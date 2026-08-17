import test from 'node:test'
import assert from 'node:assert/strict'
import { FeatureLifecycleManager, InMemoryFeatureRegistry } from '../dist/platform/index.js'

const definition = (id, dependencies = []) => ({
  id,
  version: 1,
  name: id,
  description: `${id} feature`,
  category: 'test',
  status: 'active',
  scope: 'global',
  dependencies,
})

test('lifecycle starts dependencies first and stops in reverse order', async () => {
  const registry = new InMemoryFeatureRegistry()
  const manager = new FeatureLifecycleManager(registry)
  const calls = []
  for (const feature of [definition('base'), definition('child', ['base'])]) {
    registry.register(feature)
    manager.register({
      definition: feature,
      lifecycle: {
        load: () => calls.push(`${feature.id}:load`),
        initialize: () => calls.push(`${feature.id}:init`),
        ready: () => calls.push(`${feature.id}:ready`),
        unload: () => calls.push(`${feature.id}:unload`),
      },
    })
  }
  await manager.start()
  await manager.stop()
  assert.deepEqual(calls, [
    'base:load', 'base:init', 'base:ready',
    'child:load', 'child:init', 'child:ready',
    'child:unload', 'base:unload',
  ])
})

test('lifecycle rolls back initialized feature when ready fails', async () => {
  const registry = new InMemoryFeatureRegistry()
  const manager = new FeatureLifecycleManager(registry)
  const feature = definition('unstable')
  registry.register(feature)
  const calls = []
  manager.register({
    definition: feature,
    lifecycle: {
      load: () => calls.push('load'),
      initialize: () => calls.push('init'),
      ready: () => { calls.push('ready'); throw new Error('ready failed') },
      unload: () => calls.push('unload'),
    },
  })
  await assert.rejects(() => manager.start(), /ready failed/)
  assert.deepEqual(calls, ['load', 'init', 'ready', 'unload'])
  assert.equal(manager.state('unstable'), 'unloaded')
  await assert.rejects(() => manager.start(), /ready failed/)
})

test('lifecycle rejects dependency cycles and duplicate starts', async () => {
  const registry = new InMemoryFeatureRegistry()
  const manager = new FeatureLifecycleManager(registry)
  const a = definition('a', ['b'])
  const b = definition('b', ['a'])
  for (const feature of [a, b]) {
    registry.register(feature)
    manager.register({ definition: feature, lifecycle: { load() {}, initialize() {}, ready() {}, unload() {} } })
  }
  await assert.rejects(() => manager.start(), /dependency cycle/)
})
