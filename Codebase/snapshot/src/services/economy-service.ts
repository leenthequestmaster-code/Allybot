import { createHash } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isGroupJid, isJid } from '../framework/validation.js'
import type { RedisService } from '../redis.js'

export type EconomyMembershipTier = 'basic' | 'bronze' | 'silver' | 'gold' | 'star'
export type EconomySafeStatus = 'not_open' | 'pending' | 'active' | 'frozen'
export type EconomySnapshotSource = 'postgres' | 'cache'

// Tax System (PRD §5.2)
export type TaxStatus = 'current' | 'warning' | 'penalty_1' | 'penalty_2' | 'penalty_3_plus'
export type TaxFrozenScope = 'none' | 'safe' | 'total'

export interface TaxRecord {
  readonly taxId: string
  readonly groupJid: string
  readonly subjectJid: string
  readonly wealth: number
  readonly baseTax: number
  readonly penaltyRate: number
  readonly totalTax: number
  readonly status: TaxStatus
  readonly frozenScope: TaxFrozenScope
  readonly weekNumber: number
  readonly dueAt: string
  readonly paidAt?: string
  readonly createdAt: string
}

export interface TaxSummary {
  readonly totalWealth: number
  readonly baseTaxRate: number
  readonly currentTax: number
  readonly penaltyRate: number
  readonly totalDue: number
  readonly status: TaxStatus
  readonly frozenScope: TaxFrozenScope
  readonly weekNumber: number
  readonly dueAt: string
  readonly isOverdue: boolean
}

export interface EconomyAccountSnapshot {
  readonly economyEnabled: boolean
  readonly walletBalance: number
  readonly safeBalance: number
  readonly safeLimit: number
  readonly restrictedWalletBalance: number
  readonly reservedWalletBalance: number
  readonly membershipTier: EconomyMembershipTier
  readonly safeStatus: EconomySafeStatus
  readonly revision: number
  readonly asOf: string
}

export interface EconomySnapshotResult {
  readonly snapshot: EconomyAccountSnapshot
  readonly source: EconomySnapshotSource
}

export interface EconomyHistoryEntry {
  readonly entryId: string
  readonly entryType: string
  readonly amount: number
  readonly walletDelta: number
  readonly safeDelta: number
  readonly reservedWalletDelta: number
  readonly reason: string
  readonly createdAt: string
}

export interface EconomyRpcError {
  readonly code?: unknown
  readonly message?: unknown
}

export type EconomyRpcValue = string | number | boolean | null

export interface EconomyRpcClient {
  rpc(functionName: string, args: Record<string, EconomyRpcValue>): PromiseLike<{
    data: unknown
    error: EconomyRpcError | null
  }>
}

export interface EconomyRedisCache {
  readonly isEnabled: boolean
  cacheGet<TData>(scope: string, identity: string): Promise<TData | undefined>
  cacheSet<TData>(scope: string, identity: string, value: TData, ttlSeconds: number): Promise<boolean>
  cacheDelete(scope: string, identity: string): Promise<boolean>
}

export interface EconomyServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly cacheTtlSeconds?: number
  readonly createClient?: (config: any) => EconomyRpcClient
  readonly redis?: EconomyRedisCache
  readonly clock?: () => number
}

const ECONOMY_CACHE_SCOPE = 'economy-account'
const DEFAULT_CACHE_TTL_SECONDS = 15
const MAX_CACHE_TTL_SECONDS = 300
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const MAX_VELA = 2_000_000_000
const WALLET_LIMIT = 20_000
const MEMBERSHIP_TIERS: readonly EconomyMembershipTier[] = ['basic', 'bronze', 'silver', 'gold', 'star']
const SAFE_STATUSES: readonly EconomySafeStatus[] = ['not_open', 'pending', 'active', 'frozen']
const OPERATION_HASH_LENGTH = 32

export class EconomyUnavailableError extends Error {
  constructor() {
    super('Sistem Vela sedang tidak tersedia. Coba lagi nanti.')
    this.name = 'EconomyUnavailableError'
  }
}

export class EconomyOperationError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false) {
    super(message)
    this.name = 'EconomyOperationError'
    this.retryable = retryable
  }
}

export class EconomyService implements Service {
  readonly name = 'economy'
  readonly dependencies = ['redis'] as const

