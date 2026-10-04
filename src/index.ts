import { loadConfig, publicConfig } from './config.js'
import { errorMessage } from './errors.js'
import { AppLifecycle } from './lifecycle.js'
import { ApplicationFramework } from './framework/application.js'
import { diagnosticsPlugin } from './framework/plugins/diagnostics.js'
import { createAiPlugin } from './framework/plugins/ai.js'
import { economyPlugin } from './framework/plugins/economy.js'
import { developerModePlugin } from './framework/plugins/developer-mode.js'
import { codebasePlugin } from './framework/plugins/codebase.js'
import { technicalPlugin } from './framework/plugins/technical.js'
import { quranPlugin } from './framework/plugins/quran.js'
import { sholatPlugin } from './framework/plugins/sholat.js'
import { doaPlugin } from './framework/plugins/doa.js'
import { createAfkPlugin } from './framework/plugins/afk.js'
import { createSuggestPlugin } from './framework/plugins/suggest.js'
import { menuPlugin } from './framework/plugins/menu.js'
import { createWelcomeLeavePlugin } from './framework/plugins/welcome-leave.js'
import { groupPlugin } from './framework/plugins/group.js'
import { createGroupSafetyPlugin } from './framework/plugins/group-safety.js'
import { createGroupModerationPlugin } from './framework/plugins/group-moderation.js'
import { createModerationSuitePlugin } from './framework/plugins/moderation-suite.js'
import { createGroupSetupMissionPlugin } from './framework/plugins/group-setup-mission.js'

import { utilityPlugin } from './framework/plugins/utility.js'
import { mediaPlugin } from './framework/plugins/media.js'
import { spotifyPlugin } from './framework/plugins/spotify.js'
import { createVerifyPlugin } from './framework/plugins/verify.js'
import { toolsSearchPlugin } from './framework/plugins/tools-search.js'
import { createLogger } from './logger.js'
import { createSentryReporter } from './sentry.js'
import { createSentryPlugin } from './framework/plugins/sentry.js'
import { createPermissionResolver } from './permissions.js'
import { isGroupJid } from './framework/validation.js'
import { SqliteStorage } from './storage.js'
import { AfkService } from './services/afk-service.js'
import { SuggestionService } from './services/suggestion-service.js'
import { GroupConfigurationService } from './services/group-configuration-service.js'
import { DeveloperModeService } from './services/developer-mode-service.js'
import { PlatformGuardrailService } from './services/platform-guardrail-service.js'
import { GroupSafetyService } from './services/group-safety-service.js'
import { GroupModerationService } from './services/group-moderation-service.js'
import { GroupModerationSuiteService } from './services/group-moderation-suite-service.js'
import { WhatsAppConnection } from './whatsapp.js'
import { RedisService } from './redis.js'
import { EconomyService } from './services/economy-service.js'
import { createSqliteEconomyClient } from './services/economy-sqlite-client.js'
import { createPostgresEconomyClient } from './services/economy-postgres-client.js'
import { CharacterGuideService } from './services/character-guide-service.js'
import { createPostgresCharacterClient } from './services/character-postgres-client.js'
import { GroupContextService } from './services/group-context-service.js'
import { createPostgresGroupContextClient } from './services/group-context-postgres-client.js'
import { createGroupContextPlugin } from './framework/plugins/group-context.js'
import { createCharacterGuidePlugin } from './framework/plugins/character-guide.js'
import { WebCompanionService } from './services/web-companion-service.js'
import { DownloaderService } from "./services/downloader-service.js"

import { downloaderPlugin } from "./framework/plugins/downloader.js"

