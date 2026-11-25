import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { WhatsAppConnection } from '../dist/whatsapp.js'
import { createToolsSearchPlugin, parseSearchBatchArgs } from '../dist/framework/plugins/tools-search.js'

const logger = pino({ level: 'silent' })
const baseConfig = { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: '628999999999@s.whatsapp.net' }

// Minimal valid JPEG bytes (SOI + APP0)
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

function makeMsg(text, senderJid = '628111111111@s.whatsapp.net', remoteJid = '120363000000000001@g.us') {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    remoteJid,
    senderJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
  }
}

function createFakeRedis() {
  const store = new Map()
  return {
    isEnabled: true,
    store,
    async get(key) {
      return store.has(key) ? JSON.parse(store.get(key)) : null
    },
    async set(key, value) {
      store.set(key, JSON.stringify(value))
      return true
    },
    async del(key) {
      return store.delete(key)
    },
  }
}

function createPluginHarness(deps = {}, options = {}) {
  const sent = []
  const reacts = []
  const redis = options.redis
  const groupMetadata = options.groupMetadata ?? {
    jid: '120363000000000001@g.us',
    subject: 'Test Group',
    participants: [
      { jid: '628111111111@s.whatsapp.net', role: 'member' },
      { jid: '628222222222@s.whatsapp.net', role: 'member' },
      { jid: '628333333333@s.whatsapp.net', role: 'admin' },
    ],
  }
  const whatsapp = options.whatsapp ?? {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async getGroupMetadata() { return groupMetadata },
    async sendText(remoteJid, text) { sent.push({ type: 'text', remoteJid, text }) },
    async sendMedia(remoteJid, payload) { sent.push({ type: 'media', remoteJid, payload }) },
    async sendMediaAlbum(remoteJid, items) { sent.push({ type: 'album', remoteJid, items }) },
    async sendReaction() {},
    async start() {},
    async close() {},
  }
  const services = {
    has(name) { return name === 'redis' && Boolean(redis) },
    get(name) {
      if (name === 'redis' && redis) return redis
      throw new Error(`service unavailable: ${name}`)
    },
  }
  const events = new EventBus(logger)
  const commands = new CommandRegistry(baseConfig, logger, whatsapp, services, events)
  const plugin = createToolsSearchPlugin(deps)
  plugin.load({ logger, config: baseConfig, events, commands, services })

  async function invokeRaw(cmdName, rawText, senderJid, remoteJid = '120363000000000001@g.us') {
    const cmd = commands.get(cmdName)
    assert.ok(cmd, `command ${cmdName} must be registered`)
    const body = rawText.replace(/^!/, '').trim()
    const [, ...args] = body.split(/\s+/)
    const msg = makeMsg(rawText, senderJid, remoteJid)
    const ctx = {
      message: msg,
      args,
      commandName: cmd.name,
      prefix: '!',
      config: baseConfig,
      logger,
      services,
      whatsapp,
      async reply(text) { await whatsapp.sendText(msg.remoteJid, text) },
      async react(emoji) { reacts.push({ remoteJid: msg.remoteJid, emoji }) },
    }
    await cmd.handler(ctx)
  }

  return { commands, whatsapp, sent, reacts, redis, invokeRaw }
}

test('parseSearchBatchArgs handles default, 1-10, clamp >10, quotes, and single numeric token', () => {
  assert.deepEqual(parseSearchBatchArgs('anime girl'), { query: 'anime girl', count: 1 })
  assert.deepEqual(parseSearchBatchArgs('cyberpunk 5'), { query: 'cyberpunk', count: 5 })
  assert.deepEqual(parseSearchBatchArgs('anime 25'), { query: 'anime', count: 10 })
  assert.deepEqual(parseSearchBatchArgs('anime 0'), { query: 'anime', count: 1 })
  assert.deepEqual(parseSearchBatchArgs('"persona 5" 4'), { query: 'persona 5', count: 4 })
  assert.deepEqual(parseSearchBatchArgs('"persona 5"'), { query: 'persona 5', count: 1 })
  assert.deepEqual(parseSearchBatchArgs("'fate grand order' 12"), { query: 'fate grand order', count: 10 })
  assert.deepEqual(parseSearchBatchArgs('5'), { query: '5', count: 1 })
  assert.deepEqual(parseSearchBatchArgs('   '), { query: '', count: 1 })
})

