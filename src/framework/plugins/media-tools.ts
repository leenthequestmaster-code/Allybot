import type { CommandContext, PluginContext } from '../contracts.js'
import {
  MEDIA_INPUT_MAX_BYTES,
  MEDIA_COMMAND_COOLDOWN_MS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  sourceFor,
  safeMediaFailure,
} from './media-common.js'
import QRCode from 'qrcode'
import { findEmojiMix, fetchEmojiMixBuffer } from '../../services/emojimix.js'
import { upscaleImage } from '../../services/upscaler.js'
import { setStickerExif } from '../../services/sticker-exif.js'
import {
  startSpackSession,
  getSpackSession,
  addImageToSpack,
  finishSpackSession,
  cancelSpackSession,
} from '../../services/spack-session.js'
import { FfmpegMediaTransformer, type MediaTransformer } from '../../media.js'

export function registerMediaToolCommands(context: PluginContext, transformer?: MediaTransformer): void {
  const mediaTransformer = transformer ?? new FfmpegMediaTransformer()

      context.commands.register({
        name: 'emojimix',
        aliases: ['mixemoji'],
        description: 'Gabungkan dua emoji menjadi satu stiker',
        category: 'tools',
        menuOrder: 20,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const raw = commandContext.args.join('').trim()
          let emoji1 = ''
          let emoji2 = ''

          if (raw.includes('+')) {
            const parts = raw.split('+')
            emoji1 = parts[0]?.trim() || ''
            emoji2 = parts[1]?.trim() || ''
          } else {
            const matches = Array.from(raw.matchAll(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/gu)).map((m) => m[0])
            if (matches.length >= 2) {
              emoji1 = matches[0]
              emoji2 = matches[1]
            }
          }

          if (!emoji1 || !emoji2) {
            await commandContext.reply(`Format: ${commandContext.prefix}emojimix <emoji1>+<emoji2>\nContoh: ${commandContext.prefix}emojimix 😂+😎`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          try {
            const url = await findEmojiMix(emoji1, emoji2)
            if (!url) {
              await commandContext.reply(`Kombinasi ${emoji1} + ${emoji2} belum ada di Google Emoji Kitchen nih~ 🍳`)
              return
            }

            const pngBuf = await fetchEmojiMixBuffer(url)
            if (!pngBuf) {
              await commandContext.reply('Waduh, gagal mengunduh gambar kombinasi emoji nih~ 🙏')
              return
            }

            const webpSticker = await mediaTransformer.transform(new Uint8Array(pngBuf), 'image/png', 'image', 'sticker')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: webpSticker,
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'emojimix command failed')
            await commandContext.reply('Gagal menggabungkan emoji nih, coba kombinasi emoji yang lain ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'spack',
        aliases: ['stickerpack', 'pack'],
        description: 'Kumpulkan beberapa gambar menjadi paket stiker (.wastickers)',
        category: 'tools',
        menuOrder: 23,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const sub = commandContext.args[0]?.toLowerCase()
          const remoteJid = commandContext.message.remoteJid

          if (sub === 'done') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply(`Nggak ada sesi pack yang aktif nih. Mulai dengan:\n${commandContext.prefix}spack <nama pack>`)
              return
            }
            await commandContext.react('⏳')
            const result = await finishSpackSession(remoteJid)
            if ('error' in result) {
              if (result.error.startsWith('too_few')) {
                const parts = result.error.split(':')
                await commandContext.reply(`Jumlah stiker kurang nih! Minimal butuh ${parts[2]} stiker, sekarang baru ada ${parts[1]}. Tambah gambar lagi ya~ 🖼️`)
              } else {
                await commandContext.reply('Gagal menyelesaikan sticker pack. Coba mulai sesi baru ya~ 🙏')
              }
              return
            }

            if (!commandContext.whatsapp.sendMedia) {
              await commandContext.reply('Fitur media tidak tersedia.')
              return
            }

            // 1. Send .wastickers document for import to Sticker Maker / WAStickerApps
            const safeFileName = `${result.packName.replace(/[^a-zA-Z0-9_-]/g, '_')}.wastickers`
            await commandContext.whatsapp.sendMedia(remoteJid, {
              kind: 'document',
              data: new Uint8Array(result.wastickersBuffer),
              mimeType: 'application/zip',
              fileName: safeFileName,
              caption: `📦 *${result.packName}* (${result.count} stiker)\nFile pack ini berformat *.wastickers*. Bisa kamu buka langsung di app *Sticker Maker* (Viko & Co) atau *WAStickerApps* untuk import ke WhatsApp!\n\nStikernya juga kukirimkan satu per satu di bawah ini ya~ ✨`,
            })

            // 2. Also send the stickers directly to the chat
            const author = commandContext.message.pushName || 'Cyrus'
            for (let i = 0; i < result.stickerBuffers.length; i++) {
              const stickerData = setStickerExif(result.stickerBuffers[i], result.packName, author)
              await commandContext.whatsapp.sendMedia(remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(stickerData),
                mimeType: 'image/webp',
              })
              if (i < result.stickerBuffers.length - 1) {
                await new Promise((r) => setTimeout(r, 600))
              }
            }
            return
          }

          if (sub === 'cancel' || sub === 'batal') {
            const cancelled = await cancelSpackSession(remoteJid)
            if (cancelled) {
              await commandContext.reply('Sesi pembuatan sticker pack berhasil dibatalkan. 👍')
            } else {
              await commandContext.reply('Nggak ada sesi sticker pack yang aktif.')
            }
            return
          }

          if (sub === 'status') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply('Nggak ada sesi sticker pack yang aktif.')
              return
            }
            const { readdir } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const dir = join('/tmp', `spack_${remoteJid.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
            const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('img_'))
            await commandContext.reply(`📦 Pack: *${active.packName}*\nTotal terkumpul: *${files.length}/30* stiker\n\nKirim atau balas gambar dengan *${commandContext.prefix}spack add* untuk menambah, atau *${commandContext.prefix}spack done* jika sudah selesai.`)
            return
          }

          if (sub === 'add') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply(`Belum ada sesi pack nih. Buka sesi dulu dengan:\n${commandContext.prefix}spack <nama pack>`)
              return
            }
            const selected = sourceFor(commandContext)
            if (!selected || selected.descriptor.kind !== 'image') {
              await commandContext.reply(`Balas gambar atau kirim gambar dengan caption *${commandContext.prefix}spack add* ya~ 🖼️`)
              return
            }
            if (!commandContext.whatsapp.downloadMedia) {
              await commandContext.reply('Fitur unduh media belum tersedia.')
              return
            }
            try {
              const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
                maxBytes: MEDIA_INPUT_MAX_BYTES,
                timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
              })
              const addRes = await addImageToSpack(remoteJid, Buffer.from(downloaded.data))
              if ('error' in addRes) {
                if (addRes.error === 'full') {
                  await commandContext.reply('Koleksi sudah penuh (maksimal 30 stiker). Ketik *!spack done* untuk memproses!')
                } else {
                  await commandContext.reply('Gagal menambahkan gambar. Coba lagi ya~')
                }
                return
              }
              await commandContext.reply(`✅ Gambar ke-${addRes.count}/${addRes.max} berhasil disimpan! Balas gambar berikutnya dengan *${commandContext.prefix}spack add*, atau ketik *${commandContext.prefix}spack done* kalau sudah cukup.`)
            } catch {
              await commandContext.reply('Gagal mengunduh gambar nih, coba lagi ya~ 🙏')
            }
            return
          }

          // Otherwise, start a new session
          const packName = commandContext.args.join(' ').trim()
          if (!packName) {
            await commandContext.reply(
              `Format pembuatan Sticker Pack:\n` +
              `• *${commandContext.prefix}spack <nama pack>* : Buka sesi baru\n` +
              `• Balas gambar + *${commandContext.prefix}spack add* : Tambah ke pack (min 3, maks 30)\n` +
              `• *${commandContext.prefix}spack status* : Cek jumlah stiker\n` +
              `• *${commandContext.prefix}spack done* : Selesai & kirim pack\n` +
              `• *${commandContext.prefix}spack cancel* : Batalkan sesi`
            )
            return
          }

          startSpackSession(remoteJid, commandContext.message.senderJid || '', packName)
          await commandContext.reply(
            `📦 Sesi pembuatan pack *${packName}* dibuka!\n\n` +
            `Silakan reply gambar satu per satu dengan *${commandContext.prefix}spack add*.\n` +
            `Minimal 3 stiker, maksimal 30 stiker.\n` +
            `Ketik *${commandContext.prefix}spack done* jika sudah selesai!`
          )
        },
      })

      context.commands.register({
        name: 'removebg',
        aliases: ['nobg'],
        description: 'Hapus latar belakang gambar',
        category: 'tools',
        menuOrder: 21,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected || selected.descriptor.kind !== 'image') {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}removebg.`)
            return
          }
          const apiKey = process.env.REMOVEBG_API_KEY
          if (!apiKey) {
            await commandContext.reply('Fitur hapus background belum disetel nih, colek owner ya~ 🙏')
            return
          }
          await commandContext.react('⏳')
        },
      })

      context.commands.register({
        name: 'ss',
        aliases: ['screenshot'],
        description: 'Ambil tangkapan layar sebuah website',
        category: 'tools',
        menuOrder: 22,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          let url = commandContext.args[0]?.trim()
          if (!url) {
            await commandContext.reply(`Format: ${commandContext.prefix}ss <url>\nContoh: ${commandContext.prefix}ss https://google.com`)
            return
          }
          if (!/^https?:\/\//i.test(url)) url = `https://${url}`
          if (!/^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(url)) {
            await commandContext.reply('Alamat website-nya nggak valid nih, cek lagi ya~ 🔗')
            return
          }
          try {
            const ssUrl = `https://image.thum.io/get/width/1280/crop/800/${url}`
            const res = await fetch(ssUrl, { signal: AbortSignal.timeout(15_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: buffer,
                mimeType: 'image/png',
              })
            } else {
              await commandContext.reply(`Tangkapan layar: ${ssUrl}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'screenshot command failed')
            await commandContext.reply('Gagal ambil screenshot nih, pastiin website-nya bisa dibuka ya~ 🌐')
          }
        },
      })

      context.commands.register({
        name: 'qr',
        description: 'Buat kode QR dari teks',
        category: 'tools',
        menuOrder: 24,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}qr <teks>\nContoh: ${commandContext.prefix}qr https://allyssea.com`)
            return
          }
          if (text.length > 500) {
            await commandContext.reply('Teksnya kepanjangan buat QR code nih, maksimal 500 karakter ya~ ✍️')
            return
          }
          try {
            const pngBuffer = await QRCode.toBuffer(text, {
              width: 512,
              margin: 2,
              errorCorrectionLevel: "M",
            })
            const buffer = new Uint8Array(pngBuffer)
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: "image",
                data: buffer,
                mimeType: "image/png",
              })
            } else {
              await commandContext.reply("Kode QR berhasil dibuat.")
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "qr generation failed")
            await commandContext.reply("Gagal bikin kode QR nih, coba teks yang lebih pendek ya~ 😅")
          }
        },
      })

      context.commands.register({
        name: 'tourl',
        description: 'Unggah media ke penyimpanan publik dan dapatkan link',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas media (gambar/video/audio) lalu ketik ${commandContext.prefix}tourl.`)
            return
          }
          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa unduh media saat ini. Coba lagi nanti ya~ ⏳')
            return
          }
          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })
            const formData = new FormData()
            formData.append('reqtype', 'fileupload')
            formData.append('fileToUpload', new Blob([downloaded.data], { type: downloaded.mimeType }), 'upload.bin')
            const res = await fetch('https://catbox.moe/user/api.php', {
              method: 'POST',
              body: formData,
              signal: AbortSignal.timeout(20_000),
            })
            if (res.ok) {
              const url = (await res.text()).trim()
              await commandContext.reply(`🔗 *Tautan Media Berhasil Dibuat:*\n${url}`)
            } else {
              throw new Error(`Upload error: ${res.status}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tourl upload failed')
            await commandContext.reply('Upload gagal nih, coba file lebih kecil ya~ 📁')
          }
        },
      })

      context.commands.register({
        name: 'hd',
        aliases: ['remini', 'upscale'],
        description: 'Tingkatkan kualitas gambar menjadi HD / jernih',
        category: 'tools',
        menuOrder: 32,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected || (selected.descriptor.kind !== 'image' && selected.descriptor.kind !== 'sticker')) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}hd, atau balas gambar lalu ketik ${commandContext.prefix}hd ya~ ✨`)
            return
          }

          if (selected.descriptor.sizeBytes && selected.descriptor.sizeBytes > 10 * 1024 * 1024) {
            await commandContext.reply('Ukuran gambar terlalu besar nih, maksimal 10 MB ya~ 📁')
            return
          }

          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) return
          await commandContext.react('⏳')

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 30_000,
            })

            const upscaled = await upscaleImage(Buffer.from(downloaded.data), {
              mimeType: downloaded.mimeType,
            })

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(upscaled.buffer),
              mimeType: 'image/jpeg',
              caption: `HD • ${(upscaled.latencyMs / 1000).toFixed(1)}s`,
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'hd upscale failed')
            const msg = error instanceof Error ? error.message : 'Gagal memproses gambar.'
            await commandContext.reply(`Waduh, proses HD belum berhasil nih: ${msg} 🙏`)
          }
        },
      })
}
