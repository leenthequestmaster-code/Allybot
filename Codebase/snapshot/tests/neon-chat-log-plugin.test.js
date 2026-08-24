import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../dist/config.js'
import { parseNeonChatLogGroups } from '../dist/framework/plugins/neon-chat-log.js'

test('chat-log configuration is default-off and requires Neon when enabled', () => {
  const config = loadConfig({ WHATSAPP_ENABLED: 'false' })
  assert.equal(config.NEON_ENABLED, false)
  assert.equal(config.NEON_CHAT_LOG_ENABLED, false)

  assert.throws(
    () => loadConfig({ WHATSAPP_ENABLED: 'false', NEON_CHAT_LOG_ENABLED: 'true' }),
    /NEON_ENABLED must be true/,
  )
  assert.throws(
    () => loadConfig({
      WHATSAPP_ENABLED: 'false',
      NEON_ENABLED: 'true',
      NEON_DATABASE_URL: 'postgresql://db.example.test/db',
      NEON_CHAT_LOG_ENABLED: 'true',
    }),
    /NEON_CHAT_LOG_GROUPS is required/,
  )
})

test('chat-log groups require explicit WhatsApp group JIDs', () => {
  assert.deepEqual([...parseNeonChatLogGroups('120@g.us, 120@g.us, 121@g.us')], ['120@g.us', '121@g.us'])
  assert.throws(() => parseNeonChatLogGroups(''), /NEON_CHAT_LOG_GROUPS must contain/)
  assert.throws(() => parseNeonChatLogGroups('120@s.whatsapp.net'), /NEON_CHAT_LOG_GROUPS must contain/)
})
