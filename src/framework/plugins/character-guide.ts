export function parseStrictPositiveInt(raw: string, maxLimit = 100): { ok: true; value: number } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'Input tidak boleh kosong' }
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return { ok: false, error: 'Harus berupa bilangan bulat positif' }
  const val = Number(trimmed)
  if (!Number.isSafeInteger(val) || val <= 0) return { ok: false, error: 'Nilai harus lebih besar dari 0' }
  if (val > maxLimit) return { ok: false, error: `Nilai maksimal adalah ${maxLimit}` }
  return { ok: true, value: val }
}

import { createHash } from 'node:crypto'
import type {
  CommandContext,
  CoreMessage,
  Plugin,
  PluginContext,
  WhatsAppGroupParticipant,
  WhatsAppPort,
} from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid, isJid } from '../validation.js'
import {
  CharacterGuideService,
  CharacterGuideValidationError,
  type CharacterRegistrationSession,
  type CharacterActiveRecord,
  calculateTimeRp,
  formatTimeRp,
} from '../../services/character-guide-service.js'
import { calculateCharacterStats, renderStatsCard } from '../../services/character-stats.js'
import { renderStatusCardImage } from '../../services/status-card-renderer.js'
import { executeHunt, renderHuntReport } from '../../services/character-hunting.js'
import type { EconomyService } from '../../services/economy-service.js'
import { extractCommandPayload, parseCharacterSheet } from '../../services/character-sheet-parser.js'
import { GroupContextService } from '../../services/group-context-service.js'

// Backend stub refusal (PENDING: no RPC backend exists). The command names stay
// reachable so users who already know them get one clear Indonesian refusal
// instead of silence, but every surface is hidden so no menu advertises the
// feature as active while the backend is empty. `timerp` keeps only its
// `rpwaktu` alias here — the previous list duplicated the command name as an
// alias, which register() rejects, and the resulting rollback killed the whole
// plugin on every boot.
const CHARACTER_GUIDE_BACKEND_PENDING_TEXT = 'Fitur Character Guide belum tersedia — backend sedang disiapkan.'

const CHARACTER_GUIDE_COMMAND_NAMES: readonly { readonly name: string; readonly aliases?: readonly string[] }[] = [
  { name: 'daftar', aliases: ['registercharacter', 'createcharacter'] },
  { name: 'savecharacter', aliases: ['savechar'] },
  { name: 'retry', aliases: ['retrycharacter'] },
  { name: 'cancel', aliases: ['cancelcharacter'] },
  { name: 'character', aliases: ['char', 'yourcharacter'] },
  { name: 'deletecharacter', aliases: ['deletechar', 'offcharacter'] },
  { name: 'timerp', aliases: ['rpwaktu'] },
  { name: 'guider' },
]

function registerCharacterGuideRefusalSurface(context: PluginContext): void {
  for (const { name, aliases } of CHARACTER_GUIDE_COMMAND_NAMES) {
    context.commands.register({
      name,
      ...(aliases ? { aliases } : {}),
      description: 'Fitur belum tersedia',
      hidden: true,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        await commandContext.reply(CHARACTER_GUIDE_BACKEND_PENDING_TEXT)
      },
    })
  }
}

const DEFAULT_SESSION_TTL_SECONDS = 1_800
const GUIDE_CONFIRM_TTL_MS = 2 * 60 * 1000
const CHARACTER_ID_PATTERN = /^[0-9a-f-]{20,64}$/iu

interface PendingOnboarding {
  readonly session?: CharacterRegistrationSession
  readonly cardCode: string
  readonly groupJid: string
  readonly ownerJid: string
  readonly stage: 'experience' | 'understanding'
  readonly createdAt: number
}

function characterService(ctx: CommandContext | { services: CommandContext['services'] }): CharacterGuideService {
  return ctx.services.get<CharacterGuideService>('character-guide')
}

function groupContextService(ctx: CommandContext | { services: CommandContext['services'] }): GroupContextService {
  return ctx.services.get<GroupContextService>('group-context')
}

function groupJid(context: CommandContext): string | undefined {
  return isGroupJid(context.message.remoteJid) ? context.message.remoteJid : undefined
}

function actorJid(context: CommandContext): string | undefined {
  return context.message.senderJid
}

function canonicalJid(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}

function onboardingKey(groupJid: string, ownerJid: string): string {
  return `${canonicalJid(groupJid)}:${canonicalJid(ownerJid)}`
}

function sameJid(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return canonicalJid(left) === canonicalJid(right)
}

function cardCode(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase()
}

function renderIdCard(code: string): string {
  return [
    'Character ID Card',
    `Registration ID: ${code}`,
    '',
    'Name:',
    'Gender:',
    'Age:',
    'Birthday:',
    'Race:',
    'Class:',
    'Element:',
    'Spirit: —',
    'Crew: —',
    'Will Of Path:',
    'Profession: —',
    'Motto: —',
    'Visual: —',
    'Origin: —',
  ].join('\n')
}

function renderGuideInstructions(): string {
  return [
    '*Panduan Pengisian Character ID Card*',
    'Isi bagian setelah tanda titik dua (:).',
    'Gunakan format sederhana seperti contoh berikut:',
    '',
    'Name: Aruna',
    'Gender: Female',
    'Age: 24',
    'Birthday: 12 Zephyra 776 KAR',
    'Race: Human',
    'Class: Knight',
    'Element: Fire',
    'Will Of Path: Neutral',
    'Profession: Librarian',
    'Motto: Penjaga yang tidak menyerah',
    'Visual: —',
    'Origin: —',
    '',
    'Format teks bebas (bold, miring, spasi, atau beda urutan tetap terbaca). Jangan isi Money, Membership, Rank, Level, atau Inventory karena diatur otomatis oleh sistem.',
  ].join('\n')
}

