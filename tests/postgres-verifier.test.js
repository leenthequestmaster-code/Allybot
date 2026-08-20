import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readPostgresVerificationConfig,
  redactPostgresError,
} from '../dist/postgres-verifier.js'

test('PostgreSQL verifier is optional when POSTGRES_URL is absent', () => {
  assert.equal(readPostgresVerificationConfig({}), undefined)
})

test('PostgreSQL verifier accepts a session pooler configuration without exposing secrets', () => {
  const config = readPostgresVerificationConfig({
    POSTGRES_URL: 'postgres://postgres.example.test/postgres',
    POSTGRES_POOL_MODE: 'session',
  })
  assert.deepEqual(config, {
    url: 'postgres://postgres.example.test/postgres',
    poolMode: 'session',
  })
})

test('PostgreSQL verifier rejects invalid URL and pool mode', () => {
  assert.throws(
    () => readPostgresVerificationConfig({ POSTGRES_URL: 'https://example.test' }),
    /POSTGRES_URL must use postgres/,
  )
  assert.throws(
    () => readPostgresVerificationConfig({
      POSTGRES_URL: 'postgres://postgres.example.test/postgres',
      POSTGRES_POOL_MODE: 'invalid',
    }),
    /POSTGRES_POOL_MODE must be direct, session, or transaction/,
  )
})

test('PostgreSQL verifier defaults to session mode', () => {
  assert.equal(
    readPostgresVerificationConfig({ POSTGRES_URL: 'postgresql://postgres.example.test/postgres' })?.poolMode,
    'session',
  )
})

test('PostgreSQL error redaction removes connection credentials', () => {
  const message = redactPostgresError(new Error('failed postgres://postgres:secret@example.test/postgres password=secret'))
  assert.equal(message, 'failed postgresql://***@example.test/postgres password=***')
})
