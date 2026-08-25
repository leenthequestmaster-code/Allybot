import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '')
const outputRelative = process.argv[3] ?? 'release-manifest.json'
if (!root || root === resolve('/')) throw new Error('A non-root artifact directory is required')

const outputPath = resolve(root, outputRelative)
if (!outputPath.startsWith(`${root}${sep}`)) throw new Error('Manifest output must remain inside artifact directory')

const forbiddenPath = /(^|\/)(?:\.env|.*\.(?:sqlite|db|pem|key)|creds\.json|credentials\.json)(?:\/|$)/i
const allowedPath = (path) => path === 'package.json'
  || path === 'package-lock.json'
  || path === 'bash-exec-list.txt'
  || path === 'scripts/verify-postgres.mjs'
  || path === 'scripts/verify-supabase-access.mjs'
  || path === 'scripts/verify-neon.mjs'
  || path === 'scripts/monitor-postgres.mjs'
  || path === 'scripts/verify-neon-chat-log-migration.mjs'
  || path === 'scripts/verify-upstash-redis.mjs'
  || path === 'scripts/verify-supabase-economy-migration.mjs'
  || path === 'scripts/verify-supabase-character-migration.mjs'
  || path.startsWith('migrations/neon/')
  || path.startsWith('migrations/supabase/')
  || path === 'Codebase/allybot-codebase-latest.zip'
  || path.startsWith('dist/')
  || path.startsWith('node_modules/postgres/')
  || path.startsWith('node_modules/dotenv/')
  || path.startsWith('node_modules/@supabase/')
  || path.startsWith('node_modules/@upstash/')
  || path.startsWith('node_modules/buffer/')
  || path.startsWith('node_modules/ws/')
  || path.startsWith('node_modules/iceberg-js/')
  || path.startsWith('node_modules/tslib/')
  || path.startsWith('node_modules/uncrypto/')
  || path.startsWith('node_modules/@sentry/')
  || path.startsWith('node_modules/@opentelemetry/')
  || path.startsWith('node_modules/@apm-js-collab/')
  || path.startsWith('node_modules/@jridgewell/')
  || path.startsWith('node_modules/@types/estree/')
  || path.startsWith('node_modules/astring/')
  || path.startsWith('node_modules/cjs-module-lexer/')
  || path.startsWith('node_modules/debug/')
  || path.startsWith('node_modules/es-module-lexer/')
  || path.startsWith('node_modules/esquery/')
  || path.startsWith('node_modules/estraverse/')
  || path.startsWith('node_modules/import-in-the-middle/')
  || path.startsWith('node_modules/magic-string/')
  || path.startsWith('node_modules/meriyah/')
  || path.startsWith('node_modules/module-details-from-path/')
  || path.startsWith('node_modules/ms/')
  || path.startsWith('node_modules/require-in-the-middle/')
  || path.startsWith('node_modules/semifies/')
  || path.startsWith('node_modules/source-map/')

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
  allowlist: ['dist/**', 'package.json', 'package-lock.json', 'bash-exec-list.txt', 'scripts/verify-postgres.mjs', 'scripts/verify-supabase-access.mjs', 'scripts/verify-neon.mjs', 'scripts/monitor-postgres.mjs', 'scripts/verify-neon-chat-log-migration.mjs', 'scripts/verify-upstash-redis.mjs', 'scripts/verify-supabase-economy-migration.mjs', 'scripts/verify-supabase-character-migration.mjs', 'migrations/neon/**', 'migrations/supabase/**', 'node_modules/postgres/**', 'node_modules/dotenv/**', 'node_modules/@supabase/**', 'node_modules/@upstash/**', 'node_modules/buffer/**', 'node_modules/ws/**', 'node_modules/iceberg-js/**', 'node_modules/tslib/**', 'node_modules/uncrypto/**', 'node_modules/@sentry/**', 'node_modules/@opentelemetry/**', 'node_modules/@apm-js-collab/**', 'node_modules/@jridgewell/**', 'node_modules/@types/estree/**', 'node_modules/astring/**', 'node_modules/cjs-module-lexer/**', 'node_modules/debug/**', 'node_modules/es-module-lexer/**', 'node_modules/esquery/**', 'node_modules/estraverse/**', 'node_modules/import-in-the-middle/**', 'node_modules/magic-string/**', 'node_modules/meriyah/**', 'node_modules/module-details-from-path/**', 'node_modules/ms/**', 'node_modules/require-in-the-middle/**', 'node_modules/semifies/**', 'node_modules/source-map/**', 'Codebase/allybot-codebase-latest.zip'],
  files: entries,
}

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
