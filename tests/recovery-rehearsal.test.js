import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SqliteMissionStore } from '../dist/framework/index.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = {
  child() { return this },
  info() {},
  warn() {},
  error() {},
  debug() {},
}

const missionRecord = {
  id: 'recovery-mission-1',
  definitionId: 'recovery-definition',
  definitionVersion: 1,
  remoteJid: 'recovery-chat@g.us',
  actorJid: 'recovery-user@s.whatsapp.net',
  state: 'completed',
  data: { checkpoint: 'complete' },
  status: 'completed',
  revision: 2,
  createdAt: 1_000,
  updatedAt: 1_002,
  lastOperationKey: 'recovery-op-2',
}

test('SQLite recovery rehearsal preserves mission state and audit archive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-recovery-'))
  const databasePath = join(directory, 'runtime.sqlite')
  const backupPath = join(directory, 'runtime-restored.sqlite')
  const primaryDb = new Database(databasePath)
  const missionStore = new SqliteMissionStore(primaryDb, 'recovery')
  const guardrails = new PlatformGuardrailService(databasePath, logger, { maxHotAuditRecords: 2 })
  guardrails.initialize({})

  try {
    missionStore.create(missionRecord)
    guardrails.recordAudit({ eventId: 'recovery-audit-1', eventType: 'recovery.one', namespace: 'allybot', occurredAt: 1, outcome: 'allowed' })
    guardrails.recordAudit({ eventId: 'recovery-audit-2', eventType: 'recovery.two', namespace: 'allybot', occurredAt: 2, outcome: 'changed' })
    guardrails.recordAudit({ eventId: 'recovery-audit-3', eventType: 'recovery.three', namespace: 'allybot', occurredAt: 3, outcome: 'closed' })
    assert.deepEqual(guardrails.listAudit({ includeArchive: true, limit: 10 }).map((item) => item.eventId), [
      'recovery-audit-3',
      'recovery-audit-2',
      'recovery-audit-1',
    ])

    guardrails.shutdown({})
    primaryDb.pragma('wal_checkpoint(TRUNCATE)')
    primaryDb.close()
    copyFileSync(databasePath, backupPath)

    const restoredDb = new Database(backupPath)
    const restoredStore = new SqliteMissionStore(restoredDb, 'recovery')
    assert.deepEqual(restoredStore.get(missionRecord.id), missionRecord)
    const tableCounts = restoredDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM platform_missions WHERE namespace = 'recovery') AS missions,
        (SELECT COUNT(*) FROM platform_guardrail_audit_hot) AS hotAudit,
        (SELECT COUNT(*) FROM platform_guardrail_audit_archive) AS archiveAudit
    `).get()
    assert.equal(tableCounts.missions, 1)
    assert.equal(tableCounts.hotAudit, 2)
    assert.equal(tableCounts.archiveAudit, 1)
    restoredDb.close()

    const restoredGuardrails = new PlatformGuardrailService(backupPath, logger, { maxHotAuditRecords: 2 })
    restoredGuardrails.initialize({})
    try {
      assert.deepEqual(restoredGuardrails.listAudit({ includeArchive: true, limit: 10 }).map((item) => item.eventId), [
        'recovery-audit-3',
        'recovery-audit-2',
        'recovery-audit-1',
      ])
    } finally {
      restoredGuardrails.shutdown({})
    }
  } finally {
    if (primaryDb.open) primaryDb.close()
    if (guardrails) {
      try { guardrails.shutdown({}) } catch {}
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