function renderPrivateCharacterGuide(): string {
  return [
    '*YOUR CHARACTER*',
    'Command yang tersedia:',
    '• !character — lihat Character aktif',
    '• !deletechar — nonaktifkan Character (butuh konfirmasi)',
    '• !daftar — buat Character baru setelah tidak ada yang aktif',
    '• !retry — ulang pendaftaran yang belum selesai',
    '• !cancel — batalkan pendaftaran yang berjalan',
    '• !guider — lihat kontak guider di grup',
  ].join('\n')
}

function renderSimpleGuide(): string {
  return [
    '*Panduan Singkat:*',
    '• Name: nama karakter',
    '• Gender: jenis kelamin karakter (Male/Female/Non-Binary)',
    '• Age: umur karakter (angka)',
    '• Birthday: tanggal lahir kalender KAR (contoh: 12 Zephyra 776 KAR)',
    '• Race: ras karakter (Human, Elf, dsb.)',
    '• Class: kelas atau keahlian utama (Knight, Mage, dsb.)',
    '• Element: elemen kekuatan (Fire, Water, dsb.)',
    '• Will Of Path: Light, Dark, atau Neutral',
    '• Bagian lain boleh dikosongkan dengan tanda —',
  ].join('\n')
}

function renderSaveUsage(prefix: string): string {
  return [
    `*Format:* ${prefix}savecharacter`,
    'Reply ID Card dengan command tersebut, lalu tulis seluruh data di bawahnya.',
  ].join('\n')
}

function renderParseIssues(issues: readonly { field?: string; message: string }[]): string {
  return [
    '*Character Sheet belum tersimpan.*',
    'Perbaiki bagian berikut:',
    ...issues.slice(0, 8).map((item) => `• ${item.field ? `${item.field}: ` : ''}${item.message}`),
    '',
    'Reply ulang ID Card dengan data yang sudah diperbaiki menggunakan *!savecharacter*.',
  ].join('\n')
}

function renderCharacter(record: Awaited<ReturnType<CharacterGuideService['getActive']>>): string {
  if (!record) return 'Kamu belum memiliki Character aktif. Gunakan !daftar di Grup Guide.'
  const stats = calculateCharacterStats(record.race, record.level, record.allocatedStats ?? {}, record.bonusTokens ?? 0)
  return [
    '╔═══════════════════════════════╗',
    '    ALLYSSEA · PASPOR WARGA RESMI',
    '╚═══════════════════════════════╝',
    `Nama       : *${record.name}*`,
    `Klasifikasi: ${record.race} · ${record.className} [${record.willOfPath}]`,
    `Status     : Rank ${record.rank} · Level ${record.level}`,
    `Kelahiran  : ${record.birthday} (${record.age} Thn)`,
    `Elemen     : ${record.element}`,
    '',
    '[VITALITAS BINTANG]',
    `HP : ${stats.hp}/${stats.maxHp}`,
    `SE : ${stats.se}/${stats.maxSe}`,
    '',
    '[POTENSI ATRIBUT]',
    `STR ${stats.str} │ DEF ${stats.def} │ MP ${stats.mp} │ RES ${stats.res}`,
    `SPD ${stats.spd} │ INT ${stats.int} │ LCK ${stats.lck}`,
    `Sisa Stat Token: ${stats.statTokens} (Ketik !alokasi untuk meningkatkan)`,
    '',
    '[CATATAN SIPIL]',
    `• Spirit    : ${record.spirit ?? '—'}`,
    `• Crew      : ${record.crew ?? '—'}`,
    `• Asal      : ${record.origin ?? '—'}`,
    `• Profesi   : ${record.profession ?? '—'}`,
    `• Gelar     : ${record.titles.join(', ') || '—'}`,
    `• Motto     : ${record.motto ? `"${record.motto}"` : '—'}`,
    '─────────────────────────────────',
    'Gunakan *!stats* untuk detail lengkap atau *!timerp* untuk waktu benua.',
  ].join('\n')
}

function parseCardCode(quotedText: string | undefined): string | undefined {
  const match = quotedText?.match(/(?:^|\n)\s*Registration ID\s*:\s*([A-Z0-9]{12})\s*(?:\n|$)/iu)
  return match?.[1]?.toUpperCase()
}

function isCommand(text: string | undefined, prefix: string): boolean {
  return Boolean(text?.trimStart().startsWith(prefix))
}

function choiceFromMessage(message: CoreMessage): string | undefined {
  const button = message.buttonId?.trim().toLowerCase()
  if (button) return button
  const text = message.text?.trim().toLowerCase()
  if (text === '1' || text === 'pernah') return 'guide-experience-veteran'
  if (text === '2' || text === 'pernah tapi beda platform' || text === 'pernah, tetapi dari platform lain') return 'guide-experience-other-platform'
  if (text === '3' || text === 'ini pertama kali' || text === 'pertama kali') return 'guide-experience-beginner'
  if (text === 'sudah paham') return 'guide-understood'
  if (text === 'belum mengerti') return 'guide-confused'
  return undefined
}

