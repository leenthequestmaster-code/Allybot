import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '')
const outputRelative = process.argv[3] ?? 'release-manifest.json'
if (!root || root === resolve('/')) throw new Error('A non-root artifact directory is required')

const outputPath = resolve(root, outputRelative)
if (!outputPath.startsWith(`${root}${sep}`)) throw new Error('Manifest output must remain inside artifact directory')

const forbiddenPath = /(^|\/)(?:\.env|.*\.(?:sqlite|db|pem|key)|creds\.json|credentials\.json|node_modules|src|tests)(?:\/|$)/i
const allowedPath = (path) => path === 'package.json'
  || path === 'package-lock.json'
  || path === 'bash-exec-list.txt'
  || path === 'scripts/verify-postgres.mjs'
  || path.startsWith('dist/')

function listFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (absolute === outputPath || basename(absolute) === 'SHA256SUMS.txt') continue
    if (entry.isDirectory()) files.push(...listFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
    else throw new Error(`Unsupported artifact entry: ${absolute}`)
  }
  return files
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (!statSync(root).isDirectory()) throw new Error(`Artifact directory does not exist: ${root}`)
const files = listFiles(root)
const entries = files.map((absolute) => {
  const path = relative(root, absolute).split(sep).join('/')
  if (forbiddenPath.test(path) || !allowedPath(path)) throw new Error(`Artifact path is not allowlisted: ${path}`)
  return { path, bytes: statSync(absolute).size, sha256: sha256(absolute) }
}).sort((left, right) => left.path.localeCompare(right.path))

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageLockPath = resolve(root, 'package-lock.json')
const manifest = {
  schemaVersion: 1,
  artifactId: `allybot-release-${process.env.GITHUB_SHA ?? process.env.RELEASE_COMMIT_SHA ?? 'local'}`,
  commitSha: process.env.GITHUB_SHA ?? process.env.RELEASE_COMMIT_SHA ?? 'local',
  nodeVersion: process.version,
  packageVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
  packageLockSha256: sha256(packageLockPath),
  allowlist: ['dist/**', 'package.json', 'package-lock.json', 'bash-exec-list.txt', 'scripts/verify-postgres.mjs'],
  files: entries,
}

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
