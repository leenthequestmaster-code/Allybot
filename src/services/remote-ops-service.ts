import type { Logger } from 'pino'
import type { Service, ServiceContext, CoreMessage, WhatsAppPort } from '../framework/contracts.js'
import { initSqliteDatabase, requireDatabase, type DatabaseInstance } from '../storage-helpers.js'
import { isGroupJid } from '../framework/validation.js'

export interface RemoteInspectSession {
  readonly groupJid: string
  readonly groupName: string
  readonly filterMode: 'all' | 'cmd' | 'mention'
  readonly ownerJid: string
  readonly startedAt: number
  readonly expiresAt: number
  readonly forwardedCount: number
}

export class RemoteOpsService implements Service {
  readonly name = 'remote-ops'
  private db?: DatabaseInstance

  constructor(
    private readonly databasePath: string,
    private readonly logger: Logger,
    private readonly defaultOwnerJid?: string,
    private readonly whatsapp?: WhatsAppPort,
  ) {}

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    this.logger.info({ component: 'remote-ops' }, 'RemoteOpsService initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
  }

  private database(): DatabaseInstance {
    return requireDatabase(this.db, 'remote-ops')
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_ooc_hub INTEGER NOT NULL DEFAULT 0,
        remote_silenced INTEGER NOT NULL DEFAULT 0,
        sniff_once INTEGER NOT NULL DEFAULT 0,
        member_count INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        added_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS remote_inspect_sessions (
        group_jid TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        filter_mode TEXT NOT NULL DEFAULT 'all',
        owner_jid TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        forwarded_count INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  public startInspect(
    groupJid: string,
    groupName: string,
    filterMode: 'all' | 'cmd' | 'mention',
    ownerJid: string,
    durationSec: number = 3600,
  ): RemoteInspectSession {
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + durationSec

    db.prepare(`
      INSERT INTO remote_inspect_sessions (group_jid, group_name, filter_mode, owner_jid, started_at, expires_at, forwarded_count)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(group_jid) DO UPDATE SET
        group_name = excluded.group_name,
        filter_mode = excluded.filter_mode,
        owner_jid = excluded.owner_jid,
        started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        forwarded_count = 0
    `).run(groupJid, groupName, filterMode, ownerJid, now, expiresAt)

    return {
      groupJid,
      groupName,
      filterMode,
      ownerJid,
      startedAt: now,
      expiresAt,
      forwardedCount: 0,
    }
  }

  public stopInspect(groupJid: string): boolean {
    const db = this.database()
    const result = db.prepare('DELETE FROM remote_inspect_sessions WHERE group_jid = ?').run(groupJid)
    return result.changes > 0
  }

  public listActiveInspectSessions(): RemoteInspectSession[] {
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)
    const rows = db.prepare(`
      SELECT group_jid, group_name, filter_mode, owner_jid, started_at, expires_at, forwarded_count
      FROM remote_inspect_sessions
      WHERE expires_at > ?
      ORDER BY started_at DESC
    `).all(now) as Array<{
      group_jid: string
      group_name: string
      filter_mode: 'all' | 'cmd' | 'mention'
      owner_jid: string
      started_at: number
      expires_at: number
      forwarded_count: number
    }>

    return rows.map((r) => ({
      groupJid: r.group_jid,
      groupName: r.group_name,
      filterMode: r.filter_mode,
      ownerJid: r.owner_jid,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      forwardedCount: r.forwarded_count,
    }))
  }

  public getActiveInspect(groupJid: string): RemoteInspectSession | undefined {
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)
    const row = db.prepare(`
      SELECT group_jid, group_name, filter_mode, owner_jid, started_at, expires_at, forwarded_count
      FROM remote_inspect_sessions
      WHERE group_jid = ? AND expires_at > ?
    `).get(groupJid, now) as {
      group_jid: string
      group_name: string
      filter_mode: 'all' | 'cmd' | 'mention'
      owner_jid: string
      started_at: number
      expires_at: number
      forwarded_count: number
    } | undefined

    if (!row) return undefined
    return {
      groupJid: row.group_jid,
      groupName: row.group_name,
      filterMode: row.filter_mode,
      ownerJid: row.owner_jid,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      forwardedCount: row.forwarded_count,
    }
  }

  public toggleSniffOnce(groupJid: string, enable?: boolean): boolean {
    const db = this.database()
    if (enable === undefined) {
      const row = db.prepare('SELECT sniff_once FROM community_groups WHERE jid = ?').get(groupJid) as { sniff_once: number } | undefined
      const next = row && row.sniff_once === 1 ? 0 : 1
      db.prepare(`
        INSERT INTO community_groups (jid, name, sniff_once, added_at, added_by, updated_at)
        VALUES (?, ?, ?, unixepoch(), 'remote-ops', unixepoch())
        ON CONFLICT(jid) DO UPDATE SET sniff_once = excluded.sniff_once, updated_at = unixepoch()
      `).run(groupJid, groupJid, next)
      return next === 1
    }
    const val = enable ? 1 : 0
    db.prepare(`
      INSERT INTO community_groups (jid, name, sniff_once, added_at, added_by, updated_at)
      VALUES (?, ?, ?, unixepoch(), 'remote-ops', unixepoch())
      ON CONFLICT(jid) DO UPDATE SET sniff_once = excluded.sniff_once, updated_at = unixepoch()
    `).run(groupJid, groupJid, val)
    return enable
  }

  public isSniffOnceActive(groupJid: string): boolean {
    const db = this.database()
    const row = db.prepare('SELECT sniff_once FROM community_groups WHERE jid = ?').get(groupJid) as { sniff_once: number } | undefined
    return row?.sniff_once === 1
  }