async function resolveAdminTarget(
  commandContext: CommandContext,
  service: CharacterGuideService,
  actor: string,
): Promise<{ targetKey: string; character?: CharacterActiveRecord; remainingArgs: string[] }> {
  const mentioned = commandContext.message.mentionedJids?.filter(isJid) ?? []
  if (mentioned.length > 0) {
    return {
      targetKey: mentioned[0],
      remainingArgs: commandContext.args.filter((a) => !a.startsWith('@')),
    }
  }

  if (commandContext.message.quotedSenderJid && isJid(commandContext.message.quotedSenderJid)) {
    return {
      targetKey: commandContext.message.quotedSenderJid,
      remainingArgs: [...commandContext.args],
    }
  }

  const args = [...commandContext.args]

  // Check if any arg is a phone number
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    const digits = raw.replace(/[^0-9]/g, '')
    if (digits.length >= 10 && digits.length <= 15 && (/^(\+?62|08)/.test(raw) || digits.startsWith('628') || digits.startsWith('08'))) {
      const normalized = (digits.startsWith('0') ? '62' + digits.slice(1) : digits) + '@s.whatsapp.net'
      const rem = [...args]
      rem.splice(i, 1)
      return { targetKey: normalized, remainingArgs: rem }
    }
  }

  // Check if non-numeric args match a character name in DB
  const skipWords = new Set(['char', 'dossier', 'paspor', 'stats', 'profile', 'f-', 'f', 'e', 'd', 'c', 'b', 'a', 's', 'ss', 'sss'])
  const nonNumericParts = args.filter((a) => !/^-?\d+$/.test(a) && !skipWords.has(a.toLowerCase()))
  if (nonNumericParts.length > 0) {
    const potentialName = nonNumericParts.join(' ').trim()
    try {
      const found = await service.findActiveByName(potentialName)
      if (found) {
        const rem = args.filter((a) => !nonNumericParts.includes(a))
        return { targetKey: found.ownerKey ?? found.characterId, character: found, remainingArgs: rem }
      }
    } catch {}
  }

  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!/^-?\d+$/.test(raw) && !skipWords.has(raw.toLowerCase())) {
      try {
        const found = await service.findActiveByName(raw)
        if (found) {
          const rem = [...args]
          rem.splice(i, 1)
          return { targetKey: found.ownerKey ?? found.characterId, character: found, remainingArgs: rem }
        }
      } catch {}
    }
  }

  return { targetKey: actor, remainingArgs: args }
}

async function sendQuickReplies(
  whatsapp: WhatsAppPort,
  remoteJid: string,
  body: string,
  buttons: readonly { id: string; title: string }[],
  fallback: string,
): Promise<void> {
  if (whatsapp.sendNativeQuickReplies) {
    try {
      await whatsapp.sendNativeQuickReplies(remoteJid, { type: 'native_quick_reply', body, buttons })
      return
    } catch (err) {
      // Fall back to text when the native transport is unavailable or rejected.
    }
  }
  await whatsapp.sendText(remoteJid, `${body}\n\n${fallback}`)
}

function guideRequirement(context: CommandContext, mode: string): string | undefined {
  if (mode === 'guide') return undefined
  return `Command ini hanya bisa digunakan di Grup Guide. Mode grup saat ini: ${mode.toUpperCase()}.`
}

