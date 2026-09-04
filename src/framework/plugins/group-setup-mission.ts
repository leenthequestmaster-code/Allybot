import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  CoreMessage,
  Plugin,
  WhatsAppPort,
} from '../contracts.js'
import {
  GROUP_SETUP_MISSION_ID,
  createGroupSetupMissionDefinition,
  type GroupSetupDraft,
} from '../group-setup.js'
import { MissionEngine, SqliteMissionStore } from '../mission.js'
import type { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { isGroupJid } from '../validation.js'

const INITIAL_PROMPT = 'Group Setup Mission dimulai. Kirim aturan grup, atau ketik `skip` untuk melewati.'

export function createGroupSetupMissionPlugin(whatsapp: WhatsAppPort): Plugin {
  let database: Database.Database | undefined
  let engine: MissionEngine | undefined
  let unbindMessageListener: (() => void) | undefined
  let unregisterCommand: (() => void) | undefined

  return {
    name: 'group-setup-mission',
    version: '0.1.0',
    dependencies: ['group-foundation'],
    load(context) {
      if (!context.config.databasePath) {
        context.logger.warn('Group Setup Mission disabled because framework databasePath is unavailable')
        return
      }

      const databasePath = join(dirname(context.config.databasePath), 'allybot-platform.sqlite')
      database = new Database(databasePath)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = NORMAL')
      database.pragma('foreign_keys = ON')
      database.pragma('busy_timeout = 5000')
      const store = new SqliteMissionStore(database)
      engine = new MissionEngine(store)
      const configuration = context.services.get<GroupConfigurationService>('group-configuration')
      engine.register(createGroupSetupMissionDefinition({
        apply: (draft) => { configuration.applySetup(draft) },
      }))

      unregisterCommand = context.commands.register({
        name: 'groupsetup',
        aliases: ['setupgroup'],
        description: 'Start or resume the persistent group setup mission',
        category: 'group',
        menuOrder: 30,
        permission: 'group.admin',
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const groupJid = commandContext.message.remoteJid
          if (!isGroupJid(groupJid)) {
            await commandContext.reply('Group Setup Mission hanya dapat digunakan di dalam grup.')
            return
          }
          const actorJid = commandContext.message.senderJid
          if (!actorJid) {
            await commandContext.reply('JID pengirim tidak tersedia; mission tidak dapat dimulai.')
            return
          }
          const current = engine?.findActive({ definitionId: GROUP_SETUP_MISSION_ID, remoteJid: groupJid, actorJid, now: Date.now() })
          const requestedCancel = commandContext.args[0]?.toLowerCase() === 'cancel'
          if (!current && requestedCancel) {
            await commandContext.reply('Tidak ada Group Setup Mission aktif untuk dibatalkan.')
            return
          }
          if (current) {
            if (requestedCancel) {
              const cancelled = engine?.cancel(current.id, actorJid, current.revision)
              await commandContext.reply(cancelled ? 'Group Setup Mission dibatalkan.' : 'Mission berubah bersamaan dengan request; coba lagi.')
              return
            }
            await commandContext.reply(current.lastResponse?.text ?? INITIAL_PROMPT)
            return
          }
          const mission = engine?.start(GROUP_SETUP_MISSION_ID, {
            id: `group-setup:${groupJid}:${actorJid}:${randomUUID()}`,
            remoteJid: groupJid,
            actorJid,
            data: { groupJid, updatedBy: actorJid },
            createdAt: Date.now(),
            expiresAt: Date.now() + 15 * 60 * 1000,
          })
          if (!mission) {
            await commandContext.reply('Mission engine belum siap. Coba lagi sebentar.')
            return
          }
          await commandContext.reply(INITIAL_PROMPT)
        },
      })

      unbindMessageListener = context.events.on('message.received', async (message) => {
        await handleMissionMessage(message, context.config.commandPrefix, context.logger)
      })
    },
    unload() {
      unbindMessageListener?.()
      unbindMessageListener = undefined
      unregisterCommand?.()
      unregisterCommand = undefined
      engine = undefined
      if (database?.open) database.close()
      database = undefined
    },
  }

  async function handleMissionMessage(message: CoreMessage, prefix: string, logger: { warn(fields: Record<string, unknown>, message: string): void }): Promise<void> {
    const currentEngine = engine
    if (!currentEngine || message.fromMe || !isGroupJid(message.remoteJid) || !message.senderJid) return
    const current = currentEngine.findActive({ definitionId: GROUP_SETUP_MISSION_ID, remoteJid: message.remoteJid, actorJid: message.senderJid, now: Date.now() })
    if (!current) return

    const text = message.text?.trim()
    if (!message.buttonId && text && text.startsWith(prefix) && current.state !== 'prefix') return
    const value = message.buttonId?.trim() || text
    if (!value) return

    try {
      const metadata = await whatsapp.getGroupMetadata(message.remoteJid)
      const participant = metadata.participants.find((candidate) => candidate.jid === message.senderJid)
      if (participant?.role !== 'admin' && participant?.role !== 'superadmin') {
        logger.warn({ groupJid: message.remoteJid, actorJid: message.senderJid }, 'group setup mission input denied after role recheck')
        await whatsapp.sendText(message.remoteJid, 'Akses Group Setup Mission dicabut karena kamu bukan admin grup lagi.')
        return
      }
    } catch (error) {
      logger.warn({ err: error, groupJid: message.remoteJid }, 'group setup mission role recheck failed')
      return
    }

    const result = await currentEngine.handleInput<GroupSetupDraft, string>({
      id: current.id,
      actorJid: message.senderJid,
      operationKey: message.id,
      value,
    })
    if (!result || result.replayed || !result.response) return
    await whatsapp.sendText(message.remoteJid, result.response.text)
  }
}
