import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { loadConfig, publicConfig } from '../dist/config.js'
import { WhatsAppConnection } from '../dist/whatsapp.js'

const logger = pino({ level: 'silent' })

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_PATH: './data/maintenance-test.sqlite',
    AUTH_ACCOUNT_ID: 'maintenance-test',
    QR_ENABLED: 'false',
    PAIRING_ENABLED: 'false',
    ENABLE_HISTORY_SYNC: 'false',
    MAX_RECONNECT_DELAY_MS: '300000',
    SHUTDOWN_TIMEOUT_MS: '15000',
    COMMAND_PREFIX: '!',
    DEFAULT_COMMAND_COOLDOWN_MS: '3000',
    DIAGNOSTICS_ENABLED: 'false',
    ...overrides,
  }
}

test('maintenance configuration disables WhatsApp without changing the default', () => {
  const disabled = loadConfig(baseEnv({ WHATSAPP_ENABLED: 'false' }))
  assert.equal(disabled.WHATSAPP_ENABLED, false)
  assert.equal(publicConfig(disabled).whatsappEnabled, false)

  const enabledByDefault = loadConfig(baseEnv())
  assert.equal(enabledByDefault.WHATSAPP_ENABLED, true)
})

test('WhatsAppConnection skips socket creation in maintenance mode', async () => {
  const config = loadConfig(baseEnv({ WHATSAPP_ENABLED: 'false' }))
  const connection = new WhatsAppConnection(config, {}, logger)
  const states = []
  connection.onConnectionState((event) => { states.push(event) })

  await connection.start()

  assert.equal(connection.currentStatus, 'idle')
  assert.equal(connection.isConnected, false)
  assert.equal(states.length, 1)
  assert.equal(states[0].status, 'idle')
  assert.equal(states[0].reason, 'whatsapp_disabled')

  await connection.close()
})

test('core ping does not expose an invite URL or request a link preview', async () => {
  const config = loadConfig(baseEnv())
  const savedMessages = []
  const sent = []
  const connection = new WhatsAppConnection(config, {
    saveMessages(messages) { savedMessages.push(...messages) },
  }, logger)
  const socket = {
    async sendMessage(remoteJid, content) {
      sent.push({ remoteJid, content })
      return {}
    },
  }

  await connection.handleMessages(socket, {
    type: 'notify',
    messages: [{
      key: { remoteJid: '1234567890@s.whatsapp.net', id: 'ping-1', fromMe: false },
      message: { conversation: '!ping' },
    }],
  }, logger)

  assert.equal(savedMessages.length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].content.linkPreview, null)
  assert.equal(sent[0].content.text.includes('https://chat.whatsapp.com/'), false)
})
