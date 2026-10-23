/**
 * @module aegis-queue-service
 * Unified Two-Plane Task Execution, Per-JID DRR Traffic Shaper, Meta-BBR Adaptive Pacer,
 * and Single-Writer Baileys Socket Engine for Allybot.
 */

import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type {
  CoreMessage,
  CoreMessageKey,
  Service,
  ServiceContext,
  WhatsAppMediaPayload,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../../framework/contracts.js'
import type { RedisClientInterface, RedisService } from '../../redis.js'
import {
  DRRScheduler,
  computePacketCost,
  type DRRSchedulerMetrics,
  type DRRSchedulerOptions,
  type OutboundPayloadKind,
} from './drr-scheduler.js'
import {
  AdaptivePacer,
  type AdaptivePacerOptions,
  type AdaptivePacerSnapshot,
  type BaileysMessageStatusUpdate,
} from './adaptive-pacer.js'

export type ExecutionPlane = 'auto' | 'hot' | 'durable'

export type AegisOutboundPayload =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly options?: WhatsAppSendOptions
    }
  | {
      readonly kind: 'media'
      readonly media: WhatsAppMediaPayload
    }
  | {
      readonly kind: 'reaction'
      readonly key: CoreMessageKey
      readonly emoji: string
    }
  | {
      readonly kind: 'custom'
      readonly payloadKind?: OutboundPayloadKind
      readonly estimatedBytes?: number
      readonly send: (whatsapp: WhatsAppPort, remoteJid: string) => Promise<string | void>
    }

export interface AegisTask<TResult = void> {
  /** Optional unique task ID (auto-generated UUID if omitted) */
  readonly id?: string
  /** Target WhatsApp chat/group JID (`remoteJid`) for DRR fairness isolation */
  readonly remoteJid: string
  /** Execution plane selection: `'hot'` (<500ms), `'durable'` (>1s), or `'auto'` (default: `'auto'`) */
  readonly plane?: ExecutionPlane
  /** Estimated compute duration in ms; used for `'auto'` plane routing and DRR CPU cost */
  readonly estimatedDurationMs?: number
  /** Expected outbound media/text kind for DRR cost calculation */
  readonly outboundKind?: OutboundPayloadKind
  /** Expected outbound payload size in bytes for DRR cost calculation */
  readonly estimatedBytes?: number
  /** Optional explicit DRR cost override */
  readonly explicitCost?: number
  /** Source message for speculative latency-hiding emoji reaction (`⏳` -> `✅`) */
  readonly sourceMessage?: Pick<CoreMessage, 'id' | 'remoteJid' | 'fromMe' | 'senderJid' | 'rawKey'>
  /** Enable speculative reaction (`⏳` on start, `✅` on delivery). Default: `false` unless `sourceMessage` is set */
  readonly speculativeReaction?: boolean
  /** Custom pending/success/error emojis for speculative latency hiding */
  readonly reactionEmojis?: {
    readonly pending?: string
    readonly success?: string
    readonly failure?: string
  }
  /** Maximum retry attempts for Durable-Plane tasks (default: 3) */
  readonly maxRetries?: number
  /**
   * Task producer function. May return an `AegisOutboundPayload` (or array of payloads)
   * to be dispatched safely through the Single-Writer DRR + BBR Pacer loop, plus an arbitrary `result`.
   */
  readonly execute: () => Promise<{
    readonly outbound?: AegisOutboundPayload | readonly AegisOutboundPayload[]
    readonly result?: TResult
  } | AegisOutboundPayload | void>
}

export interface AegisDispatchReceipt<TResult = void> {
  readonly taskId: string
  readonly planeUsed: 'hot' | 'durable'
  readonly remoteJid: string
  readonly computeDurationMs: number
  readonly outboundWaitMs: number
  readonly totalElapsedMs: number
  readonly costCharged: number
  readonly retriesUsed: number
  readonly result?: TResult
}

