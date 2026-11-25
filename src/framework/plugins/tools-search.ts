import type { CommandContext, Plugin, WhatsAppMediaPayload } from '../contracts.js'
import { isGroupJid } from '../validation.js'
import { isSameJid } from '../../permissions.js'
import type { RedisService } from '../../redis.js'
import { searchIllust, fetchImage, type PixivItem } from '../../services/pixiv.js'
import { searchPinterestPage, fetchBuffer, type PinterestPin } from '../../services/pinterest.js'

const SEARCH_COOLDOWN_MS = 3_000
const MAX_QUERY_LENGTH = 100
const MAX_BATCH_COUNT = 10
const MAX_SEARCH_PAGES = 3
const BATCH_DOWNLOAD_CONCURRENCY = 4
const GLOBAL_DOWNLOAD_CONCURRENCY = 6
const SEEN_HISTORY_TTL_SECONDS = 86_400
const SEEN_HISTORY_MAX_ITEMS = 200
const SEEN_FALLBACK_MAX_KEYS = 1_000
const IMAGE_BUDGET_WINDOW_MS = 60_000
const USER_IMAGE_BUDGET_LIMIT = 20
const GROUP_IMAGE_BUDGET_LIMIT = 40

export interface ParsedSearchBatchArgs {
  readonly query: string
  readonly count: number
}

