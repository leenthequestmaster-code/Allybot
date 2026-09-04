import { createHash, randomUUID } from 'node:crypto'
import { isJid, isSafeIdentifier } from './validation.js'

export type GuardrailScope = 'global' | 'user' | 'group'
export type GuardrailOutcome = 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed'
export type ProviderCircuitState = 'closed' | 'open' | 'half-open'

const MAX_IDENTIFIER_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 240
const MAX_AUDIT_METADATA_KEYS = 16
const MAX_AUDIT_STRING_LENGTH = 240
const MAX_CORRELATION_ID_LENGTH = 128
const FORBIDDEN_AUDIT_KEY = /(secret|token|password|credential|authorization|cookie|session|stack|raw|payload|message|chat|jid|phone|number|sender|recipient|target)/i
const SECRET_LIKE_VALUE = /(bearer\s+|^eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$|-----begin|(?:api[_-]?key|token|password)\s*[:=])/i

export interface GuardrailPolicyDefinition {
  readonly id: string
  readonly version: number
  readonly action: string
  readonly scope: GuardrailScope
  readonly description: string
  readonly featureId?: string
  readonly rateProfileId?: string
  readonly enabled?: boolean
}

export interface GuardrailPolicyRequest {
  readonly policyId: string
  readonly action: string
  readonly scope: GuardrailScope
}

export interface GuardrailDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly policyId?: string
  readonly policyVersion?: number
  readonly featureId?: string
  readonly rateProfileId?: string
}

export class GuardrailPolicyRegistry {
  private readonly policies = new Map<string, GuardrailPolicyDefinition>()

  register(policy: GuardrailPolicyDefinition): () => void {
    validatePolicy(policy)
    if (this.policies.has(policy.id)) throw new Error(`Guardrail policy already registered: ${policy.id}`)
    const normalized = { ...policy, enabled: policy.enabled ?? true }
    this.policies.set(normalized.id, normalized)
    return () => {
      if (this.policies.get(normalized.id) === normalized) this.policies.delete(normalized.id)
    }
  }

  get(id: string): GuardrailPolicyDefinition | undefined {
    return this.policies.get(id)
  }

