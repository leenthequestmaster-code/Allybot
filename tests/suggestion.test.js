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
    deletedStored: [],
    messageListeners: [],
    onMessage(listener) {
      this.messageListeners.push(listener)
      return () => {}
    },
    async emitMessage(message) {
      for (const listener of this.messageListeners) {
        await listener(message)
      }
    },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text, options) {
      this.sent.push({ remoteJid, text, options })
    },
    async sendMedia(remoteJid, payload) {
      this.sent.push({ remoteJid, media: payload, text: payload.caption })
    },
    async downloadMedia(_message, _source, _limits) {
      return {
        kind: 'image',
        mimeType: 'image/jpeg',
        data: Buffer.from('fake-evidence-bytes'),
      }
    },
    async deleteMessage(remoteJid, key) {
      this.deleted.push({ remoteJid, key })
    },
    deleteStoredMessage(remoteJid, id) {
      this.deletedStored.push({ remoteJid, id })
      return true
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
      if (remoteJid === '120363004@g.us') {
        return {
          id: remoteJid,
          subject: 'Report Investigation Group',
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

function msg(text, senderJid, remoteJid = senderJid, id = 'msg-1', extra = {}) {
  return {
    id,
    remoteJid,
    senderJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...extra,
  }
}

test('sanitizeSuggestionText strips mentions, links, zero-width chars, and collapses spaces', () => {
  const dirty = 'Halo @628123456789 tolong cek https://spam.com/evil dan chat.whatsapp.com/invite \u200B\u200B   teks    rapi  '
  const clean = sanitizeSuggestionText(dirty)
  assert.equal(clean, 'Halo tolong cek dan teks rapi')
})

test('feedback relay suite end-to-end: suggestion & report with media, multi-evidence, routing, and lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-suggest-test-'))
  const dbPath = join(root, 'core.sqlite')
  const botJid = '6282145982720@s.whatsapp.net'
  const whatsapp = fakeWhatsapp(botJid)
  const botOwnerJid = '628987654321@s.whatsapp.net'
  const user1Jid = '628123456789@s.whatsapp.net'
  const reportedBadUserJid = '628999888777@s.whatsapp.net'
  const adminGroupJid = '120363001@g.us'
  const noAdminGroupJid = '120363002@g.us'
  const boxGroupJid = '120363003@g.us'
  const reportBoxGroupJid = '120363004@g.us'
  const boxAdminJid = '628555444333@s.whatsapp.net'

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
    evidenceWindowMs: 5_000, // 5s window for test
  })

  framework.registerService(suggestionService)
  framework.registerPlugin(createSuggestPlugin(whatsapp))

  await framework.start()

  try {
    // 1. Suggest without box configured -> warns user
    await framework.commands.dispatch(msg('!suggest Tambah fitur polling dong', user1Jid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Kotak saran belum diatur/)

    // 2. Report without box configured -> warns user
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!report Ada penipuan transaksi', user1Jid))
    assert.equal(whatsapp.sent.length, 1)
    assert.match(whatsapp.sent[0].text, /Kotak laporan belum diatur/)

    // 3. Setting suggest box and report box by bot owner succeeds
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!setkotaksaran', botOwnerJid, boxGroupJid))
    assert.match(whatsapp.sent[0].text, /Kotak Saran Dikonfigurasi/)
    assert.equal(suggestionService.getBoxGroup('suggest'), boxGroupJid)

    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!setreportbox', botOwnerJid, reportBoxGroupJid))
    assert.match(whatsapp.sent[0].text, /Kotak Laporan Dikonfigurasi/)
    assert.equal(suggestionService.getBoxGroup('report'), reportBoxGroupJid)

    // 4. Short suggestion/report (< 5 chars) displays helpful guidance
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!suggest halo', user1Jid))
    assert.match(whatsapp.sent[0].text, /Formulir Kotak Saran/)

    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!report test', user1Jid))
    assert.match(whatsapp.sent[0].text, /Formulir Laporan Pelanggaran/)

    // 5. In group where bot is NOT admin: privacy guard blocks execution
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!report Tolong tindak penipuan', user1Jid, noAdminGroupJid))
    assert.match(whatsapp.sent[0].text, /Bot bukan admin di grup ini/)
    assert.equal(whatsapp.deleted.length, 0)

    // 6. In group where bot IS admin: auto-deletes the command message and relays to report box
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(
      `!report @${reportedBadUserJid.split('@')[0]} Telah melakukan scam koin`,
      user1Jid,
      adminGroupJid,
      'msg-report-1',
      {
        mentionedJids: [reportedBadUserJid],
        media: { kind: 'image' },
      },
    ))

    // Verified: user message deleted from group
    assert.equal(whatsapp.deleted.length, 1)
    assert.equal(whatsapp.deleted[0].key.id, 'msg-report-1')

    // Verified: stored message purged after streaming
    assert.equal(whatsapp.deletedStored.length, 1)

    // Verified: relayed to reportBoxGroupJid with media and target display
    const reportDelivery = whatsapp.sent.find((s) => s.remoteJid === reportBoxGroupJid)
    const userAck = whatsapp.sent.find((s) => s.remoteJid === adminGroupJid)
    assert.ok(reportDelivery)
    assert.ok(userAck)
    assert.match(reportDelivery.text, /Laporan Pelanggaran Masuk/)
    assert.match(reportDelivery.text, /Admin Group/)
    assert.match(reportDelivery.text, new RegExp(reportedBadUserJid.split('@')[0]))
    assert.match(userAck.text, /Laporan dibuat dan diteruskan/)

    // Extract report token
    const tokenMatch = userAck.text.match(/Nomor Tiket: `?#?([A-F0-9]{6})`?/)
    assert.ok(tokenMatch)
    const reportToken = tokenMatch[1]

    // 7. Multi-evidence window: user sends follow-up screenshot within 3 minutes
    whatsapp.sent.length = 0
    await whatsapp.emitMessage({
      id: 'evidence-followup-1',
      remoteJid: adminGroupJid,
      senderJid: user1Jid,
      text: 'Ini bukti transfer palsunya',
      timestamp: Date.now(),
      fromMe: false,
      media: { kind: 'image' },
    })

    // Verified: follow-up auto-deleted from group
    assert.ok(whatsapp.deleted.some((d) => d.key.id === 'evidence-followup-1'))
    // Verified: delivered to report box with attachment notice
    const followupDelivery = whatsapp.sent.find((s) => s.remoteJid === reportBoxGroupJid)
    assert.ok(followupDelivery)
    assert.match(followupDelivery.text, /Lampiran Bukti Tambahan/)
    assert.match(followupDelivery.text, /Ini bukti transfer palsunya/)

    // 8. Admin in report box replies via !replyreport #TOKEN
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(`!replyreport #${reportToken} Terduga pelaku sudah kami kick dan blacklist.`, boxAdminJid, reportBoxGroupJid))
    const pmToReporter = whatsapp.sent.find((s) => s.remoteJid === user1Jid)
    assert.ok(pmToReporter)
    assert.match(pmToReporter.text, /Tanggapan Pengurus atas Laporanmu/)
    assert.match(pmToReporter.text, /Terduga pelaku sudah kami kick/)

    // 9. Blacklist via !blockreport
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg(`!blockreport #${reportToken} Laporan palsu`, boxAdminJid, reportBoxGroupJid))
    assert.match(whatsapp.sent[0].text, /berhasil diblokir/)
    assert.equal(suggestionService.isBlacklisted(reportToken), true)

    // 10. Subsequent submissions from blacklisted token are dropped
    whatsapp.sent.length = 0
    await framework.commands.dispatch(msg('!report Coba lapor lagi', user1Jid))
    assert.match(whatsapp.sent[0].text, /telah diblokir/)
  } finally {
    await framework.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
