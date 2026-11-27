import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type { RedisService } from '../redis.js'
import type { Service, ServiceContext, ServiceRegistryLike, WhatsAppPort } from '../framework/contracts.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import { initSqliteDatabase, sha256, validateJid, validateGroupJid as validateGroupJidCommon, normalizeBoundedText, type DatabaseInstance } from '../storage-helpers.js'

export type GroupSafetyMode = 'off' | 'dry-run'
export type WarningStatus = 'active' | 'revoked' | 'expired'
export type ModerationCaseStatus = 'open' | 'claimed' | 'resolved' | 'dismissed' | 'appealed'

export interface GroupSafetyOptions {
  readonly clock?: () => number
  readonly warningTtlMs?: number
  readonly maxReasonLength?: number
  readonly maxListLimit?: number
  readonly spBanDurationMs?: number
  readonly pollIntervalMs?: number
  readonly whatsapp?: WhatsAppPort
  readonly botOwnerJid?: string
  readonly officialOocInviteLink?: string
}

export interface SpStateRecord {
  readonly groupJid: string
  readonly targetBareJid: string
  readonly spLevel: number
  readonly updatedAt: number
}

export interface SpScheduleRecord {
  readonly id: string
  readonly groupJid: string
  readonly targetBareJid: string
  readonly targetJid: string
  readonly spLevel: number
  readonly reason: string
  readonly kickedAt: number
  readonly reentryAt: number
  readonly status: 'scheduled' | 'completed' | 'cancelled' | 'escalated'
  readonly completedAt?: number
  readonly note?: string
}

export interface WarnThresholdResult {
  readonly action: 'below_limit' | 'immune_skip' | 'kicked_sp' | 'escalated_sp3'
  readonly activeCount: number
  readonly limit: number
  readonly spLevel?: number
  readonly reentryAt?: number
  readonly scheduleId?: string
}

export interface SafetySettingsRecord {
  readonly groupJid: string
  readonly mode: GroupSafetyMode
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface WarningRecord {
  readonly id: string
  readonly groupJid: string
  readonly targetJid: string
  readonly issuedBy: string
  readonly reason: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: WarningStatus
  readonly revokedAt?: number
  readonly revokedBy?: string
  readonly revision: number
}

export interface ModerationCaseRecord {
  readonly id: string
  readonly groupJid: string
  readonly reporterJid: string
  readonly targetJid: string
  readonly ruleId: string
  readonly evidenceMessageId?: string
  readonly evidenceHash?: string
  readonly reason: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly status: ModerationCaseStatus
  readonly assignedTo?: string
  readonly resolutionNote?: string
  readonly revision: number
}

export interface AppealRecord {
  readonly id: string
  readonly caseId: string
  readonly appellantJid: string
  readonly reason: string
  readonly createdAt: number
}

export interface CaseReportResult {
  readonly record: ModerationCaseRecord
  readonly created: boolean
}

interface SettingsRow {
  group_jid: string
  mode: GroupSafetyMode
  updated_by: string
  updated_at: number
}

interface WarningRow {
  id: string
  group_jid: string
  target_jid: string
  issued_by: string
  reason: string
  created_at: number
  expires_at: number
  status: 'active' | 'revoked'
  revoked_at: number | null
  revoked_by: string | null
  revision: number
}

interface CaseRow {
  id: string
  group_jid: string
  reporter_jid: string
  target_jid: string
  rule_id: string
  evidence_message_id: string | null
  evidence_hash: string | null
  reason: string
  created_at: number
  updated_at: number
  status: ModerationCaseStatus
  assigned_to: string | null
  resolution_note: string | null
  revision: number
}

interface AppealRow {
  id: string
  case_id: string
  appellant_jid: string
  reason: string
  created_at: number
}

const DEFAULT_WARNING_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_SP_BAN_DURATION_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_SP_POLL_INTERVAL_MS = 30_000
const DEFAULT_MAX_REASON_LENGTH = 240
const DEFAULT_MAX_LIST_LIMIT = 25

function bareSafetyJid(jid: string | undefined): string {
  if (!jid) return ''
  return jid.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}
const MAX_ID_LENGTH = 64
const MAX_EVIDENCE_MESSAGE_ID_LENGTH = 160
const SECRET_LIKE_REASON = /(bearer\s+|^eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$|(?:api[_-]?key|token|password)\s*[:=])/i
const ANTI_SPAM_PROFILE_ID = 'group-safety.spam'
const FEATURE_ID = 'group-safety'

export class GroupSafetyService implements Service {
  readonly name = 'group-safety'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly warningTtlMs: number
  private readonly spBanDurationMs: number
  private readonly pollIntervalMs: number
  private readonly maxReasonLength: number
  private readonly maxListLimit: number
  private readonly logger: Logger
  private db: DatabaseInstance | undefined
  private guardrails: PlatformGuardrailService | undefined
  private redis: RedisService | undefined
  private services: ServiceRegistryLike | undefined
  private whatsapp: WhatsAppPort | undefined
  private botOwnerJid: string | undefined
  private officialOocInviteLink: string | undefined
  private spPollerTimer: NodeJS.Timeout | undefined
  private autoEnforceWarnings = false
  private isRecoveringSp = false
  private readonly dryRunCaseWindows = new Map<string, number>()