  list(): readonly GuardrailPolicyDefinition[] {
    return [...this.policies.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  evaluate(request: GuardrailPolicyRequest): GuardrailDecision {
    validatePolicyRequest(request)
    const policy = this.policies.get(request.policyId)
    if (!policy) return { allowed: false, reason: 'Unknown guardrail policy', policyId: request.policyId }
    if (policy.enabled !== true) return deniedPolicy(policy, 'Guardrail policy is disabled')
    if (policy.action !== request.action) return deniedPolicy(policy, 'Guardrail action mismatch')
    if (policy.scope !== request.scope) return deniedPolicy(policy, 'Guardrail scope mismatch')
    return {
      allowed: true,
      reason: 'Guardrail policy allowed',
      policyId: policy.id,
      policyVersion: policy.version,
      ...(policy.featureId === undefined ? {} : { featureId: policy.featureId }),
      ...(policy.rateProfileId === undefined ? {} : { rateProfileId: policy.rateProfileId }),
    }
  }
}

function deniedPolicy(policy: GuardrailPolicyDefinition, reason: string): GuardrailDecision {
  return {
    allowed: false,
    reason,
    policyId: policy.id,
    policyVersion: policy.version,
    ...(policy.featureId === undefined ? {} : { featureId: policy.featureId }),
    ...(policy.rateProfileId === undefined ? {} : { rateProfileId: policy.rateProfileId }),
  }
}

export interface SafeActionDefinition {
  readonly id: string
  readonly version: number
  readonly description: string
  readonly inputSchemaVersion: number
  readonly risk: 'low' | 'medium' | 'high'
  readonly requiredPermission?: string
  readonly featureId?: string
  readonly enabled?: boolean
}

export class SafeActionRegistry {
  private readonly actions = new Map<string, SafeActionDefinition>()

  register(action: SafeActionDefinition): () => void {
    validateAction(action)
    if (this.actions.has(action.id)) throw new Error(`Safe action already registered: ${action.id}`)
    const normalized = { ...action, enabled: action.enabled ?? true }
    this.actions.set(normalized.id, normalized)
    return () => {
      if (this.actions.get(normalized.id) === normalized) this.actions.delete(normalized.id)
    }
  }

  get(id: string): SafeActionDefinition | undefined {
    const action = this.actions.get(id)
    return action?.enabled === true ? action : undefined
  }

  list(): readonly SafeActionDefinition[] {
    return [...this.actions.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}

export interface RateLimitProfile {
  readonly id: string
  readonly maxRequests: number
  readonly windowMs: number
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly profileId: string
  readonly key: string
  readonly count: number
  readonly limit: number
  readonly resetAt: number
}

interface RateWindow {
  readonly windowStart: number
  count: number
}

export interface FixedWindowRateLimiterOptions {
  readonly clock?: () => number
  readonly maxKeys?: number
}

export class FixedWindowRateLimiter {
  private readonly profiles = new Map<string, RateLimitProfile>()
  private readonly windows = new Map<string, RateWindow>()
  private readonly clock: () => number
  private readonly maxKeys: number

  constructor(options: FixedWindowRateLimiterOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.maxKeys = options.maxKeys ?? 1_000
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) throw new Error('maxKeys must be a positive integer')
  }

  registerProfile(profile: RateLimitProfile): () => void {
    validateRateProfile(profile)
    if (this.profiles.has(profile.id)) throw new Error(`Rate profile already registered: ${profile.id}`)
    this.profiles.set(profile.id, profile)
    return () => {
      if (this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id)
    }
  }

  getProfile(id: string): RateLimitProfile | undefined {
    return this.profiles.get(id)
  }

  consume(profileId: string, key: string, now = this.clock()): RateLimitDecision {
    const profile = this.profiles.get(profileId)
    if (!profile) {
      return { allowed: false, reason: 'Unknown rate profile', profileId, key, count: 0, limit: 0, resetAt: now }
    }
    validateClock(now)
    validateBoundedIdentifier(key, 'rate key', 160)
    const windowStart = Math.floor(now / profile.windowMs) * profile.windowMs
    const stateKey = `${profile.id}:${key}`
    let current = this.windows.get(stateKey)
    if (current && current.windowStart !== windowStart) current = undefined
    if (!current) {
      this.pruneExpired(now)
      if (!this.windows.has(stateKey) && this.windows.size >= this.maxKeys) {
        return { allowed: false, reason: 'Rate limiter capacity exhausted', profileId, key, count: 0, limit: profile.maxRequests, resetAt: windowStart + profile.windowMs }
      }
      current = { windowStart, count: 0 }
      this.windows.set(stateKey, current)
    }
    if (current.count >= profile.maxRequests) {
      return { allowed: false, reason: 'Rate limit exceeded', profileId, key, count: current.count, limit: profile.maxRequests, resetAt: current.windowStart + profile.windowMs }
    }
    current.count += 1
    return { allowed: true, reason: 'Rate limit allowed', profileId, key, count: current.count, limit: profile.maxRequests, resetAt: current.windowStart + profile.windowMs }
  }

  clear(): void {
    this.windows.clear()
  }

  private pruneExpired(now: number): void {
    for (const [key, state] of this.windows) {
      const profileId = key.slice(0, key.indexOf(':'))
      const profile = this.profiles.get(profileId)
      if (!profile || state.windowStart + profile.windowMs <= now) this.windows.delete(key)
    }
  }
}

export interface ProviderCircuitBreakerOptions {
  readonly failureThreshold?: number
  readonly cooldownMs?: number
  readonly halfOpenMaxCalls?: number
  readonly clock?: () => number
}

export interface ProviderCircuitDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly state: ProviderCircuitState
  readonly retryAt?: number
}

export class ProviderCircuitBreaker {
  private stateValue: ProviderCircuitState = 'closed'
  private failureCount = 0
  private openedAt: number | undefined
  private halfOpenCalls = 0
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly halfOpenMaxCalls: number
  private readonly clock: () => number

  constructor(options: ProviderCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1
    this.clock = options.clock ?? (() => Date.now())
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) throw new Error('failureThreshold must be a positive integer')
    if (!Number.isInteger(this.cooldownMs) || this.cooldownMs < 1) throw new Error('cooldownMs must be a positive integer')
    if (!Number.isInteger(this.halfOpenMaxCalls) || this.halfOpenMaxCalls < 1) throw new Error('halfOpenMaxCalls must be a positive integer')
  }

  get state(): ProviderCircuitState {
    return this.stateValue
  }

  allow(now = this.clock()): ProviderCircuitDecision {
    validateClock(now)
    if (this.stateValue === 'closed') return { allowed: true, reason: 'Provider circuit closed', state: 'closed' }
    if (this.stateValue === 'open') {
      const retryAt = (this.openedAt ?? now) + this.cooldownMs
      if (now < retryAt) return { allowed: false, reason: 'Provider circuit open', state: 'open', retryAt }
      this.stateValue = 'half-open'
      this.halfOpenCalls = 0
    }
    if (this.halfOpenCalls >= this.halfOpenMaxCalls) return { allowed: false, reason: 'Provider circuit probe capacity exhausted', state: 'half-open' }
    this.halfOpenCalls += 1
    return { allowed: true, reason: 'Provider circuit half-open probe allowed', state: 'half-open' }
  }

  recordSuccess(now = this.clock()): void {
    validateClock(now)
    this.stateValue = 'closed'
    this.failureCount = 0
    this.openedAt = undefined
    this.halfOpenCalls = 0
  }

  recordFailure(now = this.clock()): void {
    validateClock(now)
    if (this.stateValue === 'half-open') {
      this.open(now)
      return
    }
    this.failureCount += 1
    if (this.failureCount >= this.failureThreshold) this.open(now)
  }

  private open(now: number): void {
    this.stateValue = 'open'
    this.openedAt = now
    this.halfOpenCalls = 0
  }
}

export interface AuditRecordInput {
  readonly eventId?: string
  readonly eventType: string
  readonly schemaVersion?: number
  readonly namespace: string
  readonly occurredAt: number
  readonly actorJid?: string
  readonly resourceJid?: string
  readonly outcome: GuardrailOutcome
  readonly correlationId?: string
  readonly metadata?: Record<string, unknown>
}

export interface GuardrailAuditRecord {
  readonly eventId: string
  readonly eventType: string
  readonly schemaVersion: number
  readonly namespace: string
  readonly occurredAt: number
  readonly actorHash?: string
  readonly resourceHash?: string
  readonly outcome: GuardrailOutcome
  readonly correlationId?: string
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
}

export function createGuardrailAuditRecord(input: AuditRecordInput): GuardrailAuditRecord {
  validateAuditInput(input)
  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    namespace: input.namespace,
    occurredAt: input.occurredAt,
    ...(input.actorJid === undefined ? {} : { actorHash: hashIdentifier(input.actorJid) }),
    ...(input.resourceJid === undefined ? {} : { resourceHash: hashIdentifier(input.resourceJid) }),
    outcome: input.outcome,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    metadata: sanitizeAuditMetadata(input.metadata),
  }
}

