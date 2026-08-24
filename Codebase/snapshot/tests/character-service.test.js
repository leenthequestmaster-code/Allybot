import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { CharacterService } from '../dist/services/character-service.js'

const logger = pino({ level: 'silent' })
const group = '<jid-redacted@g.us>'
const owner = '<jid-redacted@s.whatsapp.net>'
const other = '<jid-redacted@s.whatsapp.net>'

function createGuardrails(audits) {
  return { recordAudit(input) { audits.push(input); return input } }
}

function initialize(service, guardrails) {
  service.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: { get() { return guardrails } } })
}

test('CharacterService persists bounded profiles, enforces ownership, and archives without deletion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-character-'))
  const databasePath = join(directory, 'core.sqlite')
  const audits = []
  const guardrails = createGuardrails(audits)
  try {
    const service = new CharacterService(databasePath, logger, { clock: () => 1_000 })
    initialize(service, guardrails)
    const created = service.create(group, owner, 'Aruna', 'Penjaga mercusuar yang tenang.')
    assert.equal(created.name, 'Aruna')
    assert.equal(service.getOwnActive(group, owner)?.id, created.id)
    assert.equal(service.findVisible(group, created.id.slice(0, 8))?.profile, 'Penjaga mercusuar yang tenang.')
    assert.equal(service.listVisible(group).length, 1)
    assert.throws(() => service.update(group, other, created.id.slice(0, 8), 'Bajak', 'Tidak boleh'), /pemilik character/)
    const updated = service.update(group, owner, created.id.slice(0, 8), 'Aruna Senja', 'Penjaga mercusuar saat kabut.')
    assert.equal(updated.revision, 2)
    assert.equal(service.setMood(group, owner, 'tenang').mood, 'tenang')
    assert.equal(service.retire(group, owner, created.id.slice(0, 8)), true)
    assert.equal(service.getOwnActive(group, owner), undefined)
    assert.equal(service.listVisible(group).length, 0)
    assert.equal(audits.some((audit) => audit.eventType === 'character.retired' && audit.outcome === 'closed'), true)
    assert.equal(audits.some((audit) => JSON.stringify(audit.metadata).includes('Penjaga')), false)
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })

    const reopened = new CharacterService(databasePath, logger, { clock: () => 2_000 })
    initialize(reopened, guardrails)
    assert.equal(reopened.findVisible(group, created.id.slice(0, 8)), undefined)
    reopened.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CharacterService limits active characters per owner and validates identifiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-character-limit-'))
  const databasePath = join(directory, 'core.sqlite')
  const guardrails = createGuardrails([])
  try {
    const service = new CharacterService(databasePath, logger)
    initialize(service, guardrails)
    for (const name of ['One', 'Two', 'Three']) service.create(group, owner, name, '')
    assert.throws(() => service.create(group, owner, 'Four', ''), /maksimal 3 character/)
    assert.throws(() => service.findVisible(group, 'bad id'), /safe identifier/)
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
