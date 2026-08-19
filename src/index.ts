import { loadConfig, publicConfig } from './config.js'
import { errorMessage } from './errors.js'
import { AppLifecycle } from './lifecycle.js'
import { ApplicationFramework } from './framework/application.js'
import { diagnosticsPlugin } from './framework/plugins/diagnostics.js'
import { aiPlugin } from './framework/plugins/ai.js'
import { developerModePlugin } from './framework/plugins/developer-mode.js'
import { technicalPlugin } from './framework/plugins/technical.js'
import { createAfkPlugin } from './framework/plugins/afk.js'
import { menuPlugin } from './framework/plugins/menu.js'
import { createWelcomeLeavePlugin } from './framework/plugins/welcome-leave.js'
import { groupPlugin } from './framework/plugins/group.js'
import { createGroupSafetyPlugin } from './framework/plugins/group-safety.js'
import { createGroupModerationPlugin } from './framework/plugins/group-moderation.js'
import { createGroupSetupMissionPlugin } from './framework/plugins/group-setup-mission.js'
import { createCollaborationPlugin } from './framework/plugins/collaboration.js'
import { createKnowledgePlugin } from './framework/plugins/knowledge.js'
import { createPersonalizationPlugin } from './framework/plugins/personalization.js'
import { createScenePlugin } from './framework/plugins/scene.js'
import { createCanonPlugin } from './framework/plugins/canon.js'
import { createGroupGovernancePlugin } from './framework/plugins/group-governance.js'
import { createEventPlugin } from './framework/plugins/event.js'
import { createLogger } from './logger.js'
import { createPermissionResolver } from './permissions.js'
import { SqliteStorage } from './storage.js'
import { AfkService } from './services/afk-service.js'
import { GroupConfigurationService } from './services/group-configuration-service.js'
import { DeveloperModeService } from './services/developer-mode-service.js'
import { PlatformGuardrailService } from './services/platform-guardrail-service.js'
import { GroupSafetyService } from './services/group-safety-service.js'
import { GroupModerationService } from './services/group-moderation-service.js'
import { CollaborationService } from './services/collaboration-service.js'
import { KnowledgeService } from './services/knowledge-service.js'
import { PersonalizationService } from './services/personalization-service.js'
import { SceneService } from './services/scene-service.js'
import { CanonService } from './services/canon-service.js'
import { GroupGovernanceService } from './services/group-governance-service.js'
import { EventService } from './services/event-service.js'
import { WhatsAppConnection } from './whatsapp.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config)

  const storage = new SqliteStorage(config, logger)

  if (process.argv.includes('--self-check')) {
    const integrity = storage.verifyIntegrity()
    logger.info({ config: publicConfig(config), node: process.version, integrity }, 'Allybot self-check passed')
    storage.close()
    if (!integrity.valid) process.exitCode = 2
    return
  }

  const whatsapp = new WhatsAppConnection(config, storage, logger)
  const framework = new ApplicationFramework(
    {
      commandPrefix: config.COMMAND_PREFIX,
      defaultCooldownMs: config.DEFAULT_COMMAND_COOLDOWN_MS,
      botOwnerJid: config.BOT_OWNER_JID,
      databasePath: config.DATABASE_PATH,
      aiCommandsEnabled: config.AI_COMMANDS_ENABLED,
    },
    logger,
    whatsapp,
    {
      permissionResolver: createPermissionResolver(whatsapp, config.BOT_OWNER_JID),
      prefixResolver: (message, services, fallback) => message.remoteJid.endsWith('@g.us')
        ? services.get<GroupConfigurationService>('group-configuration').resolvePrefix(message.remoteJid, fallback)
        : fallback,
    },
  )
  framework.registerService(new AfkService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupConfigurationService(config.DATABASE_PATH, logger))
  framework.registerService(new DeveloperModeService(config.DATABASE_PATH, logger))
  framework.registerService(new PlatformGuardrailService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupModerationService(config.DATABASE_PATH, logger))
  framework.registerService(new CollaborationService(config.DATABASE_PATH, logger))
  framework.registerService(new KnowledgeService(config.DATABASE_PATH, logger))
  framework.registerService(new PersonalizationService(config.DATABASE_PATH, logger))
  framework.registerService(new SceneService(config.DATABASE_PATH, logger))
  framework.registerService(new CanonService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupGovernanceService(config.DATABASE_PATH, logger))
  framework.registerService(new EventService(config.DATABASE_PATH, logger))
  framework.registerService(new GroupSafetyService(config.DATABASE_PATH, logger))
  framework.registerPlugin(technicalPlugin)
  framework.registerPlugin(aiPlugin)
  framework.registerPlugin(developerModePlugin)
  if (config.DIAGNOSTICS_ENABLED) framework.registerPlugin(diagnosticsPlugin)
  framework.registerPlugin(menuPlugin)
  framework.registerPlugin(createWelcomeLeavePlugin(whatsapp))
  framework.registerPlugin(groupPlugin)
  framework.registerPlugin(createGroupSafetyPlugin(whatsapp))
  framework.registerPlugin(createGroupModerationPlugin(whatsapp))
  framework.registerPlugin(createGroupSetupMissionPlugin(whatsapp))
  framework.registerPlugin(createCollaborationPlugin(whatsapp))
  framework.registerPlugin(createKnowledgePlugin(whatsapp))
  framework.registerPlugin(createPersonalizationPlugin(whatsapp))
  framework.registerPlugin(createScenePlugin(whatsapp))
  framework.registerPlugin(createCanonPlugin(whatsapp))
  framework.registerPlugin(createGroupGovernancePlugin(whatsapp))
  framework.registerPlugin(createEventPlugin(whatsapp))
  framework.registerPlugin(createAfkPlugin(whatsapp))
  const lifecycle = new AppLifecycle(config, logger, storage, whatsapp, framework)
  await lifecycle.start()

}

main().catch((error: unknown) => {
  console.error(`Allybot failed to start: ${errorMessage(error)}`)
  process.exitCode = 1
})
