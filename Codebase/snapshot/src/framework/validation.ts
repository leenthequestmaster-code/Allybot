export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

export function isSafeIdentifier(value: string): boolean {
  return /^[-a-z0-9]+$/.test(value)
}

// Strict WhatsApp JID grammar (Baileys-compatible): a phone user JID is digits
// (optional device suffix) at s.whatsapp.net, a group/community JID is digits with
// an optional dashed suffix at g.us, LID-mapped identities are digits at lid,
// newsletters are digits at newsletter, and the broadcast list is exactly
// status@broadcast. Anything else (x@y, URLs, path-like strings) is rejected.
const WHATSAPP_JID_PATTERN = /^(?:\d+(?::\d+)?@s\.whatsapp\.net|\d+(?:-\d+)*@g\.us|\d+(?:-\d+)*@lid|\d+(?:-\d+)*@newsletter|\d+@broadcast|status@broadcast)$/

export function isJid(value: string): boolean {
  return WHATSAPP_JID_PATTERN.test(value)
}

export function isGroupJid(value: string): boolean {
  return isJid(value) && value.endsWith('@g.us')
}

export function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}
