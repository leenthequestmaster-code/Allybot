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
  const updatedParticipants = []
  const updatedSettings = []

  return {
    sentTexts,
    deletedMessages,
    updatedParticipants,
    updatedSettings,
    userJid: '6285181696890@s.whatsapp.net',
    onMessage(cb) {
      listeners.message.push(cb)
      return () => {}
    },
    onGroupParticipantUpdate(cb) {
      listeners.participant.push(cb)
      return () => {}
    },
    onConnectionState(cb) {
      return () => {}
    },
    async sendText(remoteJid, text, options) {
      sentTexts.push({ remoteJid, text, options })
    },
    async deleteMessage(remoteJid, key) {
      deletedMessages.push({ remoteJid, key })
    },
    async groupParticipantsUpdate(groupJid, targets, action) {
      updatedParticipants.push({ groupJid, targets, action })
      return targets.map((jid) => ({ participantJid: jid, status: 'ok' }))
    },
    async groupSettingUpdate(groupJid, setting) {
      updatedSettings.push({ groupJid, setting })
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
          { jid: '6285181696890@s.whatsapp.net', role: 'admin' }, // bot is admin
        ],
      }
    },
    async getGroupInviteLink(_groupJid) {
      return 'https://chat.whatsapp.com/TESTCODE123'
    },
    async start() {},
    async close() {},
    async emitMessage(msg) {
      for (const cb of listeners.message) await cb(msg)
    },
    async emitParticipant(event) {
      for (const cb of listeners.participant) await cb(event)
    },
  }
}

test('Moderation Suite: kick, ban, unban, mute, and unmute workflows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-mod-test-'))
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
  const ownerJid = '6281111111111@s.whatsapp.net'

  // 1. Kick member
  await whatsapp.emitMessage({
    id: 'msg-kick-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!kick @6283333333333`,
    mentionedJids: [memberJid],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(whatsapp.updatedParticipants.length, 1)
  assert.equal(whatsapp.updatedParticipants[0].action, 'remove')
  assert.deepEqual(whatsapp.updatedParticipants[0].targets, [memberJid])

  // Kick owner should fail
  await whatsapp.emitMessage({
    id: 'msg-kick-owner',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!kick @6281111111111`,
    mentionedJids: [ownerJid],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Owner grup tidak dapat/)

  // 2. Ban and Blacklist auto-kick
  await whatsapp.emitMessage({
    id: 'msg-ban-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!ban @6283333333333 Toxic parah`,
    mentionedJids: [memberJid],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(suiteService.isBanned(groupJid, memberJid))

  // Simulate user tries to rejoin -> auto-kick
  await framework.events.emit('group.participants.changed', {
    groupJid,
    action: 'add',
    participantJids: [memberJid],
  })
  assert.equal(whatsapp.updatedParticipants.filter((p) => p.action === 'remove' && p.targets.includes(memberJid)).length, 3)

  // 3. Unban
  await whatsapp.emitMessage({
    id: 'msg-unban-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!unban 6283333333333`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!suiteService.isBanned(groupJid, memberJid))

  // 4. Mute and auto message deletion
  await whatsapp.emitMessage({
    id: 'msg-mute-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!mute @6284444444444 10m`,
    mentionedJids: ['6284444444444@s.whatsapp.net'],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(suiteService.isMuted(groupJid, '6284444444444@s.whatsapp.net'))

  // Muted user sends message -> auto deleted
  await whatsapp.emitMessage({
    id: 'msg-muted-send',
    remoteJid: groupJid,
    senderJid: '6284444444444@s.whatsapp.net',
    text: 'Halo halo saya bicara',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'msg-muted-send'))

  // 5. Unmute
  await whatsapp.emitMessage({
    id: 'msg-unmute-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!unmute @6284444444444`,
    mentionedJids: ['6284444444444@s.whatsapp.net'],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(!suiteService.isMuted(groupJid, '6284444444444@s.whatsapp.net'))

  // 6. Promote and Demote
  await whatsapp.emitMessage({
    id: 'msg-promote-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!promote @6284444444444`,
    mentionedJids: ['6284444444444@s.whatsapp.net'],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.updatedParticipants.some((p) => p.action === 'promote' && p.targets.includes('6284444444444@s.whatsapp.net')))

  await whatsapp.emitMessage({
    id: 'msg-demote-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!demote @6282222222222`,
    mentionedJids: [adminJid],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.updatedParticipants.some((p) => p.action === 'demote' && p.targets.includes(adminJid)))

  // 7. Lock and Unlock
  await whatsapp.emitMessage({
    id: 'msg-lock-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!lock`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(whatsapp.updatedSettings.at(-1)?.setting, 'announcement')

  await whatsapp.emitMessage({
    id: 'msg-unlock-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!unlock`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(whatsapp.updatedSettings.at(-1)?.setting, 'not_announcement')

  // 8. Tagall & Hidetag
  await whatsapp.emitMessage({
    id: 'msg-tagall-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!tagall Halo semuanya`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /TAG ALL/)

  // 9. Del (Delete reply)
  await whatsapp.emitMessage({
    id: 'msg-del-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!del`,
    quotedMessageId: 'target-spam-msg-99',
    quotedSenderJid: memberJid,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.ok(whatsapp.deletedMessages.some((d) => d.key.id === 'target-spam-msg-99'))

  // 10. Warn with auto-kick on limit (setlimit 2)
  await whatsapp.emitMessage({
    id: 'msg-setlimit-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!setlimit 2`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(suiteService.getWarnLimit(groupJid), 2)

  const testTarget = '6284444444444@s.whatsapp.net'
  // First warn
  await whatsapp.emitMessage({
    id: 'msg-warn-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!warn @6284444444444 Spam link`,
    mentionedJids: [testTarget],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /peringatan ke-1\/2/)

  // Second warn -> should trigger auto-kick!
  const participantsCountBefore = whatsapp.updatedParticipants.length
  await whatsapp.emitMessage({
    id: 'msg-warn-2',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!warn @6284444444444 Spam lagi`,
    mentionedJids: [testTarget],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /mencapai batas 2\/2 peringatan dan dikeluarkan/)
  assert.ok(whatsapp.updatedParticipants.slice(participantsCountBefore).some((p) => p.action === 'remove' && p.targets.includes(testTarget)))

  // 11. Unwarn
  await whatsapp.emitMessage({
    id: 'msg-unwarn-1',
    remoteJid: groupJid,
    senderJid: adminJid,
    text: `!unwarn @6284444444444`,
    mentionedJids: [testTarget],
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /berhasil dikurangi/)

  // 12. Essential: info & tagme
  await whatsapp.emitMessage({
    id: 'msg-info-1',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: `!info`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Informasi Pengguna|𝐈𝗻𝗳𝗼𝗿𝗺𝗮𝘀𝗶 𝐏𝗲𝗻𝗴𝗴𝘂𝗻𝗮/)

  await whatsapp.emitMessage({
    id: 'msg-tagme-1',
    remoteJid: groupJid,
    senderJid: memberJid,
    text: `!tagme`,
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(whatsapp.sentTexts.at(-1)?.text ?? '', /Halo @6283333333333!/)

  await framework.stop()
  rmSync(root, { recursive: true, force: true })
})
