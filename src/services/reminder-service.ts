/**
 * @module reminder-service
 * Persistent Reminder Service for Allybot using SQLite.
 * Manages timed user alerts, background dispatch loop, and notification delivery.
 */

import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppPort } from '../framework/contracts.js'
import { formatWibDateTime } from './natural-time.js'

export interface UserReminder {
  readonly id: string
  readonly userJid: string
  readonly targetJid: string
  readonly reminderText: string
  readonly dueAt: number
  readonly createdAt: number
  readonly status: 'pending' | 'delivered' | 'cancelled'
}

export class ReminderService implements Service {
  readonly name = 'reminder'
  private db: Database.Database | null = null
  private pollerTimer: NodeJS.Timeout | null = null
  private isProcessing = false

  constructor(
    private readonly databasePath: string,
    private readonly whatsapp: WhatsAppPort,
    private readonly logger?: Logger,
    private readonly pollIntervalMs = 15_000,
  ) {}

  initialize(_context?: ServiceContext): void {
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.ensureSchema()
    this.startPoller()
    this.logger?.info('ReminderService initialized successfully')
  }

  shutdown(_context?: ServiceContext): void {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer)
      this.pollerTimer = null
    }
    if (this.db) {
      try {
        this.db.close()
      } catch {}
      this.db = null
    }
    this.logger?.info('ReminderService shut down cleanly')
  }

  private ensureSchema(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_reminders (
        id TEXT PRIMARY KEY,
        user_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        reminder_text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_user_reminders_status_due ON user_reminders(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_user_reminders_user_status ON user_reminders(user_jid, status);
    `)
  }

  createReminder(
    userJid: string,
    targetJid: string,
    reminderText: string,
    dueAt: number,
  ): UserReminder {
    if (!this.db) throw new Error('ReminderService database is not initialized')
    const id = `rem_${randomUUID().slice(0, 8)}`
    const createdAt = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO user_reminders (id, user_jid, target_jid, reminder_text, due_at, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `)
    stmt.run(id, userJid, targetJid, reminderText.trim(), dueAt, createdAt)
    return {
      id,
      userJid,
      targetJid,
      reminderText: reminderText.trim(),
      dueAt,
      createdAt,
      status: 'pending',
    }
  }

  listPending(userJid: string): readonly UserReminder[] {
    if (!this.db) return []
    const stmt = this.db.prepare(`
      SELECT id, user_jid as userJid, target_jid as targetJid, reminder_text as reminderText,
             due_at as dueAt, created_at as createdAt, status
      FROM user_reminders
      WHERE user_jid = ? AND status = 'pending'
      ORDER BY due_at ASC
      LIMIT 20
    `)
    return stmt.all(userJid) as UserReminder[]
  }

  cancelReminder(id: string, userJid: string): boolean {
    if (!this.db) return false
    const stmt = this.db.prepare(`
      UPDATE user_reminders
      SET status = 'cancelled'
      WHERE id = ? AND user_jid = ? AND status = 'pending'
    `)
    const res = stmt.run(id, userJid)
    return res.changes > 0
  }

  private startPoller(): void {
    if (this.pollerTimer) clearInterval(this.pollerTimer)
    this.pollerTimer = setInterval(() => {
      void this.checkAndDispatchDueReminders()
    }, this.pollIntervalMs)
    this.pollerTimer.unref?.()
  }

  async checkAndDispatchDueReminders(): Promise<number> {
    if (!this.db || this.isProcessing) return 0
    this.isProcessing = true
    let dispatched = 0
    try {
      const now = Date.now()
      const stmt = this.db.prepare(`
        SELECT id, user_jid as userJid, target_jid as targetJid, reminder_text as reminderText,
               due_at as dueAt, created_at as createdAt, status
        FROM user_reminders
        WHERE status = 'pending' AND due_at <= ?
        ORDER BY due_at ASC
        LIMIT 10
      `)
      const dueList = stmt.all(now) as UserReminder[]

      for (const item of dueList) {
        try {
          const userTag = `@${item.userJid.split('@')[0]}`
          const createdStr = formatWibDateTime(new Date(item.createdAt))
          const message = [
            `⏰ *PENGINGAT WAKTU TIBA!*`,
            ``,
            `Halo ${userTag}, ini pengingat yang kamu atur:`,
            `> "${item.reminderText}"`,
            ``,
            `_Diatur pada: ${createdStr}_`,
          ].join('\n')

          await this.whatsapp.sendText(item.targetJid, message, {
            mentions: [item.userJid],
          })

          const updateStmt = this.db.prepare(`
            UPDATE user_reminders SET status = 'delivered' WHERE id = ?
          `)
          updateStmt.run(item.id)
          dispatched++
        } catch (sendErr) {
          this.logger?.warn({ err: sendErr, reminderId: item.id }, 'failed delivering due reminder')
        }
      }
    } finally {
      this.isProcessing = false
    }
    return dispatched
  }
}
