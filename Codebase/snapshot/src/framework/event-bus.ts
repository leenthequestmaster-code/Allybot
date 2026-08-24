import type { Logger } from 'pino'
import type { EventBusLike, EventListener, EventMap, EventName } from './contracts.js'

export class EventBus implements EventBusLike {
  private readonly listeners = new Map<EventName, Set<EventListener<EventName>>>()

  constructor(private readonly logger: Logger) {}

  on<K extends EventName>(name: K, listener: EventListener<K>): () => void {
    const bucket = this.listeners.get(name) ?? new Set<EventListener<EventName>>()
    bucket.add(listener as EventListener<EventName>)
    this.listeners.set(name, bucket)
    return () => bucket.delete(listener as EventListener<EventName>)
  }

  async emit<K extends EventName>(name: K, event: EventMap[K]): Promise<void> {
    const bucket = this.listeners.get(name)
    if (!bucket || bucket.size === 0) return

    const results = await Promise.allSettled(
      [...bucket].map((listener) => Promise.resolve().then(() => listener(event as EventMap[EventName]))),
    )
    for (const result of results) {
      if (result.status !== 'rejected') continue
      this.logger.error({ event: name, err: result.reason }, 'framework event listener failed')
      if (name !== 'framework.error') {
        await this.emit('framework.error', { source: `event:${String(name)}`, error: result.reason })
      }
    }
  }
}
