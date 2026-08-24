import type {
  MissionDefinition,
  MissionResponse,
  MissionTransition,
} from './mission.js'

export const GROUP_SETUP_MISSION_ID = 'group-setup'

export interface GroupSetupDraft {
  readonly groupJid: string
  readonly updatedBy: string
  readonly rules?: string
  readonly welcome?: string
  readonly leave?: string
  readonly prefix?: string
  readonly language?: 'id' | 'en'
  readonly timezone?: string
}

export interface GroupSetupGateway {
  apply(draft: GroupSetupDraft): Promise<void> | void
}

export function createGroupSetupMissionDefinition(gateway: GroupSetupGateway): MissionDefinition<GroupSetupDraft, string> {
  const next = (state: string, data: GroupSetupDraft, response: string | MissionResponse): MissionTransition<GroupSetupDraft> => ({
    type: 'transition',
    state,
    data,
    response: typeof response === 'string' ? textResponse(response) : response,
  })

  return {
    id: GROUP_SETUP_MISSION_ID,
    version: 1,
    initialState: 'rules',
    states: {
      rules: {
        onInput: (_context, rawInput) => {
          const value = optionalValue(rawInput)
          if (value === 'invalid') return stay('Aturan tidak boleh kosong. Kirim teks aturan atau ketik `skip`.')
          return next('welcome', { ..._context.mission.data, ...(value === undefined ? {} : { rules: value }) }, 'Kirim teks welcome member baru, atau ketik `skip`.')
        },
      },
      welcome: {
        onInput: (_context, rawInput) => {
          const value = optionalValue(rawInput)
          if (value === 'invalid') return stay('Pesan welcome tidak boleh kosong. Kirim teks atau ketik `skip`.')
          return next('leave', { ..._context.mission.data, ...(value === undefined ? {} : { welcome: value }) }, 'Kirim teks pesan leave, atau ketik `skip`.')
        },
      },
      leave: {
        onInput: (_context, rawInput) => {
          const value = optionalValue(rawInput)
          if (value === 'invalid') return stay('Pesan leave tidak boleh kosong. Kirim teks atau ketik `skip`.')
          return next('prefix', { ..._context.mission.data, ...(value === undefined ? {} : { leave: value }) }, 'Kirim prefix grup, misalnya `!`, atau ketik `skip`.')
        },
      },
      prefix: {
        onInput: (_context, rawInput) => {
          const normalized = rawInput.trim()
          if (normalized.toLowerCase() === 'skip') return next('language', _context.mission.data, 'Kirim bahasa grup: `id` atau `en`, atau ketik `skip`.')
          if (!/^[!#$%&*+./?@~_\-]{1,4}$/.test(normalized)) return stay('Prefix harus terdiri dari 1 sampai 4 simbol, misalnya `!`.')
          return next('language', { ..._context.mission.data, prefix: normalized }, 'Kirim bahasa grup: `id` atau `en`, atau ketik `skip`.')
        },
      },
      language: {
        onInput: (_context, rawInput) => {
          const normalized = rawInput.trim().toLowerCase()
          if (normalized === 'skip') return next('timezone', _context.mission.data, 'Kirim timezone IANA, misalnya `Asia/Jakarta`, atau ketik `skip`.')
          if (normalized !== 'id' && normalized !== 'en') return stay('Bahasa hanya mendukung `id` atau `en`.')
          return next('timezone', { ..._context.mission.data, language: normalized }, 'Kirim timezone IANA, misalnya `Asia/Jakarta`, atau ketik `skip`.')
        },
      },
      timezone: {
        onInput: (_context, rawInput) => {
          const normalized = rawInput.trim()
          if (normalized.toLowerCase() === 'skip') return next('review', _context.mission.data, renderReview(_context.mission.data))
          if (!isValidTimezone(normalized)) return stay('Timezone tidak valid. Gunakan nama IANA, misalnya `Asia/Jakarta`.')
          return next('review', { ..._context.mission.data, timezone: normalized }, renderReview({ ..._context.mission.data, timezone: normalized }))
        },
      },
      review: {
        onInput: async (_context, rawInput) => {
          const normalized = rawInput.trim().toLowerCase()
          if (normalized === 'cancel') return { type: 'cancel', response: textResponse('Group Setup Mission dibatalkan. Tidak ada perubahan yang diterapkan.') }
          if (normalized !== 'confirm') return stay('Ketik `confirm` untuk menerapkan konfigurasi atau `cancel` untuk membatalkan.')
          try {
            await gateway.apply(_context.mission.data)
            return { type: 'complete', response: textResponse('Group Setup Mission selesai. Konfigurasi grup berhasil diterapkan.') }
          } catch {
            return { type: 'fail', errorCode: 'group_setup_apply_failed', response: textResponse('Konfigurasi gagal diterapkan. Mission dihentikan agar tidak mengulang perubahan secara tidak aman.') }
          }
        },
      },
    },
  }
}

function optionalValue(rawInput: string): string | undefined | 'invalid' {
  const normalized = rawInput.trim()
  if (normalized.toLowerCase() === 'skip') return undefined
  if (!normalized) return 'invalid'
  if (normalized.length > 2_000) return 'invalid'
  return normalized
}

function textResponse(text: string): MissionResponse {
  return { kind: 'text', text }
}

function stay(text: string): MissionTransition<GroupSetupDraft> {
  return { type: 'stay', response: textResponse(text) }
}

function renderReview(draft: GroupSetupDraft): MissionResponse {
  const rows = [
    '*Review Group Setup*',
    `Rules: ${draft.rules ?? '(skip)'}`,
    `Welcome: ${draft.welcome ?? '(skip)'}`,
    `Leave: ${draft.leave ?? '(skip)'}`,
    `Prefix: ${draft.prefix ?? '(skip)'}`,
    `Language: ${draft.language ?? '(skip)'}`,
    `Timezone: ${draft.timezone ?? '(skip)'}`,
    '',
    'Ketik `confirm` untuk menerapkan atau `cancel` untuk membatalkan.',
  ]
  return textResponse(rows.join('\n'))
}

function isValidTimezone(value: string): boolean {
  if (!value || value.length > 64 || /\s/.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}
