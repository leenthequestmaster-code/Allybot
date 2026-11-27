import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import postgres, { type Sql } from 'postgres'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'

export interface UserMemorySlot {
  readonly slotKey: string
  readonly slotValue: string
  readonly updatedAt: string
}

export interface VaultEntry {
  readonly slug: string
  readonly title: string
  readonly category: string
  readonly content: string
}

export interface EpisodicMemoryItem {
  readonly id: string
  readonly scopeType: string
  readonly summary: string
  readonly importance: number
  readonly createdAt: string
}

export interface ArchiveChatRow {
  readonly groupJid: string
  readonly messageId: string
  readonly senderJid: string
  readonly pushName: string
  readonly text: string
  readonly quotedMessageId?: string
  readonly timestampMs: number
}

export interface AllybotMemoryServiceOptions {
  readonly postgresUrl?: string
  readonly knowledgeDir?: string
  readonly logger?: Logger
}

function canonicalJid(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}

export const ALLOWED_AGENT_USER_SLOTS = new Set([
  'nickname',
  'city',
  'timezone',
  'preference',
  'hobby',
  'character_hint',
  'language',
])

const PROMPT_INJECTION_VALUE_REGEX =
  /(?:ignore\s+(?:all\s+)?previous|system\s+prompt|<\/?untrusted_chat_transcript>|assistant:|you\s+are\s+now|override\s+rules)/i

export function isAllowedAgentSlotKey(slotKey: string): boolean {
  const safe = slotKey.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '_')
  return ALLOWED_AGENT_USER_SLOTS.has(safe)
}

export function isSuspiciousMemoryText(value: string): boolean {
  return PROMPT_INJECTION_VALUE_REGEX.test(value)
}

export function hashMemoryKey(value: string): string {
  return createHash('sha256').update(canonicalJid(value)).digest('hex')
}

export class AllybotMemoryService implements Service {
  readonly name = 'allybot-memory'
  private sql: Sql | null = null
  private logger?: Logger
  private readonly postgresUrl?: string
  private readonly knowledgeDir: string
  private schemaReady = false

  constructor(options: AllybotMemoryServiceOptions = {}) {
    this.postgresUrl = options.postgresUrl
    this.knowledgeDir = options.knowledgeDir ?? join(process.cwd(), 'knowledge')
    this.logger = options.logger
  }

  get isEnabled(): boolean {
    return Boolean(this.postgresUrl)
  }