/**
 * Compatible interface for `p-queue` or custom in-memory concurrency pools.
 */
export interface HotQueueLike {
  add<T>(fn: () => Promise<T>): Promise<T>
  readonly size: number
  readonly pending: number
  onIdle?(): Promise<void>
  clear?(): void
}

/**
 * Compatible interface for `bullmq` Queue/Worker or custom Redis 8 durable job runners.
 */
export interface DurableQueueAdapter {
  enqueueAndWait<T>(
    jobId: string,
    remoteJid: string,
    fn: () => Promise<T>,
    maxRetries: number,
  ): Promise<{ value: T; retriesUsed: number }>
  close(): Promise<void>
  readonly deadLetterCount: number
}

export interface AegisQueueServiceOptions {
  readonly drr?: DRRSchedulerOptions
  readonly pacer?: AdaptivePacerOptions
  /** Threshold in ms above which `'auto'` tasks route to the Durable-Plane (default: 500) */
  readonly durableThresholdMs?: number
  /** Max concurrent tasks in the Hot-Plane pool (default: 8) */
  readonly hotConcurrency?: number
  /** Max concurrent jobs in the Durable-Plane worker pool (default: 4) */
  readonly durableConcurrency?: number
  /** Default retry count for failed Durable-Plane jobs (default: 3) */
  readonly defaultDurableRetries?: number
  /** Base retry backoff delay in ms for Durable-Plane jobs (default: 500) */
  readonly retryBackoffBaseMs?: number
  /** Enable BBR + Gaussian pacing in the single-writer loop (default: true) */
  readonly enablePacing?: boolean
  /** Periodic idle flow & stale ACK cleanup interval in ms (default: 30_000) */
  readonly cleanupIntervalMs?: number
  /** Graceful shutdown drain timeout in ms (default: 10_000) */
  readonly drainTimeoutMs?: number
  /** Optional injected `p-queue` instance */
  readonly hotQueue?: HotQueueLike
  /** Optional injected `bullmq` or Redis 8 durable adapter */
  readonly durableAdapter?: DurableQueueAdapter
  /** Optional Allybot `RedisService` or `RedisClientInterface` for Redis-backed durable state */
  readonly redis?: RedisService | RedisClientInterface
  /** Custom clock for deterministic unit testing (default: Date.now) */
  readonly clock?: () => number
}

export interface AegisQueueTelemetry {
  readonly drr: DRRSchedulerMetrics
  readonly pacer: AdaptivePacerSnapshot
  readonly hotPlane: {
    readonly queued: number
    readonly active: number
    readonly completed: number
  }
  readonly durablePlane: {
    readonly queued: number
    readonly active: number
    readonly completed: number
    readonly retriesTotal: number
    readonly deadLetterCount: number
  }
  readonly singleWriter: {
    readonly isRunning: boolean
    readonly totalDispatchedMessages: number
    readonly totalSendErrors: number
  }
}

interface OutboundWriterItem {
  readonly taskId: string
  readonly remoteJid: string
  readonly payload: AegisOutboundPayload
  readonly cost: number
  readonly enqueuedAt: number
  readonly resolve: (waitedMs: number) => void
  readonly reject: (err: unknown) => void
}

/**
 * Built-in Zero-Allocation Semaphore / Concurrency Pool (`p-queue` compatible)
 * for Hot-Plane execution when an external `p-queue` instance is not injected.
 */
class NativeConcurrencyPool implements HotQueueLike {
  private activeCount = 0
  private readonly queue: Array<() => void> = []
  private readonly idleResolvers: Array<() => void> = []

  constructor(private readonly concurrency: number) {}

  get size(): number {
    return this.queue.length
  }

