import type { FeatureDefinition, FeatureRegistry } from './contracts.js'

export class InMemoryFeatureRegistry implements FeatureRegistry {
  private readonly features = new Map<string, FeatureDefinition>()

  register(feature: FeatureDefinition): () => void {
    validateFeatureDefinition(feature)
    if (this.features.has(feature.id)) throw new Error(`Feature already registered: ${feature.id}`)
    this.features.set(feature.id, feature)
    return () => {
      const current = this.features.get(feature.id)
      if (current === feature) this.features.delete(feature.id)
    }
  }

  get(id: string): FeatureDefinition | undefined {
    return this.features.get(id)
  }

  list(options: { readonly includeDisabled?: boolean } = {}): readonly FeatureDefinition[] {
    return [...this.features.values()]
      .filter((feature) => options.includeDisabled || feature.status !== 'disabled')
      .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name))
  }

  has(id: string): boolean {
    return this.features.has(id)
  }
}

function validateFeatureDefinition(feature: FeatureDefinition): void {
  if (!feature.id.trim()) throw new Error('Feature id must not be empty')
  if (!/^[-a-z0-9]+$/.test(feature.id)) throw new Error(`Invalid feature id: ${feature.id}`)
  if (!Number.isInteger(feature.version) || feature.version < 1) {
    throw new Error(`Feature version must be a positive integer: ${feature.id}`)
  }
  if (!feature.name.trim()) throw new Error(`Feature name must not be empty: ${feature.id}`)
  if (!feature.category.trim()) throw new Error(`Feature category must not be empty: ${feature.id}`)
  if (!feature.description.trim()) throw new Error(`Feature description must not be empty: ${feature.id}`)
  if (feature.dependencies?.some((dependency) => !/^[-a-z0-9]+$/.test(dependency))) {
    throw new Error(`Invalid feature dependency: ${feature.id}`)
  }
}
