import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WhatsAppConnection } from '../dist/whatsapp.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'

function dummyLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() { return this },
  }
}

test('WhatsApp adapter preserves exact rawKey on incoming group and DM messages', async () => {
  const connection = new WhatsAppConnection({}, {}, dummyLogger())
  const received = []
  connection.onMessage((msg) => received.push(msg))

  await connection.emitMessages([
    // Group message with LID participant
    {
      key: {
        remoteJid: '120363040000000000@g.us',
        id: 'group-msg-1',
        fromMe: false,
        participant: '88150529556589@lid',
      },
      message: { conversation: '!ping' },
      messageTimestamp: 1_700_000_100,
    },
    // Direct message (DM) without participant
    {
      key: {
        remoteJid: '6283197859955@s.whatsapp.net',
        id: 'dm-msg-1',
        fromMe: false,
      },
      message: { conversation: '!ping' },
      messageTimestamp: 1_700_000_101,
    },
  ])

  assert.equal(received.length, 2)
  // Group message has exact LID in rawKey
  assert.deepEqual(received[0].rawKey, {
    id: 'group-msg-1',
    remoteJid: '120363040000000000@g.us',
    fromMe: false,
    participant: '88150529556589@lid',
  })
  // DM message has no participant in rawKey
  assert.deepEqual(received[1].rawKey, {
    id: 'dm-msg-1',
    remoteJid: '6283197859955@s.whatsapp.net',
    fromMe: false,
  })
})

test('sendReaction strips participant in DMs and preserves participant in groups', async () => {
  const connection = new WhatsAppConnection({}, {}, dummyLogger())
  const sent = []
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content })
      return {}
    },
  }
  connection.status = 'connected'

  // Reaction in DM with accidental participant -> participant MUST be stripped
  await connection.sendReaction(
    '6283197859955@s.whatsapp.net',
    {
      id: 'dm-msg-1',
      remoteJid: '6283197859955@s.whatsapp.net',
      participant: '6283197859955@s.whatsapp.net',
    },
    '⏳',
  )

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].content.react.key, {
    id: 'dm-msg-1',
    remoteJid: '6283197859955@s.whatsapp.net',
    fromMe: false,
  })

  // Reaction in group with LID participant -> participant MUST be preserved
  await connection.sendReaction(
    '120363040000000000@g.us',
    {
      id: 'group-msg-1',
      remoteJid: '120363040000000000@g.us',
      participant: '88150529556589@lid',
    },
    '⏳',
  )

  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1].content.react.key, {
    id: 'group-msg-1',
    remoteJid: '120363040000000000@g.us',
    fromMe: false,
    participant: '88150529556589@lid',
  })
})

test('sendReaction dynamically maps phone number to LID in group when needed', async () => {
  const connection = new WhatsAppConnection({}, {}, dummyLogger())
  const sent = []
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content })
      return {}
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn) => {
          if (pn === '6283197859955@s.whatsapp.net') return '88150529556589@lid'
          return null
        },
      },
    },
  }
  connection.status = 'connected'

  await connection.sendReaction(
    '120363040000000000@g.us',
    {
      id: 'group-msg-2',
      remoteJid: '120363040000000000@g.us',
      participant: '6283197859955@s.whatsapp.net',
    },
    '⏳',
  )

  assert.equal(sent.length, 1)
  assert.equal(sent[0].content.react.key.participant, '88150529556589@lid')
})

test('deleteMessage strips participant in DMs and preserves participant in groups', async () => {
  const connection = new WhatsAppConnection({}, {}, dummyLogger())
  const sent = []
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content })
      return {}
    },
  }
  connection.status = 'connected'

  // DM delete
  await connection.deleteMessage('6283197859955@s.whatsapp.net', {
    id: 'dm-del-1',
    participant: '6283197859955@s.whatsapp.net',
  })
  assert.deepEqual(sent[0].content.delete, {
    id: 'dm-del-1',
    remoteJid: '6283197859955@s.whatsapp.net',
    fromMe: false,
  })

  // Group delete
  await connection.deleteMessage('120363040000000000@g.us', {
    id: 'grp-del-1',
    participant: '88150529556589@lid',
  })
  assert.deepEqual(sent[1].content.delete, {
    id: 'grp-del-1',
    remoteJid: '120363040000000000@g.us',
    fromMe: false,
    participant: '88150529556589@lid',
  })
})

test('CommandRegistry dispatch uses rawKey for context.react', async () => {
  const reactions = []
  const mockWhatsApp = {
    sendReaction: async (jid, key, emoji) => {
      reactions.push({ jid, key, emoji })
    },
    sendText: async () => {},
  }
  const config = { commandPrefix: '!', defaultCooldownMs: 0 }
  const logger = dummyLogger()
  const services = { get() { return undefined } }
  const events = { emit: async () => {} }
  const registry = new CommandRegistry(config, logger, mockWhatsApp, services, events)

  registry.register({
    name: 'heavycmd',
    scope: 'all',
    handler: async (ctx) => {
      await ctx.react('⏳')
    },
  })

  // Dispatch message with rawKey
  await registry.dispatch({
    id: 'cmd-msg-1',
    remoteJid: '120363040000000000@g.us',
    senderJid: '6283197859955@s.whatsapp.net',
    text: '!heavycmd',
    timestamp: Date.now(),
    fromMe: false,
    rawKey: {
      id: 'cmd-msg-1',
      remoteJid: '120363040000000000@g.us',
      fromMe: false,
      participant: '88150529556589@lid',
    },
  })

  assert.equal(reactions.length, 1)
  assert.equal(reactions[0].emoji, '⏳')
  assert.deepEqual(reactions[0].key, {
    id: 'cmd-msg-1',
    remoteJid: '120363040000000000@g.us',
    fromMe: false,
    participant: '88150529556589@lid',
  })
})