  constructor(databasePath: string, logger: Logger, options: GroupSafetyOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.warningTtlMs = options.warningTtlMs ?? DEFAULT_WARNING_TTL_MS
    this.spBanDurationMs = options.spBanDurationMs ?? DEFAULT_SP_BAN_DURATION_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SP_POLL_INTERVAL_MS
    this.maxReasonLength = options.maxReasonLength ?? DEFAULT_MAX_REASON_LENGTH
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.whatsapp = options.whatsapp
    this.botOwnerJid = options.botOwnerJid
    this.officialOocInviteLink = options.officialOocInviteLink
    this.logger = logger.child({ component: 'group-safety' })
    if (!Number.isInteger(this.warningTtlMs) || this.warningTtlMs < 1) throw new Error('warningTtlMs must be a positive integer')
    if (!Number.isInteger(this.maxReasonLength) || this.maxReasonLength < 1) throw new Error('maxReasonLength must be a positive integer')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be a positive integer')
  }

  initialize(context: ServiceContext): void {
    this.services = context.services
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.redis = typeof context.services.has === 'function' && context.services.has('redis')
      ? context.services.get<RedisService>('redis')
      : undefined
    if (context.config?.botOwnerJid) this.botOwnerJid = context.config.botOwnerJid
    if (context.config?.officialOocInviteLink) this.officialOocInviteLink = context.config.officialOocInviteLink
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    this.guardrails.registerRateProfile({ id: ANTI_SPAM_PROFILE_ID, maxRequests: 5, windowMs: 10_000 })
    if (this.whatsapp) {
      this.startSpPoller()
      void this.recoverSpReentries()
    }
    this.logger.info('group safety storage initialized')
  }

  attachRuntime(runtime: {
    readonly whatsapp: WhatsAppPort
    readonly services?: ServiceRegistryLike
    readonly botOwnerJid?: string
    readonly officialOocInviteLink?: string
    readonly autoEnforceWarnings?: boolean
  }): void {
    this.whatsapp = runtime.whatsapp
    if (runtime.services) this.services = runtime.services
    if (runtime.botOwnerJid) this.botOwnerJid = runtime.botOwnerJid
    if (runtime.officialOocInviteLink) this.officialOocInviteLink = runtime.officialOocInviteLink
    if (runtime.autoEnforceWarnings !== undefined) this.autoEnforceWarnings = runtime.autoEnforceWarnings
    if (this.db?.open) {
      this.startSpPoller()
      void this.recoverSpReentries()
    }
  }

  private startSpPoller(): void {
    if (this.spPollerTimer || this.pollIntervalMs <= 0) return
    this.spPollerTimer = setInterval(() => {
      void this.recoverSpReentries()
    }, this.pollIntervalMs)
    this.spPollerTimer.unref()
  }

  shutdown(_context: ServiceContext): void {
    if (this.spPollerTimer) {
      clearInterval(this.spPollerTimer)
      this.spPollerTimer = undefined
    }
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.redis = undefined
    this.services = undefined
    this.dryRunCaseWindows.clear()
  }

  getMode(groupJid: string): SafetySettingsRecord {
    validateGroupJid(groupJid)
    const row = this.database().prepare(`SELECT group_jid, mode, updated_by, updated_at FROM group_safety_settings WHERE group_jid = ?`).get(groupJid) as SettingsRow | undefined
    return row ? mapSettings(row) : { groupJid, mode: 'off', updatedBy: '', updatedAt: 0 }
  }

