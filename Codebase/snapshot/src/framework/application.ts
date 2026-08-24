import type { Logger } from 'pino'
import type {
  CommandMiddleware,
  CommandPrefixResolver,
  CommandRegistryLike,
  FrameworkConfig,
  FrameworkState,
  Plugin,
  Service,
  ServiceRegistryLike,
  WhatsAppPort,
} from './contracts.js'
import { CommandRegistry } from './command-registry.js'
import { EventBus } from './event-bus.js'
import { PluginManager } from './plugin-manager.js'
import { ServiceRegistry } from './service-registry.js'
import { type PermissionResolver } from './middleware.js'

export interface ApplicationOptions {
  readonly permissionResolver?: PermissionResolver
  readonly extraMiddleware?: readonly CommandMiddleware[]
  readonly prefixResolver?: CommandPrefixResolver
}

export class ApplicationFramework {
  readonly events: EventBus
  readonly services: ServiceRegistryLike
  readonly commands: CommandRegistryLike
  readonly plugins: PluginManager

  private stateValue: FrameworkState = { phase: 'created', connected: false }
  private readonly unbinders: Array<() => void> = []

  constructor(
    private readonly config: FrameworkConfig,
    private readonly logger: Logger,
    private readonly whatsapp: WhatsAppPort,
    options: ApplicationOptions = {},
  ) {
    this.events = new EventBus(logger)
    this.services = new ServiceRegistry(logger)
    this.commands = new CommandRegistry(
      config,
      logger,
      whatsapp,
      this.services,
      this.events,
      options.permissionResolver,
      options.extraMiddleware,
      options.prefixResolver,
    )
    this.plugins = new PluginManager(logger, config, this.events, this.commands, this.services)
  }

  get state(): FrameworkState {
    return { ...this.stateValue }
  }

  registerService(service: Service): void {
    if (this.stateValue.phase !== 'created') throw new Error('Services must be registered before framework start')
    this.services.register(service)
  }

  registerPlugin(plugin: Plugin): void {
    if (this.stateValue.phase !== 'created') throw new Error('Plugins must be registered before framework start')
    this.plugins.register(plugin)
  }

  async start(): Promise<void> {
    if (this.stateValue.phase !== 'created') throw new Error(`Framework cannot start from ${this.stateValue.phase}`)
    this.stateValue = { phase: 'bootstrapping', connected: this.whatsapp.isConnected }
    this.bindCoreEvents()

    try {
      this.stateValue = { phase: 'services', connected: this.whatsapp.isConnected }
      await this.services.initialize({ logger: this.logger, config: this.config })
      this.stateValue = { phase: 'plugins', connected: this.whatsapp.isConnected }
      await this.plugins.loadAndInitialize()
      await this.plugins.ready()
      await this.whatsapp.start()
      const readyAt = Date.now()
      this.stateValue = { phase: 'ready', connected: this.whatsapp.isConnected, startedAt: readyAt, readyAt }
      await this.events.emit('framework.ready', { at: readyAt })
    } catch (error) {
      this.stateValue = { phase: 'failed', connected: this.whatsapp.isConnected }
      await this.cleanupAfterFailedStart()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stateValue.phase === 'stopped' || this.stateValue.phase === 'created') return
    this.stateValue = { ...this.stateValue, phase: 'stopping' }
    for (const unbind of this.unbinders.splice(0)) unbind()
    await this.plugins.unload()
    await this.services.shutdown({ logger: this.logger, config: this.config })
    await this.whatsapp.close()
    this.stateValue = { phase: 'stopped', connected: false }
  }

  private bindCoreEvents(): void {
    this.unbinders.push(
      this.whatsapp.onConnectionState(async (event) => {
        this.stateValue = { ...this.stateValue, connected: event.status === 'connected' }
        await this.events.emit('connection.changed', event)
      }),
    )
    this.unbinders.push(
      this.whatsapp.onMessage(async (message) => {
        await this.events.emit('message.received', message)
        await this.commands.dispatch(message)
      }),
      this.whatsapp.onGroupParticipantUpdate(async (event) => {
        await this.events.emit('group.participants.changed', event)
      }),
    )
  }

  private async cleanupAfterFailedStart(): Promise<void> {
    for (const unbind of this.unbinders.splice(0)) unbind()
    await this.plugins.unload()
    await this.services.shutdown({ logger: this.logger, config: this.config })
  }
}
