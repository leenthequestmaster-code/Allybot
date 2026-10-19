/**
 * WhatsApp message sanitizers.
 *
 * These helpers are intentionally dependency-free and pure so they can be used
 * by plugins, services, and tests without pulling in the Baileys runtime.
 */

/** WhatsApp renders `*bold*`, `_italic_`, `~strike~`, and `` `mono` ``. */
const WA_MARKDOWN_CHARS = /([*_~`])/g
const BACKSLASH = /\\/g

/** Maximum number of code points accepted by a single WhatsApp text message. */
export const WA_MAX_TEXT_CHARS = 4096

/**
 * Invisible / zero-width code points that carry no visible glyph.
 *
 * U+200D (zero-width joiner) is handled separately because it is meaningful
 * inside emoji sequences such as `👨‍👩‍👧`.
 */
const ZERO_WIDTH_PATTERN =
  /[\u200B\u200C\u200D\uFEFF\u00AD\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u034F\u180E\u061C\u17B4\u17B5]/g

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/**
 * Emoji modifiers that sit *between* a pictograph and a zero-width joiner:
 * variation selectors U+FE0E/U+FE0F and skin-tone modifiers U+1F3FB–U+1F3FF.
 *
 * They are invisible on their own, so a joiner must look past them to decide
 * whether the surrounding code points are actually pictographs.
 */
const EMOJI_VARIATION_OR_MODIFIER = /^[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]$/u

/**
 * ANSI escape sequences: OSC (hyperlinks, titles) terminated by BEL or ST,
 * followed by CSI sequences (colors, cursor movement) and short escapes.
 */
const ANSI_OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
const ANSI_CSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

const DEFAULT_TRUNCATE_SUFFIX = '…'
const PHONE_JID_DOMAIN = 's.whatsapp.net'
const PHONE_JID_DOMAINS: ReadonlySet<string> = new Set([PHONE_JID_DOMAIN, 'lid'])
const MIN_PHONE_DIGITS = 6
const MAX_PHONE_DIGITS = 15

const MENTION_CANDIDATE_PATTERN = /(?<![\p{L}\p{N}_@])@(\+?\d[\d \t().-]{0,30}\d)/gu
const LEADING_DIGITS_PATTERN = /^\+?\d+/

export interface PhoneMention {
  readonly jid: string
  readonly mentionText: string
}

/**
 * Escape WhatsApp markdown control characters so user text is rendered
 * literally. Every `*`, `_`, `~`, and backtick is prefixed with a backslash,
 * and existing backslashes are escaped first to keep the output stable.
 */
export function escapeWAMarkdown(text: string): string {
  if (!text) return ''
  return text.replace(BACKSLASH, '\\\\').replace(WA_MARKDOWN_CHARS, '\\$1')
}

function previousCodePoint(text: string, index: number): string {
  if (index <= 0) return ''
  const unit = text.charCodeAt(index - 1)
  if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) {
    return text.slice(index - 2, index)
  }
  return text[index - 1] ?? ''
}

function nextCodePoint(text: string, index: number): string {
  const codePoint = text.codePointAt(index)
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint)
}

/**
 * Walk left from `index`, skipping emoji variation selectors and skin-tone
 * modifiers, and return the first meaningful code point (or `''`).
 */
function significantCodePointBefore(text: string, index: number): string {
  let cursor = index
  while (cursor > 0) {
    const char = previousCodePoint(text, cursor)
    if (!char) return ''
    if (!EMOJI_VARIATION_OR_MODIFIER.test(char)) return char
    cursor -= char.length
  }
  return ''
}

/**
 * Walk right from `index`, skipping emoji variation selectors and skin-tone
 * modifiers, and return the first meaningful code point (or `''`).
 */
function significantCodePointAfter(text: string, index: number): string {
  let cursor = index
  while (cursor < text.length) {
    const char = nextCodePoint(text, cursor)
    if (!char) return ''
    if (!EMOJI_VARIATION_OR_MODIFIER.test(char)) return char
    cursor += char.length
  }
  return ''
}

/**
 * Remove zero-width and bidi-control characters.
 *
 * Zero-width joiners are preserved only when they join two emoji, so composite
 * emoji (`👨‍👩‍👧`, `👩‍💻`, `🏳️‍🌈`, `👩🏽‍🚀`) keep their shape while
 * invisible text injection is still stripped. Variation selectors and skin-tone
 * modifiers between a pictograph and the joiner are skipped when looking for the
 * neighbouring pictograph.
 */
export function stripZeroWidth(text: string): string {
  if (!text) return ''
  return text.replace(ZERO_WIDTH_PATTERN, (char, offset: number) => {
    if (char === '\u200D') {
      const previous = significantCodePointBefore(text, offset)
      const next = significantCodePointAfter(text, offset + 1)
      if (previous && next && EXTENDED_PICTOGRAPHIC.test(previous) && EXTENDED_PICTOGRAPHIC.test(next)) {
        return char
      }
    }
    return ''
  })
}

/** Remove ANSI/VT100 escape sequences (colors, cursor movement, OSC links). */
export function stripAnsi(text: string): string {
  if (!text) return ''
  return text.replace(ANSI_OSC_PATTERN, '').replace(ANSI_CSI_PATTERN, '')
}

let graphemeSegmenter: Intl.Segmenter | undefined

function splitGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
  }
  return Array.from(text)
}

/**
 * Truncate a message to `maxChars` code points (suffix included).
 *
 * Truncation happens on grapheme boundaries, so surrogate pairs and composite
 * emoji are never cut in half. Non-finite limits fall back to
 * {@link WA_MAX_TEXT_CHARS}; negative limits produce an empty string.
 */
export function truncateWAMessage(
  text: string,
  maxChars: number = WA_MAX_TEXT_CHARS,
  suffix: string = DEFAULT_TRUNCATE_SUFFIX,
): string {
  if (!text) return ''
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : WA_MAX_TEXT_CHARS
  if (limit === 0) return ''
  if (Array.from(text).length <= limit) return text

  const tail = typeof suffix === 'string' ? Array.from(suffix) : []
  if (tail.length >= limit) return tail.slice(0, limit).join('')

  const budget = limit - tail.length
  let result = ''
  let used = 0
  for (const grapheme of splitGraphemes(text)) {
    const size = Array.from(grapheme).length
    if (used + size > budget) break
    result += grapheme
    used += size
  }
  return result + tail.join('')
}

function normalizePhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.startsWith('00') ? digits.slice(2) : digits
}

/**
 * Normalize a phone number or JID into a mention target.
 *
 * Accepts bare digits, international prefixes (`+62 812-3456-789`), device
 * suffixed JIDs (`628123456789:12@s.whatsapp.net`), and LID JIDs. The domain is
 * preserved for `lid`, otherwise `s.whatsapp.net` is used.
 *
 * @throws {TypeError} when the input is not a string.
 * @throws {RangeError} when the input does not contain a usable phone number.
 */
export function formatPhoneMention(jidOrPhone: string): PhoneMention {
  if (typeof jidOrPhone !== 'string') {
    throw new TypeError('Phone number or JID must be a string')
  }
  const trimmed = jidOrPhone.trim()
  if (!trimmed) throw new RangeError('Phone number or JID must not be empty')

  const at = trimmed.lastIndexOf('@')
  const domain = at === -1 ? PHONE_JID_DOMAIN : trimmed.slice(at + 1).toLowerCase()
  if (!PHONE_JID_DOMAINS.has(domain)) {
    throw new RangeError(`Unsupported WhatsApp JID domain: ${domain || '(empty)'}`)
  }

  const userPart = at === -1 ? trimmed : trimmed.slice(0, at)
  const digits = normalizePhoneDigits(userPart.split(':')[0] ?? '')
  if (!/^\d+$/.test(digits) || digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    throw new RangeError(`Invalid phone number: ${jidOrPhone}`)
  }

  return {
    jid: `${digits}@${domain}`,
    mentionText: `@${digits}`,
  }
}

/**
 * Extract phone-number mentions (`@628123456789`, `@+62 812-3456-789`) from a
 * message and return deduplicated phone JIDs in first-appearance order.
 *
 * Emails and handles preceded by a word character are ignored, as are
 * candidates outside the 6–15 digit range.
 */
export function extractMentions(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_CANDIDATE_PATTERN)) {
    const candidate = (match[1] ?? '').replace(/[\s().-]+$/, '')
    let digits = normalizePhoneDigits(candidate)
    if (digits.length > MAX_PHONE_DIGITS) {
      // The candidate may have swallowed the next token; retry with the
      // contiguous leading run before giving up on it.
      digits = normalizePhoneDigits(LEADING_DIGITS_PATTERN.exec(candidate)?.[0] ?? '')
    }
    if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) continue
    seen.add(`${digits}@${PHONE_JID_DOMAIN}`)
  }
  return [...seen]
}

/**
 * Drop a single trailing backslash left behind when truncation cuts an escaped
 * markdown pair in half. A literal backslash from the source is stored as a
 * pair (`\\`), so only an odd trailing run is considered dangling.
 */
function stripDanglingBackslash(text: string): string {
  let trailing = 0
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i -= 1) trailing += 1
  return trailing % 2 === 1 ? text.slice(0, -1) : text
}

/**
 * One-stop sanitizer for an outgoing WhatsApp text message.
 *
 * Composes the individual sanitizers in order: ANSI/OSC escapes, zero-width and
 * bidi controls, then markdown escaping, and finally truncates to `maxChars`
 * code points (default {@link WA_MAX_TEXT_CHARS}). Truncation is a hard cut so
 * the payload never exceeds the budget, and because it can slice an escaped
 * markdown pair a lone trailing backslash is removed.
 */
export function sanitizeWAMessage(text: string, maxChars: number = WA_MAX_TEXT_CHARS): string {
  if (!text) return ''
  const cleaned = escapeWAMarkdown(stripZeroWidth(stripAnsi(text)))
  return stripDanglingBackslash(truncateWAMessage(cleaned, maxChars, ''))
}
