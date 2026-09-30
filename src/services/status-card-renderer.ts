import { spawn } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export interface StatusCardPayload {
  name: string
  gender: string
  age: number
  birthday: string
  race: string
  className: string
  element: string
  rank: string
  level: number
  willOfPath: string
  spirit?: string
  crew?: string
  profession?: string
  origin?: string
  titles?: readonly string[]
  motto?: string
  stats?: Record<string, unknown>
}

function resolveScriptPath(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const fromModule = resolve(currentDir, '..', '..', 'scripts', 'generate-status-card.py')
    if (existsSync(fromModule)) return fromModule
  } catch {}

  const fromCwd = join(process.cwd(), 'scripts', 'generate-status-card.py')
  if (existsSync(fromCwd)) return fromCwd

  return '/opt/Allybot/scripts/generate-status-card.py'
}

export async function renderStatusCardImage(
  mode: 'character' | 'stats',
  payload: StatusCardPayload,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<Buffer | null> {
  const nonce = randomBytes(8).toString('hex')
  const inPath = `/tmp/status_card_in_${nonce}.json`
  const outPath = `/tmp/status_card_out_${nonce}.png`
  const scriptPath = resolveScriptPath()

  try {
    await writeFile(inPath, JSON.stringify(payload), 'utf8')
    await new Promise<void>((resolve, reject) => {
      const py = spawn('python3', [scriptPath, '--mode', mode, '--input', inPath, '--output', outPath])
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        py.kill('SIGKILL')
        reject(new Error('Status card generator timed out after 25000ms'))
      }, 25_000)

      py.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096)
      })
      py.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      py.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Status card generator exited with code ${code}: ${stderr}`))
      })
      py.stdin?.end()
    })

    const buf = await readFile(outPath)
    return buf
  } catch (error) {
    logger?.warn({ error, mode, scriptPath }, 'failed to generate status card image')
    return null
  } finally {
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
  }
}
