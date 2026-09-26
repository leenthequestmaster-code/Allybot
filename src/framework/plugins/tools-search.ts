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
      category: 'tools',
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
            await commandContext.reply([
              '𓏼 *`𝐆𝗼𝗼𝗴𝗹𝗲 𝐒𝗲𝗮𝗿𝗰𝗵`*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `⡇╌ *Query*  : ${query}`,
              `⡇╌ *Sumber* : ${data.AbstractURL || data.AbstractSource || 'Web'}`,
              '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
              data.AbstractText,
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Roleplay Community*',
            ].join('\n'))
            return
          }
          await commandContext.reply([
            '𓏼 *`𝐆𝗼𝗼𝗴𝗹𝗲 𝐒𝗲𝗮𝗿𝗰𝗵`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Query* : ${query}`,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            `Buka pencarian lengkap di browser:\nhttps://www.google.com/search?q=${encodeURIComponent(query)}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch {
          await commandContext.reply([
            '𓏼 *`𝐆𝗼𝗼𝗴𝗹𝗲 𝐒𝗲𝗮𝗿𝗰𝗵`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Query* : ${query}`,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            `https://www.google.com/search?q=${encodeURIComponent(query)}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
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

    // 3. Lyrics Search
    context.commands.register({
      name: 'lirik',
      aliases: ['lyrics'],
      description: 'Cari lirik lagu',
      category: 'tools',
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
            await commandContext.reply('Liriknya nggak ketemu nih. Coba tulis judul sama penyanyinya lebih lengkap ya~ 🎶')
            return
          }
          const lyrics = track.plainLyrics.length > 2000 ? `${track.plainLyrics.slice(0, 1990)}...` : track.plainLyrics
          await commandContext.reply([
            '𓏼 *`𝐒𝗼𝗻𝗴 𝐋𝘆𝗿𝗶𝗰𝐬`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Judul*  : ${track.trackName}`,
            `⡇╌ *Artis*  : ${track.artistName}`,
            '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
            lyrics,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch (error) {
          commandContext.logger.warn({ error }, 'lyrics command failed')
          await commandContext.reply('Lirik lagu itu belum ketemu nih, coba cek lagi judulnya ya~ 🎧')
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
    context.commands.register({
      name: 'pin',
      aliases: ['pinterest'],
      description: 'Cari gambar di Pinterest',
      category: 'tools',
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
      category: 'tools',
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
