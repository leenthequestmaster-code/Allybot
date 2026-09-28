import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createModerationSuitePlugin } from '../dist/framework/plugins/moderation-suite.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'

const logger = pino({ level: 'silent' })

test('Hardening Suite: JID/LID mapping, ban evasion defense, audit hash chain, and action guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-hardening-'))
  const dbPath = join(dir, 'test.sqlite')

  try {
    const service = new GroupModerationSuiteService(dbPath, logger)
    const groupJid = '120363000000000000@g.us'
    const phoneJid = '6283197859955@s.whatsapp.net'
    const lid = '88150529556589@lid'

    // 1. Identity Mapping
    service.recordIdentity(phoneJid, lid)
    const aliasesFromLid = service.resolveAliases(lid)
    assert.ok(aliasesFromLid.includes(phoneJid), 'resolveAliases from LID must include phone JID')

    const aliasesFromPhone = service.resolveAliases(phoneJid)
    assert.ok(aliasesFromPhone.includes(lid), 'resolveAliases from phone must include LID')

    // 2. Ban Evasion Defense via Dual Lookup
    service.ban(groupJid, phoneJid, 'admin@s.whatsapp.net', 'Spam link')
    // Check using LID: should still be banned!
    assert.equal(service.isBanned(groupJid, lid), true, 'LID must be recognized as banned when ban was applied to phone JID')
    assert.equal(service.isBanned(groupJid, phoneJid), true)

    // Unban via LID
    service.unban(groupJid, lid)
    assert.equal(service.isBanned(groupJid, phoneJid), false, 'Unban via LID must unban the phone JID')

    // 3. Mute Evasion Defense
    service.mute(groupJid, phoneJid, 'admin@s.whatsapp.net', 60_000)
    assert.equal(service.isMuted(groupJid, lid), true, 'LID must be recognized as muted when mute was applied to phone JID')
    service.unmute(groupJid, phoneJid)
    assert.equal(service.isMuted(groupJid, lid), false)

    // 4. Audit Hash Chain & Tamper Detection
    const h1 = service.recordAudit(groupJid, 'admin1@s.whatsapp.net', 'kick', 'bad1@s.whatsapp.net', 'toxic')
    const h2 = service.recordAudit(groupJid, 'admin2@s.whatsapp.net', 'ban', 'bad2@s.whatsapp.net', 'raid')
    const h3 = service.recordAudit(groupJid, 'admin1@s.whatsapp.net', 'mute', 'bad3@s.whatsapp.net', 'spam')

    assert.ok(h1 && h2 && h3, 'All audit hashes must be generated')
    const verify1 = service.verifyAuditChain(groupJid)
    assert.equal(verify1.valid, true, 'Audit hash chain must be valid')
    assert.equal(verify1.totalEvents, 3)

    // Tamper with a row directly in SQLite
    const db = service.db
    db.prepare('UPDATE moderation_audit_chain SET payload = ? WHERE id = 2').run('tampered payload')
    const verifyTampered = service.verifyAuditChain(groupJid)
    assert.equal(verifyTampered.valid, false, 'Tampered audit record must be detected as invalid')
    assert.equal(verifyTampered.brokenAt, 2, 'Broken hash chain must point to the tampered row ID')

    // 5. Bot & Owner Action Guards in ApplicationFramework
    const botJid = '6285181696890@s.whatsapp.net'
    const ownerJid = '6283197859955@s.whatsapp.net'
    const groupOwnerJid = '6281111111111@s.whatsapp.net'
    const admin1Jid = '6282222222222@s.whatsapp.net'
    const admin2Jid = '6283333333333@s.whatsapp.net'
    const memberJid = '6284444444444@s.whatsapp.net'

    const sentReplies = []
    const updatedParticipants = []

    const fakeWhatsapp = {
      userJid: botJid,
      async sendText(_jid, text) {
        sentReplies.push(text)
      },
      async groupParticipantsUpdate(gid, targets, action) {
        updatedParticipants.push({ gid, targets, action })
        return targets.map((t) => ({ participantJid: t, status: 'ok' }))
      },
      async getGroupMetadata(_gid) {
        return {
          jid: groupJid,
          subject: 'Test Lab',
          ownerJid: groupOwnerJid,
          participants: [
            { jid: groupOwnerJid, role: 'superadmin' },
            { jid: admin1Jid, role: 'admin' },
            { jid: admin2Jid, role: 'admin' },
            { jid: memberJid, role: 'member' },
            { jid: botJid, role: 'admin' },
            { jid: ownerJid, role: 'member' },
          ],
        }
      },
      onMessage: () => () => {},
      onGroupParticipantUpdate: () => () => {},
      onConnectionState: () => () => {},
      start: async () => {},
      close: async () => {},
    }

    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid, databasePath: dbPath },
      logger,
      fakeWhatsapp,
      { permissionResolver: createPermissionResolver(fakeWhatsapp, ownerJid) },
    )

    app.registerService(service)
    app.registerService(new PlatformGuardrailService(dbPath, logger))
    app.registerService(new GroupConfigurationService(dbPath, logger))
    app.registerService(new GroupSafetyService(dbPath, logger))

    app.registerPlugin(createModerationSuitePlugin(fakeWhatsapp))
    app.registerPlugin(createGroupSafetyPlugin(fakeWhatsapp))

    await app.start()

    // Test A: Admin cannot kick bot itself
    await app.commands.dispatch({
      id: 'm1',
      remoteJid: groupJid,
      senderJid: admin1Jid,
      text: `!kick @6285181696890`,
      mentionedJids: [botJid],
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.ok(sentReplies.some((r) => r.includes('bot sendiri')), 'Must refuse kicking bot itself')

    // Test B: Admin cannot kick Bot Owner (Cyrus)
    await app.commands.dispatch({
      id: 'm2',
      remoteJid: groupJid,
      senderJid: admin1Jid,
      text: `!kick @6283197859955`,
      mentionedJids: [ownerJid],
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.ok(sentReplies.some((r) => r.includes('Bot Owner tidak dapat ditindak')), 'Must refuse kicking Bot Owner')

    // Test C: Admin cannot demote fellow Admin (Anti-Coup d'État)
    await app.commands.dispatch({
      id: 'm3',
      remoteJid: groupJid,
      senderJid: admin1Jid,
      text: `!demote @6283333333333`,
      mentionedJids: [admin2Jid],
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.ok(sentReplies.some((r) => r.includes('Sesama admin grup tidak dapat saling menindak')), 'Must refuse fellow admin demote')

    // Test D: Admin cannot warn Bot Owner
    await app.commands.dispatch({
      id: 'm4',
      remoteJid: groupJid,
      senderJid: admin1Jid,
      text: `!warn @6283197859955 uji coba`,
      mentionedJids: [ownerJid],
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.ok(sentReplies.some((r) => r.includes('Bot Owner tidak dapat diberi peringatan')), 'Must refuse warning Bot Owner')

    // Test E: Audit verify command
    await app.commands.dispatch({
      id: 'm5',
      remoteJid: groupJid,
      senderJid: admin1Jid,
      text: `!auditverify`,
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.ok(sentReplies.some((r) => r.includes('AUDIT CHAIN')), 'Auditverify command must respond')

    // Test F: Botleave command (Bot Owner only)
    let leftGroup = false
    fakeWhatsapp.groupLeave = async (gid) => {
      if (gid === groupJid) leftGroup = true
    }
    // Member tries botleave: denied
    await app.commands.dispatch({
      id: 'm6',
      remoteJid: groupJid,
      senderJid: memberJid,
      text: `!botleave`,
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.equal(leftGroup, false, 'Non-owner cannot execute botleave')

    // Owner executes botleave: success
    await app.commands.dispatch({
      id: 'm7',
      remoteJid: groupJid,
      senderJid: ownerJid,
      text: `!botleave`,
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.equal(leftGroup, true, 'Bot Owner can execute botleave')

    await app.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
