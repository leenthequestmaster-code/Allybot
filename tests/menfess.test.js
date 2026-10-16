import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino from 'pino'
import sharp from 'sharp'
import { ApplicationFramework } from '../dist/framework/application.js'
import {
  MenfessService,
  MenfessCrypto,
  generateThreadId,
} from '../dist/services/menfess-service.js'
import {
  createMenfessPlugin,
  parseTargetJid,
  sanitizeMenfessText,
} from '../dist/framework/plugins/menfess.js'
import { createPermissionResolver } from '../dist/permissions.js'

const logger = pino({ level: 'silent' })

function createFakeWhatsApp(userJid = '6285181696890@s.whatsapp.net') {
  return {
    isConnected: true,
    userJid,
    sent: [],
    reactions: [],
    deleted: [],
    deletedStored: [],
    messageListeners: [],
    downloadQueue: [],
    onMessage(listener) {
      this.messageListeners.push(listener)
      return () => {}
    },
    async emitMessage(message) {
      for (const listener of this.messageListeners) {
        await listener(message)
      }
    },
    onGroupParticipantUpdate() {
      return () => {}
    },
    onConnectionState() {
      return () => {}
    },
    async sendText(remoteJid, text, options) {
      this.sent.push({ remoteJid, text, options, type: 'text' })
    },
    async sendMedia(remoteJid, payload) {
      this.sent.push({ remoteJid, media: payload, text: payload.caption, type: payload.kind, fileName: payload.fileName })
    },
    async sendReaction(remoteJid, key, emoji) {
      this.reactions.push({ remoteJid, key, emoji })
    },
    async downloadMedia(message, _source, _limits) {
      if (this.downloadQueue.length > 0) {
        return this.downloadQueue.shift()
      }
      const kind = message.media?.kind ?? 'image'
      if (kind === 'image') {
        return {
          kind: 'image',
          mimeType: 'image/jpeg',
          data: await sharp({
            create: {
              width: 2000,
              height: 1500,
              channels: 3,
              background: { r: 255, g: 0, b: 0 },
            },
          })
            .jpeg()
            .toBuffer(),
        }
      }
      return {
        kind,
        mimeType: kind === 'video' ? 'video/mp4' : kind === 'sticker' ? 'image/webp' : kind === 'audio' ? 'audio/ogg' : 'application/pdf',
        data: Buffer.from(`fake-${kind}-data`),
        fileName: kind === 'document' ? 'catatan.pdf' : undefined,
      }
    },
    async deleteMessage(remoteJid, key) {
      this.deleted.push({ remoteJid, key })
    },
    deleteStoredMessage(remoteJid, id) {
      this.deletedStored.push({ remoteJid, id })
      return true
    },
    async start() {},
    async close() {},
  }
}

test('Menfess helper parsers and validators', () => {
  assert.equal(parseTargetJid('08123456789'), '628123456789@s.whatsapp.net')
  assert.equal(parseTargetJid('+628123456789'), '628123456789@s.whatsapp.net')
  assert.equal(parseTargetJid('62812-3456-7890'), '6281234567890@s.whatsapp.net')
  assert.equal(parseTargetJid('@628123456789'), '628123456789@s.whatsapp.net')
  assert.equal(parseTargetJid('invalid-text'), undefined)
  assert.equal(parseTargetJid('123'), undefined)

  assert.equal(
    sanitizeMenfessText('\u200Bhalo\uFEFF dunia  \n\n\n\n tes'),
    'halo dunia\n\n\ntes',
  )
})

test('MenfessCrypto and ThreadID integrity', () => {
  const threadId = generateThreadId()
  assert.match(threadId, /^MF-[0-9A-HJKMNP-Z]{8}$/)

  const crypto = new MenfessCrypto('test-secret-key-123')
  const originalJid = '628123456789@s.whatsapp.net'

  const hmac1 = crypto.hashJid(originalJid)
  const hmac2 = crypto.hashJid(originalJid)
  assert.equal(hmac1, hmac2)
  assert.notEqual(hmac1, originalJid)

  const encrypted = crypto.encryptJid(originalJid)
  assert.notEqual(encrypted, originalJid)
  assert.equal(crypto.decryptJid(encrypted), originalJid)

  assert.throws(() => {
    crypto.decryptJid('corrupted:payload:data')
  })
})

