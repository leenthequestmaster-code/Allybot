import { spawn } from 'node:child_process'
import type { CoreMediaKind } from './framework/contracts.js'

export const MEDIA_TRANSFORM_TIMEOUT_MS = 15_000
export const MEDIA_TRANSFORM_MAX_OUTPUT_BYTES = 512 * 1024
export const MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES = 2 * 1024 * 1024

export type MediaTransformKind = 'sticker' | 'image' | 'gif' | 'audio'

export class MediaTransformError extends Error {
  constructor(readonly code: 'timeout' | 'output_limit' | 'process_failed' | 'unsupported', message: string) {
    super(message)
    this.name = 'MediaTransformError'
  }
}

export interface MediaTransformer {
  transform(input: Uint8Array, inputMimeType: string, inputKind: CoreMediaKind, target: MediaTransformKind): Promise<Uint8Array>
}

export type FfmpegRunner = (args: readonly string[], input: Uint8Array, maxOutputBytes: number, timeoutMs: number) => Promise<Uint8Array>

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value as number)))
}

export function runFfmpeg(args: readonly string[], input: Uint8Array, maxOutputBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const outputLimit = boundedInteger(maxOutputBytes, MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, 1, MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES)
  const timeout = boundedInteger(timeoutMs, MEDIA_TRANSFORM_TIMEOUT_MS, 1_000, MEDIA_TRANSFORM_TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let outputBytes = 0
    let stderrBytes = 0
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners('error')
      child.removeAllListeners('close')
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(error)
    }

    timer = setTimeout(() => fail(new MediaTransformError('timeout', 'media transform timed out')), timeout)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > outputLimit) {
        fail(new MediaTransformError('output_limit', 'media transform output exceeded the limit'))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = Math.min(4_096, stderrBytes + chunk.length)
    })
    child.once('error', () => fail(new MediaTransformError('process_failed', 'media transform process unavailable')))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) {
        reject(new MediaTransformError('process_failed', `media transform failed (${stderrBytes} diagnostic bytes)`))
        return
      }
      resolve(Buffer.concat(chunks, outputBytes))
    })
    child.stdin.once('error', () => fail(new MediaTransformError('process_failed', 'media transform input failed')))
    child.stdin.end(Buffer.from(input))
  })
}

function imageToStickerArgs(): readonly string[] {
  return [
    '-f', 'image2pipe',
    '-i', 'pipe:0',
    '-frames:v', '1',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0,format=rgba',
    '-an',
    '-c:v', 'libwebp',
    '-f', 'webp',
    'pipe:1',
  ]
}

function stickerToImageArgs(): readonly string[] {
  return [
    '-f', 'webp',
    '-i', 'pipe:0',
    '-frames:v', '1',
    '-f', 'image2',
    '-vcodec', 'png',
    'pipe:1',
  ]
}

function videoToGifArgs(): readonly string[] {
  return [
    '-i', 'pipe:0',
    '-t', '15',
    '-an',
    '-vf', 'fps=12,scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2:color=black',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1',
  ]
}

function mediaToAudioArgs(): readonly string[] {
  return [
    '-i', 'pipe:0',
    '-t', '60',
    '-vn',
    '-ac', '1',
    '-c:a', 'libopus',
    '-f', 'ogg',
    'pipe:1',
  ]
}

export class FfmpegMediaTransformer implements MediaTransformer {
  constructor(
    private readonly runner: FfmpegRunner = runFfmpeg,
    private readonly maxOutputBytes = MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES,
    private readonly timeoutMs = MEDIA_TRANSFORM_TIMEOUT_MS,
  ) {}

  transform(input: Uint8Array, inputMimeType: string, inputKind: CoreMediaKind, target: MediaTransformKind): Promise<Uint8Array> {
    const outputLimit = target === 'sticker' ? MEDIA_TRANSFORM_MAX_OUTPUT_BYTES : MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES
    if (target === 'sticker' && inputKind === 'image' && inputMimeType.startsWith('image/')) {
      return this.runner(imageToStickerArgs(), input, Math.min(this.maxOutputBytes, outputLimit), this.timeoutMs)
    }
    if (target === 'image' && inputKind === 'sticker' && inputMimeType === 'image/webp') {
      return this.runner(stickerToImageArgs(), input, Math.min(this.maxOutputBytes, outputLimit), this.timeoutMs)
    }
    if (target === 'gif' && inputKind === 'video' && inputMimeType.startsWith('video/')) {
      return this.runner(videoToGifArgs(), input, Math.min(this.maxOutputBytes, outputLimit), this.timeoutMs)
    }
    if (target === 'audio' && (inputKind === 'video' || inputKind === 'audio') && (inputMimeType.startsWith('video/') || inputMimeType.startsWith('audio/'))) {
      return this.runner(mediaToAudioArgs(), input, Math.min(this.maxOutputBytes, outputLimit), this.timeoutMs)
    }
    return Promise.reject(new MediaTransformError('unsupported', 'media type is not supported by this transform'))
  }
}