  public async handleIncomingMessage(message: CoreMessage, whatsapp?: WhatsAppPort): Promise<void> {
    const wa = whatsapp ?? this.whatsapp
    if (!wa) return
    if (message.fromMe || !isGroupJid(message.remoteJid)) return

    const groupJid = message.remoteJid
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)

    // Check active inspect
    const session = db.prepare(`
      SELECT group_jid, group_name, filter_mode, owner_jid, started_at, expires_at, forwarded_count
      FROM remote_inspect_sessions
      WHERE group_jid = ? AND expires_at > ?
    `).get(groupJid, now) as {
      group_jid: string
      group_name: string
      filter_mode: 'all' | 'cmd' | 'mention'
      owner_jid: string
      started_at: number
      expires_at: number
      forwarded_count: number
    } | undefined

    const text = message.text?.trim() ?? ''
    const isCommand = text.startsWith('!')
    const isMention = message.mentionedJids && wa.userJid
      ? message.mentionedJids.some((m) => m.split(':')[0] === wa.userJid?.split(':')[0])
      : false

    if (session) {
      let shouldForward = false
      if (session.filter_mode === 'all') shouldForward = true
      else if (session.filter_mode === 'cmd' && isCommand) shouldForward = true
      else if (session.filter_mode === 'mention' && isMention) shouldForward = true

      if (shouldForward) {
        db.prepare('UPDATE remote_inspect_sessions SET forwarded_count = forwarded_count + 1 WHERE group_jid = ?').run(groupJid)
        const sender = message.senderJid ? message.senderJid.split(':')[0] : 'unknown'
        const senderName = message.pushName || 'Anon'
        const content = text || (message.media ? `[${message.media.kind}]` : '[non-text]')

        const payload = [
          `🕵️ *[INSPECT: ${session.group_name}]*`,
          `👤 *Pengirim*: ${senderName} (\`${sender}\`)`,
          `💬 *Pesan*: ${content}`,
        ].join('\n')

        try {
          await wa.sendText(session.owner_jid, payload)
        } catch (err) {
          this.logger.debug({ groupJid, err }, 'failed forwarding inspect message')
        }
      }
    }

    // Check sniff_once
    const groupRow = db.prepare('SELECT name, sniff_once FROM community_groups WHERE jid = ?').get(groupJid) as {
      name: string
      sniff_once: number
    } | undefined

    if (groupRow && groupRow.sniff_once === 1) {
      // Consume sniff_once
      db.prepare('UPDATE community_groups SET sniff_once = 0, updated_at = unixepoch() WHERE jid = ?').run(groupJid)
      const targetOwner = session?.owner_jid || this.defaultOwnerJid
      if (targetOwner) {
        const sender = message.senderJid ? message.senderJid.split(':')[0] : 'unknown'
        const senderName = message.pushName || 'Anon'
        const content = text || (message.media ? `[${message.media.kind}]` : '[non-text]')

        const payload = [
          `👃 *[SNIFF ONCE: ${groupRow.name || groupJid}]*`,
          `👤 *Pengirim*: ${senderName} (\`${sender}\`)`,
          `💬 *Pesan*: ${content}`,
          '⚡ _Sniff-once otomatis nonaktif._',
        ].join('\n')

        try {
          await wa.sendText(targetOwner, payload)
        } catch (err) {
          this.logger.debug({ groupJid, err }, 'failed forwarding sniff_once message')
        }
      }
    }
  }

  public peekGroupMessages(groupJid: string, limit: number = 5): Array<{
    senderJid: string
    pushName?: string
    text: string
    timestamp: number
  }> {
    const db = this.database()
    const clamped = Math.max(1, Math.min(25, limit))
    try {
      const rows = db.prepare(`
        SELECT value, timestamp
        FROM messages
        WHERE remote_jid = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(groupJid, clamped) as Array<{ value: string; timestamp: number }>

      const results: Array<{ senderJid: string; pushName?: string; text: string; timestamp: number }> = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value)
          const senderJid = parsed.key?.participant || parsed.key?.remoteJid || 'unknown'
          const pushName = parsed.pushName
          const text = parsed.message?.conversation ||
                       parsed.message?.extendedTextMessage?.text ||
                       (parsed.message ? Object.keys(parsed.message)[0] : '')
          results.push({ senderJid, pushName, text: text || '[non-text]', timestamp: row.timestamp })
        } catch {
          results.push({ senderJid: 'unknown', text: '[unparseable]', timestamp: row.timestamp })
        }
      }
      return results
    } catch {
      return []
    }
  }

  public async broadcastThrottled(
    whatsapp: WhatsAppPort | undefined,
    targetJids: readonly string[],
    text: string,
    delayMs: number = 2500,
  ): Promise<{ total: number; sent: number; failed: number }> {
    const wa = whatsapp ?? this.whatsapp
    if (!wa) throw new Error("WhatsApp connection not available for broadcast")
    let sent = 0
    let failed = 0

    for (let i = 0; i < targetJids.length; i++) {
      const jid = targetJids[i]
      try {
        await wa.sendText(jid, text)
        sent++
      } catch (err) {
        this.logger.warn({ targetJid: jid, err }, 'broadcast send failure')
        failed++
      }
      if (i < targetJids.length - 1) {
        const jitter = Math.floor(Math.random() * 500)
        await new Promise((resolve) => setTimeout(resolve, delayMs + jitter))
      }
    }

    return { total: targetJids.length, sent, failed }
  }
}
