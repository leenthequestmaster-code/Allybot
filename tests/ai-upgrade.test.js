import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createAiPlugin, isAllowedPublicMenuCommand, matchNaturalLanguageCommand } from '../dist/framework/plugins/ai.js'
import { AiMemoryService } from '../dist/services/ai-memory-service.js'
import { buildPersonaSystemPrompt, formatWibDateTime } from '../dist/services/ai-persona-engine.js'

const logger = pino({ level: 'silent' })

class FakeWhatsApp {
  isConnected = true
  userJid = '628999999999@s.whatsapp.net'
  userLid = '999888777@lid'
  sent = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()

  onMessage(listener) {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }
  onGroupParticipantUpdate(listener) {
    this.groupParticipantListeners.add(listener)
    return () => this.groupParticipantListeners.delete(listener)
  }
  onConnectionState(listener) {
    this.connections.add(listener)
    return () => this.connections.delete(listener)
  }
  async sendText(remoteJid, text, options) {
    this.sent.push({ remoteJid, text, options })
  }
  async start() {
    this.isConnected = true
  }
  async close() {
    this.isConnected = false
  }
  async emitMessage(message) {
    await Promise.all([...this.messages].map((listener) => listener(message)))
  }
}

test('AiPersonaEngine injects real-time WIB day/date/time and natural human persona layers', () => {
  const fixedDate = new Date('2026-10-21T10:30:00.000Z') // 17:30 WIB (Rabu)
  const wib = formatWibDateTime(fixedDate)
  assert.match(wib.fullText, /Rabu/i)
  assert.match(wib.fullText, /2026/)
  assert.equal(wib.timeOfDay, 'sore')

  const systemPrompt = buildPersonaSystemPrompt({
    senderName: 'Budi',
    isGroup: true,
    groupName: 'Allyssea OOC',
    now: fixedDate,
  })
  assert.match(systemPrompt, /Budi/)
  assert.match(systemPrompt, /Allyssea OOC/)
  assert.match(systemPrompt, /Rabu/i)
  assert.match(systemPrompt, /DILARANG KERAS/i)
})

test('AiMemoryService stores multi-turn sliding window and supports reset', async () => {
  const memory = new AiMemoryService({ maxTurns: 4, ttlSeconds: 60 })
  const groupJid = '120363000000000001@g.us'
  const userJid = '628111111111@s.whatsapp.net'

  await memory.appendExchange(groupJid, userJid, 'Halo aku Raka', 'Halo Raka! Salam kenal ya~')
  await memory.appendExchange(groupJid, userJid, 'Siapa namaku tadi?', 'Namamu Raka dong!')

  const turns = await memory.getHistory(groupJid, userJid)
  assert.equal(turns.length, 4)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].content, 'Halo aku Raka')
  assert.equal(turns[3].role, 'assistant')

  await memory.clearHistory(groupJid, userJid)
  const cleared = await memory.getHistory(groupJid, userJid)
  assert.equal(cleared.length, 0)
})

