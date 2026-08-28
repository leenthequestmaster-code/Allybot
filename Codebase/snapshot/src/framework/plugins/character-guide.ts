import { createHash } from 'node:crypto'
import type {
  CommandContext,
  CoreMessage,
  Plugin,
  WhatsAppGroupParticipant,
  WhatsAppPort,
} from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid, isJid } from '../../platform/validation.js'
import {
  CharacterGuideService,
  CharacterGuideValidationError,
  type CharacterRegistrationSession,
  calculateTimeRp,
  formatTimeRp,
} from '../../services/character-guide-service.js'
import { extractCommandPayload, parseCharacterSheet } from '../../services/character-sheet-parser.js'
import { GroupContextService } from '../../services/group-context-service.js'

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

function cardCode(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 12).toUpperCase()
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
    'Panduan pengisian Character ID Card',
    'Isi bagian setelah tanda titik dua.',
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
    'Bold, italic, code mark, spasi berlebih, baris kosong, dan urutan field yang berbeda tetap dapat dibaca. Jangan mengisi Money, Membership, Rank, Level, atau Inventory karena nilainya diatur server.',
  ].join('\n')
}

function renderPrivateCharacterGuide(): string {
  return [
    'Your Character',
    'Command yang tersedia:',
    '!character — melihat Character aktif',
    '!deletechar — menonaktifkan Character dengan konfirmasi',
    '!daftar — memulai Character baru setelah tidak ada Character aktif',
    '!retry — mengulang session yang belum selesai',
    '!cancel — membatalkan session yang belum selesai',
    '!guider — melihat kontak guider di grup',
  ].join('\n')
}

function renderSimpleGuide(): string {
  return [
    'Cara mudahnya:',
    'Name adalah nama karakter.',
    'Gender adalah jenis kelamin karakter.',
    'Age adalah umur karakter.',
    'Birthday adalah tanggal lahir dalam kalender KAR.',
    'Race adalah ras karakter.',
    'Class adalah kelas atau keahlian utama.',
    'Element adalah elemen kekuatan.',
    'Will Of Path adalah Light, Dark, atau Neutral.',
    'Bagian lain boleh dikosongkan dengan tanda —.',
  ].join('\n')
}

function renderSaveUsage(prefix: string): string {
  return [
    `Format: ${prefix}savecharacter`,
    'Reply ID Card dengan command tersebut dan isi seluruh field di bawahnya.',
    `Contoh: ${prefix}savecharacter`,
  ].join('\n')
}

function renderParseIssues(issues: readonly { field?: string; message: string }[]): string {
  return [
    'Character Sheet belum disimpan.',
    'Perbaiki bagian berikut:',
    ...issues.slice(0, 8).map((item) => `- ${item.field ? `${item.field}: ` : ''}${item.message}`),
    '',
    'Silakan reply ulang ID Card dengan data yang sudah diperbaiki menggunakan !savecharacter.',
  ].join('\n')
}

function renderCharacter(record: Awaited<ReturnType<CharacterGuideService['getActive']>>): string {
  if (!record) return 'Kamu belum memiliki Character aktif. Gunakan !daftar di Grup Guide.'
  return [
    'Your Character',
    `Name: ${record.name}`,
    `Gender: ${record.gender}`,
    `Age: ${record.age}`,
    `Birthday: ${record.birthday}`,
    `Race: ${record.race}`,
    `Class: ${record.className}`,
    `Element: ${record.element}`,
    `Spirit: ${record.spirit ?? '—'}`,
    `Crew: ${record.crew ?? '—'}`,
    `Rank: ${record.rank}`,
    `Level: ${record.level}`,
    `Will Of Path: ${record.willOfPath}`,
    `Profession: ${record.profession ?? '—'}`,
    `Titles: ${record.titles.join(', ') || '—'}`,
    `Motto: ${record.motto ?? '—'}`,
    `Visual: ${record.visual ?? '—'}`,
    `Origin: ${record.origin ?? '—'}`,
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
    } catch {
      // Fall back to text when the native transport is unavailable or rejected.
    }
  }
  await whatsapp.sendText(remoteJid, `${body}\n\n${fallback}`)
}