  isDryRun(groupJid: string): boolean {
    return this.getMode(groupJid).mode === 'dry-run' && this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  setMode(groupJid: string, mode: GroupSafetyMode, actorJid: string, now = this.clock()): SafetySettingsRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'safety actor')
    if (!['off', 'dry-run'].includes(mode)) throw new Error(`Unsupported group safety mode: ${mode}`)
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, mode === 'dry-run', actorJid, `safety-mode-${now}`, now)
    return this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_safety_settings (group_jid, mode, updated_by, updated_at)
        VALUES (@group_jid, @mode, @updated_by, @updated_at)
        ON CONFLICT(group_jid) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run({ group_jid: groupJid, mode, updated_by: actorJid, updated_at: now })
      return this.getMode(groupJid)
    })
  }

  issueWarning(groupJid: string, targetJid: string, issuedBy: string, reason: string, now = this.clock()): WarningRecord {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'warning target')
    validateJid(issuedBy, 'warning issuer')
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const id = randomUUID()
    const expiresAt = now + this.warningTtlMs
    this.audit('group.safety.warning.requested', issuedBy, targetJid, 'allowed', { reasonLength: normalizedReason.length })
    const record = this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_safety_warnings
          (id, group_jid, target_jid, issued_by, reason, created_at, expires_at, status, revision)
        VALUES (@id, @group_jid, @target_jid, @issued_by, @reason, @created_at, @expires_at, 'active', 0)
      `).run({ id, group_jid: groupJid, target_jid: targetJid, issued_by: issuedBy, reason: normalizedReason, created_at: now, expires_at: expiresAt })
      return this.getWarning(id, now) as WarningRecord
    })
    this.auditBestEffort('group.safety.warning.issued', issuedBy, targetJid, 'changed', { warningId: id })
    if (this.autoEnforceWarnings && this.whatsapp && issuedBy !== '__plugin_manual_warn__') {
      const limit = this.resolveWarnLimit(groupJid)
      const activeCount = this.countActiveWarnings(groupJid, targetJid, now)
      if (activeCount >= limit) {
        void this.enforceWarnThreshold({
          groupJid,
          targetJid,
          actorJid: issuedBy,
          reason: normalizedReason,
          limit,
          now,
          announceInGroup: true,
        }).catch((err) => {
          this.logger.warn({ err, groupJid, targetJid }, 'deterministic Pasal 34 threshold enforcement failed')
        })
      }
    }
    return record
  }

  getWarning(id: string, now = this.clock()): WarningRecord | undefined {
    validateId(id, 'warning id')
    const row = this.database().prepare(`SELECT * FROM group_safety_warnings WHERE id = ?`).get(id) as WarningRow | undefined
    return row ? mapWarning(row, now) : undefined
  }

  listWarnings(groupJid: string, targetJid?: string, limit = this.maxListLimit, now = this.clock()): readonly WarningRecord[] {
    validateGroupJid(groupJid)
    if (targetJid !== undefined) validateJid(targetJid, 'warning target')
    const safeLimit = validateLimit(limit, this.maxListLimit)
    const rows = this.database().prepare(`
      SELECT * FROM group_safety_warnings
      WHERE group_jid = ? AND (? IS NULL OR target_jid = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(groupJid, targetJid ?? null, targetJid ?? null, safeLimit) as WarningRow[]
    return rows.map((row) => mapWarning(row, now))
  }

  revokeWarning(groupJid: string, id: string, revokedBy: string, now = this.clock()): WarningRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'warning id')
    validateJid(revokedBy, 'warning revoker')
    const current = this.getWarning(id, now)
    if (!current || current.groupJid !== groupJid || current.status !== 'active') return undefined
    this.audit('group.safety.warning.revoke.requested', revokedBy, current.targetJid, 'allowed', { warningId: id })
    const result = this.database().prepare(`
      UPDATE group_safety_warnings
      SET status = 'revoked', revoked_at = ?, revoked_by = ?, revision = revision + 1
      WHERE id = ? AND group_jid = ? AND status = 'active' AND revision = ?
    `).run(now, revokedBy, id, groupJid, current.revision)
    if (result.changes !== 1) {
      this.auditBestEffort('group.safety.warning.revoke.failed', revokedBy, current.targetJid, 'failed', { warningId: id })
      return undefined
    }
    this.auditBestEffort('group.safety.warning.revoked', revokedBy, current.targetJid, 'changed', { warningId: id })
    return this.getWarning(id, now)
  }

  countActiveWarnings(groupJid: string, targetJid: string, now = this.clock()): number {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'warning target')
    return (this.database().prepare(`SELECT COUNT(*) AS count FROM group_safety_warnings WHERE group_jid = ? AND target_jid = ? AND status = 'active' AND expires_at > ?`).get(groupJid, targetJid, now) as { count: number }).count
  }

  private resolveWarnLimit(groupJid: string): number {
    if (this.services && typeof this.services.has === 'function' && this.services.has('group-moderation-suite')) {
      try {
        const suite = this.services.get<{ readonly name: string; getWarnLimit?: (g: string) => number }>('group-moderation-suite')
        if (suite?.getWarnLimit) return suite.getWarnLimit(groupJid)
      } catch {}
    }
    return 3
  }

  getSpState(groupJid: string, targetJid: string): SpStateRecord {
    validateGroupJid(groupJid)
    const bare = bareSafetyJid(targetJid)
    const row = this.database()
      .prepare('SELECT group_jid, target_bare_jid, sp_level, updated_at FROM group_safety_sp_state WHERE group_jid = ? AND target_bare_jid = ?')
      .get(groupJid, bare) as { group_jid: string; target_bare_jid: string; sp_level: number; updated_at: number } | undefined
    return row
      ? { groupJid: row.group_jid, targetBareJid: row.target_bare_jid, spLevel: Number(row.sp_level), updatedAt: Number(row.updated_at) }
      : { groupJid, targetBareJid: bare, spLevel: 0, updatedAt: 0 }
  }

  getActiveSpSchedule(groupJid: string, targetJid: string): SpScheduleRecord | undefined {
    validateGroupJid(groupJid)
    const bare = bareSafetyJid(targetJid)
    const row = this.database()
      .prepare("SELECT * FROM group_safety_sp_schedules WHERE group_jid = ? AND target_bare_jid = ? AND status = 'scheduled' ORDER BY kicked_at DESC LIMIT 1")
      .get(groupJid, bare) as Record<string, unknown> | undefined
    return row ? mapSpSchedule(row) : undefined
  }

  listSpSchedules(groupJid: string, status?: SpScheduleRecord['status']): readonly SpScheduleRecord[] {
    validateGroupJid(groupJid)
    const rows = status
      ? (this.database()
          .prepare('SELECT * FROM group_safety_sp_schedules WHERE group_jid = ? AND status = ? ORDER BY reentry_at ASC LIMIT 25')
          .all(groupJid, status) as Array<Record<string, unknown>>)
      : (this.database()
          .prepare('SELECT * FROM group_safety_sp_schedules WHERE group_jid = ? ORDER BY kicked_at DESC LIMIT 25')
          .all(groupJid) as Array<Record<string, unknown>>)
    return rows.map(mapSpSchedule)
  }

  cancelSpSchedule(groupJid: string, targetJid: string, actorJid: string, resetSpLevel = false, now = this.clock()): {
    readonly cancelledCount: number
    readonly spLevel: number
  } {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'sp cancel actor')
    const bare = bareSafetyJid(targetJid)
    const cancelledCount = this.transaction(() => {
      const res = this.database()
        .prepare("UPDATE group_safety_sp_schedules SET status = 'cancelled', completed_at = ?, note = ? WHERE group_jid = ? AND target_bare_jid = ? AND status = 'scheduled'")
        .run(now, `cancelled_by:${bareSafetyJid(actorJid)}`, groupJid, bare)
      if (resetSpLevel) {
        this.database()
          .prepare('INSERT INTO group_safety_sp_state (group_jid, target_bare_jid, sp_level, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(group_jid, target_bare_jid) DO UPDATE SET sp_level = 0, updated_at = excluded.updated_at')
          .run(groupJid, bare, now)
      }
      return res.changes
    })
    this.auditBestEffort('group.safety.sp.cancelled', actorJid, targetJid, 'changed', { cancelledCount, resetSpLevel })
    return { cancelledCount, spLevel: this.getSpState(groupJid, targetJid).spLevel }
  }

  private async isTargetImmune(groupJid: string, targetJid: string, whatsapp?: WhatsAppPort): Promise<boolean> {
    const targetBare = bareSafetyJid(targetJid)
    if (!targetBare) return true
    if (whatsapp?.userJid && bareSafetyJid(whatsapp.userJid) === targetBare) return true
    if (whatsapp?.userLid && bareSafetyJid(whatsapp.userLid) === targetBare) return true
    if (this.botOwnerJid && bareSafetyJid(this.botOwnerJid) === targetBare) return true
    if (!whatsapp?.getGroupMetadata) return false
    try {
      const meta = await whatsapp.getGroupMetadata(groupJid)
      if (meta.ownerJid && bareSafetyJid(meta.ownerJid) === targetBare) return true
      return meta.participants.some(
        (p) => bareSafetyJid(p.jid) === targetBare && (p.role === 'admin' || p.role === 'superadmin'),
      )
    } catch {
      // Fail-closed: if metadata lookup fails during automated kick threshold, do not kick!
      return true
    }
  }

  async enforceWarnThreshold(params: {
    readonly groupJid: string
    readonly targetJid: string
    readonly actorJid: string
    readonly reason: string
    readonly limit?: number
    readonly now?: number
    readonly whatsapp?: WhatsAppPort
    readonly announceInGroup?: boolean
  }): Promise<WarnThresholdResult> {
    const now = params.now ?? this.clock()
    const limit = params.limit ?? this.resolveWarnLimit(params.groupJid)
    const activeCount = this.countActiveWarnings(params.groupJid, params.targetJid, now)
    if (activeCount < limit) {
      return { action: 'below_limit', activeCount, limit }
    }

    const wa = params.whatsapp ?? this.whatsapp
    if (await this.isTargetImmune(params.groupJid, params.targetJid, wa)) {
      return { action: 'immune_skip', activeCount, limit }
    }

    const bare = bareSafetyJid(params.targetJid)
    const currentSp = this.getSpState(params.groupJid, params.targetJid).spLevel

    // SP 3+ is OUTSIDE Chlona/Allybot authority: mute + escalate to Staff/Report Box (NO auto-kick)
    if (currentSp >= 2) {
      const nextSp = currentSp + 1
      const id = randomUUID()
      this.transaction(() => {
        this.database()
          .prepare('INSERT INTO group_safety_sp_state (group_jid, target_bare_jid, sp_level, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_jid, target_bare_jid) DO UPDATE SET sp_level = excluded.sp_level, updated_at = excluded.updated_at')
          .run(params.groupJid, bare, nextSp, now)
        this.database()
          .prepare("INSERT INTO group_safety_sp_schedules (id, group_jid, target_bare_jid, target_jid, sp_level, reason, kicked_at, reentry_at, status, completed_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'escalated', ?, 'sp3_outside_bot_authority')")
          .run(id, params.groupJid, bare, params.targetJid, nextSp, params.reason.slice(0, 240), now, now, now)
      })

      if (this.services && typeof this.services.has === 'function' && this.services.has('group-moderation-suite')) {
        try {
          const suite = this.services.get<{ readonly name: string; mute?: (g: string, t: string, a: string, d: number) => void }>('group-moderation-suite')
          suite.mute?.(params.groupJid, params.targetJid, wa?.userJid ?? params.actorJid, 30 * 60 * 1_000)
        } catch {}
      }

      if (this.services && typeof this.services.has === 'function' && this.services.has('suggestion') && wa) {
        try {
          const suggest = this.services.get<{ readonly name: string; getBoxGroup?: (type: string, botJid?: string) => string | undefined }>('suggestion')
          const reportBox = suggest.getBoxGroup?.('report', wa.userJid)
          if (reportBox) {
            await wa.sendText(
              reportBox,
              [
                `🚨 *Eskalasi Pasal 34 — SP ${nextSp} (Di Luar Wewenang Bot)*`,
                `• *Grup:* \`${params.groupJid}\``,
                `• *Member:* @${bare.split('@')[0]}`,
                `• *Warn:* ${activeCount}/${limit}`,
                `• *Alasan:* ${params.reason}`,
                '• *Status:* Ditahan dengan mute 30 menit (tanpa auto-kick). Menunggu putusan Staf (hiatus 1 bulan / Ban & Reset Character).',
              ].join('\n'),
              { mentions: [params.targetJid] },
            )
          }
        } catch {}
      }

      if (params.announceInGroup && wa) {
        try {
          await wa.sendText(
            params.groupJid,
            `🚨 @${bare.split('@')[0]} mencapai batas ${activeCount}/${limit} peringatan pada status *SP 2* → masuk *SP ${nextSp}* (di luar wewenang bot). Member di-mute 30 menit & dieskalasikan ke Staf.`,
            { mentions: [params.targetJid] },
          )
        } catch {}
      }

      return { action: 'escalated_sp3', activeCount, limit, spLevel: nextSp, scheduleId: id }
    }

    // SP 1 or SP 2: Persist 7-day reentry schedule BEFORE kicking
    const nextSp = currentSp + 1
    const reentryAt = now + this.spBanDurationMs
    const scheduleId = randomUUID()
    this.transaction(() => {
      this.database()
        .prepare('INSERT INTO group_safety_sp_state (group_jid, target_bare_jid, sp_level, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_jid, target_bare_jid) DO UPDATE SET sp_level = excluded.sp_level, updated_at = excluded.updated_at')
        .run(params.groupJid, bare, nextSp, now)
      this.database()
        .prepare("UPDATE group_safety_sp_schedules SET status = 'cancelled', completed_at = ?, note = 'superseded_by_new_sp' WHERE group_jid = ? AND target_bare_jid = ? AND status = 'scheduled'")
        .run(now, params.groupJid, bare)
      this.database()
        .prepare("INSERT INTO group_safety_sp_schedules (id, group_jid, target_bare_jid, target_jid, sp_level, reason, kicked_at, reentry_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')")
        .run(scheduleId, params.groupJid, bare, params.targetJid, nextSp, params.reason.slice(0, 240), now, reentryAt)
    })

    if (wa?.groupParticipantsUpdate) {
      await wa.groupParticipantsUpdate(params.groupJid, [params.targetJid], 'remove')
    }

    if (params.announceInGroup && wa) {
      try {
        await wa.sendText(
          params.groupJid,
          `⚠️ [PASAL 34] @${bare.split('@')[0]} mencapai batas ${activeCount}/${limit} peringatan dan dikeluarkan dari grup (*SP ${nextSp}* — 7 hari, akan diproses masuk ulang otomatis).
Alasan: ${params.reason}`,
          { mentions: [params.targetJid] },
        )
      } catch {}
    }

    return { action: 'kicked_sp', activeCount, limit, spLevel: nextSp, reentryAt, scheduleId }
  }

  async recoverSpReentries(whatsappOverride?: WhatsAppPort): Promise<number> {
    if (this.isRecoveringSp || !this.db?.open) return 0
    const wa = whatsappOverride ?? this.whatsapp
    if (!wa) return 0
    this.isRecoveringSp = true
    let processed = 0
    try {
      const now = this.clock()
      const dueRows = this.database()
        .prepare("SELECT * FROM group_safety_sp_schedules WHERE status = 'scheduled' AND reentry_at <= ? ORDER BY reentry_at ASC")
        .all(now) as Array<Record<string, unknown>>

      for (const raw of dueRows) {
        const row = mapSpSchedule(raw)
        // Reset active warnings for this user so they return cleanly at 0/5
        this.database()
          .prepare("UPDATE group_safety_warnings SET status = 'revoked', revoked_at = ?, revoked_by = 'sp-reentry-scheduler', revision = revision + 1 WHERE group_jid = ? AND target_jid = ? AND status = 'active'")
          .run(now, row.groupJid, row.targetJid)

        let added = false
        let addStatus = ''
        if (wa.groupParticipantsUpdate) {
          try {
            const results = await wa.groupParticipantsUpdate(row.groupJid, [row.targetJid], 'add')
            const firstStatus = results?.[0]?.status
            addStatus = firstStatus ?? 'ok'
            if (!firstStatus || firstStatus === 'ok' || firstStatus === '200' || firstStatus === '409') {
              added = true
            }
          } catch (err) {
            addStatus = err instanceof Error ? err.message : 'add_error'
          }
        }

        if (added) {
          this.database()
            .prepare("UPDATE group_safety_sp_schedules SET status = 'completed', completed_at = ?, note = 'auto_added' WHERE id = ?")
            .run(now, row.id)
          try {
            await wa.sendText(
              row.groupJid,
              `🔓 Masa *SP ${row.spLevel}* (7 hari) untuk @${row.targetBareJid.split('@')[0]} telah selesai dan berhasil dimasukkan kembali. Peringatan aktif direset ke 0.`,
              { mentions: [row.targetJid] },
            )
          } catch {}
          processed += 1
          continue
        }

        // Fallback when auto-add fails (e.g. WA 403/408 privacy): send DM invite link
        let inviteLink: string | undefined
        try {
          inviteLink = (await wa.getGroupInviteLink?.(row.groupJid)) ?? this.officialOocInviteLink
        } catch {
          inviteLink = this.officialOocInviteLink
        }
        try {
          const dmMsg = inviteLink
            ? `🔓 Masa sanksi *SP ${row.spLevel}* (7 hari) kamu telah selesai. Karena pengaturan privasi/undangan WA mencegah penambahan otomatis, silakan masuk kembali lewat tautan berikut:
${inviteLink}

_(Catatan: status SP saat ini: SP ${row.spLevel}. Jika nanti mencapai SP 3, penanganan dialihkan ke Staf.)_`
            : `🔓 Masa sanksi *SP ${row.spLevel}* (7 hari) kamu telah selesai, namun bot gagal mengirim undangan otomatis (${addStatus || '403'}). Silakan hubungi Staf untuk masuk kembali.`
          await wa.sendText(row.targetJid, dmMsg)
        } catch {}

        this.database()
          .prepare("UPDATE group_safety_sp_schedules SET status = 'completed', completed_at = ?, note = ? WHERE id = ?")
          .run(now, `dm_invite_fallback:${addStatus || 'privacy'}`, row.id)
        processed += 1
      }
    } finally {
      this.isRecoveringSp = false
    }
    return processed
  }

  reportCase(groupJid: string, reporterJid: string, targetJid: string, ruleId: string, reason: string, evidenceMessageId?: string, evidenceText?: string, now = this.clock()): CaseReportResult {
    validateGroupJid(groupJid)
    validateJid(reporterJid, 'case reporter')
    validateJid(targetJid, 'case target')
    validateId(ruleId, 'case rule id')
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const normalizedMessageId = evidenceMessageId === undefined ? undefined : normalizeBounded(evidenceMessageId, MAX_EVIDENCE_MESSAGE_ID_LENGTH, 'evidence message id')
    if (normalizedMessageId !== undefined) {
      const existing = this.findCaseByMessage(groupJid, normalizedMessageId)
      if (existing) return { record: existing, created: false }
    }
    const id = randomUUID()
    this.audit('group.safety.case.report.requested', reporterJid, targetJid, 'allowed', { ruleId, evidence: normalizedMessageId !== undefined })
    const result = this.transaction(() => {
      const inserted = this.database().prepare(`
        INSERT OR IGNORE INTO group_safety_cases
          (id, group_jid, reporter_jid, target_jid, rule_id, evidence_message_id, evidence_hash, reason, created_at, updated_at, status, revision)
        VALUES (@id, @group_jid, @reporter_jid, @target_jid, @rule_id, @evidence_message_id, @evidence_hash, @reason, @created_at, @updated_at, 'open', 0)
      `).run({ id, group_jid: groupJid, reporter_jid: reporterJid, target_jid: targetJid, rule_id: ruleId, evidence_message_id: normalizedMessageId ?? null, evidence_hash: evidenceText === undefined ? null : hashText(evidenceText), reason: normalizedReason, created_at: now, updated_at: now })
      if (inserted.changes === 0 && normalizedMessageId !== undefined) {
        const existing = this.findCaseByMessage(groupJid, normalizedMessageId)
        if (existing) return { record: existing, created: false }
      }
      const record = this.getCase(id)
      if (!record) throw new Error('Case was not persisted')
      return { record, created: true }
    })
    if (result.created) this.auditBestEffort('group.safety.case.reported', reporterJid, targetJid, 'changed', { caseId: result.record.id, ruleId })
    return result
  }

  getCase(id: string): ModerationCaseRecord | undefined {
    validateId(id, 'case id')
    const row = this.database().prepare(`SELECT * FROM group_safety_cases WHERE id = ?`).get(id) as CaseRow | undefined
    return row ? mapCase(row) : undefined
  }

  listCases(groupJid: string, statuses?: readonly ModerationCaseStatus[], limit = this.maxListLimit): readonly ModerationCaseRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    if (statuses?.some((status) => !isCaseStatus(status))) throw new Error('Invalid case status filter')
    const rows = this.database().prepare(`
      SELECT * FROM group_safety_cases
      WHERE group_jid = ? AND (? = 0 OR status IN (${statuses?.map(() => '?').join(',') || "''"}))
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(groupJid, statuses?.length ?? 0, ...(statuses ?? []), safeLimit) as CaseRow[]
    return rows.map(mapCase)
  }

  claimCase(groupJid: string, id: string, moderatorJid: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(moderatorJid, 'case moderator')
    validateRevision(expectedRevision)
    const current = this.requireCase(groupJid, id)
    if (!['open', 'appealed'].includes(current.status)) return undefined
    this.audit('group.safety.case.claim.requested', moderatorJid, current.targetJid, 'allowed', { caseId: id })
    const result = this.database().prepare(`UPDATE group_safety_cases SET status = 'claimed', assigned_to = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('open', 'appealed')`).run(moderatorJid, now, id, groupJid, expectedRevision)
    if (result.changes !== 1) {
      this.auditBestEffort('group.safety.case.claim.failed', moderatorJid, current.targetJid, 'failed', { caseId: id })
      return undefined
    }
    this.auditBestEffort('group.safety.case.claimed', moderatorJid, current.targetJid, 'changed', { caseId: id })
    return this.getCase(id)
  }

  resolveCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    return this.transitionCase(groupJid, id, moderatorJid, note, expectedRevision, 'resolved', now)
  }

  dismissCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    return this.transitionCase(groupJid, id, moderatorJid, note, expectedRevision, 'dismissed', now)
  }

  appealCase(groupJid: string, id: string, appellantJid: string, reason: string, now = this.clock()): { record: ModerationCaseRecord; appeal: AppealRecord; created: boolean } | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(appellantJid, 'appeal appellant')
    const current = this.requireCase(groupJid, id)
    if (current.targetJid !== appellantJid) return undefined
    const existing = this.getAppeal(id, appellantJid)
    if (existing) return { record: current, appeal: existing, created: false }
    if (!['resolved', 'dismissed'].includes(current.status)) return undefined
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const appealId = randomUUID()
    this.audit('group.safety.case.appeal.requested', appellantJid, appellantJid, 'allowed', { caseId: id })
    const result = this.transaction(() => {
      this.database().prepare(`INSERT INTO group_safety_appeals (id, case_id, appellant_jid, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(appealId, id, appellantJid, normalizedReason, now)
      const updated = this.database().prepare(`UPDATE group_safety_cases SET status = 'appealed', updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('resolved', 'dismissed')`).run(now, id, groupJid, current.revision)
      if (updated.changes !== 1) throw new Error('Case changed before appeal')
      return { record: this.getCase(id) as ModerationCaseRecord, appeal: this.getAppeal(id, appellantJid) as AppealRecord, created: true }
    })
    this.auditBestEffort('group.safety.case.appealed', appellantJid, appellantJid, 'changed', { caseId: id })
    return result
  }

  getAppeal(caseId: string, appellantJid: string): AppealRecord | undefined {
    validateId(caseId, 'case id')
    validateJid(appellantJid, 'appeal appellant')
    const row = this.database().prepare(`SELECT * FROM group_safety_appeals WHERE case_id = ? AND appellant_jid = ?`).get(caseId, appellantJid) as AppealRow | undefined
    return row ? mapAppeal(row) : undefined
  }

  consumeAntiSpam(groupJid: string, senderJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(senderJid, 'spam sender')
    return this.guardrailService().consumeRate(ANTI_SPAM_PROFILE_ID, hashText(`${groupJid}:${senderJid}`), { actorJid: senderJid, resourceJid: groupJid }, now).allowed
  }

  async shouldCreateDryRunCaseDistributed(groupJid: string, targetJid: string, ruleId: string, now = this.clock()): Promise<boolean> {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'dry-run target')
    validateId(ruleId, 'dry-run rule id')
    if (this.redis?.isEnabled) {
      const remembered = await this.redis.rememberOnce('dry-run-case', `${groupJid}:${targetJid}:${ruleId}`, 10)
      if (remembered !== undefined) return remembered
    }
    return this.shouldCreateDryRunCase(groupJid, targetJid, ruleId, now)
  }

  async consumeAntiSpamDistributed(groupJid: string, senderJid: string, now = this.clock()): Promise<boolean> {
    validateGroupJid(groupJid)
    validateJid(senderJid, 'spam sender')
    if (this.redis?.isEnabled) {
      const decision = await this.redis.consumeFixedWindow('group-safety-spam', `${groupJid}:${senderJid}`, 5, 10_000, now)
      if (decision !== undefined) return decision.allowed
    }
    return this.consumeAntiSpam(groupJid, senderJid, now)
  }

  shouldCreateDryRunCase(groupJid: string, targetJid: string, ruleId: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'dry-run target')
    validateId(ruleId, 'dry-run rule id')
    const key = hashText(`${groupJid}:${targetJid}:${ruleId}`)
    const last = this.dryRunCaseWindows.get(key)
    if (last !== undefined && now - last < 10_000) return false
    if (this.dryRunCaseWindows.size >= 1_024) {
      const oldest = this.dryRunCaseWindows.keys().next().value
      if (oldest) this.dryRunCaseWindows.delete(oldest)
    }
    this.dryRunCaseWindows.set(key, now)
    return true
  }

  private transitionCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, status: 'resolved' | 'dismissed', now: number): ModerationCaseRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(moderatorJid, 'case moderator')
    validateRevision(expectedRevision)
    const normalizedNote = normalizeReason(note, this.maxReasonLength)
    const current = this.requireCase(groupJid, id)
    if (!['open', 'claimed', 'appealed'].includes(current.status)) return undefined
    this.audit(`group.safety.case.${status}.requested`, moderatorJid, current.targetJid, 'allowed', { caseId: id })
    const result = this.database().prepare(`UPDATE group_safety_cases SET status = ?, assigned_to = COALESCE(assigned_to, ?), resolution_note = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('open', 'claimed', 'appealed')`).run(status, moderatorJid, normalizedNote, now, id, groupJid, expectedRevision)
    if (result.changes !== 1) {
      this.auditBestEffort(`group.safety.case.${status}.failed`, moderatorJid, current.targetJid, 'failed', { caseId: id })
      return undefined
    }
    this.auditBestEffort(`group.safety.case.${status}`, moderatorJid, current.targetJid, 'changed', { caseId: id })
    return this.getCase(id)
  }

  private requireCase(groupJid: string, id: string): ModerationCaseRecord {
    const record = this.getCase(id)
    if (!record || record.groupJid !== groupJid) throw new Error('Moderation case not found in group')
    return record
  }

  private findCaseByMessage(groupJid: string, messageId: string): ModerationCaseRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM group_safety_cases WHERE group_jid = ? AND evidence_message_id = ?`).get(groupJid, messageId) as CaseRow | undefined
    return row ? mapCase(row) : undefined
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'changed' | 'failed' | 'allowed' | 'denied', metadata: Record<string, unknown>): void {
    // Best-effort: an audit failure must never throw after a committed write.
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', eventType }, 'group safety audit unavailable')
    }
  }

  private auditBestEffort(eventType: string, actorJid: string, resourceJid: string, outcome: 'changed' | 'failed', metadata: Record<string, unknown>): void {
    try {
      this.audit(eventType, actorJid, resourceJid, outcome, metadata)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', eventType }, 'group safety completion audit unavailable')
    }
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS group_safety_settings (
        group_jid TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('off', 'dry-run')),
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_safety_warnings (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        revoked_at INTEGER,
        revoked_by TEXT,
        revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_safety_warnings_group_target_time ON group_safety_warnings (group_jid, target_jid, created_at);
      CREATE TABLE IF NOT EXISTS group_safety_cases (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        reporter_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        evidence_message_id TEXT,
        evidence_hash TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'resolved', 'dismissed', 'appealed')),
        assigned_to TEXT,
        resolution_note TEXT,
        revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_safety_cases_message ON group_safety_cases (group_jid, evidence_message_id) WHERE evidence_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_group_safety_cases_group_status ON group_safety_cases (group_jid, status, updated_at);
      CREATE TABLE IF NOT EXISTS group_safety_appeals (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES group_safety_cases(id),
        appellant_jid TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (case_id, appellant_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_group_safety_appeals_case ON group_safety_appeals (case_id, created_at);
      CREATE TABLE IF NOT EXISTS group_safety_sp_state (
        group_jid TEXT NOT NULL,
        target_bare_jid TEXT NOT NULL,
        sp_level INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, target_bare_jid)
      );
      CREATE TABLE IF NOT EXISTS group_safety_sp_schedules (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        target_bare_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        sp_level INTEGER NOT NULL,
        reason TEXT NOT NULL,
        kicked_at INTEGER NOT NULL,
        reentry_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled', 'escalated')),
        completed_at INTEGER,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_group_safety_sp_due ON group_safety_sp_schedules (status, reentry_at);
    `)
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private database(): DatabaseInstance {
    if (!this.db?.open) throw new Error('Group safety service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Platform guardrails service is not initialized')
    return this.guardrails
  }
}

