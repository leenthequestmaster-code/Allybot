import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type proto,
} from '@whiskeysockets/baileys'
import type { AppConfig } from './config.js'
import { AllybotError } from './errors.js'
import type { AppLogger } from './logger.js'

interface SerializedValueRow {
  value: string
}

interface StoredMessageRow {
  data: string
  updated_at: string
}

export interface MessageCacheStats {
  readonly rows: number
  readonly bytes: number
}

export interface MessageCachePruneResult extends MessageCacheStats {
  readonly expiredRows: number
  readonly excessRows: number
  readonly excessBytesRows: number
}

function serializeValue(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer)
}

function parseValue<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T
}

function getMessageKey(key: WAMessageKey): { jid: string; id: string } | undefined {
  if (!key.remoteJid || !key.id) return undefined
  return { jid: key.remoteJid, id: key.id }
}

export class SqliteStorage {
  private readonly db: Database.Database
  private readonly accountId: string
  private readonly logger: AppLogger
  private readonly messageCacheTtlMs: number
  private readonly messageCacheMaxRows: number
  private readonly messageCacheMaxBytes: number
  private readonly messagePruneTimer: NodeJS.Timeout

  constructor(config: AppConfig, logger: AppLogger) {
    mkdirSync(dirname(config.DATABASE_PATH), { recursive: true, mode: 0o700 })
    this.db = new Database(config.DATABASE_PATH)
    this.accountId = config.AUTH_ACCOUNT_ID
    this.logger = logger.child({ component: 'storage' })
    this.messageCacheTtlMs = config.LOCAL_MESSAGE_CACHE_TTL_MS
    this.messageCacheMaxRows = config.LOCAL_MESSAGE_CACHE_MAX_ROWS
    this.messageCacheMaxBytes = config.LOCAL_MESSAGE_CACHE_MAX_BYTES
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.pruneMessageCache()
    const pruneIntervalMs = Math.min(Math.max(Math.floor(this.messageCacheTtlMs / 2), 60_000), 60 * 60_000)
    this.messagePruneTimer = setInterval(() => {
      try {
        this.pruneMessageCache()
      } catch (error) {
        this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'message cache pruning failed')
      }
    }, pruneIntervalMs)
    this.messagePruneTimer.unref()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_creds (
        account_id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_keys (
        account_id TEXT NOT NULL,
        key_type TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, key_type, key_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        account_id TEXT NOT NULL,
        remote_jid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        value TEXT NOT NULL,
        timestamp INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, remote_jid, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_account_time
        ON messages (account_id, timestamp);
    `)

    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, applied_at)
         VALUES (@id, @applied_at)`,
      )
      .run({ id: '0001_core', applied_at: new Date().toISOString() })
  }

  loadCreds(): AuthenticationCreds {
    const row = this.db
      .prepare('SELECT value FROM auth_creds WHERE account_id = ?')
      .get(this.accountId) as SerializedValueRow | undefined

    if (!row) {
      const creds = initAuthCreds()
      this.saveCreds(creds)
      this.logger.info('initialized new authentication credentials')
      return creds
    }

    try {
      const creds = parseValue<AuthenticationCreds>(row.value)
      if (!creds.noiseKey || !creds.signedIdentityKey || !creds.advSecretKey) {
        throw new Error('required authentication fields are missing')
      }
      return creds
    } catch (error) {
      throw new AllybotError(
        'Authentication state is corrupt or unreadable; preserving it for manual recovery',
        'authentication',
        { cause: error },
      )
    }
  }

