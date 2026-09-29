import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { SuggestionService } from '../dist/services/suggestion-service.js'
import { createSuggestPlugin, sanitizeSuggestionText } from '../dist/framework/plugins/suggest.js'
import { createPermissionResolver } from '../dist/permissions.js'

const logger = pino({ level: 'silent' })

function fakeWhatsapp(userJid = '6282145982720@s.whatsapp.net') {
  return {
    isConnected: true,
    userJid,
    sent: [],
    deleted: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text, options) {
      this.sent.push({ remoteJid, text, options })
    },
    async deleteMessage(remoteJid, key) {
      this.deleted.push({ remoteJid, key })
    },
    async getGroupMetadata(remoteJid) {
      if (remoteJid === '120363001@g.us') {
        return {
          id: remoteJid,
          subject: 'Admin Group',
          participants: [
            { jid: userJid, role: 'admin' },
            { jid: '628123456789@s.whatsapp.net', role: 'member' },
          ],
        }
      }
      if (remoteJid === '120363002@g.us') {
        return {
          id: remoteJid,
          subject: 'No Admin Group',
          participants: [
            { jid: userJid, role: 'member' },
            { jid: '628123456789@s.whatsapp.net', role: 'member' },
          ],
        }
      }
      if (remoteJid === '120363003@g.us') {
        return {
          id: remoteJid,
          subject: 'Suggestion Box Group',
          participants: [
            { jid: userJid, role: 'admin' },
            { jid: '628555444333@s.whatsapp.net', role: 'admin' },
            { jid: '628111222333@s.whatsapp.net', role: 'member' },
          ],
        }
      }
      return {
        id: remoteJid,
        subject: 'General Group',
        participants: [],
      }
    },
    async start() {},
    async close() {},
  }
}

function msg(text, senderJid, remoteJid = senderJid, id = 'msg-1') {
  return {
    id,
    remoteJid,
    senderJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
  }
}

test('sanitizeSuggestionText strips mentions, links, zero-width chars, and collapses spaces', () => {
  const dirty = 'Halo @628123456789 tolong cek https://spam.com/evil dan chat.whatsapp.com/invite \u200B\u200B   teks    rapi  '
  const clean = sanitizeSuggestionText(dirty)
  assert.equal(clean, 'Halo tolong cek dan teks rapi')
})

