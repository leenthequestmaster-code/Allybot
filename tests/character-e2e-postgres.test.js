import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { EventBus } from '../dist/framework/event-bus.js'
import { MessageGateRegistry } from '../dist/framework/message-gate.js'
import { createCharacterGuidePlugin } from '../dist/framework/plugins/character-guide.js'
import { CharacterGuideService } from '../dist/services/character-guide-service.js'
import { GroupContextService } from '../dist/services/group-context-service.js'
import { createPostgresCharacterClient } from '../dist/services/character-postgres-client.js'
import { createPostgresGroupContextClient } from '../dist/services/group-context-postgres-client.js'

const logger = pino({ level: 'silent' })
const POSTGRES_URL = 'postgres://allybot:allybot_secret_pass@127.0.0.1:5432/allybot'
const groupJid = '120363000000000099@g.us'
const ownerJid = '6281299999999@s.whatsapp.net'
const botJid = '6285181696890@s.whatsapp.net'

const sampleSheet = `Name: Cheryl
Gender: Female
Age: 22
Birthday: 15 Zephyra 778 KAR
Race: Human
Class: Knight
Element: Fire
Will Of Path: Light`

test('End-to-end: Setgroup guide -> !daftar -> choice -> issue card -> savecharacter -> getActive -> retire', async () => {
  const charClient = createPostgresCharacterClient({ postgresUrl: POSTGRES_URL })
  const groupClient = createPostgresGroupContextClient({ postgresUrl: POSTGRES_URL })

  const charService = new CharacterGuideService(logger, { env: { CHARACTER_GUIDE_ENABLED: 'true' }, createClient: () => charClient })
  const groupService = new GroupContextService(logger, { env: { GROUP_CONTEXT_ENABLED: 'true' }, createClient: () => groupClient })

  charService.initialize({ logger, config: {}, services: {} })
  groupService.initialize({ logger, config: {}, services: {} })

  // 1. Set group mode to guide
  const setGroupResult = await groupService.set(groupJid, 'guide', undefined, 'disabled', ownerJid)
  assert.equal(setGroupResult.mode, 'guide')

  // Clean previous registration/active character
  const reg = await charService.getRegistration(groupJid, ownerJid)
  if (reg) await charService.cancelRegistration(groupJid, ownerJid, reg.sessionId)
  const existingActive = await charService.getActive(groupJid, ownerJid)
  if (existingActive) await charService.retire(groupJid, ownerJid, existingActive.characterId)

  const sent = []
  const commands = new Map()
  const events = new EventBus(logger)

  const context = {
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0, characterGuideSessionTtlSeconds: 1800 },
    services: {
      get(name) {
        if (name === 'character-guide') return charService
        if (name === 'group-context') return groupService
        throw new Error(`unexpected service: ${name}`)
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
    async sendNativeQuickReplies(remoteJid, payload) { sent.push({ remoteJid, text: payload.body }) },
    async getGroupMetadata() { return { jid: groupJid, subject: 'Guide Group', participants: [{ jid: ownerJid, role: 'member' }] } },
  }

  const plugin = createCharacterGuidePlugin(whatsapp)
  plugin.load(context)

  function cmdCtx(text, overrides = {}) {
    const parts = text.slice(1).split(/\s+/u)
    return {
      message: {
        id: 'msg-' + Math.random().toString(36).slice(2),
        remoteJid: groupJid,
        senderJid: ownerJid,
        timestamp: Date.now(),
        fromMe: false,
        text,
        ...overrides,
      },
      args: parts.slice(1),
      commandName: parts[0],
      prefix: '!',
      config: context.config,
      logger,
      services: context.services,
      whatsapp,
      async reply(replyText) { sent.push({ remoteJid: groupJid, text: replyText }) },
    }
  }

  // 2. User sends !daftar
  await commands.get('daftar').handler(cmdCtx('!daftar'))
  assert.ok(sent.some((item) => item.text.includes('Selamat datang') || item.text.includes('pengalamanmu')), 'Prompt daftar sent')

  // 3. User chooses 1 (Pemula)
  await events.emit('message.received', {
    id: 'choice-msg-1',
    remoteJid: groupJid,
    senderJid: ownerJid,
    text: '1',
    timestamp: Date.now(),
    fromMe: false,
  })

  // Bot should have issued a Character ID Card message
  const cardMsg = sent.find((item) => item.text.includes('Registration ID:'))
  assert.ok(cardMsg, 'Character ID Card issued')

  // 4. User replies to that Card with !savecharacter and the sheet
  await commands.get('savecharacter').handler(cmdCtx(`!savecharacter\n${sampleSheet}`, {
    quotedMessageId: 'card-msg-id-123',
    quotedSenderJid: botJid,
    quotedText: cardMsg.text,
  }))

  assert.ok(sent.some((item) => item.text.includes('berhasil disimpan')), 'Character saved message sent')

  // 5. Verify directly in PostgreSQL via service
  const activeChar = await charService.getActive(groupJid, ownerJid)
  assert.ok(activeChar, 'Active character found in DB')
  assert.equal(activeChar.name, 'Cheryl')
  assert.equal(activeChar.race, 'Human')
  assert.equal(activeChar.className, 'Knight')
  assert.equal(activeChar.element, 'Fire')
  assert.equal(activeChar.status, 'active')

  // 6. Test !character command to view active sheet
  await commands.get('character').handler(cmdCtx('!character'))
  assert.ok(sent.some((item) => item.text.includes('Cheryl') && item.text.includes('Knight')), '!character shows sheet')

  // 7. Clean up / retire character
  await charService.retire(groupJid, ownerJid, activeChar.characterId)
  const afterRetire = await charService.getActive(groupJid, ownerJid)
  assert.equal(afterRetire, undefined, 'Character successfully retired')
})
