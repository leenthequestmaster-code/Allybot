export const CHARACTER_GENDERS = ['Male', 'Female', 'Non-Binary'] as const
export type CharacterGender = (typeof CHARACTER_GENDERS)[number]

export const CHARACTER_RACES = [
  'Human', 'Elf', 'Dark Elf', 'Dwarf', 'Giant', 'Orc', 'Fairy', 'Vampire',
  'Pisces', 'Harpy', 'Slime', 'Dragonborn', 'Beastfolk', 'Kitsune', 'Dryad', 'Demon', 'Angel',
] as const
export type CharacterRace = (typeof CHARACTER_RACES)[number]

export const CHARACTER_ELEMENTS = [
  'Fire', 'Water', 'Wind', 'Earth', 'Nature', 'Electro', 'Ice', 'Dark', 'Light',
  'Sound', 'Blood', 'Bone', 'Sand', 'Mist', 'Fruits', 'Paper', 'Magma', 'Gel',
] as const
export type CharacterElement = (typeof CHARACTER_ELEMENTS)[number]

export const CHARACTER_CLASSES = [
  'Knight', 'Samurai', 'Berserker', 'Ninja', 'Thief', 'Assassin', 'Archer', 'Gunslinger', 'Sniper',
  'Sorcerer', 'Necromancer', 'Illusionist', 'Paladin', 'Bard', 'Cleric', 'Trapper', 'Mechanist',
  'Saboteur', 'Puppeteer', 'Jester', 'Sigil Scribe', 'Guardian', 'Sentinel', 'Bulwark',
  'Beastmaster', 'Shapeshifter', 'Summoner',
] as const
export type CharacterClass = (typeof CHARACTER_CLASSES)[number]

export const CHARACTER_BIRTH_MONTHS = [
  'Aurion', 'Florentis', 'Zephyra', 'Emberfall', 'Luminara', 'Verdantia',
  'Solmora', 'Astravia', 'Umbralis', 'Crystelle', 'Nocturne', 'Everglen',
] as const

export const CHARACTER_WILL_OF_PATHS = ['Light', 'Dark', 'Neutral'] as const
export type CharacterWillOfPath = (typeof CHARACTER_WILL_OF_PATHS)[number]

export interface CharacterSheetPayload {
  readonly name: string
  readonly gender: CharacterGender
  readonly age: number
  readonly birthdayDay: number
  readonly birthdayMonth: string
  readonly birthdayYear: number
  readonly race: CharacterRace
  readonly className: CharacterClass
  readonly element: CharacterElement
  readonly spirit?: string
  readonly crew?: string
  readonly willOfPath: CharacterWillOfPath
  readonly profession?: string
  readonly motto?: string
  readonly visual?: string
  readonly origin?: string
}

export interface CharacterParseIssue {
  readonly field?: string
  readonly code: 'missing' | 'invalid' | 'duplicate' | 'ambiguous' | 'unsupported'
  readonly value?: string
  readonly message: string
}

export type CharacterParseResult =
  | { readonly ok: true; readonly payload: CharacterSheetPayload; readonly ignoredFields: readonly string[] }
  | { readonly ok: false; readonly issues: readonly CharacterParseIssue[] }

const FIELD_ALIASES: ReadonlyMap<string, string> = new Map([
  ['name', 'name'], ['nama', 'name'], ['character name', 'name'], ['nama karakter', 'name'],
  ['gender', 'gender'], ['jenis kelamin', 'gender'],
  ['age', 'age'], ['usia', 'age'],
  ['birthday', 'birthday'], ['tanggal lahir', 'birthday'],
  ['race', 'race'], ['ras', 'race'],
  ['class', 'class'], ['kelas', 'class'],
  ['element', 'element'], ['elemen', 'element'],
  ['spirit', 'spirit'], ['roh', 'spirit'],
  ['crew', 'crew'],
  ['rank', 'rank'], ['level', 'level'],
  ['will of path', 'will'], ['will path', 'will'], ['path', 'will'], ['jalur', 'will'],
  ['profession job', 'profession'], ['profession', 'profession'], ['proffession job', 'profession'],
  ['job', 'profession'], ['pekerjaan', 'profession'],
  ['title', 'titles'], ['titles', 'titles'], ['gelar', 'titles'],
  ['money', 'money'], ['vela', 'money'],
  ['membership', 'membership'],
  ['items materials', 'inventory'], ['items', 'inventory'], ['materials', 'inventory'], ['inventory', 'inventory'],
  ['motto', 'motto'], ['slogan', 'motto'],
  ['visual', 'visual'], ['origin', 'origin'],
])

