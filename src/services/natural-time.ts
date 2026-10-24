/**
 * @module natural-time
 * Indonesian Natural Language Date/Time Parser powered by chrono-node and WIB Timezone Anchor.
 *
 * Translates Indonesian colloquial phrases ("besok jam 7 pagi", "30 menit lagi", "lusa jam 2 siang")
 * into precise JavaScript Date objects anchored to Asia/Jakarta (WIB, UTC+7).
 */

import * as chrono from 'chrono-node'

export interface ParsedNaturalTime {
  readonly date: Date | null
  readonly remainingText: string
  readonly isFuture: boolean
}

/**
 * Preprocesses Indonesian time expressions into normalized forms that chrono-node understands.
 */
export function translateIndonesianTimeText(raw: string): string {
  let s = raw.toLowerCase().trim()

  // 1. Direct relative patterns: 'X menit lagi', 'X jam lagi', 'X hari lagi'
  s = s.replace(/(\d+)\s*(?:detik|dtk)\s*lagi/gi, 'in $1 seconds')
  s = s.replace(/(\d+)\s*(?:menit|mnt)\s*lagi/gi, 'in $1 minutes')
  s = s.replace(/setengah\s*jam\s*lagi/gi, 'in 30 minutes')
  s = s.replace(/(\d+)\s*(?:jam|jm)\s*lagi/gi, 'in $1 hours')
  s = s.replace(/(\d+)\s*(?:hari|hr)\s*lagi/gi, 'in $1 days')
  s = s.replace(/(\d+)\s*(?:minggu|mgg)\s*lagi/gi, 'in $1 weeks')
  s = s.replace(/(\d+)\s*(?:bulan|bln)\s*lagi/gi, 'in $1 months')
  s = s.replace(/sebentar\s*lagi/gi, 'in 10 minutes')

  // 2. Relative days
  s = s.replace(/\bhari ini\b/gi, 'today')
  s = s.replace(/\bnanti malam\b/gi, 'tonight')
  s = s.replace(/\bnanti sore\b/gi, 'this afternoon')
  s = s.replace(/\bnanti siang\b/gi, 'this afternoon')
  s = s.replace(/\bbesok\b/gi, 'tomorrow')
  s = s.replace(/\blusa\b/gi, 'in 2 days')
  s = s.replace(/\bminggu depan\b/gi, 'next week')

  // 3. Time of day keywords attached to jam/pukul
  s = s.replace(/(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?\s*pagi/gi, (_m, h, min) => {
    return `${h}:${min || '00'} am`
  })
  s = s.replace(
    /(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?\s*(?:siang|sore|malam)/gi,
    (_m, h, min) => {
      let hour = parseInt(h, 10)
      if (hour < 12) hour += 12
      return `${hour}:${min || '00'}`
    },
  )
  s = s.replace(/(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?\s*subuh/gi, (_m, h, min) => {
    return `${h}:${min || '00'} am`
  })
  s = s.replace(/(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?/gi, (_m, h, min) => {
    return `at ${h}:${min || '00'}`
  })

  // 4. Days of week
  s = s.replace(/\bsenin\b/gi, 'monday')
  s = s.replace(/\bselasa\b/gi, 'tuesday')
  s = s.replace(/\brabu\b/gi, 'wednesday')
  s = s.replace(/\bkamis\b/gi, 'thursday')
  s = s.replace(/\bjum'?at\b/gi, 'friday')
  s = s.replace(/\bsabtu\b/gi, 'saturday')
  s = s.replace(/\bminggu\b/gi, 'sunday')

  // 5. Months
  s = s.replace(/\bjanuari\b/gi, 'january')
  s = s.replace(/\bfebruari\b/gi, 'february')
  s = s.replace(/\bmaret\b/gi, 'march')
  s = s.replace(/\bapril\b/gi, 'april')
  s = s.replace(/\bmei\b/gi, 'may')
  s = s.replace(/\bjuni\b/gi, 'june')
  s = s.replace(/\bjuli\b/gi, 'july')
  s = s.replace(/\bagustus\b/gi, 'august')
  s = s.replace(/\bseptember\b/gi, 'september')
  s = s.replace(/\boktober\b/gi, 'october')
  s = s.replace(/\bnovember\b/gi, 'november')
  s = s.replace(/\bdesember\b/gi, 'december')

  return s
}

/**
 * Parses an Indonesian natural language sentence containing both time and note.
 * e.g. "besok jam 7 pagi bangunin sahur ya"
 * Returns: { date: Date, remainingText: "bangunin sahur ya", isFuture: true }
 */
export function parseNaturalTimeIndonesian(
  input: string,
  referenceDate = new Date(),
): ParsedNaturalTime {
  const translated = translateIndonesianTimeText(input)
  // Timezone anchor: 420 minutes (+07:00 WIB Asia/Jakarta)
  const results = chrono.parse(translated, { instant: referenceDate, timezone: 420 })
  if (results.length === 0 || !results[0]) {
    return { date: null, remainingText: input.trim(), isFuture: false }
  }

  const firstResult = results[0]
  const date = firstResult.start.date()

  let targetDate = date
  // If parsed time is earlier than reference today (e.g. user says "jam 7 pagi" at 9 AM),
  // bump to tomorrow 7 AM if no specific day was specified
  if (targetDate.getTime() < referenceDate.getTime() - 60_000) {
    if (!firstResult.start.isCertain('day') && !firstResult.start.isCertain('month')) {
      targetDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000)
    }
  }

  // Extract the remaining message text
  const matchedText = firstResult.text
  let remainingText = translated.replace(matchedText, '').trim()

  // Clean Indonesian conjunctions
  remainingText = remainingText.replace(/^(?:untuk|buat|ingatkan|ingetin|pesan)\s+/i, '').trim()

  const isFuture = targetDate.getTime() > referenceDate.getTime()
  return { date: targetDate, remainingText, isFuture }
}

/**
 * Formats a Date object nicely into Indonesian WIB locale string.
 */
export function formatWibDateTime(date: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date) + ' WIB'
}
