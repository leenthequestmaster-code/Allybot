import type {
  FeatureRegistry,
  PermissionPort,
  PlatformClock,
  PlatformEventSink,
  PlatformLogger,
} from './contracts.js'
import { InMemoryFeatureRegistry } from './feature-registry.js'
import { TextInteractionAdapter, type TextInteractionOptions } from './interaction.js'
import { FeatureLifecycleManager } from './lifecycle.js'
import { PolicyPermissionEvaluator } from './permission.js'
import { InMemoryPlatformEventSink } from './events.js'

export interface PlatformKernelOptions extends TextInteractionOptions {
  readonly clock?: PlatformClock
  readonly logger?: PlatformLogger
  readonly features?: FeatureRegistry
  readonly permissions?: PermissionPort
  readonly events?: PlatformEventSink
}

export interface PlatformKernel {
  readonly features: FeatureRegistry
  readonly lifecycle: FeatureLifecycleManager
  readonly interaction: TextInteractionAdapter
  readonly permissions: PermissionPort
  readonly events: PlatformEventSink
  readonly clock: PlatformClock
  readonly logger?: PlatformLogger
}

export function createPlatformKernel(options: PlatformKernelOptions = {}): PlatformKernel {
  const clock = options.clock ?? { now: () => Date.now() }
  const features = options.features ?? new InMemoryFeatureRegistry()
  return {
    features,
    lifecycle: new FeatureLifecycleManager(features),
    interaction: new TextInteractionAdapter({ ...options, clock }),
    permissions: options.permissions ?? new PolicyPermissionEvaluator(),
    events: options.events ?? new InMemoryPlatformEventSink(),
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
}
