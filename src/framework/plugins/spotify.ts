import type { Plugin, PluginContext, CommandContext } from '../contracts.js'
import { statSync, readFileSync, unlinkSync, copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { loadConfig } from '../../services/music-config.js'
import { getTier } from '../../services/music-tiers.js'
import { checkCooldown, markCall } from '../../services/music-cooldown.js'
import { checkQuota, consumeQuota, restoreLimits, startRolloverInterval } from '../../services/music-limiter.js'
import { runOnce, stats as queueStats } from '../../services/music-queue.js'
import { initMusic, searchAndDownload, MusicError } from '../../services/music-service.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function formatBytes(b: number): string {
  if (b > 1073741824) return `${(b / 1073741824).toFixed(1)} GB`
  if (b > 1048576) return `${(b / 1048576).toFixed(1)} MB`
  return `${Math.round(b / 1024)} KB`
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

async function getDirSize(dir: string): Promise<number> {
  const { readdir } = await import('fs/promises')
  let total = 0
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      try {
        total += statSync(resolve(dir, name)).size
      } catch {
        //
      }
    }
  } catch {
    //
  }
  return total
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const spotifyPlugin: Plugin = {
  name: 'spotify',
  version: '4.0.0',

  async load(context: PluginContext) {
    const logger = context.logger

    let config = loadConfig()
    restoreLimits()
    startRolloverInterval(config)
    await initMusic(config)

    // ── !spotify / !play / !lagu ───────────────────────────────────────────
    context.commands.register({
      name: 'spotify',
      aliases: ['play', 'lagu'],
      description: 'Download lagu MP3 + lirik. Contoh: !play duka last child',
      category: 'tools',
      menuOrder: 10,

      handler: async (ctx: CommandContext) => {
        config = loadConfig()

        const query = ctx.args.join(' ').trim()
        if (!query) {
          await ctx.reply('Kirim judul lagunya. Contoh: !play duka last child')
          return
        }

        const remoteJid = ctx.message.remoteJid
        const senderJid = ctx.message.senderJid ?? remoteJid
        const isGroup = isGroupJid(remoteJid)
        const tier = getTier(senderJid, isGroup ? remoteJid : undefined, config)

        // Cooldown
        const cooldown = checkCooldown(remoteJid, isGroup, tier, config)
        if (!cooldown.ok) {
          const secs = Math.ceil(cooldown.remaining / 1000)
          await ctx.reply(`Tunggu ${secs}s lagi.`)
          return
        }

        // Quota
        const quotaInfo = checkQuota(senderJid, tier, config)
        if (!quotaInfo.ok) {
          await ctx.reply(`Jatah download kamu hari ini udah habis (${quotaInfo.used}/${quotaInfo.quota} lagu). Coba lagi besok ya, reset otomatis tengah malam WIB.`)
          return
        }

        await ctx.react('⏳')

        const t0 = Date.now()
        let tmpPath: string | null = null
        let statusSent = false

        try {
          const result = await runOnce(
            `music:${query.toLowerCase()}`,
            () => searchAndDownload(query, tier, config),
            config,
          )

          statusSent = true

          // Copy ke /tmp sebelum kirim (cache file immutable)
          const tmpDir = '/tmp/allybot-music'
          mkdirSync(tmpDir, { recursive: true })
          tmpPath = resolve(tmpDir, `${randomUUID()}.mp3`)
          copyFileSync(result.filePath, tmpPath)

          // Kirim audio
          const audioData = readFileSync(tmpPath)
          if (!ctx.whatsapp.sendMedia) {
            throw new Error('sendMedia not available on this WhatsApp adapter')
          }
          await ctx.whatsapp.sendMedia(remoteJid, {
            kind: 'audio',
            data: new Uint8Array(audioData),
            mimeType: 'audio/mpeg',
            fileName: `${result.artist} - ${result.trackName}.mp3`,
          })

          // Caption metadata
          const elapsed = Date.now() - t0
          const quotaAfter = checkQuota(senderJid, tier, config)
          const quotaDisplay = quotaAfter.quota === 999999 ? '∞' : String(quotaAfter.quota)
          const caption =
            `*${result.trackName}*\n` +
            `${result.artist} · ${result.album}\n` +
            `${formatMs(result.durationMs)} · ${formatMs(elapsed)} · ${quotaAfter.used + 1}/${quotaDisplay}`

          await ctx.reply(caption)

          // Lirik dikirim sebagai pesan terpisah agar tidak terpotong
          if (result.lyrics) {
            await ctx.reply(result.lyrics)
          }

          consumeQuota(senderJid, config)
          markCall(remoteJid)
          await ctx.react('✅')

        } catch (e) {
          let errMsg = 'Gagal. Coba lagi nanti.'

          if (e instanceof MusicError) {
            switch (e.code) {
              case 'NOT_FOUND':
                errMsg = `Lagu "${query}" tidak ditemukan.`
                break
              case 'ARL_EXPIRED':
                errMsg = 'Deezer session expired, tunggu admin update.'
                break
              case 'REGION_LOCKED':
                errMsg = 'Lagu ini tidak tersedia di region server.'
                break
              case 'CIRCUIT_OPEN':
                errMsg = 'Deezer sedang tidak bisa diakses. Coba lagi nanti.'
                break
              case 'DOWNLOAD_FAILED':
                errMsg = 'Gagal download audio. Coba judul lain.'
                break
            }
          }

          logger.error({ err: e, query }, 'music pipeline error')
          await ctx.react('❌')
          await ctx.reply(errMsg)
          markCall(remoteJid)

        } finally {
          if (tmpPath) {
            try { unlinkSync(tmpPath) } catch { /* best effort */ }
          }
        }
      },
    })

    // ── !musicstats (owner only) ───────────────────────────────────────────
    context.commands.register({
      name: 'musicstats',
      description: 'Statistik music plugin (owner only)',
      category: 'tools',
      hidden: true,

      handler: async (ctx: CommandContext) => {
        config = loadConfig()
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const tier = getTier(senderJid, undefined, config)

        if (tier !== 'owner') {
          await ctx.reply('Bukan owner.')
          return
        }

        const qs = queueStats()
        const audioDir = '/opt/Allybot/data/cache/audio'
        const diskBytes = await getDirSize(audioDir)

        const report =
          `*Music Stats*\n\n` +
          `Queue: ${qs.active} active, ${qs.waiting} waiting, ${qs.inflight} in-flight\n` +
          `Cache: ${formatBytes(diskBytes)} (${audioDir})`

        await ctx.reply(report)
      },
    })
  },
}
