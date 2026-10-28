import ffmpeg from '@modernized/fluent-ffmpeg'
import { Readable, Writable } from 'node:stream'

/**
 * Modernized Fluent-FFmpeg Service for Allybot
 * Provides typed, bounded FFmpeg execution with automatic stream cleanup and timeout control.
 */
export function createFfmpegCommand(input?: string | Readable) {
  return ffmpeg(input)
}

/**
 * Execute a fluent FFmpeg transcode pipeline directly from Buffer to Buffer in memory.
 */
export async function transcodeBuffer(
  inputBuffer: Buffer,
  configure: (cmd: ReturnType<typeof ffmpeg>) => void,
  timeoutMs: number = 30000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = new Readable()
    inputStream.push(inputBuffer)
    inputStream.push(null)

    const chunks: Buffer[] = []
    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })

    const cmd = ffmpeg(inputStream)

    const timer = setTimeout(() => {
      try {
        cmd.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`Fluent-FFmpeg transcode timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    configure(cmd)

    cmd
      .on('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
      .on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
      .writeToStream(outputStream)
  })
}

export { ffmpeg }
export default ffmpeg