test('@Allybot mention triggers natural conversational AI with multi-turn memory and reply continuity', async () => {
  const wa = new FakeWhatsApp()
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, wa)
  const aiCalls = []

  app.registerService(new AiMemoryService())
  app.registerPlugin(
    createAiPlugin({
      whatsapp: wa,
      transport: async (req) => {
        aiCalls.push(req)
        return { content: 'Halo juga! Hari ini hari Rabu nih, lagi santai kah?' }
      },
    }),
  )
  await app.start()

  // Turn 1: User tags bot number via native WhatsApp mention
  await wa.emitMessage({
    id: 'msg-tag-1',
    remoteJid: '120363000000000001@g.us',
    senderJid: '6281200000001@s.whatsapp.net',
    pushName: 'Leen',
    mentionedJids: ['628999999999@s.whatsapp.net'],
    text: '@628999999999 Halo bot, hari ini hari apa?',
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.equal(aiCalls.length, 1)
  assert.equal(aiCalls[0].userMessage, 'Halo bot, hari ini hari apa?')
  assert.match(wa.sent.at(-1).text, /Hari ini hari Rabu nih/)

  // Turn 2: User replies directly to Allybot's AI message without typing !ai or @Allybot
  await wa.emitMessage({
    id: 'msg-reply-2',
    remoteJid: '120363000000000001@g.us',
    senderJid: '6281200000001@s.whatsapp.net',
    pushName: 'Leen',
    quotedSenderJid: '628999999999@s.whatsapp.net',
    quotedText: wa.sent.at(-1).text,
    text: 'Kalau besok hari apa dong?',
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.equal(aiCalls.length, 2)
  assert.equal(aiCalls[1].userMessage, 'Kalau besok hari apa dong?')
  assert.equal(aiCalls[1].history.length, 2)
  assert.equal(aiCalls[1].history[0].content, 'Halo bot, hari ini hari apa?')

  await app.stop()
})

test('@Allybot Smart Command Router executes public !menu commands via fast-path and natural language while blocking !pay and admin commands', async () => {
  const wa = new FakeWhatsApp()
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, wa)
  const executedCommands = []

  app.registerService(new AiMemoryService())
  app.registerPlugin({
    name: 'mock-menu-commands',
    load(ctx) {
      ctx.commands.register({
        name: 'sticker',
        aliases: ['s'],
        description: 'Buat stiker dari gambar atau video',
        category: 'tools',
        handler: async (cmdCtx) => {
          executedCommands.push({
            name: 'sticker',
            args: cmdCtx.args,
            hasImage: cmdCtx.message.media?.kind === 'image',
          })
          await cmdCtx.reply('Stiker berhasil dibuat!')
        },
      })
      ctx.commands.register({
        name: 'play',
        description: 'Putar lagu dari pencarian judul',
        category: 'tools',
        handler: async (cmdCtx) => {
          executedCommands.push({
            name: 'play',
            args: cmdCtx.args,
          })
          await cmdCtx.reply(`Memutar lagu: ${cmdCtx.args.join(' ')}`)
        },
      })
      ctx.commands.register({
        name: 'pay',
        description: 'Transfer Vela ke member lain',
        category: 'your-character',
        handler: async () => {
          executedCommands.push({ name: 'pay' })
        },
      })
      ctx.commands.register({
        name: 'kick',
        description: 'Keluarkan member dari grup',
        category: 'moderation',
        permission: 'group.admin',
        handler: async () => {
          executedCommands.push({ name: 'kick' })
        },
      })
    },
  })

  app.registerPlugin(
    createAiPlugin({
      whatsapp: wa,
      transport: async () => ({ content: 'fallback chat' }),
    }),
  )
  await app.start()

  // 1. Natural language sticker request with attached image: "@Allybot tolong ubah gambar ini jadi stiker"
  await wa.emitMessage({
    id: 'msg-nl-sticker',
    remoteJid: '120363000000000001@g.us',
    senderJid: '6281200000001@s.whatsapp.net',
    text: '@Allybot tolong ubah gambar ini jadi stiker',
    media: { kind: 'image', mimeType: 'image/jpeg' },
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.equal(executedCommands.length, 1)
  assert.equal(executedCommands[0].name, 'sticker')
  assert.equal(executedCommands[0].hasImage, true)

  // 2. Fast-path / natural play request: "@Allybot play Duka Last Child"
  await wa.emitMessage({
    id: 'msg-nl-play',
    remoteJid: '120363000000000001@g.us',
    senderJid: '6281200000001@s.whatsapp.net',
    text: '@Allybot play Duka Last Child',
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.equal(executedCommands.length, 2)
  assert.equal(executedCommands[1].name, 'play')
  assert.deepEqual(executedCommands[1].args, ['Duka', 'Last', 'Child'])

  // 3. Economy mutation command (!pay) MUST be blocked from @Allybot router and require manual !pay
  await wa.emitMessage({
    id: 'msg-nl-pay-blocked',
    remoteJid: '120363000000000001@g.us',
    senderJid: '6281200000001@s.whatsapp.net',
    text: '@Allybot pay @628222222222 5000',
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.equal(executedCommands.length, 2) // pay was NOT executed!
  assert.match(wa.sent.at(-1).text, /wajib diketik manual pakai command/i)

  // 4. Admin command (!kick) is excluded by isAllowedPublicMenuCommand
  assert.equal(
    isAllowedPublicMenuCommand({
      name: 'kick',
      category: 'moderation',
      permission: 'group.admin',
      handler: () => {},
    }),
    false,
  )

  await app.stop()
})
