export interface LinkEvaluationResult {
  readonly hasLinks: boolean
  readonly hasForbiddenLinks: boolean
  readonly detectedLinks: readonly string[]
  readonly forbiddenLinks: readonly string[]
  readonly whitelistedLinks: readonly string[]
}

const COMMON_TLDS = '(?:com|net|org|id|xyz|site|me|info|top|online|vip|app|dev|cc|co|io|biz|club|store|shop|pro|asia|tech)'

const OBFUSCATED_DOT_REGEX = /\[\.\]|\(dot\)|\s*\[dot\]\s*/gi

// URL matchers
const PROTOCOL_URL_REGEX = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>]+/gi

const SHORTLINK_REGEX = /(?:wa\.me|t\.me|chat\.whatsapp\.com|whatsapp\.com\/channel|bit\.ly|s\.id|tinyurl\.com|linktr\.ee)\/[^\s<>]+/gi

const DOMAIN_TLD_REGEX = new RegExp(
  '\\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.' + COMMON_TLDS + '(?:\\/[^\\s<>]*)?',
  'gi',
)

const WA_CHANNEL_REGEX = /^(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/[a-zA-Z0-9_-]+/i

function cleanPunctuation(url: string): string {
  return url.replace(/[.,;!?)\\]]+$/, '')
}

export function cleanObfuscatedDots(text: string): string {
  if (!text) return ''
  return text.replace(OBFUSCATED_DOT_REGEX, '.')
}

export function extractUrls(text: string): string[] {
  if (!text) return []
  const cleaned = cleanObfuscatedDots(text)
  const rawMatches = new Set<string>()

  const pMatches = cleaned.match(PROTOCOL_URL_REGEX)
  if (pMatches) {
    for (const m of pMatches) {
      const trimmed = cleanPunctuation(m.trim())
      if (trimmed) rawMatches.add(trimmed)
    }
  }

  const sMatches = cleaned.match(SHORTLINK_REGEX)
  if (sMatches) {
    for (const m of sMatches) {
      const trimmed = cleanPunctuation(m.trim())
      if (trimmed) rawMatches.add(trimmed)
    }
  }

  const dMatches = cleaned.match(DOMAIN_TLD_REGEX)
  if (dMatches) {
    for (const m of dMatches) {
      const trimmed = cleanPunctuation(m.trim())
      if (trimmed) rawMatches.add(trimmed)
    }
  }

  // Deduplicate substrings so 'whatsapp.com/...' is merged into 'https://whatsapp.com/...'
  const sorted = [...rawMatches].sort((a, b) => b.length - a.length)
  const result: string[] = []
  for (const item of sorted) {
    if (!result.some((existing) => existing.includes(item))) {
      result.push(item)
    }
  }

  return result
}

export function isWhatsAppChannelLink(url: string): boolean {
  if (!url) return false
  return WA_CHANNEL_REGEX.test(url)
}

export function extractGroupInviteCode(url: string): string | undefined {
  if (!url) return undefined
  const match = /(?:chat\.whatsapp\.com\/(?:invite\/)?)([a-zA-Z0-9_-]+)/i.exec(url)
  if (match) return match[1]
  const trimmed = url.trim()
  if (/^[a-zA-Z0-9_-]{10,40}$/.test(trimmed)) return trimmed
  return undefined
}

export function isCurrentGroupInviteLink(url: string, currentInviteLink?: string): boolean {
  if (!url || !currentInviteLink) return false
  const targetCode = extractGroupInviteCode(url)
  const currentCode = extractGroupInviteCode(currentInviteLink)
  if (!targetCode || !currentCode) return false
  return targetCode.toLowerCase() === currentCode.toLowerCase()
}

export function evaluateMessageLinks(text: string, currentGroupInviteLink?: string): LinkEvaluationResult {
  const detectedLinks = extractUrls(text)
  if (detectedLinks.length === 0) {
    return {
      hasLinks: false,
      hasForbiddenLinks: false,
      detectedLinks: [],
      forbiddenLinks: [],
      whitelistedLinks: [],
    }
  }

  const forbiddenLinks: string[] = []
  const whitelistedLinks: string[] = []

  for (const link of detectedLinks) {
    if (isWhatsAppChannelLink(link)) {
      whitelistedLinks.push(link)
    } else if (isCurrentGroupInviteLink(link, currentGroupInviteLink)) {
      whitelistedLinks.push(link)
    } else {
      forbiddenLinks.push(link)
    }
  }

  return {
    hasLinks: true,
    hasForbiddenLinks: forbiddenLinks.length > 0,
    detectedLinks,
    forbiddenLinks,
    whitelistedLinks,
  }
}