  private readonly env: NodeJS.ProcessEnv
  private readonly cacheTtlSeconds: number
  private readonly createClient: (config: any) => EconomyRpcClient
  private readonly injectedRedis?: EconomyRedisCache
  private readonly clock: () => number
  private enabled = false
  private client: EconomyRpcClient | undefined
  private redis: EconomyRedisCache | undefined

  constructor(
    private readonly logger: Logger,
    options: EconomyServiceOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS
    if (!Number.isSafeInteger(this.cacheTtlSeconds) || this.cacheTtlSeconds < 5 || this.cacheTtlSeconds > MAX_CACHE_TTL_SECONDS) {
      throw new Error(`Economy cache TTL must be between 5 and ${MAX_CACHE_TTL_SECONDS} seconds`)
    }
    this.createClient = options.createClient ?? (() => ({ rpc: async () => ({ data: null, error: null }) }))
    this.injectedRedis = options.redis
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(context: ServiceContext): void {
    this.enabled = this.env.ECONOMY_ENABLED?.trim().toLowerCase() === 'true' || this.env.SUPABASE_ECONOMY_ENABLED?.trim().toLowerCase() === 'true'
    this.redis = this.injectedRedis ?? (context.services.has('redis')
      ? context.services.get<RedisService>('redis') as unknown as EconomyRedisCache
      : undefined)

    if (!this.enabled) return

    this.client = this.createClient({})
    this.logger.info({ cacheTtlSeconds: this.cacheTtlSeconds }, 'Economy service initialized')
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get isReady(): boolean {
    return this.enabled && this.client !== undefined
  }

  async getAccountSnapshot(groupJid: string, subjectJid: string): Promise<EconomySnapshotResult> {
    this.assertAccountIdentity(groupJid, subjectJid)
    if (!this.client) throw new EconomyUnavailableError()

    const scopeKey = hashIdentity(canonicalJid(groupJid))
    const subjectKey = hashIdentity(canonicalJid(subjectJid))
    const cacheIdentity = cacheIdentityFor(scopeKey, subjectKey)
    if (this.redis?.isEnabled) {
      const cached = await this.safeCacheGet(cacheIdentity)
      if (cached !== undefined) {
        const normalized = normalizeSnapshot(cached)
        if (normalized) return { snapshot: normalized, source: 'cache' }
        await this.safeCacheDelete(cacheIdentity)
      }
    }

    const result = await this.callRpc('economy_get_account_snapshot', {
      p_scope_key: scopeKey,
      p_subject_key: subjectKey,
    })
    const snapshot = normalizeSnapshot(result)
    if (!snapshot) {
      this.logger.warn({ responseType: typeof result }, 'Supabase economy snapshot response was invalid')
      throw new EconomyUnavailableError()
    }

    if (this.redis?.isEnabled) await this.safeCacheSet(cacheIdentity, snapshot)
    return { snapshot, source: 'postgres' }
  }

  async setGroupPolicy(
    groupJid: string,
    enabled: boolean,
    actorJid: string,
    operationKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertGroupIdentity(groupJid)
    this.assertActorIdentity(actorJid)
    return this.mutate('economy_set_group_policy', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_enabled: enabled,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: reason,
    })
  }

  async openSafe(
    groupJid: string,
    subjectJid: string,
    actorJid: string,
    operationKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    const result = await this.mutate('economy_open_safe', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: reason,
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async grantReward(
    groupJid: string,
    subjectJid: string,
    amount: number,
    actorJid: string,
    operationKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    assertAmount(amount)
    const result = await this.mutate('economy_grant_reward', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_amount: amount,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: reason,
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async deposit(
    groupJid: string,
    subjectJid: string,
    amount: number,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    assertAmount(amount)
    const result = await this.mutate('economy_deposit', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_amount: amount,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: 'Setoran Wallet ke Safe',
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async withdraw(
    groupJid: string,
    subjectJid: string,
    amount: number,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    assertAmount(amount)
    const result = await this.mutate('economy_withdraw', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_amount: amount,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: 'Penarikan Safe ke Wallet',
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async upgradeMembership(
    groupJid: string,
    subjectJid: string,
    targetTier: EconomyMembershipTier,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    if (!['bronze', 'silver', 'gold', 'star'].includes(targetTier)) throw new EconomyOperationError('Pilihan membership tidak valid.')
    const result = await this.mutate('economy_upgrade_membership', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_target_tier: targetTier,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: `Peningkatan membership ke ${targetTier}`,
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async createTransfer(
    groupJid: string,
    senderJid: string,
    recipientJid: string,
    amount: number,
    actorJid: string,
    operationKey: string,
    note: string,
  ): Promise<Record<string, unknown>> {
    this.assertGroupIdentity(groupJid)
    this.assertActorIdentity(senderJid)
    this.assertActorIdentity(recipientJid)
    this.assertActorIdentity(actorJid)
    assertAmount(amount)
    if (canonicalJid(senderJid) === canonicalJid(recipientJid)) throw new EconomyOperationError('Transfer ke diri sendiri tidak diperbolehkan.')
    const result = await this.mutate('economy_create_transfer', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_sender_key: hashIdentity(canonicalJid(senderJid)),
      p_recipient_key: hashIdentity(canonicalJid(recipientJid)),
      p_amount: amount,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_note: note,
    })
    await this.invalidateAccount(groupJid, senderJid)
    return result
  }

  async acceptTransfer(
    groupJid: string,
    transferId: string,
    recipientJid: string,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertGroupIdentity(groupJid)
    this.assertActorIdentity(recipientJid)
    this.assertActorIdentity(actorJid)
    const result = await this.mutate('economy_accept_transfer', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_transfer_id: transferId,
      p_recipient_key: hashIdentity(canonicalJid(recipientJid)),
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: 'Transfer Vela diterima',
    })
    await this.invalidateAccountsFromResult(groupJid, result, recipientJid)
    return result
  }

  async rejectTransfer(
    groupJid: string,
    transferId: string,
    recipientJid: string,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertGroupIdentity(groupJid)
    this.assertActorIdentity(recipientJid)
    this.assertActorIdentity(actorJid)
    const result = await this.mutate('economy_reject_transfer', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_transfer_id: transferId,
      p_recipient_key: hashIdentity(canonicalJid(recipientJid)),
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: 'Transfer Vela ditolak',
    })
    await this.invalidateAccountsFromResult(groupJid, result, recipientJid)
    return result
  }

  async sweepOverage(
    groupJid: string,
    subjectJid: string,
    actorJid: string,
    operationKey: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    const result = await this.mutate('economy_sweep_overage', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: 'Penyitaan Wallet setelah masa tenggang',
    })
    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  async getHistory(groupJid: string, subjectJid: string, limit = 20): Promise<readonly EconomyHistoryEntry[]> {
    this.assertAccountIdentity(groupJid, subjectJid)
    if (!this.client) throw new EconomyUnavailableError()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new EconomyOperationError('Jumlah riwayat harus antara 1 dan 50.')
    const result = await this.callRpc('economy_get_history', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_limit: limit,
    })
    if (!Array.isArray(result)) throw new EconomyUnavailableError()
    return result.map(normalizeHistoryEntry).filter((entry): entry is EconomyHistoryEntry => entry !== undefined)
  }

  async invalidateAccount(groupJid: string, subjectJid: string): Promise<boolean> {
    this.assertAccountIdentity(groupJid, subjectJid)
    if (!this.redis?.isEnabled) return false
    return this.safeCacheDelete(cacheIdentityFor(hashIdentity(canonicalJid(groupJid)), hashIdentity(canonicalJid(subjectJid))))
  }

  async shutdown(): Promise<void> {
    this.client = undefined
    this.redis = undefined
    this.enabled = false
  }

  // Tax System (PRD §5.2)
  private static readonly TAX_BASE_RATE = 0.02 // 2% base tax
  private static readonly TAX_PENALTY_INCREMENT = 0.02 // +2% per week
  private static readonly TAX_DUE_DAY = 1 // Monday (0=Sunday, 1=Monday)
  private static readonly TAX_DUE_HOUR_WIB = 0 // 00:00 WIB

  calculateTax(wealth: number): { baseTax: number; totalTax: number; penaltyRate: number } {
    const baseTax = Math.floor(wealth * EconomyService.TAX_BASE_RATE)
    return { baseTax, totalTax: baseTax, penaltyRate: 0 }
  }

  calculateTaxWithPenalty(wealth: number, weekNumber: number): { baseTax: number; totalTax: number; penaltyRate: number; status: TaxStatus; frozenScope: TaxFrozenScope } {
    const baseTax = Math.floor(wealth * EconomyService.TAX_BASE_RATE)
    let penaltyRate = 0
    let status: TaxStatus = 'current'
    let frozenScope: TaxFrozenScope = 'none'

    if (weekNumber === 1) {
      status = 'warning'
    } else if (weekNumber === 2) {
      penaltyRate = EconomyService.TAX_PENALTY_INCREMENT
      status = 'penalty_1'
    } else if (weekNumber === 3) {
      penaltyRate = EconomyService.TAX_PENALTY_INCREMENT * 2
      status = 'penalty_2'
      frozenScope = 'safe'
    } else if (weekNumber >= 4) {
      penaltyRate = EconomyService.TAX_PENALTY_INCREMENT * (weekNumber - 1)
      status = 'penalty_3_plus'
      frozenScope = 'total'
    }

    const totalTax = Math.floor(baseTax * (1 + penaltyRate))
    return { baseTax, totalTax, penaltyRate, status, frozenScope }
  }

  getCurrentTaxWeek(realMs = Date.now()): number {
    const wibMs = realMs + 7 * 60 * 60 * 1000
    const wibDate = new Date(wibMs)
    const dayOfWeek = wibDate.getUTCDay()
    const hour = wibDate.getUTCHours()

    // Tax is due every Monday at 00:00 WIB
    // If today is Monday after 00:00, it's the new week
    // If today is before Monday, it's the previous week
    let weekOffset = 0
    if (dayOfWeek === 1 && hour >= EconomyService.TAX_DUE_HOUR_WIB) {
      weekOffset = 0
    } else if (dayOfWeek > 1 || (dayOfWeek === 1 && hour < EconomyService.TAX_DUE_HOUR_WIB)) {
      weekOffset = 1
    } else {
      weekOffset = 0
    }

    // Calculate weeks since epoch (simplified - in production use actual epoch)
    const epochMs = new Date('2024-01-01T00:00:00+07:00').getTime()
    const weeksSinceEpoch = Math.floor((wibMs - epochMs) / (7 * 24 * 60 * 60 * 1000))
    return weeksSinceEpoch + weekOffset + 1
  }

  async getTaxSummary(groupJid: string, subjectJid: string): Promise<TaxSummary | undefined> {
    this.assertAccountIdentity(groupJid, subjectJid)
    if (!this.client) throw new EconomyUnavailableError()

    const snapshotResult = await this.getAccountSnapshot(groupJid, subjectJid)
    const wealth = snapshotResult.snapshot.walletBalance + snapshotResult.snapshot.safeBalance
    const weekNumber = this.getCurrentTaxWeek()
    const taxCalc = this.calculateTaxWithPenalty(wealth, weekNumber)

    const now = this.clock()
    const wibMs = now + 7 * 60 * 60 * 1000
    const wibDate = new Date(wibMs)
    const dayOfWeek = wibDate.getUTCDay()
    const isOverdue = dayOfWeek > 1 || (dayOfWeek === 1 && wibDate.getUTCHours() >= EconomyService.TAX_DUE_HOUR_WIB)

    return {
      totalWealth: wealth,
      baseTaxRate: EconomyService.TAX_BASE_RATE,
      currentTax: taxCalc.baseTax,
      penaltyRate: taxCalc.penaltyRate,
      totalDue: taxCalc.totalTax,
      status: taxCalc.status,
      frozenScope: taxCalc.frozenScope,
      weekNumber,
      dueAt: new Date(now + (8 - dayOfWeek) * 24 * 60 * 60 * 1000).toISOString(),
      isOverdue,
    }
  }

  async payTax(
    groupJid: string,
    subjectJid: string,
    actorJid: string,
    operationKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAccountIdentity(groupJid, subjectJid)
    this.assertActorIdentity(actorJid)
    if (!this.client) throw new EconomyUnavailableError()

    const summary = await this.getTaxSummary(groupJid, subjectJid)
    if (!summary || summary.totalDue <= 0) {
      throw new EconomyOperationError('Tidak ada pajak yang harus dibayar.')
    }

    const result = await this.mutate('economy_pay_tax', {
      p_scope_key: hashIdentity(canonicalJid(groupJid)),
      p_subject_key: hashIdentity(canonicalJid(subjectJid)),
      p_amount: summary.totalDue,
      p_operation_key: operationKey,
      p_actor_key: hashIdentity(canonicalJid(actorJid)),
      p_reason: reason,
    })

    await this.invalidateAccount(groupJid, subjectJid)
    return result
  }

  private async invalidateAccountsFromResult(groupJid: string, result: Record<string, unknown>, fallbackSubjectJid: string): Promise<void> {
    const scopeKey = hashIdentity(canonicalJid(groupJid))
    const cacheIdentities = [cacheIdentityFor(scopeKey, hashIdentity(canonicalJid(fallbackSubjectJid)))]
    for (const field of ['sender_key', 'recipient_key']) {
      const value = result[field]
      if (typeof value === 'string' && isEconomyHash(value)) cacheIdentities.push(cacheIdentityFor(scopeKey, value))
    }
    await Promise.all([...new Set(cacheIdentities)].map((identity) => this.safeCacheDelete(identity)))
  }

  private async mutate(functionName: string, args: Record<string, EconomyRpcValue>): Promise<Record<string, unknown>> {
    const result = await this.callRpc(functionName, args)
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new EconomyUnavailableError()
    return result as Record<string, unknown>
  }

  private async callRpc(functionName: string, args: Record<string, EconomyRpcValue>): Promise<unknown> {
    if (!this.client) throw new EconomyUnavailableError()
    let response: Awaited<ReturnType<EconomyRpcClient['rpc']>>
    try {
      response = await this.client.rpc(functionName, args)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', functionName }, 'Supabase economy RPC request failed')
      throw new EconomyUnavailableError()
    }
    if (response.error) {
      this.logger.warn({ errorCode: safeErrorCode(response.error), functionName }, 'Supabase economy RPC rejected')
      throw classifyRpcError(response.error)
    }
    return response.data
  }

  private async safeCacheGet(identity: string): Promise<unknown | undefined> {
    if (!this.redis?.isEnabled) return undefined
    try {
      return await this.redis.cacheGet<unknown>(ECONOMY_CACHE_SCOPE, identity)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Supabase economy cache read failed')
      return undefined
    }
  }

  private async safeCacheSet(identity: string, snapshot: EconomyAccountSnapshot): Promise<void> {
    if (!this.redis?.isEnabled) return
    try {
      await this.redis.cacheSet(ECONOMY_CACHE_SCOPE, identity, snapshot, this.cacheTtlSeconds)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Supabase economy cache write failed')
    }
  }

  private async safeCacheDelete(identity: string): Promise<boolean> {
    if (!this.redis?.isEnabled) return false
    try {
      return await this.redis.cacheDelete(ECONOMY_CACHE_SCOPE, identity)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Supabase economy cache invalidation failed')
      return false
    }
  }

  private assertAccountIdentity(groupJid: string, subjectJid: string): void {
    this.assertGroupIdentity(groupJid)
    this.assertActorIdentity(subjectJid)
  }

  private assertGroupIdentity(groupJid: string): void {
    if (!isGroupJid(groupJid)) throw new EconomyOperationError('Economy group identity is invalid')
  }

  private assertActorIdentity(actorJid: string): void {
    if (!isJid(actorJid)) throw new EconomyOperationError('Economy subject identity is invalid')
  }
}

export function createEconomyOperationKey(prefix: string, sourceId: string): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'economy'
  const hash = hashIdentity(`${safePrefix}:${sourceId}`).slice(0, OPERATION_HASH_LENGTH)
  return `${safePrefix}-${hash}`
}

function canonicalJid(value: string): string {
  const at = value.lastIndexOf('@')
  if (at <= 0) return value
  const local = value.slice(0, at).split(':', 1)[0]
  return `${local}@${value.slice(at + 1)}`
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cacheIdentityFor(scopeKey: string, subjectKey: string): string {
  return `${scopeKey}:${subjectKey}`
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000) {
    throw new EconomyOperationError('Jumlah Vela harus berupa angka bulat antara 1 dan 1.000.000.000.')
  }
}

function safeErrorCode(error: EconomyRpcError): string | undefined {
  return typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.code) ? error.code : undefined
}

function classifyRpcError(error: EconomyRpcError): EconomyOperationError {
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  if (message.includes('disabled')) return new EconomyOperationError('Economy Vela belum diaktifkan di grup ini.')
  if (message.includes('insufficient') || message.includes('capacity') || message.includes('limit')) return new EconomyOperationError('Operasi ditolak karena saldo atau kapasitas tidak mencukupi.')
  if (message.includes('active') || message.includes('frozen') || message.includes('account')) return new EconomyOperationError('Operasi ditolak karena status rekening belum memenuhi syarat.')
  if (message.includes('transfer')) return new EconomyOperationError('Transfer tidak dapat diproses. Periksa ID, penerima, dan masa berlaku transfer.')
  if (message.includes('operation') || message.includes('replay')) return new EconomyOperationError('Operasi sudah diproses atau operation key tidak dapat digunakan ulang.')
  return new EconomyOperationError('Operasi Vela ditolak oleh validasi server.')
}

function normalizeSnapshot(value: unknown): EconomyAccountSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const economyEnabled = typeof record.economy_enabled === 'boolean'
    ? record.economy_enabled
    : typeof record.economyEnabled === 'boolean'
      ? record.economyEnabled
      : undefined
  const walletBalance = integerField(record.wallet_balance ?? record.walletBalance)
  const safeBalance = integerField(record.safe_balance ?? record.safeBalance)
  const safeLimit = integerField(record.safe_limit ?? record.safeLimit)
  const restrictedWalletBalance = integerField(record.restricted_wallet_balance ?? record.restrictedWalletBalance)
  const reservedWalletBalance = integerField(record.reserved_wallet_balance ?? record.reservedWalletBalance)
  const revision = integerField(record.revision)
  const membershipTier = record.membership_tier ?? record.membershipTier
  const safeStatus = record.safe_status ?? record.safeStatus
  const asOf = typeof record.as_of === 'string' ? record.as_of : typeof record.asOf === 'string' ? record.asOf : undefined

  if (
    economyEnabled === undefined || walletBalance === undefined || safeBalance === undefined || safeLimit === undefined || restrictedWalletBalance === undefined || reservedWalletBalance === undefined ||
    revision === undefined || !isMembershipTier(membershipTier) || !isSafeStatus(safeStatus) || !asOf ||
    walletBalance < 0 || safeBalance < 0 || safeLimit < 0 || restrictedWalletBalance < 0 || reservedWalletBalance < 0 || revision < 0 ||
    walletBalance > MAX_VELA || safeBalance > MAX_VELA || safeLimit > MAX_VELA || restrictedWalletBalance > walletBalance ||
    reservedWalletBalance > walletBalance || restrictedWalletBalance + reservedWalletBalance > walletBalance ||
    safeBalance > safeLimit || walletBalance - restrictedWalletBalance - reservedWalletBalance > WALLET_LIMIT
  ) return undefined

  return {
    economyEnabled,
    walletBalance,
    safeBalance,
    safeLimit,
    restrictedWalletBalance,
    reservedWalletBalance,
    membershipTier,
    safeStatus,
    revision,
    asOf,
  }
}

function normalizeHistoryEntry(value: unknown): EconomyHistoryEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const entryId = typeof record.entry_id === 'string' ? record.entry_id : undefined
  const entryType = typeof record.entry_type === 'string' ? record.entry_type : undefined
  const amount = integerField(record.amount)
  const walletDelta = signedIntegerField(record.wallet_delta)
  const safeDelta = signedIntegerField(record.safe_delta)
  const reservedWalletDelta = signedIntegerField(record.reserved_wallet_delta)
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, 500) : undefined
  const createdAt = typeof record.created_at === 'string' ? record.created_at : undefined
  if (!entryId || !entryType || amount === undefined || walletDelta === undefined || safeDelta === undefined || reservedWalletDelta === undefined || !reason || !createdAt) return undefined
  return { entryId, entryType, amount, walletDelta, safeDelta, reservedWalletDelta, reason, createdAt }
}

function integerField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function signedIntegerField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function isMembershipTier(value: unknown): value is EconomyMembershipTier {
  return typeof value === 'string' && MEMBERSHIP_TIERS.includes(value as EconomyMembershipTier)
}

function isSafeStatus(value: unknown): value is EconomySafeStatus {
  return typeof value === 'string' && SAFE_STATUSES.includes(value as EconomySafeStatus)
}

export function isEconomyHash(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value)
}