function mapSettings(row: SettingsRow): SafetySettingsRecord {
  return { groupJid: row.group_jid, mode: row.mode, updatedBy: row.updated_by, updatedAt: row.updated_at }
}

function mapWarning(row: WarningRow, now: number): WarningRecord {
  const status: WarningStatus = row.status === 'active' && row.expires_at <= now ? 'expired' : row.status
  return {
    id: row.id,
    groupJid: row.group_jid,
    targetJid: row.target_jid,
    issuedBy: row.issued_by,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.revoked_by === null ? {} : { revokedBy: row.revoked_by }),
    revision: row.revision,
  }
}

function mapCase(row: CaseRow): ModerationCaseRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    reporterJid: row.reporter_jid,
    targetJid: row.target_jid,
    ruleId: row.rule_id,
    ...(row.evidence_message_id === null ? {} : { evidenceMessageId: row.evidence_message_id }),
    ...(row.evidence_hash === null ? {} : { evidenceHash: row.evidence_hash }),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    ...(row.assigned_to === null ? {} : { assignedTo: row.assigned_to }),
    ...(row.resolution_note === null ? {} : { resolutionNote: row.resolution_note }),
    revision: row.revision,
  }
}

function mapAppeal(row: AppealRow): AppealRecord {
  return { id: row.id, caseId: row.case_id, appellantJid: row.appellant_jid, reason: row.reason, createdAt: row.created_at }
}

