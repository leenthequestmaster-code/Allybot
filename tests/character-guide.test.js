import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { EventBus } from '../dist/framework/event-bus.js'
import { MessageGateRegistry } from '../dist/framework/message-gate.js'
import { createCharacterGuidePlugin } from '../dist/framework/plugins/character-guide.js'

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000000@g.us'
const ownerJid = '628120000000@s.whatsapp.net'
const botJid = '628990000000@s.whatsapp.net'
const sessionId = '11111111-1111-4111-8111-111111111111'
const characterId = '22222222-2222-4222-8222-222222222222'
const referenceKey = 'a'.repeat(64)

const body = `Name: Aruna
Gender: Female
Age: 24
Birthday: 12 Zephyra 776 KAR
Race: Human
Class: Knight
Element: Fire
Will Of Path: Neutral`

function createHarness({ existing = false } = {}) {
  const sent = []
  const quickReplies = []
  const commands = new Map()
  let registrationExists = false
  const service = {
    name: 'character-guide',
    isEnabled: true,
    createCardReference() { return referenceKey },
    async getActive() { return undefined },
    async getActiveForOwner() { return undefined },
    async getRegistration() { return registrationExists ? { sessionId, referenceKey, code: 'existing', existing: true } : undefined },
    async startRegistration() {
      if (existing) return { sessionId, referenceKey: 'b'.repeat(64), code: 'existing', existing: true }
      registrationExists = true
      return { sessionId, referenceKey, code: 'created', existing: false }
    },
    async save() { return { characterId, deliveryId: undefined, name: 'Aruna', status: 'saved' } },
    async cancelRegistration() { registrationExists = false },
    async pendingDeliveryForOwner() { return undefined },
    async markDelivery() {},
    async retire() {},
  }
  const groupContext = {
    name: 'group-context',
    isEnabled: true,
    async get() { return { groupKey: 'c'.repeat(64), mode: 'guide', oocPolicy: 'disabled', revision: 1, enabled: true } },
  }
  const events = new EventBus(logger)
  const context = {
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0, characterGuideSessionTtlSeconds: 1800 },
    services: {
      get(name) {
        if (name === 'character-guide') return service
        if (name === 'group-context') return groupContext
        throw new Error(`unexpected service ${name}`)
      },
      has(name) { return name === 'character-guide' || name === 'group-context' },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    events,
    messageGates: new MessageGateRegistry(),
  }
  const whatsapp = {
    userJid: botJid,
    async sendText(remoteJid, text) { sent.push({ remoteJid, text }) },
    async sendNativeQuickReplies(remoteJid, payload) { quickReplies.push({ remoteJid, payload }) },
    async getGroupMetadata() { return { jid: groupJid, subject: 'Guide', participants: [{ jid: ownerJid, role: 'member' }] } },
  }
  return { context, events, whatsapp, sent, quickReplies, commands, service, setRegistration(value) { registrationExists = value } }
}

function commandContext(harness, text, overrides = {}) {
  const message = {
    id: 'save-message',
    remoteJid: groupJid,
    senderJid: ownerJid,
    timestamp: Date.now(),
    fromMe: false,
    text,
    ...overrides,
  }
  return {
    message,
    args: text.slice(1).split(/\s+/u).slice(1),
    commandName: text.slice(1).split(/\s+/u)[0],
    prefix: '!',
    config: harness.context.config,
    logger,
    services: harness.context.services,
    whatsapp: harness.whatsapp,
    async reply(replyText) { harness.sent.push({ remoteJid: groupJid, text: replyText }) },
  }
}

test('Character Guide handles experience selection without quotedMessageId and issues one coherent card session', async () => {
  const harness = createHarness()
  await createCharacterGuidePlugin(harness.whatsapp).load(harness.context)
  await harness.commands.get('daftar').handler(commandContext(harness, '!daftar', { id: 'daftar-1' }))
  await harness.events.emit('message.received', {
    id: 'choice-1', remoteJid: groupJid, senderJid: ownerJid, text: '1', timestamp: Date.now(), fromMe: false,
  })

  assert.equal(harness.quickReplies.length, 1)
  assert.ok(harness.sent.some((item) => item.text.includes('Character ID Card')))
  assert.equal(harness.service.startRegistration !== undefined, true)
})

test('Character Guide refuses to silently map a new card to a different existing session', async () => {
  const harness = createHarness({ existing: true })
  await createCharacterGuidePlugin(harness.whatsapp).load(harness.context)
  await harness.commands.get('daftar').handler(commandContext(harness, '!daftar', { id: 'daftar-existing' }))
  await harness.events.emit('message.received', {
    id: 'choice-existing', remoteJid: groupJid, senderJid: ownerJid, text: '1', timestamp: Date.now(), fromMe: false,
  })
  assert.ok(harness.sent.some((item) => item.text.includes('ID Card aktif')))
  assert.equal(harness.sent.some((item) => item.text.includes('Character ID Card')), false)
})

test('Character Guide save path validates reply/card and calls service only after parser succeeds', async () => {
  const harness = createHarness()
  await createCharacterGuidePlugin(harness.whatsapp).load(harness.context)
  await harness.commands.get('daftar').handler(commandContext(harness, '!daftar', { id: 'daftar-save' }))
  await harness.events.emit('message.received', {
    id: 'choice-save', remoteJid: groupJid, senderJid: ownerJid, text: '1', timestamp: Date.now(), fromMe: false,
  })
  harness.setRegistration(true)
  await harness.commands.get('savecharacter').handler(commandContext(harness, `!savecharacter\n${body}`, {
    id: 'save-1',
    quotedMessageId: 'card-message',
    quotedSenderJid: botJid,
    quotedText: 'Character ID Card\nRegistration ID: AAAABBBBCCCC',
  }))
  assert.ok(harness.sent.some((item) => item.text.includes('berhasil disimpan')))
})

test('Guide participant add creates onboarding prompt but does not create durable session before card issuance', async () => {
  const harness = createHarness()
  await createCharacterGuidePlugin(harness.whatsapp).load(harness.context)
  await harness.events.emit('group.participants.changed', {
    groupJid,
    action: 'add',
    participantJids: [ownerJid, botJid],
    at: 1_700_000_000_000,
  })
  assert.equal(harness.quickReplies.length, 1)
  assert.ok(harness.sent.some((item) => item.text.includes('Selamat datang')))
})