test('!pin and !pixiv dedupe within batch, paginate, replace failed downloads, enforce caption vs album rules, and auto-reset when pool exhausted', async () => {
  const redis = createFakeRedis()
  const pinPages = {
    page1: [
      { id: 'p1', title: 'Pin 1', author: 'a1', imageUrl: 'https://i.pinimg.com/originals/1.jpg?foo=1', mediaType: 'image' },
      // Duplicate canonical URL with different pin id & query param
      { id: 'p1dup', title: 'Pin 1 Dup', author: 'a1', imageUrl: 'https://i.pinimg.com/originals/1.jpg?foo=2', mediaType: 'image' },
      { id: 'p2-fail', title: 'Pin 2 Fail', author: 'a2', imageUrl: 'https://i.pinimg.com/originals/fail.jpg', mediaType: 'image' },
      { id: 'p3', title: 'Pin 3', author: 'a3', imageUrl: 'https://i.pinimg.com/originals/3.jpg', mediaType: 'image' },
      { id: 'p4', title: 'Pin 4', author: 'a4', imageUrl: 'https://i.pinimg.com/originals/4.jpg', mediaType: 'image' },
    ],
    page2: [
      { id: 'p5', title: 'Pin 5', author: 'a5', imageUrl: 'https://i.pinimg.com/originals/5.jpg', mediaType: 'image' },
      { id: 'p6', title: 'Pin 6', author: 'a6', imageUrl: 'https://i.pinimg.com/originals/6.jpg', mediaType: 'image' },
    ],
  }

  const harness = createPluginHarness({
    searchPinterestPage: async (_q, opts) => {
      if (!opts?.bookmark) return { items: pinPages.page1, nextBookmark: 'bm2' }
      return { items: pinPages.page2, nextBookmark: null }
    },
    fetchPinBuffer: async (url) => {
      if (url.includes('fail.jpg')) return null
      return Buffer.concat([FAKE_JPEG, Buffer.from(url)])
    },
    searchPixivIllust: async () => ({
      items: [
        { id: '101', title: 'Art 1', author: 'u1', tags: ['miku'], imageUrls: ['https://i.pixiv.re/101.jpg'], pageCount: 1 },
        { id: '101', title: 'Art 1 Dup', author: 'u1', tags: ['miku'], imageUrls: ['https://i.pixiv.re/101.jpg'], pageCount: 1 },
        { id: '102', title: 'Art 2', author: 'u2', tags: ['miku'], imageUrls: ['https://i.pixiv.re/102.jpg'], pageCount: 1 },
        { id: '103', title: 'Art 3', author: 'u3', tags: ['miku'], imageUrls: ['https://i.pixiv.re/103.jpg'], pageCount: 1 },
      ],
      nextPage: null,
      nextOffset: null,
    }),
    fetchPixivImage: async (url) => Buffer.concat([FAKE_JPEG, Buffer.from(url)]),
  }, { redis })

  // 1) N=1 sends single media with caption
  await harness.invokeRaw('pin', '!pin anime', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'media')
  assert.match(harness.sent.at(-1).payload.caption ?? '', /Pin 1/)

  // 2) N=3 pulls remaining from page1 (skipping p1 & p2-fail) + page2, sends album with undefined captions
  await harness.invokeRaw('pin', '!pin anime 3', '628111111111@s.whatsapp.net')
  const album1 = harness.sent.at(-1)
  assert.equal(album1.type, 'album')
  assert.equal(album1.items.length, 3)
  for (const item of album1.items) {
    assert.equal(item.caption, undefined)
  }
  const urls1 = album1.items.map((i) => Buffer.from(i.data).subarray(FAKE_JPEG.length).toString())
  assert.deepEqual(urls1, [
    'https://i.pinimg.com/originals/3.jpg',
    'https://i.pinimg.com/originals/4.jpg',
    'https://i.pinimg.com/originals/5.jpg',
  ])

  // 3) Next call asks for 3, only p6 is unseen so sends 1 (via sendMedia with caption)
  await harness.invokeRaw('pin', '!pin anime 3', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'media')
  const urlLast = Buffer.from(harness.sent.at(-1).payload.data).subarray(FAKE_JPEG.length).toString()
  assert.equal(urlLast, 'https://i.pinimg.com/originals/6.jpg')

  // 4) Pool exhausted (0 unseen left across pages) -> auto-resets seen history & delivers 3 fresh!
  await harness.invokeRaw('pin', '!pin anime 3', '628111111111@s.whatsapp.net')
  const resetAlbum = harness.sent.at(-1)
  assert.equal(resetAlbum.type, 'album')
  assert.equal(resetAlbum.items.length, 3)

  // 5) Pixiv N=3 dedupes duplicate illust_id 101 and delivers album of 3 distinct artworks without captions
  await harness.invokeRaw('pixiv', '!pixiv miku 3', '628111111111@s.whatsapp.net')
  const pixivAlbum = harness.sent.at(-1)
  assert.equal(pixivAlbum.type, 'album')
  assert.equal(pixivAlbum.items.length, 3)
  for (const item of pixivAlbum.items) assert.equal(item.caption, undefined)
})

