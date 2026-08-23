import type { CommandContext, CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../../framework/contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import {
  PersonalizationService,
  type GroupPolicyRecord,
  type PreferenceOverrides,
  type ResolvedPreferences,
  type UserPreferencesRecord,
} from '../../services/personalization-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function personalization(context: { services: ServiceRegistryLike }): PersonalizationService {
  return context.services.get<PersonalizationService>('personalization')
}

function requireGroup(context: CommandContext): string | undefined {
  const group = groupJid(context.message)
  if (!group) void context.reply('Command Personalization hanya dapat digunakan di dalam grup WhatsApp.')
  return group
}

function requireEnabled(context: CommandContext, group: string): boolean {
  if (personalization(context).isEnabled(group)) return true
  void context.reply(`Fitur Personalization belum aktif untuk grup ini. Admin dapat mengaktifkannya dengan ${context.prefix}setpersonalization on.`)
  return false
}

function normalizeArgs(args: readonly string[]): string {
  return args.join(' ').trim()
}

function renderQuiet(quietHours: ResolvedPreferences['quietHours']): string {
  return quietHours ? `${quietHours.start}-${quietHours.end}` : 'off'
}

function renderEffective(preferences: ResolvedPreferences): string {
  return [
    '⚙️ *Personalization efektif*',
    `Language: ${preferences.language} (${preferences.sources.language})`,
    `Timezone: ${preferences.timezone} (${preferences.sources.timezone})`,
    `Quiet hours: ${renderQuiet(preferences.quietHours)} (${preferences.sources.quietHours})`,
    `Notifications: ${preferences.notificationsEnabled ? 'on' : 'off'} (${preferences.sources.notificationsEnabled})`,
    `Verbosity: ${preferences.verbosity} (${preferences.sources.verbosity})`,
    `Format: ${preferences.format} (${preferences.sources.format})`,
    '',
    'Precedence: override kamu → policy grup → default global.',
  ].join('\n')
}

function renderOverrides(title: string, overrides: PreferenceOverrides | undefined): string {
  if (!overrides) return `${title}: belum ada override.`
  const lines = [title]
  if (overrides.language !== undefined) lines.push(`Language: ${overrides.language}`)
  if (overrides.timezone !== undefined) lines.push(`Timezone: ${overrides.timezone}`)
  if (overrides.quietHours !== undefined) lines.push(`Quiet hours: ${overrides.quietHours ? `${overrides.quietHours.start}-${overrides.quietHours.end}` : 'off'}`)
  if (overrides.notificationsEnabled !== undefined) lines.push(`Notifications: ${overrides.notificationsEnabled ? 'on' : 'off'}`)
  if (overrides.verbosity !== undefined) lines.push(`Verbosity: ${overrides.verbosity}`)
  if (overrides.format !== undefined) lines.push(`Format: ${overrides.format}`)
  return lines.length === 1 ? `${title}: belum ada override.` : lines.join('\n')
}

function renderUserPreferences(record: UserPreferencesRecord | undefined): string {
  return renderOverrides('Override pribadi', record)
}

function renderGroupPolicy(record: GroupPolicyRecord | undefined): string {
  return renderOverrides('Policy grup', record)
}

function parseQuiet(value: string): { start: string; end: string } | null {
  if (value.toLowerCase() === 'off') return null
  const parts = value.split('-').map((part) => part.trim())
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Format quiet hours: HH:mm-HH:mm atau off')
  return { start: parts[0], end: parts[1] }
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === 'on') return true
  if (value === 'off') return false
  return undefined
}

function userHelp(prefix: string): string {
  return [
    `Format: ${prefix}myprefs`,
    `${prefix}mylanguage <id|en>`,
    `${prefix}mytimezone <IANA timezone>`,
    `${prefix}quiet <HH:mm-HH:mm|off>`,
    `${prefix}notify <on|off>`,
    `${prefix}verbosity <brief|normal|detailed>`,
    `${prefix}format <plain|accessible>`,
  ].join('\n')
}

function groupHelp(prefix: string): string {
  return [
    `Format admin: ${prefix}preferences <language|timezone|quiet|notify|verbosity|format> <nilai>`,
    `Contoh: ${prefix}preferences quiet 22:00-07:00`,
    `Reset quiet: ${prefix}preferences quiet off`,
  ].join('\n')
}