test('suggestion suite end-to-end: configuration, privacy guards, routing, and lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-suggest-test-'))
  const dbPath = join(root, 'core.sqlite')
  const botJid = '6282145982720@s.whatsapp.net'
  const whatsapp = fakeWhatsapp(botJid)
  const botOwnerJid = '628987654321@s.whatsapp.net'
  const user1Jid = '628123456789@s.whatsapp.net'
  const adminGroupJid = '120363001@g.us'
  const noAdminGroupJid = '120363002@g.us'
  const boxGroupJid = '120363003@g.us'
  const boxAdminJid = '628555444333@s.whatsapp.net'
  const regularMemberJid = '628111222333@s.whatsapp.net'

  const framework = new ApplicationFramework(
    {
      commandPrefix: '!',
      defaultCooldownMs: 0,
      botOwnerJid,
      databasePath: dbPath,
    },
    logger,
    whatsapp,
    {
      permissionResolver: createPermissionResolver(whatsapp, botOwnerJid),
    },
  )

  const suggestionService = new SuggestionService(dbPath, logger, {
    secret: 'test-secret-salt-12345678',
    cooldownMs: 1_000,
    maxPerDay: 3,
  })

  framework.registerService(suggestionService)
  framework.registerPlugin(createSuggestPlugin(whatsapp))

  await framework.start()

  try {
    // 1. Suggest without box configured -> warns user
    await framework.commands.dispatch(msg('!suggest Tambah fitur polling dong', user1Jid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Kotak saran belum diatur/)

    // 2. Setting box in PM is rejected
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!setkotaksaran', botOwnerJid, botOwnerJid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /hanya bisa dijalankan di dalam grup/)

    // 3. Setting box by non-owner is rejected
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!setkotaksaran', user1Jid, boxGroupJid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /owner/i)

    // 4. Setting box by bot owner in group succeeds
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!setkotaksaran', botOwnerJid, boxGroupJid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Kotak Saran Dikonfigurasi/)
    assert.equal(suggestionService.getBoxGroup(), boxGroupJid)

    // 5. Short suggestion (< 5 chars) displays helpful guidance
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest halo', user1Jid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Formulir Kotak Saran/)

    // 6. In a group where bot is NOT admin: privacy guard blocks execution to prevent unretractable leak
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest Tolong adakan event bulanan', user1Jid, noAdminGroupJid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Bot bukan admin di grup ini/)
    assert.equal(whatsapp.deleted.length, 0) // No deletion attempted

    // 7. In a group where bot IS admin: auto-deletes the command message and relays to box group
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest Tolong buat mini-game baru', user1Jid, adminGroupJid, 'msg-adm-1'))
    // Deleted message verification:
    assert.equal(whatsapp.deleted.length, 1)
    assert.equal(whatsapp.deleted[0].key.id, 'msg-adm-1')
    // Messages sent: 1 to box-group, 1 confirmation to sender in admin-group
    assert.equal(whatsapp.sent.length, 2)
    const boxDelivery = whatsapp.sent.find((s) => s.remoteJid === boxGroupJid)
    const userConfirm = whatsapp.sent.find((s) => s.remoteJid === adminGroupJid)
    assert.ok(boxDelivery)
    assert.ok(userConfirm)
    assert.match(boxDelivery.text, /Kotak Saran Masuk/)
    assert.match(boxDelivery.text, /Saran #1/)
    assert.match(boxDelivery.text, /Tolong buat mini-game baru/)
    assert.match(userConfirm.text, /Saranmu Berhasil Dikirim/)

    // Extract ticket token from user confirmation
    const tokenMatch = userConfirm.text.match(/Nomor Tiket: `?#?([A-F0-9]{6})`?/)
    assert.ok(tokenMatch)
    const token = tokenMatch[1]

    // 8. Verify rate limiting cooldown (cooldown is 1,000ms in test options)
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest Cepat-cepat kirim lagi', user1Jid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Tunggu \d+ detik sebelum mengirim saran/)

    // Advance clock past 1s cooldown
    await new Promise((resolve) => setTimeout(resolve, 1100))

    // 9. Admin in box group replies via !replysaran #TOKEN
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(`!replysaran #${token} Ide mini-game kamu sedang kami rancang!`, boxAdminJid, boxGroupJid))
    // Should forward reply directly to user1 PM and notify admin in box group
    const pmToUser = whatsapp.sent.find((s) => s.remoteJid === user1Jid)
    const adminAck = whatsapp.sent.find((s) => s.remoteJid === boxGroupJid)
    assert.ok(pmToUser)
    assert.ok(adminAck)
    assert.match(pmToUser.text, /Tanggapan Pengurus atas Saranmu/)
    assert.match(pmToUser.text, /Ide mini-game kamu sedang kami rancang!/)
    assert.match(adminAck.text, /Tanggapan berhasil dikirimkan/)

    // 10. Non-admin in box group cannot use replysaran
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(`!replysaran #${token} Halo`, regularMemberJid, boxGroupJid))
    assert.match(whatsapp.sent[0].text, /hanya dapat digunakan oleh pengurus/)

    // 11. Blacklist token via !blocksaran
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(`!blocksaran #${token} Spamming`, boxAdminJid, boxGroupJid))
    assert.match(whatsapp.sent[0].text, /berhasil diblokir/)
    assert.equal(suggestionService.isBlacklisted(token), true)

    // 12. Subsequent suggestions from that blacklisted user are rejected
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest Saran dari user yang diblokir', user1Jid))
    assert.match(whatsapp.sent[0].text, /telah diblokir/)

    // 13. Pruning expired items
    const pruneResult = suggestionService.pruneOld(0) // cutoff = now, prunes everything older than 0ms
    assert.equal(pruneResult.suggestionsDeleted, 1)
  } finally {
    await framework.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
