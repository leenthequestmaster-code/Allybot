import type { CharacterRace } from './character-sheet-parser.js'

export interface CharacterAttributes {
  readonly hp: number
  readonly maxHp: number
  readonly cc: number // Core Capacity (Adeon)
  readonly maxCc: number
  readonly gc: number // Gate Capacity (Arcanist)
  readonly maxGc: number
  // Interop aliases:
  readonly se: number
  readonly maxSe: number
  readonly str: number
  readonly ap: number // Astresence Power
  readonly mp: number // Alias to AP
  readonly def: number
  readonly res: number
  readonly agi: number
  readonly spd: number // Alias to AGI
  readonly int: number
  readonly lck: number // Interop
  readonly statTokens: number
  readonly bonusTokens: number
  readonly allocatedTokens: Readonly<Record<string, number>>
  readonly trait: string
  readonly classBonusText?: string
}

export interface ClassBonus {
  readonly str?: number
  readonly ap?: number
  readonly def?: number
  readonly res?: number
  readonly agi?: number
  readonly int?: number
  readonly archetype: 'Attacker' | 'Defender' | 'Infiltrator' | 'Supporter'
}

export const CLASS_BONUSES: Record<string, ClassBonus> = {
  // Attacker
  Warrior: { str: 30, def: 20, archetype: 'Attacker' },
  Brawler: { str: 30, agi: 20, archetype: 'Attacker' },
  Marksman: { agi: 30, int: 20, archetype: 'Attacker' },
  Berserker: { str: 30, res: 20, archetype: 'Attacker' },
  // Defender
  Guardian: { def: 30, res: 20, archetype: 'Defender' },
  Juggernaut: { def: 30, str: 20, archetype: 'Defender' },
  // Infiltrator
  Assassin: { agi: 30, str: 20, archetype: 'Infiltrator' },
  Trapper: { int: 30, agi: 20, archetype: 'Infiltrator' },
  Puppeteer: { agi: 30, int: 20, archetype: 'Infiltrator' },
  Poisoner: { int: 30, agi: 20, archetype: 'Infiltrator' },
  // Supporter
  Healer: { ap: 30, res: 20, archetype: 'Supporter' },
  Enchanter: { ap: 30, int: 20, archetype: 'Supporter' },
  Debuffer: { ap: 30, int: 20, archetype: 'Supporter' },
  Summoner: { ap: 30, int: 20, archetype: 'Supporter' },
  Engineer: { int: 30, str: 20, archetype: 'Supporter' },
  Channeler: { ap: 30, int: 20, archetype: 'Supporter' },
}

export const RACE_TRAITS: Record<string, string> = {
  // Astryans Lineage
  Human: 'Versatility & Adaptability',
  Elf: 'Keen Senses & Astral Attunement',
  Dwarf: 'Stonecraft & Dense Bone',
  Goblin: 'Mechanical Ingenuity & Cunning',
  Serpentine: 'Cold Blood & Antidote Mastery',
  Siren: 'Aquatic Resonance & Sonar',
  // Primordial Lineage
  Giant: 'Colossal Mass & Fortitude',
  Orc: 'Battle Fervor & Dense Muscle',
  Beastfolk: 'Primal Predator & Tracking',
  Dryad: 'Living Bark & Botanical Symbiosis',
  Fairy: 'Ethereal Flutter & High Affinity',
  // Celestials Lineage
  Dragon: 'Draconic Scales & Breath Pulse',
  Valkyr: 'Aerial Dive & Ethereal Wings',
  // Hibrida & Asimilasi
  Beastkin: 'Urban Acuity & Nimble Senses',
  'Half-Elf': 'Grace & Keen Curiosity',
  Goliath: 'Massive Framework & Heavy Lift',
  'Half-Orc': 'Unyielding Tenacity & Grit',
  Chimera: 'Hybrid Resilience & Multi-Organ',
}

const BASE_VITAL = {
  hp: 10_000,
  cc: 1_000,
  gc: 100,
  str: 100,
  ap: 100,
  def: 100,
  res: 100,
  agi: 100,
  int: 100,
}

export function parseAllocatedStats(raw: unknown): Record<string, number> {
  if (!raw) return {}
  let current: unknown = raw
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current)
    } catch {}
  }
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current)
    } catch {}
  }
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    const result: Record<string, number> = {}
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      const num = Number(v)
      if (Number.isFinite(num) && num > 0) {
        result[k.toLowerCase()] = Math.floor(num)
      }
    }
    return result
  }
  return {}
}

export function tokensPerLevelByPotency(grade: string): number {
  const g = (grade || 'D').toUpperCase().replace(/[^A-Z0-9]/gu, '')
  if (g.startsWith('F')) return 1
  if (g.startsWith('E')) return 2
  if (g.startsWith('D')) return 4
  if (g.startsWith('C')) return 5
  if (g.startsWith('B')) return 7
  if (g.startsWith('A')) return 8
  if (g.startsWith('S')) return 10
  if (g === '0') return 5
  return 4
}

