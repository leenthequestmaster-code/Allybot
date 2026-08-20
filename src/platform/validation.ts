export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

export function isSafeIdentifier(value: string): boolean {
  return /^[-a-z0-9]+$/.test(value)
}

export function isJid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value)
}

export function isGroupJid(value: string): boolean {
  return isJid(value) && value.endsWith('@g.us')
}

export function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}
