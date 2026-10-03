const FAIL_THRESHOLD = 3
const OPEN_DURATION_MS = 5 * 60 * 1000 // 5 minutes

type State = 'closed' | 'open' | 'half-open'

let state: State = 'closed'
let consecutiveFails = 0
let openedAt: number | null = null

// ─── Core API ─────────────────────────────────────────────────────────────────

export function isOpen(): boolean {
  if (state === 'closed') return false

  if (state === 'open') {
    // Check if timeout elapsed → transition to half-open for probe
    if (openedAt !== null && Date.now() - openedAt >= OPEN_DURATION_MS) {
      state = 'half-open'
      return false // Allow one probe attempt
    }
    return true
  }

  // half-open: allow one probe
  return false
}

export function trip(): void {
  consecutiveFails++
  if (state === 'closed' && consecutiveFails >= FAIL_THRESHOLD) {
    state = 'open'
    openedAt = Date.now()
  } else if (state === 'half-open') {
    // Probe failed — re-open
    state = 'open'
    openedAt = Date.now()
    consecutiveFails = FAIL_THRESHOLD
  }
}

export function probe(): void {
  // Called on successful Deezer call
  if (state === 'half-open' || state === 'open') {
    state = 'closed'
    consecutiveFails = 0
    openedAt = null
  } else {
    // Normal success — reset fail counter
    consecutiveFails = 0
  }
}

export function reset(): void {
  state = 'closed'
  consecutiveFails = 0
  openedAt = null
}

export function notifyOwner(
  ownerJids: string[],
  notifyFn: (jid: string, message: string) => void,
): void {
  const msg =
    '⚠️ *[MusicBot]* Deezer ARL kemungkinan expired atau diblokir.\n' +
    'Circuit breaker OPEN — bot tidak bisa download musik untuk sementara.\n' +
    'Update `deezer_arl` di `/opt/Allybot/data/config.json` lalu restart bot.'

  for (const jid of ownerJids) {
    try {
      notifyFn(jid, msg)
    } catch {
      // best-effort
    }
  }
}

export function circuitStatus(): { state: string; consecutiveFails: number; openedAt: number | null } {
  return { state, consecutiveFails, openedAt }
}