  saveCreds(creds: AuthenticationCreds): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO auth_creds (account_id, value, updated_at)
         VALUES (@account_id, @value, @updated_at)
         ON CONFLICT(account_id) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run({ account_id: this.accountId, value: serializeValue(creds), updated_at: now })
  }

  verifyIntegrity(): { valid: boolean; reason?: string; keyCount: number } {
    const credsRow = this.db
      .prepare('SELECT value FROM auth_creds WHERE account_id = ?')
      .get(this.accountId) as SerializedValueRow | undefined
    const keyRows = this.db
      .prepare('SELECT value FROM auth_keys WHERE account_id = ?')
      .all(this.accountId) as SerializedValueRow[]
    try {
      if (credsRow) {
        const creds = parseValue<AuthenticationCreds>(credsRow.value)
        if (!creds.noiseKey || !creds.signedIdentityKey || !creds.advSecretKey) {
          throw new Error('required authentication fields are missing')
        }
      }
      for (const row of keyRows) parseValue<unknown>(row.value)
      return { valid: true, keyCount: keyRows.length }
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error), keyCount: keyRows.length }
    }
  }

  createKeyStore(): SignalKeyStore {
    const get = <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      if (ids.length === 0) return {} as { [id: string]: SignalDataTypeMap[T] }
      const placeholders = ids.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT key_id, value FROM auth_keys
           WHERE account_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
        )
        .all(this.accountId, String(type), ...ids) as Array<{ key_id: string; value: string }>
      const keyValues: { [id: string]: SignalDataTypeMap[T] } = {}
      for (const row of rows) {
        keyValues[row.key_id] = parseValue<SignalDataTypeMap[T]>(row.value)
      }
      return keyValues
    }

    const set = (keyData: SignalDataSet): void => {
      const now = new Date().toISOString()
      const persistKeyUpdates = this.db.transaction((entries: Array<[string, Record<string, unknown>]>) => {
        for (const [type, values] of entries) {
          for (const [id, value] of Object.entries(values)) {
            if (value === null) {
              this.db
                .prepare(
                  'DELETE FROM auth_keys WHERE account_id = ? AND key_type = ? AND key_id = ?',
                )
                .run(this.accountId, type, id)
              continue
            }
            this.db
              .prepare(
                `INSERT INTO auth_keys (account_id, key_type, key_id, value, updated_at)
                 VALUES (@account_id, @key_type, @key_id, @value, @updated_at)
                 ON CONFLICT(account_id, key_type, key_id) DO UPDATE SET
                   value = excluded.value,
                   updated_at = excluded.updated_at`,
              )
              .run({
                account_id: this.accountId,
                key_type: type,
                key_id: id,
                value: serializeValue(value),
                updated_at: now,
              })
          }
        }
      })
      persistKeyUpdates(Object.entries(keyData) as Array<[string, Record<string, unknown>]>)
    }

    const clear = (): void => {
      this.db.prepare('DELETE FROM auth_keys WHERE account_id = ?').run(this.accountId)
    }

    return { get, set, clear }
  }

  saveMessages(messages: WAMessage[]): void {
    const now = new Date().toISOString()
    const upsertMessage = this.db.prepare(
      `INSERT INTO messages (account_id, remote_jid, message_id, value, timestamp, updated_at)
       VALUES (@account_id, @remote_jid, @message_id, @value, @timestamp, @updated_at)
       ON CONFLICT(account_id, remote_jid, message_id) DO UPDATE SET
         value = excluded.value,
         timestamp = excluded.timestamp,
         updated_at = excluded.updated_at`,
    )
    const persistMessages = this.db.transaction((incoming: WAMessage[]) => {
      for (const message of incoming) {
        const key = getMessageKey(message.key)
        if (!key || !message.message) continue
        const value = serializeValue(message.message)
        if (Buffer.byteLength(value, 'utf8') > this.messageCacheMaxBytes) {
          this.logger.warn({ reason: 'message_cache_item_too_large' }, 'message skipped by local cache byte limit')
          continue
        }
        upsertMessage.run({
          account_id: this.accountId,
          remote_jid: key.jid,
          message_id: key.id,
          value,
          timestamp: message.messageTimestamp ? Number(message.messageTimestamp) : null,
          updated_at: now,
        })
      }
      this.pruneMessageCacheWithinTransaction(new Date(now).getTime())
    })
    persistMessages(messages)
  }

  getMessageCacheStats(): MessageCacheStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes
         FROM messages WHERE account_id = ?`,
      )
      .get(this.accountId) as { rows: number; bytes: number }
    return { rows: Number(row.rows), bytes: Number(row.bytes) }
  }

  pruneMessageCache(now = Date.now()): MessageCachePruneResult {
    if (!Number.isFinite(now)) throw new Error('message cache prune clock must be finite')
    const prune = this.db.transaction((clock: number) => this.pruneMessageCacheWithinTransaction(clock))
    return prune(now)
  }

  private pruneMessageCacheWithinTransaction(now: number): MessageCachePruneResult {
    const cutoff = new Date(now - this.messageCacheTtlMs).toISOString()
    const expiredRows = this.db
      .prepare('DELETE FROM messages WHERE account_id = ? AND updated_at < ?')
      .run(this.accountId, cutoff).changes

    const excessRowIds = this.db
      .prepare(
        `SELECT rowid FROM messages
         WHERE account_id = ?
         ORDER BY updated_at DESC, rowid DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(this.accountId, this.messageCacheMaxRows) as Array<{ rowid: number }>
    const excessRows = this.deleteMessageRows(excessRowIds.map((row) => row.rowid))

    const retainedRows = this.db
      .prepare(
        `SELECT rowid, length(CAST(value AS BLOB)) AS bytes
         FROM messages
         WHERE account_id = ?
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(this.accountId) as Array<{ rowid: number; bytes: number }>
    let retainedBytes = 0
    const excessByteRowIds: number[] = []
    for (const row of retainedRows) {
      const rowBytes = Number(row.bytes)
      if (retainedBytes + rowBytes <= this.messageCacheMaxBytes) retainedBytes += rowBytes
      else excessByteRowIds.push(row.rowid)
    }
    const excessBytesRows = this.deleteMessageRows(excessByteRowIds)
    const stats = this.getMessageCacheStats()
    return { ...stats, expiredRows, excessRows, excessBytesRows }
  }

  private deleteMessageRows(rowIds: readonly number[]): number {
    if (rowIds.length === 0) return 0
    const placeholders = rowIds.map(() => '?').join(',')
    return this.db
      .prepare(`DELETE FROM messages WHERE account_id = ? AND rowid IN (${placeholders})`)
      .run(this.accountId, ...rowIds).changes
  }

  async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const normalized = getMessageKey(key)
    if (!normalized) return undefined
    const row = this.db
      .prepare(
        `SELECT value AS data, updated_at
         FROM messages
         WHERE account_id = ? AND remote_jid = ? AND message_id = ?`,
      )
      .get(this.accountId, normalized.jid, normalized.id) as StoredMessageRow | undefined
    if (!row) return undefined
    const updatedAt = Date.parse(row.updated_at)
    if (!Number.isFinite(updatedAt) || updatedAt <= Date.now() - this.messageCacheTtlMs) {
      this.db
        .prepare('DELETE FROM messages WHERE account_id = ? AND remote_jid = ? AND message_id = ?')
        .run(this.accountId, normalized.jid, normalized.id)
      return undefined
    }
    return parseValue<proto.IMessage>(row.data)
  }

  close(): void {
    clearInterval(this.messagePruneTimer)
    if (this.db.open) this.db.close()
  }
}