  get pending(): number {
    return this.activeCount
  }

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeCount++
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.activeCount--
            const next = this.queue.shift()
            if (next) {
              next()
            } else if (this.activeCount === 0) {
              while (this.idleResolvers.length > 0) {
                this.idleResolvers.shift()!()
              }
            }
          })
      }

      if (this.activeCount < this.concurrency) {
        run()
      } else {
        this.queue.push(run)
      }
    })
  }

  onIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  clear(): void {
    this.queue.length = 0
  }
}

/**
 * Resilient Durable-Plane Job Runner supporting Redis 8 metadata persistence
 * (when Redis is available) with exponential backoff retry and dead-letter accounting.
 */
class ResilientDurableRunner implements DurableQueueAdapter {
  private readonly pool: NativeConcurrencyPool
  private deadLetters = 0

  constructor(
    concurrency: number,
    private readonly retryBackoffBaseMs: number,
    private readonly redis?: RedisService | RedisClientInterface,
    private readonly logger?: Logger,
  ) {
    this.pool = new NativeConcurrencyPool(concurrency)
  }

  get deadLetterCount(): number {
    return this.deadLetters
  }

  get queuedCount(): number {
    return this.pool.size
  }

  get activeCount(): number {
    return this.pool.pending
  }

  async enqueueAndWait<T>(
    jobId: string,
    remoteJid: string,
    fn: () => Promise<T>,
    maxRetries: number,
  ): Promise<{ value: T; retriesUsed: number }> {
    // Persist job metadata in Redis 8 if a raw Redis client is provided (fail-soft)
    await this.recordJobStateInRedis(jobId, 'active', remoteJid)

    return this.pool.add(async () => {
      let attempt = 0
      while (true) {
        try {
          const value = await fn()
          await this.recordJobStateInRedis(jobId, 'completed', remoteJid)
          return { value, retriesUsed: attempt }
        } catch (err) {
          if (attempt >= maxRetries) {
            this.deadLetters++
            await this.recordJobStateInRedis(jobId, 'dead-letter', remoteJid)
            this.logger?.warn(
              { jobId, attempts: attempt + 1, deadLetters: this.deadLetters },
              'AegisQueue durable job exhausted retries and entered dead-letter state',
            )
            throw err
          }
          attempt++
          const backoffMs = Math.min(5_000, this.retryBackoffBaseMs * Math.pow(2, attempt - 1))
          await new Promise((r) => setTimeout(r, backoffMs))
        }
      }
    })
  }

  async close(): Promise<void> {
    this.pool.clear()
    await this.pool.onIdle()
  }

  private async recordJobStateInRedis(
    jobId: string,
    status: 'active' | 'completed' | 'dead-letter',
    _remoteJid: string,
  ): Promise<void> {
    if (!this.redis) return
    try {
      const client = this.resolveRedisClient()
      if (!client) return
      const key = `allybot:aegis:job:${jobId}`
      if (status === 'completed') {
        await client.del(key)
      } else {
        await client.set(key, JSON.stringify({ status, updatedAt: Date.now() }), 'EX', 3600)
      }
    } catch {
      // Fail-soft per Allybot HANDOFF.md architecture
    }
  }

  private resolveRedisClient(): RedisClientInterface | undefined {
    if (!this.redis) return undefined
    if ('set' in this.redis && typeof this.redis.set === 'function') {
      return this.redis as RedisClientInterface
    }
    return undefined
  }
}

export class AegisQueueService implements Service {
  readonly name = 'aegis-queue'

  readonly drr: DRRScheduler<OutboundWriterItem>
  readonly pacer: AdaptivePacer

  private readonly durableThresholdMs: number
  private readonly defaultDurableRetries: number
  private readonly enablePacing: boolean
  private readonly cleanupIntervalMs: number
  private readonly drainTimeoutMs: number
  private readonly clock: () => number

  private readonly hotQueue: HotQueueLike
  private readonly durableRunner: DurableQueueAdapter & {
    readonly queuedCount?: number
    readonly activeCount?: number
  }

