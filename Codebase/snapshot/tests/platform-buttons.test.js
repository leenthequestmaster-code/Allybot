import test from 'node:test'
import assert from 'node:assert/strict'
import { CapabilityAwareButtonAdapter, TextInteractionAdapter } from '../dist/platform/index.js'

const menu = (overrides = {}) => ({
  id: 'button-menu', version: 1, kind: 'menu', title: 'Allybot', body: 'Pilih:',
  items: [
    { id: 'general', label: 'General', availability: 'active' },
    { id: 'coming', label: 'Coming', availability: 'coming_soon' },
  ],
  fallbackText: 'Balas dengan angka.', ...overrides,
})

test('button adapter uses native quick replies only when capability and constraints allow it', async () => {
  const adapter = new CapabilityAwareButtonAdapter(new TextInteractionAdapter(), { interactionId: () => 'fixed' })
  const native = await adapter.render(menu(), { nativeQuickReply: true })
  assert.equal(native.mode, 'native')
  assert.deepEqual(native.payload.buttons, [{ id: 'general', title: 'General' }])

  const fallback = await adapter.render(menu(), { nativeQuickReply: false })
  assert.equal(fallback.mode, 'text')
  assert.match(fallback.text, /1\. General/)

  const tooMany = await adapter.render(menu({ items: [
    { id: 'one', label: 'One', availability: 'active' },
    { id: 'two', label: 'Two', availability: 'active' },
    { id: 'three', label: 'Three', availability: 'active' },
    { id: 'four', label: 'Four', availability: 'active' },
  ] }), { nativeQuickReply: true })
  assert.equal(tooMany.mode, 'text')
})

test('button adapter parses callback id and falls back to text parser', () => {
  const clock = { now: () => 1_000 }
  const adapter = new CapabilityAwareButtonAdapter(new TextInteractionAdapter({ clock }), { clock, interactionId: () => 'fixed' })
  const currentMenu = menu({ expiresAt: 2_000 })
  const selected = adapter.parseSelection({ remoteJid: 'chat@g.us', senderJid: 'user@s.whatsapp.net', buttonId: 'general' }, currentMenu)
  assert.equal(selected?.itemId, 'general')
  assert.equal(selected?.context.interactionId, 'fixed')
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@g.us', buttonId: 'coming' }, currentMenu), undefined)
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@g.us', buttonId: 'unknown' }, currentMenu), undefined)
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@g.us', text: '1' }, currentMenu)?.itemId, 'general')
})

test('button adapter rejects expired callback', () => {
  let now = 2_000
  const adapter = new CapabilityAwareButtonAdapter(new TextInteractionAdapter(), {
    clock: { now: () => now },
    interactionId: () => 'fixed',
  })
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@g.us', buttonId: 'general' }, menu({ expiresAt: 2_000 })), undefined)
  now = 1_000
  assert.equal(adapter.parseSelection({ remoteJid: 'chat@g.us', buttonId: 'general' }, menu({ expiresAt: 2_000 }))?.itemId, 'general')
})
