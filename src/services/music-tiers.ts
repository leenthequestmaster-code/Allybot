import type { Config } from './music-config.js'

export type Tier = 'owner' | 'premium' | 'free'

/**
 * Determine the tier for a user in the current chat context.
 * Priority: owners > premium_users > premium_groups > free
 */
export function getTier(
  userJid: string,
  groupJid: string | undefined,
  config: Config,
): Tier {
  // Normalize JID by stripping device suffix if present
  const normalizeJid = (jid: string): string => jid.split(':')[0] ?? jid

  const normalizedUser = normalizeJid(userJid)

  if (config.owners.some((o) => normalizeJid(o) === normalizedUser)) {
    return 'owner'
  }

  if (config.premium_users.some((u) => normalizeJid(u) === normalizedUser)) {
    return 'premium'
  }

  if (
    groupJid &&
    config.premium_groups.some((g) => normalizeJid(g) === normalizeJid(groupJid))
  ) {
    return 'premium'
  }

  return 'free'
}
