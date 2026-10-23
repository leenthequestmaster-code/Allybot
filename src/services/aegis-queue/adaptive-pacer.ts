/**
 * @module adaptive-pacer
 * Meta-BBR Inspired Self-Tuning Telemetry Pacer & Gaussian Micro-Jitter Token Bucket.
 *
 * Solves Dilemma C (Static Pacing vs Meta Heuristic Anti-Ban & Bufferbloat):
 * 1. Measures live RTT to Meta servers by tracking Baileys `messages.update` transitions
 *    from `status: 2` (SERVER_SENT) to `status: 3` (DELIVERY_ACK).
 * 2. Maintains an Exponential Moving Average (EMA) of RTT ($\alpha = 0.2$) and RTT deviation.
 * 3. Dynamically adjusts the base dispatch interval $I_{\text{base}} \in [80\text{ms}, 400\text{ms}]$:
 *    - High RTT / congestion detected -> Multiplicative backoff ($I_{\text{base}} \leftarrow \min(I_{\max}, I_{\text{base}} \cdot \gamma)$).
 *    - Low RTT / healthy connection   -> Additive recovery ($I_{\text{base}} \leftarrow \max(I_{\min}, I_{\text{base}} - \Delta)$).
 * 4. Injects Box-Muller Gaussian Micro-Jitter ($\mu = I_{\text{base}}, \sigma = 15\text{ms}$) to eliminate
 *    robotic periodic signatures.
 * 5. Enforces a Single-Writer Token-Bucket rate limiter with `acquireToken()` promise gating.
 */

export type PacerCongestionState = 'CRUISE' | 'RECOVERY' | 'BACKOFF'

export interface BaileysMessageStatusUpdate {
  readonly key?: {
    readonly id?: string | null
    readonly remoteJid?: string | null
    readonly fromMe?: boolean | null
  }
  readonly update?: {
    readonly status?: number | null
  }
}

export interface AdaptivePacerOptions {
  /** Initial base pacing interval in ms ($\mu_0$, default: 120) */
  readonly initialIntervalMs?: number
  /** Minimum allowed base pacing interval in ms ($I_{\min}$, default: 80) */
  readonly minIntervalMs?: number
  /** Maximum allowed base pacing interval in ms ($I_{\max}$, default: 400) */
  readonly maxIntervalMs?: number
  /** Gaussian micro-jitter standard deviation in ms ($\sigma$, default: 15) */
  readonly jitterStdDevMs?: number
  /** EMA smoothing factor $\alpha \in (0, 1)$ for RTT telemetry (default: 0.2) */
  readonly emaAlpha?: number
  /** RTT threshold (ms) below which connection is considered healthy for additive recovery (default: 220) */
  readonly lowRttThresholdMs?: number
  /** RTT threshold (ms) above which multiplicative backoff is triggered (default: 350) */
  readonly highRttThresholdMs?: number
  /** Instant RTT spike threshold (ms) triggering immediate backoff (default: 550) */
  readonly spikeRttThresholdMs?: number
  /** Multiplicative backoff factor $\gamma > 1$ (default: 1.35) */
  readonly backoffMultiplier?: number
  /** Additive recovery step $\Delta$ in ms (default: 8) */
  readonly recoveryStepMs?: number
  /** Token bucket burst capacity (default: 3) */
  readonly bucketCapacity?: number
  /** Maximum in-flight message IDs tracked for ACK RTT to prevent memory leaks (default: 2048) */
  readonly maxInflightAcks?: number
  /** TTL in ms for unacknowledged message IDs before automatic pruning (default: 60_000) */
  readonly inflightAckTtlMs?: number
  /** Custom clock for deterministic unit tests (default: Date.now) */
  readonly clock?: () => number
  /** Custom RNG in (0, 1) for deterministic jitter tests (default: Math.random) */
  readonly random?: () => number
}

export interface AdaptivePacerSnapshot {
  readonly state: PacerCongestionState
  readonly baseIntervalMs: number
  readonly emaRttMs: number
  readonly rttVarMs: number
  readonly lastRttSampleMs: number | null
  readonly samplesCount: number
  readonly availableTokens: number
  readonly inflightAckCount: number
  readonly pendingWaiters: number
}

