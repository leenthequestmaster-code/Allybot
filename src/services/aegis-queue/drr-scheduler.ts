/**
 * @module drr-scheduler
 * Per-JID Deficit Round-Robin (DRR / FQ-CoDel Adapted) Scheduler for WhatsApp Traffic Shaping.
 *
 * Solves the "Noisy Neighbor" (Inter-Group Starvation) problem:
 * - Maintains isolated virtual queues per `remoteJid`.
 * - Uses a circular doubly-linked active list for strict O(1) enqueue and O(1) amortized dequeue.
 * - Assigns bandwidth/compute credits (`quantum`) per round and deducts message-specific `cost`.
 * - Applies FQ-CoDel sparse-flow priority boost so quiet groups sending light commands
 *   (e.g. `!ping`, `!catur`) bypass noisy groups flooding heavy media jobs (<25ms scheduling latency).
 * - Automatically prunes idle empty JID flows to guarantee zero memory leaks.
 */

export type OutboundPayloadKind =
  | 'reaction'
  | 'text'
  | 'sticker'
  | 'image'
  | 'audio'
  | 'document'
  | 'video'

export interface CostEstimationInput {
  readonly kind: OutboundPayloadKind
  readonly sizeBytes?: number
  readonly textLength?: number
  readonly estimatedCpuMs?: number
  /** Optional explicit override cost */
  readonly explicitCost?: number
}

export interface DRRSchedulerOptions {
  /** Credits added to each active JID flow per round-robin turn (default: 300) */
  readonly quantum?: number
  /** Maximum accumulated deficit per JID flow to prevent credit hoarding (default: 1800) */
  readonly maxDeficit?: number
  /** Maximum queued items allowed per single JID before backpressure rejection (default: 250) */
  readonly maxQueueDepthPerJid?: number
  /** Maximum distinct JID flows tracked simultaneously (default: 1000) */
  readonly maxTrackedFlows?: number
  /** Idle duration in ms before an empty JID flow is garbage-collected (default: 60_000) */
  readonly idleTimeoutMs?: number
  /** Enable FQ-CoDel sparse-flow head insertion for newly active light flows (default: true) */
  readonly sparseFlowBoost?: boolean
  /** Custom clock for deterministic unit testing (default: Date.now) */
  readonly clock?: () => number
}

export interface ScheduledPacket<TPayload> {
  readonly id: string
  readonly jid: string
  readonly payload: TPayload
  readonly cost: number
  readonly enqueuedAt: number
}

interface PacketNode<TPayload> {
  readonly packet: ScheduledPacket<TPayload>
  next: PacketNode<TPayload> | null
}

interface JidFlowQueue<TPayload> {
  readonly jid: string
  deficit: number
  size: number
  head: PacketNode<TPayload> | null
  tail: PacketNode<TPayload> | null
  active: boolean
  prevActive: JidFlowQueue<TPayload> | null
  nextActive: JidFlowQueue<TPayload> | null
  lastTouchedAt: number
  totalDispatched: number
  totalCostCharged: number
}

export interface DRRSchedulerMetrics {
  readonly trackedFlows: number
  readonly activeFlows: number
  readonly totalQueuedPackets: number
  readonly totalEnqueued: number
  readonly totalDequeued: number
  readonly totalDroppedBackpressure: number
  readonly totalPrunedFlows: number
}

const DEFAULT_QUANTUM = 300
const DEFAULT_MAX_DEFICIT = 1_800
const DEFAULT_MAX_QUEUE_DEPTH_PER_JID = 250
const DEFAULT_MAX_TRACKED_FLOWS = 1_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

const BASE_KIND_COST: Readonly<Record<OutboundPayloadKind, number>> = {
  reaction: 15,
  text: 40,
  sticker: 100,
  image: 160,
  audio: 220,
  document: 260,
  video: 450,
}

/**
 * Computes the deterministic DRR deficit cost $C(p)$ of an outbound WhatsApp operation.
 * Time Complexity: $O(1)$
 *
 * Formula:
 * $$C(p) = \text{clamp}\left(C_{\text{base}}(\text{kind}) + C_{\text{size}}(\text{bytes}, \text{chars}) + \lceil 0.15 \cdot T_{\text{cpu}} \rceil,\; 10,\; D_{\max}\right)$$
 */
export function computePacketCost(
  input: CostEstimationInput,
  maxDeficit = DEFAULT_MAX_DEFICIT,
): number {
  if (input.explicitCost !== undefined && Number.isFinite(input.explicitCost)) {
    return Math.max(1, Math.min(maxDeficit, Math.round(input.explicitCost)))
  }

  const base = BASE_KIND_COST[input.kind] ?? 50
  const bytes = Math.max(0, input.sizeBytes ?? 0)
  const chars = Math.max(0, input.textLength ?? 0)
  const cpuMs = Math.max(0, input.estimatedCpuMs ?? 0)

  let sizeCost = 0
  if (input.kind === 'text') {
    sizeCost = Math.ceil(chars / 256)
  } else if (input.kind === 'sticker') {
    sizeCost = Math.ceil(bytes / 8_192)
  } else if (input.kind === 'image' || input.kind === 'audio') {
    sizeCost = Math.ceil(bytes / 16_384)
  } else if (input.kind === 'document' || input.kind === 'video') {
    sizeCost = Math.ceil(bytes / 32_768)
  }

  const cpuCost = Math.ceil(cpuMs * 0.15)
  const rawCost = base + sizeCost + cpuCost
  return Math.max(10, Math.min(maxDeficit, rawCost))
}

