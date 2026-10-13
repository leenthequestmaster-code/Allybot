import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { CommunityService } from '../dist/services/community-service.js'
import { createCommunityPlugin } from '../dist/framework/plugins/community.js'
import { remoteOpsPlugin } from '../dist/framework/plugins/remote-ops.js'
import { createModerationSuitePlugin } from '../dist/framework/plugins/moderation-suite.js'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'

const logger = pino({ level: 'silent' })
const ownerJid = '6283197859955@s.whatsapp.net'
const group1Jid = '120363001@g.us'
const group2Jid = '120363002@g.us'
const botJid = '6285181696890@s.whatsapp.net'
const userJid = '628123456789@s.whatsapp.net'

class MockWhatsAppPort {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  leftGroups = []
  groupActions = []
  messageListeners = new Set()
  participantListeners = new Set()
  connections = new Set()

  metadataMap = new Map([
    [
      group1Jid,
      {
        id: group1Jid,
        subject: 'Allyssea Hub 1',
        participants: [
          { jid: botJid, role: 'admin' },
          { jid: ownerJid, role: 'admin' },
          { jid: userJid, role: 'member' },
        ],
      },
    ],
    [
      group2Jid,
      {
        id: group2Jid,
        subject: 'Allyssea Roleplay 2',
        participants: [
          { jid: botJid, role: 'admin' },
          { jid: ownerJid, role: 'admin' },
          { jid: userJid, role: 'member' },
        ],
      },
    ],
  ])

  onMessage(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onGroupParticipantUpdate(listener) {
    this.participantListeners.add(listener)
    return () => this.participantListeners.delete(listener)
  }

  onConnectionState(listener) {
    this.connections.add(listener)
    return () => this.connections.delete(listener)
  }

  async sendText(remoteJid, text, options) {
    this.sent.push({ remoteJid, text, options })
  }

  async getGroupMetadata(groupJid) {
    const meta = this.metadataMap.get(groupJid)
    if (!meta) throw new Error(`Group metadata not found for ${groupJid}`)
    return meta
  }

  async groupParticipantsUpdate(groupJid, participantJids, action) {
    this.groupActions.push({ groupJid, participantJids, action })
    return participantJids.map((jid) => ({ participantJid: jid, status: '200' }))
  }

  async groupLeave(groupJid) {
    this.leftGroups.push(groupJid)
  }

  async emitMessage(message) {
    for (const listener of this.messageListeners) {
      await listener(message)
    }
  }

  async emitParticipantUpdate(event) {
    for (const listener of this.participantListeners) {
      await listener(event)
    }
  }

  async start() { this.isConnected = true }
  async close() { this.isConnected = false }
}

function tempDatabase() {
  return join(mkdtempSync(join(tmpdir(), 'allybot-comm-test-')), 'core.sqlite')
}

test('CommunityService manages official groups and blacklists correctly in SQLite', () => {
  const databasePath = tempDatabase()
  const service = new CommunityService(databasePath, logger)
  service.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: {} })

  try {
    // Groups
    assert.equal(service.listGroups().length, 0)
    service.registerGroup(group1Jid, 'Official Hub', ownerJid)
    assert.equal(service.listGroups().length, 1)
    assert.equal(service.isOfficialGroup(group1Jid), true)
    assert.equal(service.isOfficialGroup(group2Jid), false)

    // Blacklist
    assert.equal(service.isBlacklisted(userJid), false)
    service.banUser(userJid, 'Spamming raid', ownerJid)
    assert.equal(service.isBlacklisted(userJid), true)
    assert.equal(service.listBlacklist().length, 1)
    assert.equal(service.listBlacklist()[0].reason, 'Spamming raid')

    // Unban
    assert.equal(service.unbanUser(userJid), true)
    assert.equal(service.isBlacklisted(userJid), false)

    // Remove group
    assert.equal(service.removeGroup(group1Jid), true)
    assert.equal(service.isOfficialGroup(group1Jid), false)
  } finally {
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
    rmSync(databasePath, { force: true })
  }
})