interface TokenWaiter {
  readonly requiredTokens: number
  readonly resolve: (delayWaitedMs: number) => void
  readonly enqueuedAt: number
}

const DEFAULT_INITIAL_INTERVAL_MS = 120
const DEFAULT_MIN_INTERVAL_MS = 80
const DEFAULT_MAX_INTERVAL_MS = 400
const DEFAULT_JITTER_STD_DEV_MS = 15
const DEFAULT_EMA_ALPHA = 0.2
const DEFAULT_LOW_RTT_THRESHOLD_MS = 220
const DEFAULT_HIGH_RTT_THRESHOLD_MS = 350
const DEFAULT_SPIKE_RTT_THRESHOLD_MS = 550
const DEFAULT_BACKOFF_MULTIPLIER = 1.35
const DEFAULT_RECOVERY_STEP_MS = 8
const DEFAULT_BUCKET_CAPACITY = 3
const DEFAULT_MAX_INFLIGHT_ACKS = 2_048
const DEFAULT_INFLIGHT_ACK_TTL_MS = 60_000

/**
 * Generates a standard normal random variable $Z \sim \mathcal{N}(0, 1)$
 * using the polar/trigonometric Box-Muller transform:
 * $$Z = \sqrt{-2 \ln(u_1)} \cdot \cos(2\pi u_2)$$
 * Clamped to $[-3, +3]$ standard deviations to prevent extreme tail stalls.
 */
export function boxMullerStandardNormal(randomFn: () => number = Math.random): number {
  // Guard u1 away from 0 to avoid Math.log(0) = -Infinity
  const u1 = Math.max(1e-7, Math.min(1 - 1e-7, randomFn()))
  const u2 = randomFn()
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
  return Math.max(-3.0, Math.min(3.0, z0))
}

export class AdaptivePacer {
  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly jitterStdDevMs: number
  private readonly emaAlpha: number
  private readonly lowRttThresholdMs: number
  private readonly highRttThresholdMs: number
  private readonly spikeRttThresholdMs: number
  private readonly backoffMultiplier: number
  private readonly recoveryStepMs: number
  private readonly bucketCapacity: number
  private readonly maxInflightAcks: number
  private readonly inflightAckTtlMs: number
  private readonly clock: () => number
  private readonly random: () => number

  private baseIntervalMs: number
  private emaRttMs: number
  private rttVarMs = 0
  private lastRttSampleMs: number | null = null
  private samplesCount = 0
  private state: PacerCongestionState = 'CRUISE'

  /** Bounded map of messageId -> sentTimestampMs for RTT measurement */
  private readonly inflightAcks = new Map<string, number>()

  /** Token bucket state */
  private tokens: number
  private lastRefillAt: number
  private lastDispatchAt = 0
  private readonly waiters: TokenWaiter[] = []
  private pumpTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(options: AdaptivePacerOptions = {}) {
    this.minIntervalMs = Math.max(20, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)
    this.maxIntervalMs = Math.max(this.minIntervalMs, options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS)
    this.baseIntervalMs = Math.max(
      this.minIntervalMs,
      Math.min(this.maxIntervalMs, options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS),
    )
    this.jitterStdDevMs = Math.max(0, options.jitterStdDevMs ?? DEFAULT_JITTER_STD_DEV_MS)
    this.emaAlpha = Math.max(0.01, Math.min(0.99, options.emaAlpha ?? DEFAULT_EMA_ALPHA))
    this.lowRttThresholdMs = options.lowRttThresholdMs ?? DEFAULT_LOW_RTT_THRESHOLD_MS
    this.highRttThresholdMs = options.highRttThresholdMs ?? DEFAULT_HIGH_RTT_THRESHOLD_MS
    this.spikeRttThresholdMs = options.spikeRttThresholdMs ?? DEFAULT_SPIKE_RTT_THRESHOLD_MS
    this.backoffMultiplier = Math.max(1.05, options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER)
    this.recoveryStepMs = Math.max(1, options.recoveryStepMs ?? DEFAULT_RECOVERY_STEP_MS)
    this.bucketCapacity = Math.max(1, options.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY)
    this.maxInflightAcks = Math.max(32, options.maxInflightAcks ?? DEFAULT_MAX_INFLIGHT_ACKS)
    this.inflightAckTtlMs = Math.max(1_000, options.inflightAckTtlMs ?? DEFAULT_INFLIGHT_ACK_TTL_MS)
    this.clock = options.clock ?? Date.now
    this.random = options.random ?? Math.random

    this.emaRttMs = this.baseIntervalMs
    this.tokens = this.bucketCapacity
    this.lastRefillAt = this.clock()
  }