const CONTROLLED_FIELDS = new Set(['rank', 'level', 'titles', 'money', 'membership', 'inventory'])
const REQUIRED_FIELDS = ['name', 'gender', 'age', 'birthday', 'race', 'class', 'element', 'will'] as const
const KNOWN_FIELDS = new Set([...FIELD_ALIASES.values()])
const LABEL_TYPO_ALIASES: ReadonlyMap<string, string> = new Map([
  ['nma', 'name'], ['nam', 'name'], ['gnder', 'gender'], ['gendr', 'gender'], ['ag', 'age'],
  ['birtday', 'birthday'], ['birthdy', 'birthday'], ['rae', 'race'], ['clas', 'class'],
  ['elemen', 'element'], ['elemet', 'element'], ['spiritu', 'spirit'], ['wil of path', 'will'],
  ['profesion', 'profession'], ['proffesion job', 'profession'], ['profesion job', 'profession'],
  ['mot', 'motto'], ['visul', 'visual'], ['origIn', 'origin'],
])

function cleanControl(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/gu, ' ')
    .trim()
}

function unwrapFormatting(value: string): string {
  let current = cleanControl(value).trim()
  for (let index = 0; index < 4; index += 1) {
    const next = current
      .replace(/^(?:[>*•·]+\s*)/u, '')
      .replace(/\s*[>*•·]+$/u, '')
      .replace(/^(\*)([\s\S]*?)\1$/u, '$2')
      .replace(/^(_)([\s\S]*?)\1$/u, '$2')
      .replace(/^(`)([\s\S]*?)\1$/u, '$2')
      .replace(/^(~)([\s\S]*?)\1$/u, '$2')
      .trim()
    if (next === current) break
    current = next
  }
  return current
}

function normalizeLabel(value: string): string {
  return unwrapFormatting(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function canonicalFromList(value: string, values: readonly string[]): string | undefined {
  const normalized = normalizeLabel(value)
  return values.find((candidate) => normalizeLabel(candidate) === normalized)
}

function lineFieldLabel(value: string): string | undefined {
  const normalized = normalizeLabel(value)
  if (FIELD_ALIASES.has(normalized)) return FIELD_ALIASES.get(normalized)
  return LABEL_TYPO_ALIASES.get(normalized)
}

function looksLikeFieldLine(line: string): boolean {
  return /^.{1,60}(?:\s*[:=]\s*|\s+-\s+).+/u.test(cleanControl(line))
}

function parseFieldLine(line: string): { field?: string; value?: string; standalone: boolean } {
  const cleaned = cleanControl(line)
  const separator = cleaned.match(/^(.+?)(?:\s*[:=]\s*|\s+-\s+)(.*)$/u)
  if (separator) {
    const rawValue = separator[2] ?? ''
    return {
      field: lineFieldLabel(separator[1] ?? ''),
      ...(rawValue.trim() ? { value: unwrapFormatting(rawValue) } : {}),
      standalone: !rawValue.trim(),
    }
  }
  const field = lineFieldLabel(cleaned)
  return { field, standalone: Boolean(field) }
}

function parseBirthday(value: string): { day: number; month: string; year: number } | undefined {
  const normalized = unwrapFormatting(value).replace(/\s+/gu, ' ')
  const match = normalized.match(/^(\d{1,2})\s+([\p{L}-]+)\s+(?:KAR\s*)?(\d{3,4})(?:\s*KAR)?$/iu)
  if (!match) return undefined
  const day = Number(match[1])
  const month = canonicalFromList(match[2] ?? '', CHARACTER_BIRTH_MONTHS)
  const year = Number(match[3])
  if (!Number.isInteger(day) || !month || !Number.isInteger(year)) return undefined
  return { day, month, year }
}

function canonicalGender(value: string): CharacterGender | undefined {
  const normalized = normalizeLabel(value)
  if (normalized === 'male' || normalized === 'm' || normalized === 'laki laki' || normalized === 'pria') return 'Male'
  if (normalized === 'female' || normalized === 'f' || normalized === 'perempuan' || normalized === 'wanita') return 'Female'
  if (normalized === 'non binary' || normalized === 'nonbinary' || normalized === 'non biner') return 'Non-Binary'
  return undefined
}

function canonicalRace(value: string): CharacterRace | undefined {
  return canonicalFromList(value, CHARACTER_RACES) as CharacterRace | undefined
}

function canonicalElement(value: string): CharacterElement | undefined {
  return canonicalFromList(value, CHARACTER_ELEMENTS) as CharacterElement | undefined
}

function canonicalClass(value: string): CharacterClass | undefined {
  return canonicalFromList(value, CHARACTER_CLASSES) as CharacterClass | undefined
}

function canonicalWill(value: string): CharacterWillOfPath | undefined {
  return canonicalFromList(value, CHARACTER_WILL_OF_PATHS) as CharacterWillOfPath | undefined
}

function valueForField(fields: ReadonlyMap<string, string>, field: string): string | undefined {
  const value = fields.get(field)
  if (!value) return undefined
  const normalized = unwrapFormatting(value)
  if (!normalized || normalized === '—' || normalized === '-' || normalized.toLowerCase() === 'none' || normalized.toLowerCase() === 'n/a') return undefined
  return normalized
}

function issue(field: string | undefined, code: CharacterParseIssue['code'], message: string, value?: string): CharacterParseIssue {
  return { ...(field ? { field } : {}), code, ...(value ? { value } : {}), message }
}

export function normalizeCharacterText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/gu, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
}

export function parseCharacterSheet(input: string): CharacterParseResult {
  const normalizedInput = normalizeCharacterText(input)
  if (normalizedInput.length === 0 || normalizedInput.length > 12_000) {
    return { ok: false, issues: [issue(undefined, 'invalid', 'Isi Character Sheet kosong atau terlalu panjang.')] }
  }

  const fields = new Map<string, string>()
  const duplicates = new Set<string>()
  const ignoredFields: string[] = []
  const unsupportedFields: string[] = []
  const lines = normalizedInput.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const parsed = parseFieldLine(line)
    if (!parsed.field) {
      if (looksLikeFieldLine(line)) unsupportedFields.push(line.slice(0, 60))
      continue
    }
    let value = parsed.value
    if (parsed.standalone) {
      const continuation: string[] = []
      while (lines[index + 1] && !parseFieldLine(lines[index + 1] ?? '').field && !looksLikeFieldLine(lines[index + 1] ?? '') && (parsed.field === 'motto' || continuation.length === 0)) {
        continuation.push(unwrapFormatting(lines[index + 1] ?? ''))
        index += 1
      }
      if (continuation.length > 0) value = continuation.join(' ').trim()
    }
    if (value === undefined) continue
    if (CONTROLLED_FIELDS.has(parsed.field)) {
      ignoredFields.push(parsed.field)
      continue
    }
    if (fields.has(parsed.field)) {
      duplicates.add(parsed.field)
      continue
    }
    fields.set(parsed.field, value)
  }

  const issues: CharacterParseIssue[] = unsupportedFields.map((field) => issue(undefined, 'unsupported', `Label field tidak dikenali: ${field}.`))
  for (const field of duplicates) issues.push(issue(field, 'duplicate', `Field ${field} muncul lebih dari satu kali.`))
  for (const field of REQUIRED_FIELDS) {
    if (!valueForField(fields, field)) issues.push(issue(field, 'missing', `Field ${field} wajib diisi.`))
  }
  if (issues.length > 0) return { ok: false, issues }

  const name = valueForField(fields, 'name')
  const genderValue = valueForField(fields, 'gender')
  const ageValue = valueForField(fields, 'age')
  const birthdayValue = valueForField(fields, 'birthday')
  const raceValue = valueForField(fields, 'race')
  const classValue = valueForField(fields, 'class')
  const elementValue = valueForField(fields, 'element')
  const willValue = valueForField(fields, 'will')
  const gender = genderValue ? canonicalGender(genderValue) : undefined
  const age = ageValue && /^\d{1,3}$/u.test(ageValue) ? Number(ageValue) : undefined
  const birthday = birthdayValue ? parseBirthday(birthdayValue) : undefined
  const race = raceValue ? canonicalRace(raceValue) : undefined
  const className = classValue ? canonicalClass(classValue) : undefined
  const element = elementValue ? canonicalElement(elementValue) : undefined
  const will = willValue ? canonicalWill(willValue) : undefined

  if (!name || name.length > 60) issues.push(issue('name', 'invalid', 'Name harus berisi 1 sampai 60 karakter.', name))
  if (!gender) issues.push(issue('gender', 'invalid', 'Gender harus Male, Female, atau Non-Binary.', genderValue))
  if (age === undefined || age < 5 || age > 500) issues.push(issue('age', 'invalid', 'Age harus berupa angka 5 sampai 500.', ageValue))
  if (!birthday || birthday.day < 1 || birthday.day > 31 || birthday.year !== 800 - (age ?? 0)) {
    issues.push(issue('birthday', 'invalid', 'Birthday harus berbentuk [Tanggal] [Bulan KAR] [Tahun KAR] dan tahun harus 800 dikurangi Age.', birthdayValue))
  }
  if (!race) issues.push(issue('race', 'invalid', `Race harus salah satu dari: ${CHARACTER_RACES.join(', ')}.`, raceValue))
  if (!className) issues.push(issue('class', 'invalid', `Class harus salah satu dari: ${CHARACTER_CLASSES.join(', ')}.`, classValue))
  if (!element) issues.push(issue('element', 'invalid', `Element harus salah satu dari: ${CHARACTER_ELEMENTS.join(', ')}.`, elementValue))
  if (element === 'Nature' && race && !['Dryad', 'Elf'].includes(race)) issues.push(issue('element', 'invalid', 'Element Nature hanya untuk race Dryad atau Elf.', element))
  if (element === 'Blood' && race !== 'Vampire') issues.push(issue('element', 'invalid', 'Element Blood hanya untuk race Vampire.', element))
  if (element === 'Gel' && race !== 'Slime') issues.push(issue('element', 'invalid', 'Element Gel hanya untuk race Slime.', element))
  if (!will) issues.push(issue('will', 'invalid', 'Will Of Path harus Light, Dark, atau Neutral.', willValue))
  if (issues.length > 0 || !gender || age === undefined || !birthday || !race || !className || !element || !will || !name) {
    return { ok: false, issues }
  }

  const optional = (field: string, maxLength: number): string | undefined => {
    const value = valueForField(fields, field)
    return value && value.length <= maxLength ? value : undefined
  }
  for (const [field, maxLength] of [['spirit', 120], ['crew', 120], ['profession', 120], ['motto', 500], ['visual', 160], ['origin', 160]] as const) {
    const value = valueForField(fields, field)
    if (value && value.length > maxLength) issues.push(issue(field, 'invalid', `Field ${field} terlalu panjang.`, value))
  }
  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    ignoredFields: [...new Set(ignoredFields)],
    payload: {
      name,
      gender,
      age,
      birthdayDay: birthday.day,
      birthdayMonth: birthday.month,
      birthdayYear: birthday.year,
      race,
      className,
      element,
      willOfPath: will,
      ...(optional('spirit', 120) ? { spirit: optional('spirit', 120) } : {}),
      ...(optional('crew', 120) ? { crew: optional('crew', 120) } : {}),
      ...(optional('profession', 120) ? { profession: optional('profession', 120) } : {}),
      ...(optional('motto', 500) ? { motto: optional('motto', 500) } : {}),
      ...(optional('visual', 160) ? { visual: optional('visual', 160) } : {}),
      ...(optional('origin', 160) ? { origin: optional('origin', 160) } : {}),
    },
  }
}

export function extractCommandPayload(messageText: string | undefined, prefix: string, commandName: string): string | undefined {
  const text = messageText?.trim()
  if (!text || !text.startsWith(prefix)) return undefined
  const body = text.slice(prefix.length).trimStart()
  const match = body.match(/^([^\s\n]+)/u)
  if (!match || match[1]?.toLowerCase() !== commandName.toLowerCase()) return undefined
  return body.slice(match[0].length).trimStart()
}

function hasNarrativeContent(value: string): boolean {
  const unwrapped = unwrapFormatting(value)
  return /[\p{L}\p{N}]/u.test(unwrapped)
}

function isNarrativeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^>\s*/u.test(trimmed)) return hasNarrativeContent(trimmed.replace(/^>\s*/u, ''))
  if (/^(?:["“「『]).+(?:["”」』])$/u.test(trimmed)) return hasNarrativeContent(trimmed.slice(1, -1))
  if (/^『[^』]{1,60}』\s*[:：-]\s*\S/u.test(trimmed)) return hasNarrativeContent(trimmed.replace(/^『[^』]{1,60}』\s*[:：-]\s*/u, ''))
  return false
}

export function isCanonicalNarrativeText(text: string): boolean {
  const normalized = normalizeCharacterText(text).trim()
  if (!normalized || normalized.length > 4_000) return false
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(isNarrativeLine)
}