  private cleanupTimer: NodeJS.Timeout | null = null
  private writerLoopPromise: Promise<void> | null = null
  private writerWakeResolver: (() => void) | null = null
  private shuttingDown = false

  private hotCompletedCount = 0
  private durableCompletedCount = 0
  private durableRetriesTotal = 0
  private totalDispatchedMessages = 0
  private totalSendErrors = 0

  constructor(
    private readonly whatsapp: WhatsAppPort,
    private readonly logger?: Logger,
    options: AegisQueueServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now
    this.drr = new DRRScheduler<OutboundWriterItem>({
      ...options.drr,
      clock: this.clock,
    })
    this.pacer = new AdaptivePacer({
      ...options.pacer,
      clock: this.clock,
    })

    this.durableThresholdMs = Math.max(50, options.durableThresholdMs ?? 500)
    this.defaultDurableRetries = Math.max(0, options.defaultDurableRetries ?? 3)
    this.enablePacing = options.enablePacing ?? true
    this.cleanupIntervalMs = Math.max(1_000, options.cleanupIntervalMs ?? 30_000)
    this.drainTimeoutMs = Math.max(500, options.drainTimeoutMs ?? 10_000)

    this.hotQueue =
      options.hotQueue ?? new NativeConcurrencyPool(Math.max(1, options.hotConcurrency ?? 8))
    this.durableRunner =
      options.durableAdapter ??
      new ResilientDurableRunner(
        Math.max(1, options.durableConcurrency ?? 4),
        Math.max(10, options.retryBackoffBaseMs ?? 200),
        options.redis,
        this.logger,
      )
  }

  /**
   * Allybot `Service.initialize` lifecycle hook.
   * Starts the periodic memory-hygiene sweeper and binds Baileys ACK RTT listeners if available.
   */
  initialize(_context?: ServiceContext): void {
    this.shuttingDown = false
    this.startCleanupTimer()
    this.bindBaileysAckListener()
    this.logger?.info('AegisQueue service initialized (DRR + Meta-BBR Pacer + Two-Plane Engine)')
  }

  /**
   * Allybot `Service.shutdown` lifecycle hook.
   * Gracefully drains in-flight tasks and outbound packets, clears timers, and closes durable adapters.
   */
  async shutdown(_context?: ServiceContext): Promise<void> {
    this.shuttingDown = true
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Wake single-writer loop so it can finish draining remaining items
    this.wakeSingleWriter()

    const waitBounded = async (promise: Promise<void> | null | undefined): Promise<void> => {
      if (!promise) return
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          promise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.drainTimeoutMs)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    await waitBounded(this.writerLoopPromise)
    if (this.hotQueue.onIdle) {
      await waitBounded(this.hotQueue.onIdle())
    }

    await this.durableRunner.close()
    this.pacer.shutdown()
    this.drr.clear()
    this.logger?.info('AegisQueue service shut down cleanly')
  }

