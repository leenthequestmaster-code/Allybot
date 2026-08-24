import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const root = new URL('..', import.meta.url)

test('Supabase Character/Group Context migration verifier passes repository source', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-supabase-character-migration.mjs', '.'], {
    cwd: root.pathname,
    encoding: 'utf8',
  })
  assert.match(output, /SUPABASE_CHARACTER_SCHEMA=PASS/)
})
