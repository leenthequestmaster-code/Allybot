/**
 * @module voice-service
 * Natural Voice Synthesis Engine powered by Fish Audio S2.1-Pro-Free & WhatsApp VOIP Opus Transcoder.
 *
 * Key Highlights:
 * 1. Ultra-natural human voice (breath, cadence, Indonesian conversational flow).
 * 2. Persistent Disk Cache: repeated phrases are stored in `data/cache/voice/` (zero latency, zero tokens).
 * 3. FFmpeg in-memory audio transcode to WhatsApp Voice Note standard (OGG Opus 48kHz mono, VOIP profile).
 * 4. Automatic 64-sample green waveform extraction via `generateWaveform`.
 * 5. Fail-soft fallback to legacy Google TTS if remote API is unreachable.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { generateWaveform } from './waveform-generator.js'

export const DEFAULT_CHLONA_VOICE_ID = '8ba556e867e0422caf319ead9911b274' // Wanita Santai Berbicara
export const DEFAULT_FISH_TOKEN = 'd5b5578f-f542-4a1c-8bb7-995e5d8cd880'

const VOICE_CACHE_DIR = join(process.cwd(), 'data', 'cache', 'voice')

try {
  mkdirSync(VOICE_CACHE_DIR, { recursive: true })
} catch {}

export interface VoiceSynthesisOptions {
  readonly voiceId?: string
  readonly token?: string
  readonly timeoutMs?: number
}

export interface VoiceSynthesisResult {
  readonly audioData: Uint8Array
  readonly mimeType: string
  readonly waveform: Uint8Array
  readonly fromCache: boolean
  readonly durationSeconds?: number
}

/**
 * Transcodes an MP3 buffer to WhatsApp PTT Opus (OGG container, 48kHz, mono, VOIP profile).
 */
function transcodeToOpusPtt(mp3Buffer: Buffer, timeoutMs = 15_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      'pipe:0',
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      '-application',
      'voip',
      '-avoid_negative_ts',
      'make_zero',
      '-f',
      'ogg',
      'pipe:1',
    ])

    const chunks: Buffer[] = []
    ff.stdout.on('data', (d: Buffer) => chunks.push(d))

    ff.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`))
      }
    })

    ff.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })

    timer = setTimeout(() => {
      try {
        ff.kill('SIGKILL')
      } catch {}
      reject(new Error(`FFmpeg PTT transcode timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    ff.stdin.end(mp3Buffer)
  })
}

/**
 * Fetches legacy Google TTS MP3 buffer as fallback.
 */
async function fetchGoogleTtsFallback(text: string, timeoutMs = 8_000): Promise<Buffer> {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=id&client=tw-ob`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`)
    const arrayBuf = await res.arrayBuffer()
    return Buffer.from(arrayBuf)
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Synthesizes natural speech using Fish Audio S2.1-Pro-Free with persistent cache and waveform.
 */
export async function synthesizeNaturalSpeech(
  text: string,
  options?: VoiceSynthesisOptions,
): Promise<VoiceSynthesisResult> {
  const cleanText = text.trim()
  if (!cleanText) throw new Error('Text cannot be empty')

  const voiceId = options?.voiceId || process.env.FISH_VOICE_ID || DEFAULT_CHLONA_VOICE_ID
  const token = options?.token || process.env.FISH_AUDIO_TOKEN || DEFAULT_FISH_TOKEN
  const timeoutMs = options?.timeoutMs ?? 15_000

  // 1. Check persistent cache
  const cacheKey = createHash('sha1').update(`${voiceId}:${cleanText.toLowerCase()}`).digest('hex')
  const cachePath = join(VOICE_CACHE_DIR, `${cacheKey}.ogg`)

  if (existsSync(cachePath)) {
    try {
      const cachedBuffer = readFileSync(cachePath)
      const waveform = await generateWaveform(cachedBuffer)
      return {
        audioData: new Uint8Array(cachedBuffer),
        mimeType: 'audio/ogg; codecs=opus',
        waveform,
        fromCache: true,
      }
    } catch {}
  }

  // 2. Fetch from Fish Audio API
  let rawMp3Buffer: Buffer | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        model: 's2.1-pro-free',
      },
      body: JSON.stringify({
        text: cleanText,
        reference_id: voiceId,
        format: 'mp3',
      }),
    })
    clearTimeout(timer)

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer()
      const buf = Buffer.from(arrayBuf)
      if (buf.length > 1000) {
        rawMp3Buffer = buf
      }
    }
  } catch {}

  // 3. Fallback to Google TTS if Fish Audio fails
  if (!rawMp3Buffer) {
    try {
      rawMp3Buffer = await fetchGoogleTtsFallback(cleanText)
    } catch (fallbackErr) {
      throw new Error(`All speech synthesis providers failed: ${String(fallbackErr)}`)
    }
  }

  // 4. Transcode to WhatsApp VOIP Opus
  const opusBuffer = await transcodeToOpusPtt(rawMp3Buffer)

  // 5. Save to persistent cache
  try {
    writeFileSync(cachePath, opusBuffer)
  } catch {}

  // 6. Generate 64-sample waveform
  const waveform = await generateWaveform(opusBuffer)

  return {
    audioData: new Uint8Array(opusBuffer),
    mimeType: 'audio/ogg; codecs=opus',
    waveform,
    fromCache: false,
  }
}
