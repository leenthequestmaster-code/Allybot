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
