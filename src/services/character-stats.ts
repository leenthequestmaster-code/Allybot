import type { CharacterRace } from './character-sheet-parser.js'

export interface CharacterAttributes {
  readonly hp: number
  readonly maxHp: number
  readonly se: number
  readonly maxSe: number
  readonly str: number
  readonly def: number
  readonly mp: number
  readonly res: number
  readonly spd: number
  readonly int: number
  readonly lck: number
  readonly statTokens: number
  readonly allocatedTokens: Readonly<Record<string, number>>
  readonly trait: string
}

export interface RaceBonus {
  readonly hp?: number
  readonly se?: number
  readonly str?: number
  readonly def?: number
  readonly mp?: number
  readonly res?: number
  readonly spd?: number
  readonly int?: number
  readonly lck?: number
  readonly trait: string
}

export const RACE_BONUSES: Record<string, RaceBonus> = {
  Human: { int: 10, lck: 10, trait: 'Versatility' },
  Elf: { mp: 15, spd: 5, trait: 'Nature Attunement' },
  'Dark Elf': { mp: 15, str: 5, trait: 'Night Vision' },
  Dwarf: { str: 10, def: 10, trait: 'Iron Constitution' },
  Giant: { str: 15, hp: 150, trait: 'Colossal Might' },
  Orc: { str: 20, hp: 100, trait: 'Battle Fervor' },
  Fairy: { spd: 20, se: 50, trait: 'Flight' },
  Vampire: { mp: 10, spd: 10, trait: 'Life Steal' },
  Pisces: { spd: 10, res: 10, trait: 'Aquatic Life' },
  Harpy: { spd: 15, int: 5, trait: 'Aerial View' },
  Slime: { def: 20, se: 50, trait: 'Elastic Body' },
  Dragonborn: { str: 10, mp: 10, trait: 'Dragon Scale' },
  Beastfolk: { spd: 10, str: 10, trait: 'Primal Instinct' },
  Kitsune: { mp: 15, lck: 5, trait: 'Illusionist' },
  Dryad: { res: 15, se: 100, trait: 'Root Connection' },
  Demon: { mp: 15, str: 10, trait: 'Demonic Aura' },
  Angel: { res: 15, mp: 10, trait: 'Holy Light' },
}

const BASE_VITAL = {
  hp: 800,
  se: 200,
  str: 10,
  def: 10,
  mp: 10,
  res: 10,
  spd: 10,
  int: 10,
  lck: 10,
}

export function calculateCharacterStats(
  race: string,
  level: number,
  allocated: Record<string, number> = {},
): CharacterAttributes {
  const bonus = RACE_BONUSES[race] ?? { trait: 'Adaptability' }
  const totalTokensEarned = (Math.max(1, level) - 1) * 5 + 5 // Level 1 starts with 5 tokens
  
  const allocHp = Math.max(0, allocated.hp ?? 0)
  const allocSe = Math.max(0, allocated.se ?? 0)
  const allocStr = Math.max(0, allocated.str ?? 0)
  const allocDef = Math.max(0, allocated.def ?? 0)
  const allocMp = Math.max(0, allocated.mp ?? 0)
  const allocRes = Math.max(0, allocated.res ?? 0)
  const allocSpd = Math.max(0, allocated.spd ?? 0)
  const allocInt = Math.max(0, allocated.int ?? 0)
  const allocLck = Math.max(0, allocated.lck ?? 0)

  const usedTokens = allocHp + allocSe + allocStr + allocDef + allocMp + allocRes + allocSpd + allocInt + allocLck
  const remainingTokens = Math.max(0, totalTokensEarned - usedTokens)

  const maxHp = BASE_VITAL.hp + (bonus.hp ?? 0) + allocHp * 150
  const maxSe = BASE_VITAL.se + (bonus.se ?? 0) + allocSe * 100
  const str = BASE_VITAL.str + (bonus.str ?? 0) + allocStr
  const def = BASE_VITAL.def + (bonus.def ?? 0) + allocDef
  const mp = BASE_VITAL.mp + (bonus.mp ?? 0) + allocMp
  const res = BASE_VITAL.res + (bonus.res ?? 0) + allocRes
  const spd = BASE_VITAL.spd + (bonus.spd ?? 0) + allocSpd
  const int = BASE_VITAL.int + (bonus.int ?? 0) + allocInt
  const lck = BASE_VITAL.lck + (bonus.lck ?? 0) + allocLck

  return {
    hp: maxHp,
    maxHp,
    se: maxSe,
    maxSe,
    str,
    def,
    mp,
    res,
    spd,
    int,
    lck,
    statTokens: remainingTokens,
    allocatedTokens: {
      hp: allocHp,
      se: allocSe,
      str: allocStr,
      def: allocDef,
      mp: allocMp,
      res: allocRes,
      spd: allocSpd,
      int: allocInt,
      lck: allocLck,
    },
    trait: bonus.trait,
  }
}

export function renderStatsCard(name: string, race: string, className: string, rank: string, level: number, stats: CharacterAttributes): string {
  const hpBar = makeProgressBar(stats.hp, stats.maxHp, 10)
  const seBar = makeProgressBar(stats.se, stats.maxSe, 10)

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
    `HP : ${stats.hp}/${stats.maxHp}  ${hpBar}`,
    `SE : ${stats.se}/${stats.maxSe}  ${seBar}`,
    '',
    '[MATRIKS ATRIBUT]',
    `• STR (Fisik)   : ${stats.str.toString().padEnd(3)} • DEF (Ketahanan): ${stats.def}`,
    `• MP  (Sihir)   : ${stats.mp.toString().padEnd(3)} • RES (Resistensi): ${stats.res}`,
    `• SPD (Kelincahan): ${stats.spd.toString().padEnd(3)} • INT (Akurasi)  : ${stats.int}`,
    `• LCK (Keberuntungan): ${stats.lck}`,
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
