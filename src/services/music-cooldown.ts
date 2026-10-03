import type { Config } from './music-config.js'
import type { Tier } from './music-tiers.js'

interface CooldownEntry {
  lastCallAt: number
}

const cooldowns = new Map<string, CooldownEntry>()

// ─── Cleanup stale entries every 5 min ───────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  for (const [jid, entry] of cooldowns.entries()) {
    // Remove entries that are very old (> 1 hour, well past any cooldown)
    if (now - entry.lastCallAt > 3_600_000) {
      cooldowns.delete(jid)
    }
  }
}, 5 * 60 * 1000)

// ─── API ──────────────────────────────────────────────────────────────────────

export function checkCooldown(
  jid: string,
  isGroup: boolean,
  tier: Tier,
  config: Config,
): { ok: boolean; remaining: number } {
  // Owners: always ok
  if (tier === 'owner') return { ok: true, remaining: 0 }

  // Premium in group: always ok
  if (isGroup && tier === 'premium') return { ok: true, remaining: 0 }

  const cooldownMs = isGroup ? config.cooldown_group_ms : config.cooldown_dm_ms
  const entry = cooldowns.get(jid)

  if (!entry) return { ok: true, remaining: 0 }

  const elapsed = Date.now() - entry.lastCallAt
  if (elapsed >= cooldownMs) return { ok: true, remaining: 0 }

  return { ok: false, remaining: cooldownMs - elapsed }
}

export function markCall(jid: string): void {
  cooldowns.set(jid, { lastCallAt: Date.now() })
}

export function resetCooldown(jid: string): void {
  cooldowns.delete(jid)
}