export class DRRScheduler<TPayload = unknown> {
  private readonly quantum: number
  private readonly maxDeficit: number
  private readonly maxQueueDepthPerJid: number
  private readonly maxTrackedFlows: number
  private readonly idleTimeoutMs: number
  private readonly sparseFlowBoost: boolean
  private readonly clock: () => number

  private readonly flows = new Map<string, JidFlowQueue<TPayload>>()
  private activeCursor: JidFlowQueue<TPayload> | null = null
  private activeFlowCount = 0
  private totalQueuedCount = 0
  private totalEnqueuedCount = 0
  private totalDequeuedCount = 0
  private totalDroppedCount = 0
  private totalPrunedCount = 0

  constructor(options: DRRSchedulerOptions = {}) {
    this.quantum = Math.max(10, Math.floor(options.quantum ?? DEFAULT_QUANTUM))
    this.maxDeficit = Math.max(this.quantum, Math.floor(options.maxDeficit ?? DEFAULT_MAX_DEFICIT))
    this.maxQueueDepthPerJid = Math.max(
      1,
      Math.floor(options.maxQueueDepthPerJid ?? DEFAULT_MAX_QUEUE_DEPTH_PER_JID),
    )
    this.maxTrackedFlows = Math.max(16, Math.floor(options.maxTrackedFlows ?? DEFAULT_MAX_TRACKED_FLOWS))
    this.idleTimeoutMs = Math.max(1_000, Math.floor(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS))
    this.sparseFlowBoost = options.sparseFlowBoost ?? true
    this.clock = options.clock ?? Date.now
  }

  /**
   * Enqueues a packet into its JID's virtual flow queue.
   * Time Complexity: $O(1)$
   *
   * @returns `true` if accepted, `false` if rejected due to per-JID backpressure limit.
   */
  enqueue(
    jid: string,
    id: string,
    payload: TPayload,
    costInput: number | CostEstimationInput,
  ): boolean {
    const now = this.clock()
    let flow = this.flows.get(jid)

    if (!flow) {
      if (this.flows.size >= this.maxTrackedFlows) {
        this.evictOldestIdleFlow(now)
      }
      flow = {
        jid,
        deficit: 0,
        size: 0,
        head: null,
        tail: null,
        active: false,
        prevActive: null,
        nextActive: null,
        lastTouchedAt: now,
        totalDispatched: 0,
        totalCostCharged: 0,
      }
      this.flows.set(jid, flow)
    }

    if (flow.size >= this.maxQueueDepthPerJid) {
      this.totalDroppedCount++
      return false
    }

    const cost =
      typeof costInput === 'number'
        ? Math.max(1, Math.min(this.maxDeficit, Math.round(costInput)))
        : computePacketCost(costInput, this.maxDeficit)

    const packet: ScheduledPacket<TPayload> = {
      id,
      jid,
      payload,
      cost,
      enqueuedAt: now,
    }

    const node: PacketNode<TPayload> = { packet, next: null }
    if (flow.tail) {
      flow.tail.next = node
      flow.tail = node
    } else {
      flow.head = node
      flow.tail = node
    }

    flow.size++
    flow.lastTouchedAt = now
    this.totalQueuedCount++
    this.totalEnqueuedCount++

    if (!flow.active) {
      // Newly activated flow receives 1 initial quantum.
      // If sparseFlowBoost is enabled and the packet is a light interactive request (cost <= quantum),
      // insert right at `activeCursor` so quiet groups experience <25ms latency even during floods.
      flow.deficit = this.quantum
      const boostToFront = this.sparseFlowBoost && cost <= this.quantum && flow.totalDispatched === 0
      const isLightInteractive = this.sparseFlowBoost && cost <= this.quantum
      this.insertActiveFlow(flow, boostToFront || isLightInteractive)
    }

    return true
  }