import { startScheduler } from './services/sholat-scheduler.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config)
  const sentry = createSentryReporter(config, logger)

  const storage = new SqliteStorage(config, logger)

  if (process.argv.includes('--self-check')) {
    const integrity = storage.verifyIntegrity()
    logger.info({ config: publicConfig(config), node: process.version, integrity }, 'Allybot self-check passed')
    storage.close()
    await sentry.close()
    process.exit(integrity.valid ? 0 : 2)
  }

  const redis = new RedisService({ env: process.env })
  const whatsapp = new WhatsAppConnection(config, storage, logger, redis)
  const framework = new ApplicationFramework(
    {
      commandPrefix: config.COMMAND_PREFIX,
      defaultCooldownMs: config.DEFAULT_COMMAND_COOLDOWN_MS,
      botOwnerJid: config.BOT_OWNER_JID,
      databasePath: config.DATABASE_PATH,
      codebaseExportEnabled: config.CODEBASE_EXPORT_ENABLED,
      codebaseExportPath: config.CODEBASE_EXPORT_PATH,
      codebaseExportMaxBytes: config.CODEBASE_EXPORT_MAX_BYTES,
      characterGuideSessionTtlSeconds: config.CHARACTER_GUIDE_SESSION_TTL_SECONDS,
      groupContextOocCooldownMs: config.GROUP_CONTEXT_OOC_COOLDOWN_MS,
      groupContextOocWindowMs: config.GROUP_CONTEXT_OOC_WINDOW_MS,
      groupContextOocMaxPerWindow: config.GROUP_CONTEXT_OOC_MAX_PER_WINDOW,
      officialOocGroupJid: config.OFFICIAL_OOC_GROUP_JID,
      officialOocInviteLink: config.OFFICIAL_OOC_INVITE_LINK,
      officialGroupJids: config.OFFICIAL_GROUP_JIDS
        ? config.OFFICIAL_GROUP_JIDS.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    },
    logger,
    whatsapp,
    {
      permissionResolver: createPermissionResolver(whatsapp, config.BOT_OWNER_JID),
      prefixResolver: (message, services, fallback) => isGroupJid(message.remoteJid)
        ? services.get<GroupConfigurationService>('group-configuration').resolvePrefix(message.remoteJid, fallback)
        : fallback,
    },
  )
  framework.registerService(new AfkService(config.DATABASE_PATH, logger))
  framework.registerService(new SuggestionService(config.DATABASE_PATH, logger, { secret: config.SUGGEST_SECRET }))
  framework.registerService(new GroupConfigurationService(config.DATABASE_PATH, logger))
  framework.registerService(new DeveloperModeService(config.DATABASE_PATH, logger))
  const economyClient = config.POSTGRES_ENABLED && config.POSTGRES_URL
    ? () => createPostgresEconomyClient({ postgresUrl: config.POSTGRES_URL! })
    : () => createSqliteEconomyClient(config.DATABASE_PATH)

  framework.registerService(new EconomyService(logger, {
    env: { ...process.env, ECONOMY_ENABLED: config.ECONOMY_ENABLED ? 'true' : 'false' },
    cacheTtlSeconds: 15,
    createClient: economyClient,
    whatsapp,
  }))
  const groupContextClient = config.POSTGRES_ENABLED && config.POSTGRES_URL
    ? () => createPostgresGroupContextClient({ postgresUrl: config.POSTGRES_URL! })
    : undefined

  framework.registerService(new GroupContextService(logger, {
    env: { ...process.env, GROUP_CONTEXT_ENABLED: config.GROUP_CONTEXT_ENABLED ? 'true' : 'false' },
    createClient: groupContextClient,
  }))

  const characterClient = config.POSTGRES_ENABLED && config.POSTGRES_URL
    ? () => createPostgresCharacterClient({ postgresUrl: config.POSTGRES_URL!, redis })
    : undefined

  framework.registerService(new CharacterGuideService(logger, {
    env: { ...process.env, CHARACTER_GUIDE_ENABLED: config.CHARACTER_GUIDE_ENABLED ? 'true' : 'false' },
    createClient: characterClient,
  }))
  framework.registerService(new PlatformGuardrailService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupModerationService(config.DATABASE_PATH, logger))
  framework.registerService(redis)
  framework.registerService(new GroupSafetyService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupModerationSuiteService(config.DATABASE_PATH, logger))
  framework.registerService(new WebCompanionService(logger, { whatsapp }))
  framework.registerService(new DownloaderService())
  framework.registerPlugin(createSentryPlugin(sentry))
  framework.registerPlugin(technicalPlugin)
  if (config.AI_ENABLED) framework.registerPlugin(createAiPlugin({ fallbackEnabled: config.AI_FALLBACK_ENABLED }))
  framework.registerPlugin(developerModePlugin)
  if (config.CODEBASE_EXPORT_ENABLED) framework.registerPlugin(codebasePlugin)
  if (config.DIAGNOSTICS_ENABLED) framework.registerPlugin(diagnosticsPlugin)
  framework.registerPlugin(menuPlugin)
  framework.registerPlugin(groupPlugin)
  framework.registerPlugin(createGroupContextPlugin(whatsapp))
  framework.registerPlugin(createCharacterGuidePlugin(whatsapp))
  framework.registerPlugin(createWelcomeLeavePlugin(whatsapp))
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))
  framework.registerPlugin(createGroupModerationPlugin(whatsapp))
  framework.registerPlugin(createModerationSuitePlugin(whatsapp))
  framework.registerPlugin(createGroupSetupMissionPlugin(whatsapp))
  framework.registerPlugin(economyPlugin)
  framework.registerPlugin(utilityPlugin)
  framework.registerPlugin(mediaPlugin)
  framework.registerPlugin(downloaderPlugin)
  framework.registerPlugin(spotifyPlugin)
  framework.registerPlugin(createVerifyPlugin(whatsapp))
  framework.registerPlugin(toolsSearchPlugin)
  framework.registerPlugin(quranPlugin)
  framework.registerPlugin(sholatPlugin)
  framework.registerPlugin(doaPlugin)
  framework.registerPlugin(createAfkPlugin(whatsapp))
  if (config.SUGGEST_ENABLED) framework.registerPlugin(createSuggestPlugin(whatsapp))
  const lifecycle = new AppLifecycle(config, logger, storage, whatsapp, framework, sentry)
  
  startScheduler(whatsapp)
  
  try {
    await lifecycle.start()
  } catch (error) {
    sentry.captureError('lifecycle:start', error)
    await sentry.close()
    throw error
  }

}

main().catch((error: unknown) => {
  console.error(`Allybot failed to start: ${errorMessage(error)}`)
  process.exitCode = 1
})