  /**
   * Registers an outbound message ID when dispatched (`status: 2`) so its delivery receipt
   * (`status: 3`) can compute an exact server RTT sample.
   */
  trackOutboundMessage(messageId: string, sentAtMs = this.clock()): void {
    if (!messageId || this.stopped) return
    if (this.inflightAcks.size >= this.maxInflightAcks) {
      this.pruneStaleInflightAcks(sentAtMs)
      if (this.inflightAcks.size >= this.maxInflightAcks) {
        const oldestKey = this.inflightAcks.keys().next().value
        if (oldestKey !== undefined) this.inflightAcks.delete(oldestKey)
      }
    }
    this.inflightAcks.set(messageId, sentAtMs)
  }

  /**
   * Processes Baileys `messages.update` events.
   * When `update.status === 3` (DELIVERY_ACK) or `>= 3` matches a tracked outbound message ID,
   * computes RTT and feeds the BBR adaptive controller.
   *
   * @returns Number of valid RTT samples extracted.
   */
  onBaileysMessagesUpdate(
    updates: readonly BaileysMessageStatusUpdate[],
    nowMs = this.clock(),
  ): number {
    let extracted = 0
    for (let i = 0; i < updates.length; i++) {
      const item = updates[i]
      const msgId = item.key?.id
      const status = item.update?.status
      if (!msgId || status === null || status === undefined || status < 3) continue

      const sentAt = this.inflightAcks.get(msgId)
      if (sentAt !== undefined) {
        this.inflightAcks.delete(msgId)
        const rtt = Math.max(1, nowMs - sentAt)
        this.recordRttSample(rtt)
        extracted++
      }
    }
    return extracted
  }

  /**
   * Feeds a live RTT sample (in ms) into the BBR-inspired EMA filter and adjusts
   * the base pacing interval $I_{\text{base}} \in [I_{\min}, I_{\max}]$.
   */
  recordRttSample(rttMs: number): number {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return this.baseIntervalMs

    const clampedRtt = Math.max(5, Math.min(30_000, rttMs))
    this.lastRttSampleMs = clampedRtt

    if (this.samplesCount === 0) {
      this.emaRttMs = clampedRtt
      this.rttVarMs = clampedRtt * 0.25
    } else {
      const delta = Math.abs(clampedRtt - this.emaRttMs)
      this.rttVarMs = 0.25 * delta + 0.75 * this.rttVarMs
      this.emaRttMs = this.emaAlpha * clampedRtt + (1 - this.emaAlpha) * this.emaRttMs
    }
    this.samplesCount++

    // Congestion Window & Pacing Interval State Transitions
    if (clampedRtt >= this.spikeRttThresholdMs || this.emaRttMs >= this.highRttThresholdMs) {
      this.state = 'BACKOFF'
      this.baseIntervalMs = Math.min(
        this.maxIntervalMs,
        Math.round(this.baseIntervalMs * this.backoffMultiplier),
      )
    } else if (this.emaRttMs <= this.lowRttThresholdMs) {
      const step = Math.max(
        this.recoveryStepMs,
        Math.ceil((this.baseIntervalMs - this.minIntervalMs) * 0.15),
      )
      this.baseIntervalMs = Math.max(
        this.minIntervalMs,
        this.baseIntervalMs - step,
      )
      this.state = this.baseIntervalMs > DEFAULT_INITIAL_INTERVAL_MS ? 'RECOVERY' : 'CRUISE'
    } else {
      // Mid-band deadzone (between lowRttThresholdMs and highRttThresholdMs): hold steady
      if (this.state === 'BACKOFF') {
        this.state = 'RECOVERY'
      }
    }

    return this.baseIntervalMs
  }