export function hashIdentifier(value: string): string {
  if (!isJid(value)) throw new Error('Audit identifier must be a valid JID')
  return createHash('sha256').update(value.trim()).digest('hex').slice(0, 16)
}

function sanitizeAuditMetadata(metadata: Record<string, unknown> | undefined): Readonly<Record<string, string | number | boolean | null>> {
  if (metadata === undefined) return {}
  const entries = Object.entries(metadata)
  if (entries.length > MAX_AUDIT_METADATA_KEYS) throw new Error('Audit metadata has too many keys')
  const safe: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of entries) {
    validateMetadataKey(key)
    if (FORBIDDEN_AUDIT_KEY.test(key)) throw new Error(`Audit metadata key is not allowed: ${key}`)
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'object' && value !== null)) {
      throw new Error(`Audit metadata value must be scalar: ${key}`)
    }
    if (typeof value === 'string' && value.length > MAX_AUDIT_STRING_LENGTH) throw new Error(`Audit metadata value is too long: ${key}`)
    if (typeof value === 'string' && SECRET_LIKE_VALUE.test(value)) throw new Error(`Audit metadata value looks sensitive: ${key}`)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Audit metadata number is invalid: ${key}`)
    safe[key] = value as string | number | boolean | null
  }
  return safe
}

function validatePolicy(policy: GuardrailPolicyDefinition): void {
  validateNamespacedIdentifier(policy.id, 'policy id', MAX_IDENTIFIER_LENGTH)
  validateVersion(policy.version, 'policy version')
  validateNamespacedIdentifier(policy.action, 'policy action', MAX_IDENTIFIER_LENGTH)
  validateScope(policy.scope)
  validateDescription(policy.description, 'policy description')
  if (policy.featureId !== undefined) validateNamespacedIdentifier(policy.featureId, 'policy feature id', MAX_IDENTIFIER_LENGTH)
  if (policy.rateProfileId !== undefined) validateNamespacedIdentifier(policy.rateProfileId, 'policy rate profile id', MAX_IDENTIFIER_LENGTH)
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') throw new Error('policy enabled must be boolean')
}

function validatePolicyRequest(request: GuardrailPolicyRequest): void {
  validateNamespacedIdentifier(request.policyId, 'policy id', MAX_IDENTIFIER_LENGTH)
  validateNamespacedIdentifier(request.action, 'policy action', MAX_IDENTIFIER_LENGTH)
  validateScope(request.scope)
}

function validateAction(action: SafeActionDefinition): void {
  validateNamespacedIdentifier(action.id, 'action id', MAX_IDENTIFIER_LENGTH)
  validateVersion(action.version, 'action version')
  validateDescription(action.description, 'action description')
  validateVersion(action.inputSchemaVersion, 'action input schema version')
  if (!['low', 'medium', 'high'].includes(action.risk)) throw new Error(`Invalid action risk: ${action.id}`)
  if (action.requiredPermission !== undefined) validateNamespacedIdentifier(action.requiredPermission, 'action permission', MAX_IDENTIFIER_LENGTH)
  if (action.featureId !== undefined) validateNamespacedIdentifier(action.featureId, 'action feature id', MAX_IDENTIFIER_LENGTH)
  if (action.enabled !== undefined && typeof action.enabled !== 'boolean') throw new Error('action enabled must be boolean')
}

function validateRateProfile(profile: RateLimitProfile): void {
  validateNamespacedIdentifier(profile.id, 'rate profile id', MAX_IDENTIFIER_LENGTH)
  if (!Number.isInteger(profile.maxRequests) || profile.maxRequests < 1) throw new Error(`Invalid rate profile maxRequests: ${profile.id}`)
  if (!Number.isInteger(profile.windowMs) || profile.windowMs < 1) throw new Error(`Invalid rate profile windowMs: ${profile.id}`)
}

function validateAuditInput(input: AuditRecordInput): void {
  if (input.eventId !== undefined) validateBoundedIdentifier(input.eventId, 'audit event id', 128)
  validateEventType(input.eventType)
  if (input.schemaVersion !== undefined && (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)) throw new Error('Audit schemaVersion must be a positive integer')
  validateBoundedIdentifier(input.namespace, 'audit namespace', MAX_IDENTIFIER_LENGTH)
  validateClock(input.occurredAt)
  if (input.actorJid !== undefined && !isJid(input.actorJid)) throw new Error('Audit actorJid must be a valid JID')
  if (input.resourceJid !== undefined && !isJid(input.resourceJid)) throw new Error('Audit resourceJid must be a valid JID')
  if (input.correlationId !== undefined) validateBoundedIdentifier(input.correlationId, 'audit correlation id', MAX_CORRELATION_ID_LENGTH)
  if (!['allowed', 'denied', 'changed', 'failed', 'limited', 'opened', 'closed'].includes(input.outcome)) throw new Error(`Invalid audit outcome: ${input.outcome}`)
}

function validateEventType(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH || !/^[-a-z0-9]+(?:\.[-a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid audit event type: ${value}`)
  }
}

function validateMetadataKey(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid audit metadata key: ${value}`)
  }
}

function validateNamespacedIdentifier(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(value)) throw new Error(`Invalid ${field}: ${value}`)
}

function validateScope(scope: GuardrailScope): void {
  if (!['global', 'user', 'group'].includes(scope)) throw new Error(`Invalid guardrail scope: ${scope}`)
}

function validateVersion(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
}

function validateDescription(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DESCRIPTION_LENGTH) throw new Error(`${field} must be non-empty and bounded`)
}

function validateBoundedIdentifier(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || !isSafeIdentifier(value)) throw new Error(`Invalid ${field}: ${value}`)
}

function validateClock(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('Clock value must be a finite non-negative number')
}
