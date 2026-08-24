import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryFeatureRegistry, TextInteractionAdapter, isGroupJid } from '../dist/platform/index.js'

const feature = (overrides = {}) => ({
  id: 'utility-menu',
  version: 1,
  name: 'Utility Menu',
  description: 'Utility menu feature',
  category: 'utility',
  status: 'active',
  scope: 'chat',
  ...overrides,
})

const menu = (overrides = {}) => ({
  id: 'main',
  version: 1,
  kind: 'menu',
  title: 'Allybot',
  body: 'Pilih kategori:',
  items: [
    { id: 'general', label: 'General', availability: 'active' },
    { id: 'mission', label: 'Mission', availability: 'coming_soon' },
  ],
  fallbackText: 'Balas dengan angka.',
  ...overrides,
})

test('canonical group Jid validation accepts supported WhatsApp group formats', () => {
  assert.equal(isGroupJid('120363000000000000@g.us'), true)
  assert.equal(isGroupJid('120363000000000000-1234567890@g.us'), true)
  assert.equal(isGroupJid('6283197859955@s.whatsapp.net'), false)
  assert.equal(isGroupJid('group@g.us'), true)
  assert.equal(isGroupJid('not-a-jid'), false)
})

test('platform registry rejects duplicate ids and unregisters deterministically', () => {
  const registry = new InMemoryFeatureRegistry()
  const unregister = registry.register(feature())
  assert.throws(() => registry.register(feature()), /already registered/)
  assert.deepEqual(registry.list().map(({ id }) => id), ['utility-menu'])
  unregister()
  assert.equal(registry.has('utility-menu'), false)
})

test('text interaction renders menu and parses direct menu command or reply number', async () => {
  let now = 1_000
  const adapter = new TextInteractionAdapter({
    botJid: 'bot@s.whatsapp.net',
    clock: { now: () => now },
    interactionId: () => 'interaction-fixed',
  })
  const currentMenu = menu({ expiresAt: 2_000 })
  assert.match(await adapter.render(currentMenu), /1\. General/)
  assert.match(await adapter.render(currentMenu), /2\. Mission \(Coming Soon\)/)

  const direct = adapter.parseSelection({ remoteJid: 'chat@s.whatsapp.net', senderJid: 'user@s.whatsapp.net', text: '!menu 1' }, currentMenu)
  assert.equal(direct?.itemId, 'general')
  assert.equal(direct?.context.interactionId, 'interaction-fixed')

  const reply = adapter.parseSelection({
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'user@s.whatsapp.net',
    text: '1',
    quotedText: 'Allybot\n1. General',
    quotedSenderJid: 'bot@s.whatsapp.net',
  }, currentMenu)
  assert.equal(reply?.itemId, 'general')
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@s.whatsapp.net', text: '2' }, currentMenu), undefined)

  now = 2_000
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@s.whatsapp.net', text: '1' }, currentMenu), undefined)
})

test('quoted menu selection requires the configured bot sender', () => {
  const adapter = new TextInteractionAdapter({ botJid: 'bot@s.whatsapp.net' })
  const currentMenu = menu()
  assert.equal(adapter.parseSelection({
    remoteJid: 'chat@s.whatsapp.net',
    text: '1',
    quotedText: 'fake menu',
    quotedSenderJid: 'attacker@s.whatsapp.net',
  }, currentMenu)?.itemId, 'general')
  assert.equal(adapter.parseSelection({
    remoteJid: 'chat@s.whatsapp.net',
    quotedText: 'fake menu',
    quotedSenderJid: 'attacker@s.whatsapp.net',
  }, currentMenu), undefined)
})
