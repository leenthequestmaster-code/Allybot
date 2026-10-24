/**
 * @module sholat-offline
 * 100% Offline Astronomical Islamic Prayer Times Engine powered by SunCalc and Kemenag RI Hisab Standards.
 *
 * Mathematical Standards (Kemenag RI / MABIMS):
 * - Subuh: Solar depression angle -20 deg + 3 minutes Ihtiyat buffer.
 * - Imsak: Subuh - 10 minutes.
 * - Dzuhur: Solar Noon (zawal) + 4 minutes Ihtiyat buffer.
 * - Ashar: Shafi'i shadow ratio (shadow = 1x object height + noon shadow) + 2.5 minutes Ihtiyat buffer.
 * - Maghrib: Sunset (ghurub) + 4 minutes Ihtiyat buffer.
 * - Isya: Solar depression angle -18 deg + 3 minutes Ihtiyat buffer.
 */

import * as SunCalcModule from 'suncalc'
const SunCalc: typeof import('suncalc') = (SunCalcModule as any).default || SunCalcModule

export interface CityCoordinate {
  readonly name: string
  readonly lat: number
  readonly lng: number
  readonly tz: number // 7: WIB, 8: WITA, 9: WIT
  readonly tzName: 'WIB' | 'WITA' | 'WIT'
}

export interface JadwalSholat {
  readonly imsak: string
  readonly subuh: string
  readonly terbit?: string
  readonly dzuhur: string
  readonly ashar: string
  readonly maghrib: string
  readonly isya: string
  readonly kota: string
  readonly tanggal: string
  readonly tzName: string
}

// Register Kemenag custom astronomical solar depression angles
try {
  SunCalc.addTime(-20, 'fajrKemenag', 'isya20')
  SunCalc.addTime(-18, 'fajr18', 'isyaKemenag')
} catch {}

// ─── Curated Indonesian City Coordinates ──────────────────────────────────────