export function createCharacterGuidePlugin(whatsapp: WhatsAppPort): Plugin {
  const onboarding = new Map<string, PendingOnboarding>()
  const deleteConfirmations = new Map<string, number>()

  return {
    name: 'character-guide',
    version: '0.1.0',
    dependencies: ['group-context'],
    load(context) {
      const service = context.services.get<CharacterGuideService>('character-guide')
      const groupContext = context.services.get<GroupContextService>('group-context')
      // Explicit disable ladder:
      // 1. flag false  → plugin registers nothing at all (no commands, no listeners)
      // 2. flag true + stub backend → hidden refusal surface; commands always answer
      //    with CHARACTER_GUIDE_BACKEND_PENDING_TEXT and neither the onboarding
      //    listeners nor any service method is ever registered/called
      // 3. flag true + real backend → the full live guide surface
      if (!service.isEnabled) return
      if (!service.hasBackend) {
        registerCharacterGuideRefusalSurface(context)
        context.logger.info('Character Guide plugin loaded in backend-pending refusal mode')
        return
      }
      const onboardingTtlMs = Math.max(60_000, (context.config.characterGuideSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS) * 1_000)
      const cardLocks = new Map<string, Promise<PendingOnboarding | undefined>>()
      const cardMessageLocks = new Map<string, Promise<void>>()

      const pruneTransientState = (): void => {
        const now = Date.now()
        for (const [key, pending] of onboarding) if (now - pending.createdAt > onboardingTtlMs) onboarding.delete(key)
        for (const [key, expiresAt] of deleteConfirmations) if (expiresAt <= now) deleteConfirmations.delete(key)
      }

      const issueCard = async (pending: PendingOnboarding): Promise<PendingOnboarding | undefined> => {
        const key = onboardingKey(pending.groupJid, pending.ownerJid)
        if (pending.session) return pending
        const existingLock = cardLocks.get(key)
        if (existingLock) return existingLock
        const work = (async (): Promise<PendingOnboarding | undefined> => {
          const current = onboarding.get(key)
          if (current?.session) return current
          const referenceKey = service.createCardReference(pending.groupJid, pending.ownerJid, pending.cardCode)
          const ttl = context.config.characterGuideSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
          const session = await service.startRegistration(pending.groupJid, pending.ownerJid, referenceKey, ttl)
          if (session.existing && session.referenceKey !== referenceKey) {
            await whatsapp.sendText(pending.groupJid, 'Pendaftaranmu sudah memiliki ID Card aktif. Gunakan !retry jika ingin membatalkan lalu mulai ulang.')
            return undefined
          }
          const next = { ...pending, session, stage: pending.stage }
          onboarding.set(key, next)
          return next
        })()
        cardLocks.set(key, work)
        try {
          return await work
        } finally {
          if (cardLocks.get(key) === work) cardLocks.delete(key)
        }
      }

      const sendCardInstructions = async (pending: PendingOnboarding, simpleFirst = false): Promise<void> => {
        const key = onboardingKey(pending.groupJid, pending.ownerJid)
        if (pending.session) return
        const existingLock = cardMessageLocks.get(key)
        if (existingLock) return existingLock
        const work = (async (): Promise<void> => {
          let ready: PendingOnboarding | undefined
          try {
            ready = await issueCard(pending)
          } catch (err) {
            context.logger.warn('character guide card issuance failed')
            try {
              await whatsapp.sendText(pending.groupJid, 'ID Card belum bisa diterbitkan sekarang. Coba lagi sebentar lagi atau gunakan !retry jika sesi lama bermasalah.')
            } catch {
              context.logger.warn('character guide recovery notice failed')
            }
            return
          }
          if (!ready) return
          try {
            if (simpleFirst) {
              await whatsapp.sendText(ready.groupJid, renderSimpleGuide())
              await whatsapp.sendText(ready.groupJid, renderIdCard(ready.cardCode))
              await whatsapp.sendText(ready.groupJid, renderGuideInstructions())
            } else {
              await whatsapp.sendText(ready.groupJid, renderGuideInstructions())
              await whatsapp.sendText(ready.groupJid, renderIdCard(ready.cardCode))
            }
            await whatsapp.sendText(ready.groupJid, 'Setelah selesai, reply ID Card tersebut dengan *!savecharacter*. Untuk melihat daftar guider, gunakan *!guider*.')
          } catch {
            onboarding.delete(key)
            context.logger.warn('character guide card delivery failed')
            try {
              await whatsapp.sendText(pending.groupJid, 'ID Card belum terkirim lengkap. Gunakan !retry untuk membatalkan sesi ini lalu mulai ulang.')
            } catch {
              context.logger.warn('character guide delivery recovery notice failed')
            }
          }
        })()
        cardMessageLocks.set(key, work)
        try {
          await work
        } finally {
          if (cardMessageLocks.get(key) === work) cardMessageLocks.delete(key)
        }
      }

      context.events.on('message.received', async (message) => {
        pruneTransientState()
        if (!service.isEnabled || !isGroupJid(message.remoteJid) || !message.senderJid) return
        if (context.services.has('web-companion')) return
        const selection = choiceFromMessage(message)
        if (!selection || isCommand(message.text, context.config.commandPrefix)) return
        const key = onboardingKey(message.remoteJid, message.senderJid)
        const pending = onboarding.get(key)
        if (!pending) return
        if (selection === 'guide-experience-veteran') {
          await sendCardInstructions(pending)
          return
        }
        if (selection === 'guide-experience-other-platform') {
          if (pending.stage === 'understanding' || pending.session) return
          onboarding.set(key, { ...pending, stage: 'understanding', createdAt: Date.now() })
          await whatsapp.sendText(message.remoteJid, renderGuideInstructions())
          await sendQuickReplies(whatsapp, message.remoteJid, 'Apakah panduan ini sudah dipahami?', [
            { id: 'guide-understood', title: 'Sudah paham' },
            { id: 'guide-confused', title: 'Belum mengerti' },
          ], 'Balas dengan 1 untuk Sudah paham atau 2 untuk Belum mengerti.')
          return
        }
        if (selection === 'guide-experience-beginner') {
          await sendCardInstructions(pending, true)
          return
        }
        if (selection === 'guide-confused') {
          await sendCardInstructions(pending, true)
          return
        }
        if (selection === 'guide-understood' && pending.stage === 'understanding') {
          await sendCardInstructions(pending)
        }
      })

      context.events.on('group.participants.changed', async (event) => {
        pruneTransientState()
        if (!service.isEnabled || event.action !== 'add' || !isGroupJid(event.groupJid)) return
        const current = await groupContext.get(event.groupJid)
        if (current.mode !== 'guide') return
        const botJid = whatsapp.userJid
        const participants = event.participantJids
          .filter((participant) => isJid(participant) && !sameJid(participant, botJid))
          .slice(0, 10)

        if (context.services.has('web-companion')) {
          for (const participant of participants) {
            const active = await service.getActive(event.groupJid, participant)
            if (active) continue
            const phone = canonicalJid(participant).split('@')[0] ?? 'member'
            await whatsapp.sendText(
              event.groupJid,
              `Selamat datang di Benua Allyssea, @${phone}!\nUntuk mulai membuat karakter, silakan ketik *!daftar* di grup ini.`,
              { mentions: [participant] },
            )
          }
          return
        }

        for (const participant of participants) {
          const key = onboardingKey(event.groupJid, participant)
          if (onboarding.has(key)) continue
          onboarding.set(key, {
            cardCode: cardCode(participant),
            groupJid: event.groupJid,
            ownerJid: participant,
            stage: 'experience',
            createdAt: Date.now(),
          })
          await whatsapp.sendText(event.groupJid, `Selamat datang di Grup Guide, @${canonicalJid(participant).split('@')[0] ?? 'member'}.` , { mentions: [participant] })
          await sendQuickReplies(whatsapp, event.groupJid, 'Sudah pernah bermain RP sebelumnya?', [
            { id: 'guide-experience-veteran', title: 'Pernah' },
            { id: 'guide-experience-other-platform', title: 'Pernah dari platform lain' },
            { id: 'guide-experience-beginner', title: 'Ini pertama kali' },
          ], 'Balas dengan 1, 2, atau 3.')
        }
      })

      context.commands.register({
        name: 'daftar',
        aliases: ['registercharacter', 'createcharacter'],
        description: 'Mulai pendaftaran Character Sheet di Grup Guide',
        category: 'your-character',
        menuOrder: 1,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) {
            await commandContext.reply('Command ini hanya bisa digunakan di dalam grup Guide.')
            return
          }
          if (!service.isEnabled) {
            await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
            return
          }
          const currentContext = await groupContext.get(group)
          const modeError = guideRequirement(commandContext, currentContext.mode)
          if (modeError) {
            await commandContext.reply(modeError)
            return
          }
          const active = await service.getActive(group, actor)
          if (active) {
            await commandContext.reply('Kamu masih punya Character aktif. Gunakan !character untuk melihatnya atau !deletecharacter jika ingin mulai ulang.')
            return
          }

          if (commandContext.services.has('web-companion')) {
            try {
              const web = commandContext.services.get<any>('web-companion')
              const sess = await web.createSession(actor, group)
              if (sess?.url) {
                const phone = canonicalJid(actor).split('@')[0] ?? 'member'
                const welcomeText = [
                  '*REGISTRI KARAKTER BENUA ALLYSSEA*',
                  '',
                  `Selamat datang, @${phone}!`,
                  'Pendaftaran karakter resmi dilakukan melalui formulir web di tautan berikut:',
                  `🔗 ${sess.url}`,
                  '',
                  '_Tautan ini privat dan aktif selama 30 menit. Setelah disimpan di web, karaktermu langsung aktif dan bisa dicek dengan *!character*._',
                ].join('\n')
                await whatsapp.sendText(group, welcomeText, { mentions: [actor] })
                return
              }
            } catch (err) {
              context.logger.warn({ err }, 'failed to create web companion session in !daftar')
            }
          }

          const existing = await service.getRegistration(group, actor)
          if (existing) {
            await commandContext.reply('Pendaftaranmu masih berjalan. Reply ID Card yang sudah dikirim dengan !savecharacter, atau ketik !retry untuk mulai ulang.')
            return
          }
          const code = cardCode(`${group}:${actor}:${Date.now()}`)
          onboarding.set(onboardingKey(group, actor), { cardCode: code, groupJid: group, ownerJid: actor, stage: 'experience', createdAt: Date.now() })

          await whatsapp.sendText(group, 'Selamat datang di Grup Guide! Sebelum membuat karakter, pilih pengalamanmu bermain Roleplay:')
          await sendQuickReplies(whatsapp, group, 'Pilih salah satu:', [
            { id: 'guide-experience-veteran', title: 'Pernah' },
            { id: 'guide-experience-other-platform', title: 'Pernah dari platform lain' },
            { id: 'guide-experience-beginner', title: 'Ini pertama kali' },
          ], 'Balas dengan 1, 2, atau 3.')
        },
      })

      // Only register legacy manual !savecharacter command in environments without web-companion
      if (!context.services.has('web-companion')) {
        context.commands.register({
          name: 'savecharacter',
          aliases: ['savechar'],
          description: 'Simpan Character Sheet dari reply ID Card',
          category: 'your-character',
          menuOrder: 2,
          cooldownMs: 5_000,
          handler: async (commandContext) => {
            pruneTransientState()
            const group = groupJid(commandContext)
            const actor = actorJid(commandContext)
            if (!group || !actor) {
              await commandContext.reply('Command ini hanya bisa digunakan di dalam grup Guide.')
              return
            }
            if (!service.isEnabled) {
              await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
              return
            }
            const currentContext = await groupContext.get(group)
            const modeError = guideRequirement(commandContext, currentContext.mode)
            if (modeError) {
              await commandContext.reply(modeError)
              return
            }
            if (!commandContext.message.quotedText || !commandContext.message.quotedMessageId || !sameJid(commandContext.message.quotedSenderJid, commandContext.whatsapp.userJid)) {
              await commandContext.reply('Reply pesan Character ID Card dari Allybot, lalu kirim !savecharacter bersama data lengkap karaktermu.')
              return
            }
            const code = parseCardCode(commandContext.message.quotedText)
            if (!code) {
              await commandContext.reply('Pesan yang kamu reply bukan Character ID Card dari Allybot.')
              return
            }
            const registration = await service.getRegistration(group, actor)
            if (!registration || registration.referenceKey !== service.createCardReference(group, actor, code)) {
              await commandContext.reply('Registration ID tidak cocok atau sesi pendaftaran sudah kedaluwarsa. Gunakan !retry di Grup Guide untuk mulai ulang.')
              return
            }
            const rawBody = extractCommandPayload(commandContext.message.text, commandContext.prefix, 'savecharacter')
            if (!rawBody) {
              await commandContext.reply(renderSaveUsage(commandContext.prefix))
              return
            }
            const parsed = parseCharacterSheet(rawBody)
            if (!parsed.ok) {
              await commandContext.reply(renderParseIssues(parsed.issues))
              return
            }
            try {
              const saved = await service.save(group, actor, registration.sessionId, registration.referenceKey, parsed.payload, commandContext.message.id)
              onboarding.delete(onboardingKey(group, actor))
              await commandContext.reply(`Character Sheet ${saved.name} berhasil disimpan.`)
              if (saved.deliveryId) {
                try {
                  await whatsapp.sendText(actor, '*YOUR CHARACTER*\n\nCharacter Sheet berhasil didaftarkan. Gunakan !character untuk melihat profil dan !deletecharacter jika ingin mulai ulang.')
                  await service.markDelivery(saved.deliveryId, 'sent')
                } catch {
                  await service.markDelivery(saved.deliveryId, 'failed', 'private_delivery_failed')
                  context.logger.warn({ groupJid: group }, 'character guide private delivery failed')
                }
              }
            } catch (error) {
              if (error instanceof CharacterGuideValidationError) await commandContext.reply(error.message)
              else await commandContext.reply('Character Sheet belum bisa disimpan saat ini. Coba lagi nanti.')
            }
          },
        })
      }

      context.commands.register({
        name: 'retry',
        aliases: ['retrycharacter'],
        description: 'Ulangi pendaftaran Character Sheet',
        category: 'your-character',
        menuOrder: 3,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) return void await commandContext.reply('Command ini hanya bisa digunakan di dalam grup Guide.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const currentContext = await groupContext.get(group)
          const modeError = guideRequirement(commandContext, currentContext.mode)
          if (modeError) return void await commandContext.reply(modeError)
          const registration = await service.getRegistration(group, actor)
          if (registration) await service.cancelRegistration(group, actor, registration.sessionId)
          onboarding.delete(onboardingKey(group, actor))
          await commandContext.reply('Pendaftaran sebelumnya dibatalkan. Jalankan !daftar untuk membuat ID Card baru.')
        },
      })

      context.commands.register({
        name: 'cancel',
        aliases: ['cancelcharacter'],
        description: 'Batalkan pendaftaran Character Sheet yang belum selesai',
        category: 'your-character',
        menuOrder: 4,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) return void await commandContext.reply('Command ini hanya bisa digunakan di dalam grup Guide.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const registration = await service.getRegistration(group, actor)
          if (!registration) return void await commandContext.reply('Tidak ada pendaftaran Character yang sedang berjalan.')
          await service.cancelRegistration(group, actor, registration.sessionId)
          onboarding.delete(onboardingKey(group, actor))
          await commandContext.reply('Pendaftaran Character dibatalkan. Character aktif yang sudah tersimpan tidak terpengaruh.')
        },
      })

      context.commands.register({
        name: 'character',
        aliases: ['char', 'yourcharacter'],
        description: 'Lihat Character aktif',
        category: 'your-character',
        menuOrder: 5,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const record = group ? await service.getActive(group, actor) : await service.getActiveForOwner(actor)
          if (!record) {
            await commandContext.reply(renderCharacter(record))
            return
          }

          const stats = calculateCharacterStats(record.race, record.level, record.allocatedStats ?? {}, record.bonusTokens ?? 0)
          let mediaSent = false
          if (commandContext.whatsapp.sendMedia) {
            try {
              const imgBuffer = await renderStatusCardImage('character', {
                name: record.name,
                gender: record.gender,
                age: record.age,
                birthday: record.birthday,
                race: record.race,
                className: record.className,
                element: record.element,
                rank: record.rank,
                level: record.level,
                willOfPath: record.willOfPath,
                spirit: record.spirit,
                crew: record.crew,
                profession: record.profession,
                origin: record.origin,
                titles: record.titles,
                motto: record.motto,
                stats: stats as unknown as Record<string, unknown>,
              }, commandContext.logger)
              if (imgBuffer) {
                await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                  kind: 'image',
                  data: new Uint8Array(imgBuffer),
                  mimeType: 'image/png',
                })
                mediaSent = true
              }
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to send character card media, fallback to text')
            }
          }

          if (!mediaSent) {
            await commandContext.reply(renderCharacter(record))
          }

          const pendingDelivery = await service.pendingDeliveryForOwner(actor)
          if (pendingDelivery) {
            try {
                await whatsapp.sendText(actor, renderPrivateCharacterGuide())
              await service.markDelivery(pendingDelivery, 'sent')
            } catch {
              await service.markDelivery(pendingDelivery, 'failed', 'private_delivery_failed')
            }
          }
        },
      })

      // The former duplicate `timerp` alias (name listed again as an alias) made
      // register() throw and PluginManager.cleanup() roll back every command this
      // plugin had registered; fixed by keeping only `rpwaktu` as the alias.
      context.commands.register({
        name: 'timerp',
        aliases: ['rpwaktu'],
        description: 'Lihat waktu RP Allyssea saat ini',
        category: 'your-character',
        hidden: true,
        menuOrder: 8,
        handler: async (commandContext) => {
          const result = calculateTimeRp()
          await commandContext.reply(formatTimeRp(result))
        },
      })

      context.commands.register({
        name: 'stats',
        aliases: ['mystats', 'characterstats'],
        description: 'Lihat status atribut & alokasi token karakter',
        category: 'your-character',
        menuOrder: 6,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const record = await service.getActiveForOwner(actor)
          if (!record) return void await commandContext.reply('Kamu belum memiliki Character aktif. Ketik !daftar untuk membuat karakter.')
          const stats = calculateCharacterStats(record.race, record.level, record.allocatedStats ?? {}, record.bonusTokens ?? 0)

          let mediaSent = false
          if (commandContext.whatsapp.sendMedia) {
            try {
              const imgBuffer = await renderStatusCardImage('stats', {
                name: record.name,
                gender: record.gender,
                age: record.age,
                birthday: record.birthday,
                race: record.race,
                className: record.className,
                element: record.element,
                rank: record.rank,
                level: record.level,
                willOfPath: record.willOfPath,
                spirit: record.spirit,
                crew: record.crew,
                profession: record.profession,
                origin: record.origin,
                titles: record.titles,
                motto: record.motto,
                stats: stats as unknown as Record<string, unknown>,
              }, commandContext.logger)
              if (imgBuffer) {
                await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                  kind: 'image',
                  data: new Uint8Array(imgBuffer),
                  mimeType: 'image/png',
                })
                mediaSent = true
              }
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to send stats card media, fallback to text')
            }
          }

          if (!mediaSent) {
            await commandContext.reply(renderStatsCard(record.name, record.race, record.className, record.rank, record.level, stats))
          }
        },
      })

      context.commands.register({
        name: 'alokasi',
        aliases: ['addstat', 'upstat', 'allocatestat'],
        description: 'Alokasikan Stat Token ke atribut (HP/SE/STR/DEF/MP/RES/SPD/INT/LCK)',
        category: 'your-character',
        menuOrder: 7,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const statKey = commandContext.args[0]?.toLowerCase()
          const parseRes = parseStrictPositiveInt(commandContext.args[1] ?? '1', 100)
          if (!statKey) {
            return void await commandContext.reply([
              '*Format Alokasi Stat Token:*',
              `${commandContext.prefix}alokasi <stat> <jumlah>`,
              '',
              'Pilihan Stat:',
              '• hp  (+150 HP per token)',
              '• se  (+100 SE per token)',
              '• str, def, mp, res, spd, int, lck (+1 poin per token)',
              '',
              'Contoh: `!alokasi str 2` atau `!alokasi hp 1`',
            ].join('\n'))
          }
          if (!parseRes.ok) {
            return void await commandContext.reply(`Jumlah alokasi tidak valid: ${parseRes.error}. (Maksimal 100 per perintah)`)
          }
          const result = await service.allocateStats(groupJid(commandContext) || 'global', actor, statKey, parseRes.value)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'givetoken',
        aliases: ['addtoken', 'tokenreward'],
        description: 'Berikan Stat Token kepada karakter (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 35,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const { targetKey, remainingArgs } = await resolveAdminTarget(commandContext, service, actor)
          const rawAmount = remainingArgs[0]
          const parseRes = parseStrictPositiveInt(rawAmount ?? '', 1000)

          if (!parseRes.ok) {
            return void await commandContext.reply([
              '*Format Give Token:*',
              `• \`${commandContext.prefix}givetoken <jumlah>\` (untuk diri sendiri)`,
              `• \`${commandContext.prefix}givetoken <@target / nomor / nama> <jumlah>\``,
              '',
              `Contoh: \`${commandContext.prefix}givetoken 10\` atau \`${commandContext.prefix}givetoken Cheryl 5\``,
            ].join('\n'))
          }

          const result = await service.grantTokens(targetKey, parseRes.value)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'setlevel',
        aliases: ['chlevel', 'lvl'],
        description: 'Ubah level karakter target (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 36,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const { targetKey, remainingArgs } = await resolveAdminTarget(commandContext, service, actor)
          const rawLevel = remainingArgs[0]
          const parseRes = parseStrictPositiveInt(rawLevel ?? '', 100)

          if (!parseRes.ok) {
            return void await commandContext.reply([
              '*Format Set Level:*',
              `• \`${commandContext.prefix}setlevel <1-100>\` (untuk diri sendiri)`,
              `• \`${commandContext.prefix}setlevel <@target / nomor / nama> <1-100>\``,
              '',
              `Contoh: \`${commandContext.prefix}setlevel 25\` atau \`${commandContext.prefix}setlevel Cheryl 50\``,
            ].join('\n'))
          }

          const result = await service.setLevel(targetKey, parseRes.value)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'resetstats',
        aliases: ['resetsheet', 'statreset'],
        description: 'Refund & reset seluruh alokasi stat karakter (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 37,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const { targetKey } = await resolveAdminTarget(commandContext, service, actor)
          const result = await service.resetStats(targetKey)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'setrank',
        aliases: ['chrank', 'rankset'],
        description: 'Ubah rank lisensi karakter target (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 38,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const { targetKey, remainingArgs } = await resolveAdminTarget(commandContext, service, actor)
          const validRanks = ['F-', 'F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS']
          let chosenRank: string | undefined
          for (const arg of remainingArgs) {
            const up = arg.toUpperCase()
            if (validRanks.includes(up)) {
              chosenRank = up
              break
            }
          }

          if (!chosenRank) {
            return void await commandContext.reply([
              '*Format Set Rank:*',
              `• \`${commandContext.prefix}setrank <rank>\` (untuk diri sendiri)`,
              `• \`${commandContext.prefix}setrank <@target / nomor / nama> <rank>\``,
              '',
              `Pilihan Rank: ${validRanks.join(', ')}`,
              `Contoh: \`${commandContext.prefix}setrank S\` atau \`${commandContext.prefix}setrank Cheryl SS\``,
            ].join('\n'))
          }

          const result = await service.setRank(targetKey, chosenRank)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'inspectchar',
        aliases: ['charinfo', 'chardebug', 'inspect'],
        description: 'Intip visual Status Window karakter target (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 39,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const { targetKey, character, remainingArgs } = await resolveAdminTarget(commandContext, service, actor)
          const record = character ?? await service.getActiveForOwner(targetKey)
          if (!record) {
            return void await commandContext.reply('Karakter aktif tidak ditemukan untuk target tersebut.')
          }

          const stats = calculateCharacterStats(record.race, record.level, record.allocatedStats ?? {}, record.bonusTokens ?? 0)
          const mode = remainingArgs.some((a) => ['char', 'dossier', 'paspor', 'profile'].includes(a.toLowerCase())) ? 'character' : 'stats'

          let mediaSent = false
          if (commandContext.whatsapp.sendMedia) {
            try {
              const imgBuffer = await renderStatusCardImage(mode, {
                name: record.name,
                gender: record.gender,
                age: record.age,
                birthday: record.birthday,
                race: record.race,
                className: record.className,
                element: record.element,
                rank: record.rank,
                level: record.level,
                willOfPath: record.willOfPath,
                spirit: record.spirit,
                crew: record.crew,
                profession: record.profession,
                origin: record.origin,
                titles: record.titles,
                motto: record.motto,
                stats: stats as unknown as Record<string, unknown>,
              }, commandContext.logger)
              if (imgBuffer) {
                await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                  kind: 'image',
                  data: new Uint8Array(imgBuffer),
                  mimeType: 'image/png',
                })
                mediaSent = true
              }
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to send inspected character card media')
            }
          }

          if (!mediaSent) {
            await commandContext.reply(mode === 'character' ? renderCharacter(record) : renderStatsCard(record.name, record.race, record.className, record.rank, record.level, stats))
          }
        },
      })

      context.commands.register({
        name: 'forceretire',
        aliases: ['killchar', 'wipechar'],
        description: 'Nonaktifkan paksa karakter target (khusus admin/owner)',
        category: 'moderation',
        permission: permissionNames.groupAdminOrBotOwner,
        menuOrder: 40,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')

          const hasMention = (commandContext.message.mentionedJids?.filter(isJid) ?? []).length > 0
          const hasQuoted = Boolean(commandContext.message.quotedSenderJid && isJid(commandContext.message.quotedSenderJid))
          const hasArgs = commandContext.args.length > 0

          if (!hasMention && !hasQuoted && !hasArgs) {
            return void await commandContext.reply([
              '*Peringatan:* Command ini akan menonaktifkan karakter target secara paksa.',
              `Format: \`${commandContext.prefix}forceretire <@target / nomor / nama>\``,
              '',
              `Contoh: \`${commandContext.prefix}forceretire Cheryl\` atau \`${commandContext.prefix}forceretire @user\``,
            ].join('\n'))
          }

          const { targetKey } = await resolveAdminTarget(commandContext, service, actor)
          const result = await service.forceRetire(targetKey)
          await commandContext.reply(result.message)
        },
      })

      context.commands.register({
        name: 'hunt',
        aliases: ['berburu', 'ekspedisi'],
        description: 'Jalankan ekspedisi perburuan monster alam liar untuk imbalan Vela',
        category: 'roleplay',
        hidden: true,
        menuOrder: 8,
        cooldownMs: 30_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const actor = actorJid(commandContext)
          if (!actor) return void await commandContext.reply('Identitas pengirim tidak ditemukan.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const record = await service.getActiveForOwner(actor)
          if (!record) return void await commandContext.reply('Kamu belum memiliki Character aktif. Ketik !daftar untuk membuat karakter.')
          
          const stats = calculateCharacterStats(record.race, record.level, record.allocatedStats ?? {}, record.bonusTokens ?? 0)
          const result = executeHunt(record.name, record.className, stats)

          if (result.victory && result.velaEarned > 0 && commandContext.services.has('economy')) {
            try {
              const eco = commandContext.services.get<EconomyService>('economy')
              if (eco.isEnabled) {
                const group = groupJid(commandContext) || '120363000000000001@g.us'
                const opKey = `hunt-reward-${actor}-${Date.now()}`
                await eco.grantReward(group, actor, result.velaEarned, actor, opKey, `Hasil Berburu: ${result.monster.name}`)
              }
            } catch (err) {
              context.logger.warn({ err }, 'failed to grant hunt reward to economy')
            }
          }

          await commandContext.reply(renderHuntReport(record.name, result))
        },
      })

      context.commands.register({
        name: 'toko',
        aliases: ['pasar', 'shop'],
        description: 'Lihat daftar perbekalan resmi Benua Allyssea',
        category: 'your-character',
        hidden: true,
        menuOrder: 9,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          await commandContext.reply([
            '🏪 *TOKO PERBEKALAN RESMI ALLYSSEA*',
            '─────────────────────────────',
            '1. *Ramuan Pemulih HP (Minor Salve)*',
            '   • Harga: 50 Vela',
            '   • Efek : Memulihkan 200 Health Point saat bertualang.',
            '',
            '2. *Kristal Bintang (Star Shard)*',
            '   • Harga: 75 Vela',
            '   • Efek : Memulihkan 100 Star Energy.',
            '',
            '3. *Peta Lembah Jura (Expedition Map)*',
            '   • Harga: 150 Vela',
            '   • Efek : Membuka wilayah perburuan berimbalan tinggi.',
            '',
            '4. *Surat Lisensi Pemburu (Hunter Crest)*',
            '   • Harga: 500 Vela',
            '   • Efek : Bukti kelayakan ujian kenaikan Rank.',
            '─────────────────────────────',
            '_Gunakan *!hunt* untuk mengumpulkan Vela dari perburuan monster liar._',
          ].join('\n'))
        },
      })

      context.commands.register({
        name: 'deletecharacter',
        aliases: ['deletechar', 'offcharacter'],
        description: 'Nonaktifkan Character aktif dan mulai ulang',
        category: 'your-character',
        menuOrder: 6,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          pruneTransientState()
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) return void await commandContext.reply('Command Character hanya bisa digunakan di dalam grup.')
          if (!service.isEnabled) return void await commandContext.reply('Fitur Character Guide belum aktif di server ini.')
          const active = await service.getActive(group, actor)
          if (!active) return void await commandContext.reply('Kamu belum memiliki Character aktif.')
          const key = `${group}:${actor}`
          const confirmation = commandContext.args[0]?.toLowerCase() === 'confirm'
          if (!confirmation) {
            deleteConfirmations.set(key, Date.now() + GUIDE_CONFIRM_TTL_MS)
            await commandContext.reply('Character akan dinonaktifkan permanen. Ketik *!deletecharacter confirm* untuk melanjutkan.')
            return
          }
          const expiresAt = deleteConfirmations.get(key) ?? 0
          deleteConfirmations.delete(key)
          if (expiresAt <= Date.now()) return void await commandContext.reply('Konfirmasi sudah kedaluwarsa. Jalankan !deletecharacter lagi.')
          await service.retire(group, actor, active.characterId, 'owner_requested', commandContext.message.id)
          await commandContext.reply('Character sudah dinonaktifkan. Kamu sekarang dapat menggunakan !daftar di Grup Guide untuk membuat Character baru.')
        },
      })

      context.commands.register({
        name: 'guider',
        description: 'Lihat admin yang menjadi kontak Guide grup',
        category: 'your-character',
        hidden: true,
        menuOrder: 7,
        handler: async (commandContext) => {
          const group = groupJid(commandContext)
          if (!group) return void await commandContext.reply('Command ini hanya bisa digunakan di dalam grup.')
          const metadata = await whatsapp.getGroupMetadata(group)
          const guides = metadata.participants.filter((participant: WhatsAppGroupParticipant) => participant.role === 'admin' || participant.role === 'superadmin')
          if (guides.length === 0) return void await commandContext.reply('Belum ada guider yang terdaftar di grup ini.')
          await commandContext.reply(['*Daftar Guider:*', ...guides.map((guide) => `• @${guide.jid.split('@')[0]?.split(':')[0] ?? guide.jid}`)].join('\n'), {
            mentions: guides.map((guide) => guide.jid),
          })
        },
      })
    },
  }
}
