import { test } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { utilityPlugin } from '../dist/framework/plugins/utility.js'

const logger = pino({ level: 'silent' })

function fakeWhatsapp() {
  return {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
    async start() {},
    async close() {},
  }
}

function message(index, text, overrides = {}) {
  return {
    id: `utility-${index}`,
    remoteJid: `utility-${index}@s.whatsapp.net`,
    senderJid: `utility-${index}@s.whatsapp.net`,
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...overrides,
  }
}

function createRegistry(whatsapp) {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const config = { commandPrefix: '!', defaultCooldownMs: 0 }
  const registry = new CommandRegistry(config, logger, whatsapp, services, events, undefined, [])
  utilityPlugin.load?.({ logger, config, events, commands: registry, services })
  return registry
}

test('utility module split preserves canonical command registration parity', () => {
  const registry = createRegistry(fakeWhatsapp())
  assert.deepEqual(registry.list().map((command) => command.name), [
    'status', 'uptime', 'features', 'commands', 'searchcmd', 'about', 'version', 'privacy', 'support',
    'calc', 'convert', 'time', 'date', 'random', 'choose', 'flip', 'roll', 'truth', 'dare', 'rps', '8ball',
  ])
  assert.deepEqual(registry.get('dice')?.aliases, ['dice'])
  assert.deepEqual(registry.get('suit')?.aliases, ['suit'])
})

test('status, uptime, and features expose bounded non-sensitive runtime summaries', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

  await registry.dispatch(message(1, '!status'))
  assert.match(whatsapp.sent[0].text, /Status Allybot/)
  assert.match(whatsapp.sent[0].text, /Sambungan: connected/)
  assert.match(whatsapp.sent[0].text, /Data rahasia/)

  await registry.dispatch(message(2, '!uptime'))
  assert.match(whatsapp.sent[1].text, /sudah berjalan selama/)
  assert.match(whatsapp.sent[1].text, /detik/)

  await registry.dispatch(message(3, '!features'))
  assert.match(whatsapp.sent[2].text, /Ringkasan fitur Allybot/)
  assert.match(whatsapp.sent[2].text, /TOOLS:/)
  assert.doesNotMatch(whatsapp.sent[2].text, /clearcache/)
})

test('utility command index and search expose registered commands without hidden entries', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

  await registry.dispatch(message(4, '!commands'))
  assert.match(whatsapp.sent[0].text, /Command Allybot yang tersedia/)
  assert.match(whatsapp.sent[0].text, /!searchcmd/)

  await registry.dispatch(message(5, '!searchcmd matematika'))
  assert.match(whatsapp.sent[1].text, /!calc/)
  assert.doesNotMatch(whatsapp.sent[1].text, /menu-reply/)
})

test('calculator accepts bounded arithmetic and rejects executable syntax', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

  await registry.dispatch(message(3, '!calc (12 + 8) / 2'))
  assert.match(whatsapp.sent[0].text, /10/)

  await registry.dispatch(message(4, '!calc process.exit()'))
  assert.match(whatsapp.sent[1].text, /Format:/)
})

test('unit and timezone utilities validate input and return bounded output', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

  await registry.dispatch(message(5, '!convert 10 km m'))
  assert.match(whatsapp.sent[0].text, /10 km/)
  assert.match(whatsapp.sent[0].text, /10\.000 m/)

  await registry.dispatch(message(6, '!convert 10 km kg'))
  assert.match(whatsapp.sent[1].text, /Format:/)

  await registry.dispatch(message(7, '!time Not/AZone'))
  assert.match(whatsapp.sent[2].text, /tidak dikenali/)
})

test('fun commands stay within bounded ranges and reject malformed dice', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

  await registry.dispatch(message(8, '!random 1 3'))
  assert.match(whatsapp.sent[0].text, /Angka acaknya: \*[1-3]\*/)

  await registry.dispatch(message(9, '!choose teh | kopi'))
  assert.match(whatsapp.sent[1].text, /Pilihanku: \*(teh|kopi)\*/)

  await registry.dispatch(message(10, '!roll 2d6'))
  assert.match(whatsapp.sent[2].text, /2d6/)

  await registry.dispatch(message(11, '!roll 99d999'))
  assert.match(whatsapp.sent[3].text, /Format:/)

  await registry.dispatch(message(12, '!8ball apakah aman?'))
  assert.match(whatsapp.sent[4].text, /apakah aman\?/)

  await registry.dispatch(message(13, '!truth'))
  assert.match(whatsapp.sent[5].text, /Truth:/)

  await registry.dispatch(message(14, '!dare'))
  assert.match(whatsapp.sent[6].text, /Dare:/)

  const challenger = '<jid-redacted@s.whatsapp.net>'
  const challenged = '<jid-redacted@s.whatsapp.net>'
  await registry.dispatch(message(15, '!rps challenge @pemain', {
    remoteJid: 'rps-group@g.us',
    senderJid: challenger,
    mentionedJids: [challenged],
  }))
  assert.match(whatsapp.sent.at(-1).text, /Tantangan Suit PvP/)

  await registry.dispatch(message(16, '!rps accept', {
    remoteJid: challenged,
    senderJid: challenged,
  }))
  assert.match(whatsapp.sent.at(-1).text, /Tantangan diterima/)

  await new Promise((resolve) => setTimeout(resolve, 1_600))
  await registry.dispatch(message(17, '!rps batu', {
    remoteJid: challenger,
    senderJid: challenger,
  }))
  assert.match(whatsapp.sent.at(-1).text, /Pilihan.*batu.*dicatat/)

  await registry.dispatch(message(18, '!rps laser', {
    remoteJid: challenged,
    senderJid: challenged,
  }))
  assert.match(whatsapp.sent.at(-1).text, /Format:/)
})
