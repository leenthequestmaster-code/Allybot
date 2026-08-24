import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, publicConfig } from '../dist/config.js'

test('Codebase export configuration is disabled and bounded by default', () => {
  const config = loadConfig({ NODE_ENV: 'test' })
  assert.equal(config.CODEBASE_EXPORT_ENABLED, false)
  assert.equal(config.CODEBASE_EXPORT_PATH, './Codebase/allybot-codebase-latest.zip')
  assert.equal(config.CODEBASE_EXPORT_MAX_BYTES, 3 * 1024 * 1024)
  const exposed = publicConfig(config)
  assert.equal(exposed.codebaseExportEnabled, false)
  assert.equal(exposed.codebaseExportMaxBytes, 3 * 1024 * 1024)
  assert.equal('codebaseExportPath' in exposed, false)
})

test('Codebase export configuration rejects unsafe paths and oversized limits', () => {
  assert.throws(() => loadConfig({ CODEBASE_EXPORT_PATH: '/tmp/export.zip' }), /inside the application directory/)
  assert.throws(() => loadConfig({ CODEBASE_EXPORT_PATH: '../export.zip' }), /inside the application directory/)
  assert.throws(() => loadConfig({ CODEBASE_EXPORT_PATH: 'C:\\export.zip' }), /inside the application directory/)
  assert.throws(() => loadConfig({ CODEBASE_EXPORT_MAX_BYTES: String(4 * 1024 * 1024 + 1) }), /must be between/)
})


test('Character Guide and Group Context are default-off with bounded safe defaults', () => {
  const config = loadConfig({ NODE_ENV: 'test' })
  assert.equal(config.CHARACTER_GUIDE_ENABLED, false)
  assert.equal(config.GROUP_CONTEXT_ENABLED, false)
  assert.equal(config.CHARACTER_GUIDE_SESSION_TTL_SECONDS, 1800)
  assert.equal(config.GROUP_CONTEXT_OOC_COOLDOWN_MS, 30000)
  assert.equal(config.GROUP_CONTEXT_OOC_WINDOW_MS, 600000)
  assert.equal(config.GROUP_CONTEXT_OOC_MAX_PER_WINDOW, 3)
  const exposed = publicConfig(config)
  assert.equal(exposed.characterGuideEnabled, false)
  assert.equal(exposed.groupContextEnabled, false)
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in exposed, false)
})

test('Supabase-backed Character/Group Context flags require server-side credentials and valid bounds', () => {
  assert.throws(() => loadConfig({ CHARACTER_GUIDE_ENABLED: 'true' }), /SUPABASE_URL is required/)
  assert.throws(() => loadConfig({ GROUP_CONTEXT_ENABLED: 'true', SUPABASE_URL: 'https://example.supabase.co' }), /SUPABASE_SERVICE_ROLE_KEY is required/)
  assert.throws(() => loadConfig({ CHARACTER_GUIDE_SESSION_TTL_SECONDS: '299' }), /must be between/)
  assert.throws(() => loadConfig({ GROUP_CONTEXT_OOC_MAX_PER_WINDOW: '21' }), /must be between/)
  const config = loadConfig({
    CHARACTER_GUIDE_ENABLED: 'true',
    GROUP_CONTEXT_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-server-only-value',
  })
  assert.equal(config.CHARACTER_GUIDE_ENABLED, true)
  assert.equal(config.GROUP_CONTEXT_ENABLED, true)
})