function guideRequirement(context: CommandContext, mode: string): string | undefined {
  if (mode === 'guide') return undefined
  return `Command ini hanya dapat digunakan di Grup Guide. Mode grup saat ini: ${mode.toUpperCase()}.`
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
          } catch {
            context.logger.warn('character guide card issuance failed')
            try {
              await whatsapp.sendText(pending.groupJid, 'ID Card belum dapat diterbitkan sekarang. Coba lagi nanti atau gunakan !retry jika session lama bermasalah.')
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
            await whatsapp.sendText(ready.groupJid, 'Setelah selesai, reply ID Card tersebut dengan !savecharacter. Untuk melihat daftar guider, gunakan !guider.')
          } catch {
            onboarding.delete(key)
            context.logger.warn('character guide card delivery failed')
            try {
              await whatsapp.sendText(pending.groupJid, 'ID Card belum terkirim lengkap. Gunakan !retry untuk membatalkan session ini lalu mulai ulang.')
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
        for (const participant of participants) {
          const key = onboardingKey(event.groupJid, participant)
          if (onboarding.has(key)) continue
          const codeSeed = `${event.groupJid}:${canonicalJid(participant)}:${event.at}`
          onboarding.set(key, {
            cardCode: cardCode(codeSeed),
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
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup Guide.')
            return
          }
          if (!service.isEnabled) {
            await commandContext.reply('Character Guide belum diaktifkan pada server.')
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
            await commandContext.reply('Kamu masih memiliki Character aktif. Gunakan !character untuk melihatnya atau !deletecharacter jika ingin memulai ulang.')
            return
          }
          const existing = await service.getRegistration(group, actor)
          if (existing) {
            await commandContext.reply('Pendaftaranmu masih berjalan. Gunakan !savecharacter dengan reply ke ID Card yang sudah diterbitkan, atau !retry untuk memulai ulang.')
            return
          }
          const code = cardCode(commandContext.message.id)
          onboarding.set(onboardingKey(group, actor), { cardCode: code, groupJid: group, ownerJid: actor, stage: 'experience', createdAt: Date.now() })
          await whatsapp.sendText(group, 'Selamat datang di Grup Guide. Sebelum membuat karakter, pilih pengalamanmu bermain Roleplay.')
          await sendQuickReplies(whatsapp, group, 'Pilih salah satu:', [
            { id: 'guide-experience-veteran', title: 'Pernah' },
            { id: 'guide-experience-other-platform', title: 'Pernah dari platform lain' },
            { id: 'guide-experience-beginner', title: 'Ini pertama kali' },
          ], 'Balas dengan 1, 2, atau 3.')
        },
      })

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
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup Guide.')
            return
          }
          if (!service.isEnabled) {
            await commandContext.reply('Character Guide belum diaktifkan pada server.')
            return
          }
          const currentContext = await groupContext.get(group)
          const modeError = guideRequirement(commandContext, currentContext.mode)
          if (modeError) {
            await commandContext.reply(modeError)
            return
          }
          if (!commandContext.message.quotedText || !commandContext.message.quotedMessageId || !sameJid(commandContext.message.quotedSenderJid, commandContext.whatsapp.userJid)) {
            await commandContext.reply('Reply pesan Character ID Card dari Allybot, lalu kirim !savecharacter bersama data lengkapmu.')
            return
          }
          const code = parseCardCode(commandContext.message.quotedText)
          if (!code) {
            await commandContext.reply('Reply tersebut bukan Character ID Card yang diterbitkan Allybot.')
            return
          }
          const registration = await service.getRegistration(group, actor)
          if (!registration || registration.referenceKey !== service.createCardReference(group, actor, code)) {
            await commandContext.reply('Registration ID tidak cocok atau session pendaftaran sudah tidak aktif. Gunakan !retry di Grup Guide untuk memulai ulang.')
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
                await whatsapp.sendText(actor, 'Your Character\n\nCharacter Sheet berhasil didaftarkan. Gunakan !character untuk melihat profil dan !deletecharacter jika ingin memulai ulang.')
                await service.markDelivery(saved.deliveryId, 'sent')
              } catch {
                await service.markDelivery(saved.deliveryId, 'failed', 'private_delivery_failed')
                context.logger.warn({ group }, 'character guide private delivery failed')
              }
            }
          } catch (error) {
            if (error instanceof CharacterGuideValidationError) await commandContext.reply(error.message)
            else await commandContext.reply('Character Sheet belum dapat disimpan. Coba lagi nanti.')
          }
        },
      })

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
          if (!group || !actor) return void await commandContext.reply('Command ini hanya dapat digunakan di dalam grup Guide.')
          if (!service.isEnabled) return void await commandContext.reply('Character Guide belum diaktifkan pada server.')
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
          if (!group || !actor) return void await commandContext.reply('Command ini hanya dapat digunakan di dalam grup Guide.')
          if (!service.isEnabled) return void await commandContext.reply('Character Guide belum diaktifkan pada server.')
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
          if (!actor) return void await commandContext.reply('Identitas user tidak tersedia.')
          if (!service.isEnabled) return void await commandContext.reply('Character Guide belum diaktifkan pada server.')
          const record = group ? await service.getActive(group, actor) : await service.getActiveForOwner(actor)
          await commandContext.reply(renderCharacter(record))
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

      context.commands.register({
        name: 'timerp',
        aliases: ['timerp', 'rpwaktu'],
        description: 'Lihat waktu RP Allyssea saat ini',
        category: 'your-character',
        menuOrder: 8,
        handler: async (commandContext) => {
          const result = calculateTimeRp()
          await commandContext.reply(formatTimeRp(result))
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
          if (!group || !actor) return void await commandContext.reply('Command Character hanya dapat digunakan di dalam grup.')
          if (!service.isEnabled) return void await commandContext.reply('Character Guide belum diaktifkan pada server.')
          const active = await service.getActive(group, actor)
          if (!active) return void await commandContext.reply('Kamu belum memiliki Character aktif.')
          const key = `${group}:${actor}`
          const confirmation = commandContext.args[0]?.toLowerCase() === 'confirm'
          if (!confirmation) {
            deleteConfirmations.set(key, Date.now() + GUIDE_CONFIRM_TTL_MS)
            await commandContext.reply('Character akan dinonaktifkan dan tidak dapat digunakan sebagai Character aktif. Gunakan !deletecharacter confirm untuk melanjutkan.')
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
        menuOrder: 7,
        handler: async (commandContext) => {
          const group = groupJid(commandContext)
          if (!group) return void await commandContext.reply('Command ini hanya dapat digunakan di dalam grup.')
          const metadata = await whatsapp.getGroupMetadata(group)
          const guides = metadata.participants.filter((participant: WhatsAppGroupParticipant) => participant.role === 'admin' || participant.role === 'superadmin')
          if (guides.length === 0) return void await commandContext.reply('Belum ada guider yang dapat ditampilkan.')
          await commandContext.reply(['Daftar Guider', ...guides.map((guide) => `- @${guide.jid.split('@')[0]?.split(':')[0] ?? guide.jid}`)].join('\n'), {
            mentions: guides.map((guide) => guide.jid),
          })
        },
      })
    },
  }
}
