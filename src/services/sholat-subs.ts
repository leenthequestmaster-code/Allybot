import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SholatSubscription {
  kota: string
  subscribedAt: number
  subscribedBy: string
  enabled: boolean
}

type SubsState = Record<string, SholatSubscription>

const FILE_PATH = join(process.cwd(), 'data', 'sholat_subs.json')
let STATE: SubsState = {}
let isLoaded = false
let writeTimeout: NodeJS.Timeout | null = null

async function loadState(): Promise<void> {
  if (isLoaded) return
  if (existsSync(FILE_PATH)) {
    try {
      const data = await fs.readFile(FILE_PATH, 'utf-8')
      STATE = JSON.parse(data)
    } catch (e) {
      STATE = {}
    }
  }
  isLoaded = true
}

function scheduleWrite(): void {
  if (writeTimeout) return
  writeTimeout = setTimeout(async () => {
    writeTimeout = null
    try {
      await fs.writeFile(FILE_PATH, JSON.stringify(STATE, null, 2), 'utf-8')
    } catch (e) {
      // Best effort persist
    }
  }, 500) // Debounce 500ms
}

export async function subscribe(groupJid: string, kota: string, byJid: string): Promise<void> {
  await loadState()
  STATE[groupJid] = {
    kota: kota.toLowerCase().trim(),
    subscribedAt: Date.now(),
    subscribedBy: byJid,
    enabled: true,
  }
  scheduleWrite()
}

export async function unsubscribe(groupJid: string): Promise<void> {
  await loadState()
  if (STATE[groupJid]) {
    delete STATE[groupJid]
    scheduleWrite()
  }
}

export async function setKota(groupJid: string, kota: string): Promise<void> {
  await loadState()
  if (STATE[groupJid]) {
    STATE[groupJid].kota = kota.toLowerCase().trim()
    scheduleWrite()
  } else {
    throw new Error('Grup belum subscribed. Jalankan !sholat subscribe <kota> dulu.')
  }
}

export async function getStatus(groupJid: string): Promise<SholatSubscription | null> {
  await loadState()
  return STATE[groupJid] || null
}

export async function listAll(): Promise<Record<string, SholatSubscription>> {
  await loadState()
  return { ...STATE }
}
