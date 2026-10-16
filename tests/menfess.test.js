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
      this.sent.push({ remoteJid, media: payload, text: payload.caption, type: payload.kind })
    },
    async sendReaction(remoteJid, key, emoji) {
      this.reactions.push({ remoteJid, key, emoji })
    },
    async downloadMedia(_message, _source, _limits) {
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

    // 8. Close thread
    const closeRes = await service.closeThread(sender)
    assert.equal(closeRes.closed, true)
    assert.equal(closeRes.threadId, threadId)

    assert.equal(await service.getActiveSession(sender), undefined)
    assert.equal(await service.getActiveSession(recipient), undefined)

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

test('Menfess End-to-End Plugin conversation: send, sticky reply, media, and stop', async () => {
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

    // Step 1: Send !menfess
    await framework.commands.dispatch({
      id: 'm1',
      remoteJid: senderJid,
      senderJid,
      text: `!menfess 08999888777 Halo ini pesan rahasia perdana!`,
      timestamp: Date.now(),
      fromMe: false,
    })

    // Check sender received confirmation
    const senderReplies = fakeWA.sent.filter((s) => s.remoteJid === senderJid)
    assert.ok(senderReplies.length >= 1)
    assert.match(senderReplies[0].text, /Menfess Berhasil Terkirim/)

    // Check recipient received secret message
    const recipientMessages = fakeWA.sent.filter((s) => s.remoteJid === recipientJid)
    assert.ok(recipientMessages.length >= 1)
    assert.match(recipientMessages[0].text, /Pesan Rahasia Diterima/)
    assert.match(recipientMessages[0].text, /Halo ini pesan rahasia perdana!/)

    // Step 2: Sticky reply from recipient (plain text, no command prefix!)
    await fakeWA.emitMessage({
      id: 'm2',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      text: 'Wah siapa ya ini? Salam kenal!',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Check sender received relayed message
    const senderRelays = fakeWA.sent.filter(
      (s) => s.remoteJid === senderJid && s.text.includes('Wah siapa ya ini?'),
    )
    assert.equal(senderRelays.length, 1)
    assert.match(senderRelays[0].text, /\[Penerima\]/)

    // Step 3: Sticky reply from sender (photo)
    await fakeWA.emitMessage({
      id: 'm3',
      remoteJid: senderJid,
      senderJid,
      media: { kind: 'image' },
      text: 'Ini petunjuk buatmu hehe',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Check recipient received sanitized photo
    const recipientPhotos = fakeWA.sent.filter(
      (s) => s.remoteJid === recipientJid && s.type === 'image',
    )
    assert.equal(recipientPhotos.length, 1)
    assert.match(recipientPhotos[0].text, /Foto Anonim \[Pengirim\]/)

    // Step 4: Stop conversation with !stopmenfess
    await framework.commands.dispatch({
      id: 'm4',
      remoteJid: recipientJid,
      senderJid: recipientJid,
      text: '!stopmenfess',
      timestamp: Date.now(),
      fromMe: false,
    })

    // Both parties notified of closure
    const recipientClose = fakeWA.sent.find(
      (s) => s.remoteJid === recipientJid && s.text.includes('telah resmi diakhiri'),
    )
    assert.ok(recipientClose)

    const senderClose = fakeWA.sent.find(
      (s) => s.remoteJid === senderJid && s.text.includes('telah mengakhiri sesi Menfess'),
    )
    assert.ok(senderClose)

    // Verification: Active session is now null
    assert.equal(await service.getActiveSession(senderJid), undefined)
    assert.equal(await service.getActiveSession(recipientJid), undefined)

    await framework.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
