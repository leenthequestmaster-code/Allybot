import type { CommandContext, WhatsAppPort } from './framework/contracts.js'

export const permissionNames = {
  botOwner: 'bot.owner',
  groupAdmin: 'group.admin',
  groupOwner: 'group.owner',
} as const

function bareJid(jid: string): string {
  return jid.split(':')[0] ?? jid
}

function normalizePhoneJid(value?: string): string | undefined {
  if (!value) return undefined
  return bareJid(value.includes('@') ? value : `${value}@s.whatsapp.net`)
}

function isSameJid(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return bareJid(left) === bareJid(right)
}

export function createPermissionResolver(
  whatsapp: WhatsAppPort,
  botOwnerJid?: string,
): (permission: string, context: CommandContext) => Promise<boolean> {
  const normalizedBotOwnerJid = normalizePhoneJid(botOwnerJid)

  return async (permission, context) => {
    const senderJid = context.message.senderJid
    if (!senderJid) return false

    if (permission === permissionNames.botOwner) {
      return isSameJid(senderJid, normalizedBotOwnerJid)
    }

    if (!context.message.remoteJid.endsWith('@g.us')) return false

    const metadata = await whatsapp.getGroupMetadata(context.message.remoteJid)
    const sender = metadata.participants.find((participant) => isSameJid(participant.jid, senderJid))
    if (!sender) return false

    if (permission === permissionNames.groupAdmin) {
      return sender.role === 'admin' || sender.role === 'superadmin'
    }

    if (permission === permissionNames.groupOwner) {
      return sender.role === 'superadmin' || isSameJid(metadata.ownerJid, senderJid)
    }

    return false
  }
}
