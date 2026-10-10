import type { CommandContext, Plugin } from '../contracts.js'
import { isGroupJid } from '../validation.js'
import {
  AiHandlerError,
  createAiHandler,
  type AiTransport,
} from '../../ai-handler.js'
import type { ChatHistoryService } from '../../services/chat-history-service.js'

const REKAP_COMMAND_COOLDOWN_MS = 20_000

const REKAP_SYSTEM_PROMPT = [
  'Kamu adalah asisten perangkum obrolan WhatsApp yang objektif, ringkas, dan cerdas.',
  'Tugasmu: Menganalisis transkrip obrolan grup dan menghasilkan ringkasan yang padat, akurat, dan mudah dibaca.',
  'PEDOMAN PENTING:',
  '1. HINDARI AI SLOP: Dilarang menggunakan kalimat pembuka atau penutup basa-basi (seperti "Halo semuanya", "Tentu, ini rekapnya", "Semoga bermanfaat", "Grup terlihat sangat aktif"). Langsung tuliskan isi rekap.',
  '2. MINIMAL EMOJI: Gunakan format teks rapi dengan bullet (•) atau nomor. Jangan gunakan banyak emoji hiasan berlebihan.',
  '3. BAHASA: Gunakan bahasa Indonesia yang wajar, komunikatif, dan ringkas. Pahami singkatan dan bahasa gaul obrolan Indonesia (misal: otw, ywdh, bntr, mabar, gajelas, dll).',
  '4. AKURAT & BEBAS HALUSINASI: Hanya rangkum apa yang benar-benar tertulis dalam transkrip. Jangan mengarang topik atau orang yang tidak ada.',
  '5. FORMAT KELUARAN YANG WAJIB DIIKUTI:',
  '*Topik Utama:*',
  '1. [Nama Topik]: [Ringkasan 1-2 kalimat]',
  '2. [Nama Topik]: [Ringkasan 1-2 kalimat]',
  '',
  '*Poin Penting:*',
  '• [Kesepakatan, rencana, atau info penting jika ada; jika tidak ada, tulis "Tidak ada keputusan khusus."]',
  '',
  '*Sorotan:*',
  '• [Kutipan atau momen percakapan menarik jika ada]',
].join(' ')

function safeFailureMessage(error: unknown): string {
  if (error instanceof AiHandlerError && error.code === 'missing_api_key') {
    return 'Fitur AI belum dikonfigurasi, hubungi pengurus bot ya.'
  }
  return 'Lagi pusing nih, coba beberapa saat lagi ya~ 🤖🙏'
}

export interface RekapPluginOptions {
  readonly transport?: AiTransport
  readonly fallbackEnabled?: boolean
}

export function createRekapPlugin(whatsapp: any, options: RekapPluginOptions = {}): Plugin {
  return {
    name: 'rekap-commands',
    version: '0.1.0',
    load(context) {
      const getChatHistory = (): ChatHistoryService =>
        context.services.get<ChatHistoryService>('chat-history')

      const aiHandler = createAiHandler({
        transport: options.transport,
        logger: context.logger,
        fallbackEnabled: options.fallbackEnabled,
        systemPrompt: REKAP_SYSTEM_PROMPT,
        maxInputLength: 25_000,
        preserveNewlines: true,
      })

      context.commands.register({
        name: 'rekap',
        aliases: ['summary', 'rangkum', 'tldr'],
        description: 'Rangkum obrolan terkini di grup dengan AI',
        category: 'tools',
        menuOrder: 2,
        cooldownMs: REKAP_COMMAND_COOLDOWN_MS,
        handler: async (commandContext: CommandContext) => {
          if (!isGroupJid(commandContext.message.remoteJid)) {
            await commandContext.reply('Perintah rekap hanya dapat digunakan di dalam obrolan grup.')
            return
          }

          const argNum = parseInt(commandContext.args[0] ?? '30', 10)
          const count = Number.isInteger(argNum) ? Math.min(Math.max(argNum, 10), 100) : 30

          const chatHistoryService = getChatHistory()
          const messages = await chatHistoryService.getRecentMessages(commandContext.message.remoteJid, count)

          if (messages.length < 5) {
            await commandContext.reply(
              `Obrolan belum cukup untuk dirangkum (saat ini baru ${messages.length} pesan, minimal butuh 5 pesan teks). Mengobrol dulu yuk!`,
            )
            return
          }

          const firstMsg = messages[0]!
          const lastMsg = messages[messages.length - 1]!

          const firstTime = new Date(firstMsg.timestamp).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Jakarta',
          })
          const lastTime = new Date(lastMsg.timestamp).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Jakarta',
          })

          const participants = [...new Set(messages.map((m) => m.pushName))]

          const transcript = messages
            .map((m) => `${m.pushName}: ${m.text}`)
            .join('\n')

          const prompt = `Berikut adalah transkrip ${messages.length} pesan obrolan grup WhatsApp:\n\n${transcript}\n\nBuat ringkasan sesuai panduan sistem.`

          try {
            const summary = await aiHandler(prompt)

            const formatted = [
              '𓏼 *`𝐀𝐥𝐥𝘆𝗯𝗼𝘁 𝐑𝗲𝗸𝗮𝗽`*',
              '────────────────────────',
              `• Periode    : ${messages.length} pesan (${firstTime} - ${lastTime} WIB)`,
              `• Partisipan : ${participants.length} anggota (${participants.slice(0, 4).join(', ')}${participants.length > 4 ? '...' : ''})`,
              '────────────────────────',
              summary.trim(),
              '────────────────────────',
              '*© Allyssea Roleplay Community*',
            ].join('\n')

            await commandContext.reply(formatted)
          } catch (error) {
            commandContext.logger.warn(
              { errorName: error instanceof Error ? error.name : 'UnknownError' },
              'rekap summarization failed',
            )
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })
    },
  }
}
