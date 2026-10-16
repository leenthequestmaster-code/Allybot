import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { Logger } from 'pino'
import sharp from 'sharp'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { bareJid, isSameJid } from '../permissions.js'
import type { RedisService } from '../redis.js'
import { initSqliteDatabase, requireDatabase, type DatabaseInstance } from '../storage-helpers.js'

export interface MenfessThreadRecord {
  readonly threadId: string
  readonly senderHmac: string
  readonly receiverHmac: string
  readonly encryptedSender: string
  readonly encryptedReceiver: string
  readonly status: 'active' | 'closed' | 'blocked'
  readonly messageCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ActiveMenfessSession {
  readonly threadId: string
  readonly role: 'sender' | 'receiver'
  readonly peerHmac: string
  readonly createdAt: number
}

export interface CreateThreadResult {
  readonly success: boolean
  readonly thread?: MenfessThreadRecord
  readonly reason?:
    | 'RATE_LIMITED'
    | 'RECIPIENT_BLOCKED'
    | 'RECIPIENT_OPTED_OUT'
    | 'SENDER_OPTED_OUT'
    | 'SENDER_BUSY'
    | 'RECIPIENT_BUSY'
    | 'SELF_TARGET'
    | 'INVALID_TARGET'
  readonly remainingDailyQuota?: number
}

export interface MenfessServiceOptions {
  readonly secret: string
  readonly clock?: () => number
  readonly maxPerDay?: number
  readonly sessionTtlSeconds?: number
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateThreadId(): string {
  const bytes = randomBytes(5)
  let id = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      id += CROCKFORD_ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  return `MF-${id}`
}

export class MenfessCrypto {
  private readonly encKey: Buffer
  private readonly hmacKey: Buffer

  constructor(secret: string) {
    this.encKey = createHmac('sha256', secret).update('allybot:menfess:enc:v1').digest()
    this.hmacKey = createHmac('sha256', secret).update('allybot:menfess:hmac:v1').digest()
  }

  hashJid(jid: string): string {
    const normalized = bareJid(jid)
    return createHmac('sha256', this.hmacKey).update(normalized).digest('hex')
  }

  encryptJid(jid: string): string {
    const normalized = bareJid(jid)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv)
    const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
  }

  decryptJid(payload: string): string {
    const parts = payload.split(':')
    if (parts.length !== 3) throw new Error('Invalid encrypted JID payload')
    const [ivHex, tagHex, dataHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return decrypted.toString('utf8')
  }
}

export const MENFESS_DEFAULT_MAX_PER_DAY = 5
export const MENFESS_DEFAULT_SESSION_TTL_SECONDS = 86_400 // 24 hours

export class MenfessService implements Service {
  readonly name = 'menfess'

  private db: DatabaseInstance | undefined
  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxPerDay: number
  private readonly sessionTtlSeconds: number
  readonly crypto: MenfessCrypto

  private redis: RedisService | undefined

  private readonly memorySessions = new Map<string, ActiveMenfessSession>()
  private readonly memoryThreads = new Map<string, { senderJid: string; receiverJid: string; status: 'active' | 'closed' | 'blocked' }>()

  constructor(
    databasePath: string,
    private readonly logger: Logger,
    options: MenfessServiceOptions,
  ) {
    this.databasePath = databasePath
    if (!options.secret) {
      throw new Error('MenfessService requires an explicit secret key for zero-knowledge encryption')
    }
    this.clock = options.clock ?? (() => Date.now())
    this.maxPerDay = options.maxPerDay ?? MENFESS_DEFAULT_MAX_PER_DAY
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? MENFESS_DEFAULT_SESSION_TTL_SECONDS
    this.crypto = new MenfessCrypto(options.secret)
  }

  initialize(context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()

    try {
      this.redis = context.services.get<RedisService>('redis')
    } catch {
      this.redis = undefined
    }

    this.rehydrateActiveSessions()

    this.logger.info(
      { component: 'menfess', activeSessions: this.memorySessions.size, redisConfigured: Boolean(this.redis) },
      'Menfess service initialized',
    )
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
    this.memorySessions.clear()
    this.memoryThreads.clear()
  }

