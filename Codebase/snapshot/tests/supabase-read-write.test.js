import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSupabaseReadWriteClient,
  readSupabaseReadWriteConfig,
} from '../dist/supabase-read-write.js'

test('Supabase read-write client is optional when its environment is absent', () => {
  assert.equal(readSupabaseReadWriteConfig({}), undefined)
})

test('Supabase read-write config requires URL and service-role key together', () => {
  assert.throws(
    () => readSupabaseReadWriteConfig({ SUPABASE_URL: 'https://project.example.test' }),
    /SUPABASE_SERVICE_ROLE_KEY is required/,
  )
  assert.throws(
    () => readSupabaseReadWriteConfig({ SUPABASE_SERVICE_ROLE_KEY: 'server-only-key' }),
    /SUPABASE_URL is required/,
  )
})

test('Supabase read-write config requires an HTTPS URL', () => {
  assert.throws(
    () => readSupabaseReadWriteConfig({
      SUPABASE_URL: 'http://project.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    }),
    /SUPABASE_URL must use https:\/\//,
  )
})

test('Supabase read-write client initializes server-side without a data operation', () => {
  const config = readSupabaseReadWriteConfig({
    SUPABASE_URL: 'https://project.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
  })
  const client = createSupabaseReadWriteClient(config)

  assert.equal(typeof client.from, 'function')
  assert.equal(typeof client.rpc, 'function')
})
