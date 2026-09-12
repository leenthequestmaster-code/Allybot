import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createSentryPlugin } from '../dist/framework/plugins/sentry.js'
import { technicalPlugin } from '../dist/framework/plugins/technical.js'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { developerModePlugin } from '../dist/framework/plugins/developer-mode.js'
import { codebasePlugin } from '../dist/framework/plugins/codebase.js'
import { diagnosticsPlugin } from '../dist/framework/plugins/diagnostics.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { createGroupContextPlugin } from '../dist/framework/plugins/group-context.js'
import { createCharacterGuidePlugin } from '../dist/framework/plugins/character-guide.js'
import { createWelcomeLeavePlugin } from '../dist/framework/plugins/welcome-leave.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'
import { createGroupModerationPlugin } from '../dist/framework/plugins/group-moderation.js'
import { createGroupSetupMissionPlugin } from '../dist/framework/plugins/group-setup-mission.js'
import { economyPlugin } from '../dist/framework/plugins/economy.js'
import { createGroupGovernancePlugin } from '../dist/framework/plugins/group-governance.js'
import { createScenePlugin } from '../dist/framework/plugins/scene.js'
import { createKnowledgePlugin } from '../dist/framework/plugins/knowledge.js'
import { suggestionRelayPlugin } from '../dist/framework/plugins/suggestion-relay.js'
import { utilityPlugin } from '../dist/framework/plugins/utility.js'
import { mediaPlugin } from '../dist/framework/plugins/media.js'
import { toolsSearchPlugin } from '../dist/framework/plugins/tools-search.js'
import { createAfkPlugin } from '../dist/framework/plugins/afk.js'

const logger = pino({ level: 'silent' })

// Service names src/index.ts registers. Stubs stand in for the real implementations so
// this test stays about plugin wiring, not storage behaviour.
const SERVICE_NAMES = [
  'afk',
  'group-configuration',
  'developer-mode',
  'economy',
  'group-context',
  'character-guide',
  'platform-guardrails',
  'group-moderation',
  'knowledge',
  'scene',
  'group-governance',
  'suggestion-relay',
  'redis',
  'group-safety',
]

// Every property resolves to another callable stub, so plugin load hooks can read flags,
// call methods, and chain without any real backend. Feature flags read as truthy, which
// registers the widest possible command surface — the state most likely to collide.
function stubService(name) {
  const target = () => undefined
  const proxy = new Proxy(target, {
    get(_target, property) {
      if (property === 'name') return name
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive) return () => name
      return proxy
    },
    apply() {
      return proxy
    },
  })
  return proxy
}

// PENDING: two plugins collide on command names and die on every production boot.
// Resolving them needs product decisions on who owns `groupmode` and `ooc`, so they are
// pinned here instead of silently tolerated. Delete an entry once its collision is fixed.
// (character-guide's former `timerp` duplicate alias was resolved in the backend-stub
// disable work — the plugin now reaches ready.)
const PENDING_PLUGIN_FAILURES = [
  'group-moderation: Command name already registered: groupmode',
  'scene: Command name already registered: ooc',
]
const PENDING_PLUGINS = ['group-moderation', 'scene']

function fakeWhatsapp() {
  const noop = () => () => undefined
  return {
    isConnected: true,
    currentStatus: 'connected',
    userJid: 'bot@s.whatsapp.net',
    onMessage: noop,
    onGroupParticipantUpdate: noop,
    onConnectionState: noop,
    async sendText() {},
    async sendNativeQuickReplies() {},
    async getGroupMetadata() {
      return { jid: 'group@g.us', subject: 'Readiness', participants: [] }
    },
    async getGroupInviteLink() {
      return undefined
    },
    async start() {},
    async close() {},
  }
}

test('every production plugin reaches ready, except the documented pending collisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-plugin-readiness-'))
  const whatsapp = fakeWhatsapp()
  const framework = new ApplicationFramework(
    {
      commandPrefix: '!',
      defaultCooldownMs: 0,
      botOwnerJid: 'owner@s.whatsapp.net',
      databasePath: join(root, 'core.sqlite'),
      codebaseExportEnabled: true,
      characterGuideSessionTtlSeconds: 1_800,
      groupContextOocCooldownMs: 30_000,
      groupContextOocWindowMs: 600_000,
      groupContextOocMaxPerWindow: 3,
    },
    logger,
    whatsapp,
  )

  for (const name of SERVICE_NAMES) framework.registerService(stubService(name))

  const failures = []
  framework.events.on('plugin.failed', ({ name, error }) => {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Same plugins and same order as src/index.ts, with every feature flag on.
  framework.registerPlugin(createSentryPlugin({ isEnabled: false, captureError() {}, captureMessage() {}, close: async () => {} }))
  framework.registerPlugin(technicalPlugin)
  framework.registerPlugin(createAiPlugin({ fallbackEnabled: false }))
  framework.registerPlugin(developerModePlugin)
  framework.registerPlugin(codebasePlugin)
  framework.registerPlugin(diagnosticsPlugin)
  framework.registerPlugin(menuPlugin)
  framework.registerPlugin(groupPlugin)
  framework.registerPlugin(createGroupContextPlugin(whatsapp))
  framework.registerPlugin(createCharacterGuidePlugin(whatsapp))
  framework.registerPlugin(createWelcomeLeavePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))
  framework.registerPlugin(createGroupModerationPlugin(whatsapp))
  framework.registerPlugin(createGroupSetupMissionPlugin(whatsapp))
  framework.registerPlugin(economyPlugin)
  framework.registerPlugin(createGroupGovernancePlugin(whatsapp))
  framework.registerPlugin(createScenePlugin(whatsapp))
  framework.registerPlugin(createKnowledgePlugin(whatsapp))
  framework.registerPlugin(suggestionRelayPlugin)
  framework.registerPlugin(utilityPlugin)
  framework.registerPlugin(mediaPlugin)
  framework.registerPlugin(toolsSearchPlugin)
  framework.registerPlugin(createAfkPlugin(whatsapp))

  try {
    await framework.start()

    // A plugin that fails to load is non-fatal by design: the framework still reports
    // ready while that plugin's commands silently disappear, including the ones already
    // accepted before the collision, which cleanup() rolls back. Comparing against the
    // exact pending set means a NEW collision fails this test, and resolving a listed
    // one also fails it until the entry is removed here.
    assert.deepEqual(failures, PENDING_PLUGIN_FAILURES, 'plugin load failures changed')
    const notReady = framework.plugins.list().filter((entry) => entry.state !== 'ready').map((entry) => entry.name)
    assert.deepEqual(notReady, PENDING_PLUGINS, 'set of non-ready plugins changed')
    assert.equal(framework.state.phase, 'ready')
  } finally {
    await framework.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
