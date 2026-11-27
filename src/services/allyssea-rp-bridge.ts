import { createHash } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'

export interface RpCharacterSummary {
  readonly found: boolean
  readonly characters: readonly {
    readonly name: string
    readonly race: string
    readonly className: string
    readonly element: string
    readonly rank: string
    readonly level: number
    readonly status: string
    readonly bonusTokens: number
  }[]
  readonly pendingRegistrationSession?: {
    readonly sessionId: string
    readonly expiresAt: string
  }
}

export interface RpSonaSummary {
  readonly found: boolean
  readonly accounts: readonly {
    readonly walletBalance: number
    readonly safeBalance: number
    readonly safeLimit: number
    readonly membershipTier: string
    readonly safeStatus: string
  }[]
  readonly recentHistory: readonly {
    readonly entryType: string
    readonly amount: number
    readonly reason: string | null
    readonly createdAt: string
  }[]
}

export interface RpWorldPulseSummary {
  readonly totalRpGroups: number
  readonly rpGroups: readonly {
    readonly label: string
    readonly icSubtype: string | null
    readonly oocPolicy: string
  }[]
}

export interface AllysseaRpBridgeOptions {
  readonly postgresUrl?: string
  readonly logger?: Logger
}

function canonicalJid(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(canonicalJid(value)).digest('hex')
}

export class AllysseaRpBridgeService implements Service {
  readonly name = 'allyssea-rp-bridge'
  private sql: Sql | null = null
  private logger?: Logger
  private readonly postgresUrl?: string

  constructor(options: AllysseaRpBridgeOptions = {}) {
    this.postgresUrl = options.postgresUrl
    this.logger = options.logger
  }

  async initialize(context?: ServiceContext): Promise<void> {
    if (context?.logger) this.logger = context.logger
    if (!this.postgresUrl) return
    this.sql = postgres(this.postgresUrl, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 5,
    })
    this.logger?.info('AllysseaRpBridgeService initialized (read-only)')
  }

  async shutdown(): Promise<void> {
    if (this.sql) {
      try {
        await this.sql.end({ timeout: 3 })
      } catch {
        // ignore close error
      }
      this.sql = null
    }
  }

  async checkCharacter(senderJid: string): Promise<RpCharacterSummary> {
    if (!this.sql) return { found: false, characters: [] }
    const ownerKey = hashIdentity(senderJid)
    const chars = await this.sql`
      SELECT name, race, class_name, element, rank, level, status, bonus_tokens
      FROM public.character_profiles
      WHERE owner_key = ${ownerKey}
      ORDER BY updated_at DESC
      LIMIT 5
    `
    const sessions = await this.sql`
      SELECT session_id, expires_at
      FROM public.character_registration_sessions
      WHERE owner_key = ${ownerKey} AND expires_at > now()
      ORDER BY expires_at DESC
      LIMIT 1
    `
    const activeSession = sessions[0]
    return {
      found: chars.length > 0 || Boolean(activeSession),
      characters: chars.map((r) => ({
        name: String(r.name),
        race: String(r.race),
        className: String(r.class_name),
        element: String(r.element),
        rank: String(r.rank),
        level: Number(r.level),
        status: String(r.status),
        bonusTokens: Number(r.bonus_tokens ?? 0),
      })),
      ...(activeSession
        ? {
            pendingRegistrationSession: {
              sessionId: String(activeSession.session_id),
              expiresAt: new Date(String(activeSession.expires_at)).toISOString(),
            },
          }
        : {}),
    }
  }

  async checkSona(senderJid: string): Promise<RpSonaSummary> {
    if (!this.sql) return { found: false, accounts: [], recentHistory: [] }
    const subjectKey = hashIdentity(senderJid)
    const accounts = await this.sql`
      SELECT wallet_balance, safe_balance, safe_limit, membership_tier, safe_status
      FROM public.economy_accounts
      WHERE subject_key = ${subjectKey}
      ORDER BY updated_at DESC
      LIMIT 5
    `
    const history = await this.sql`
      SELECT entry_type, amount, reason, created_at
      FROM public.economy_history
      WHERE subject_key = ${subjectKey}
      ORDER BY created_at DESC
      LIMIT 5
    `
    return {
      found: accounts.length > 0,
      accounts: accounts.map((a) => ({
        walletBalance: Number(a.wallet_balance ?? 0),
        safeBalance: Number(a.safe_balance ?? 0),
        safeLimit: Number(a.safe_limit ?? 0),
        membershipTier: String(a.membership_tier ?? 'standard'),
        safeStatus: String(a.safe_status ?? 'active'),
      })),
      recentHistory: history.map((h) => ({
        entryType: String(h.entry_type),
        amount: Number(h.amount ?? 0),
        reason: h.reason ? String(h.reason) : null,
        createdAt: new Date(String(h.created_at)).toISOString(),
      })),
    }
  }

  async getWorldPulse(query?: string): Promise<RpWorldPulseSummary> {
    const cleanQ = query?.trim().toLowerCase()
    let rpGroups: { label: string; icSubtype: string | null; oocPolicy: string }[] = []
    let totalRpGroups = 0

    if (this.sql) {
      const countRows = await this.sql`SELECT count(*)::int AS total FROM public.group_contexts WHERE mode = 'ic'`
      totalRpGroups = Number(countRows[0]?.total ?? 0)
      const rows = cleanQ
        ? await this.sql`
            SELECT group_label, ic_subtype, ooc_policy
            FROM public.group_contexts
            WHERE mode = 'ic' AND coalesce(group_label, '') ILIKE ${'%' + cleanQ.slice(0, 50) + '%'}
            ORDER BY group_label ASC
            LIMIT 25
          `
        : await this.sql`
            SELECT group_label, ic_subtype, ooc_policy
            FROM public.group_contexts
            WHERE mode = 'ic'
            ORDER BY group_label ASC
            LIMIT 45
          `
      rpGroups = rows.map((r) => ({
        label: String(r.group_label ?? 'Lokasi RP'),
        icSubtype: r.ic_subtype ? String(r.ic_subtype) : null,
        oocPolicy: String(r.ooc_policy ?? 'strict'),
      }))
    }

    return {
      totalRpGroups,
      rpGroups,
    }
  }
}
