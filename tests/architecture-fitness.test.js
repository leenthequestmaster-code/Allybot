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

test('architecture fitness keeps bounded scheduler and CAS claim invariants', () => {
  const announcement = read('src/services/announcement-service.ts')
  assert.match(announcement, /this\.dispatcher\.unref\?\.\(\)/)
  assert.match(announcement, /clearInterval\(this\.dispatcher\)/)
  assert.match(announcement, /LIMIT \?/)
  assert.match(announcement, /status = 'sending'.*status = 'pending'/s)
  assert.match(announcement, /revision = revision \+ 1/)
})

test('architecture fitness keeps guardrail outcomes and feature flags fail-closed', () => {
  const guardrails = read('src/platform/guardrails.ts')
  const service = read('src/services/platform-guardrail-service.ts')
  const announcement = read('src/services/announcement-service.ts')
  const suggestion = read('src/services/suggestion-relay-service.ts')

  assert.match(guardrails, /'allowed', 'denied', 'changed', 'failed', 'limited', 'opened', 'closed'/)
  assert.match(service, /allowed: false, reason: 'Guardrail audit unavailable'/)
  assert.match(service, /isFeatureEnabled\(groupJid: string, featureId: string\): boolean[\s\S]*enabled === true/)
  assert.match(announcement, /this\.guardrailService\(\)\.isFeatureEnabled\(/)
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

test('architecture fitness rejects tracked secrets, database files, and session artifacts', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const forbidden = tracked.filter((path) => /(^|\/)(\.env|.*\.(?:sqlite|db|pem|key)|creds\.json|credentials\.json|node_modules)(\/|$)/i.test(path))
  assert.deepEqual(forbidden, [])
})