  private database(): DatabaseInstance {
    return requireDatabase(this.db, 'Menfess')
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS menfess_threads (
        thread_id TEXT PRIMARY KEY,
        sender_hmac TEXT NOT NULL,
        receiver_hmac TEXT NOT NULL,
        encrypted_sender TEXT NOT NULL,
        encrypted_receiver TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        message_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_menfess_threads_sender ON menfess_threads(sender_hmac);
      CREATE INDEX IF NOT EXISTS idx_menfess_threads_receiver ON menfess_threads(receiver_hmac);
      CREATE INDEX IF NOT EXISTS idx_menfess_threads_status ON menfess_threads(status);

      CREATE TABLE IF NOT EXISTS menfess_blacklist (
        receiver_hmac TEXT NOT NULL,
        blocked_sender_hmac TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (receiver_hmac, blocked_sender_hmac)
      );

      CREATE TABLE IF NOT EXISTS menfess_optouts (
        recipient_hmac TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `)
  }

  private rehydrateActiveSessions(): void {
    const db = this.database()
    const activeCutoff = this.clock() - this.sessionTtlSeconds * 1_000
    const rows = db
      .prepare(
        'SELECT thread_id, encrypted_sender, encrypted_receiver, sender_hmac, receiver_hmac, created_at, status FROM menfess_threads WHERE status = ? AND updated_at >= ?',
      )
      .all('active', activeCutoff) as Array<{
        thread_id: string
        encrypted_sender: string
        encrypted_receiver: string
        sender_hmac: string
        receiver_hmac: string
        created_at: number
        status: 'active' | 'closed' | 'blocked'
      }>

    for (const row of rows) {
      try {
        const senderJid = this.crypto.decryptJid(row.encrypted_sender)
        const receiverJid = this.crypto.decryptJid(row.encrypted_receiver)

        this.memorySessions.set(senderJid, {
          threadId: row.thread_id,
          role: 'sender',
          peerHmac: row.receiver_hmac,
          createdAt: row.created_at,
        })
        this.memorySessions.set(receiverJid, {
          threadId: row.thread_id,
          role: 'receiver',
          peerHmac: row.sender_hmac,
          createdAt: row.created_at,
        })
        this.memoryThreads.set(row.thread_id, {
          senderJid,
          receiverJid,
          status: row.status,
        })
      } catch (error) {
        this.logger.warn({ error, threadId: row.thread_id }, 'Failed to rehydrate menfess thread')
      }
    }
  }

  async isOptedOut(jid: string): Promise<boolean> {
    const clean = bareJid(jid)
    const hmac = this.crypto.hashJid(clean)

    if (this.redis) {
      try {
        const cached = await this.redis.cacheGet<boolean>('menfess:optout', hmac)
        if (cached !== null && cached !== undefined) {
          return Boolean(cached)
        }
      } catch {
        // Fall back to sqlite
      }
    }

    const db = this.database()
    const row = db
      .prepare('SELECT 1 FROM menfess_optouts WHERE recipient_hmac = ? LIMIT 1')
      .get(hmac)
    const optedOut = Boolean(row)

    if (this.redis) {
      try {
        await this.redis.cacheSet('menfess:optout', hmac, optedOut, 7 * 86_400)
      } catch {
        // Non-blocking
      }
    }

    return optedOut
  }

  async setOptOut(
    jid: string,
    optOut: boolean,
  ): Promise<{ optedOut: boolean; closedThreadId?: string; peerJid?: string }> {
    const clean = bareJid(jid)
    const hmac = this.crypto.hashJid(clean)
    const db = this.database()
    const now = this.clock()

    let closedThreadId: string | undefined
    let peerJid: string | undefined

    if (optOut) {
      const activeSession = await this.getActiveSession(clean)
      if (activeSession) {
        const closeRes = await this.closeThread(clean)
        if (closeRes.closed) {
          closedThreadId = closeRes.threadId
          peerJid = closeRes.peerJid
        }
      }

      db.prepare(`
        INSERT OR IGNORE INTO menfess_optouts (recipient_hmac, created_at)
        VALUES (?, ?)
      `).run(hmac, now)

      if (this.redis) {
        try {
          await this.redis.cacheSet('menfess:optout', hmac, true, 7 * 86_400)
        } catch {
          // Non-blocking
        }
      }
      return { optedOut: true, closedThreadId, peerJid }
    } else {
      db.prepare('DELETE FROM menfess_optouts WHERE recipient_hmac = ?').run(hmac)

      if (this.redis) {
        try {
          await this.redis.cacheDelete('menfess:optout', hmac)
        } catch {
          // Non-blocking
        }
      }
      return { optedOut: false }
    }
  }

  async checkRateLimit(senderJid: string): Promise<{ allowed: boolean; remaining: number }> {
    const senderHmac = this.crypto.hashJid(senderJid)
    const windowStart = this.clock() - 24 * 60 * 60 * 1_000

    const db = this.database()
    const row = db
      .prepare('SELECT count(*) as count FROM menfess_threads WHERE sender_hmac = ? AND created_at >= ?')
      .get(senderHmac, windowStart) as { count: number } | undefined

    const count = row?.count ?? 0
    const allowed = count < this.maxPerDay
    const remaining = Math.max(0, this.maxPerDay - count)
    return { allowed, remaining }
  }

  isBlacklisted(receiverJid: string, senderJid: string): boolean {
    const receiverHmac = this.crypto.hashJid(receiverJid)
    const senderHmac = this.crypto.hashJid(senderJid)

    const db = this.database()
    const row = db
      .prepare('SELECT 1 FROM menfess_blacklist WHERE receiver_hmac = ? AND blocked_sender_hmac = ? LIMIT 1')
      .get(receiverHmac, senderHmac)
    return Boolean(row)
  }

  async getActiveSession(jid: string): Promise<ActiveMenfessSession | undefined> {
    const bare = bareJid(jid)
    if (this.redis) {
      try {
        const cached = await this.redis.cacheGet<ActiveMenfessSession>('menfess:active', bare)
        if (cached) {
          return cached
        }
      } catch {
        // Fall back to memory
      }
    }

    const mem = this.memorySessions.get(bare)
    if (mem) {
      const isExpired = this.clock() - mem.createdAt > this.sessionTtlSeconds * 1_000
      if (isExpired) {
        this.memorySessions.delete(bare)
        return undefined
      }
      return mem
    }

    const hmac = this.crypto.hashJid(bare)
    const activeCutoff = this.clock() - this.sessionTtlSeconds * 1_000
    const db = this.database()
    const row = db
      .prepare(
        'SELECT thread_id, sender_hmac, receiver_hmac, encrypted_sender, encrypted_receiver, status, created_at FROM menfess_threads WHERE (sender_hmac = ? OR receiver_hmac = ?) AND status = ? AND updated_at >= ? LIMIT 1',
      )
      .get(hmac, hmac, 'active', activeCutoff) as {
        thread_id: string
        sender_hmac: string
        receiver_hmac: string
        encrypted_sender: string
        encrypted_receiver: string
        status: 'active' | 'closed' | 'blocked'
        created_at: number
      } | undefined

    if (row) {
      const isSender = row.sender_hmac === hmac
      const session: ActiveMenfessSession = {
        threadId: row.thread_id,
        role: isSender ? 'sender' : 'receiver',
        peerHmac: isSender ? row.receiver_hmac : row.sender_hmac,
        createdAt: row.created_at,
      }
      this.memorySessions.set(bare, session)
      return session
    }

    return undefined
  }

  async createThread(senderJid: string, receiverJid: string): Promise<CreateThreadResult> {
    const cleanSender = bareJid(senderJid)
    const cleanReceiver = bareJid(receiverJid)

    if (!cleanSender || !cleanReceiver) {
      return { success: false, reason: 'INVALID_TARGET' }
    }
    if (cleanSender === cleanReceiver) {
      return { success: false, reason: 'SELF_TARGET' }
    }

    if (await this.isOptedOut(cleanSender)) {
      return { success: false, reason: 'SENDER_OPTED_OUT' }
    }

    if (await this.isOptedOut(cleanReceiver)) {
      return { success: false, reason: 'RECIPIENT_OPTED_OUT' }
    }

    if (this.isBlacklisted(cleanReceiver, cleanSender)) {
      return { success: false, reason: 'RECIPIENT_BLOCKED' }
    }

    const rate = await this.checkRateLimit(cleanSender)
    if (!rate.allowed) {
      return { success: false, reason: 'RATE_LIMITED', remainingDailyQuota: 0 }
    }

    const senderActive = await this.getActiveSession(cleanSender)
    if (senderActive) {
      return { success: false, reason: 'SENDER_BUSY' }
    }

    const receiverActive = await this.getActiveSession(cleanReceiver)
    if (receiverActive) {
      return { success: false, reason: 'RECIPIENT_BUSY' }
    }

    const threadId = generateThreadId()
    const senderHmac = this.crypto.hashJid(cleanSender)
    const receiverHmac = this.crypto.hashJid(cleanReceiver)
    const encryptedSender = this.crypto.encryptJid(cleanSender)
    const encryptedReceiver = this.crypto.encryptJid(cleanReceiver)
    const now = this.clock()

    const db = this.database()
    db.prepare(`
      INSERT INTO menfess_threads (
        thread_id, sender_hmac, receiver_hmac, encrypted_sender, encrypted_receiver, status, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
    `).run(threadId, senderHmac, receiverHmac, encryptedSender, encryptedReceiver, now, now)

    const senderSession: ActiveMenfessSession = {
      threadId,
      role: 'sender',
      peerHmac: receiverHmac,
      createdAt: now,
    }
    const receiverSession: ActiveMenfessSession = {
      threadId,
      role: 'receiver',
      peerHmac: senderHmac,
      createdAt: now,
    }

    this.memorySessions.set(cleanSender, senderSession)
    this.memorySessions.set(cleanReceiver, receiverSession)
    this.memoryThreads.set(threadId, {
      senderJid: cleanSender,
      receiverJid: cleanReceiver,
      status: 'active',
    })

    if (this.redis) {
      try {
        await Promise.all([
          this.redis.cacheSet('menfess:active', cleanSender, senderSession, this.sessionTtlSeconds),
          this.redis.cacheSet('menfess:active', cleanReceiver, receiverSession, this.sessionTtlSeconds),
        ])
      } catch (err) {
        this.logger.warn({ err, threadId }, 'Failed to set active sessions in Redis')
      }
    }

    const threadRecord: MenfessThreadRecord = {
      threadId,
      senderHmac,
      receiverHmac,
      encryptedSender,
      encryptedReceiver,
      status: 'active',
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    }

    return {
      success: true,
      thread: threadRecord,
      remainingDailyQuota: rate.remaining - 1,
    }
  }

  async getPeerJid(threadId: string, currentJid: string): Promise<string | undefined> {
    const cleanCurrent = bareJid(currentJid)

    const cached = this.memoryThreads.get(threadId)
    if (cached) {
      if (cached.senderJid === cleanCurrent) return cached.receiverJid
      if (cached.receiverJid === cleanCurrent) return cached.senderJid
    }

    const db = this.database()
    const row = db
      .prepare('SELECT encrypted_sender, encrypted_receiver, status FROM menfess_threads WHERE thread_id = ?')
      .get(threadId) as { encrypted_sender: string; encrypted_receiver: string; status: string } | undefined

    if (!row || row.status !== 'active') return undefined

    const senderJid = this.crypto.decryptJid(row.encrypted_sender)
    const receiverJid = this.crypto.decryptJid(row.encrypted_receiver)

    this.memoryThreads.set(threadId, {
      senderJid,
      receiverJid,
      status: 'active',
    })

    if (senderJid === cleanCurrent) return receiverJid
    if (receiverJid === cleanCurrent) return senderJid
    return undefined
  }

  async recordMessage(threadId: string, senderJid: string, receiverJid: string): Promise<void> {
    const now = this.clock()
    const db = this.database()
    db.prepare('UPDATE menfess_threads SET message_count = message_count + 1, updated_at = ? WHERE thread_id = ?').run(
      now,
      threadId,
    )

    if (this.redis) {
      try {
        const cleanSender = bareJid(senderJid)
        const cleanReceiver = bareJid(receiverJid)
        const senderSession = await this.getActiveSession(cleanSender)
        const receiverSession = await this.getActiveSession(cleanReceiver)
        if (senderSession) {
          await this.redis.cacheSet('menfess:active', cleanSender, senderSession, this.sessionTtlSeconds)
        }
        if (receiverSession) {
          await this.redis.cacheSet('menfess:active', cleanReceiver, receiverSession, this.sessionTtlSeconds)
        }
      } catch (err) {
        this.logger.debug({ err, threadId }, 'Failed to refresh Redis TTL for menfess')
      }
    }
  }

  getRecentlyClosedThread(
    jid: string,
    windowMs = 3_600_000,
  ): { threadId: string; role: 'sender' | 'receiver'; updatedAt: number; isBlocked: boolean } | undefined {
    const clean = bareJid(jid)
    const hmac = this.crypto.hashJid(clean)
    const cutoff = this.clock() - windowMs
    const db = this.database()
    const row = db
      .prepare(
        "SELECT thread_id, sender_hmac, status, updated_at FROM menfess_threads WHERE (sender_hmac = ? OR receiver_hmac = ?) AND status IN ('closed', 'blocked') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(hmac, hmac, cutoff) as { thread_id: string; sender_hmac: string; status: string; updated_at: number } | undefined

    if (!row) return undefined
    return {
      threadId: row.thread_id,
      role: row.sender_hmac === hmac ? 'sender' : 'receiver',
      updatedAt: row.updated_at,
      isBlocked: row.status === 'blocked',
    }
  }

  async closeThread(
    jid: string,
  ): Promise<{ closed: boolean; threadId?: string; peerJid?: string; initiatorJid?: string }> {
    const clean = bareJid(jid)
    const session = await this.getActiveSession(clean)
    if (!session) return { closed: false }

    const db = this.database()
    const row = db
      .prepare('SELECT encrypted_sender, encrypted_receiver, status FROM menfess_threads WHERE thread_id = ?')
      .get(session.threadId) as { encrypted_sender: string; encrypted_receiver: string; status: string } | undefined

    if (!row) return { closed: false }

    const threadSenderJid = bareJid(this.crypto.decryptJid(row.encrypted_sender))
    const threadReceiverJid = bareJid(this.crypto.decryptJid(row.encrypted_receiver))
    const peerJid = isSameJid(clean, threadSenderJid) ? threadReceiverJid : threadSenderJid

    const now = this.clock()
    db.prepare("UPDATE menfess_threads SET status = 'closed', updated_at = ? WHERE thread_id = ?").run(
      now,
      session.threadId,
    )

    // Complete eviction for BOTH parties
    this.memorySessions.delete(threadSenderJid)
    this.memorySessions.delete(threadReceiverJid)
    this.memorySessions.delete(clean)
    if (peerJid) {
      this.memorySessions.delete(peerJid)
    }
    this.memoryThreads.delete(session.threadId)

    if (this.redis) {
      try {
        await Promise.all([
          this.redis.cacheDelete('menfess:active', threadSenderJid),
          this.redis.cacheDelete('menfess:active', threadReceiverJid),
          this.redis.cacheDelete('menfess:active', clean),
          ...(peerJid ? [this.redis.cacheDelete('menfess:active', peerJid)] : []),
        ])
      } catch (err) {
        this.logger.debug({ err, threadId: session.threadId }, 'Failed to delete active sessions in Redis')
      }
    }

    return { closed: true, threadId: session.threadId, peerJid, initiatorJid: clean }
  }

  async blockSender(receiverJid: string): Promise<{ blocked: boolean; threadId?: string; peerJid?: string }> {
    const clean = bareJid(receiverJid)
    const session = await this.getActiveSession(clean)
    if (!session || session.role !== 'receiver') {
      return { blocked: false }
    }

    const db = this.database()
    const row = db
      .prepare('SELECT encrypted_sender, encrypted_receiver, status FROM menfess_threads WHERE thread_id = ?')
      .get(session.threadId) as { encrypted_sender: string; encrypted_receiver: string; status: string } | undefined

    if (!row) return { blocked: false }

    const threadSenderJid = bareJid(this.crypto.decryptJid(row.encrypted_sender))
    const threadReceiverJid = bareJid(this.crypto.decryptJid(row.encrypted_receiver))
    const peerJid = isSameJid(clean, threadSenderJid) ? threadReceiverJid : threadSenderJid

    const receiverHmac = this.crypto.hashJid(clean)
    const senderHmac = this.crypto.hashJid(peerJid)
    const now = this.clock()

    db.prepare(`
      INSERT OR IGNORE INTO menfess_blacklist (receiver_hmac, blocked_sender_hmac, created_at)
      VALUES (?, ?, ?)
    `).run(receiverHmac, senderHmac, now)

    db.prepare("UPDATE menfess_threads SET status = 'blocked', updated_at = ? WHERE thread_id = ?").run(
      now,
      session.threadId,
    )

    this.memorySessions.delete(threadSenderJid)
    this.memorySessions.delete(threadReceiverJid)
    this.memorySessions.delete(clean)
    if (peerJid) {
      this.memorySessions.delete(peerJid)
    }
    this.memoryThreads.delete(session.threadId)

    if (this.redis) {
      try {
        await Promise.all([
          this.redis.cacheDelete('menfess:active', threadSenderJid),
          this.redis.cacheDelete('menfess:active', threadReceiverJid),
          this.redis.cacheDelete('menfess:active', clean),
          ...(peerJid ? [this.redis.cacheDelete('menfess:active', peerJid)] : []),
        ])
      } catch (err) {
        this.logger.debug({ err, threadId: session.threadId }, 'Failed to delete active sessions in Redis')
      }
    }

    return { blocked: true, threadId: session.threadId, peerJid }
  }

  async sanitizeImage(buffer: Buffer): Promise<Buffer> {
    return await sharp(buffer)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()
  }
}
