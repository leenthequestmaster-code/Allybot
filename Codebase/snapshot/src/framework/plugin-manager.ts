import type {
  EventBusLike,
  FrameworkConfig,
  Plugin,
  PluginContext,
  CommandRegistryLike,
  MessageGateRegistryLike,
  ServiceRegistryLike,
} from './contracts.js'
import type { Logger } from 'pino'

interface PluginRecord {
  plugin: Plugin
  state: 'registered' | 'loaded' | 'initialized' | 'ready' | 'failed'
  cleanups: Array<() => void>
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRecord>()

  constructor(
    private readonly logger: Logger,
    private readonly config: FrameworkConfig,
    private readonly events: EventBusLike,
    private readonly commands: CommandRegistryLike,
    private readonly services: ServiceRegistryLike,
    private readonly messageGates: MessageGateRegistryLike,
  ) {}

  register(plugin: Plugin): void {
    const name = plugin.name.trim()
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) throw new Error(`Invalid plugin name: ${name}`)
    if (this.plugins.has(name)) throw new Error(`Plugin already registered: ${name}`)
    this.plugins.set(name, { plugin, state: 'registered', cleanups: [] })
  }

  list(): readonly { name: string; state: PluginRecord['state'] }[] {
    return [...this.plugins].map(([name, record]) => ({ name, state: record.state }))
  }

  async loadAndInitialize(): Promise<void> {
    for (const name of this.resolveOrder()) {
      const record = this.plugins.get(name)
      if (!record) continue
      try {
        const context = this.context(record)
        await record.plugin.load?.(context)
        record.state = 'loaded'
        await this.events.emit('plugin.loaded', { name })
        await record.plugin.initialize?.(context)
        record.state = 'initialized'
      } catch (error) {
        record.state = 'failed'
        this.cleanup(record)
        this.logger.error({ plugin: name, err: error }, 'plugin load or initialization failed')
        await this.events.emit('plugin.failed', { name, error })
      }
    }
  }

  async ready(): Promise<void> {
    for (const name of this.resolveOrder()) {
      const record = this.plugins.get(name)
      if (!record || record.state !== 'initialized') continue
      try {
        await record.plugin.ready?.(this.context(record))
        record.state = 'ready'
      } catch (error) {
        record.state = 'failed'
        this.cleanup(record)
        this.logger.error({ plugin: name, err: error }, 'plugin ready hook failed')
        await this.events.emit('plugin.failed', { name, error })
      }
    }
  }

  async unload(): Promise<void> {
    const order = this.resolveOrder().reverse()
    for (const name of order) {
      const record = this.plugins.get(name)
      if (!record || record.state === 'registered') continue
      try {
        await record.plugin.unload?.(this.context(record))
      } catch (error) {
        this.logger.error({ plugin: name, err: error }, 'plugin unload hook failed')
      } finally {
        this.cleanup(record)
        record.state = 'registered'
      }
    }
  }

  private context(record: PluginRecord): PluginContext {
    const events: EventBusLike = {
      on: (name, listener) => this.trackCleanup(record, this.events.on(name, listener)),
      emit: (name, event) => this.events.emit(name, event),
    }
    const commands: CommandRegistryLike = {
      register: (command) => this.trackCleanup(record, this.commands.register(command)),
      get: (name) => this.commands.get(name),
      dispatch: (message) => this.commands.dispatch(message),
      list: () => this.commands.list(),
    }
    return {
      logger: this.logger,
      config: this.config,
      events,
      commands,
      services: this.services,
      messageGates: {
        register: (name, gate) => this.trackCleanup(record, this.messageGates.register(name, gate)),
        evaluate: (message) => this.messageGates.evaluate(message),
        list: () => this.messageGates.list(),
      },
    }
  }

  private trackCleanup(record: PluginRecord, cleanup: () => void): () => void {
    let active = true
    const disposer = () => {
      if (!active) return
      active = false
      cleanup()
    }
    record.cleanups.push(disposer)
    return disposer
  }

  private cleanup(record: PluginRecord): void {
    for (const cleanup of record.cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch (error) {
        this.logger.warn({ plugin: record.plugin.name, err: error }, 'plugin registration cleanup failed')
      }
    }
  }

  private resolveOrder(): string[] {
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const order: string[] = []

    const visit = (name: string): void => {
      if (visited.has(name)) return
      if (visiting.has(name)) throw new Error(`Circular plugin dependency: ${name}`)
      const record = this.plugins.get(name)
      if (!record) throw new Error(`Missing plugin dependency: ${name}`)
      visiting.add(name)
      for (const dependency of record.plugin.dependencies ?? []) visit(dependency)
      visiting.delete(name)
      visited.add(name)
      order.push(name)
    }

    for (const name of this.plugins.keys()) visit(name)
    return order
  }
}
