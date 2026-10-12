/**
 * Downloader plugin: registers !dl, !sc, !yts, !dlstats, !bypass commands.
 * @module framework/plugins/downloader
 */

import type { Logger } from 'pino'
import type {
  CommandContext,
  Plugin,
  PluginContext,
} from '../contracts.js'
import { DownloaderService } from '../../services/downloader-service.js'
import { deliverMedia, MAX_CAROUSEL_ITEMS } from '../../services/downloader/deliver.js'
import { CircuitOpenError, detectPlatform, resolveBypass } from '../../services/downloader/index.js'
import { scrapeTeraBox } from '../../services/downloader/scrapr-core/terabox.js'
import type { SearchResult } from '../../services/downloader/types.js'
import type { QuotaService } from '../../services/quota-service.js'

/* ── Error messages (Indonesian, casual) ── */

const MSG = {
  PLATFORM_UNSUPPORTED: '❌ Platform nggak didukung. Support: IG, FB, X/Twitter (!tw), Threads, Reddit, Pinterest, MediaFire, Sfile, SC, Videy, Pixeldrain.',
  RESOLVE_FAILED: '❌ Gagal ambil media. Pastikan kontennya publik ya~',
  TIMEOUT: '⏱ Timeout. Coba lagi nanti~',
  CIRCUIT_OPEN: (platform: string) => `⏳ ${platform} lagi sibuk. Coba 30 menit lagi~`,
  NO_URL: '❌ Kirim URL setelah command. Contoh: !dl https://instagram.com/p/xxx',
  MULTI_URL: '❌ Satu URL aja ya~',
  SHORT_URL: '❌ Short URL (bit.ly dll) bisa dibuka lewat command !bypass <url> ya~',
  WRONG_PLATFORM: (expected: string) => `❌ URL itu bukan ${expected}. Pakai !dl aja biar otomatis~`,
  CAROUSEL_LIMIT: (total: number) => `ℹ️ Mengirim ${MAX_CAROUSEL_ITEMS} dari ${total} media. Sisanya nggak dikirim ya~`,
  NO_RESULTS: '😢 Nggak ketemu hasil pencarian.',
  SEARCH_QUERY_MISSING: '❌ Tulis kata kunci pencarian. Contoh: !yts lofi hip hop',
  NO_RECIPIENT: '❌ Sedang memproses, coba lagi dalam beberapa detik~',
} as const

/* ── Helpers ── */

const URL_REGEX = /https?:\/\/[^\s]+/gi
const SHORT_URL_REGEX = /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|v\.gd|ow\.ly|buff\.ly|dub\.sh)(?:\/|$)/i

/** Map command alias → expected platform for validation */
const ALIAS_PLATFORM_MAP: Record<string, string> = {
  ig: 'instagram',
  fb: 'facebook',
  tw: 'twitter',
  threads: 'threads',
  th: 'threads',
  reddit: 'reddit',
  mf: 'mediafire',
  sfile: 'sfile',
  videy: 'videy',
  pd: 'pixeldrain',
}

function extractUrl(args: readonly string[]): string | null {
  const text = args.join(' ')
  const matches = text.match(URL_REGEX)
  if (!matches || matches.length === 0) {
    const joined = args.join(' ').trim()
    if (joined && /^[\w.-]+\.\w+\//.test(joined)) {
      return `https://${joined}`
    }
    return null
  }
  return matches[0]
}