export const INDONESIAN_CITIES: Record<string, CityCoordinate> = {
  // DKI Jakarta & Bodetabek
  jakarta: { name: 'Jakarta', lat: -6.2088, lng: 106.8456, tz: 7, tzName: 'WIB' },
  'jakarta pusat': { name: 'Jakarta Pusat', lat: -6.1865, lng: 106.8341, tz: 7, tzName: 'WIB' },
  'jakarta barat': { name: 'Jakarta Barat', lat: -6.1683, lng: 106.7588, tz: 7, tzName: 'WIB' },
  'jakarta selatan': { name: 'Jakarta Selatan', lat: -6.2615, lng: 106.8106, tz: 7, tzName: 'WIB' },
  'jakarta timur': { name: 'Jakarta Timur', lat: -6.2250, lng: 106.9004, tz: 7, tzName: 'WIB' },
  'jakarta utara': { name: 'Jakarta Utara', lat: -6.1384, lng: 106.8640, tz: 7, tzName: 'WIB' },
  bogor: { name: 'Bogor', lat: -6.5971, lng: 106.8060, tz: 7, tzName: 'WIB' },
  depok: { name: 'Depok', lat: -6.4025, lng: 106.7942, tz: 7, tzName: 'WIB' },
  tangerang: { name: 'Tangerang', lat: -6.1783, lng: 106.6319, tz: 7, tzName: 'WIB' },
  'tangerang selatan': { name: 'Tangerang Selatan', lat: -6.2888, lng: 106.7179, tz: 7, tzName: 'WIB' },
  bekasi: { name: 'Bekasi', lat: -6.2383, lng: 106.9756, tz: 7, tzName: 'WIB' },

  // Jawa Barat & Banten
  serang: { name: 'Serang', lat: -6.1104, lng: 106.1640, tz: 7, tzName: 'WIB' },
  cilegon: { name: 'Cilegon', lat: -6.0174, lng: 106.0538, tz: 7, tzName: 'WIB' },
  bandung: { name: 'Bandung', lat: -6.9175, lng: 107.6191, tz: 7, tzName: 'WIB' },
  cimahi: { name: 'Cimahi', lat: -6.8723, lng: 107.5422, tz: 7, tzName: 'WIB' },
  cirebon: { name: 'Cirebon', lat: -6.7320, lng: 108.5523, tz: 7, tzName: 'WIB' },
  sukabumi: { name: 'Sukabumi', lat: -6.9277, lng: 106.9299, tz: 7, tzName: 'WIB' },
  tasikmalaya: { name: 'Tasikmalaya', lat: -7.3274, lng: 108.2207, tz: 7, tzName: 'WIB' },
  garut: { name: 'Garut', lat: -7.2274, lng: 107.9087, tz: 7, tzName: 'WIB' },
  karawang: { name: 'Karawang', lat: -6.3042, lng: 107.3075, tz: 7, tzName: 'WIB' },

  // Jawa Tengah & DI Yogyakarta
  semarang: { name: 'Semarang', lat: -6.9667, lng: 110.4167, tz: 7, tzName: 'WIB' },
  surakarta: { name: 'Surakarta', lat: -7.5755, lng: 110.8243, tz: 7, tzName: 'WIB' },
  magelang: { name: 'Magelang', lat: -7.4797, lng: 110.2177, tz: 7, tzName: 'WIB' },
  tegal: { name: 'Tegal', lat: -6.8694, lng: 109.1402, tz: 7, tzName: 'WIB' },
  pekalongan: { name: 'Pekalongan', lat: -6.8886, lng: 109.6753, tz: 7, tzName: 'WIB' },
  purwokerto: { name: 'Purwokerto', lat: -7.4244, lng: 109.2302, tz: 7, tzName: 'WIB' },
  cilacap: { name: 'Cilacap', lat: -7.7028, lng: 109.0150, tz: 7, tzName: 'WIB' },
  kudus: { name: 'Kudus', lat: -6.8048, lng: 110.8405, tz: 7, tzName: 'WIB' },
  yogyakarta: { name: 'Yogyakarta', lat: -7.7956, lng: 110.3695, tz: 7, tzName: 'WIB' },
  sleman: { name: 'Sleman', lat: -7.6896, lng: 110.3396, tz: 7, tzName: 'WIB' },
  bantul: { name: 'Bantul', lat: -7.8927, lng: 110.3276, tz: 7, tzName: 'WIB' },

  // Jawa Timur
  surabaya: { name: 'Surabaya', lat: -7.2575, lng: 112.7521, tz: 7, tzName: 'WIB' },
  malang: { name: 'Malang', lat: -7.9666, lng: 112.6326, tz: 7, tzName: 'WIB' },
  sidoarjo: { name: 'Sidoarjo', lat: -7.4478, lng: 112.7183, tz: 7, tzName: 'WIB' },
  gresik: { name: 'Gresik', lat: -7.1566, lng: 112.6555, tz: 7, tzName: 'WIB' },
  kediri: { name: 'Kediri', lat: -7.8480, lng: 112.0178, tz: 7, tzName: 'WIB' },
  madiun: { name: 'Madiun', lat: -7.6298, lng: 111.5239, tz: 7, tzName: 'WIB' },
  jember: { name: 'Jember', lat: -8.1724, lng: 113.7007, tz: 7, tzName: 'WIB' },
  banyuwangi: { name: 'Banyuwangi', lat: -8.2192, lng: 114.3692, tz: 7, tzName: 'WIB' },

  // Sumatera
  'banda aceh': { name: 'Banda Aceh', lat: 5.5483, lng: 95.3238, tz: 7, tzName: 'WIB' },
  medan: { name: 'Medan', lat: 3.5952, lng: 98.6722, tz: 7, tzName: 'WIB' },
  padang: { name: 'Padang', lat: -0.9471, lng: 100.4172, tz: 7, tzName: 'WIB' },
  pekanbaru: { name: 'Pekanbaru', lat: 0.5071, lng: 101.4478, tz: 7, tzName: 'WIB' },
  batam: { name: 'Batam', lat: 1.1301, lng: 104.0529, tz: 7, tzName: 'WIB' },
  'tanjung pinang': { name: 'Tanjung Pinang', lat: 0.9167, lng: 104.4500, tz: 7, tzName: 'WIB' },
  jambi: { name: 'Jambi', lat: -1.6101, lng: 103.6131, tz: 7, tzName: 'WIB' },
  palembang: { name: 'Palembang', lat: -2.9909, lng: 104.7565, tz: 7, tzName: 'WIB' },
  bengkulu: { name: 'Bengkulu', lat: -3.8004, lng: 102.2655, tz: 7, tzName: 'WIB' },
  'bandar lampung': { name: 'Bandar Lampung', lat: -5.4297, lng: 105.2625, tz: 7, tzName: 'WIB' },
  'pangkal pinang': { name: 'Pangkal Pinang', lat: -2.1333, lng: 106.1167, tz: 7, tzName: 'WIB' },

  // Bali, NTB, NTT (WITA)
  denpasar: { name: 'Denpasar', lat: -8.6705, lng: 115.2126, tz: 8, tzName: 'WITA' },
  mataram: { name: 'Mataram', lat: -8.5833, lng: 116.1167, tz: 8, tzName: 'WITA' },
  bima: { name: 'Bima', lat: -8.4608, lng: 118.7267, tz: 8, tzName: 'WITA' },
  kupang: { name: 'Kupang', lat: -10.1772, lng: 123.6070, tz: 8, tzName: 'WITA' },

  // Kalimantan
  pontianak: { name: 'Pontianak', lat: -0.0263, lng: 109.3425, tz: 7, tzName: 'WIB' },
  singkawang: { name: 'Singkawang', lat: 0.9067, lng: 108.9869, tz: 7, tzName: 'WIB' },
  palangkaraya: { name: 'Palangkaraya', lat: -2.2161, lng: 113.9139, tz: 7, tzName: 'WIB' },
  banjarmasin: { name: 'Banjarmasin', lat: -3.3167, lng: 114.5900, tz: 8, tzName: 'WITA' },
  banjarbaru: { name: 'Banjarbaru', lat: -3.4402, lng: 114.8306, tz: 8, tzName: 'WITA' },
  samarinda: { name: 'Samarinda', lat: -0.5022, lng: 117.1536, tz: 8, tzName: 'WITA' },
  balikpapan: { name: 'Balikpapan', lat: -1.2379, lng: 116.8529, tz: 8, tzName: 'WITA' },
  tarakan: { name: 'Tarakan', lat: 3.3272, lng: 117.5786, tz: 8, tzName: 'WITA' },

  // Sulawesi (WITA)
  makassar: { name: 'Makassar', lat: -5.1477, lng: 119.4327, tz: 8, tzName: 'WITA' },
  manado: { name: 'Manado', lat: 1.4748, lng: 124.8421, tz: 8, tzName: 'WITA' },
  palu: { name: 'Palu', lat: -0.9003, lng: 119.8779, tz: 8, tzName: 'WITA' },
  kendari: { name: 'Kendari', lat: -3.9985, lng: 122.5126, tz: 8, tzName: 'WITA' },
  gorontalo: { name: 'Gorontalo', lat: 0.5435, lng: 123.0568, tz: 8, tzName: 'WITA' },
  mamuju: { name: 'Mamuju', lat: -2.6770, lng: 118.8890, tz: 8, tzName: 'WITA' },

  // Maluku & Papua (WIT)
  ambon: { name: 'Ambon', lat: -3.6954, lng: 128.1814, tz: 9, tzName: 'WIT' },
  ternate: { name: 'Ternate', lat: 0.7904, lng: 127.3828, tz: 9, tzName: 'WIT' },
  jayapura: { name: 'Jayapura', lat: -2.5916, lng: 140.6690, tz: 9, tzName: 'WIT' },
  sorong: { name: 'Sorong', lat: -0.8762, lng: 131.2558, tz: 9, tzName: 'WIT' },
  merauke: { name: 'Merauke', lat: -8.4991, lng: 140.4049, tz: 9, tzName: 'WIT' },
}