  async initialize(context?: ServiceContext): Promise<void> {
    if (context?.logger) this.logger = context.logger
    if (!this.postgresUrl) {
      this.logger?.info('AllybotMemoryService disabled (POSTGRES_URL not configured)')
      return
    }
    this.sql = postgres(this.postgresUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5,
      onnotice: () => {},
    })
    await this.ensureSchema()
    await this.syncKnowledgeVault()
    this.logger?.info('AllybotMemoryService initialized (schema: allybot_memory)')
  }

  async shutdown(): Promise<void> {
    if (this.sql) {
      try {
        await this.sql.end({ timeout: 3 })
      } catch {
        // ignore close errors on shutdown
      }
      this.sql = null
    }
    this.schemaReady = false
  }

  private async ensureSchema(): Promise<void> {
    if (!this.sql || this.schemaReady) return
    await this.sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS allybot_memory;

      CREATE TABLE IF NOT EXISTS allybot_memory.user_memory_slots (
        sender_key TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        slot_value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'conversation',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (sender_key, slot_key)
      );

      CREATE TABLE IF NOT EXISTS allybot_memory.episodic_memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('dm', 'group', 'global')),
        scope_key TEXT NOT NULL,
        sender_key TEXT,
        summary TEXT NOT NULL,
        importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
        fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary, ''))) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_allybot_episodic_fts ON allybot_memory.episodic_memories USING GIN (fts_vector);
      CREATE INDEX IF NOT EXISTS idx_allybot_episodic_scope ON allybot_memory.episodic_memories (scope_type, scope_key, last_reinforced_at DESC);

      CREATE TABLE IF NOT EXISTS allybot_memory.group_chat_archive (
        id BIGSERIAL PRIMARY KEY,
        group_jid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        push_name TEXT NOT NULL,
        text TEXT NOT NULL,
        quoted_message_id TEXT,
        timestamp_ms BIGINT NOT NULL,
        fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(push_name, '') || ' ' || coalesce(text, ''))) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (group_jid, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_allybot_chat_archive_group_ts ON allybot_memory.group_chat_archive (group_jid, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_allybot_chat_archive_fts ON allybot_memory.group_chat_archive USING GIN (fts_vector);

      CREATE TABLE IF NOT EXISTS allybot_memory.knowledge_vault (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_allybot_vault_fts ON allybot_memory.knowledge_vault USING GIN (fts_vector);

      CREATE TABLE IF NOT EXISTS allybot_memory.wake_corpus (
        id BIGSERIAL PRIMARY KEY,
        group_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        message_text TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_allybot_wake_corpus_created ON allybot_memory.wake_corpus (created_at DESC);

      CREATE TABLE IF NOT EXISTS allybot_memory.moderation_auto_reopen (
        group_jid TEXT PRIMARY KEY,
        reopen_at_ms BIGINT NOT NULL,
        locked_at_ms BIGINT NOT NULL,
        sop_id TEXT NOT NULL,
        reason TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allybot_memory.moderation_lock_cooldown (
        group_jid TEXT PRIMARY KEY,
        last_locked_at_ms BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allybot_memory.consolidation_state (
        scope_key TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('dm', 'group')),
        last_consolidated_ms BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS allybot_memory.faq_candidates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_key TEXT NOT NULL,
        question TEXT NOT NULL,
        answer_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_allybot_faq_candidates_status
        ON allybot_memory.faq_candidates (status, created_at DESC);
    `)
    try {
      await this.sql.unsafe(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX IF NOT EXISTS idx_allybot_episodic_trgm
          ON allybot_memory.episodic_memories USING GIN (summary gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_allybot_vault_trgm
          ON allybot_memory.knowledge_vault USING GIN (content gin_trgm_ops);
      `)
    } catch {
      // pg_trgm optional if DB role lacks extension privilege
    }
    this.schemaReady = true
  }

  async syncKnowledgeVault(): Promise<number> {
    if (!this.sql || !existsSync(this.knowledgeDir)) return 0
    const files = readdirSync(this.knowledgeDir).filter((f) => f.endsWith('.md'))
    let synced = 0
    for (const file of files) {
      const slug = basename(file, '.md')
      const content = readFileSync(join(this.knowledgeDir, file), 'utf8').trim()
      if (!content) continue
      const titleMatch = content.match(/^#\s+(.+)$/m)
      const title = titleMatch?.[1]?.trim() || slug
      const category = slug.includes('sop') || slug.includes('rules') ? 'moderation' : 'guide'
      await this.sql`
        INSERT INTO allybot_memory.knowledge_vault (slug, title, category, content, updated_at)
        VALUES (${slug}, ${title}, ${category}, ${content}, now())
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          content = EXCLUDED.content,
          updated_at = now()
      `
      synced += 1
    }
    return synced
  }

  async getUserSlots(senderJid: string): Promise<readonly UserMemorySlot[]> {
    if (!this.sql) return []
    const senderKey = hashMemoryKey(senderJid)
    const rows = await this.sql`
      SELECT slot_key, slot_value, updated_at
      FROM allybot_memory.user_memory_slots
      WHERE sender_key = ${senderKey}
      ORDER BY updated_at DESC
      LIMIT 15
    `
    return rows.map((r) => ({
      slotKey: String(r.slot_key),
      slotValue: String(r.slot_value),
      updatedAt: new Date(String(r.updated_at)).toISOString(),
    }))
  }

  async setUserSlot(senderJid: string, slotKey: string, slotValue: string, source = 'agent'): Promise<boolean> {
    if (!this.sql) return false
    const safeKey = slotKey.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 40)
    const safeVal = slotValue.trim().slice(0, 300)
    if (!safeKey || !safeVal) return false
    if ((source === 'agent' || source === 'consolidation') && !ALLOWED_AGENT_USER_SLOTS.has(safeKey)) {
      return false
    }
    if (isSuspiciousMemoryText(safeVal)) {
      return false
    }
    const senderKey = hashMemoryKey(senderJid)
    await this.sql`
      INSERT INTO allybot_memory.user_memory_slots (sender_key, slot_key, slot_value, source, updated_at)
      VALUES (${senderKey}, ${safeKey}, ${safeVal}, ${source}, now())
      ON CONFLICT (sender_key, slot_key) DO UPDATE SET
        slot_value = EXCLUDED.slot_value,
        source = EXCLUDED.source,
        updated_at = now()
    `
    return true
  }

  async searchKnowledgeVault(query: string, limit = 3): Promise<readonly VaultEntry[]> {
    const cleanQuery = query.trim()
    if (!this.sql) {
      // Fallback read directly from disk if PG is unavailable (e.g. unit test / offline)
      if (!existsSync(this.knowledgeDir)) return []
      const files = readdirSync(this.knowledgeDir).filter((f) => f.endsWith('.md'))
      const qLower = cleanQuery.toLowerCase()
      return files
        .map((file) => {
          const slug = basename(file, '.md')
          const content = readFileSync(join(this.knowledgeDir, file), 'utf8').trim()
          const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug
          return { slug, title, category: slug.includes('sop') ? 'moderation' : 'guide', content }
        })
        .filter((entry) => !qLower || entry.title.toLowerCase().includes(qLower) || entry.content.toLowerCase().includes(qLower))
        .slice(0, limit)
    }

    if (!cleanQuery) {
      const rows = await this.sql`
        SELECT slug, title, category, content
        FROM allybot_memory.knowledge_vault
        ORDER BY updated_at DESC
        LIMIT ${Math.min(limit, 5)}
      `
      return rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        category: String(r.category),
        content: String(r.content),
      }))
    }

    const rows = await this.sql`
      SELECT slug, title, category, content,
             ts_rank_cd(fts_vector, websearch_to_tsquery('simple', ${cleanQuery})) AS rank
      FROM allybot_memory.knowledge_vault
      WHERE fts_vector @@ websearch_to_tsquery('simple', ${cleanQuery})
         OR content ILIKE ${'%' + cleanQuery.slice(0, 60) + '%'}
      ORDER BY rank DESC, updated_at DESC
      LIMIT ${Math.min(limit, 5)}
    `
    if (rows.length > 0) {
      return rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        category: String(r.category),
        content: String(r.content),
      }))
    }

    const fallbackRows = await this.sql`
      SELECT slug, title, category, content
      FROM allybot_memory.knowledge_vault
      WHERE slug = 'allyssea-canon-guide'
      LIMIT 1
    `
    return fallbackRows.map((r) => ({
      slug: String(r.slug),
      title: String(r.title),
      category: String(r.category),
      content: String(r.content),
    }))
  }

  async searchEpisodic(
    scopeType: 'dm' | 'group',
    scopeJid: string,
    query: string,
    limit = 5,
    senderJid?: string,
  ): Promise<readonly EpisodicMemoryItem[]> {
    if (!this.sql) return []
    const scopeKey = hashMemoryKey(scopeJid)
    const senderKey = senderJid ? hashMemoryKey(senderJid) : null
    const cleanQuery = query.trim().slice(0, 140)
    const cappedLimit = Math.min(Math.max(limit, 1), 10)
    if (!cleanQuery) {
      const rows = await this.sql`
        SELECT id, scope_type, summary, importance, created_at,
               (importance * 0.65
                + EXP(-GREATEST(0, EXTRACT(EPOCH FROM (now() - last_reinforced_at))) / 1209600.0) * 0.25
                + CASE WHEN ${senderKey}::text IS NOT NULL AND sender_key = ${senderKey} THEN 0.15 ELSE 0 END) AS score
        FROM allybot_memory.episodic_memories
        WHERE scope_type = ${scopeType} AND scope_key = ${scopeKey}
        ORDER BY score DESC, last_reinforced_at DESC
        LIMIT ${cappedLimit}
      `
      return rows.map((r) => ({
        id: String(r.id),
        scopeType: String(r.scope_type),
        summary: String(r.summary),
        importance: Number(r.importance),
        createdAt: new Date(String(r.created_at)).toISOString(),
      }))
    }
    const rows = await this.sql`
      SELECT id, scope_type, summary, importance, created_at,
             (COALESCE(ts_rank_cd(fts_vector, websearch_to_tsquery('simple', ${cleanQuery})), 0) * 0.50
              + COALESCE(similarity(summary, ${cleanQuery}), 0) * 0.30
              + importance * 0.35
              + EXP(-GREATEST(0, EXTRACT(EPOCH FROM (now() - last_reinforced_at))) / 1209600.0) * 0.15
              + CASE WHEN ${senderKey}::text IS NOT NULL AND sender_key = ${senderKey} THEN 0.12 ELSE 0 END) AS score
      FROM allybot_memory.episodic_memories
      WHERE scope_type = ${scopeType} AND scope_key = ${scopeKey}
        AND (
          fts_vector @@ websearch_to_tsquery('simple', ${cleanQuery})
          OR summary ILIKE ${'%' + cleanQuery.slice(0, 60) + '%'}
          OR similarity(summary, ${cleanQuery}) > 0.12
        )
      ORDER BY score DESC, last_reinforced_at DESC
      LIMIT ${cappedLimit}
    `
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: String(r.id),
        scopeType: String(r.scope_type),
        summary: String(r.summary),
        importance: Number(r.importance),
        createdAt: new Date(String(r.created_at)).toISOString(),
      }))
    }
    // Fallback to top recent high-importance episodic memories in the SAME scope only
    const fallbackRows = await this.sql`
      SELECT id, scope_type, summary, importance, created_at
      FROM allybot_memory.episodic_memories
      WHERE scope_type = ${scopeType} AND scope_key = ${scopeKey}
      ORDER BY importance DESC, last_reinforced_at DESC
      LIMIT ${Math.min(cappedLimit, 2)}
    `
    return fallbackRows.map((r) => ({
      id: String(r.id),
      scopeType: String(r.scope_type),
      summary: String(r.summary),
      importance: Number(r.importance),
      createdAt: new Date(String(r.created_at)).toISOString(),
    }))
  }

  async saveEpisodicMemory(entry: {
    readonly scopeType: 'dm' | 'group'
    readonly scopeJid: string
    readonly senderJid?: string
    readonly summary: string
    readonly importance?: number
    readonly confidence?: number
  }): Promise<string | undefined> {
    if (!this.sql) return undefined
    if (entry.scopeType !== 'dm' && entry.scopeType !== 'group') {
      throw new Error('Episodic memory from chat must be scoped to dm or group')
    }
    const cleanSummary = entry.summary.trim().slice(0, 1200)
    if (!cleanSummary || isSuspiciousMemoryText(cleanSummary)) return undefined
    const scopeKey = hashMemoryKey(entry.scopeJid)
    const senderKey = entry.senderJid ? hashMemoryKey(entry.senderJid) : null
    const importance = Math.min(1, Math.max(0.1, entry.importance ?? 0.6))
    const confidence = Math.min(1, Math.max(0.1, entry.confidence ?? 0.8))
    const rows = await this.sql`
      INSERT INTO allybot_memory.episodic_memories (scope_type, scope_key, sender_key, summary, importance, confidence)
      VALUES (${entry.scopeType}, ${scopeKey}, ${senderKey}, ${cleanSummary}, ${importance}, ${confidence})
      RETURNING id
    `
    return rows[0]?.id ? String(rows[0].id) : undefined
  }

  async reinforceEpisodicMemory(id: string): Promise<void> {
    if (!this.sql || !id) return
    try {
      await this.sql`
        UPDATE allybot_memory.episodic_memories
        SET last_reinforced_at = now(),
            importance = LEAST(1.0, importance + 0.05)
        WHERE id = ${id}::uuid
      `
    } catch {
      // fail-soft
    }
  }

  async saveFaqCandidate(scopeJid: string, question: string, answerHint: string): Promise<boolean> {
    if (!this.sql) return false
    const q = question.trim().slice(0, 300)
    const a = answerHint.trim().slice(0, 500)
    if (!q || !a || isSuspiciousMemoryText(q) || isSuspiciousMemoryText(a)) return false
    const scopeKey = hashMemoryKey(scopeJid)
    await this.sql`
      INSERT INTO allybot_memory.faq_candidates (scope_key, question, answer_hint, status)
      VALUES (${scopeKey}, ${q}, ${a}, 'pending')
    `
    return true
  }

  async getConsolidationWatermark(scopeKey: string): Promise<number> {
    if (!this.sql) return 0
    const rows = await this.sql`
      SELECT last_consolidated_ms
      FROM allybot_memory.consolidation_state
      WHERE scope_key = ${scopeKey}
      LIMIT 1
    `
    return rows[0] ? Number(rows[0].last_consolidated_ms) : 0
  }

  async setConsolidationWatermark(scopeKey: string, scopeType: 'dm' | 'group', lastConsolidatedMs: number): Promise<void> {
    if (!this.sql) return
    await this.sql`
      INSERT INTO allybot_memory.consolidation_state (scope_key, scope_type, last_consolidated_ms, updated_at)
      VALUES (${scopeKey}, ${scopeType}, ${lastConsolidatedMs}, now())
      ON CONFLICT (scope_key) DO UPDATE SET
        last_consolidated_ms = GREATEST(allybot_memory.consolidation_state.last_consolidated_ms, EXCLUDED.last_consolidated_ms),
        updated_at = now()
    `
  }

  async listArchiveGroups(limit = 20): Promise<readonly string[]> {
    if (!this.sql) return []
    const rows = await this.sql`
      SELECT group_jid
      FROM allybot_memory.group_chat_archive
      GROUP BY group_jid
      ORDER BY MAX(timestamp_ms) DESC
      LIMIT ${Math.min(Math.max(limit, 1), 50)}
    `
    return rows.map((r) => String(r.group_jid))
  }

  async getArchiveMessagesSince(groupJid: string, afterTimestampMs: number, limit = 150): Promise<readonly ArchiveChatRow[]> {
    if (!this.sql) return []
    const capped = Math.min(Math.max(limit, 1), 300)
    const rows = await this.sql`
      SELECT group_jid, message_id, sender_jid, push_name, text, quoted_message_id, timestamp_ms
      FROM allybot_memory.group_chat_archive
      WHERE group_jid = ${groupJid} AND timestamp_ms > ${afterTimestampMs}
      ORDER BY timestamp_ms ASC
      LIMIT ${capped}
    `
    return rows.map((r) => ({
      groupJid: String(r.group_jid),
      messageId: String(r.message_id),
      senderJid: String(r.sender_jid),
      pushName: String(r.push_name),
      text: String(r.text),
      ...(r.quoted_message_id ? { quotedMessageId: String(r.quoted_message_id) } : {}),
      timestampMs: Number(r.timestamp_ms),
    }))
  }

  async recordGroupArchiveMessage(entry: ArchiveChatRow): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql`
        INSERT INTO allybot_memory.group_chat_archive (
          group_jid, message_id, sender_jid, push_name, text, quoted_message_id, timestamp_ms
        ) VALUES (
          ${entry.groupJid},
          ${entry.messageId},
          ${entry.senderJid},
          ${entry.pushName.slice(0, 50)},
          ${entry.text.slice(0, 2000)},
          ${entry.quotedMessageId ?? null},
          ${entry.timestampMs}
        )
        ON CONFLICT (group_jid, message_id) DO NOTHING
      `
    } catch (err) {
      this.logger?.debug({ err: err instanceof Error ? err.message : 'UnknownError' }, 'failed to archive group message to PG')
    }
  }

  async getArchiveMessages(groupJid: string, limit = 200, beforeTimestampMs?: number): Promise<readonly ArchiveChatRow[]> {
    if (!this.sql) return []
    const capped = Math.min(Math.max(limit, 1), 1500)
    const rows = beforeTimestampMs
      ? await this.sql`
          SELECT group_jid, message_id, sender_jid, push_name, text, quoted_message_id, timestamp_ms
          FROM allybot_memory.group_chat_archive
          WHERE group_jid = ${groupJid} AND timestamp_ms < ${beforeTimestampMs}
          ORDER BY timestamp_ms DESC
          LIMIT ${capped}
        `
      : await this.sql`
          SELECT group_jid, message_id, sender_jid, push_name, text, quoted_message_id, timestamp_ms
          FROM allybot_memory.group_chat_archive
          WHERE group_jid = ${groupJid}
          ORDER BY timestamp_ms DESC
          LIMIT ${capped}
        `
    return rows.reverse().map((r) => ({
      groupJid: String(r.group_jid),
      messageId: String(r.message_id),
      senderJid: String(r.sender_jid),
      pushName: String(r.push_name),
      text: String(r.text),
      ...(r.quoted_message_id ? { quotedMessageId: String(r.quoted_message_id) } : {}),
      timestampMs: Number(r.timestamp_ms),
    }))
  }

  async logWakeCorpus(groupJid: string, senderJid: string, messageText: string, decision: string, reason: string): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql`
        INSERT INTO allybot_memory.wake_corpus (group_jid, sender_jid, message_text, decision, reason)
        VALUES (${groupJid}, ${hashMemoryKey(senderJid)}, ${messageText.slice(0, 500)}, ${decision}, ${reason})
      `
    } catch {
      // fail-soft passive logger
    }
  }

  async saveAutoReopenLock(lock: {
    readonly groupJid: string
    readonly reopenAtMs: number
    readonly lockedAtMs: number
    readonly sopId: string
    readonly reason: string
  }): Promise<void> {
    if (!this.sql) return
    await this.sql`
      INSERT INTO allybot_memory.moderation_auto_reopen (group_jid, reopen_at_ms, locked_at_ms, sop_id, reason)
      VALUES (${lock.groupJid}, ${lock.reopenAtMs}, ${lock.lockedAtMs}, ${lock.sopId}, ${lock.reason.slice(0, 300)})
      ON CONFLICT (group_jid) DO UPDATE SET
        reopen_at_ms = EXCLUDED.reopen_at_ms,
        locked_at_ms = EXCLUDED.locked_at_ms,
        sop_id = EXCLUDED.sop_id,
        reason = EXCLUDED.reason
    `
    await this.sql`
      INSERT INTO allybot_memory.moderation_lock_cooldown (group_jid, last_locked_at_ms)
      VALUES (${lock.groupJid}, ${lock.lockedAtMs})
      ON CONFLICT (group_jid) DO UPDATE SET
        last_locked_at_ms = GREATEST(allybot_memory.moderation_lock_cooldown.last_locked_at_ms, EXCLUDED.last_locked_at_ms)
    `
  }

  async deleteAutoReopenLock(groupJid: string): Promise<void> {
    if (!this.sql) return
    await this.sql`
      DELETE FROM allybot_memory.moderation_auto_reopen
      WHERE group_jid = ${groupJid}
    `
  }

  async listAutoReopenLocks(): Promise<readonly {
    readonly groupJid: string
    readonly reopenAtMs: number
    readonly lockedAtMs: number
    readonly sopId: string
    readonly reason: string
  }[]> {
    if (!this.sql) return []
    const rows = await this.sql`
      SELECT group_jid, reopen_at_ms, locked_at_ms, sop_id, reason
      FROM allybot_memory.moderation_auto_reopen
      ORDER BY reopen_at_ms ASC
    `
    return rows.map((r) => ({
      groupJid: String(r.group_jid),
      reopenAtMs: Number(r.reopen_at_ms),
      lockedAtMs: Number(r.locked_at_ms),
      sopId: String(r.sop_id),
      reason: String(r.reason),
    }))
  }

  async getLastLockCooldownMs(groupJid: string): Promise<number | undefined> {
    if (!this.sql) return undefined
    const rows = await this.sql`
      SELECT last_locked_at_ms
      FROM allybot_memory.moderation_lock_cooldown
      WHERE group_jid = ${groupJid}
      LIMIT 1
    `
    if (!rows[0]) return undefined
    return Number(rows[0].last_locked_at_ms)
  }
}
