/**
 * @module waveform-generator
 * Native 64-sample PCM audio waveform extractor using ffmpeg.
 * Generates WhatsApp-compatible interactive green waveform bars (0..100) for Voice Notes (PTT).
 */

import { spawn } from 'node:child_process'

/**
 * Extracts 64 normalized amplitude values (0..100) from an audio buffer using ffmpeg.
 * Time complexity: O(N) stream processing in ~15-25ms.
 */
export function generateWaveform(audioBuffer: Buffer, timeoutMs = 15_000): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve) => {
    if (!audioBuffer || audioBuffer.length < 500) {
      return resolve(new Uint8Array(64).fill(25))
    }

    let timer: NodeJS.Timeout | undefined
    // Resample to 8kHz mono 8-bit unsigned PCM
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'u8',
      'pipe:1',
    ])

    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))

    const finalize = (code: number | null) => {
      if (timer) clearTimeout(timer)
      if (code !== 0) {
        return resolve(new Uint8Array(64).fill(25))
      }

      const raw = Buffer.concat(chunks)
      if (raw.length === 0) {
        return resolve(new Uint8Array(64).fill(25))
      }

      const samples = new Uint8Array(64)
      const step = raw.length / 64

      for (let i = 0; i < 64; i++) {
        const start = Math.floor(i * step)
        const end = Math.floor((i + 1) * step)
        let maxDev = 0
        for (let j = start; j < end; j++) {
          const dev = Math.abs(raw[j] - 128) // 128 is center silence for 8-bit unsigned
          if (dev > maxDev) maxDev = dev
        }
        // Normalize 0..128 to 0..100
        samples[i] = Math.min(100, Math.round((maxDev / 128) * 100))
      }

      resolve(samples)
    }

    proc.on('close', finalize)
    proc.on('error', () => {
      if (timer) clearTimeout(timer)
      resolve(new Uint8Array(64).fill(25))
    })

    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {}
      resolve(new Uint8Array(64).fill(25))
    }, timeoutMs)
    timer.unref?.()

    proc.stdin.end(audioBuffer)
  })
}