export function calculateCharacterStats(
  race: string,
  level: number,
  allocated: unknown = {},
  bonusTokens = 0,
  className = 'Warrior',
  potencyGrade = 'D',
  cultivationPath?: string,
): CharacterAttributes {
  const trait = RACE_TRAITS[race] ?? 'Adaptability & Survival'
  const classBonus = CLASS_BONUSES[className] ?? { str: 30, def: 20, archetype: 'Attacker' }
  const safeBonus = Math.max(0, Number(bonusTokens) || 0)
  
  // Equal baseline at Level 1: 25 tokens. Each subsequent level grants tokens by potency grade.
  const earnedTokens = 25 + (Math.max(1, level) - 1) * tokensPerLevelByPotency(potencyGrade) + safeBonus
  const cleanAlloc = parseAllocatedStats(allocated)

  const allocHp = Math.max(0, cleanAlloc.hp ?? 0)
  const allocCc = Math.max(0, cleanAlloc.cc ?? cleanAlloc.se ?? 0)
  const allocGc = Math.max(0, cleanAlloc.gc ?? 0)
  const allocStr = Math.max(0, cleanAlloc.str ?? 0)
  const allocAp = Math.max(0, cleanAlloc.ap ?? cleanAlloc.mp ?? 0)
  const allocDef = Math.max(0, cleanAlloc.def ?? 0)
  const allocRes = Math.max(0, cleanAlloc.res ?? 0)
  const allocAgi = Math.max(0, cleanAlloc.agi ?? cleanAlloc.spd ?? 0)
  const allocInt = Math.max(0, cleanAlloc.int ?? 0)

  const usedTokens = allocHp + allocCc + allocGc + allocStr + allocAp + allocDef + allocRes + allocAgi + allocInt
  const remainingTokens = Math.max(0, earnedTokens - usedTokens)

  const maxHp = BASE_VITAL.hp + allocHp * 1_000
  const isArcanist = cultivationPath?.toLowerCase().includes('arcanist') || cultivationPath?.toLowerCase().includes('astrevia')
  const maxCc = isArcanist ? 0 : (BASE_VITAL.cc + allocCc * 1_000)
  const maxGc = isArcanist ? (BASE_VITAL.gc + allocGc * 100) : 0
  const energyMax = isArcanist ? maxGc : maxCc

  const str = BASE_VITAL.str + (classBonus.str ?? 0) + allocStr
  const ap = BASE_VITAL.ap + (classBonus.ap ?? 0) + allocAp
  const def = BASE_VITAL.def + (classBonus.def ?? 0) + allocDef
  const res = BASE_VITAL.res + (classBonus.res ?? 0) + allocRes
  const agi = BASE_VITAL.agi + (classBonus.agi ?? 0) + allocAgi
  const int = BASE_VITAL.int + (classBonus.int ?? 0) + allocInt

  return {
    hp: maxHp,
    maxHp,
    cc: maxCc,
    maxCc,
    gc: maxGc,
    maxGc,
    se: energyMax,
    maxSe: energyMax,
    str,
    ap,
    mp: ap,
    def,
    res,
    agi,
    spd: agi,
    int,
    lck: 0,
    statTokens: remainingTokens,
    bonusTokens: safeBonus,
    allocatedTokens: {
      hp: allocHp,
      cc: allocCc,
      gc: allocGc,
      str: allocStr,
      ap: allocAp,
      def: allocDef,
      res: allocRes,
      agi: allocAgi,
      int: allocInt,
    },
    trait,
    classBonusText: `${classBonus.archetype} (${Object.entries(classBonus).filter(([k]) => k !== 'archetype').map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ')})`,
  }
}

export function renderStatsCard(name: string, race: string, className: string, rank: string, level: number, stats: CharacterAttributes): string {
  const hpBar = makeProgressBar(stats.hp, stats.maxHp, 10)
  const isAdeon = stats.cc > 0 || stats.gc === 0
  const energyLabel = isAdeon ? 'CC (Core)' : 'GC (Gate)'
  const energyVal = isAdeon ? stats.cc : stats.gc
  const energyMax = isAdeon ? stats.maxCc : stats.maxGc
  const energyBar = makeProgressBar(energyVal, energyMax, 10)

  return [
    '╔═══════════════════════════════╗',
    '    ALLYSSEA · STATUS RESMI WARGA',
    '╚═══════════════════════════════╝',
    `Nama       : *${name}*`,
    `Ras/Kelas  : ${race} · ${className}`,
    `Peringkat  : Rank ${rank} (Level ${level})`,
    `Karakteristik: ${stats.trait}`,
    '',
    '[VITALITAS BINTANG]',
    `HP : ${stats.hp.toLocaleString()} / ${stats.maxHp.toLocaleString()}  ${hpBar}`,
    `${energyLabel} : ${energyVal.toLocaleString()} / ${energyMax.toLocaleString()}  ${energyBar}`,
    '',
    '[MATRIKS ATRIBUT (6 PILAR)]',
    `• STR (Fisik)   : ${stats.str.toString().padEnd(4)} • DEF (Ketahanan): ${stats.def}`,
    `• AP  (Astresence): ${stats.ap.toString().padEnd(4)} • RES (Resistensi): ${stats.res}`,
    `• AGI (Kelincahan): ${stats.agi.toString().padEnd(4)} • INT (Akurasi)  : ${stats.int}`,
    '',
    `Sisa Stat Token: *${stats.statTokens} Token*`,
    stats.statTokens > 0 
      ? '_Gunakan command *!alokasi <stat> <jumlah>* untuk memperkuat karakter._\n_(Contoh: !alokasi str 2 atau !alokasi hp 1)_'
      : '_Semua Stat Token telah dialokasikan._',
    '─────────────────────────────────',
  ].join('\n')
}

function makeProgressBar(current: number, max: number, length: number): string {
  if (max <= 0) return '░'.repeat(length)
  const ratio = Math.min(1, Math.max(0, current / max))
  const filled = Math.round(ratio * length)
  const empty = length - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}