  /**
   * Computes the next outbound pacing delay incorporating Box-Muller Gaussian Micro-Jitter:
   * $$D = \text{clamp}\left(\text{round}(I_{\text{base}} + \sigma \cdot Z),\; I_{\min} - 20,\; I_{\max} + 45\right)$$
   */
  computeNextDelayMs(): number {
    if (this.jitterStdDevMs <= 0) return this.baseIntervalMs
    const z = boxMullerStandardNormal(this.random)
    const jittered = Math.round(this.baseIntervalMs + z * this.jitterStdDevMs)
    const floor = Math.max(20, this.minIntervalMs - 20)
    const ceil = this.maxIntervalMs + 3 * this.jitterStdDevMs
    return Math.max(floor, Math.min(ceil, jittered))
  }

  /**
   * Acquires permission from the Token-Bucket + Gaussian Pacer to dispatch an outbound packet.
   * Serializes callers in FIFO order and resolves with the actual waited duration in ms.
   */
  acquireToken(requiredTokens = 1): Promise<number> {
    if (this.stopped) return Promise.resolve(0)
    const normalizedReq = Math.max(0.1, Math.min(this.bucketCapacity, requiredTokens))

    return new Promise<number>((resolve) => {
      this.waiters.push({
        requiredTokens: normalizedReq,
        resolve,
        enqueuedAt: this.clock(),
      })
      this.pumpWaiters()
    })
  }

  /**
   * Prunes unacknowledged message IDs older than `inflightAckTtlMs`.
   */
  pruneStaleInflightAcks(nowMs = this.clock()): number {
    let pruned = 0
    for (const [msgId, sentAt] of this.inflightAcks.entries()) {
      if (nowMs - sentAt >= this.inflightAckTtlMs) {
        this.inflightAcks.delete(msgId)
        pruned++
      }
    }
    return pruned
  }

  getSnapshot(): AdaptivePacerSnapshot {
    this.refillTokens(this.clock())
    return {
      state: this.state,
      baseIntervalMs: this.baseIntervalMs,
      emaRttMs: Math.round(this.emaRttMs * 100) / 100,
      rttVarMs: Math.round(this.rttVarMs * 100) / 100,
      lastRttSampleMs: this.lastRttSampleMs,
      samplesCount: this.samplesCount,
      availableTokens: Math.round(this.tokens * 100) / 100,
      inflightAckCount: this.inflightAcks.size,
      pendingWaiters: this.waiters.length,
    }
  }

  /**
   * Cancels any active pacing timer and drains pending token waiters immediately.
   */
  shutdown(): void {
    this.stopped = true
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }
    this.inflightAcks.clear()
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!
      w.resolve(0)
    }
  }

  private refillTokens(nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillAt)
    if (elapsedMs <= 0) return
    // Token refill rate is 1 token per `baseIntervalMs`
    const added = elapsedMs / this.baseIntervalMs
    this.tokens = Math.min(this.bucketCapacity, this.tokens + added)
    this.lastRefillAt = nowMs
  }

  private pumpWaiters(): void {
    if (this.stopped || this.pumpTimer || this.waiters.length === 0) return

    const now = this.clock()
    this.refillTokens(now)

    const head = this.waiters[0]
    const timeSinceLastDispatch = now - this.lastDispatchAt
    const targetJitteredGap = this.computeNextDelayMs()

    if (this.tokens >= head.requiredTokens && (this.lastDispatchAt === 0 || timeSinceLastDispatch >= targetJitteredGap)) {
      this.waiters.shift()
      this.tokens -= head.requiredTokens
      this.lastDispatchAt = now
      head.resolve(Math.max(0, now - head.enqueuedAt))
      if (this.waiters.length > 0) {
        this.pumpWaiters()
      }
      return
    }

    const tokenDeficit = Math.max(0, head.requiredTokens - this.tokens)
    const waitForTokensMs = Math.ceil(tokenDeficit * this.baseIntervalMs)
    const waitForJitterGapMs =
      this.lastDispatchAt === 0 ? 0 : Math.max(0, targetJitteredGap - timeSinceLastDispatch)
    const sleepMs = Math.max(5, waitForTokensMs, waitForJitterGapMs)

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      this.pumpWaiters()
    }, sleepMs)
  }
}
