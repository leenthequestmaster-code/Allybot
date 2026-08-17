import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameworkInteractionAdapter, TextInteractionAdapter, menuFromCommands } from '../dist/platform/index.js'

test('framework adapter maps CoreMessage and rejects self or foreign quoted menu input', () => {
  const adapter = new FrameworkInteractionAdapter(new TextInteractionAdapter({ botJid: 'bot@s.whatsapp.net' }), 'bot@s.whatsapp.net')
  const menu = {
    id: 'framework-menu', version: 1, kind: 'menu', title: 'Menu', body: 'Choose',
    items: [{ id: 'first', label: 'First', availability: 'active' }], fallbackText: 'Reply 1',
  }
  assert.equal(adapter.parseSelection({
    id: 'm1', remoteJid: 'chat@g.us', senderJid: 'user@s.whatsapp.net', text: '1', quotedText: 'Menu', quotedSenderJid: 'bot@s.whatsapp.net', timestamp: 1, fromMe: false,
  }, menu)?.itemId, 'first')
  assert.equal(adapter.parseSelection({
    id: 'm2', remoteJid: 'chat@g.us', senderJid: 'user@s.whatsapp.net', text: '1', quotedText: 'Menu', quotedSenderJid: 'other@s.whatsapp.net', timestamp: 1, fromMe: false,
  }, menu), undefined)
  assert.equal(adapter.parseSelection({
    id: 'm3', remoteJid: 'chat@g.us', senderJid: 'bot@s.whatsapp.net', text: '1', quotedText: 'Menu', quotedSenderJid: 'bot@s.whatsapp.net', timestamp: 1, fromMe: true,
  }, menu), undefined)
})

test('framework command conversion preserves menu order and metadata', () => {
  const menu = menuFromCommands([
    { name: 'zeta', description: 'Z', menuOrder: 20, handler() {} },
    { name: 'alpha', description: 'A', menuOrder: 1, handler() {} },
  ], { id: 'commands', title: 'Commands', body: 'Select', fallbackText: 'Use numbers' })
  assert.deepEqual(menu.items.map(({ id }) => id), ['alpha', 'zeta'])
  assert.equal(menu.items[0].description, 'A')
  assert.equal(menu.version, 1)
})
