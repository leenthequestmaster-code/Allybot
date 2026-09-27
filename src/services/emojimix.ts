/**
 * Google Emoji Kitchen (Emojimix) Service for Allybot
 * Matches emoji pairs against official Emoji Kitchen data and Google gstatic CDN.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface MixItem {
  readonly leftEmoji: string
  readonly rightEmoji: string
  readonly date: string
}

const GSTATIC_ROOT = 'https://www.gstatic.com/android/keyboard/emojikitchen'
const FALLBACK_DATES = [
  '20240530',
  '20240206',
  '20231113',
  '20230301',
  '20220815',
  '20220203',
  '20211115',
  '20210521',
  '20201001',
]

let _indexPromise: Promise<Map<string, MixItem>> | null = null

export function emojiToHex(emoji: string): string {
  const codes: string[] = []
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && cp !== 0xfe0f) {
      codes.push(cp.toString(16).toLowerCase())
    }
  }
  return codes.join('-')
}

function formatPart(hexStr: string): string {
  return hexStr
    .split('-')
    .map((p) => `u${p}`)
    .join('-')
}

export function buildGstaticUrl(mix: MixItem): string {
  const left = formatPart(mix.leftEmoji)
  const right = formatPart(mix.rightEmoji)
  return `${GSTATIC_ROOT}/${mix.date}/${left}/${left}_${right}.png`
}

async function getIndex(): Promise<Map<string, MixItem>> {
  if (_indexPromise) return _indexPromise

  _indexPromise = (async () => {
    const map = new Map<string, MixItem>()
    try {
      const jsonPath = join(process.cwd(), 'assets', 'emoji_mixes.json')
      const content = await readFile(jsonPath, 'utf-8')
      const raw = JSON.parse(content)
      const dataObj = Array.isArray(raw) ? raw[0] : raw

      if (dataObj && typeof dataObj === 'object') {
        for (const mixes of Object.values(dataObj)) {
          if (Array.isArray(mixes)) {
            for (const item of mixes) {
              if (item?.leftEmoji && item?.rightEmoji && item?.date) {
                const k1 = `${item.leftEmoji}_${item.rightEmoji}`
                const k2 = `${item.rightEmoji}_${item.leftEmoji}`
                if (!map.has(k1)) map.set(k1, item)
                if (!map.has(k2)) map.set(k2, item)
              }
            }
          }
        }
      }
    } catch {
      // If assets/emoji_mixes.json is absent, map stays empty and brute-force handles lookup
    }
    return map
  })()

  return _indexPromise
}

export async function findEmojiMix(e1: string, e2: string): Promise<string | null> {
  const h1 = emojiToHex(e1)
  const h2 = emojiToHex(e2)

  if (!h1 || !h2) return null

  // 1. Check loaded index
  const index = await getIndex()
  const found = index.get(`${h1}_${h2}`) || index.get(`${h2}_${h1}`)
  if (found) {
    const url = buildGstaticUrl(found)
    return url
  }

  // 2. Fallback brute-force against known Google CDN dates
  const p1 = formatPart(h1)
  const p2 = formatPart(h2)

  for (const date of FALLBACK_DATES) {
    const candidates = [
      `${GSTATIC_ROOT}/${date}/${p1}/${p1}_${p2}.png`,
      `${GSTATIC_ROOT}/${date}/${p2}/${p2}_${p1}.png`,
    ]

    for (const url of candidates) {
      try {
        const headRes = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        })
        if (headRes.ok) return url
      } catch {
        continue
      }
    }
  }

  return null
}

export async function fetchEmojiMixBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch {
    return null
  }
}
