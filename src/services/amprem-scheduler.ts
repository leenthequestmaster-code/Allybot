// Backup + GC + rate-limit notify scheduler untuk !am.
// Idempotent via state file — tidak double-run kalau bot restart.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const STATE_PATH = resolve('/opt/Allybot/data/amprem_backup_state.json')

interface SchedulerState {
  lastBackupDate: string
  lastGcDate: string
}

const state: SchedulerState = { lastBackupDate: '', lastGcDate: '' }

let dirty = false
let debounceTimer: NodeJS.Timeout | null = null

function schedulePersist(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!dirty) return
    try {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
      dirty = false
    } catch {
      // best-effort
    }
  }, 500)
}

function todayStr(): string {
  const now = new Date()
  const ms = now.getTime() + now.getTimezoneOffset() * 60000 + 7 * 3600000
  return new Date(ms).toISOString().slice(0, 10)
}

function hourWIB(): number {
  const now = new Date()
  const ms = now.getTime() + now.getTimezoneOffset() * 60000 + 7 * 3600000
  return new Date(ms).getUTCHours()
}

export function restoreSchedulerState(): void {
  if (!existsSync(STATE_PATH)) return
  try {
    const d = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<SchedulerState>
    if (typeof d.lastBackupDate === 'string') state.lastBackupDate = d.lastBackupDate
    if (typeof d.lastGcDate === 'string') state.lastGcDate = d.lastGcDate
  } catch {
    // corrupt — fresh
  }
}

// Return true kalau harus jalan sekarang (jam cocok + belum pernah hari ini).
export function shouldRunBackup(hour: number): boolean {
  const today = todayStr()
  if (state.lastBackupDate === today) return false
  if (hourWIB() !== hour) return false
  state.lastBackupDate = today
  dirty = true
  schedulePersist()
  return true
}

export function shouldRunGc(hour: number): boolean {
  const today = todayStr()
  if (state.lastGcDate === today) return false
  if (hourWIB() !== hour) return false
  state.lastGcDate = today
  dirty = true
  schedulePersist()
  return true
}