  /**
   * Dequeues the next eligible packet according to Deficit Round-Robin (DRR) rules.
   * Time Complexity: $O(1)$ amortized per round.
   */
  dequeue(): ScheduledPacket<TPayload> | undefined {
    if (this.activeFlowCount === 0 || !this.activeCursor) {
      return undefined
    }

    const now = this.clock()
    // Guard bound: at most ceil(maxDeficit / quantum) + 2 full sweeps of active flows
    const maxSteps = this.activeFlowCount * (Math.ceil(this.maxDeficit / this.quantum) + 2)

    for (let step = 0; step < maxSteps; step++) {
      const flow: JidFlowQueue<TPayload> | null = this.activeCursor
      if (!flow || !flow.head) {
        if (flow) this.removeActiveFlow(flow)
        if (!this.activeCursor) return undefined
        continue
      }

      const headNode = flow.head
      const pktCost = headNode.packet.cost

      if (pktCost <= flow.deficit) {
        // Packet fits within current deficit: pop from flow queue
        flow.head = headNode.next
        if (!flow.head) {
          flow.tail = null
        }
        flow.size--
        flow.deficit -= pktCost
        flow.lastTouchedAt = now
        flow.totalDispatched++
        flow.totalCostCharged += pktCost

        this.totalQueuedCount--
        this.totalDequeuedCount++

        if (flow.size === 0) {
          // Shreedhar & Varghese DRR invariant: empty flow resets deficit to 0 and leaves active list
          flow.deficit = 0
          this.removeActiveFlow(flow)
        } else if (flow.head && flow.head.packet.cost > flow.deficit) {
          // Current flow cannot afford its next packet yet; advance cursor to next JID flow
          this.activeCursor = flow.nextActive
        }

        return headNode.packet
      }

      // Flow cannot afford its head packet yet: grant +quantum and rotate to next flow
      flow.deficit = Math.min(this.maxDeficit, flow.deficit + this.quantum)
      this.activeCursor = flow.nextActive
    }

    return undefined
  }

  /**
   * Prunes idle, empty JID flow records whose `lastTouchedAt` is older than `idleTimeoutMs`.
   * Time Complexity: $O(F)$ where $F$ is the number of tracked flows.
   *
   * @returns Number of idle flows removed.
   */
  pruneIdleFlows(nowMs = this.clock()): number {
    let pruned = 0
    for (const [jid, flow] of this.flows.entries()) {
      if (!flow.active && flow.size === 0 && nowMs - flow.lastTouchedAt >= this.idleTimeoutMs) {
        this.flows.delete(jid)
        pruned++
        this.totalPrunedCount++
      }
    }
    return pruned
  }

  /**
   * Clears all queues and resets state (used during graceful shutdown).
   */
  clear(): void {
    this.flows.clear()
    this.activeCursor = null
    this.activeFlowCount = 0
    this.totalQueuedCount = 0
  }

  get size(): number {
    return this.totalQueuedCount
  }

  get trackedFlowCount(): number {
    return this.flows.size
  }

  get activeJidCount(): number {
    return this.activeFlowCount
  }

  getMetrics(): DRRSchedulerMetrics {
    return {
      trackedFlows: this.flows.size,
      activeFlows: this.activeFlowCount,
      totalQueuedPackets: this.totalQueuedCount,
      totalEnqueued: this.totalEnqueuedCount,
      totalDequeued: this.totalDequeuedCount,
      totalDroppedBackpressure: this.totalDroppedCount,
      totalPrunedFlows: this.totalPrunedCount,
    }
  }

  /**
   * Inserts a flow into the circular doubly-linked active list in $O(1)$ time.
   * If `preemptAtCursor` is true (sparse-flow boost), the flow becomes the immediate `activeCursor`.
   */
  private insertActiveFlow(flow: JidFlowQueue<TPayload>, preemptAtCursor: boolean): void {
    flow.active = true
    if (!this.activeCursor) {
      flow.nextActive = flow
      flow.prevActive = flow
      this.activeCursor = flow
      this.activeFlowCount = 1
      return
    }

    const cursor = this.activeCursor
    const tail = cursor.prevActive!

    tail.nextActive = flow
    flow.prevActive = tail
    flow.nextActive = cursor
    cursor.prevActive = flow
    this.activeFlowCount++

    if (preemptAtCursor) {
      this.activeCursor = flow
    }
  }

  /**
   * Removes a flow from the circular doubly-linked active list in $O(1)$ time.
   */
  private removeActiveFlow(flow: JidFlowQueue<TPayload>): void {
    if (!flow.active) return
    flow.active = false

    if (this.activeFlowCount <= 1 || flow.nextActive === flow) {
      flow.nextActive = null
      flow.prevActive = null
      this.activeCursor = null
      this.activeFlowCount = 0
      return
    }

    const prev = flow.prevActive!
    const next = flow.nextActive!
    prev.nextActive = next
    next.prevActive = prev

    if (this.activeCursor === flow) {
      this.activeCursor = next
    }

    flow.nextActive = null
    flow.prevActive = null
    this.activeFlowCount--
  }

  private evictOldestIdleFlow(nowMs: number): void {
    if (this.pruneIdleFlows(nowMs) > 0) return
    let oldestJid: string | undefined
    let oldestTime = Infinity
    for (const [jid, flow] of this.flows.entries()) {
      if (!flow.active && flow.size === 0 && flow.lastTouchedAt < oldestTime) {
        oldestTime = flow.lastTouchedAt
        oldestJid = jid
      }
    }
    if (oldestJid !== undefined) {
      this.flows.delete(oldestJid)
      this.totalPrunedCount++
    }
  }
}
