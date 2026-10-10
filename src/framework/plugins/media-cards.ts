import type { CommandContext, PluginContext } from '../contracts.js'
import {
  MEDIA_COMMAND_COOLDOWN_MS,
  sourceFor,
  safeMediaFailure,
  runPythonScript,
} from './media-common.js'
import { setStickerExif } from '../../services/sticker-exif.js'
import { VisualCardService } from '../../services/visual-card-service.js'
import { writeFile, unlink } from 'node:fs/promises'
import { randomInt } from 'node:crypto'

export function registerMediaCardCommands(context: PluginContext): void {
      context.commands.register({
        name: 'brat',
        description: 'Buat gambar cover album brat teks hitam background putih dengan efek buram khas',
        category: 'tools',
        menuOrder: 16,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args
          const wantsSticker = rawArgs.some((a) => a === '--sticker' || a === '-s')
          const text = rawArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-')).join(' ').trim() ||
            commandContext.message.quotedText?.trim() || ''

          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}brat <teks>\nContoh: ${commandContext.prefix}brat i'm so brat`)
            return
          }
          if (text.length > 200) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 200 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const png = await VisualCardService.renderBrat(text)

            if (wantsSticker) {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'Brat', commandContext.message.pushName || 'Cyrus')
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: 'brat',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'brat command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      context.commands.register({
        name: 'brats',
        aliases: ['bratsticker'],
        description: 'Buat stiker brat teks hitam background putih dengan efek buram khas',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim() || commandContext.message.quotedText?.trim() || ''
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}brats <teks>\nContoh: ${commandContext.prefix}brats i'm so brat`)
            return
          }
          if (text.length > 200) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 200 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const png = await VisualCardService.renderBrat(text)
            const webp = await VisualCardService.pngToWebpSticker(png, 512)
            const finalWebp = setStickerExif(webp, 'Brat', commandContext.message.pushName || 'Cyrus')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: new Uint8Array(finalWebp),
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'brats command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      context.commands.register({
        name: 'bratvid',
        aliases: ['bvid', 'bratvideo', 'bratanim'],
        description: 'Buat stiker animasi atau video teks brat kata demi kata',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args
          const wantsVideo = rawArgs.some((a) => a === '--video' || a === '--mp4' || a === '-v')
          const text = rawArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-')).join(' ').trim()

          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}bratvid <teks>\nContoh: ${commandContext.prefix}bratvid i am so brat\nOpsi: Tambahkan --green, --black, atau --video`)
            return
          }
          if (text.length > 150) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 150 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const ext = wantsVideo ? 'mp4' : 'webp'
            const tmpId = `bvid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const outPath = `/tmp/${tmpId}.${ext}`

            const { spawn } = await import('node:child_process')
            const { readFile, unlink } = await import('node:fs/promises')
            const { join } = await import('node:path')

            const scriptPath = join(process.cwd(), 'scripts', 'generate-bratvid.py')
            await runPythonScript(scriptPath, [outPath, ...commandContext.args], { timeoutMs: 45_000 })

            const data = await readFile(outPath)
            await unlink(outPath).catch(() => {})

            if (data.byteLength === 0 || data.byteLength > 15 * 1024 * 1024) {
              await commandContext.reply('Hasil media terlalu besar atau gagal dibuat.')
              return
            }

            if (wantsVideo) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'video',
                data: new Uint8Array(data),
                mimeType: 'video/mp4',
                gifPlayback: true,
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(data),
                mimeType: 'image/webp',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'bratvid command failed')
            await commandContext.reply('Waduh, gagal ngerender stiker brat nih. Coba lagi nanti ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'qc',
        aliases: ['quotly', 'qchat'],
        description: 'Ubah teks atau pesan yang dibalas menjadi stiker bubble chat',
        category: 'tools',
        menuOrder: 22,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}qc, atau ketik ${commandContext.prefix}qc <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          // Format name and target text
          let senderName = ''
          if (quotedText && rawArgs) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          // Format time
          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          // Fetch avatar in-memory
          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderQc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const rawWebp = await VisualCardService.pngToWebpSticker(png, 512)
            const finalWebp = setStickerExif(rawWebp, 'Quote Chat', senderName)

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: new Uint8Array(finalWebp),
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'qc command failed')
            await commandContext.reply('Waduh, gagal bikin quote chat stiker nih. Coba lagi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'iqc',
        aliases: ['iosqc', 'fakechat'],
        description: 'Buat fake chat aesthetic bergaya WhatsApp iOS context menu',
        category: 'tools',
        menuOrder: 23,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}iqc, atau ketik ${commandContext.prefix}iqc <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let senderName = ''
          if (quotedText && rawArgs && !rawArgs.startsWith('--')) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderIqc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const asSticker = commandContext.args.includes('--sticker') || commandContext.args.includes('-s')
            if (asSticker) {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'iOS Quote Chat', senderName)
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: `*iOS Quote Chat* — ${senderName}`,
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'iqc command failed')
            await commandContext.reply('Waduh, gagal bikin iOS quote chat nih. Coba lagi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'iqcs',
        aliases: ['iosqcs', 'iqcsticker', 'fakechatsticker'],
        description: 'Buat stiker fake chat aesthetic bergaya WhatsApp iOS context menu',
        category: 'tools',
        menuOrder: 24,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}iqcs, atau ketik ${commandContext.prefix}iqcs <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let senderName = ''
          if (quotedText && rawArgs && !rawArgs.startsWith('--')) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderIqc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const asImage = commandContext.args.includes('--img') || commandContext.args.includes('-i')
            if (asImage) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: `*iOS Quote Chat* — ${senderName}`,
              })
            } else {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'iOS Quote Chat', senderName)
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'iqcs command failed')
            await commandContext.reply('Waduh, gagal bikin stiker iOS quote chat nih. Coba lagi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'x',
        aliases: ['tweet', 'faketweet', 'xpost'],
        description: 'Buat kartu postingan Twitter/X mockup yang elegan',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: 4_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let tweetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            tweetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            tweetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}x, atau ketik ${commandContext.prefix}x <teks>`)
            return
          }

          if (tweetText.length > 280) {
            await commandContext.reply('Teks postingan X maksimal 280 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let name = ''
          let handle = ''

          if (rawArgs.includes('|')) {
            const parts = rawArgs.split('|').map((s) => s.trim())
            if (parts.length >= 3) {
              name = parts[0]
              handle = parts[1].replace(/^@/, '')
              tweetText = parts.slice(2).join('|')
            } else if (parts.length === 2) {
              name = parts[0]
              handle = name.toLowerCase().replace(/[^a-z0-9_]/g, '')
              tweetText = parts[1]
            }
          }

          if (!name) {
            name = commandContext.message.pushName || 'User'
          }
          if (!handle) {
            const rawNum = targetSenderJid.split('@')[0].split(':')[0]
            handle = name.toLowerCase().replace(/[^a-z0-9_]/g, '') || rawNum || 'user'
          }

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {}
          }

          try {
            const png = await VisualCardService.renderTweet({
              name,
              handle,
              text: tweetText,
              avatarBuffer,
              verified: true,
            })

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption: `*Postingan X* — @${handle}`,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tweet command failed')
            await commandContext.reply('Waduh, gagal bikin tweet card nih. Coba lagi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'ttstalk',
        aliases: ['tiktokstalk'],
        description: 'Lihat profil dan statistik akun TikTok secara visual',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: 6_000,
        handler: async (commandContext) => {
          const username = commandContext.args[0]?.trim().replace(/^@/, '')
          if (!username) {
            await commandContext.reply(`Format: ${commandContext.prefix}ttstalk <username>\nContoh: ${commandContext.prefix}ttstalk tiktok`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              signal: AbortSignal.timeout(10_000),
            })

            if (!res.ok) {
              await commandContext.reply(`Profil TikTok @${username} tidak ditemukan atau privat nih 🥺`)
              return
            }

            const html = await res.text()
            const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/)
            if (!match || !match[1]) {
              await commandContext.reply(`Gagal membaca profil TikTok @${username}. Coba beberapa saat lagi ya~`)
              return
            }

            const data = JSON.parse(match[1])
            const userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail']
            const userInfo = userDetail?.userInfo?.user
            const stats = userDetail?.userInfo?.stats

            if (!userInfo) {
              await commandContext.reply(`Akun TikTok @${username} tidak ditemukan nih 🥺`)
              return
            }

            const formatNum = (num: number | undefined) => {
              if (num === undefined || num === null) return '0'
              if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
              if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
              return num.toLocaleString('id-ID')
            }

            let avatarBuffer: Buffer | undefined
            const avatarUrl = userInfo.avatarLarger || userInfo.avatarMedium || userInfo.avatarThumb
            if (avatarUrl) {
              try {
                const avRes = await fetch(avatarUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(5_000),
                })
                if (avRes.ok) {
                  avatarBuffer = Buffer.from(await avRes.arrayBuffer())
                }
              } catch {}
            }

            const png = await VisualCardService.renderProfileCard({
              platform: 'tiktok',
              username: userInfo.uniqueId || username,
              nickname: userInfo.nickname || username,
              bio: userInfo.signature || '',
              avatarBuffer,
              verified: Boolean(userInfo.verified),
              stats: {
                followers: formatNum(stats?.followerCount),
                following: formatNum(stats?.followingCount),
                thirdStat: formatNum(stats?.heartCount ?? stats?.heart),
                thirdStatLabel: 'Total Likes',
              },
            })

            const caption = [
              '𓏼 *`𝐓𝐈𝐊𝐓𝐎𝐊 𝐏𝐑𝐎𝐅𝐈𝐋𝐄`*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `⡇╌ *Nama* : ${userInfo.nickname || username}`,
              `⡇╌ *Username* : @${userInfo.uniqueId || username} ${userInfo.verified ? '✓' : ''}`,
              `⡇╌ *Followers* : ${formatNum(stats?.followerCount)}`,
              `⡇╌ *Following* : ${formatNum(stats?.followingCount)}`,
              `⡇╌ *Total Suka* : ${formatNum(stats?.heartCount ?? stats?.heart)}`,
              `⡇╌ *Video* : ${formatNum(stats?.videoCount)}`,
              '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
              userInfo.signature ? `📝 *Bio:*\n${userInfo.signature}\n─͜──͜──͜─  · • ·  ─͜──͜──͜─` : '',
              `🔗 https://tiktok.com/@${userInfo.uniqueId || username}`,
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Stalker Suite*',
            ].filter(Boolean).join('\n')

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ttstalk command failed')
            await commandContext.reply('Waduh, gagal mengambil profil TikTok. Coba lagi nanti ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'igstalk',
        aliases: ['instagramstalk'],
        description: 'Lihat profil dan statistik akun Instagram secara visual',
        category: 'tools',
        menuOrder: 26,
        cooldownMs: 6_000,
        handler: async (commandContext) => {
          const username = commandContext.args[0]?.trim().replace(/^@/, '')
          if (!username) {
            await commandContext.reply(`Format: ${commandContext.prefix}igstalk <username>\nContoh: ${commandContext.prefix}igstalk instagram`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            let profileData: {
              fullName: string
              username: string
              bio: string
              followers: string
              following: string
              posts: string
              avatarUrl?: string
              verified?: boolean
            } | null = null

            // Try direct web_profile_info
            try {
              const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
                headers: {
                  'x-ig-app-id': '936619743392459',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
                },
                signal: AbortSignal.timeout(6_000),
              })
              if (res.ok) {
                const data = (await res.json()) as any
                const user = data?.data?.user
                if (user) {
                  profileData = {
                    fullName: user.full_name || username,
                    username: user.username || username,
                    bio: user.biography || '',
                    followers: (user.edge_followed_by?.count ?? 0).toLocaleString('id-ID'),
                    following: (user.edge_follow?.count ?? 0).toLocaleString('id-ID'),
                    posts: (user.edge_owner_to_timeline_media?.count ?? 0).toLocaleString('id-ID'),
                    avatarUrl: user.profile_pic_url_hd || user.profile_pic_url,
                    verified: Boolean(user.is_verified),
                  }
                }
              }
            } catch {}

            // Fallback: DuckDuckGo search query for site:instagram.com/${username}
            if (!profileData) {
              try {
                const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=site:instagram.com/${encodeURIComponent(username)}`, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                  signal: AbortSignal.timeout(6_000),
                })
                if (ddgRes.ok) {
                  const html = await ddgRes.text()
                  const descMatch = html.match(/([0-9,.]+[KMBkmb]?)\s+Followers,\s*([0-9,.]+[KMBkmb]?)\s+Following,\s*([0-9,.]+[KMBkmb]?)\s+Posts\s*-\s*([^(@]+)\s*\(@([^)]+)\)\s*(?:on Instagram)?(?::\s*\"?([^\"]*)\"?)?/i)
                  if (descMatch) {
                    profileData = {
                      fullName: descMatch[4].trim(),
                      username: descMatch[5].trim(),
                      bio: descMatch[6]?.trim() || '',
                      followers: descMatch[1].trim(),
                      following: descMatch[2].trim(),
                      posts: descMatch[3].trim(),
                      verified: false,
                    }
                  }
                }
              } catch {}
            }

            if (!profileData) {
              await commandContext.reply(`Profil Instagram @${username} tidak ditemukan atau privat nih 🥺`)
              return
            }

            let avatarBuffer: Buffer | undefined
            if (profileData.avatarUrl) {
              try {
                const avRes = await fetch(profileData.avatarUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(4_000),
                })
                if (avRes.ok) {
                  avatarBuffer = Buffer.from(await avRes.arrayBuffer())
                }
              } catch {}
            }

            const png = await VisualCardService.renderProfileCard({
              platform: 'instagram',
              username: profileData.username,
              nickname: profileData.fullName,
              bio: profileData.bio,
              avatarBuffer,
              verified: profileData.verified,
              stats: {
                followers: profileData.followers,
                following: profileData.following,
                thirdStat: profileData.posts,
                thirdStatLabel: 'Posts',
              },
            })

            const caption = [
              '𓏼 *`𝐈𝐍𝐒𝐓𝐀𝐆𝐑𝐀𝐌 𝐏𝐑𝐎𝐅𝐈𝐋𝐄`*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `⡇╌ *Nama* : ${profileData.fullName}`,
              `⡇╌ *Username* : @${profileData.username} ${profileData.verified ? '✓' : ''}`,
              `⡇╌ *Followers* : ${profileData.followers}`,
              `⡇╌ *Following* : ${profileData.following}`,
              `⡇╌ *Postingan* : ${profileData.posts}`,
              '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
              profileData.bio ? `📝 *Bio:*\n${profileData.bio}\n─͜──͜──͜─  · • ·  ─͜──͜──͜─` : '',
              `🔗 https://instagram.com/${profileData.username}`,
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Stalker Suite*',
            ].filter(Boolean).join('\n')

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'igstalk command failed')
            await commandContext.reply('Waduh, gagal mengambil profil Instagram. Coba lagi nanti ya~ 🙏')
          }
        },
      })
}
