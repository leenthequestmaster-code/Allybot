import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { join } from 'node:path'

const repository = process.cwd()
const read = (relativePath) => readFileSync(join(repository, relativePath), 'utf8')

test('architecture fitness keeps lifecycle ownership and cleanup seams intact', () => {
  const pluginManager = read('src/framework/plugin-manager.ts')
  const serviceRegistry = read('src/framework/service-registry.ts')
  const application = read('src/framework/application.ts')

  assert.match(pluginManager, /trackCleanup\(/)
  assert.match(pluginManager, /resolveOrder\(\)\.reverse\(\)/)
  assert.match(pluginManager, /record\.cleanups\.splice\(0\)\.reverse\(\)/)
  assert.match(serviceRegistry, /Circular service dependency/)
  assert.match(serviceRegistry, /Missing service dependency/)
  assert.match(application, /await this\.plugins\.unload\(\)/)
  assert.match(application, /await this\.services\.shutdown\(/)
})

test('architecture fitness keeps guardrail outcomes and feature flags fail-closed', () => {
  const guardrails = read('src/framework/guardrails.ts')
  const service = read('src/services/platform-guardrail-service.ts')
  const suggestion = read('src/services/suggestion-relay-service.ts')

  assert.match(guardrails, /'allowed', 'denied', 'changed', 'failed', 'limited', 'opened', 'closed'/)
  assert.match(service, /allowed: false, reason: 'Guardrail audit unavailable'/)
  assert.match(service, /isFeatureEnabled\(groupJid: string, featureId: string\): boolean[\s\S]*enabled === true/)
  assert.match(suggestion, /this\.guardrailService\(\)\.isFeatureEnabled\(/)
})

test('architecture fitness keeps sanitized artifact and locked deployment boundaries', () => {
  const workflow = read('.github/workflows/ci.yml')
  assert.match(workflow, /npm ci --no-audit --no-fund/)
  assert.match(workflow, /npm run typecheck/)
  assert.match(workflow, /npm run build/)
  assert.match(workflow, /npm test/)
  assert.match(workflow, /create-release-manifest\.mjs/)
  assert.match(workflow, /-F "files=@\.deploy\/\$\{ARCHIVE_NAME\}"/)
  assert.match(workflow, /Forbidden path found in sanitized archive/)
  assert.match(workflow, /server_started.*not attempted/)
  assert.doesNotMatch(workflow, /\/command/)
})

test('architecture fitness keeps Codebase export automation least-privilege and provenance-bound', () => {
  const workflow = read('.github/workflows/ci.yml')
  const packageJson = JSON.parse(read('package.json'))
  const releaseManifest = read('scripts/create-release-manifest.mjs')
  const generator = read('scripts/generate-codebase-export.mjs')

  assert.equal(packageJson.scripts.test, 'node --test tests/*.test.js')
  assert.match(workflow, /paths-ignore:[\s\S]*Codebase\/\*\*/)
  assert.match(workflow, /Generate sanitized Codebase Intelligence Export/)
  assert.match(workflow, /source_sha="\$GITHUB_SHA"/)
  assert.match(workflow, /node scripts\/generate-codebase-export\.mjs --output Codebase --source-sha "\$source_sha"/)
  assert.match(workflow, /Codebase\/allybot-codebase-latest\.zip/)
  assert.match(workflow, /publish_codebase:[\s\S]*permissions:\n\s+contents: write/)
  assert.match(workflow, /git fetch --no-tags origin main --depth=1/)
  assert.match(workflow, /git rev-parse origin\/main\)" = "\$GITHUB_SHA"/)
  assert.doesNotMatch(workflow, /^permissions:\n\s+contents: write/m)
  assert.match(releaseManifest, /path === 'Codebase\/allybot-codebase-latest\.zip'/)
  assert.match(generator, /CODEBASE_REPOSITORY_ROOT/)
  assert.match(generator, /MAX_TOTAL_SNAPSHOT_BYTES/)
  assert.match(generator, /secretPatterns/)
})

test('architecture fitness rejects tracked secrets, database files, and session artifacts', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const forbidden = tracked.filter((path) => /(^|\/)(\.env|.*\.(?:sqlite|db|pem|key)|creds\.json|credentials\.json|node_modules)(\/|$)/i.test(path))
  assert.deepEqual(forbidden, [])
})