function hasMultipleUrls(args: readonly string[]): boolean {
  const text = args.join(' ')
  const matches = text.match(URL_REGEX)
  if (matches && matches.length > 1) return true

  const bareDomains = text.match(/(^|\s)(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi)
  return !!bareDomains && bareDomains.length > 1
}

function formatSearchResults(results: SearchResult[], platform: string): string {
  if (results.length === 0) return MSG.NO_RESULTS

  const lines = results.map((r, i) => {
    const parts = [`${i + 1}. *${r.title}*`]
    if (r.channel) parts.push(`   📺 ${r.channel}`)
    if (r.duration) parts.push(`   ⏱ ${r.duration}`)
    if (r.url) parts.push(`   🔗 ${r.url}`)
    return parts.join('\n')
  })

  const header = platform === 'youtube' ? '🔍 *Hasil Pencarian YouTube:*' : '🔍 *Hasil Pencarian SoundCloud:*'
  return `${header}\n\n${lines.join('\n\n')}`
}

/* ── Plugin ── */

export const downloaderPlugin: Plugin = {
  name: 'downloader' as const,
  version: '0.2.0' as const,
  dependencies: ['menu'] as const,

  async load(context: PluginContext): Promise<void> {
    const logger = context.logger.child({ plugin: 'downloader' })
    const downloaderService = context.services.get<DownloaderService>("downloader")

    /* ── !dl command ── */
    context.commands.register({
      name: 'dl',
      aliases: ['ig', 'fb', 'tw', 'threads', 'th', 'reddit', 'mf', 'sfile', 'videy', 'pd'],
      description: 'Download media dari Instagram, TikTok, Douyin, Bilibili, RedNote, Bandcamp, Facebook, Twitter, Threads, Reddit, Pinterest, MediaFire, atau Sfile.',
      category: 'media',
      menuOrder: 10,
      cooldownMs: 10_000,

      validate(ctx: CommandContext): string | undefined {
        if (ctx.args.length === 0) return MSG.NO_URL
        if (hasMultipleUrls(ctx.args)) return MSG.MULTI_URL
        return undefined
      },

      async handler(ctx: CommandContext): Promise<void> {
        let url = extractUrl(ctx.args)

        if (!url) {
          const rawInput = ctx.args.join(' ').trim()
          if (rawInput && /[\w.-]+\.\w+/.test(rawInput)) {
            url = `https://${rawInput}`
          } else {
            await ctx.reply(MSG.NO_URL)
            return
          }
        }

        if (SHORT_URL_REGEX.test(url)) {
          await ctx.reply(MSG.SHORT_URL)
          return
        }

        const adapter = detectPlatform(url)

        const expectedPlatform = ALIAS_PLATFORM_MAP[ctx.commandName]
        if (expectedPlatform) {
          if (!adapter || adapter.name !== expectedPlatform) {
            await ctx.reply(MSG.WRONG_PLATFORM(expectedPlatform))
            return
          }
        }

        if (!adapter) {
          await ctx.reply(MSG.PLATFORM_UNSUPPORTED)
          return
        }

        const remoteJid = ctx.message.remoteJid
        if (!remoteJid) {
          await ctx.reply(MSG.NO_RECIPIENT)
          return
        }

        const quotaService = ctx.services.has('quota')
          ? ctx.services.get<QuotaService>('quota')
          : undefined
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const reservation = quotaService?.reserveQuota(senderJid, 'downloader')
        if (reservation && !reservation.ok) {
          await ctx.reply(`Limit harian download kamu sudah habis (0/${reservation.limit}). Donasi seikhlasnya via !donasi untuk menaikkan limit hingga 50x/hari seumur hidup!`)
          return
        }

        await ctx.react('⏳')

        try {
          const result = await downloaderService.resolve(url)

          if (result.type === 'carousel' && result.media.length > MAX_CAROUSEL_ITEMS) {
            await ctx.reply(MSG.CAROUSEL_LIMIT(result.media.length))
          }

          await deliverMedia(ctx.whatsapp, remoteJid, result, ctx.logger)
          quotaService?.commitQuota(senderJid, 'downloader')
          await ctx.react('✅')
        } catch (err) {
          quotaService?.refundQuota(senderJid, 'downloader')
          if (err instanceof CircuitOpenError) {
            await ctx.reply(MSG.CIRCUIT_OPEN(adapter.name))
            await ctx.react('❌')
            return
          }

          const errMsg = err instanceof Error ? err.message : String(err)

          if (errMsg === 'PLATFORM_UNSUPPORTED') {
            await ctx.reply(MSG.PLATFORM_UNSUPPORTED)
          } else if (/timeout|abort/i.test(errMsg)) {
            await ctx.reply(MSG.TIMEOUT)
          } else {
            logger.warn({ err, url }, 'dl: resolve failed')
            await ctx.reply(MSG.RESOLVE_FAILED)
          }
          await ctx.react('❌')
        }
      },
    })

    /* ── !bypass / !unshort command ── */
    context.commands.register({
      name: 'bypass',
      aliases: ['unshort', 'openlink'],
      description: 'Bypass shortlink atau unshorten URL (bit.ly, dub.sh, sfl.gl, sub2unlock, rekonise)',
      category: 'media',
      menuOrder: 13,
      cooldownMs: 5_000,

      validate(ctx: CommandContext): string | undefined {
        if (ctx.args.length === 0) return '❌ Masukkan link yang mau di-bypass. Contoh: !bypass https://bit.ly/xxxx'
        return undefined
      },

      async handler(ctx: CommandContext): Promise<void> {
        const rawUrl = extractUrl(ctx.args)
        if (!rawUrl) {
          await ctx.reply('❌ URL tidak valid. Pastikan format link benar ya~')
          return
        }

        await ctx.react('🔍')

        try {
          const res = await resolveBypass(rawUrl)
          const lines: string[] = [
            '🔓 *Hasil Bypass Link:*',
            `🔗 *Original:* ${res.originalUrl}`,
            `🎯 *Tujuan:* ${res.destinationUrl}`,
          ]

          if (res.hops.length > 2) {
            lines.push(`🔀 *Redirect Hops:* ${res.hops.length - 1} kali`)
          }

          if (res.directFile) {
            lines.push('\n📦 *Direct File Terdeteksi:*')
            lines.push(`• *Nama:* ${res.directFile.filename}`)
            lines.push(`• *Ukuran:* ${res.directFile.size}`)
            lines.push(`• *Link Unduh:* ${res.directFile.url}`)
          }

          await ctx.reply(lines.join('\n'))
          await ctx.react('✅')
        } catch (err) {
          logger.warn({ err, rawUrl }, 'bypass: failed')
          await ctx.reply('❌ Gagal mem-bypass link. Link mungkin kedaluwarsa atau server menolak request.')
          await ctx.react('❌')
        }
      },
    })

    /* ── !terabox command ── */
    context.commands.register({
      name: 'terabox',
      aliases: ['tb'],
      description: 'Ekstrak file atau stream video dari TeraBox',
      category: 'media',
      menuOrder: 14,
      cooldownMs: 10_000,

      validate(ctx: CommandContext): string | undefined {
        if (ctx.args.length === 0) return '❌ Masukkan link TeraBox. Contoh: !terabox https://terabox.app/s/xxxx'
        return undefined
      },

      async handler(ctx: CommandContext): Promise<void> {
        const rawUrl = extractUrl(ctx.args)
        if (!rawUrl) {
          await ctx.reply('❌ Link TeraBox tidak valid.')
          return
        }

        await ctx.react('🔍')

        try {
          const res = await scrapeTeraBox(rawUrl)
          if (!res.downloads || res.downloads.length === 0) {
            await ctx.react('❌')
            await ctx.reply('❌ Tidak ada file yang ditemukan pada folder/link TeraBox ini.')
            return
          }

          let msg = `📦 *TeraBox File Extractor*\n`
          msg += `📌 *Folder/Judul:* ${res.title}\n`
          msg += `📁 *Total File:* ${res.downloads.length}\n\n`

          for (let i = 0; i < res.downloads.length; i++) {
            const item = res.downloads[i]
            const typeEmoji = item.type === 'video' ? '🎬' : '📄'
            msg += `${i + 1}. ${typeEmoji} *${item.filename}* (${item.size})\n`
            msg += `⚡ *Direct Link:* ${item.url}\n\n`
          }

          msg += `_Catatan: Langsung unduh atau streaming via direct link di atas._`

          await ctx.reply(msg)
          await ctx.react('✅')
        } catch (err) {
          logger.warn({ err, rawUrl }, 'terabox: failed')
          await ctx.reply('❌ Gagal mengekstrak TeraBox. Server TeraBox menolak atau link kadaluarsa.')
          await ctx.react('❌')
        }
      },
    })

    /* ── !sc command ── */
    context.commands.register({
      name: 'sc',
      description: 'SoundCloud: download track atau cari musik',
      category: 'media',
      menuOrder: 11,
      cooldownMs: 10_000,

      validate(ctx: CommandContext): string | undefined {
        if (ctx.args.length === 0) return MSG.SEARCH_QUERY_MISSING
        return undefined
      },

      async handler(ctx: CommandContext): Promise<void> {
        const url = extractUrl(ctx.args)
        const remoteJid = ctx.message.remoteJid
        if (!remoteJid) {
          await ctx.reply(MSG.NO_RECIPIENT)
          return
        }

        let isSoundCloud = false
        if (url) {
          try {
            const parsed = new URL(url)
            isSoundCloud = /(^|\.)soundcloud\.com$/i.test(parsed.hostname)
          } catch {
            isSoundCloud = false
          }
        }

        if (url && isSoundCloud) {
          await ctx.react('⏳')
          try {
            const result = await downloaderService.resolveWith('soundcloud', url)
            await deliverMedia(ctx.whatsapp, remoteJid, result, ctx.logger)
            await ctx.react('✅')
          } catch (err) {
            if (err instanceof CircuitOpenError) {
              await ctx.reply(MSG.CIRCUIT_OPEN('SoundCloud'))
              await ctx.react('❌')
              return
            }
            logger.warn({ err, url }, 'sc: download failed')
            await ctx.reply(MSG.RESOLVE_FAILED)
            await ctx.react('❌')
          }
        } else {
          const query = ctx.args.join(' ')
          await ctx.react('🔍')
          try {
            const results = await downloaderService.searchSoundCloud(query)
            const text = formatSearchResults(results, 'soundcloud')
            await ctx.reply(text)
          } catch (err) {
            logger.warn({ err, query }, 'sc: search failed')
            await ctx.reply(MSG.RESOLVE_FAILED)
            await ctx.react('❌')
          }
        }
      },
    })

    /* ── !yts command ── */
    context.commands.register({
      name: 'yts',
      description: 'Cari video YouTube (tanpa download)',
      category: 'media',
      menuOrder: 12,
      cooldownMs: 5_000,

      validate(ctx: CommandContext): string | undefined {
        if (ctx.args.length === 0) return MSG.SEARCH_QUERY_MISSING
        return undefined
      },

      async handler(ctx: CommandContext): Promise<void> {
        const query = ctx.args.join(' ')
        await ctx.react('🔍')
        try {
          const results = await downloaderService.searchYouTube(query)
          const text = formatSearchResults(results, 'youtube')
          await ctx.reply(text)
        } catch (err) {
          logger.warn({ err, query }, 'yts: search failed')
          await ctx.reply(MSG.RESOLVE_FAILED)
          await ctx.react('❌')
        }
      },
    })

    /* ── !dlstats command ── */
    context.commands.register({
      name: 'dlstats',
      description: 'Downloader metrics & circuit states',
      category: 'admin',
      hidden: true,
      permission: 'developer',
      cooldownMs: 3_000,

      async handler(ctx: CommandContext): Promise<void> {
        try {
          const metrics = downloaderService.getMetrics() ?? {}
          const circuits = downloaderService.getCircuitStates() ?? {}
          const cacheStats = downloaderService.cache?.stats ? await downloaderService.cache.stats() : null

          const lines: string[] = ['📊 *Downloader Stats*\n']

          for (const [name, m] of Object.entries(metrics)) {
            lines.push(
              `*${name}*: ${m.total} total (✅ ${m.success} / ❌ ${m.fail}) avg ${m.avgLatencyMs}ms`,
            )
            if (m.lastError) {
              lines.push(`  └ Last error: ${m.lastError}`)
            }
          }

          lines.push('\n⚡ *Circuit Breakers*')
          for (const [name, s] of Object.entries(circuits)) {
            const icon = s.state === 'closed' ? '🟢' : s.state === 'open' ? '🔴' : '🟡'
            lines.push(`${icon} ${name}: ${s.state} (${s.failures} failures)`)
          }

          lines.push('\n💾 *Cache*')
          if (cacheStats) {
            lines.push(`Metadata: ${cacheStats.metadataEntries ?? 0} entries`)
            const bytes = cacheStats.fileSizeBytes ?? 0
            lines.push(`Files: ${cacheStats.fileCount ?? 0} (${Math.round(bytes / 1024 / 1024)}MB)`)
          } else {
            lines.push('Cache tidak tersedia')
          }

          await ctx.reply(lines.join('\n'))
        } catch (err) {
          logger.warn({ err }, 'dlstats: failed to gather stats')
          await ctx.reply('❌ Gagal ambil statistik downloader.')
        }
      },
    })

    logger.info('Downloader plugin loaded: !dl, !bypass, !terabox, !sc, !yts, !dlstats')
  },

  async initialize(_context: PluginContext): Promise<void> {},
  async unload(context: PluginContext): Promise<void> {},
}
