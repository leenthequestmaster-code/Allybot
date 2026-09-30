import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'
import { createModerationSuitePlugin } from '../dist/framework/plugins/moderation-suite.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'

const logger = pino({ level: 'silent' })

function createFakeWhatsapp() {
  const listeners = {
    message: [],
    participant: [],
  }

  const sentTexts = []
  const deletedMessages = []
  let inviteLinkFetchCount = 0

  return {
    sentTexts,
    deletedMessages,
    get inviteLinkFetchCount() {
      return inviteLinkFetchCount
    },
    userJid: '6285181696890@s.whatsapp.net',
    onMessage(cb) {
      listeners.message.push(cb)
      return () => {}
    },
    onGroupParticipantUpdate(cb) {
      listeners.participant.push(cb)
      return () => {}
    },
    onConnectionState() {
      return () => {}
    },
    async sendText(remoteJid, text, options) {
      sentTexts.push({ remoteJid, text, options })
    },
    async deleteMessage(remoteJid, key) {
      deletedMessages.push({ remoteJid, key })
    },
    async getGroupMetadata(groupJid) {
      return {
        jid: groupJid,
        subject: 'Test Group',
        ownerJid: '6281111111111@s.whatsapp.net',
        participants: [
          { jid: '6281111111111@s.whatsapp.net', role: 'superadmin' },
          { jid: '6282222222222@s.whatsapp.net', role: 'admin' },
          { jid: '6283333333333@s.whatsapp.net', role: 'member' },
          { jid: '6284444444444@s.whatsapp.net', role: 'member' },
          { jid: '6285181696890@s.whatsapp.net', role: 'admin' },
        ],
      }
    },
    async getGroupInviteLink(_groupJid) {
      inviteLinkFetchCount++
      return 'https://chat.whatsapp.com/TESTGROUP123'
    },
    async start() {},
    async close() {},
    async emitMessage(msg) {
      for (const cb of listeners.message) await cb(msg)
    },
  }
}