  /**
   * Unified Developer-Facing API: Dispatches a task to the Hot-Plane or Durable-Plane,
   * manages speculative latency-hiding reactions (`⏳` -> `✅`), and serializes all outbound
   * socket writes through the Per-JID DRR Scheduler and Meta-BBR Adaptive Pacer.
   */
  async dispatch<TResult = void>(task: AegisTask<TResult>): Promise<AegisDispatchReceipt<TResult>> {
    if (this.shuttingDown) {
      throw new Error('AegisQueueService is shutting down and cannot accept new tasks')
    }

    const taskId = task.id ?? randomUUID()
    const startedAt = this.clock()
    const planeToUse = this.resolvePlane(task)

    const useSpeculativeReaction =
      task.speculativeReaction ?? Boolean(task.sourceMessage?.id && this.whatsapp.sendReaction)
    const pendingEmoji = task.reactionEmojis?.pending ?? '⏳'
    const successEmoji = task.reactionEmojis?.success ?? '✅'
    const failureEmoji = task.reactionEmojis?.failure ?? '❌'

    if (useSpeculativeReaction && task.sourceMessage) {
      await this.sendSpeculativeReaction(task.sourceMessage, pendingEmoji)
    }

    let retriesUsed = 0
    let taskOutput:
      | {
          readonly outbound?: AegisOutboundPayload | readonly AegisOutboundPayload[]
          readonly result?: TResult
        }
      | AegisOutboundPayload
      | void

    const computeStart = this.clock()
    try {
      if (planeToUse === 'hot') {
        taskOutput = await this.hotQueue.add(() => task.execute())
        this.hotCompletedCount++
      } else {
        const maxRetries = task.maxRetries ?? this.defaultDurableRetries
        const durableRes = await this.durableRunner.enqueueAndWait(
          taskId,
          task.remoteJid,
          () => task.execute(),
          maxRetries,
        )
        taskOutput = durableRes.value
        retriesUsed = durableRes.retriesUsed
        this.durableRetriesTotal += retriesUsed
        this.durableCompletedCount++
      }
    } catch (error) {
      if (useSpeculativeReaction && task.sourceMessage) {
        await this.sendSpeculativeReaction(task.sourceMessage, failureEmoji)
      }
      throw error
    }
    const computeDurationMs = Math.max(0, this.clock() - computeStart)

    // Normalize outbound payloads returned by the task
    const outboundPayloads = this.extractOutboundPayloads(taskOutput)
    let outboundWaitMs = 0
    let totalCostCharged = 0

    for (let i = 0; i < outboundPayloads.length; i++) {
      const payload = outboundPayloads[i]
      const cost = this.estimatePayloadCost(payload, task, computeDurationMs)
      totalCostCharged += cost
      const waited = await this.enqueueOutbound(
        task.remoteJid,
        `${taskId}:${i}`,
        payload,
        cost,
      )
      outboundWaitMs += waited
    }

    if (useSpeculativeReaction && task.sourceMessage) {
      await this.sendSpeculativeReaction(task.sourceMessage, successEmoji)
    }

    const extractedResult = this.extractTaskResult<TResult>(taskOutput)

    return {
      taskId,
      planeUsed: planeToUse,
      remoteJid: task.remoteJid,
      computeDurationMs,
      outboundWaitMs,
      totalElapsedMs: Math.max(0, this.clock() - startedAt),
      costCharged: totalCostCharged,
      retriesUsed,
      result: extractedResult,
    }
  }

  /**
   * Enqueues a pre-built outbound payload directly into the Per-JID DRR Scheduler
   * and awaits its serialized dispatch through the Single-Writer Baileys loop.
   */
  enqueueOutbound(
    remoteJid: string,
    packetId: string,
    payload: AegisOutboundPayload,
    explicitCost?: number,
  ): Promise<number> {
    const cost =
      explicitCost ??
      this.estimatePayloadCost(payload, { remoteJid, execute: async () => {} }, 0)

    return new Promise<number>((resolve, reject) => {
      const writerItem: OutboundWriterItem = {
        taskId: packetId,
        remoteJid,
        payload,
        cost,
        enqueuedAt: this.clock(),
        resolve,
        reject,
      }

      const accepted = this.drr.enqueue(remoteJid, packetId, writerItem, cost)
      if (!accepted) {
        reject(new Error(`AegisQueue backpressure limit exceeded for JID`))
        return
      }

      this.ensureSingleWriterRunning()
      this.wakeSingleWriter()
    })
  }

