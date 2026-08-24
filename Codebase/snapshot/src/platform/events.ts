import type { PlatformEvent, PlatformEventSink, PlatformLogger } from './contracts.js'

export class InMemoryPlatformEventSink implements PlatformEventSink {
  private readonly eventsValue: PlatformEvent[] = []

  constructor(private readonly maxEvents = 1_000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be a positive integer')
  }

  emit(event: PlatformEvent): void {
    this.eventsValue.push(event)
    if (this.eventsValue.length > this.maxEvents) this.eventsValue.splice(0, this.eventsValue.length - this.maxEvents)
  }

  list(): readonly PlatformEvent[] {
    return this.eventsValue.slice()
  }

  clear(): void {
    this.eventsValue.length = 0
  }
}

export class LoggerPlatformEventSink implements PlatformEventSink {
  constructor(private readonly logger: PlatformLogger) {}

  emit(event: PlatformEvent): void {
    const fields = { ...event.payload, event: event.name, at: event.at }
    if (event.name === 'permission.denied' || event.name === 'platform.error') {
      this.logger.warn('platform event', fields)
      return
    }
    this.logger.info('platform event', fields)
  }
}