function mapSpSchedule(row: Record<string, unknown>): SpScheduleRecord {
  return {
    id: String(row.id),
    groupJid: String(row.group_jid),
    targetBareJid: String(row.target_bare_jid),
    targetJid: String(row.target_jid),
    spLevel: Number(row.sp_level),
    reason: String(row.reason),
    kickedAt: Number(row.kicked_at),
    reentryAt: Number(row.reentry_at),
    status: String(row.status) as SpScheduleRecord['status'],
    ...(row.completed_at == null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.note == null ? {} : { note: String(row.note) }),
  }
}

function validateGroupJid(value: string): void {
  try {
    validateGroupJidCommon(value)
  } catch {
    throw new Error('Group safety requires a group JID')
  }
}

function validateId(value: string, field: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(value)) throw new Error(`Invalid ${field}`)
}

function validateRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error('Case revision must be a non-negative integer')
}

function validateLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`List limit must be between 1 and ${max}`)
  return value
}

function normalizeReason(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) throw new Error('reason must not be empty')
  if (normalized.length > maxLength) throw new Error('reason is too long')
  if (SECRET_LIKE_REASON.test(normalized)) throw new Error('reason contains sensitive-looking data')
  return normalized
}

function normalizeBounded(value: string, maxLength: number, field: string): string {
  const result = normalizeBoundedText(value, maxLength)
  if (!result) throw new Error(`${field} must not be empty`)
  if (SECRET_LIKE_REASON.test(result)) throw new Error(`${field} contains sensitive-looking data`)
  return result
}

const hashText = (value: string): string => sha256(value, 32)

function isCaseStatus(value: string): value is ModerationCaseStatus {
  return ['open', 'claimed', 'resolved', 'dismissed', 'appealed'].includes(value)
}
