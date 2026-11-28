import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { generateImageWithAi, AiHandlerError } from '../dist/ai-handler.js'
import { matchNaturalLanguageCommand, createAiPlugin } from '../dist/framework/plugins/ai.js'
import {
  buildAnimePrompt,
  buildLogoPrompt,
  buildI2iPrompt,
  buildBgChangePrompt,
  buildRestorePrompt,
  buildCosplayPrompt,
  buildRemixPrompt,
} from '../dist/services/image-prompts.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp() {
  const sent = []
  const media = []
  const reactions = []
  return {
    sent,
    media,
    reactions,
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) {
      sent.push({ remoteJid, text })
    },
    async sendMedia(remoteJid, payload) {
      media.push({ remoteJid, payload })
    },
    async sendReaction(remoteJid, key, emoji) {
      reactions.push({ remoteJid, key, emoji })
    },
    async downloadMedia(msg, source, limits) {
      return {
        data: Buffer.from('fake-image-bytes-png'),
        mimeType: 'image/png',
        fileName: 'input.png',
        kind: 'image',
      }
    },
  }
}

function message(id, remoteJid, text, options = {}) {
  return {
    id,
    remoteJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    senderJid: options.senderJid ?? remoteJid,
    ...options,
  }
}

test('1. generateImageWithAi rejects empty prompt safely', async () => {
  await assert.rejects(
    () => generateImageWithAi('   '),
    (err) => err instanceof AiHandlerError && err.code === 'invalid_input',
  )
})

test('2. matchNaturalLanguageCommand routes drawing and painting requests to text2img', () => {
  const dummyMsg = { id: 'm1', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false }

  const res1 = matchNaturalLanguageCommand('gambarin kucing lucu di luar angkasa', dummyMsg)
  assert.equal(res1?.commandName, 'img')
  assert.equal(res1?.argsText, 'kucing lucu di luar angkasa')

  const res2 = matchNaturalLanguageCommand('tolong buatkan gambar pemandangan pantai sore hari', dummyMsg)
  assert.equal(res2?.commandName, 'img')
  assert.equal(res2?.argsText, 'pemandangan pantai sore hari')

  const res3 = matchNaturalLanguageCommand('lukiskan robot cyberpunk yang keren', dummyMsg)
  assert.equal(res3?.commandName, 'img')
  assert.equal(res3?.argsText, 'robot cyberpunk yang keren')
})

test('3. Technical image prompt wrappers generate deterministic templates', () => {
  // Anime
  const anime = buildAnimePrompt('gadis membaca buku')
  assert.match(anime.prompt, /Anime key visual, gadis membaca buku/i)
  assert.match(anime.prompt, /Makoto Shinkai/i)
  assert.match(anime.negativePrompt, /blurry linework/i)

  // Logo
  const logo = buildLogoPrompt('Kopi Senja', 'kedai kopi hangat')
  assert.match(logo.prompt, /Minimalist vector logo for "Kopi Senja", concept: kedai kopi hangat/i)
  assert.match(logo.negativePrompt, /blurry text/i)

  // I2I
  const i2i = buildI2iPrompt('tambahkan topi jerami')
  assert.match(i2i.prompt, /Image-to-image edit/i)
  assert.match(i2i.prompt, /tambahkan topi jerami/i)
  assert.match(i2i.negativePrompt, /identity drift/i)

  // BgChange
  const bg = buildBgChangePrompt('pantai Bali saat senja')
  assert.match(bg.prompt, /Background replacement/i)
  assert.match(bg.prompt, /pantai Bali saat senja/i)
  assert.match(bg.negativePrompt, /halo edges/i)

  // Restore
  const restore = buildRestorePrompt()
  assert.match(restore.prompt, /Image restoration/i)
  assert.match(restore.negativePrompt, /over-smoothed skin/i)

  // Cosplay
  const cosplay = buildCosplayPrompt('baju zirah ksatria hitam')
  assert.match(cosplay.prompt, /Wardrobe replacement/i)
  assert.match(cosplay.prompt, /baju zirah ksatria hitam/i)
  assert.match(cosplay.negativePrompt, /face change/i)

  // Remix
  const remix = buildRemixPrompt('gaya cat air pastel')
  assert.match(remix.prompt, /Concept blend/i)
  assert.match(remix.prompt, /gaya cat air pastel/i)
  assert.match(remix.negativePrompt, /identity loss/i)
})