// Common aliases mapping
export const CITY_ALIASES: Record<string, string> = {
  dki: 'jakarta',
  jkt: 'jakarta',
  jaksel: 'jakarta selatan',
  jakpus: 'jakarta pusat',
  jakbar: 'jakarta barat',
  jaktim: 'jakarta timur',
  jakut: 'jakarta utara',
  tangsel: 'tangerang selatan',
  jogja: 'yogyakarta',
  yogya: 'yogyakarta',
  solo: 'surakarta',
  bali: 'denpasar',
  lombok: 'mataram',
  bdg: 'bandung',
  sby: 'surabaya',
}

/**
 * Resolves city query into known coordinate and timezone.
 */
export function resolveCityCoordinate(query: string): CityCoordinate | null {
  const clean = query
    .toLowerCase()
    .replace(/^(?:kota|kabupaten|kab\.?)\s+/i, '')
    .trim()

  if (CITY_ALIASES[clean]) {
    return INDONESIAN_CITIES[CITY_ALIASES[clean]!] ?? null
  }

  if (INDONESIAN_CITIES[clean]) {
    return INDONESIAN_CITIES[clean]!
  }

  // Prefix match
  for (const [key, val] of Object.entries(INDONESIAN_CITIES)) {
    if (key.startsWith(clean) || clean.startsWith(key)) {
      return val
    }
  }

  return null
}