test('In-flight lock and sliding-window image budget block spam and allow owner/admin bypass', async () => {
  let now = 1_700_000_000_000
  let releaseSlowDownload
  let slowOnce = true
  const redis = createFakeRedis()

  const pins = Array.from({ length: 30 }, (_, idx) => ({
    id: `p${idx + 1}`,
    title: `Pin ${idx + 1}`,
    author: 'a',
    imageUrl: `https://i.pinimg.com/originals/${idx + 1}.jpg`,
    mediaType: 'image',
  }))

  const harness = createPluginHarness({
    clock: () => now,
    searchPinterestPage: async () => ({ items: pins, nextBookmark: null }),
    fetchPinBuffer: async (url) => {
      if (slowOnce) {
        slowOnce = false
        await new Promise((resolve) => { releaseSlowDownload = resolve })
      }
      return Buffer.concat([FAKE_JPEG, Buffer.from(url)])
    },
  }, { redis })

  // In-flight singleflight lock for same user + chat
  const pFirst = harness.invokeRaw('pin', '!pin cat 2', '628111111111@s.whatsapp.net')
  await new Promise((r) => setTimeout(r, 15))
  await harness.invokeRaw('pin', '!pin cat 2', '628111111111@s.whatsapp.net')
  assert.match(harness.sent.at(-1).text ?? '', /masih diproses/i)
  releaseSlowDownload()
  await pFirst

  // User already used 2 images; send 10 + 8 = 20 total -> allowed
  await harness.invokeRaw('pin', '!pin cat 10', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'album')
  assert.equal(harness.sent.at(-1).items.length, 10)

  await harness.invokeRaw('pin', '!pin cat 8', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'album')
  assert.equal(harness.sent.at(-1).items.length, 8)

  // Next 5 exceeds 20/60s -> blocked politely
  await harness.invokeRaw('pin', '!pin cat 5', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'text')
  assert.match(harness.sent.at(-1).text, /Batas kirim gambar kamu \(20 gambar\/menit\)/)

  // Group admin bypasses budget even if group/user is busy
  await harness.invokeRaw('pin', '!pin cat 5', '628333333333@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'album')
  assert.equal(harness.sent.at(-1).items.length, 5)

  // Advance clock past 60s window -> user can send again
  now += 61_000
  await harness.invokeRaw('pin', '!pin cat 5', '628111111111@s.whatsapp.net')
  assert.equal(harness.sent.at(-1).type, 'album')
  assert.equal(harness.sent.at(-1).items.length, 5)
})

test('Concurrent User A and User B running !pin anime 5 in same group get disjoint image sets and non-interleaved albums', async () => {
  const socketCalls = []
  let msgSeq = 1
  const connection = new WhatsAppConnection({}, {}, logger)
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (remoteJid, content) => {
      // Simulate realistic network delay on album parent/children to expose any interleaving bug
      await new Promise((r) => setTimeout(r, 5))
      const id = `wa-${msgSeq++}`
      socketCalls.push({ remoteJid, content, keyId: id })
      return { key: { id, remoteJid, fromMe: true } }
    },
  }
  connection.status = 'connected'

  const pins = Array.from({ length: 15 }, (_, idx) => ({
    id: `p${idx + 1}`,
    title: `Pin ${idx + 1}`,
    author: 'artist',
    imageUrl: `https://i.pinimg.com/originals/c${idx + 1}.jpg`,
    mediaType: 'image',
  }))

  let maxConcurrentDownloads = 0
  let activeDownloads = 0

  const harness = createPluginHarness({
    searchPinterestPage: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { items: [...pins], nextBookmark: null }
    },
    fetchPinBuffer: async (url) => {
      activeDownloads += 1
      if (activeDownloads > maxConcurrentDownloads) maxConcurrentDownloads = activeDownloads
      await new Promise((r) => setTimeout(r, 15))
      activeDownloads -= 1
      return Buffer.concat([FAKE_JPEG, Buffer.from(url)])
    },
  }, { whatsapp: connection })

  await Promise.all([
    harness.invokeRaw('pin', '!pin anime 5', '628111111111@s.whatsapp.net'),
    harness.invokeRaw('pin', '!pin anime 5', '628222222222@s.whatsapp.net'),
  ])

  assert.ok(maxConcurrentDownloads <= 6, `Global download semaphore must cap at 6, saw ${maxConcurrentDownloads}`)

  // Expect 2 albums: each = 1 parent albumMessage + 5 image messages = 6 socket calls each = 12 total
  assert.equal(socketCalls.length, 12)
  assert.ok(socketCalls[0].content.album, 'First call must be album 1 parent')
  assert.equal(socketCalls[0].content.album.expectedImageCount, 5)
  const parent1KeyId = socketCalls[0].keyId
  for (let i = 1; i <= 5; i++) {
    assert.equal(socketCalls[i].content.albumParentKey.id, parent1KeyId)
    assert.equal(socketCalls[i].content.caption, undefined)
  }

  assert.ok(socketCalls[6].content.album, 'Seventh call must be album 2 parent (strictly non-interleaved)')
  assert.equal(socketCalls[6].content.album.expectedImageCount, 5)
  const parent2KeyId = socketCalls[6].keyId
  for (let i = 7; i <= 11; i++) {
    assert.equal(socketCalls[i].content.albumParentKey.id, parent2KeyId)
    assert.equal(socketCalls[i].content.caption, undefined)
  }

  const album1Urls = new Set(
    socketCalls.slice(1, 6).map((c) => c.content.image.subarray(FAKE_JPEG.length).toString()),
  )
  const album2Urls = new Set(
    socketCalls.slice(7, 12).map((c) => c.content.image.subarray(FAKE_JPEG.length).toString()),
  )
  assert.equal(album1Urls.size, 5)
  assert.equal(album2Urls.size, 5)
  for (const u of album1Urls) {
    assert.equal(album2Urls.has(u), false, `Disjoint check failed: ${u} appeared in both albums`)
  }
})

