import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WhatsAppConnection, SendGate } from '../dist/whatsapp.js'

function logger() {
  return { debug() {}, warn() {} }
}

test('WhatsApp adapter exposes bounded direct and quoted media descriptors', async () => {
  const connection = new WhatsAppConnection({}, {}, logger())
  const received = []
  connection.onMessage((message) => received.push(message))

  await connection.emitMessages([
    {
      key: { remoteJid: 'group@g.us', id: 'direct-image', participant: 'alice@s.whatsapp.net', fromMe: false },
      message: {
        imageMessage: { mimetype: 'image/jpeg', fileLength: 1234, width: 800, height: 600, caption: '!sticker' },
      },
      messageTimestamp: 1_700_000_000,
    },
    {
      key: { remoteJid: 'group@g.us', id: 'quoted-sticker', participant: 'alice@s.whatsapp.net', fromMe: false },
      message: {
        extendedTextMessage: {
          text: '!toimg',
          contextInfo: {
            quotedMessage: { stickerMessage: { mimetype: 'image/webp', fileLength: 222 } },
            participant: 'bob@s.whatsapp.net',
          },
        },
      },
      messageTimestamp: 1_700_000_001,
    },
    {
      key: { remoteJid: 'group@g.us', id: 'view-once-image', participant: 'alice@s.whatsapp.net', fromMe: false },
      message: {
        viewOnceMessage: { message: { imageMessage: { mimetype: 'image/png', fileLength: 44 } } },
      },
      messageTimestamp: 1_700_000_002,
    },
  ])

  assert.deepEqual(received[0].media, {
    kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1234, width: 800, height: 600,
  })
  assert.deepEqual(received[1].quotedMedia, {
    kind: 'sticker', mimeType: 'image/webp', sizeBytes: 222, quoted: true,
  })
  assert.deepEqual(received[2].media, { kind: 'image', mimeType: 'image/png', sizeBytes: 44 })
  assert.equal(JSON.stringify(received).includes('mediaKey'), false)
  assert.equal(JSON.stringify(received).includes('directPath'), false)
})

test('WhatsApp adapter rejects oversized stored media before download', async () => {
  const content = { imageMessage: { mimetype: 'image/jpeg', fileLength: 10_000 } }
  const connection = new WhatsAppConnection({}, { getMessage: async () => content }, logger())
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    updateMediaMessage: async () => { throw new Error('must not reupload') },
  }
  connection.status = 'connected'

  await assert.rejects(() => connection.downloadMedia({
    id: 'oversize', remoteJid: 'group@g.us', media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 10_000 }, timestamp: Date.now(), fromMe: false,
  }, 'direct', { maxBytes: 100 }), /exceeds byte limit/)
})

test('WhatsApp adapter sends validated binary media payloads through Baileys', async () => {
  const sent = []
  const connection = new WhatsAppConnection({}, {}, logger())
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (remoteJid, content) => { sent.push({ remoteJid, content }); return {} },
  }
  connection.status = 'connected'

  await connection.sendMedia('group@g.us', {
    kind: 'sticker', data: new Uint8Array([1, 2, 3]), mimeType: 'image/webp',
  })
  assert.equal(sent[0].remoteJid, 'group@g.us')
  assert.equal(Buffer.isBuffer(sent[0].content.sticker), true)
  assert.equal(sent[0].content.mimetype, 'image/webp')

  await assert.rejects(() => connection.sendMedia('group@g.us', {
    kind: 'sticker', data: new Uint8Array([1]), mimeType: 'image/png',
  }), /Sticker payload must be image\/webp/)
  await assert.rejects(() => connection.sendMedia('group@g.us', {
    kind: 'document', data: new Uint8Array([1]), mimeType: 'text/plain', fileName: '../unsafe.txt',
  }), /Document filename is invalid/)
})

test('SendGate allows burst and paces subsequent requests', async () => {
  const gate = new SendGate({ maxBurst: 3, refillIntervalMs: 100 })
  const start = Date.now()

  // 3 immediate permits
  await gate.acquireSendPermit()
  await gate.acquireSendPermit()
  await gate.acquireSendPermit()
  const burstDuration = Date.now() - start
  assert.ok(burstDuration < 60, `burst should complete almost immediately, took ${burstDuration}ms`)

  // 4th permit must wait for refill (~100ms)
  await gate.acquireSendPermit()
  const pacedDuration = Date.now() - start
  assert.ok(pacedDuration >= 70, `4th permit should wait for refill, took ${pacedDuration}ms`)
})

test('SendGate media semaphore limits concurrent media uploads to maxMediaInFlight', async () => {
  const gate = new SendGate({ maxMediaInFlight: 1 })
  const events = []

  const job1 = async () => {
    const release = await gate.acquireMediaSlot()
    events.push('job1:start')
    await new Promise((r) => setTimeout(r, 80))
    events.push('job1:end')
    release()
  }

  const job2 = async () => {
    const release = await gate.acquireMediaSlot()
    events.push('job2:start')
    await new Promise((r) => setTimeout(r, 20))
    events.push('job2:end')
    release()
  }

  await Promise.all([job1(), job2()])
  assert.deepEqual(events, ['job1:start', 'job1:end', 'job2:start', 'job2:end'])
})
