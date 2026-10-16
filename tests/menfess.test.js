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
    assert.match(senderVideos[0].text, /Video Anonim \[Penerima\]/)

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
    assert.match(senderDocs[0].text, /Dokumen Anonim \[Penerima\]/)

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