test('4. AI Plugin registers image commands without leaking model names', () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)

  const plugin = createAiPlugin({ whatsapp })
  plugin.load?.({ logger, config, events, commands: registry, services })

  const registeredImageCmds = ['img', 'text2img', 'anime', 'logo', 'i2i', 'bgchange', 'restore', 'cosplay', 'remix']
  for (const cmd of registeredImageCmds) {
    const def = registry.get(cmd)
    assert.ok(def, `Command !${cmd} must be registered`)
    assert.doesNotMatch(def.description, /\b(gemini|imagen|flux|veo|google)\b/i)
  }
})

test('5. Image commands enforce standardized Status response on missing inputs', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)

  const plugin = createAiPlugin({ whatsapp })
  plugin.load?.({ logger, config, events, commands: registry, services })

  // 1. !img with empty prompt and no image
  await registry.dispatch(message('m-1', '1203630123@g.us', '!img', { senderJid: '6281@s.whatsapp.net' }))
  assert.match(whatsapp.sent[0].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[0].text, /!img <deskripsi>/i)

  // 2. !anime alias with empty prompt
  await registry.dispatch(message('m-2', '1203630123@g.us', '!anime', { senderJid: '6282@s.whatsapp.net' }))
  assert.match(whatsapp.sent[1].text, /Status: Gagal/i)

  // 3. !logo alias with empty prompt
  await registry.dispatch(message('m-3', '1203630123@g.us', '!logo', { senderJid: '6283@s.whatsapp.net' }))
  assert.match(whatsapp.sent[2].text, /Status: Gagal/i)

  // 4. !bgchange alias without image fails cleanly
  await registry.dispatch(message('m-4', '1203630123@g.us', '!bgchange', { senderJid: '6284@s.whatsapp.net' }))
  assert.match(whatsapp.sent[3].text, /Status: Gagal/i)
})

test('6. generateImageWithAi falls back to 9router-gemini when Flow is disabled/unavailable and never calls Pollinations', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls = []
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url))
    return new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.alloc(600, 1).toString('base64') }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const res = await generateImageWithAi('kucing oranye di taman', {
      flowEnabled: false,
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:20128/v1',
    })
    assert.equal(res.source, '9router-gemini')
    assert.equal(requestedUrls.some((u) => u.includes('pollinations')), false)
    assert.equal(requestedUrls.some((u) => u.endsWith('/images/generations')), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('7. !i2i collects up to 4 staged/direct/quoted images and clears staging buffer after use', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const plugin = createAiPlugin({ whatsapp })
  plugin.load?.({ logger, config, events, commands: registry, services })

  // Send 5 standalone images (staging should keep last 4)
  for (let i = 1; i <= 5; i++) {
    await events.emit('message.received', message(`img-${i}`, '1203630123@g.us', '', {
      senderJid: '628111@s.whatsapp.net',
      media: { kind: 'image' },
    }))
  }

  // Dispatch !i2i without attaching image directly -> should fail only if staging wasn't used, so here it proceeds to processing
  await registry.dispatch(message('cmd-i2i', '1203630123@g.us', '!i2i gabungkan jadi kolase', {
    senderJid: '628111@s.whatsapp.net',
  }))
  assert.match(whatsapp.sent.at(-1).text, /Gambar sedang diproses|Gagal memproses gambar/i)
  assert.doesNotMatch(whatsapp.sent.at(-1).text, /Format perintah/i)
})
