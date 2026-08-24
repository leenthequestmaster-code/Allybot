import type { FeatureDefinition, FeatureLifecycle, FeatureRegistry } from './contracts.js'

export interface FeatureModule {
  readonly definition: FeatureDefinition
  readonly lifecycle: FeatureLifecycle
}

export type FeatureRuntimeState = 'registered' | 'loaded' | 'initialized' | 'ready' | 'unloaded' | 'failed'

export class FeatureLifecycleManager {
  private readonly modules = new Map<string, FeatureModule>()
  private readonly states = new Map<string, FeatureRuntimeState>()

  constructor(private readonly registry: FeatureRegistry) {}

  register(module: FeatureModule): () => void {
    const { definition } = module
    if (this.modules.has(definition.id)) throw new Error(`Feature lifecycle already registered: ${definition.id}`)
    if (!this.registry.has(definition.id)) throw new Error(`Feature must be registered before lifecycle: ${definition.id}`)
    this.modules.set(definition.id, module)
    this.states.set(definition.id, 'registered')
    return () => {
      if (this.modules.get(definition.id) !== module) return
      const state = this.states.get(definition.id)
      if (state === 'loaded' || state === 'initialized' || state === 'ready') {
        throw new Error(`Cannot unregister active feature lifecycle: ${definition.id}`)
      }
      this.modules.delete(definition.id)
      this.states.delete(definition.id)
    }
  }

  state(id: string): FeatureRuntimeState | undefined {
    return this.states.get(id)
  }

  async start(): Promise<void> {
    if ([...this.states.values()].some((state) => state === 'loaded' || state === 'initialized' || state === 'ready')) {
      throw new Error('Feature lifecycle is already started')
    }
    const order = this.resolveOrder()
    const started: FeatureModule[] = []
    try {
      for (const module of order) {
        const { definition, lifecycle } = module
        await lifecycle.load(definition)
        this.states.set(definition.id, 'loaded')
        await lifecycle.initialize(definition)
        this.states.set(definition.id, 'initialized')
        started.push(module)
        await lifecycle.ready(definition)
        this.states.set(definition.id, 'ready')
      }
    } catch (error) {
      for (const module of [...started].reverse()) {
        try {
          await module.lifecycle.unload(module.definition)
          this.states.set(module.definition.id, 'unloaded')
        } catch {
          this.states.set(module.definition.id, 'failed')
        }
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const order = this.resolveOrder().reverse()
    for (const module of order) {
      const state = this.states.get(module.definition.id)
      if (state !== 'ready' && state !== 'initialized' && state !== 'loaded') continue
      await module.lifecycle.unload(module.definition)
      this.states.set(module.definition.id, 'unloaded')
    }
  }

  private resolveOrder(): FeatureModule[] {
    const active = [...this.modules.values()].filter(({ definition }) => definition.status === 'active' || definition.status === 'experimental')
    const byId = new Map(active.map((module) => [module.definition.id, module]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const order: FeatureModule[] = []

    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new Error(`Feature dependency cycle detected at: ${id}`)
      const module = byId.get(id)
      if (!module) throw new Error(`Feature dependency is not active or registered: ${id}`)
      visiting.add(id)
      for (const dependency of module.definition.dependencies ?? []) visit(dependency)
      visiting.delete(id)
      visited.add(id)
      order.push(module)
    }

    for (const module of active) visit(module.definition.id)
    return order
  }
}