test('MenfessService full lifecycle: quota, blacklist, sessions, and closing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-service-test-'))
  const dbPath = join(dir, 'test-menfess.sqlite')

  try {
    const service = new MenfessService(dbPath, logger, {
      secret: 'unit-test-secret',
      maxPerDay: 2,
      sessionTtlSeconds: 3600,
    })

    service.initialize({
      services: {
        get: () => {
          throw new Error('No redis in unit test')
        },
      },
    })

    const sender = '628111111111@s.whatsapp.net'
    const recipient = '628222222222@s.whatsapp.net'
    const thirdParty = '628333333333@s.whatsapp.net'

    // 1. Self target
    const selfRes = await service.createThread(sender, sender)
    assert.equal(selfRes.success, false)
    assert.equal(selfRes.reason, 'SELF_TARGET')

    // 2. Successful creation
    const res1 = await service.createThread(sender, recipient)
    assert.equal(res1.success, true)
    assert.ok(res1.thread?.threadId)
    assert.equal(res1.remainingDailyQuota, 1)

    const threadId = res1.thread.threadId

    // 3. Sender busy check
    const busySender = await service.createThread(sender, thirdParty)
    assert.equal(busySender.success, false)
    assert.equal(busySender.reason, 'SENDER_BUSY')

    // 4. Recipient busy check
    const busyRecipient = await service.createThread(thirdParty, recipient)
    assert.equal(busyRecipient.success, false)
    assert.equal(busyRecipient.reason, 'RECIPIENT_BUSY')

    // 5. Active session lookup
    const senderSession = await service.getActiveSession(sender)
    assert.equal(senderSession?.threadId, threadId)
    assert.equal(senderSession?.role, 'sender')

    const recipientSession = await service.getActiveSession(recipient)
    assert.equal(recipientSession?.threadId, threadId)
    assert.equal(recipientSession?.role, 'receiver')

    // 6. Peer resolution
    const peerOfSender = await service.getPeerJid(threadId, sender)
    assert.equal(peerOfSender, recipient)

    const peerOfRecipient = await service.getPeerJid(threadId, recipient)
    assert.equal(peerOfRecipient, sender)

    // 7. Record message
    await service.recordMessage(threadId, sender, recipient)

    // 8. Close thread by sender -> closes for BOTH parties
    const closeRes = await service.closeThread(sender)
    assert.equal(closeRes.closed, true)
    assert.equal(closeRes.threadId, threadId)
    assert.equal(closeRes.peerJid, recipient)

    assert.equal(await service.getActiveSession(sender), undefined)
    assert.equal(await service.getActiveSession(recipient), undefined)

    // Check recently closed
    const recentSender = service.getRecentlyClosedThread(sender)
    assert.equal(recentSender?.threadId, threadId)
    const recentRecipient = service.getRecentlyClosedThread(recipient)
    assert.equal(recentRecipient?.threadId, threadId)

    // 9. Daily rate limit check (maxPerDay: 2)
    const res2 = await service.createThread(sender, recipient)
    assert.equal(res2.success, true)
    assert.equal(res2.remainingDailyQuota, 0)

    await service.closeThread(sender)

    const res3 = await service.createThread(sender, recipient)
    assert.equal(res3.success, false)
    assert.equal(res3.reason, 'RATE_LIMITED')

    // 10. Blacklist test
    const blockService = new MenfessService(dbPath, logger, {
      secret: 'unit-test-secret',
      maxPerDay: 10,
    })
    blockService.initialize({ services: { get: () => { throw new Error() } } })

    const threadToBlock = await blockService.createThread(sender, recipient)
    assert.equal(threadToBlock.success, true)

    const blockRes = await blockService.blockSender(recipient)
    assert.equal(blockRes.blocked, true)
    assert.equal(blockRes.peerJid, sender)

    // Both sessions purged on block
    assert.equal(await blockService.getActiveSession(sender), undefined)
    assert.equal(await blockService.getActiveSession(recipient), undefined)

    // Attempting to send again should be blocked
    const afterBlock = await blockService.createThread(sender, recipient)
    assert.equal(afterBlock.success, false)
    assert.equal(afterBlock.reason, 'RECIPIENT_BLOCKED')

    blockService.shutdown({})
    service.shutdown({})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MenfessService image sanitization strips metadata and caps 1024px', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-sharp-test-'))
  const dbPath = join(dir, 'test-menfess.sqlite')

  try {
    const service = new MenfessService(dbPath, logger, { secret: 'sharp-test' })
    service.initialize({ services: { get: () => { throw new Error() } } })

    const largeImage = await sharp({
      create: {
        width: 2500,
        height: 1800,
        channels: 3,
        background: { r: 10, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer()

    const sanitized = await service.sanitizeImage(largeImage)
    const meta = await sharp(sanitized).metadata()

    assert.ok(meta.width <= 1024)
    assert.ok(meta.height <= 1024)
    assert.equal(meta.format, 'jpeg')

    service.shutdown({})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MenfessService opt-out persistence, session termination, and rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-optout-service-'))
  const dbPath = join(dir, 'test-menfess-optout.sqlite')

  try {
    const service = new MenfessService(dbPath, logger, {
      secret: 'unit-test-secret',
      maxPerDay: 5,
    })
    service.initialize({
      services: {
        get: () => {
          throw new Error('No redis in unit test')
        },
      },
    })

    const sender = '628111111111@s.whatsapp.net'
    const recipient = '628222222222@s.whatsapp.net'

    // Initially recipient is NOT opted out
    assert.equal(await service.isOptedOut(recipient), false)

    // Recipient opts out
    const optRes = await service.setOptOut(recipient, true)
    assert.equal(optRes.optedOut, true)
    assert.equal(await service.isOptedOut(recipient), true)

    // Sender tries to send menfess to opted-out recipient -> rejected RECIPIENT_OPTED_OUT
    const createRes = await service.createThread(sender, recipient)
    assert.equal(createRes.success, false)
    assert.equal(createRes.reason, 'RECIPIENT_OPTED_OUT')

    // Opted out user tries to send menfess -> rejected SENDER_OPTED_OUT
    const senderOptRes = await service.createThread(recipient, sender)
    assert.equal(senderOptRes.success, false)
    assert.equal(senderOptRes.reason, 'SENDER_OPTED_OUT')

    // Recipient opts back in
    const onRes = await service.setOptOut(recipient, false)
    assert.equal(onRes.optedOut, false)
    assert.equal(await service.isOptedOut(recipient), false)

    // Now creation succeeds
    const successRes = await service.createThread(sender, recipient)
    assert.equal(successRes.success, true)

    // Opt-out while in active session should automatically terminate the session
    const optWhileActive = await service.setOptOut(recipient, true)
    assert.equal(optWhileActive.optedOut, true)
    assert.equal(optWhileActive.closedThreadId, successRes.thread?.threadId)
    assert.equal(optWhileActive.peerJid, sender)

    // Sessions are purged
    assert.equal(await service.getActiveSession(sender), undefined)
    assert.equal(await service.getActiveSession(recipient), undefined)

    service.shutdown({})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Menfess End-to-End Plugin: free media types (video, sticker, doc, audio, image) and single-party !stopmenfess termination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-e2e-test-'))
  const dbPath = join(dir, 'test-menfess-e2e.sqlite')

  try {
    const fakeWA = createFakeWhatsApp()
    const botOwnerJid = '6283197859955@s.whatsapp.net'
    const framework = new ApplicationFramework(
      {
        commandPrefix: '!',
        defaultCooldownMs: 0,
        botOwnerJid,
        databasePath: dbPath,
      },
      logger,
      fakeWA,
      {
        permissionResolver: createPermissionResolver(fakeWA, botOwnerJid),
      },
    )

    const service = new MenfessService(dbPath, logger, { secret: 'e2e-secret', maxPerDay: 5 })
    framework.registerService(service)
    framework.registerPlugin(createMenfessPlugin(fakeWA))

    await framework.start()

    const senderJid = '628111222333@s.whatsapp.net'
    const recipientJid = '628999888777@s.whatsapp.net'

    // Step 1: Send !menfess with text
    await framework.commands.dispatch({
      id: 'm1',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Halo ini pesan rahasia perdana!',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Check sender received confirmation
    const senderReplies = fakeWA.sent.filter((s) => s.remoteJid === senderJid)
    assert.ok(senderReplies.length >= 1)
    assert.match(senderReplies[0].text, /Menfess Berhasil Terkirim/)

    // Step 2: Sticky reply from recipient with VIDEO
    await fakeWA.emitMessage({
      id: 'm2',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      media: { kind: 'video' },
      text: 'Ini video buatmu!',
      timestamp: Date.now(),
      fromMe: false,
    })

    const senderVideos = fakeWA.sent.filter((s) => s.remoteJid === senderJid && s.type === 'video')
    assert.equal(senderVideos.length, 1)
    assert.equal(senderVideos[0].text, 'Ini video buatmu!')
    assert.doesNotMatch(senderVideos[0].text, /Video Anonim|Penerima|#MF-/)

    // Step 3: Sticky reply from sender with STICKER
    await fakeWA.emitMessage({
      id: 'm3',
      remoteJid: senderJid,
      senderJid,
      media: { kind: 'sticker' },
      text: 'Stiker lucu',
      timestamp: Date.now(),
      fromMe: false,
    })

    const recipientStickers = fakeWA.sent.filter((s) => s.remoteJid === recipientJid && s.type === 'sticker')
    assert.equal(recipientStickers.length, 1)

    // Step 4: Sticky reply with DOCUMENT
    await fakeWA.emitMessage({
      id: 'm4',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      media: { kind: 'document' },
      text: 'Ini file dokumen penting',
      timestamp: Date.now(),
      fromMe: false,
    })

    const senderDocs = fakeWA.sent.filter((s) => s.remoteJid === senderJid && s.type === 'document')
    assert.equal(senderDocs.length, 1)
    assert.equal(senderDocs[0].text, 'Ini file dokumen penting')
    assert.doesNotMatch(senderDocs[0].text, /Dokumen Anonim|Penerima|#MF-/)

    // Step 4.5: Sticky pure text reply from sender
    await fakeWA.emitMessage({
      id: 'm4_text',
      remoteJid: senderJid,
      senderJid,
      text: 'Boleh kenalan lebih lanjut?',
      timestamp: Date.now(),
      fromMe: false,
    })
    const recipientTexts = fakeWA.sent.filter((s) => s.remoteJid === recipientJid && s.type === 'text')
    const pureText = recipientTexts.find((s) => s.text === 'Boleh kenalan lebih lanjut?')
    assert.ok(pureText, 'Pure text must be relayed without robot tags')
    assert.doesNotMatch(pureText.text, /Pengirim|Penerima|#MF-/)

    // Step 5: Stop conversation with single party !stopmenfess (initiated by recipient)
    await framework.commands.dispatch({
      id: 'm5',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      text: '!stopmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Both parties notified of closure
    const recipientClose = fakeWA.sent.find(
      (s) => s.remoteJid === recipientJid && s.text?.includes('telah resmi diakhiri'),
    )
    assert.ok(recipientClose)
    assert.match(recipientClose.text, /kedua belah pihak/)

    const senderClose = fakeWA.sent.find(
      (s) => s.remoteJid === senderJid && s.text?.includes('telah mengakhiri sesi Menfess'),
    )
    assert.ok(senderClose)
    assert.match(senderClose.text, /ditutup sepenuhnya/)

    // Verification: Active session is completely null for BOTH
    assert.equal(await service.getActiveSession(senderJid), undefined)
    assert.equal(await service.getActiveSession(recipientJid), undefined)

    // Step 6: Sender tries to send another message after recipient closed it -> should get closure notice and NOT relay!
    const sentCountBefore = fakeWA.sent.length
    await fakeWA.emitMessage({
      id: 'm6',
      remoteJid: senderJid,
      senderJid,
      text: 'Halo kamu masih di situ?',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Recipient must NOT receive this message
    const leakedMessages = fakeWA.sent.slice(sentCountBefore).filter((s) => s.remoteJid === recipientJid)
    assert.equal(leakedMessages.length, 0)

    // Sender must receive friendly notice that session ended
    const senderEndedNotice = fakeWA.sent.slice(sentCountBefore).find((s) => s.remoteJid === senderJid)
    assert.ok(senderEndedNotice)
    assert.match(senderEndedNotice.text, /telah resmi diakhiri/)

    // Step 7: Sender executes !stopmenfess after it was already closed -> friendly already closed notice
    await framework.commands.dispatch({
      id: 'm7',
      remoteJid: senderJid,
      senderJid,
      text: '!stopmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    const senderAlreadyClosed = fakeWA.sent.find(
      (s) => s.remoteJid === senderJid && s.text?.includes('sudah resmi ditutup sebelumnya'),
    )
    assert.ok(senderAlreadyClosed)

    await framework.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Menfess Plugin E2E: !offmenfess and !onmenfess flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-optout-e2e-'))
  const dbPath = join(dir, 'test-menfess-optout-e2e.sqlite')

  try {
    const fakeWA = createFakeWhatsApp()
    const botOwnerJid = '6283197859955@s.whatsapp.net'
    const framework = new ApplicationFramework(
      {
        commandPrefix: '!',
        defaultCooldownMs: 0,
        botOwnerJid,
        databasePath: dbPath,
      },
      logger,
      fakeWA,
      {
        permissionResolver: createPermissionResolver(fakeWA, botOwnerJid),
      },
    )

    const service = new MenfessService(dbPath, logger, { secret: 'e2e-secret', maxPerDay: 5 })
    framework.registerService(service)
    framework.registerPlugin(createMenfessPlugin(fakeWA))

    await framework.start()

    const senderJid = '628111222333@s.whatsapp.net'
    const recipientJid = '628999888777@s.whatsapp.net'

    // Step 1: Recipient activates DND via !offmenfess
    await framework.commands.dispatch({
      id: 'opt1',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      text: '!offmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    const offReply = fakeWA.sent.find(
      (s) => s.remoteJid === recipientJid && s.text?.includes('Penerimaan Menfess Dinonaktifkan'),
    )
    assert.ok(offReply)
    assert.match(offReply.text, /!onmenfess/)

    // Step 2: Sender attempts to send menfess to recipient -> must be rejected
    const beforeCount = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'opt2',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Halo mau kenalan dong',
      timestamp: Date.now(),
      fromMe: false,
    })

    const senderRejection = fakeWA.sent.slice(beforeCount).find((s) => s.remoteJid === senderJid)
    assert.ok(senderRejection)
    assert.match(senderRejection.text, /menonaktifkan fitur penerimaan Menfess/)

    // Recipient must NOT receive any message
    const recipientLeaked = fakeWA.sent.slice(beforeCount).filter((s) => s.remoteJid === recipientJid)
    assert.equal(recipientLeaked.length, 0)

    // Step 3: Recipient re-enables menfess via !onmenfess
    await framework.commands.dispatch({
      id: 'opt3',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      text: '!onmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    const onReply = fakeWA.sent.find(
      (s) => s.remoteJid === recipientJid && s.text?.includes('Penerimaan Menfess Diaktifkan'),
    )
    assert.ok(onReply)

    // Step 4: Sender sends menfess again -> now succeeds!
    await framework.commands.dispatch({
      id: 'opt4',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Halo sekarang terkirim!',
      timestamp: Date.now(),
      fromMe: false,
    })

    const senderSuccess = fakeWA.sent.find(
      (s) => s.remoteJid === senderJid && s.text?.includes('Menfess Berhasil Terkirim'),
    )
    assert.ok(senderSuccess)

    const recipientMessage = fakeWA.sent.find(
      (s) => s.remoteJid === recipientJid && s.text?.includes('Halo sekarang terkirim!'),
    )
    assert.ok(recipientMessage)

    await framework.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Menfess Plugin E2E: Owner-only !setmenfess quota management and enforcement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'menfess-quota-e2e-'))
  const dbPath = join(dir, 'test-menfess-quota-e2e.sqlite')

  try {
    const fakeWA = createFakeWhatsApp()
    const botOwnerJid = '6283197859955@s.whatsapp.net'
    const framework = new ApplicationFramework(
      {
        commandPrefix: '!',
        defaultCooldownMs: 0,
        botOwnerJid,
        databasePath: dbPath,
      },
      logger,
      fakeWA,
      {
        permissionResolver: createPermissionResolver(fakeWA, botOwnerJid),
      },
    )

    const service = new MenfessService(dbPath, logger, {
      secret: 'e2e-secret',
      maxPerDay: 5,
      botOwnerJid,
    })
    framework.registerService(service)
    framework.registerPlugin(createMenfessPlugin(fakeWA))

    await framework.start()

    const senderJid = '628111222333@s.whatsapp.net'
    const recipientJid = '628999888777@s.whatsapp.net'

    // 1. Non-owner tries !setmenfess -> permission denied
    const beforeCount1 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq1',
      remoteJid: senderJid,
      senderJid,
      text: '!setmenfess 08999888777 20',
      timestamp: Date.now(),
      fromMe: false,
    })
    const nonOwnerDenied = fakeWA.sent.slice(beforeCount1).find((s) => s.remoteJid === senderJid)
    assert.ok(nonOwnerDenied)
    assert.match(nonOwnerDenied.text, /izin|tidak memiliki izin|owner/i)

    // 2. Owner checks format with empty args
    const beforeCount2 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq2',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })
    const formatHelp = fakeWA.sent.slice(beforeCount2).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(formatHelp)
    assert.match(formatHelp.text, /Format Pengaturan Kuota Menfess/i)

    // 3. Owner sets sender's quota to 1
    const beforeCount3 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq3',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess 08111222333 1',
      timestamp: Date.now(),
      fromMe: false,
    })
    const setReply = fakeWA.sent.slice(beforeCount3).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(setReply)
    assert.match(setReply.text, /berhasil diatur menjadi \*1 sesi\/hari\*/)

    // 4. Sender checks status -> sees 1 sesi
    const beforeCount4 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq4',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess status',
      timestamp: Date.now(),
      fromMe: false,
    })
    const statusReply = fakeWA.sent.slice(beforeCount4).find((s) => s.remoteJid === senderJid)
    assert.ok(statusReply)
    assert.match(statusReply.text, /Sisa Kuota Harian:\* \*1 sesi\*/)

    // 5. Sender sends 1st menfess -> succeeds
    const beforeCount5 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq5',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Pesan pertama',
      timestamp: Date.now(),
      fromMe: false,
    })
    const sendSuccess = fakeWA.sent.slice(beforeCount5).find((s) => s.remoteJid === senderJid && s.text?.includes('Menfess Berhasil Terkirim'))
    assert.ok(sendSuccess)

    // Close session to test next menfess quota
    await framework.commands.dispatch({
      id: 'sq5_stop',
      remoteJid: senderJid,
      senderJid,
      text: '!stopmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    // 6. Sender tries 2nd menfess -> rejected (quota exhausted)
    const beforeCount6 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq6',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Pesan kedua harusnya ditolak',
      timestamp: Date.now(),
      fromMe: false,
    })
    const quotaExhausted = fakeWA.sent.slice(beforeCount6).find((s) => s.remoteJid === senderJid)
    assert.ok(quotaExhausted)
    assert.match(quotaExhausted.text, /Kuota Menfess harian kamu telah habis/)

    // 7. Owner adds quota: +2
    const beforeCount7 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq7',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess 08111222333 +2',
      timestamp: Date.now(),
      fromMe: false,
    })
    const addReply = fakeWA.sent.slice(beforeCount7).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(addReply)
    assert.match(addReply.text, /Berhasil menambahkan \*\+2\* kuota.*sekarang menjadi \*3 sesi\/hari\*/)

    // 8. Sender can send 2nd menfess now
    const beforeCount8 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq8',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess 08999888777 Pesan kedua sekarang berhasil',
      timestamp: Date.now(),
      fromMe: false,
    })
    const sendSuccess2 = fakeWA.sent.slice(beforeCount8).find((s) => s.remoteJid === senderJid && s.text?.includes('Menfess Berhasil Terkirim'))
    assert.ok(sendSuccess2)

    await framework.commands.dispatch({
      id: 'sq8_stop',
      remoteJid: senderJid,
      senderJid,
      text: '!stopmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    // 9. Owner sets sender to unlimited
    const beforeCount9 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq9',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess 08111222333 unlimited',
      timestamp: Date.now(),
      fromMe: false,
    })
    const unliReply = fakeWA.sent.slice(beforeCount9).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(unliReply)
    assert.match(unliReply.text, /UNLIMITED/)

    // 10. Sender status reflects unlimited
    const beforeCount10 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq10',
      remoteJid: senderJid,
      senderJid,
      text: '!menfess status',
      timestamp: Date.now(),
      fromMe: false,
    })
    const unliStatus = fakeWA.sent.slice(beforeCount10).find((s) => s.remoteJid === senderJid)
    assert.ok(unliStatus)
    assert.match(unliStatus.text, /Unlimited \(Tanpa Batas\)/)

    // 11. Owner checks quota info for sender
    const beforeCount11 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq11',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess 08111222333 check',
      timestamp: Date.now(),
      fromMe: false,
    })
    const checkInfo = fakeWA.sent.slice(beforeCount11).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(checkInfo)
    assert.match(checkInfo.text, /Informasi Kuota Menfess Pengguna/)
    assert.match(checkInfo.text, /Kustom \(Owner Set\)/)

    // 12. Owner resets quota back to default
    const beforeCount12 = fakeWA.sent.length
    await framework.commands.dispatch({
      id: 'sq12',
      remoteJid: botOwnerJid,
      senderJid: botOwnerJid,
      text: '!setmenfess 08111222333 reset',
      timestamp: Date.now(),
      fromMe: false,
    })
    const resetReply = fakeWA.sent.slice(beforeCount12).find((s) => s.remoteJid === botOwnerJid)
    assert.ok(resetReply)
    assert.match(resetReply.text, /direset ke standar \(\*5 sesi\/hari\*\)/)

    await framework.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
