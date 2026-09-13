import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { WhatsAppConnection } from '../dist/whatsapp.js'

function createConnection() {
  const storage = {}
  const logger = pino({ level: 'silent' })
  const connection = new WhatsAppConnection({}, storage, logger)
  connection.status = 'connected'
  return connection
}

function createSocket() {
  const calls = []
  return {
    user: { id: 'bot@s.whatsapp.net' },
    calls,
    async relayMessage(remoteJid, message, options) {
      calls.push({ remoteJid, message, options })
      return options.messageId
    },
  }
}

test('native quick replies relay required private-chat metadata nodes', async () => {
  const connection = createConnection()
  const socket = createSocket()
  connection.socket = socket

  await connection.sendNativeQuickReplies('user@s.whatsapp.net', {
    type: 'native_quick_reply',
    body: 'Choose',
    buttons: [{ id: 'menu:token:general', title: 'GENERAL' }],
  })

  assert.equal(socket.calls.length, 1)
  const [call] = socket.calls
  assert.equal(call.options.additionalNodes[0].tag, 'biz')
  assert.equal(call.options.additionalNodes[0].content[0].tag, 'interactive')
  assert.deepEqual(call.options.additionalNodes[0].content[0].attrs, { type: 'native_flow', v: '1' })
  assert.deepEqual(call.options.additionalNodes[0].content[0].content[0], {
    tag: 'native_flow',
    attrs: { v: '9', name: 'mixed' },
  })
  assert.deepEqual(call.options.additionalNodes[1], { tag: 'bot', attrs: { biz_bot: '1' } })
})

test('native quick replies omit private bot metadata for group relay', async () => {
  const connection = createConnection()
  const socket = createSocket()
  connection.socket = socket

  await connection.sendNativeQuickReplies('12345-67890@g.us', {
    type: 'native_quick_reply',
    body: 'Choose',
    buttons: [{ id: 'menu:token:general', title: 'GENERAL' }],
  })

  assert.equal(socket.calls.length, 1)
  const [call] = socket.calls
  assert.equal(call.options.additionalNodes.length, 1)
  assert.equal(call.options.additionalNodes[0].tag, 'biz')
})
