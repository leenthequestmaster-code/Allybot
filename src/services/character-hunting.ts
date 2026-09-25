import type { CharacterAttributes } from './character-stats.js'

export interface HuntingMonster {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly hp: number
  readonly atk: number
  readonly def: number
  readonly spd: number
  readonly minVela: number
  readonly maxVela: number
  readonly dropItem: string
}

export interface HuntingResult {
  readonly victory: boolean
  readonly monster: HuntingMonster
  readonly rounds: number
  readonly playerDamageDealt: number
  readonly playerDamageTaken: number
  readonly criticalHit: boolean
  readonly velaEarned: number
  readonly log: string[]
}

const REGION_F_MONSTERS: readonly HuntingMonster[] = [
  {
    id: 'gloom_wolf',
    name: 'Gloom Wolf',
    title: 'Serigala Bayangan Lembah',
    hp: 320,
    atk: 28,
    def: 8,
    spd: 12,
    minVela: 35,
    maxVela: 70,
    dropItem: 'Taring Serigala Bayangan',
  },
  {
    id: 'forest_boar',
    name: 'Forest Boar',
    title: 'Babi Hutan Rimba Jura',
    hp: 380,
    atk: 32,
    def: 12,
    spd: 7,
    minVela: 40,
    maxVela: 80,
    dropItem: 'Kulit Pelindung Tebal',
  },
  {
    id: 'crystal_wasp',
    name: 'Crystal Wasp',
    title: 'Tawon Kristal Astral',
    hp: 240,
    atk: 36,
    def: 6,
    spd: 16,
    minVela: 45,
    maxVela: 85,
    dropItem: 'Serbuk Kristal Berpendar',
  },
  {
    id: 'marsh_slime',
    name: 'Marsh Slime',
    title: 'Lendir Rawa Purba',
    hp: 420,
    atk: 24,
    def: 16,
    spd: 5,
    minVela: 30,
    maxVela: 75,
    dropItem: 'Cairan Lendir Pekat',
  },
]

export function executeHunt(
  characterName: string,
  className: string,
  stats: CharacterAttributes,
): HuntingResult {
  // Select a random monster for now (Rank F territory)
  const monster = REGION_F_MONSTERS[Math.floor(Math.random() * REGION_F_MONSTERS.length)]
  const log: string[] = []

  let monsterHp = monster.hp
  let playerDamageTaken = 0
  let playerTotalDealt = 0
  let isCrit = false
  let rounds = 0

  const isMagicUser = ['Sorcerer', 'Necromancer', 'Illusionist', 'Cleric', 'Bard', 'Summoner'].includes(className)
  const baseAttackPower = isMagicUser ? stats.mp * 2.2 : stats.str * 2.2

  // Combat loop (max 3 exchanges)
  while (monsterHp > 0 && rounds < 3) {
    rounds += 1

    // Player Turn
    const critChance = Math.min(0.4, (stats.lck * 0.015))
    const critRoll = Math.random() < critChance
    let playerHit = Math.max(25, Math.round(baseAttackPower - monster.def + (Math.random() * 20 - 10)))
    if (critRoll) {
      playerHit = Math.round(playerHit * 1.5)
      isCrit = true
    }

    monsterHp -= playerHit
    playerTotalDealt += playerHit

    if (monsterHp <= 0) {
      break
    }

    // Monster Turn
    const monsterHit = Math.max(10, Math.round(monster.atk - (stats.def * 0.6) + (Math.random() * 10 - 5)))
    playerDamageTaken += monsterHit
  }

  const victory = monsterHp <= 0
  const velaEarned = victory 
    ? Math.floor(Math.random() * (monster.maxVela - monster.minVela + 1)) + monster.minVela
    : 0

  return {
    victory,
    monster,
    rounds,
    playerDamageDealt: playerTotalDealt,
    playerDamageTaken,
    criticalHit: isCrit,
    velaEarned,
    log,
  }
}

export function renderHuntReport(
  characterName: string,
  result: HuntingResult,
): string {
  if (result.victory) {
    return [
      '⚔️ *LAPORAN EKSPEDISI PERBURUAN*',
      '─────────────────────────────',
      `Lokasi : Hutan Pinggiran Lembah Jura`,
      `Target : *${result.monster.name}* (${result.monster.title})`,
      '',
      `Petualang *${characterName}* berhasil menumbangkan mangsa dalam ${result.rounds} babak pertempuran!`,
      result.criticalHit ? '⚡ _Serangan kritikal presisi berhasil dilancarkan!_' : '',
      `• Total Kerusakan Diberikan: *${result.playerDamageDealt} DMG*`,
      `• Luka Fisik Diterima      : *${result.playerDamageTaken} DMG*`,
      '',
      '[HASIL JARAHAN PERBURUAN]',
      `💰 Imbalan Tunai : *+${result.velaEarned} Vela* (Langsung ke Dompet)`,
      `🎒 Material Langka: *${result.monster.dropItem}*`,
      '─────────────────────────────',
      '_Gunakan *!vela* untuk memeriksa saldo atau *!hunt* lagi setelah jeda._',
    ].filter(Boolean).join('\n')
  }

  return [
    '⚔️ *LAPORAN EKSPEDISI PERBURUAN*',
    '─────────────────────────────',
    `Lokasi : Hutan Pinggiran Lembah Jura`,
    `Target : *${result.monster.name}* (${result.monster.title})`,
    '',
    `Pertarungan berlangsung sengit! *${characterName}* harus mundur taktis untuk memulihkan tenaga.`,
    `• Kerusakan Diberikan: ${result.playerDamageDealt} DMG`,
    `• Luka Fisik Diterima: ${result.playerDamageTaken} DMG`,
    '',
    '_Tenangkan diri dan pulihkan vitalitas sebelum mencoba ekspedisi berikutnya._',
    '─────────────────────────────',
  ].join('\n')
}
