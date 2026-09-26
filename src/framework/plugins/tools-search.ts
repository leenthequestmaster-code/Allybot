import type { CommandContext, Plugin } from '../contracts.js'

const SEARCH_COOLDOWN_MS = 5_000
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
    // 1. Google Web Search
    context.commands.register({
      name: 'google',
      aliases: ['search'],
      description: 'Cari informasi di web',
      category: 'tools-search',
      menuOrder: 1,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'google', '<kata kunci>') + '\nContoh: `!google Nikola Tesla`')
          return
        }
        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
            signal: AbortSignal.timeout(10_000),
          })
          const data = (await res.json()) as any
          if (data?.AbstractText) {
            await commandContext.reply(`🔍 *Hasil Pencarian: ${query}*\n\n${data.AbstractText}\n\nSumber: ${data.AbstractURL || data.AbstractSource || 'Web'}`)
            return
          }
          await commandContext.reply(`🔍 *Pencarian Web: ${query}*\n\nBuka pencarian lengkap di browser:\nhttps://www.google.com/search?q=${encodeURIComponent(query)}`)
        } catch {
          await commandContext.reply(`🔍 *Pencarian Web: ${query}*\n\nhttps://www.google.com/search?q=${encodeURIComponent(query)}`)
        }
      },
    })

    // 2. Image Search
    context.commands.register({
      name: 'image',
      aliases: ['gambar'],
      description: 'Cari gambar dengan filter aman',
      category: 'tools-search',
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
          await commandContext.reply(`Gambar untuk "${query}" tidak ditemukan atau filter keamanan aktif.`)
        } catch (error) {
          commandContext.logger.warn({ error }, 'image search failed')
          await commandContext.reply('Gagal mencari gambar saat ini.')
        }
      },
    })

    // 3. Lyrics Search
    context.commands.register({
      name: 'lirik',
      aliases: ['lyrics'],
      description: 'Cari lirik lagu',
      category: 'tools-search',
      menuOrder: 3,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'lirik', '<judul lagu / artis>') + '\nContoh: `!lirik Coldplay Yellow`')
          return
        }
        try {
          const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const items = (await res.json()) as any[]
          const track = items.find((i) => i.plainLyrics)
          if (!track || !track.plainLyrics) {
            await commandContext.reply('Lirik lagu tersebut tidak ditemukan. Coba sertakan judul dan nama artis yang lebih spesifik.')
            return
          }
          const lyrics = track.plainLyrics.length > 2000 ? `${track.plainLyrics.slice(0, 1990)}...` : track.plainLyrics
          await commandContext.reply(`🎵 *${track.trackName} - ${track.artistName}*\n\n${lyrics}`)
        } catch (error) {
          commandContext.logger.warn({ error }, 'lyrics command failed')
          await commandContext.reply('Lirik lagu tersebut tidak ditemukan atau layanan sedang offline.')
        }
      },
    })

    // 4. Wikipedia Summary
    context.commands.register({
      name: 'wiki',
      aliases: ['wikipedia'],
      description: 'Ringkasan artikel dari Wikipedia',
      category: 'tools-search',
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
              await commandContext.reply(`Topik tidak ditemukan secara langsung. Beberapa topik serupa:\n• ${suggestions.join('\n• ')}`)
            } else {
              await commandContext.reply('Topik tersebut tidak ditemukan di Wikipedia.')
            }
            return
          }
          const data = (await res.json()) as any
          if (data.type === 'disambiguation') {
            await commandContext.reply(`Topik ambigu (banyak topik serupa):\n${data.extract}\n\nSilakan cari dengan istilah yang lebih spesifik.`)
            return
          }
          await commandContext.reply(`📚 *Wikipedia: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page ?? ''}`)
        } catch (error) {
          commandContext.logger.warn({ error }, 'wikipedia command failed')
          await commandContext.reply('Gagal mengambil ringkasan dari Wikipedia.')
        }
      },
    })

    // 5. Cuaca / Weather
    context.commands.register({
      name: 'cuaca',
      aliases: ['weather'],
      description: 'Informasi prakiraan cuaca suatu kota',
      category: 'tools-search',
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
            await commandContext.reply(`Kota "${city}" tidak dikenali. Pastikan ejaan nama kota sudah benar.`)
            return
          }
          const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`, {
            signal: AbortSignal.timeout(10_000),
          })
          const weatherData = (await weatherRes.json()) as any
          const cur = weatherData?.current_weather
          if (!cur) throw new Error('weather data unavailable')

          await commandContext.reply([
            `🌤️ *Cuaca di ${loc.name}, ${loc.country || ''}*`,
            `• Kondisi: ${describeWeatherCode(cur.weathercode)}`,
            `• Suhu: ${cur.temperature}°C`,
            `• Kecepatan Angin: ${cur.windspeed} km/h`,
            `• Waktu Pantauan: ${cur.time}`,
          ].join('\n'))
        } catch (error) {
          commandContext.logger.warn({ error }, 'weather command failed')
          await commandContext.reply('Gagal mengambil data cuaca saat ini.')
        }
      },
    })

    // 6. Pinterest
    context.commands.register({
      name: 'pin',
      aliases: ['pinterest'],
      description: 'Cari gambar di Pinterest',
      category: 'tools-search',
      menuOrder: 6,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pin', '<kata kunci>') + '\nContoh: `!pin anime girl`')
          return
        }
        await commandContext.reply(`🔍 *Pinterest Search*\nQuery: ${query}\n\nhttps://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`)
      },
    })

    // 7. Pixiv
    context.commands.register({
      name: 'pixiv',
      description: 'Cari ilustrasi di Pixiv',
      category: 'tools-search',
      menuOrder: 7,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pixiv', '<kata kunci>') + '\nContoh: `!pixiv fate saber`')
          return
        }
        await commandContext.reply(`🎨 *Pixiv Search*\nQuery: ${query}\n\nhttps://www.pixiv.net/tags.php?tag=${encodeURIComponent(query)}`)
      },
    })
  },
}

export default toolsSearchPlugin
