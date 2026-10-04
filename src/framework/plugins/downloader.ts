/**
 * Downloader plugin: registers !dl, !sc, !yts, !dlstats commands.
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
import { CircuitOpenError, detectPlatform } from '../../services/downloader/index.js'
import type { SearchResult } from '../../services/downloader/types.js'

/* ── Error messages (Indonesian, casual) ── */

const MSG = {
  PLATFORM_UNSUPPORTED: '❌ Platform nggak didukung. Support: IG, FB, X/Twitter (!tw), Threads, SC, Videy, Pixeldrain.',
  RESOLVE_FAILED: '❌ Gagal ambil media. Pastikan kontennya publik ya~',
  TIMEOUT: '⏱ Timeout. Coba lagi nanti~',
  CIRCUIT_OPEN: (platform: string) => `⏳ ${platform} lagi sibuk. Coba 30 menit lagi~`,
  NO_URL: '❌ Kirim URL setelah command. Contoh: !dl https://instagram.com/p/xxx',
  MULTI_URL: '❌ Satu URL aja ya~',
  SHORT_URL: '❌ Short URL (bit.ly dll) nggak didukung. Pakai URL asli ya~',
  WRONG_PLATFORM: (expected: string) => `❌ URL itu bukan ${expected}. Pakai !dl aja biar otomatis~`,
  CAROUSEL_LIMIT: (total: number) => `ℹ️ Mengirim ${MAX_CAROUSEL_ITEMS} dari ${total} media. Sisanya nggak dikirim ya~`,
  NO_RESULTS: '😢 Nggak ketemu hasil pencarian.',
  SEARCH_QUERY_MISSING: '❌ Tulis kata kunci pencarian. Contoh: !yts lofi hip hop',
  NO_RECIPIENT: '❌ Sedang memproses, coba lagi dalam beberapa detik~',
  FB_NEEDS_LOGIN: '⚠️ Video Facebook butuh akun yang login buat diambil. Link grup/private/share tanpa cookie nggak bisa~ Coba URL video halaman publik, atau kirim link videonya.',
} as const

/* ── Helpers ── */

const URL_REGEX = /https?:\/\/[^\s]+/gi
const SHORT_URL_REGEX = /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|v\.gd|ow\.ly|buff\.ly)(?:\/|$)/i

/** Map command alias → expected platform for validation (X/Twitter via !tw, karena !x milik mockup card) */
const ALIAS_PLATFORM_MAP: Record<string, string> = {
  ig: 'instagram',
  fb: 'facebook',
  tw: 'twitter',
  threads: 'threads',
  th: 'threads',
  videy: 'videy',
  pd: 'pixeldrain',
}

function extractUrl(args: readonly string[]): string | null {
  const text = args.join(' ')
  const matches = text.match(URL_REGEX)
  if (!matches || matches.length === 0) {
    // Try without protocol
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

  // Protocol-less multi-domain: !dl example.com/a example.com/b → ambil kandidat domain
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
  version: '0.1.0' as const,
  dependencies: ['menu'] as const,

  async load(context: PluginContext): Promise<void> {
    const logger = context.logger.child({ plugin: 'downloader' })
    const downloaderService = context.services.get<DownloaderService>("downloader")


    /* ── !dl command ── */
    context.commands.register({
      name: 'dl',
      aliases: ['ig', 'fb', 'tw', 'threads', 'th', 'videy', 'pd'],
      description: 'Download media dari URL (IG, FB, X/Twitter, Threads, SC, Videy, Pixeldrain)',
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

        // If no URL found, try treating full args as URL without protocol
        if (!url) {
          const rawInput = ctx.args.join(' ').trim()
          if (rawInput && /[\w.-]+\.\w+/.test(rawInput)) {
            url = `https://${rawInput}`
          } else {
            await ctx.reply(MSG.NO_URL)
            return
          }
        }

        // Reject short URLs
        if (SHORT_URL_REGEX.test(url)) {
          await ctx.reply(MSG.SHORT_URL)
          return
        }

        const adapter = detectPlatform(url)

        // If invoked via platform alias, validate URL matches
        const expectedPlatform = ALIAS_PLATFORM_MAP[ctx.commandName]
        if (expectedPlatform) {
          if (!adapter || adapter.name !== expectedPlatform) {
            await ctx.reply(MSG.WRONG_PLATFORM(expectedPlatform))
            return
          }
        }

        // Check platform support
        if (!adapter) {
          await ctx.reply(MSG.PLATFORM_UNSUPPORTED)
          return
        }

        const remoteJid = ctx.message.remoteJid
        if (!remoteJid) {
          await ctx.reply(MSG.NO_RECIPIENT)
          return
        }

        await ctx.react('⏳')

        try {
          const result = await downloaderService.resolve(url)

          // Warn about carousel limit
          if (result.type === 'carousel' && result.media.length > MAX_CAROUSEL_ITEMS) {
            await ctx.reply(MSG.CAROUSEL_LIMIT(result.media.length))
          }

          await deliverMedia(ctx.whatsapp, remoteJid, result, ctx.logger)
          await ctx.react('✅')
        } catch (err) {
          if (err instanceof CircuitOpenError) {
            await ctx.reply(MSG.CIRCUIT_OPEN(adapter.name))
            await ctx.react('❌')
            return
          }

          const errMsg = err instanceof Error ? err.message : String(err)

          // Facebook: bedakan kebutuhan login/cookie dari kegagalan umum
          const isFacebook = adapter.name === 'facebook'
          if (isFacebook && /(Unable to fetch|licensed|login required|not available|page .* content|\bcookie\b|session)/i.test(errMsg)) {
            await ctx.reply(MSG.FB_NEEDS_LOGIN)
          } else if (errMsg === 'PLATFORM_UNSUPPORTED') {
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

        // Exact hostname check, bukan substring: cegah SSRF via soundcloud.com.evil.com
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
          // Download mode
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
          // Search mode
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

    /* ── !dlstats command (hidden, developer only) ── */
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

          // Metrics per adapter
          for (const [name, m] of Object.entries(metrics)) {
            lines.push(
              `*${name}*: ${m.total} total (✅ ${m.success} / ❌ ${m.fail}) avg ${m.avgLatencyMs}ms`,
            )
            if (m.lastError) {
              lines.push(`  └ Last error: ${m.lastError}`)
            }
          }

          // Circuit states
          lines.push('\n⚡ *Circuit Breakers*')
          for (const [name, s] of Object.entries(circuits)) {
            const icon = s.state === 'closed' ? '🟢' : s.state === 'open' ? '🔴' : '🟡'
            lines.push(`${icon} ${name}: ${s.state} (${s.failures} failures)`)
          }

          // Cache
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

    logger.info('Downloader plugin loaded: !dl, !sc, !yts, !dlstats')
  },

  async initialize(_context: PluginContext): Promise<void> {
    // Service initialization handled by framework
  },

  async unload(context: PluginContext): Promise<void> {
    // Cache cleanup handled by service shutdown lifecycle
  },
}