/**
 * Calculates exact Ashar time using Shafi'i shadow ratio and binary search on SunCalc altitude.
 */
function calculateAshar(date: Date, lat: number, lng: number): Date {
  const times: any = SunCalc.getTimes(date, lat, lng)
  const noon = (times.solarNoon as Date) || date
  const sunset = (times.sunset as Date) || new Date(noon.getTime() + 6 * 3600 * 1000)

  const posNoon = SunCalc.getPosition(noon, lat, lng)
  const z0Rad = (90 - posNoon.altitude) * (Math.PI / 180)
  const shadowAsr = 1 + Math.tan(z0Rad)
  const targetAltDeg = Math.atan(1 / shadowAsr) * (180 / Math.PI)

  let low = noon.getTime()
  let high = sunset.getTime()
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    const pos = SunCalc.getPosition(new Date(mid), lat, lng)
    if (pos.altitude > targetAltDeg) {
      low = mid
    } else {
      high = mid
    }
  }

  // Add 2.5 minutes Kemenag Ihtiyat buffer
  return new Date((low + high) / 2 + 2.5 * 60 * 1000)
}

/**
 * Computes exact Islamic Prayer Times offline for a city and date.
 */
export function calculateJadwalOffline(
  city: CityCoordinate,
  date: Date = new Date(),
): JadwalSholat {
  const { lat, lng, tz, tzName } = city
  const times: any = SunCalc.getTimes(date, lat, lng)

  const fajrRaw = (times.fajrKemenag as Date) || (times.dawn as Date) || date
  const isyaRaw = (times.isyaKemenag as Date) || (times.dusk as Date) || date
  const sunsetRaw = (times.sunset as Date) || date
  const noonRaw = (times.solarNoon as Date) || date

  // Subuh: -20 deg + 3m Ihtiyat
  const subuh = new Date(fajrRaw.getTime() + 3 * 60 * 1000)
  // Imsak: Subuh - 10m
  const imsak = new Date(subuh.getTime() - 10 * 60 * 1000)
  // Terbit: sunrise
  const terbit = (times.sunrise as Date) || date
  // Dzuhur: solarNoon + 4m Ihtiyat (zawal)
  const dzuhur = new Date(noonRaw.getTime() + 4 * 60 * 1000)
  // Ashar: Shafi'i shadow calculation
  const ashar = calculateAshar(date, lat, lng)
  // Maghrib: sunset + 4m Ihtiyat
  const maghrib = new Date(sunsetRaw.getTime() + 4 * 60 * 1000)
  // Isya: -18 deg + 3m Ihtiyat
  const isya = new Date(isyaRaw.getTime() + 3 * 60 * 1000)

  const timeZoneStr = tz === 7 ? 'Asia/Jakarta' : tz === 8 ? 'Asia/Makassar' : 'Asia/Jayapura'

  const format = (d: Date): string =>
    new Intl.DateTimeFormat('id-ID', {
      timeZone: timeZoneStr,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d).replace('.', ':')

  const tanggalStr = new Intl.DateTimeFormat('id-ID', {
    timeZone: timeZoneStr,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)

  return {
    imsak: format(imsak),
    subuh: format(subuh),
    terbit: format(terbit),
    dzuhur: format(dzuhur),
    ashar: format(ashar),
    maghrib: format(maghrib),
    isya: format(isya),
    kota: city.name,
    tanggal: tanggalStr,
    tzName,
  }
}