  /**
   * Exposes live telemetry across the DRR Scheduler, BBR Adaptive Pacer,
   * Hot-Plane, Durable-Plane, and Single-Writer loop.
   */
  getTelemetry(): AegisQueueTelemetry {
    return {
      drr: this.drr.getMetrics(),
      pacer: this.pacer.getSnapshot(),
      hotPlane: {
        queued: this.hotQueue.size,
        active: this.hotQueue.pending,
        completed: this.hotCompletedCount,
      },
      durablePlane: {
        queued: this.durableRunner.queuedCount ?? 0,
        active: this.durableRunner.activeCount ?? 0,
        completed: this.durableCompletedCount,
        retriesTotal: this.durableRetriesTotal,
        deadLetterCount: this.durableRunner.deadLetterCount,
      },
      singleWriter: {
        isRunning: this.writerLoopPromise !== null,
        totalDispatchedMessages: this.totalDispatchedMessages,
        totalSendErrors: this.totalSendErrors,
      },
    }
  }

  private resolvePlane<TResult>(task: AegisTask<TResult>): 'hot' | 'durable' {
    if (task.plane === 'hot') return 'hot'
    if (task.plane === 'durable') return 'durable'
    const est = task.estimatedDurationMs ?? 50
    return est > this.durableThresholdMs ? 'durable' : 'hot'
  }

  private extractOutboundPayloads<TResult>(
    output:
      | {
          readonly outbound?: AegisOutboundPayload | readonly AegisOutboundPayload[]
          readonly result?: TResult
        }
      | AegisOutboundPayload
      | void,
  ): readonly AegisOutboundPayload[] {
    if (!output) return []
    if ('kind' in output && typeof output.kind === 'string') {
      return [output as AegisOutboundPayload]
    }
    if ('outbound' in output && output.outbound) {
      return Array.isArray(output.outbound)
        ? output.outbound
        : [output.outbound as AegisOutboundPayload]
    }
    return []
  }

  private extractTaskResult<TResult>(
    output:
      | {
          readonly outbound?: AegisOutboundPayload | readonly AegisOutboundPayload[]
          readonly result?: TResult
        }
      | AegisOutboundPayload
      | void,
  ): TResult | undefined {
    if (!output) return undefined
    if ('result' in output) return output.result
    return undefined
  }

  private estimatePayloadCost<TResult>(
    payload: AegisOutboundPayload,
    task: AegisTask<TResult>,
    computeDurationMs: number,
  ): number {
    if (task.explicitCost !== undefined) {
      return computePacketCost({ kind: 'text', explicitCost: task.explicitCost })
    }

    const cpuMs = task.estimatedDurationMs ?? computeDurationMs
    if (payload.kind === 'text') {
      return computePacketCost({
        kind: 'text',
        textLength: payload.text.length,
        estimatedCpuMs: cpuMs,
      })
    }
    if (payload.kind === 'reaction') {
      return computePacketCost({
        kind: 'reaction',
        estimatedCpuMs: cpuMs,
      })
    }
    if (payload.kind === 'media') {
      return computePacketCost({
        kind: payload.media.kind,
        sizeBytes: payload.media.data.byteLength,
        estimatedCpuMs: cpuMs,
      })
    }
    return computePacketCost({
      kind: payload.payloadKind ?? task.outboundKind ?? 'text',
      sizeBytes: payload.estimatedBytes ?? task.estimatedBytes ?? 0,
      estimatedCpuMs: cpuMs,
    })
  }

  /**
   * Ensures only ONE Single-Writer coroutine is active at any point in time,
   * eliminating Libsignal E2E session race conditions and socket bufferbloat.
   */
  private ensureSingleWriterRunning(): void {
    if (this.writerLoopPromise) return
    this.writerLoopPromise = this.runSingleWriterLoop().finally(() => {
      this.writerLoopPromise = null
      if (this.drr.size > 0 && !this.shuttingDown) {
        this.ensureSingleWriterRunning()
      }
    })
  }

  private wakeSingleWriter(): void {
    if (this.writerWakeResolver) {
      const resolve = this.writerWakeResolver
      this.writerWakeResolver = null
      resolve()
    }
  }

