import type { CommandContext, CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../../framework/contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import {
  SceneService,
  type SceneConsentRecord,
  type SceneMode,
  type SceneParticipantRecord,
  type SceneRecord,
  type SceneView,
} from '../../services/scene-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function scene(context: { services: ServiceRegistryLike }): SceneService {
  return context.services.get<SceneService>('scene')
}

function requireGroup(context: CommandContext): string | undefined {
  const group = groupJid(context.message)
  if (!group) void context.reply('Command Scene hanya dapat digunakan di dalam grup WhatsApp.')
  return group
}

function requireEnabled(context: CommandContext, group: string): boolean {
  if (scene(context).isEnabled(group)) return true
  void context.reply(`Fitur Scene belum aktif untuk grup ini. Admin dapat mengaktifkannya dengan ${context.prefix}setscene on.`)
  return false
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function renderScene(record: SceneRecord, participantCount?: number, participant?: SceneParticipantRecord): string {
  return [
    `🎭 *Scene ${shortId(record.id)}*`,
    `Judul: ${record.title}`,
    `Visibility: ${record.visibility}`,
    `Status: ${record.status}`,
    `Peserta aktif: ${participantCount ?? '-'}`,
    participant ? `Mode kamu: ${participant.mode.toUpperCase()}` : undefined,
    `Berakhir: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'tidak ditentukan'}`,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function renderList(views: readonly SceneView[]): string {
  if (views.length === 0) return 'Belum ada scene aktif yang terlihat pada scope kamu.'
  return ['🎭 *Scene aktif*', ...views.map((view) => `• ${shortId(view.scene.id)} — ${view.scene.title} [${view.scene.visibility}/${view.scene.status}] · ${view.participantCount} peserta`)].join('\n')
}

function parseOpenArgs(args: readonly string[]): { title: string; visibility: 'public' | 'private'; ttlMinutes?: number } {
  const values = [...args]
  let visibility: 'public' | 'private' = 'public'
  const visibilityIndex = values.findIndex((value) => value.toLowerCase() === 'private' || value.toLowerCase() === 'public')
  if (visibilityIndex >= 0) visibility = values.splice(visibilityIndex, 1)[0].toLowerCase() as 'public' | 'private'
  let ttlMinutes: number | undefined
  const ttlIndex = values.findIndex((value) => value.toLowerCase().startsWith('ttl='))
  if (ttlIndex >= 0) {
    const raw = values.splice(ttlIndex, 1)[0].slice(4)
    ttlMinutes = Number(raw)
    if (!Number.isInteger(ttlMinutes)) throw new Error('TTL harus berupa angka menit bulat')
  }
  return { title: values.join(' ').trim(), visibility, ...(ttlMinutes === undefined ? {} : { ttlMinutes }) }
}

function parseConsent(args: readonly string[]): { sceneId: string; action: string; enabled: boolean; ttlMinutes?: number } {
  const [sceneId, action, mode, ttlValue] = args
  if (!sceneId || !action || !mode || (mode !== 'on' && mode !== 'off')) throw new Error('Format: !consent <sceneId> <action> <on|off> [menit]')
  const ttlMinutes = ttlValue === undefined ? undefined : Number(ttlValue)
  if (ttlValue !== undefined && !Number.isInteger(ttlMinutes)) throw new Error('TTL consent harus berupa angka menit bulat')
  return { sceneId, action, enabled: mode === 'on', ...(ttlMinutes === undefined ? {} : { ttlMinutes }) }
}

function sceneHelp(prefix: string): string {
  return [
    `${prefix}scene`,
    `${prefix}scene open <judul> [public|private] [ttl=menit]`,
    `${prefix}scene join <id>`,
    `${prefix}scene leave <id>`,
    `${prefix}scene status <id>`,
    `${prefix}scene pause|resume|close <id>`,
    `${prefix}ic|ooc <id>`,
    `${prefix}pause <id>`,
    `${prefix}consent <id> <participate|share_context|receive_assistance> <on|off> [menit]`,
  ].join('\n')
}

export function createScenePlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'scene',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'scene',
        description: 'Manage bounded roleplay scenes',
        category: 'roleplay',
        menuOrder: 1,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; command Scene ditolak.')
            return
          }
          const action = commandContext.args[0]?.toLowerCase()
          if (!action) {
            await commandContext.reply(renderList(scene(commandContext).listVisibleScenes(group, actor)))
            return
          }
          try {
            const service = scene(commandContext)
            if (action === 'open') {
              const parsed = parseOpenArgs(commandContext.args.slice(1))
              const created = service.openScene({ groupJid: group, creatorJid: actor, ...parsed })
              await commandContext.reply(`✅ Scene dibuat.\n${renderScene(created, 1, { sceneId: created.id, userJid: actor, role: 'owner', status: 'active', mode: 'ooc', joinedAt: created.createdAt, updatedAt: created.updatedAt })}`)
            } else if (action === 'join') {
              const participant = service.joinScene(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(`✅ Kamu bergabung ke scene ${shortId(participant.sceneId)} sebagai OOC. Consent harus diberikan terpisah melalui ${commandContext.prefix}consent.`)
            } else if (action === 'leave') {
              const left = service.leaveScene(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(left ? `✅ Kamu keluar dari scene ${commandContext.args[1]}. Consent aktif ditarik.` : 'Kamu tidak sedang menjadi peserta aktif scene tersebut.')
            } else if (action === 'status') {
              const view = service.getVisibleScene(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(view ? renderScene(view.scene, view.participantCount, view.participant) : 'Scene tidak ditemukan atau tidak terlihat pada scope kamu.')
            } else if (action === 'pause' || action === 'resume' || action === 'close') {
              const reference = commandContext.args[1] ?? ''
              const updated = action === 'pause'
                ? service.pauseScene(group, reference, actor)
                : action === 'resume'
                  ? service.resumeScene(group, reference, actor)
                  : service.closeScene(group, reference, actor)
              await commandContext.reply(`✅ Lifecycle scene diperbarui.\n${renderScene(updated)}`)
            } else {
              await commandContext.reply(sceneHelp(commandContext.prefix))
            }
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Operasi Scene ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'setscene',
        description: 'Enable or disable Scene per group',
        category: 'roleplay',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setscene <on|off>`)
            return
          }
          scene(commandContext).setEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Scene untuk grup ini: *${mode}*.`)
        },
      })

      for (const mode of ['ic', 'ooc'] as const) {
        context.commands.register({
          name: mode,
          description: `Set current scene mode to ${mode.toUpperCase()}`,
          category: 'roleplay',
          menuOrder: mode === 'ic' ? 3 : 4,
          handler: async (commandContext) => {
            await updateMode(commandContext, whatsapp, mode)
          },
        })
      }

      context.commands.register({
        name: 'pause',
        description: 'Pause a scene owned by the actor',
        category: 'roleplay',
        menuOrder: 5,
        handler: async (commandContext) => {
          await transitionShortcut(commandContext, whatsapp, 'pause')
        },
      })

      context.commands.register({
        name: 'consent',
        description: 'Grant or withdraw scoped scene consent',
        category: 'roleplay',
        menuOrder: 6,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; consent ditolak.')
            return
          }
          try {
            const parsed = parseConsent(commandContext.args)
            const consent = scene(commandContext).setConsent({ groupJid: group, sceneReference: parsed.sceneId, userJid: actor, ...parsed })
            await commandContext.reply(`✅ Consent *${consent.action}* untuk scene ${shortId(consent.sceneId)}: *${consent.enabled ? 'on' : 'off'}*.${consent.expiresAt ? ` Berlaku sampai ${new Date(consent.expiresAt).toISOString()}.` : ''}`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Consent ditolak oleh validasi.')
          }
        },
      })
    },
  }
}

