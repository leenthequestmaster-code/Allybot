import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { test } from 'node:test'
import { loadConfig } from '../dist/config.js'
import { SqliteStorage } from '../dist/storage.js'

const logger = pino({ level: 'silent' })

function createStorage(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-storage-test-'))
  const databasePath = join(directory, 'storage.sqlite')
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_PATH: databasePath,
    AUTH_ACCOUNT_ID: 'storage-test',
    LOCAL_MESSAGE_CACHE_TTL_MS: '60000',
    LOCAL_MESSAGE_CACHE_MAX_ROWS: '2',
    LOCAL_MESSAGE_CACHE_MAX_BYTES: '4096',
    WHATSAPP_ENABLED: 'false',
    QR_ENABLED: 'false',
    PAIRING_ENABLED: 'false',
    ENABLE_HISTORY_SYNC: 'false',
    ...overrides,
  })
  return { storage: new SqliteStorage(config, logger), directory }
}

function message(id, text) {
  return {
    key: { remoteJid: 'synthetic@s.whatsapp.net', id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1,
  }
}

test('local message cache enforces row and byte bounds without affecting auth state', async () => {
  const { storage, directory } = createStorage()
  try {
    storage.loadCreds()
    storage.saveMessages([
      message('one', 'one'),
      message('two', 'two'),
      message('three', 'three'),
    ])
    const stats = storage.getMessageCacheStats()
    assert.equal(stats.rows, 2)
    assert.equal(await storage.getMessage({ remoteJid: 'synthetic@s.whatsapp.net', id: 'one' }), undefined)
    assert.ok(await storage.getMessage({ remoteJid: 'synthetic@s.whatsapp.net', id: 'three' }))

    storage.saveMessages([message('oversized', 'x'.repeat(8_000))])
    assert.equal(await storage.getMessage({ remoteJid: 'synthetic@s.whatsapp.net', id: 'oversized' }), undefined)
    assert.ok(storage.getMessageCacheStats().bytes <= 4096)
    assert.equal(storage.verifyIntegrity().valid, true)
  } finally {
    storage.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('local message cache removes expired rows on prune and stale read', async () => {
  const { storage, directory } = createStorage({ LOCAL_MESSAGE_CACHE_TTL_MS: '60000' })
  try {
    storage.saveMessages([message('expired', 'expired')])
    const prune = storage.pruneMessageCache(Date.now() + 60_001)
    assert.equal(prune.expiredRows, 1)
    assert.equal(await storage.getMessage({ remoteJid: 'synthetic@s.whatsapp.net', id: 'expired' }), undefined)
  } finally {
    storage.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
