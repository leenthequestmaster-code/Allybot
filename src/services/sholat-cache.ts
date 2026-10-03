import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface JadwalSholat {
  imsak: string
  subuh: string
  dzuhur: string
  ashar: string
  maghrib: string
  isya: string
}

export interface CacheEntry {
  jadwal: JadwalSholat
  expiresAt: number
}

// In-memory cache map
const CACHE_MAP = new Map<string, CacheEntry>()
const CACHE_FILE = join(process.cwd(), 'data', 'sholat_cache.json')
const TTL = 24 * 60 * 60 * 1000 // 24 hours

let isLoaded = false

function getCacheKey(kota: string, tanggal: string): string {
  return `${kota.toLowerCase().trim()}_${tanggal}`
}

async function loadCache(): Promise<void> {
  if (isLoaded) return
  if (existsSync(CACHE_FILE)) {
    try {
      const data = await fs.readFile(CACHE_FILE, 'utf-8')
      const parsed = JSON.parse(data)
      const now = Date.now()
      
      for (const [key, entry] of Object.entries(parsed) as [string, CacheEntry][]) {
        if (entry.expiresAt > now) {
          CACHE_MAP.set(key, entry)
        }
      }
    } catch (e) {
      // Best effort load, if corrupted just ignore
    }
  }
  isLoaded = true
}

let writeTimeout: NodeJS.Timeout | null = null

function scheduleWrite(): void {
  if (writeTimeout) return
  writeTimeout = setTimeout(async () => {
    writeTimeout = null
    try {
      const obj = Object.fromEntries(CACHE_MAP.entries())
      await fs.writeFile(CACHE_FILE, JSON.stringify(obj), 'utf-8')
    } catch (e) {
      // best effort write
    }
  }, 500) // debounce 500ms
}

export async function getCached(kota: string, tanggal: string): Promise<JadwalSholat | null> {
  await loadCache()
  const key = getCacheKey(kota, tanggal)
  const entry = CACHE_MAP.get(key)
  
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    CACHE_MAP.delete(key)
    scheduleWrite()
    return null
  }
  
  return entry.jadwal
}

export async function setCached(kota: string, tanggal: string, jadwal: JadwalSholat): Promise<void> {
  await loadCache()
  const key = getCacheKey(kota, tanggal)
  
  CACHE_MAP.set(key, {
    jadwal,
    expiresAt: Date.now() + TTL,
  })
  
  scheduleWrite()
}
