import type { Logger } from 'pino'
import type { Service, ServiceContext, ServiceRegistryLike } from './contracts.js'

export class ServiceRegistry implements ServiceRegistryLike {
  private readonly services = new Map<string, Service>()
  private initialized: string[] = []

  constructor(private readonly logger: Logger) {}

  register(service: Service): void {
    if (this.services.has(service.name)) {
      throw new Error(`Service already registered: ${service.name}`)
    }
    this.services.set(service.name, service)
  }

  get<T extends Service = Service>(name: string): T {
    const service = this.services.get(name)
    if (!service) throw new Error(`Service is not registered: ${name}`)
    return service as T
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  list(): readonly string[] {
    return [...this.services.keys()]
  }

  async initialize(context: Omit<ServiceContext, 'services'>): Promise<void> {
    const order = this.resolveOrder()
    this.initialized = []
    const fullContext: ServiceContext = { ...context, services: this }

    for (const name of order) {
      const service = this.get(name)
      try {
        await service.initialize?.(fullContext)
        this.initialized.push(name)
        this.logger.debug({ service: name }, 'framework service initialized')
      } catch (error) {
        this.logger.error({ service: name, err: error }, 'framework service initialization failed')
        throw error
      }
    }
  }

  async shutdown(context: Omit<ServiceContext, 'services'>): Promise<void> {
    const fullContext: ServiceContext = { ...context, services: this }
    for (const name of [...this.initialized].reverse()) {
      const service = this.get(name)
      try {
        await service.shutdown?.(fullContext)
        this.logger.debug({ service: name }, 'framework service shut down')
      } catch (error) {
        this.logger.error({ service: name, err: error }, 'framework service shutdown failed')
      }
    }
    this.initialized = []
  }

  private resolveOrder(): string[] {
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const order: string[] = []

    const visit = (name: string): void => {
      if (visited.has(name)) return
      if (visiting.has(name)) throw new Error(`Circular service dependency: ${name}`)
      const service = this.get(name)
      visiting.add(name)
      for (const dependency of service.dependencies ?? []) {
        if (!this.services.has(dependency)) {
          throw new Error(`Missing service dependency: ${name} -> ${dependency}`)
        }
        visit(dependency)
      }
      visiting.delete(name)
      visited.add(name)
      order.push(name)
    }

    for (const name of this.services.keys()) visit(name)
    return order
  }
}