export function parseSearchBatchArgs(rawArgs: string): ParsedSearchBatchArgs {
  const trimmed = rawArgs.trim()
  if (!trimmed) return { query: '', count: 1 }

  const clampCount = (n: number): number => Math.min(MAX_BATCH_COUNT, Math.max(1, n))

  const quotedMatch = trimmed.match(/^(['"])(.*?)\1(?:\s+(\d+))?$/)
  if (quotedMatch) {
    const query = quotedMatch[2].trim()
    const count = quotedMatch[3] ? clampCount(Number.parseInt(quotedMatch[3], 10)) : 1
    return { query, count }
  }

  const tokens = trimmed.split(/\s+/)
  if (tokens.length >= 2 && /^\d+$/.test(tokens[tokens.length - 1])) {
    const count = clampCount(Number.parseInt(tokens[tokens.length - 1], 10))
    const query = tokens.slice(0, -1).join(' ').trim()
    return { query, count }
  }

  return { query: trimmed, count: 1 }
}

export interface ToolsSearchDependencies {
  readonly searchPinterestPage?: typeof searchPinterestPage
  readonly fetchPinBuffer?: typeof fetchBuffer
  readonly searchPixivIllust?: typeof searchIllust
  readonly fetchPixivImage?: typeof fetchImage
  readonly clock?: () => number
}

class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}

function detectImageMime(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function canonicalPinterestId(pin: PinterestPin): string {
  try {
    const parsed = new URL(pin.imageUrl)
    return `${parsed.origin}${parsed.pathname}`.toLowerCase()
  } catch {
    return pin.imageUrl.trim() || pin.id
  }
}

function normalizeSearchQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

function getOptionalRedis(commandContext: CommandContext): RedisService | undefined {
  try {
    if (typeof commandContext.services?.has === 'function' && !commandContext.services.has('redis')) {
      return undefined
    }
    return commandContext.services?.get<RedisService>('redis')
  } catch {
    return undefined
  }
}

async function isOwnerOrGroupAdmin(commandContext: CommandContext): Promise<boolean> {
  const senderJid = commandContext.message.senderJid
  if (!senderJid) return false
  if (commandContext.config.botOwnerJid && isSameJid(senderJid, commandContext.config.botOwnerJid)) {
    return true
  }
  const remoteJid = commandContext.message.remoteJid
  if (!isGroupJid(remoteJid) || !commandContext.whatsapp.getGroupMetadata) {
    return false
  }
  try {
    const metadata = await commandContext.whatsapp.getGroupMetadata(remoteJid)
    if (!metadata) return false
    if (metadata.ownerJid && isSameJid(senderJid, metadata.ownerJid)) return true
    const participant = metadata.participants?.find((p) => isSameJid(p.jid, senderJid))
    return participant?.role === 'admin' || participant?.role === 'superadmin'
  } catch {
    return false
  }
}

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

export function createToolsSearchPlugin(deps: ToolsSearchDependencies = {}): Plugin {
  const fetchPinPage = deps.searchPinterestPage ?? searchPinterestPage
  const downloadPinBuffer = deps.fetchPinBuffer ?? fetchBuffer
  const fetchPixivPage = deps.searchPixivIllust ?? searchIllust
  const downloadPixivImage = deps.fetchPixivImage ?? fetchImage
  const clock = deps.clock ?? (() => Date.now())

  return {
    name: 'tools-search',
    version: '0.1.0',
    load(context) {
      const inFlightBatch = new Set<string>()
      const inFlightClaimedIds = new Map<string, Set<string>>()
      const globalDownloadSemaphore = new AsyncSemaphore(GLOBAL_DOWNLOAD_CONCURRENCY)
      const seenFallback = new Map<string, { ids: string[]; expiresAt: number }>()
      const seenMutexes = new Map<string, Promise<void>>()
      const budgetFallback = new Map<string, number[]>()
      const budgetMutexes = new Map<string, Promise<void>>()

      async function withKeyMutex<T>(mutexMap: Map<string, Promise<void>>, key: string, fn: () => Promise<T>): Promise<T> {
        const prev = mutexMap.get(key) ?? Promise.resolve()
        let release!: () => void
        const next = new Promise<void>((resolve) => {
          release = resolve
        })
        const tail = prev.catch(() => {}).then(() => next)
        mutexMap.set(key, tail)
        await prev.catch(() => {})
        try {
          return await fn()
        } finally {
          release()
          if (mutexMap.get(key) === tail) {
            mutexMap.delete(key)
          }
        }
      }

      function getClaimedSet(claimKey: string): Set<string> {
        let set = inFlightClaimedIds.get(claimKey)
        if (!set) {
          set = new Set<string>()
          inFlightClaimedIds.set(claimKey, set)
        }
        return set
      }

      function releaseClaimedIds(claimKey: string, ids: Iterable<string>): void {
        const set = inFlightClaimedIds.get(claimKey)
        if (!set) return
        for (const id of ids) set.delete(id)
        if (set.size === 0) inFlightClaimedIds.delete(claimKey)
      }

      async function loadSeenIds(redis: RedisService | undefined, key: string): Promise<Set<string>> {
        if (redis?.isEnabled && typeof redis.get === 'function') {
          try {
            const stored = await redis.get<string[]>(key)
            if (Array.isArray(stored)) {
              return new Set(stored.filter((v) => typeof v === 'string' && v.length > 0))
            }
          } catch {}
        }
        const entry = seenFallback.get(key)
        if (!entry) return new Set()
        if (entry.expiresAt <= clock()) {
          seenFallback.delete(key)
          return new Set()
        }
        return new Set(entry.ids)
      }

      async function saveSeenIds(redis: RedisService | undefined, key: string, ids: readonly string[]): Promise<void> {
        const bounded = ids.slice(-SEEN_HISTORY_MAX_ITEMS)
        if (redis?.isEnabled && typeof redis.set === 'function') {
          try {
            const ok = await redis.set(key, bounded, SEEN_HISTORY_TTL_SECONDS)
            if (ok) return
          } catch {}
        }
        if (seenFallback.size >= SEEN_FALLBACK_MAX_KEYS && !seenFallback.has(key)) {
          const oldest = seenFallback.keys().next().value
          if (oldest) seenFallback.delete(oldest)
        }
        seenFallback.set(key, {
          ids: [...bounded],
          expiresAt: clock() + SEEN_HISTORY_TTL_SECONDS * 1000,
        })
      }

      async function appendSeenIds(redis: RedisService | undefined, key: string, newIds: readonly string[]): Promise<void> {
        if (newIds.length === 0) return
        await withKeyMutex(seenMutexes, key, async () => {
          const current = await loadSeenIds(redis, key)
          for (const id of newIds) {
            current.delete(id)
            current.add(id)
          }
          await saveSeenIds(redis, key, [...current])
        })
      }

      async function clearSeenIds(redis: RedisService | undefined, key: string): Promise<void> {
        await withKeyMutex(seenMutexes, key, async () => {
          seenFallback.delete(key)
          if (redis?.isEnabled && typeof redis.del === 'function') {
            try {
              await redis.del(key)
              return
            } catch {}
          }
          if (redis?.isEnabled && typeof redis.set === 'function') {
            try {
              await redis.set(key, [], SEEN_HISTORY_TTL_SECONDS)
            } catch {}
          }
        })
      }

      async function loadWindowTimestamps(redis: RedisService | undefined, key: string, now: number): Promise<number[]> {
        const cutoff = now - IMAGE_BUDGET_WINDOW_MS
        let raw: number[] | null = null
        if (redis?.isEnabled && typeof redis.get === 'function') {
          try {
            const stored = await redis.get<number[]>(key)
            if (Array.isArray(stored)) raw = stored
          } catch {}
        }
        if (!raw) {
          raw = budgetFallback.get(key) ?? []
        }
        return raw.filter((ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > cutoff).sort((a, b) => a - b)
      }

      async function saveWindowTimestamps(redis: RedisService | undefined, key: string, timestamps: number[]): Promise<void> {
        budgetFallback.set(key, timestamps)
        if (budgetFallback.size > 2_000) {
          const oldest = budgetFallback.keys().next().value
          if (oldest) budgetFallback.delete(oldest)
        }
        if (redis?.isEnabled && typeof redis.set === 'function') {
          try {
            await redis.set(key, timestamps, 120)
          } catch {}
        }
      }

      async function reserveImageBudget(
        commandContext: CommandContext,
        redis: RedisService | undefined,
        chatJid: string,
        senderJid: string,
        requestedCount: number,
      ): Promise<
        | { allowed: true; refund: (unusedCount: number) => Promise<void> }
        | { allowed: false; scope: 'user' | 'group'; remaining: number; waitSeconds: number }
      > {
        if (await isOwnerOrGroupAdmin(commandContext)) {
          return { allowed: true, refund: async () => {} }
        }

        const userKey = `imgbudget:user:${senderJid}`
        const groupKey = `imgbudget:group:${chatJid}`
        const isGroup = isGroupJid(chatJid)
        const lockKey = isGroup ? `budget:${groupKey}` : `budget:${userKey}`

        return withKeyMutex(budgetMutexes, lockKey, async () => {
          const now = clock()
          const userTimestamps = await loadWindowTimestamps(redis, userKey, now)
          if (userTimestamps.length + requestedCount > USER_IMAGE_BUDGET_LIMIT) {
            const remaining = Math.max(0, USER_IMAGE_BUDGET_LIMIT - userTimestamps.length)
            const neededToExpire = userTimestamps.length + requestedCount - USER_IMAGE_BUDGET_LIMIT
            const expireAt = (userTimestamps[neededToExpire - 1] ?? now) + IMAGE_BUDGET_WINDOW_MS
            const waitSeconds = Math.max(1, Math.ceil((expireAt - now) / 1000))
            return { allowed: false, scope: 'user', remaining, waitSeconds }
          }

          let groupTimestamps: number[] = []
          if (isGroup) {
            groupTimestamps = await loadWindowTimestamps(redis, groupKey, now)
            if (groupTimestamps.length + requestedCount > GROUP_IMAGE_BUDGET_LIMIT) {
              const remaining = Math.max(0, GROUP_IMAGE_BUDGET_LIMIT - groupTimestamps.length)
              const neededToExpire = groupTimestamps.length + requestedCount - GROUP_IMAGE_BUDGET_LIMIT
              const expireAt = (groupTimestamps[neededToExpire - 1] ?? now) + IMAGE_BUDGET_WINDOW_MS
              const waitSeconds = Math.max(1, Math.ceil((expireAt - now) / 1000))
              return { allowed: false, scope: 'group', remaining, waitSeconds }
            }
          }

          const tokenStamp = now
          const added = Array.from({ length: requestedCount }, () => tokenStamp)
          await saveWindowTimestamps(redis, userKey, [...userTimestamps, ...added])
          if (isGroup) {
            await saveWindowTimestamps(redis, groupKey, [...groupTimestamps, ...added])
          }

          let refunded = false
          const refund = async (unusedCount: number) => {
            if (refunded || unusedCount <= 0) return
            refunded = true
            await withKeyMutex(budgetMutexes, lockKey, async () => {
              const currentNow = clock()
              const removeTokens = (list: number[], countToRemove: number): number[] => {
                let left = countToRemove
                const next: number[] = []
                for (let i = list.length - 1; i >= 0; i--) {
                  if (left > 0 && list[i] === tokenStamp) {
                    left -= 1
                    continue
                  }
                  next.push(list[i])
                }
                return next.reverse()
              }
              const uTs = await loadWindowTimestamps(redis, userKey, currentNow)
              await saveWindowTimestamps(redis, userKey, removeTokens(uTs, unusedCount))
              if (isGroup) {
                const gTs = await loadWindowTimestamps(redis, groupKey, currentNow)
                await saveWindowTimestamps(redis, groupKey, removeTokens(gTs, unusedCount))
              }
            })
          }

          return { allowed: true, refund }
        })
      }

      async function collectUniqueBatch<TCandidate>(options: {
        readonly requestedCount: number
        readonly claimKey: string
        readonly seenKey: string
        readonly redis: RedisService | undefined
        readonly fetchPages: () => Promise<{
          readonly candidates: TCandidate[]
          readonly fetchMore: () => Promise<TCandidate[]>
          readonly hasMore: () => boolean
        }>
        readonly getId: (candidate: TCandidate) => string
        readonly download: (candidate: TCandidate) => Promise<Buffer | null>
      }): Promise<{
        readonly fetchedAny: boolean
        readonly downloaded: Array<{ candidate: TCandidate; id: string; buffer: Buffer }>
        readonly releaseClaims: () => void
        readonly commitSeen: () => Promise<void>
      }> {
        const { requestedCount, claimKey, seenKey, redis, fetchPages, getId, download } = options
        const myClaimedIds = new Set<string>()
        const attemptedIds = new Set<string>()
        const failedDownloadIds = new Set<string>()
        const valid: Array<{ candidate: TCandidate; id: string; buffer: Buffer }> = []

        const pager = await fetchPages()
        const pool: TCandidate[] = [...pager.candidates]
        const poolIds = new Set<string>(pool.map(getId))

        const appendToPool = (more: TCandidate[]) => {
          for (const item of more) {
            const id = getId(item)
            if (!id || poolIds.has(id)) continue
            poolIds.add(id)
            pool.push(item)
          }
        }

        if (pool.length === 0) {
          return {
            fetchedAny: false,
            downloaded: [],
            releaseClaims: () => releaseClaimedIds(claimKey, myClaimedIds),
            commitSeen: async () => {},
          }
        }

        let seenSet = await loadSeenIds(redis, seenKey)

        const countUnseenUnclaimedInPool = (): number => {
          const claimedSet = inFlightClaimedIds.get(claimKey)
          let count = 0
          for (const item of pool) {
            const id = getId(item)
            if (!seenSet.has(id) && !attemptedIds.has(id) && !claimedSet?.has(id)) {
              count += 1
            }
          }
          return count
        }

        while (countUnseenUnclaimedInPool() < requestedCount && pager.hasMore()) {
          appendToPool(await pager.fetchMore())
        }

        const claimNextBatch = (needed: number): Array<{ candidate: TCandidate; id: string }> => {
          const claimedSet = getClaimedSet(claimKey)
          const batch: Array<{ candidate: TCandidate; id: string }> = []
          for (const item of pool) {
            if (batch.length >= needed) break
            const id = getId(item)
            if (seenSet.has(id) || attemptedIds.has(id) || failedDownloadIds.has(id) || claimedSet.has(id)) continue
            claimedSet.add(id)
            myClaimedIds.add(id)
            attemptedIds.add(id)
            batch.push({ candidate: item, id })
          }
          return batch
        }

        const runDownloadLoop = async () => {
          while (valid.length < requestedCount) {
            const stillNeeded = requestedCount - valid.length
            let batch = claimNextBatch(stillNeeded)
            if (batch.length === 0 && pager.hasMore()) {
              appendToPool(await pager.fetchMore())
              batch = claimNextBatch(stillNeeded)
            }
            if (batch.length === 0) break

            // Download batch with max BATCH_DOWNLOAD_CONCURRENCY (4) and global semaphore (6)
            const queue = [...batch]
            const workers = Array.from({ length: Math.min(BATCH_DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
              while (queue.length > 0) {
                const entry = queue.shift()
                if (!entry) break
                const buffer = await globalDownloadSemaphore.run(() => download(entry.candidate))
                if (buffer && buffer.length > 0) {
                  valid.push({ candidate: entry.candidate, id: entry.id, buffer })
                } else {
                  failedDownloadIds.add(entry.id)
                  releaseClaimedIds(claimKey, [entry.id])
                  myClaimedIds.delete(entry.id)
                }
              }
            })
            await Promise.all(workers)
          }
        }

        try {
          // If every candidate across all fetched pages was already seen (and not merely locked in-flight),
          // reset seen history for this query so the cycle starts fresh cleanly.
          const claimedNow = inFlightClaimedIds.get(claimKey)
          const totalUnseenEvenIfClaimed = pool.filter((item) => !seenSet.has(getId(item))).length
          if (totalUnseenEvenIfClaimed === 0 && pool.length > 0 && !claimedNow?.size) {
            await clearSeenIds(redis, seenKey)
            seenSet = new Set<string>()
          }

          await runDownloadLoop()

          // Also auto-reset if all remaining unseen candidates failed to download while prior seen history exists
          if (valid.length === 0 && seenSet.size > 0 && pool.length > 0 && !inFlightClaimedIds.get(claimKey)?.size) {
            await clearSeenIds(redis, seenKey)
            seenSet = new Set<string>()
            attemptedIds.clear()
            await runDownloadLoop()
          }
        } catch (err) {
          releaseClaimedIds(claimKey, myClaimedIds)
          throw err
        }

        // Preserve pool order and trim if concurrent workers slightly exceeded (shouldn't happen since claimed == stillNeeded)
        const finalValid = valid.slice(0, requestedCount)
        return {
          fetchedAny: true,
          downloaded: finalValid,
          releaseClaims: () => releaseClaimedIds(claimKey, myClaimedIds),
          commitSeen: async () => {
            await appendSeenIds(redis, seenKey, finalValid.map((item) => item.id))
          },
        }
      }
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
    context.commands.register({
      name: 'pin',
      aliases: ['pinterest'],
      description: 'Cari gambar acak di Pinterest (hingga 10 gambar)',
      category: 'tools',
      menuOrder: 6,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const parsed = parseSearchBatchArgs(commandContext.args.join(' '))
        const query = boundText(parsed.query)
        if (!query) {
          await commandContext.reply(
            usage(commandContext, 'pin', '<query> [1-10]') + '\nContoh: `!pin cyberpunk 5` atau `!pin "persona 5" 4`',
          )
          return
        }

        const chatJid = commandContext.message.remoteJid
        const senderJid = commandContext.message.senderJid ?? chatJid
        const lockKey = `${chatJid}:${senderJid}:pinterest`
        if (inFlightBatch.has(lockKey)) {
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply('Batch Pinterest kamu sebelumnya masih diproses nih, tunggu sebentar ya~ ⏳')
          return
        }

        const redis = getOptionalRedis(commandContext)
        const budget = await reserveImageBudget(commandContext, redis, chatJid, senderJid, parsed.count)
        if (!budget.allowed) {
          const limitLabel = budget.scope === 'group' ? 'grup (40 gambar/menit)' : 'kamu (20 gambar/menit)'
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply(
            `Batas kirim gambar ${limitLabel} tercapai (sisa ${budget.remaining}). Coba lagi dalam ${budget.waitSeconds} detik ya~ ⏳`,
          )
          return
        }

        inFlightBatch.add(lockKey)
        await commandContext.react('⏳')

        let releaseClaims: (() => void) | undefined
        let sentCount = 0

        try {
          const normalizedQuery = normalizeSearchQueryKey(query)
          const claimKey = `pinterest:${chatJid}`
          const seenKey = `imgseen:pinterest:${chatJid}:${normalizedQuery}`

          const batchResult = await collectUniqueBatch<PinterestPin>({
            requestedCount: parsed.count,
            claimKey,
            seenKey,
            redis,
            getId: (pin) => canonicalPinterestId(pin),
            download: (pin) => downloadPinBuffer(pin.imageUrl, 15_000, {
              logger: commandContext.logger,
              pinId: pin.id,
            }),
            fetchPages: async () => {
              let pagesFetched = 0
              let nextBookmark: string | null = null
              const filterImages = (items: PinterestPin[]) => items.filter((p) => p.mediaType === 'image')

              const firstPage = await fetchPinPage(query, { randomize: true })
              pagesFetched = 1
              nextBookmark = firstPage.nextBookmark

              return {
                candidates: filterImages(firstPage.items),
                hasMore: () => pagesFetched < MAX_SEARCH_PAGES && Boolean(nextBookmark),
                fetchMore: async () => {
                  if (!nextBookmark || pagesFetched >= MAX_SEARCH_PAGES) return []
                  pagesFetched += 1
                  const next = await fetchPinPage(query, { randomize: true, bookmark: nextBookmark })
                  nextBookmark = next.nextBookmark
                  return filterImages(next.items)
                },
              }
            },
          })

          releaseClaims = batchResult.releaseClaims

          if (!batchResult.fetchedAny || batchResult.downloaded.length === 0) {
            await commandContext.react('❌').catch(() => {})
            if (!batchResult.fetchedAny) {
              await commandContext.reply(`Gambar untuk "${query}" nggak ketemu di Pinterest nih, coba kata kunci lain ya~ 🔍`)
            } else {
              await commandContext.reply(`Hasil ketemu tapi gambarnya gagal diunduh nih: ${query}`)
            }
            return
          }

          if (batchResult.downloaded.length === 1) {
            const { candidate: pin, buffer } = batchResult.downloaded[0]
            const captionLines: string[] = []
            if (pin.title) captionLines.push(pin.title.slice(0, 120))
            if (pin.author) captionLines.push(`by @${pin.author}`)
            captionLines.push(`pinterest.com/pin/${pin.id}`)
            const caption = captionLines.join('\n')

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(chatJid, {
                kind: 'image',
                data: new Uint8Array(buffer),
                mimeType: detectImageMime(buffer),
                caption,
              })
            } else {
              await commandContext.reply(`${caption}\n${pin.imageUrl}`)
            }
          } else {
            const albumPayloads: WhatsAppMediaPayload[] = batchResult.downloaded.map(({ buffer }) => ({
              kind: 'image',
              data: new Uint8Array(buffer),
              mimeType: detectImageMime(buffer),
              caption: undefined,
            }))

            if (commandContext.whatsapp.sendMediaAlbum) {
              await commandContext.whatsapp.sendMediaAlbum(chatJid, albumPayloads)
            } else if (commandContext.whatsapp.sendMedia) {
              for (const payload of albumPayloads) {
                await commandContext.whatsapp.sendMedia(chatJid, payload)
              }
            } else {
              await commandContext.reply(batchResult.downloaded.map((d) => d.candidate.imageUrl).join('\n'))
            }
          }

          sentCount = batchResult.downloaded.length
          await batchResult.commitSeen()
          await commandContext.react('✅').catch(() => {})
        } catch (error) {
          commandContext.logger.warn({ error }, 'pinterest command failed')
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply('Waduh, gagal ngambil gambar dari Pinterest nih. Coba sebentar lagi ya~ 🙏')
        } finally {
          releaseClaims?.()
          inFlightBatch.delete(lockKey)
          if (sentCount < parsed.count) {
            await budget.refund(parsed.count - sentCount).catch(() => {})
          }
        }
      },
    })

    // 7. Pixiv
    context.commands.register({
      name: 'pixiv',
      description: 'Cari ilustrasi acak di Pixiv (hingga 10 gambar)',
      category: 'tools',
      menuOrder: 7,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const parsed = parseSearchBatchArgs(commandContext.args.join(' '))
        const query = boundText(parsed.query)
        if (!query) {
          await commandContext.reply(
            usage(commandContext, 'pixiv', '<query> [1-10]') + '\nContoh: `!pixiv raiden shogun 4` atau `!pixiv "fate grand order" 5`',
          )
          return
        }

        const chatJid = commandContext.message.remoteJid
        const senderJid = commandContext.message.senderJid ?? chatJid
        const lockKey = `${chatJid}:${senderJid}:pixiv`
        if (inFlightBatch.has(lockKey)) {
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply('Batch Pixiv kamu sebelumnya masih diproses nih, tunggu sebentar ya~ ⏳')
          return
        }

        const redis = getOptionalRedis(commandContext)
        const budget = await reserveImageBudget(commandContext, redis, chatJid, senderJid, parsed.count)
        if (!budget.allowed) {
          const limitLabel = budget.scope === 'group' ? 'grup (40 gambar/menit)' : 'kamu (20 gambar/menit)'
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply(
            `Batas kirim gambar ${limitLabel} tercapai (sisa ${budget.remaining}). Coba lagi dalam ${budget.waitSeconds} detik ya~ ⏳`,
          )
          return
        }

        inFlightBatch.add(lockKey)
        await commandContext.react('⏳')

        let releaseClaims: (() => void) | undefined
        let sentCount = 0

        try {
          const normalizedQuery = normalizeSearchQueryKey(query)
          const claimKey = `pixiv:${chatJid}`
          const seenKey = `imgseen:pixiv:${chatJid}:${normalizedQuery}`

          const batchResult = await collectUniqueBatch<PixivItem>({
            requestedCount: parsed.count,
            claimKey,
            seenKey,
            redis,
            getId: (item) => item.id,
            download: async (item) => {
              const firstImageUrl = item.imageUrls[0]
              if (!firstImageUrl) return null
              return downloadPixivImage(firstImageUrl, {
                logger: commandContext.logger,
                illustId: item.id,
              })
            },
            fetchPages: async () => {
              let pagesFetched = 0
              const candidateOffsets = [0, 30, 60]
              let nextOffset: number | null = null
              const filterValid = (items: readonly PixivItem[]) => items.filter((item) => Boolean(item.id && item.imageUrls[0]))

              const firstPage = await fetchPixivPage(query, { randomize: true })
              pagesFetched = 1
              nextOffset = typeof firstPage.nextOffset === 'number'
                ? firstPage.nextOffset
                : (candidateOffsets[pagesFetched] ?? null)

              return {
                candidates: filterValid(firstPage.items),
                hasMore: () => pagesFetched < MAX_SEARCH_PAGES && nextOffset !== null,
                fetchMore: async () => {
                  if (pagesFetched >= MAX_SEARCH_PAGES || nextOffset === null) return []
                  const off = nextOffset
                  pagesFetched += 1
                  const next = await fetchPixivPage(query, { randomize: true, offset: off })
                  nextOffset = typeof next.nextOffset === 'number'
                    ? next.nextOffset
                    : (pagesFetched < MAX_SEARCH_PAGES ? (off + 30) : null)
                  return filterValid(next.items)
                },
              }
            },
          })

          releaseClaims = batchResult.releaseClaims

          if (!batchResult.fetchedAny) {
            await commandContext.react('❌').catch(() => {})
            await commandContext.reply(`Gambar untuk "${query}" nggak ketemu di Pixiv nih, coba kata kunci lain ya~ 🔍`)
            return
          }

          if (batchResult.downloaded.length === 0) {
            await commandContext.react('❌').catch(() => {})
            await commandContext.reply('Waduh, gambarnya gagal dimuat nih. Coba kata kunci lain atau tunggu sebentar ya~ 🙏')
            return
          }

          if (batchResult.downloaded.length === 1) {
            const { candidate: item, buffer } = batchResult.downloaded[0]
            const tagsStr = item.tags.length > 0
              ? item.tags.slice(0, 5).map((t) => `#${t.replace(/[\s#]+/g, '_')}`).join(' ')
              : ''
            const caption = `${item.title}\nby ${item.author}${tagsStr ? '\n' + tagsStr : ''}\n#${item.id}`

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(chatJid, {
                kind: 'image',
                data: new Uint8Array(buffer),
                mimeType: detectImageMime(buffer),
                caption,
              })
            } else {
              await commandContext.reply(`${caption}\n${item.imageUrls[0]}`)
            }
          } else {
            const albumPayloads: WhatsAppMediaPayload[] = batchResult.downloaded.map(({ buffer }) => ({
              kind: 'image',
              data: new Uint8Array(buffer),
              mimeType: detectImageMime(buffer),
              caption: undefined,
            }))

            if (commandContext.whatsapp.sendMediaAlbum) {
              await commandContext.whatsapp.sendMediaAlbum(chatJid, albumPayloads)
            } else if (commandContext.whatsapp.sendMedia) {
              for (const payload of albumPayloads) {
                await commandContext.whatsapp.sendMedia(chatJid, payload)
              }
            } else {
              await commandContext.reply(batchResult.downloaded.map((d) => d.candidate.imageUrls[0]).join('\n'))
            }
          }

          sentCount = batchResult.downloaded.length
          await batchResult.commitSeen()
          await commandContext.react('✅').catch(() => {})
        } catch (error) {
          commandContext.logger.warn({ error }, 'pixiv command failed')
          await commandContext.react('❌').catch(() => {})
          await commandContext.reply('Waduh, gagal ngambil gambar dari Pixiv nih. Coba sebentar lagi ya~ 🙏')
        } finally {
          releaseClaims?.()
          inFlightBatch.delete(lockKey)
          if (sentCount < parsed.count) {
            await budget.refund(parsed.count - sentCount).catch(() => {})
          }
        }
      },
    })
    },
  }
}

export const toolsSearchPlugin: Plugin = createToolsSearchPlugin()

export default toolsSearchPlugin