test('WhatsAppConnection.sendMediaAlbum falls back to sequential sendMedia when album parent fails', async () => {
  const sent = []
  const connection = new WhatsAppConnection({}, {}, logger)
  connection.socket = {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (remoteJid, content) => {
      if (content.album) throw new Error('album unsupported')
      sent.push({ remoteJid, content })
      return { key: { id: `m-${sent.length}` } }
    },
  }
  connection.status = 'connected'

  await connection.sendMediaAlbum('120363000000000001@g.us', [
    { kind: 'image', data: FAKE_JPEG, mimeType: 'image/jpeg' },
    { kind: 'image', data: FAKE_JPEG, mimeType: 'image/jpeg' },
  ])

  assert.equal(sent.length, 2)
  assert.equal(Buffer.isBuffer(sent[0].content.image), true)
  assert.equal(sent[0].content.albumParentKey, undefined)
})

test('!pin and !pixiv emit ✅ after-react on success and ❌ on failure/empty', async () => {
  const harness = createPluginHarness({
    searchPinterestPage: async (q) => {
      if (q === 'empty') return { items: [], nextBookmark: null }
      return {
        items: [{ id: 'ok1', title: 'Ok', author: 'a', imageUrl: 'https://i.pinimg.com/originals/ok1.jpg', mediaType: 'image' }],
        nextBookmark: null,
      }
    },
    fetchPinBuffer: async (url) => Buffer.concat([FAKE_JPEG, Buffer.from(url)]),
    searchPixivIllust: async (q) => {
      if (q === 'fail') throw new Error('network error')
      return {
        items: [{ id: 'px1', title: 'Pix', author: 'a', tags: [], imageUrls: ['https://i.pixiv.re/px1.jpg'], pageCount: 1 }],
        nextPage: null,
        nextOffset: null,
      }
    },
    fetchPixivImage: async (url) => Buffer.concat([FAKE_JPEG, Buffer.from(url)]),
  })

  await harness.invokeRaw('pin', '!pin sakura', '628111111111@s.whatsapp.net')
  assert.deepEqual(
    harness.reacts.slice(-2).map((s) => s.emoji),
    ['⏳', '✅'],
  )

  await harness.invokeRaw('pin', '!pin empty', '628111111111@s.whatsapp.net')
  assert.deepEqual(
    harness.reacts.slice(-2).map((s) => s.emoji),
    ['⏳', '❌'],
  )

  await harness.invokeRaw('pixiv', '!pixiv miku', '628111111111@s.whatsapp.net')
  assert.deepEqual(
    harness.reacts.slice(-2).map((s) => s.emoji),
    ['⏳', '✅'],
  )

  await harness.invokeRaw('pixiv', '!pixiv fail', '628111111111@s.whatsapp.net')
  assert.deepEqual(
    harness.reacts.slice(-2).map((s) => s.emoji),
    ['⏳', '❌'],
  )
})
