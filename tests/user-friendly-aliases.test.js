import { test } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { createGroupModerationPlugin } from '../dist/framework/plugins/group-moderation.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp() {
  return {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText() {},
    async start() {},
    async close() {},
  }
}

function collectCommands(plugin, services = {}) {
  const commands = []
  plugin.load?.({
    logger,
    config,
    events: { on() { return () => {} } },
    commands: { register(command) { commands.push(command); return () => {} } },
    services: { get(name) { return services[name] ?? {} } },
  })
  return new Map(commands.map((command) => [command.name, command]))
}

function assertAlias(commandMap, commandName, alias) {
  assert.ok(commandMap.get(commandName), 'missing command ' + commandName)
  assert.ok(commandMap.get(commandName).aliases?.includes(alias), alias + ' is not an alias of ' + commandName)
}

test('user-friendly aliases remain attached to canonical commands', () => {
  const whatsapp = fakeWhatsapp()
  const moderation = collectCommands(createGroupModerationPlugin(whatsapp))
  const safety = collectCommands(createGroupSafetyPlugin(whatsapp))
  const ai = collectCommands(createAiPlugin())

  assertAlias(moderation, 'modaction', 'moderate')
  assertAlias(safety, 'claimcase', 'takecase')
  assertAlias(ai, 'ai', 'tanya')
})
