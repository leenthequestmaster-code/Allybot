import type { CommandContext, Plugin } from '../contracts.js'
import { searchIllust, fetchImage } from '../../services/pixiv.js'
import { searchPinterest, fetchBuffer } from '../../services/pinterest.js'

const SEARCH_COOLDOWN_MS = 3_000
const MAX_QUERY_LENGTH = 100

function usage(context: CommandContext, command: string, example: string): string {
  return `Format: ${context.prefix}${command} ${example}`
}

function boundText(value: string, max = MAX_QUERY_LENGTH): string | undefined {
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function describeWeatherCode(code: number): string {
  switch (code) {
    case 0: return 'Cerah ☀️'
    case 1:
    case 2:
    case 3: return 'Sebagian Berawan / Mendung ⛅'
    case 45:
    case 48: return 'Berkabut 🌫️'
    case 51:
    case 53:
    case 55: return 'Gerimis Ringan 🌦️'
    case 61:
    case 63:
    case 65: return 'Hujan 🌧️'
    case 71:
    case 73:
    case 75: return 'Bersalju ❄️'
    case 80:
    case 81:
    case 82: return 'Hujan Lebat / Deras ⛈️'
    case 95:
    case 96:
    case 99: return 'Badai Petir ⚡'
    default: return 'Normal'
  }
}

export const toolsSearchPlugin: Plugin = {
  name: 'tools-search',
  version: '0.1.0',
  load(context) {
    // 1. Google Web Search (AI-Powered)
    context.commands.register({
      name: 'google',
      aliases: ['search'],
      description: 'Cari informasi terkini di web dengan rangkuman AI',
      category: 'tools',
      menuOrder: 1,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'google', '<kata kunci>') + '\nContoh: `!google harga bitcoin hari ini`')
          return
        }

        await commandContext.react('⏳')

        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, {
            signal: AbortSignal.timeout(10_000),
          })
          const data = (await res.json()) as any

          let snippets = data?.AbstractText || ''
          let sourceUrl = data?.AbstractURL || `https://www.google.com/search?q=${encodeURIComponent(query)}`

          if (!snippets && data?.RelatedTopics && Array.isArray(data.RelatedTopics)) {
            snippets = data.RelatedTopics
              .slice(0, 5)
              .map((t: any) => t.Text || (t.Topics && t.Topics[0]?.Text))
              .filter(Boolean)
              .join('\n')
          }

          let aiAnswer: string
          try {
            const { chatCompletion } = await import('../../ai-handler.js')
            const prompt = [
              'Kamu adalah asisten mesin pencari cerdas untuk bot WhatsApp.',
              'Tugasmu: Jawab dan rangkum pertanyaan/topik pencarian berikut secara akurat, padat, jelas, dan terkini dalam bahasa Indonesia.',
              `Pertanyaan/Topik: ${query}`,
              snippets ? `Konteks Rujukan Web:\n${snippets}` : 'Tidak ada rujukan web instan, jawab menggunakan pengetahuan terbaikmu.',
              'Format jawaban langsung ke intinya (maksimal 2-3 paragraf atau beberapa poin penting).',
            ].join('\n\n')
            aiAnswer = await chatCompletion(prompt)
          } catch {
            aiAnswer = snippets || `Hasil pencarian dapat dibuka di:\n${sourceUrl}`
          }

          await commandContext.reply([
            '𓏼 *`𝐆𝗼𝗼𝗴𝗹𝗲 𝐒𝗲𝗮𝗿𝗰𝗵 (𝐀𝐈 𝐀𝗻𝘀𝘄𝗲𝗿)`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Query* : ${query}`,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            aiAnswer,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            `🔗 Sumber: ${sourceUrl}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch (error) {
          commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'google search failed')
          await commandContext.reply(`Waduh, gagal mencari info untuk "${query}" nih. Coba lagi sebentar ya~ 🙏`)
        }
      },
    })

    // 2. Image Search
    context.commands.register({
      name: 'image',
      aliases: ['gambar'],
      description: 'Cari gambar dengan filter aman',
      category: 'tools',
      menuOrder: 2,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'image', '<kata kunci>') + '\nContoh: `!image pemandangan gunung`')
          return
        }
        try {
          const res = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json`, {
            signal: AbortSignal.timeout(10_000),
          })
          const data = (await res.json()) as any
          const pages = Object.values(data?.query?.pages || {}) as any[]
          const imgUrl = pages.find((p) => p.imageinfo?.[0]?.url)?.imageinfo[0].url
          if (imgUrl) {
            if (commandContext.whatsapp.sendImage) {
              await commandContext.whatsapp.sendImage(commandContext.message.remoteJid, imgUrl, `📷 Hasil gambar untuk: ${query}`)
            } else {
              await commandContext.reply(`📷 *Gambar Ditemukan:*\n${imgUrl}`)
            }
            return
          }
          await commandContext.reply(`Nggak nemu gambar "${query}" nih, coba kata kunci lain ya~ 🔎`)
        } catch (error) {
          commandContext.logger.warn({ error }, 'image search failed')
          await commandContext.reply('Lagi susah cari gambarnya nih, coba sebentar lagi ya~ 😅')
        }
      },
    })

    // 4. Wikipedia Summary
    context.commands.register({
      name: 'wiki',
      aliases: ['wikipedia'],
      description: 'Ringkasan artikel dari Wikipedia',
      category: 'tools',
      menuOrder: 4,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'wiki', '<topik>') + '\nContoh: `!wiki Indonesia`')
          return
        }
        try {
          const res = await fetch(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
            signal: AbortSignal.timeout(10_000),
            headers: { 'User-Agent': 'Allybot/0.1.0' },
          })
          if (res.status === 404) {
            const searchRes = await fetch(`https://id.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json`, {
              signal: AbortSignal.timeout(10_000),
              headers: { 'User-Agent': 'Allybot/0.1.0' },
            })
            const searchData = (await searchRes.json()) as any[]
            const suggestions = (searchData[1] as string[]) || []
            if (suggestions.length > 0) {
              await commandContext.reply([
                '𓏼 *`𝐖𝗶𝗸𝗶𝗽𝗲𝗱𝗶𝗮 𝐒𝘂𝗺𝗺𝗮𝗿𝘆`*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                'Topik itu belum pas nih. Mungkin maksud kamu:',
                '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
                ...suggestions.map(s => `- — *+ ${s}*`),
                '━━━━━━━━━━━━━━━━━━━━',
                '*© Allyssea Roleplay Community*',
              ].join('\n'))
            } else {
              await commandContext.reply('Topik itu belum ada di Wikipedia nih, coba kata kunci lain ya~ 📖')
            }
            return
          }
          const data = (await res.json()) as any
          if (data.type === 'disambiguation') {
            await commandContext.reply(`Topiknya ada banyak arti nih:\n${data.extract}\n\nCoba ketik topik yang lebih spesifik ya~ 💡`)
            return
          }
          await commandContext.reply([
            '𓏼 *`𝐖𝗶𝗸𝗶𝗽𝗲𝗱𝗶𝗮 𝐒𝘂𝗺𝗺𝗮𝗿𝘆`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Topik* : ${data.title}`,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            data.extract,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            `🔗 ${data.content_urls?.desktop?.page ?? ''}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch (error) {
          commandContext.logger.warn({ error }, 'wikipedia command failed')
          await commandContext.reply('Belum bisa buka artikelnya nih, coba sebentar lagi ya~ 🙏')
        }
      },
    })

    // 5. Cuaca / Weather
    context.commands.register({
      name: 'cuaca',
      aliases: ['weather'],
      description: 'Informasi prakiraan cuaca suatu kota',
      category: 'tools',
      menuOrder: 5,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const city = boundText(commandContext.args.join(' '))
        if (!city) {
          await commandContext.reply(usage(commandContext, 'cuaca', '<nama kota>') + '\nContoh: `!cuaca Jakarta`')
          return
        }
        try {
          const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id&format=json`, {
            signal: AbortSignal.timeout(10_000),
          })
          const geoData = (await geoRes.json()) as any
          const loc = geoData?.results?.[0]
          if (!loc) {
            await commandContext.reply(`Kota "${city}" nggak ketemu nih, coba cek lagi ejaannya ya~ 🌤️`)
            return
          }
          const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`, {
            signal: AbortSignal.timeout(10_000),
          })
          const weatherData = (await weatherRes.json()) as any
          const cur = weatherData?.current_weather
          if (!cur) throw new Error('weather data unavailable')

          await commandContext.reply([
            '𓏼 *`𝐖𝗲𝗮𝘁𝗵𝗲𝗿 𝐑𝗲𝗽𝗼𝗿𝘁`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Wilayah*  : ${loc.name}, ${loc.country || ''}`,
            `⡇╌ *Kondisi*  : ${describeWeatherCode(cur.weathercode)}`,
            `⡇╌ *Suhu*     : ${cur.temperature}°C`,
            `⡇╌ *Angin*    : ${cur.windspeed} km/h`,
            `⡇╌ *Pantauan* : ${cur.time}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch (error) {
          commandContext.logger.warn({ error }, 'weather command failed')
          await commandContext.reply('Info cuacanya belum bisa dicek nih, coba sebentar lagi ya~ 🌦️')
        }
      },
    })

    // 6. Pinterest
    const recentPinIdsByChat = new Map<string, Set<string>>()

    context.commands.register({
      name: 'pin',
      aliases: ['pinterest'],
      description: 'Cari gambar acak di Pinterest',
      category: 'tools',
      menuOrder: 6,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pin', '<kata kunci>') + '\nContoh: `!pin anime girl`')
          return
        }

        const chatJid = commandContext.message.remoteJid
        await commandContext.react('⏳')

        try {
          const results = await searchPinterest(query, { randomize: true })
          if (!results || results.length === 0) {
            await commandContext.reply(`Gambar untuk "${query}" nggak ketemu di Pinterest nih, coba kata kunci lain ya~ 🔍`)
            return
          }

          let recentIds = recentPinIdsByChat.get(chatJid)
          if (!recentIds) {
            recentIds = new Set<string>()
            recentPinIdsByChat.set(chatJid, recentIds)
          }

          // Prioritaskan gambar yang belum pernah dikirim ke chat ini
          let candidates = results.filter((pin) => !recentIds.has(pin.id))
          if (candidates.length === 0) {
            recentIds.clear()
            candidates = [...results]
          }

          let sent = false
          for (const pin of candidates) {
            if (pin.mediaType !== 'image') continue

            const buf = await fetchBuffer(pin.imageUrl, 15_000, {
              logger: commandContext.logger,
              pinId: pin.id,
            })
            if (!buf) continue

            const captionLines: string[] = []
            if (pin.title) captionLines.push(pin.title.slice(0, 120))
            if (pin.author) captionLines.push(`by @${pin.author}`)
            captionLines.push(`pinterest.com/pin/${pin.id}`)
            const caption = captionLines.join('\n')

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(chatJid, {
                kind: 'image',
                data: new Uint8Array(buf),
                mimeType: 'image/jpeg',
                caption,
              })
            } else {
              await commandContext.reply(`${caption}\n${pin.imageUrl}`)
            }

            recentIds.add(pin.id)
            if (recentIds.size > 50) {
              const firstVal = recentIds.values().next().value
              if (firstVal) recentIds.delete(firstVal)
            }

            sent = true
            break
          }

          if (!sent) {
            await commandContext.reply(`Hasil ketemu tapi gambarnya gagal diunduh nih: ${query}`)
          }
        } catch (error) {
          commandContext.logger.warn({ error }, 'pinterest command failed')
          await commandContext.reply('Waduh, gagal ngambil gambar dari Pinterest nih. Coba sebentar lagi ya~ 🙏')
        }
      },
    })

    // 7. Pixiv
    const recentPixivIdsByChat = new Map<string, Set<string>>()

    context.commands.register({
      name: 'pixiv',
      description: 'Cari ilustrasi acak di Pixiv',
      category: 'tools',
      menuOrder: 7,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pixiv', '<kata kunci>') + '\nContoh: `!pixiv miku`')
          return
        }

        const chatJid = commandContext.message.remoteJid
        await commandContext.react('⏳')

        try {
          const result = await searchIllust(query, { randomize: true })
          if (!result.items || result.items.length === 0) {
            await commandContext.reply(`Gambar untuk "${query}" nggak ketemu di Pixiv nih, coba kata kunci lain ya~ 🔍`)
            return
          }

          let recentIds = recentPixivIdsByChat.get(chatJid)
          if (!recentIds) {
            recentIds = new Set<string>()
            recentPixivIdsByChat.set(chatJid, recentIds)
          }

          // Prioritaskan gambar yang belum pernah dikirim ke chat ini
          let candidates = result.items.filter((item) => !recentIds.has(item.id))
          if (candidates.length === 0) {
            recentIds.clear()
            candidates = [...result.items]
          }

          let sent = false
          // Kirim 1 hasil acak
          for (const item of candidates) {
            const firstImageUrl = item.imageUrls[0]
            if (!firstImageUrl) continue

            const imageBuffer = await fetchImage(firstImageUrl, {
              logger: commandContext.logger,
              illustId: item.id,
            })

            if (!imageBuffer) continue

            const tagsStr = item.tags.length > 0
              ? item.tags.slice(0, 5).map((t) => `#${t.replace(/[\s#]+/g, '_')}`).join(' ')
              : ''
            const caption = `${item.title}\nby ${item.author}${tagsStr ? '\n' + tagsStr : ''}\n#${item.id}`

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(chatJid, {
                kind: 'image',
                data: new Uint8Array(imageBuffer),
                mimeType: 'image/jpeg',
                caption,
              })
            } else {
              await commandContext.reply(`${caption}\n${firstImageUrl}`)
            }

            recentIds.add(item.id)
            if (recentIds.size > 50) {
              const firstVal = recentIds.values().next().value
              if (firstVal) recentIds.delete(firstVal)
            }

            sent = true
            break
          }

          if (!sent) {
            await commandContext.reply('Waduh, gambarnya gagal dimuat nih. Coba kata kunci lain atau tunggu sebentar ya~ 🙏')
          }
        } catch (error) {
          commandContext.logger.warn({ error }, 'pixiv command failed')
          await commandContext.reply('Waduh, gagal ngambil gambar dari Pixiv nih. Coba sebentar lagi ya~ 🙏')
        }
      },
    })
  },
}

export default toolsSearchPlugin