async function updateMode(commandContext: CommandContext, whatsapp: WhatsAppPort, mode: SceneMode): Promise<void> {
  const group = requireGroup(commandContext)
  if (!group || !requireEnabled(commandContext, group)) return
  const actor = actorJid(commandContext.message, whatsapp)
  if (!actor || !commandContext.args[0]) {
    await commandContext.reply(`Format: ${commandContext.prefix}${mode} <sceneId>`)
    return
  }
  try {
    const participant = scene(commandContext).setMode(group, commandContext.args[0], actor, mode)
    await commandContext.reply(`✅ Scene ${shortId(participant.sceneId)} sekarang berlabel *${participant.mode.toUpperCase()}*. Label ini hanya metadata presentasi, bukan permission.`)
  } catch (error) {
    await commandContext.reply(error instanceof Error ? error.message : 'Mode scene ditolak oleh validasi.')
  }
}

async function transitionShortcut(commandContext: CommandContext, whatsapp: WhatsAppPort, action: 'pause'): Promise<void> {
  const group = requireGroup(commandContext)
  if (!group || !requireEnabled(commandContext, group)) return
  const actor = actorJid(commandContext.message, whatsapp)
  if (!actor || !commandContext.args[0]) {
    await commandContext.reply(`Format: ${commandContext.prefix}${action} <sceneId>`)
    return
  }
  try {
    const updated = scene(commandContext).pauseScene(group, commandContext.args[0], actor)
    await commandContext.reply(`✅ Scene ${shortId(updated.id)} dijeda.`)
  } catch (error) {
    await commandContext.reply(error instanceof Error ? error.message : 'Lifecycle scene ditolak oleh validasi.')
  }
}