  private async runSingleWriterLoop(): Promise<void> {
    while (true) {
      const nextScheduled = this.drr.dequeue()
      if (!nextScheduled) {
        if (this.shuttingDown) break
        await new Promise<void>((resolve) => {
          this.writerWakeResolver = resolve
        })
        if (this.shuttingDown && this.drr.size === 0) break
        continue
      }

      const item = nextScheduled.payload
      try {
        if (this.enablePacing) {
          // Scale token acquisition slightly for heavy media (1.0 token for normal, 1.5 for video)
          const tokenWeight =
            item.payload.kind === 'media' && item.payload.media.kind === 'video' ? 1.5 : 1.0
          await this.pacer.acquireToken(tokenWeight)
        }

        const sentAt = this.clock()
        const msgId = await this.executeSocketSend(item.remoteJid, item.payload)
        if (msgId) {
          this.pacer.trackOutboundMessage(msgId, sentAt)
        }
        this.totalDispatchedMessages++
        item.resolve(Math.max(0, this.clock() - item.enqueuedAt))
      } catch (err) {
        this.totalSendErrors++
        item.reject(err)
      }
    }
  }

  private async executeSocketSend(
    remoteJid: string,
    payload: AegisOutboundPayload,
  ): Promise<string | undefined> {
    if (payload.kind === 'text') {
      await this.whatsapp.sendText(remoteJid, payload.text, payload.options)
      return (this.whatsapp as { lastSentMessageId?: string }).lastSentMessageId
    }
    if (payload.kind === 'media') {
      if (!this.whatsapp.sendMedia) {
        throw new Error('WhatsAppPort.sendMedia is not available on the current transport')
      }
      await this.whatsapp.sendMedia(remoteJid, payload.media)
      return (this.whatsapp as { lastSentMessageId?: string }).lastSentMessageId
    }
    if (payload.kind === 'reaction') {
      if (this.whatsapp.sendReaction) {
        await this.whatsapp.sendReaction(remoteJid, payload.key, payload.emoji)
      }
      return undefined
    }
    const maybeId = await payload.send(this.whatsapp, remoteJid)
    return typeof maybeId === 'string' ? maybeId : undefined
  }

  private async sendSpeculativeReaction(
    sourceMessage: Pick<CoreMessage, 'id' | 'remoteJid' | 'fromMe' | 'senderJid' | 'rawKey'>,
    emoji: string,
  ): Promise<void> {
    if (!this.whatsapp.sendReaction) return
    const key: CoreMessageKey = sourceMessage.rawKey ?? {
      id: sourceMessage.id,
      remoteJid: sourceMessage.remoteJid,
      fromMe: sourceMessage.fromMe,
      ...(sourceMessage.senderJid ? { participant: sourceMessage.senderJid } : {}),
    }
    try {
      await this.enqueueOutbound(
        sourceMessage.remoteJid,
        `react:${sourceMessage.id}:${emoji}`,
        { kind: 'reaction', key, emoji },
        15,
      )
    } catch {
      // Speculative reactions are best-effort and must never fail the parent task
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = setInterval(() => {
      const now = this.clock()
      this.drr.pruneIdleFlows(now)
      this.pacer.pruneStaleInflightAcks(now)
    }, this.cleanupIntervalMs)
    this.cleanupTimer.unref?.()
  }

  private bindBaileysAckListener(): void {
    const attach = () => {
      const rawSocket = this.whatsapp.socket as
        | {
            ev?: {
              on?: (
                event: string,
                handler: (updates: readonly BaileysMessageStatusUpdate[]) => void,
              ) => void
            }
          }
        | undefined

      if (rawSocket?.ev?.on) {
        rawSocket.ev.on('messages.update', (updates) => {
          if (Array.isArray(updates)) {
            this.pacer.onBaileysMessagesUpdate(updates)
          }
        })
      }
    }

    attach()
    this.whatsapp.onConnectionState?.((event) => {
      if (event.status === 'connected') {
        attach()
      }
    })
  }
}
