import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const RAW_ACCOUNT = '<phone-redacted>'
const RAW_JID = 'synthetic-user@s.whatsapp.net'
const RAW_TOKEN = 'Bearer synthetic-token-value'
const RAW_ERROR = 'synthetic private provider detail'

function runLoggerProbe() {
  const source = `
    import { createLogger } from './dist/logger.js'
    const logger = createLogger({ LOG_LEVEL: 'info', AUTH_ACCOUNT_ID: ${JSON.stringify(RAW_ACCOUNT)} })
    const error = new Error(${JSON.stringify(RAW_ERROR)})
    error.cause = new Error('synthetic nested cause')
    logger.error({ err: error, error, remoteJid: ${JSON.stringify(RAW_JID)}, token: ${JSON.stringify(RAW_TOKEN)} }, 'privacy probe')
    logger.error(error, 'direct error probe')
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

test('logger redacts identifiers and serializes errors without private detail', () => {
  const result = runLoggerProbe()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes(RAW_ACCOUNT), false)
  assert.equal(result.stdout.includes(RAW_JID), false)
  assert.equal(result.stdout.includes(RAW_TOKEN), false)
  assert.equal(result.stdout.includes(RAW_ERROR), false)
  assert.equal(result.stdout.includes('synthetic nested cause'), false)
  assert.equal(result.stdout.includes('"stack"'), false)
  assert.match(result.stdout, /"name":"Error"/)
})
