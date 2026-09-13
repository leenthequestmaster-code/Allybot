import { test } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { createGroupGovernancePlugin } from '../dist/framework/plugins/group-governance.js'
import { createGroupModerationPlugin } from '../dist/framework/plugins/group-moderation.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'
import { createKnowledgePlugin } from '../dist/framework/plugins/knowledge.js'
import { createScenePlugin } from '../dist/framework/plugins/scene.js'

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
  assert.ok(commandMap.get(commandName), `missing command ${commandName}`)
  assert.ok(commandMap.get(commandName).aliases?.includes(alias), `${alias} is not an alias of ${commandName}`)
}

test('user-friendly aliases remain attached to canonical commands', () => {
  const whatsapp = fakeWhatsapp()
  const knowledge = collectCommands(createKnowledgePlugin(whatsapp))
  const scene = collectCommands(createScenePlugin(whatsapp))
  const moderation = collectCommands(createGroupModerationPlugin(whatsapp))
  const safety = collectCommands(createGroupSafetyPlugin(whatsapp))
  const governance = collectCommands(createGroupGovernancePlugin(whatsapp))
  const ai = collectCommands(createAiPlugin())

  assertAlias(knowledge, 'setknowledge', 'catatan')
  assertAlias(knowledge, 'bookmarks', 'tersimpan')
  assertAlias(knowledge, 'knowledgeexport', 'exportcatatan')
  assertAlias(scene, 'setscene', 'adegan')
  assertAlias(moderation, 'modaction', 'moderate')
  assertAlias(safety, 'claimcase', 'takecase')
  assertAlias(governance, 'handoff', 'handover')
  assertAlias(governance, 'continuity', 'cekcatatan')
  assertAlias(governance, 'joinrequests', 'joinlist')
  assertAlias(ai, 'ai', 'tanya')
})
