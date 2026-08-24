import test from 'node:test'
import assert from 'node:assert/strict'
import { extractButtonId, WhatsAppConnection } from '../dist/whatsapp.js'

const message = (content) => ({ message: content })

test('WhatsApp adapter extracts supported legacy and native-flow callback ids', () => {
  assert.equal(extractButtonId(message({ buttonsResponseMessage: { selectedButtonId: 'general' } })), 'general')
  assert.equal(extractButtonId(message({ templateButtonReplyMessage: { selectedId: 'template-choice' } })), 'template-choice')
  assert.equal(extractButtonId(message({ listResponseMessage: { singleSelectReply: { selectedRowId: 'row-choice' } } })), 'row-choice')
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'native-choice' }) },
  } })), 'native-choice')
})

test('WhatsApp adapter preserves phone identity from private-message remoteJidAlt when primary chat JID is a LID', async () => {
  const connection = new WhatsAppConnection({}, {}, {})
  const messages = []
  connection.onMessage((normalized) => messages.push(normalized))

  await connection.emitMessages([
    {
      key: {
        remoteJid: 'owner-lid@lid',
        remoteJidAlt: '<jid-redacted@s.whatsapp.net>',
        id: 'private-lid-owner',
        fromMe: false,
      },
      message: { conversation: '!dev help' },
      messageTimestamp: 1_700_000_000,
    },
  ])

  assert.equal(messages[0]?.senderJid, '<jid-redacted@s.whatsapp.net>')
  assert.equal(messages[0]?.remoteJid, 'owner-lid@lid')
  assert.equal(messages[0]?.text, '!dev help')
})

test('WhatsApp adapter ignores malformed or oversized native-flow params', () => {
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: '{not-json' },
  } })), undefined)
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: 'x'.repeat(4097) },
  } })), undefined)
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: JSON.stringify({ url: 'https://example.test' }) },
  } })), undefined)
})

test('WhatsApp adapter caches profile-picture lookup and rejects non-HTTPS URLs', async () => {
  const logger = { debug() {} }
  const connection = new WhatsAppConnection({}, {}, logger)
  let calls = 0
  const sent = []
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    profilePictureUrl: async () => {
      calls += 1
      return 'https://cdn.example.test/owner.jpg'
    },
    sendMessage: async (remoteJid, content) => {
      sent.push({ remoteJid, content })
      return {}
    },
  }
  connection.status = 'connected'

  assert.equal(await connection.getProfilePictureUrl('<jid-redacted@s.whatsapp.net>'), 'https://cdn.example.test/owner.jpg')
  assert.equal(await connection.getProfilePictureUrl('<jid-redacted@s.whatsapp.net>'), 'https://cdn.example.test/owner.jpg')
  assert.equal(calls, 1)

  await connection.sendImage('chat@s.whatsapp.net', 'https://cdn.example.test/owner.jpg', 'Owner Vallen')
  assert.equal(sent[0].remoteJid, 'chat@s.whatsapp.net')
  assert.equal(sent[0].content.caption, 'Owner Vallen')
  await assert.rejects(() => connection.sendImage('chat@s.whatsapp.net', 'http://cdn.example.test/owner.jpg'))
})

test('WhatsApp adapter profile-picture lookup falls back when upstream returns an unsafe URL', async () => {
  const connection = new WhatsAppConnection({}, {}, { debug() {} })
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    profilePictureUrl: async () => 'http://insecure.example.test/owner.jpg',
  }
  connection.status = 'connected'

  assert.equal(await connection.getProfilePictureUrl('<jid-redacted@s.whatsapp.net>'), undefined)
})

test('WhatsApp adapter profile-picture failures log only a safe error name', async () => {
  const logs = []
  const connection = new WhatsAppConnection({}, {}, {
    debug(payload, message) { logs.push({ payload, message }) },
  })
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    profilePictureUrl: async () => {
      throw new Error('profile request failed for <jid-redacted@s.whatsapp.net> token=example-token')
    },
  }
  connection.status = 'connected'

  assert.equal(await connection.getProfilePictureUrl('<jid-redacted@s.whatsapp.net>'), undefined)
  assert.deepEqual(logs[0].payload, { errorName: 'Error' })
  assert.equal(JSON.stringify(logs).includes('<jid-redacted@s.whatsapp.net>'), false)
  assert.equal(JSON.stringify(logs).includes('example-token'), false)
})
