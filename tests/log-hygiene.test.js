import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'
import { extractAllLinks } from '../dist/services/tempmail.js'
import { tripOnRateLimit, resetRateLimit, rateLimitTripsThisHour } from '../dist/services/amprem-rate-limit.js'

const repository = process.cwd()
const read = (relativePath) => readFileSync(join(repository, relativePath), 'utf8')

const SCOPE_FILES = [
  'src/services/verify-api.ts',
  'src/services/tempmail.ts',
  'src/services/amprem-rate-limit.ts',
  'src/framework/plugins/verify.ts',
]

function captureConsole(fn) {
  const calls = []
  const orig = console.log
  console.log = (...args) => { calls.push(args) }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return calls
}

test('log hygiene keeps debug console output out of verify/tempmail/rate-limit scope', () => {
  for (const file of SCOPE_FILES) {
    const source = read(file)
    const hasConsole = /console\.(log|debug|info|warn|error)/.test(source)
    assert.equal(hasConsole, false, file + ' must not contain console.* calls')
  }
})

test('log hygiene ignores local backup and editor artefacts', () => {
  const lines = read('.gitignore').split('\n').map((line) => line.trim())
  for (const pattern of ['*.bak', '*.old', '*.orig', '*.rej', '*~', '*.swp']) {
    assert.ok(lines.includes(pattern), '.gitignore must contain ' + pattern)
  }
})

test('log hygiene keeps link extraction silent and pure', () => {
  const link = 'https://example.com/auth?oobCode=SYNTHETIC_CODE_123'
  const prefix = 'klik '
  const suffix = ' untuk masuk'
  let out
  const calls = captureConsole(() => {
    out = extractAllLinks(prefix + link + suffix, null, undefined)
  })
  assert.deepEqual(out, [link])
  assert.equal(calls.length, 0, 'extractAllLinks must not write to console')
})

test('log hygiene keeps rate-limit trips silent but counted', () => {
  resetRateLimit()
  let retryAfter
  const calls = captureConsole(() => {
    retryAfter = tripOnRateLimit(429, { message: 'rate limit exceeded' }, new Headers(), 'send')
  })
  assert.equal(retryAfter, 60)
  assert.equal(rateLimitTripsThisHour(), 1)
  assert.equal(calls.length, 0, 'tripOnRateLimit must not write to console')
  resetRateLimit()
})
