const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\uFEFF\u00AD\u200E\u200F\u202A-\u202E\u2060\u034F\u17B4\u17B5\u180E]/g

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0430': 'a', '\u0410': 'a', '\u0431': 'b', '\u0432': 'b', '\u0433': 'r', '\u0434': 'd',
  '\u0435': 'e', '\u0415': 'e', '\u0451': 'e', '\u0436': 'zh', '\u0437': 'z', '\u0438': 'u',
  '\u0439': 'u', '\u043A': 'k', '\u041A': 'k', '\u043B': 'l', '\u043C': 'm', '\u041C': 'm',
  '\u043D': 'h', '\u041D': 'h', '\u043E': 'o', '\u041E': 'o', '\u043F': 'n', '\u0440': 'p',
  '\u0420': 'p', '\u0441': 'c', '\u0421': 'c', '\u0442': 't', '\u0422': 't', '\u0443': 'y',
  '\u0423': 'y', '\u0444': 'f', '\u0445': 'x', '\u0425': 'x', '\u0456': 'i', '\u0406': 'i',
  '\u0457': 'i', '\u0454': 'e', '\u0455': 's', '\u0458': 'j',
  // Greek
  '\u03B1': 'a', '\u03B2': 'b', '\u03B3': 'y', '\u03B4': 'd', '\u03B5': 'e', '\u03B6': 'z',
  '\u03B7': 'n', '\u03B8': 'o', '\u03B9': 'i', '\u03BA': 'k', '\u03BB': 'l', '\u03BC': 'm',
  '\u03BD': 'v', '\u03BE': 'x', '\u03BF': 'o', '\u03C0': 'n', '\u03C1': 'p', '\u03C2': 's',
  '\u03C3': 's', '\u03C4': 't', '\u03C5': 'u', '\u03C6': 'f', '\u03C7': 'x', '\u03C8': 'ps',
  '\u03C9': 'w',
  // Lao digits / others
  '\u0EEC': 'o', '\u0ED1': '1', '\u0ED2': '2',
}

const LEETSPEAK: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '$': 's',
  '5': 's',
  '7': 't',
  '8': 'b',
  '!': 'i',
}

export function stripInvisible(text: string): string {
  if (!text) return ''
  return text.replace(INVISIBLE_CHARS_REGEX, '')
}

export function normalizeHomoglyphs(text: string): string {
  if (!text) return ''
  const decomposed = text.normalize('NFKD')
  let result = ''
  for (const char of decomposed) {
    result += HOMOGLYPHS[char] ?? char
  }
  return result
}

export function collapseDelimiters(text: string): string {
  if (!text) return ''
  // 1. Collapse non-space delimiters between alphanumeric characters: k.o.n.t.o.l or k-o-n-t-o-l or k_o_n_t_o_l
  let result = text.replace(/([a-zA-Z0-9])[._\-*~^/|\\`]+(?=[a-zA-Z0-9])/g, '$1')
  // 2. Collapse spaced single letters when 3 or more occur sequentially: "k o n t o l" -> "kontol"
  result = result.replace(/\b([a-zA-Z0-9])(?:\s+([a-zA-Z0-9])){2,}\b/g, (match) => match.replace(/\s+/g, ''))
  return result
}

export function translateLeetspeak(text: string): string {
  if (!text) return ''
  let result = ''
  for (const char of text) {
    result += LEETSPEAK[char] ?? char
  }
  return result
}

export function normalizeForToxicDetection(text: string): string {
  if (!text) return ''
  let s = stripInvisible(text)
  s = normalizeHomoglyphs(s)
  s = collapseDelimiters(s)
  s = translateLeetspeak(s)
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}
