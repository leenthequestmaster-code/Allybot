import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { createCharacterPlugin } from '../dist/framework/plugins/character.js'
import { CharacterService } from '../dist/services/character-service.js'
import { createFakeWhatsapp } from './helpers/fake-whatsapp.js'

const logger = pino({ level: 'silent' })
const group = '120363000000000000@g.us'
const owner = '628120000001@s.whatsapp.net'
const other = '628120000002@s.whatsapp.net'

function message(id, senderJid, text) {
  return { id, remoteJid: group, senderJid, text, timestamp: Date.now(), fromMe: false }
}

test('Character plugin emote is group-only, bounded, and strips presentation markup', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const commands = new CommandRegistry({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, whatsapp, { get() { throw new Error('unused') } }, events)
  createCharacterPlugin(whatsapp).load?.({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, events, commands, services: { get() { throw new Error('unused') } } })

  await commands.dispatch(message('emote', owner, '!aksi *tersenyum*   lalu melambaikan tangan'))
  assert.equal(whatsapp.sent[0].text, '🎭 *Aksi:* tersenyum lalu melambaikan tangan')

  await commands.dispatch({ ...message('private-emote', owner, '!emote tersenyum'), remoteJid: owner })
  assert.match(whatsapp.sent[1].text, /hanya dapat digunakan di dalam grup/)

  await commands.dispatch(message('empty-emote', owner, '!emote'))
  assert.match(whatsapp.sent[2].text, /Format: !emote/)
})

test('Character plugin supports text-first roleplay profile workflow with owner checks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-character-plugin-'))
  const databasePath = join(directory, 'core.sqlite')
  const audits = []
  const guardrails = { recordAudit(input) { audits.push(input); return input } }
  const service = new CharacterService(databasePath, logger)
  service.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: { get() { return guardrails } } })
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = { get(name) { if (name === 'character') return service; throw new Error(`missing service ${name}`) } }
  const registry = new CommandRegistry({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, whatsapp, services, events)
  createCharacterPlugin(whatsapp).load?.({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, events, commands: registry, services })

  try {
    await registry.dispatch(message('create', owner, '!character create Aruna | Penjaga mercusuar'))
    assert.match(whatsapp.sent[0].text, /Character .* dibuat/)
    const reference = /ID: `([a-f0-9]{8})`/.exec(whatsapp.sent[0].text)?.[1]
    assert.ok(reference)

    await registry.dispatch(message('view', owner, '!char view'))
    assert.match(whatsapp.sent[1].text, /Nama: Aruna/)
    assert.match(whatsapp.sent[1].text, /Penjaga mercusuar/)

    await registry.dispatch(message('mood', owner, '!mood tenang'))
    assert.match(whatsapp.sent[2].text, /tenang/)

    await registry.dispatch(message('unauthorized-edit', other, `!character edit ${reference} Bajak Laut | Tidak boleh`))
    assert.match(whatsapp.sent[3].text, /Hanya pemilik character/)

    await registry.dispatch(message('list', owner, '!character list'))
    assert.match(whatsapp.sent[4].text, /Aruna/)
    assert.equal(audits.some((audit) => audit.eventType === 'character.created'), true)
  } finally {
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
    rmSync(directory, { recursive: true, force: true })
  }
})
