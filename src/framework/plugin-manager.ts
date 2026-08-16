import type {
  EventBusLike,
  FrameworkConfig,
  Plugin,
  PluginContext,
  CommandRegistryLike,
  ServiceRegistryLike,
} from './contracts.js'
import type { Logger } from 'pino'

interface PluginRecord {
  plugin: Plugin
  state: 'registered' | 'loaded' | 'initialized' | 'ready' | 'failed'
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRecord>()

  constructor(
    private readonly logger: Logger,
    private readonly config: FrameworkConfig,
    private readonly events: EventBusLike,
    private readonly commands: CommandRegistryLike,
    private readonly services: ServiceRegistryLike,
  ) {}

  register(plugin: Plugin): void {
    const name = plugin.name.trim()
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) throw new Error(`Invalid plugin name: ${name}`)
    if (this.plugins.has(name)) throw new Error(`Plugin already registered: ${name}`)
    this.plugins.set(name, { plugin, state: 'registered' })
  }

  list(): readonly { name: string; state: PluginRecord['state'] }[] {
    return [...this.plugins].map(([name, record]) => ({ name, state: record.state }))
  }

  async loadAndInitialize(): Promise<void> {
    const context = this.context()
    for (const name of this.resolveOrder()) {
      const record = this.plugins.get(name)
      if (!record) continue
      try {
        await record.plugin.load?.(context)
        record.state = 'loaded'
        await this.events.emit('plugin.loaded', { name })
        await record.plugin.initialize?.(context)
        record.state = 'initialized'
      } catch (error) {
        record.state = 'failed'
        this.logger.error({ plugin: name, err: error }, 'plugin load or initialization failed')
        await this.events.emit('plugin.failed', { name, error })
      }
    }
  }

  async ready(): Promise<void> {
    const context = this.context()
    for (const name of this.resolveOrder()) {
      const record = this.plugins.get(name)
      if (!record || record.state !== 'initialized') continue
      try {
        await record.plugin.ready?.(context)
        record.state = 'ready'
      } catch (error) {
        record.state = 'failed'
        this.logger.error({ plugin: name, err: error }, 'plugin ready hook failed')
        await this.events.emit('plugin.failed', { name, error })
      }
    }
  }

  async unload(): Promise<void> {
    const context = this.context()
    const order = this.resolveOrder().reverse()
    for (const name of order) {
      const record = this.plugins.get(name)
      if (!record || record.state === 'registered' || record.state === 'failed') continue
      try {
        await record.plugin.unload?.(context)
      } catch (error) {
        this.logger.error({ plugin: name, err: error }, 'plugin unload hook failed')
      } finally {
        record.state = 'registered'
      }
    }
  }

  private context(): PluginContext {
    return {
      logger: this.logger,
      config: this.config,
      events: this.events,
      commands: this.commands,
      services: this.services,
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
