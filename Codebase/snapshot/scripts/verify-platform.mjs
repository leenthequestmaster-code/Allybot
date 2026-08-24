import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceDir = join(root, 'src', 'platform')
const distDir = join(root, 'dist', 'platform')

for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
  const distFile = join(distDir, file.replace(/\.ts$/, '.js'))
  if (!existsSync(distFile)) throw new Error(`Missing compiled platform entrypoint: ${relative(root, distFile)}`)
}

const trackedAndUntracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
const sensitivePattern = /(^|\/)(?:\.env|auth_info|session|sessions|.*\.sqlite(?:-shm|-wal)?|.*\.db(?:-shm|-wal)?)($|\/)/i
const sensitiveFiles = trackedAndUntracked.split('\n').filter(Boolean).filter((file) => sensitivePattern.test(file))
if (sensitiveFiles.length > 0) throw new Error(`Sensitive files detected in repository set: ${sensitiveFiles.join(', ')}`)

console.log(`Platform parity verified: ${readdirSync(sourceDir).filter((name) => name.endsWith('.ts')).length} source modules have compiled output`)
