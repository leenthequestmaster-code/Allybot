import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
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
import { createModerationSuitePlugin } from '../dist/framework/plugins/moderation-suite.js'
import { createGroupSetupMissionPlugin } from '../dist/framework/plugins/group-setup-mission.js'
import { economyPlugin } from '../dist/framework/plugins/economy.js'
import { utilityPlugin } from '../dist/framework/plugins/utility.js'
import { mediaPlugin } from '../dist/framework/plugins/media.js'
import { toolsSearchPlugin } from '../dist/framework/plugins/tools-search.js'
import { createAfkPlugin } from '../dist/framework/plugins/afk.js'
import { createCommunityPlugin } from '../dist/framework/plugins/community.js'
import { remoteOpsPlugin } from '../dist/framework/plugins/remote-ops.js'
import { createSuggestPlugin } from '../dist/framework/plugins/suggest.js'
import { createMenfessPlugin } from '../dist/framework/plugins/menfess.js'
import { createRekapPlugin } from '../dist/framework/plugins/rekap.js'
import { createChessPlugin } from '../dist/framework/plugins/chess.js'
import { reminderPlugin } from '../dist/framework/plugins/reminder.js'
import { certificatePlugin } from '../dist/framework/plugins/certificate.js'
import { exifPlugin } from '../dist/framework/plugins/exif.js'
import { downloaderPlugin } from '../dist/framework/plugins/downloader.js'
import { quranPlugin } from '../dist/framework/plugins/quran.js'
import { sholatPlugin } from '../dist/framework/plugins/sholat.js'
import { doaPlugin } from '../dist/framework/plugins/doa.js'

// These two legacy plugins perform boot-time I/O outside the framework service registry.
// Replace their external boundaries before importing them, not their real plugin hooks.
function isolateLegacyBoot() {
  const forbidden = '() => { throw new Error("Readiness must not execute external operations") }'
  const modules = new Map([
    ['music-config.js', 'export const loadConfig = () => ({ timezone_offset: 7, owners: [], premium_users: [], premium_groups: [] });'],
    ['music-limiter.js', `export const restoreLimits = () => {}; export const startRolloverInterval = () => {}; export const checkQuota = ${forbidden}; export const consumeQuota = ${forbidden};`],
    ['music-service.js', `export const initMusic = async () => {}; export const searchAndDownload = ${forbidden}; export class MusicError extends Error {}`],
    ['amprem-auto-limiter.js', `export const restoreAutoLimits = () => {}; export const checkAutoLimit = ${forbidden}; export const consumeAutoLimit = ${forbidden};`],
    ['amprem-auto-session.js', `export const restoreAutoSessions = () => {}; ${['saveAutoSession', 'getAutoSession', 'clearAutoSession', 'markAccountVerified', 'removeTempSession', 'findAccount', 'listAccounts', 'removeAccount', 'getLoginSent', 'markLoginSent', 'runGc'].map((name) => `export const ${name} = ${forbidden};`).join(' ')}`],
    ['amprem-scheduler.js', `export const restoreSchedulerState = () => {}; export const shouldRunBackup = ${forbidden}; export const shouldRunGc = ${forbidden};`],
  ])
  const replaced = new Set()
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const name = url.split('/').at(-1)
      if (url.includes('/dist/services/') && modules.has(name)) {
        replaced.add(name)
        return { format: 'module', source: modules.get(name), shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
  return { hooks, replaced, expected: [...modules.keys()] }
}

const logger = pino({ level: 'silent' })

// Service names src/index.ts registers. Stubs stand in for the real implementations so
// this test stays about plugin wiring, not storage behaviour.
const SERVICE_NAMES = [
  'afk',
  'suggestion',
  'group-configuration',
  'developer-mode',
  'economy',
  'group-context',
  'character-guide',
  'platform-guardrails',
  'group-moderation',
  'redis',
  'group-safety',
  'group-moderation-suite',
  'chat-history',
  'web-companion',
  'downloader',
  'quota',
  'community',
  'chess',
  'reminder',
  'aegis-queue',
  'menfess',
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

test('every active production plugin reaches ready without network or production storage', async (t) => {
  const isolation = isolateLegacyBoot()
  t.after(() => isolation.hooks.deregister())
  // Block the legacy verify cron entirely; readiness does not exercise scheduled jobs.
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Readiness must not use network') })
  const { spotifyPlugin } = await import('../dist/framework/plugins/spotify.js')
  const { createVerifyPlugin } = await import('../dist/framework/plugins/verify.js')
  assert.deepEqual([...isolation.replaced].sort(), isolation.expected.sort(), 'all legacy storage/network boundaries must be replaced')

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
  framework.registerPlugin(createRekapPlugin(whatsapp, { fallbackEnabled: false }))
  framework.registerPlugin(developerModePlugin)
  framework.registerPlugin(codebasePlugin)
  framework.registerPlugin(diagnosticsPlugin)
  framework.registerPlugin(menuPlugin)
  framework.registerPlugin(groupPlugin)
  framework.registerPlugin(createGroupContextPlugin(whatsapp))
  framework.registerPlugin(createCharacterGuidePlugin(whatsapp))
  framework.registerPlugin(createCommunityPlugin(whatsapp))
  framework.registerPlugin(remoteOpsPlugin)
  framework.registerPlugin(createWelcomeLeavePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))
  framework.registerPlugin(createGroupModerationPlugin(whatsapp))
  framework.registerPlugin(createModerationSuitePlugin(whatsapp))
  framework.registerPlugin(createGroupSetupMissionPlugin(whatsapp))
  framework.registerPlugin(economyPlugin)
  framework.registerPlugin(utilityPlugin)
  framework.registerPlugin(createChessPlugin(whatsapp))
  framework.registerPlugin(reminderPlugin)
  framework.registerPlugin(certificatePlugin)
  framework.registerPlugin(exifPlugin)
  framework.registerPlugin(mediaPlugin)
  framework.registerPlugin(downloaderPlugin)
  framework.registerPlugin(spotifyPlugin)
  framework.registerPlugin(createVerifyPlugin(whatsapp))
  framework.registerPlugin(toolsSearchPlugin)
  framework.registerPlugin(quranPlugin)
  framework.registerPlugin(sholatPlugin)
  framework.registerPlugin(doaPlugin)
  framework.registerPlugin(createAfkPlugin(whatsapp))
  framework.registerPlugin(createSuggestPlugin(whatsapp))
  framework.registerPlugin(createMenfessPlugin(whatsapp))

  // Retain an independent registration-inventory guard: new runtime plugins must be
  // added here, otherwise an all-ready assertion could silently cover only a subset.
  const runtimeSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const testSource = readFileSync(new URL('./plugin-readiness.test.js', import.meta.url), 'utf8')
  const registrations = (source) => [...source.matchAll(/framework\.registerPlugin\((\w+)/g)].map((match) => match[1])
  assert.deepEqual(registrations(testSource), registrations(runtimeSource), 'readiness must cover the active runtime plugin set and order')

  try {
    await framework.start()

    // Framework ready alone can mask individual plugin failures and rolled-back commands.
    assert.deepEqual(failures, [], 'every active plugin must load without collisions')
    const notReady = framework.plugins.list().filter((entry) => entry.state !== 'ready').map((entry) => entry.name)
    assert.deepEqual(notReady, [], 'every active plugin must reach ready')
    assert.equal(framework.state.phase, 'ready')
  } finally {
    await framework.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