export function createPersonalizationPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'personalization',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'personalization',
        aliases: ['personal'],
        description: 'Show Personalization status and scope',
        category: 'personalization',
        menuOrder: 1,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const enabled = personalization(commandContext).isEnabled(group)
          await commandContext.reply(`⚙️ Personalization: *${enabled ? 'aktif' : 'off'}*\nPreference tidak mengubah permission atau side effect.\nAktifkan: ${commandContext.prefix}setpersonalization on`)
        },
      })

      context.commands.register({
        name: 'setpersonalization',
        description: 'Enable or disable Personalization per group',
        category: 'personalization',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setpersonalization <on|off>`)
            return
          }
          personalization(commandContext).setEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Personalization untuk grup ini: *${mode}*.`)
        },
      })

      context.commands.register({
        name: 'myprefs',
        aliases: ['mypreferences', 'prefs'],
        description: 'Show effective and personal preferences',
        category: 'personalization',
        menuOrder: 3,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; preference ditolak.')
            return
          }
          const service = personalization(commandContext)
          const effective = service.resolvePreferences(group, actor)
          const personal = service.exportUserPreferences(group, actor)
          const policy = service.getGroupPolicy(group)
          await commandContext.reply([renderEffective(effective), '', renderUserPreferences(personal), renderGroupPolicy(policy), '', userHelp(commandContext.prefix)].join('\n'))
        },
      })

      context.commands.register({
        name: 'preferences',
        aliases: ['groupprefs'],
        description: 'Set group notification and presentation policy',
        category: 'personalization',
        menuOrder: 4,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const key = commandContext.args[0]?.toLowerCase()
          const value = normalizeArgs(commandContext.args.slice(1))
          if (!actor || !key || !value) {
            await commandContext.reply(groupHelp(commandContext.prefix))
            return
          }
          const service = personalization(commandContext)
          try {
            let updated: GroupPolicyRecord
            if (key === 'language') updated = service.setGroupLanguage(group, actor, value)
            else if (key === 'timezone') updated = service.setGroupTimezone(group, actor, value)
            else if (key === 'quiet') updated = service.setGroupQuietHours(group, actor, parseQuiet(value))
            else if (key === 'notify') {
              const enabled = parseBoolean(value.toLowerCase())
              if (enabled === undefined) throw new Error('Format notify: on atau off')
              updated = service.setGroupNotifications(group, actor, enabled)
            } else if (key === 'verbosity') updated = service.setGroupVerbosity(group, actor, value)
            else if (key === 'format') updated = service.setGroupFormat(group, actor, value)
            else {
              await commandContext.reply(groupHelp(commandContext.prefix))
              return
            }
            await commandContext.reply(`✅ Policy grup diperbarui.\n${renderGroupPolicy(updated)}`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Policy grup ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'mylanguage',
        description: 'Set personal language preference',
        category: 'personalization',
        menuOrder: 5,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'language')
        },
      })

      context.commands.register({
        name: 'mytimezone',
        description: 'Set personal IANA timezone preference',
        category: 'personalization',
        menuOrder: 6,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'timezone')
        },
      })

      context.commands.register({
        name: 'quiet',
        description: 'Set personal quiet hours',
        category: 'personalization',
        menuOrder: 7,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'quiet')
        },
      })

      context.commands.register({
        name: 'notify',
        description: 'Enable or disable personal notifications',
        category: 'personalization',
        menuOrder: 8,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'notify')
        },
      })

      context.commands.register({
        name: 'verbosity',
        aliases: ['balasan'],
        description: 'Set personal response verbosity',
        category: 'personalization',
        menuOrder: 9,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'verbosity')
        },
      })

      context.commands.register({
        name: 'format',
        description: 'Set personal accessibility format',
        category: 'personalization',
        menuOrder: 10,
        handler: async (commandContext) => {
          await updateUser(commandContext, whatsapp, 'format')
        },
      })
    },
  }
}

async function updateUser(
  commandContext: CommandContext,
  whatsapp: WhatsAppPort,
  field: 'language' | 'timezone' | 'quiet' | 'notify' | 'verbosity' | 'format',
): Promise<void> {
  const group = requireGroup(commandContext)
  if (!group || !requireEnabled(commandContext, group)) return
  const actor = actorJid(commandContext.message, whatsapp)
  const value = normalizeArgs(commandContext.args)
  if (!actor || !value) {
    await commandContext.reply(`Format: ${commandContext.prefix}${field === 'quiet' ? 'quiet <HH:mm-HH:mm|off>' : field === 'notify' ? 'notify <on|off>' : `${field} <nilai>`}`)
    return
  }
  const service = personalization(commandContext)
  try {
    let record: UserPreferencesRecord
    if (field === 'language') record = service.setUserLanguage(group, actor, value)
    else if (field === 'timezone') record = service.setUserTimezone(group, actor, value)
    else if (field === 'quiet') record = service.setUserQuietHours(group, actor, parseQuiet(value))
    else if (field === 'notify') {
      const enabled = parseBoolean(value.toLowerCase())
      if (enabled === undefined) throw new Error('Format notify: on atau off')
      record = service.setUserNotifications(group, actor, enabled)
    } else if (field === 'verbosity') record = service.setUserVerbosity(group, actor, value)
    else record = service.setUserFormat(group, actor, value)
    await commandContext.reply(`✅ Preference pribadi diperbarui.\n${renderUserPreferences(record)}`)
  } catch (error) {
    await commandContext.reply(error instanceof Error ? error.message : 'Preference ditolak oleh validasi.')
  }
}
