import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export async function transcribeAudioBuffer(buffer: Buffer): Promise<string> {
  const id = randomUUID()
  const inPath = join(tmpdir(), `${id}.ogg`)
  const wavPath = join(tmpdir(), `${id}.wav`)

  try {
    writeFileSync(inPath, buffer)
    // Convert to 16kHz mono WAV for whisper
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-i',
        inPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ])
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))))
      ff.on('error', reject)
    })

    // Transcribe with whisper-cli
    return await new Promise<string>((resolve, reject) => {
      const whisper = spawn('whisper-cli', [
        '-m',
        '/opt/tools/whisper.cpp/models/ggml-base.bin',
        '-f',
        wavPath,
        '--no-timestamps',
        '-l',
        'id',
      ])
      let output = ''
      whisper.stdout.on('data', (d: Buffer) => {
        output += d.toString('utf8')
      })
      whisper.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim())
        } else {
          reject(new Error(`whisper-cli exited with code ${code}`))
        }
      })
      whisper.on('error', reject)
    })
  } finally {
    try {
      unlinkSync(inPath)
    } catch {}
    try {
      unlinkSync(wavPath)
    } catch {}
  }
}