test('Federated community commands: !addgroup, !clist, !ckick, !cban, and auto-eject on join', async () => {
  const databasePath = tempDatabase()
  const port = new MockWhatsAppPort()
  const communityService = new CommunityService(databasePath, logger)

  const fw = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid, databasePath },
    logger,
    port,
    { permissionResolver: createPermissionResolver(port, ownerJid) },
  )

  fw.registerService(communityService)
  fw.registerPlugin(createCommunityPlugin(port))

  try {
    await fw.start()

    // 1. !addgroup
    await port.emitMessage({
      id: 'm1',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!addgroup ${group1Jid} Allyssea Hub`,
      timestamp: Date.now(),
      fromMe: false,
    })
    const lastReply1 = port.sent.pop()
    assert.match(lastReply1.text, /Grup Resmi Allyssea Ditambahkan/)
    assert.equal(communityService.isOfficialGroup(group1Jid), true)

    // Add group 2
    await port.emitMessage({
      id: 'm2',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!addgroup ${group2Jid} Allyssea Roleplay`,
      timestamp: Date.now(),
      fromMe: false,
    })
    port.sent.pop()

    // 2. !clist
    await port.emitMessage({
      id: 'm3',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: '!clist',
      timestamp: Date.now(),
      fromMe: false,
    })
    const listReply = port.sent.pop()
    assert.match(listReply.text, /Daftar Jaringan Komunitas Resmi Allyssea/)
    assert.match(listReply.text, /Allyssea Hub/)
    assert.match(listReply.text, /Allyssea Roleplay/)

    // 3. !ckick
    port.groupActions = []
    await port.emitMessage({
      id: 'm4',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!ckick ${userJid} Melanggar aturan`,
      timestamp: Date.now(),
      fromMe: false,
    })
    const kickReply = port.sent.pop()
    assert.match(kickReply.text, /Federated Community Kick Selesai/)
    assert.match(kickReply.text, /Berhasil: 2 grup/)
    assert.equal(port.groupActions.length, 2)
    assert.equal(port.groupActions[0].action, 'remove')
    assert.equal(port.groupActions[1].action, 'remove')

    // 4. !cban
    port.groupActions = []
    await port.emitMessage({
      id: 'm5',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!cban ${userJid} Raid perusuh`,
      timestamp: Date.now(),
      fromMe: false,
    })
    const banReply = port.sent.pop()
    assert.match(banReply.text, /Federated Community Ban & Blacklist Aktif/)
    assert.equal(communityService.isBlacklisted(userJid), true)

    // 5. Test auto-eject when blacklisted member joins group 1
    port.groupActions = []
    await port.emitParticipantUpdate({
      groupJid: group1Jid,
      action: 'add',
      participantJids: [userJid],
      at: Date.now(),
    })
    assert.equal(port.groupActions.length, 1)
    assert.equal(port.groupActions[0].groupJid, group1Jid)
    assert.equal(port.groupActions[0].participantJids[0], userJid)
    assert.equal(port.groupActions[0].action, 'remove')

    const autoEjectNotice = port.sent.pop()
    assert.match(autoEjectNotice.text, /Allyssea Community Blacklist/)

    // 6. !cunban
    await port.emitMessage({
      id: 'm6',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!cunban ${userJid}`,
      timestamp: Date.now(),
      fromMe: false,
    })
    const unbanReply = port.sent.pop()
    assert.match(unbanReply.text, /Blacklist komunitas untuk .* telah dicabut/)
    assert.equal(communityService.isBlacklisted(userJid), false)

    await fw.stop()
  } finally {
    rmSync(databasePath, { force: true })
  }
})

test('Remote Ops commands: !vps and !botleave from private chat', async () => {
  const databasePath = tempDatabase()
  const port = new MockWhatsAppPort()
  const suiteService = new GroupModerationSuiteService(databasePath, logger)

  const fw = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid, databasePath },
    logger,
    port,
    { permissionResolver: createPermissionResolver(port, ownerJid) },
  )

  fw.registerService(suiteService)
  fw.registerPlugin(createModerationSuitePlugin(port))
  fw.registerPlugin(remoteOpsPlugin)

  try {
    await fw.start()

    // 1. !vps
    await port.emitMessage({
      id: 'm_vps',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: '!vps',
      timestamp: Date.now(),
      fromMe: false,
    })
    const vpsReply = port.sent.pop()
    assert.match(vpsReply.text, /VPS & Host Resource Snapshot/)
    assert.match(vpsReply.text, /OS RAM/)
    assert.match(vpsReply.text, /Node\.js/)

    // 2. Remote !botleave from private chat
    await port.emitMessage({
      id: 'm_leave',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: `!botleave ${group1Jid}`,
      timestamp: Date.now(),
      fromMe: false,
    })
    const leaveReply = port.sent.pop()
    assert.match(leaveReply.text, /Berhasil keluar dari grup/)
    assert.equal(port.leftGroups.includes(group1Jid), true)

    await fw.stop()
  } finally {
    rmSync(databasePath, { force: true })
  }
})