test('Automod Hardened: Antilink channel exemption, anti-smuggling, caching, and evasion defense', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-antilink-hardened-'))
  const dbPath = join(root, 'test.sqlite')
  const whatsapp = createFakeWhatsapp()

  const framework = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, databasePath: dbPath },
    logger,
    whatsapp,
    { permissionResolver: createPermissionResolver(whatsapp, '6281111111111') },
  )

  const suiteService = new GroupModerationSuiteService(dbPath, logger)
  const configService = new GroupConfigurationService(dbPath, logger)
  const guardrailService = new PlatformGuardrailService(dbPath, logger)
  const safetyService = new GroupSafetyService(dbPath, logger)

  framework.registerService(suiteService)
  framework.registerService(configService)
  framework.registerService(guardrailService)
  framework.registerService(safetyService)

  framework.registerPlugin(createModerationSuitePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))

  await framework.start()

  const groupJid = '120363000000000001@g.us'
  const adminJid = '6282222222222@s.whatsapp.net'
  const memberJid = '6283333333333@s.whatsapp.net'

  // 1. Enable antilink
  await whatsapp.emitMessage({
    id: 'cmd-antilink-on',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: '!antilink on',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Filter antilink sekarang: \*ON\*/)

  // 2. Standard external link -> DELETED + WARNED
  await whatsapp.emitMessage({
    id: 'msg-ext-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Cek web ini ya https://phishing.site/promo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-ext-link'))
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Dilarang mengirim tautan\/link di grup ini/)

  // 3. Shortlink without protocol (wa.me) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-wame-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Chat aku di wa.me/6281234567890 ya',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-wame-link'))

  // 4. Obfuscated dot (judi[.]com) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-obfuscated-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Gacor di judi[.]com/slot hari ini',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-obfuscated-link'))

  // 5. WhatsApp Channel link (EXEMPTED / WHITELISTED) -> NOT DELETED
  await whatsapp.emitMessage({
    id: 'msg-channel-link-1',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Follow saluran kita https://whatsapp.com/channel/0029VaABC123 ya teman-teman',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-channel-link-1'))

  // 6. WhatsApp Channel link without https -> NOT DELETED
  await whatsapp.emitMessage({
    id: 'msg-channel-link-2',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Buka whatsapp.com/channel/0029VaXYZ789',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-channel-link-2'))

  // 7. Group's own invite link -> NOT DELETED
  await whatsapp.emitMessage({
    id: 'msg-own-group-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Undang teman ke grup: https://chat.whatsapp.com/TESTGROUP123',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-own-group-link'))

  // 7b. Inverse substring evasion attempt (chat.whatsapp.com without code or different code) -> DELETED!
  await whatsapp.emitMessage({
    id: 'msg-evasion-bare-domain',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Cek tautan grup ini https://chat.whatsapp.com/OTHERGROUP999',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-evasion-bare-domain'))

  // 8. Anti-Smuggling: Channel link + Forbidden external link in same message -> DELETED!
  await whatsapp.emitMessage({
    id: 'msg-smuggled-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Join saluran https://whatsapp.com/channel/0029VaABC123 dan juga daftar di http://phishing.site/xyz',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-smuggled-link'))

  // 9. Caching verification: Multiple link checks should hit memory cache without re-fetching invite link
  const fetchCountBefore = whatsapp.inviteLinkFetchCount
  for (let i = 0; i < 3; i++) {
    await whatsapp.emitMessage({
      id: `msg-cached-link-${i}`,
      remoteJid: groupJid,
      senderJid: memberJid,
      text: 'Link lagi: https://chat.whatsapp.com/TESTGROUP123',
      timestamp: Date.now(),
      fromMe: false,
    })
  }
  assert.equal(whatsapp.inviteLinkFetchCount, fetchCountBefore) // No additional calls!

  // 10. Admin bypass
  await whatsapp.emitMessage({
    id: 'msg-admin-link',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: 'Pengumuman resmi dari admin: https://example.com/docs',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-admin-link'))

  await framework.stop()
  rmSync(root, { recursive: true, force: true })
})

test('Automod Hardened: Antitoxic Unicode evasion, homoglyphs, delimiters, leetspeak, and safe phrases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-antitoxic-hardened-'))
  const dbPath = join(root, 'test.sqlite')
  const whatsapp = createFakeWhatsapp()

  const framework = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, databasePath: dbPath },
    logger,
    whatsapp,
    { permissionResolver: createPermissionResolver(whatsapp, '6281111111111') },
  )

  const suiteService = new GroupModerationSuiteService(dbPath, logger)
  const configService = new GroupConfigurationService(dbPath, logger)
  const guardrailService = new PlatformGuardrailService(dbPath, logger)
  const safetyService = new GroupSafetyService(dbPath, logger)

  framework.registerService(suiteService)
  framework.registerService(configService)
  framework.registerService(guardrailService)
  framework.registerService(safetyService)

  framework.registerPlugin(createModerationSuitePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))

  await framework.start()

  const groupJid = '120363000000000001@g.us'
  const adminJid = '6282222222222@s.whatsapp.net'
  const memberJid = '6283333333333@s.whatsapp.net'

  // Enable antitoxic
  await whatsapp.emitMessage({
    id: 'cmd-antitoxic-on',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: '!antitoxic on',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Filter antitoxic sekarang: \*ON\*/)

  // 1. ZWSP evasion (\u200B) -> DELETED silently
  await whatsapp.emitMessage({
    id: 'msg-toxic-zwsp',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'dasar k\u200Bontol lu',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-zwsp'))

  // 2. Cyrillic homoglyph evasion (Cyrillic о = \u043e) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-toxic-homoglyph',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'dasar k\u043ent\u043el lu',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-homoglyph'))

  // 3. Dot delimiter evasion (k.o.n.t.o.l) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-toxic-dot',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'k.o.n.t.o.l lu',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-dot'))

  // 4. Dash delimiter evasion (k-o-n-t-o-l) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-toxic-dash',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'k-o-n-t-o-l lu',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-dash'))

  // 5. Spaced single letters (k o n t o l) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-toxic-spaced',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'k o n t o l lu',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-spaced'))

  // 6. Leetspeak evasion (k0nt0l / b@ngs4t) -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-toxic-leet',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'dasar b@ngs4t',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-toxic-leet'))

  // 7. False positive protection: "anjing laut" -> ALLOWED (NOT DELETED)
  await whatsapp.emitMessage({
    id: 'msg-safe-anjing-laut',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'lucu banget kemarin aku lihat anjing laut di pantai',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-safe-anjing-laut'))

  // 8. False positive protection: "babi hutan" -> ALLOWED (NOT DELETED)
  await whatsapp.emitMessage({
    id: 'msg-safe-babi-hutan',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'warga menangkap babi hutan yang masuk ke perkebunan',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-safe-babi-hutan'))

  // 9. Mixed safe phrase + real toxic -> DELETED
  await whatsapp.emitMessage({
    id: 'msg-mixed-toxic',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'anjing laut tapi kamu goblok',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-mixed-toxic'))

  // 10. Admin bypass
  await whatsapp.emitMessage({
    id: 'msg-admin-toxic',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: 'contoh kata toxic: anjing',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-admin-toxic'))

  await framework.stop()
  rmSync(root, { recursive: true, force: true })
})

test('Automod Hardened: Dry-Run harmony prevents destructive action while case is recorded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-dryrun-harmony-'))
  const dbPath = join(root, 'test.sqlite')
  const whatsapp = createFakeWhatsapp()

  const framework = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, databasePath: dbPath },
    logger,
    whatsapp,
    { permissionResolver: createPermissionResolver(whatsapp, '6281111111111') },
  )

  const suiteService = new GroupModerationSuiteService(dbPath, logger)
  const configService = new GroupConfigurationService(dbPath, logger)
  const guardrailService = new PlatformGuardrailService(dbPath, logger)
  const safetyService = new GroupSafetyService(dbPath, logger)

  framework.registerService(suiteService)
  framework.registerService(configService)
  framework.registerService(guardrailService)
  framework.registerService(safetyService)

  framework.registerPlugin(createModerationSuitePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))

  await framework.start()

  const groupJid = '120363000000000001@g.us'
  const adminJid = '6282222222222@s.whatsapp.net'
  const memberJid = '6283333333333@s.whatsapp.net'

  // Enable antilink AND enable safety dry-run
  await whatsapp.emitMessage({
    id: 'cmd-antilink-on-2',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: '!antilink on',
    timestamp: Date.now(),
    fromMe: false,
  })
  await whatsapp.emitMessage({
    id: 'cmd-setsafety-dryrun',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: '!setsafety dry-run',
    timestamp: Date.now(),
    fromMe: false,
  })

  // Member sends a forbidden link during dry-run
  await whatsapp.emitMessage({
    id: 'msg-dryrun-link',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: 'Cek ini https://forbidden.test/abc',
    timestamp: Date.now(),
    fromMe: false,
  })

  // 1. Message MUST NOT be deleted (dry-run suppresses destructive action)
  assert.ok(!whatsapp.deletedMessages.some((d) => d.key.id === 'msg-dryrun-link'))

  // 2. Case MUST be recorded in GroupSafetyService
  const cases = safetyService.listCases(groupJid, ['open'])
  assert.ok(cases.some((c) => c.ruleId === 'anti-link'))

  await framework.stop()
  rmSync(root, { recursive: true, force: true })
})
