import postgres, { type Sql } from 'postgres'
import { randomUUID } from 'node:crypto'
import type { CharacterRpcClient } from './character-guide-service.js'
import type { RedisService } from '../redis.js'

export interface CharacterPostgresClientOptions {
  readonly postgresUrl: string
  readonly redis?: RedisService
}

export function createPostgresCharacterClient(options: CharacterPostgresClientOptions): CharacterRpcClient {
  const sql: Sql = postgres(options.postgresUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  })

  let schemaInitialized = false

  async function ensureSchema(): Promise<void> {
    if (schemaInitialized) return
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS character_registration_sessions (
          session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          guide_key TEXT NOT NULL,
          owner_key TEXT NOT NULL,
          quoted_reference_key TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS character_profiles (
          character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          guide_key TEXT NOT NULL,
          owner_key TEXT NOT NULL,
          registration_session_id UUID,
          name TEXT NOT NULL,
          gender TEXT NOT NULL,
          age INTEGER NOT NULL,
          birthday_day INTEGER NOT NULL,
          birthday_month TEXT NOT NULL,
          birthday_year INTEGER NOT NULL,
          race TEXT NOT NULL,
          class_name TEXT NOT NULL,
          element TEXT NOT NULL,
          spirit TEXT,
          crew TEXT,
          will_of_path TEXT NOT NULL,
          profession TEXT,
          titles JSONB NOT NULL DEFAULT '["Allyssea Citizens"]'::jsonb,
          motto TEXT,
          visual TEXT,
          origin TEXT,
          rank TEXT NOT NULL DEFAULT 'F-',
          level INTEGER NOT NULL DEFAULT 1,
          allocated_stats JSONB DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'active',
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        ALTER TABLE character_profiles ADD COLUMN IF NOT EXISTS allocated_stats JSONB DEFAULT '{}'::jsonb;

        CREATE TABLE IF NOT EXISTS character_delivery_outbox (
          delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          character_id UUID NOT NULL,
          owner_key TEXT NOT NULL,
          guide_key TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'your_character_guide',
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          sent_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      schemaInitialized = true
    } catch {
      // Continue anyway if tables already exist or permissions differ
    }
  }

  // Pre-initialize schema in background
  ensureSchema().catch(() => {})

  return {
    async rpc(functionName: string, args: Record<string, string | number | boolean | null | object>) {
      await ensureSchema()
      const redis = options.redis?.isEnabled ? options.redis : undefined

      if (functionName === 'character_registration_start') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')
        const referenceKey = String(args.p_quoted_reference_key ?? '')
        const ttlSeconds = Number(args.p_ttl_seconds ?? 1800)
        const sessionId = randomUUID()
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

        // Delete previous sessions for this owner
        await sql`
          DELETE FROM character_registration_sessions
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey}
        `

        const rows = await sql`
          INSERT INTO character_registration_sessions (session_id, guide_key, owner_key, quoted_reference_key, expires_at)
          VALUES (${sessionId}, ${guideKey}, ${ownerKey}, ${referenceKey}, ${expiresAt.toISOString()})
          RETURNING session_id, quoted_reference_key, expires_at
        `

        const row = rows[0]
        return {
          data: {
            ok: true,
            code: 'created',
            session_id: row.session_id,
            quoted_reference_key: row.quoted_reference_key,
            expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
          },
          error: null,
        }
      }

      if (functionName === 'character_registration_get') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')

        const rows = await sql`
          SELECT session_id, quoted_reference_key, expires_at
          FROM character_registration_sessions
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey} AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1
        `

        if (rows.length === 0) {
          return { data: { ok: true, code: 'not_found' }, error: null }
        }

        const row = rows[0]
        return {
          data: {
            ok: true,
            code: 'found',
            session_id: row.session_id,
            quoted_reference_key: row.quoted_reference_key,
          },
          error: null,
        }
      }

      if (functionName === 'character_registration_cancel') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')

        await sql`
          DELETE FROM character_registration_sessions
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey}
        `

        return { data: { ok: true, code: 'cancelled' }, error: null }
      }

      if (functionName === 'character_save') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')
        const sessionId = String(args.p_session_id ?? '')
        const payload = (args.p_payload ?? {}) as Record<string, unknown>

        // Check if active character exists
        const existing = await sql`
          SELECT character_id FROM character_profiles
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey} AND status = 'active'
          LIMIT 1
        `
        if (existing.length > 0) {
          return { data: { ok: false, code: 'active_character_exists' }, error: null }
        }

        const characterId = randomUUID()
        const deliveryId = randomUUID()

        const name = String(payload.name ?? '')
        const gender = String(payload.gender ?? '')
        const age = Number(payload.age ?? 0)
        const birthdayDay = Number(payload.birthday_day ?? 1)
        const birthdayMonth = String(payload.birthday_month ?? 'Zephyra')
        const birthdayYear = Number(payload.birthday_year ?? 776)
        const race = String(payload.race ?? '')
        const className = String(payload.class_name ?? '')
        const element = String(payload.element ?? '')
        const willOfPath = String(payload.will_of_path ?? 'Neutral')
        const spirit = payload.spirit ? String(payload.spirit) : null
        const crew = payload.crew ? String(payload.crew) : null
        const profession = payload.profession ? String(payload.profession) : null
        const motto = payload.motto ? String(payload.motto) : null
        const visual = payload.visual ? String(payload.visual) : null
        const origin = payload.origin ? String(payload.origin) : null

        await sql`
          INSERT INTO character_profiles (
            character_id, guide_key, owner_key, registration_session_id,
            name, gender, age, birthday_day, birthday_month, birthday_year,
            race, class_name, element, spirit, crew, will_of_path,
            profession, motto, visual, origin, rank, level, status, revision
          ) VALUES (
            ${characterId}, ${guideKey}, ${ownerKey}, ${sessionId || null},
            ${name}, ${gender}, ${age}, ${birthdayDay}, ${birthdayMonth}, ${birthdayYear},
            ${race}, ${className}, ${element}, ${spirit}, ${crew}, ${willOfPath},
            ${profession}, ${motto}, ${visual}, ${origin}, 'F-', 1, 'active', 1
          )
        `

        await sql`
          INSERT INTO character_delivery_outbox (delivery_id, character_id, owner_key, guide_key, status)
          VALUES (${deliveryId}, ${characterId}, ${ownerKey}, ${guideKey}, 'pending')
        `

        // Invalidate Redis cache
        if (redis) {
          await redis.cacheDelete('character:active', ownerKey).catch(() => {})
        }

        return {
          data: {
            ok: true,
            code: 'saved',
            character_id: characterId,
            delivery_id: deliveryId,
          },
          error: null,
        }
      }

      if (functionName === 'character_get_active') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')

        // Check Redis cache first
        if (redis) {
          try {
            const cached = await redis.cacheGet<Record<string, unknown>>('character:active', ownerKey)
            if (cached) {
              return { data: cached, error: null }
            }
          } catch {}
        }

        const rows = await sql`
          SELECT * FROM character_profiles
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey} AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        `

        if (rows.length === 0) {
          return { data: { ok: true, code: 'not_found' }, error: null }
        }

        const row = rows[0]
        let titles: string[] = ['Allyssea Citizens']
        if (Array.isArray(row.titles)) {
          titles = row.titles
        } else if (typeof row.titles === 'string') {
          try { titles = JSON.parse(row.titles) } catch {}
        }

        const resultData = {
          ok: true,
          code: 'found',
          character_id: String(row.character_id),
          name: String(row.name),
          gender: String(row.gender),
          age: Number(row.age),
          birthday_day: Number(row.birthday_day),
          birthday_month: String(row.birthday_month),
          birthday_year: Number(row.birthday_year),
          race: String(row.race),
          class_name: String(row.class_name),
          element: String(row.element),
          spirit: row.spirit ? String(row.spirit) : undefined,
          crew: row.crew ? String(row.crew) : undefined,
          rank: String(row.rank ?? 'F-'),
          level: Number(row.level ?? 1),
          will_of_path: String(row.will_of_path),
          profession: row.profession ? String(row.profession) : undefined,
          titles,
          motto: row.motto ? String(row.motto) : undefined,
          visual: row.visual ? String(row.visual) : undefined,
          origin: row.origin ? String(row.origin) : undefined,
          allocated_stats: typeof row.allocated_stats === 'object' && row.allocated_stats !== null ? row.allocated_stats : {},
          status: 'active',
          revision: Number(row.revision ?? 1),
        }

        // Cache in Redis for 60 seconds
        if (redis) {
          await redis.cacheSet('character:active', ownerKey, resultData, 60).catch(() => {})
        }

        return { data: resultData, error: null }
      }

      if (functionName === 'character_allocate_stats') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')
        const statKey = String(args.p_stat_key ?? '').toLowerCase()
        const amount = Number(args.p_amount ?? 1)

        const validKeys = ['hp', 'se', 'str', 'def', 'mp', 'res', 'spd', 'int', 'lck']
        if (!validKeys.includes(statKey) || amount <= 0 || !Number.isInteger(amount)) {
          return { data: { ok: false, error: 'Kunci stat atau jumlah alokasi tidak valid.' }, error: null }
        }

        const rows = await sql`
          SELECT character_id, race, level, allocated_stats FROM character_profiles
          WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey} AND status = 'active'
          LIMIT 1
        `
        if (rows.length === 0) {
          return { data: { ok: false, error: 'Karakter aktif tidak ditemukan.' }, error: null }
        }

        const row = rows[0]
        const level = Number(row.level ?? 1)
        const totalTokensEarned = (Math.max(1, level) - 1) * 5 + 5
        const currentAlloc: Record<string, number> = typeof row.allocated_stats === 'object' && row.allocated_stats !== null ? { ...row.allocated_stats } : {}

        const currentUsed = validKeys.reduce((sum, k) => sum + (Number(currentAlloc[k]) || 0), 0)
        if (currentUsed + amount > totalTokensEarned) {
          return { data: { ok: false, error: `Stat Token tidak mencukupi. Sisa token: ${totalTokensEarned - currentUsed}.` }, error: null }
        }

        currentAlloc[statKey] = (Number(currentAlloc[statKey]) || 0) + amount

        await sql`
          UPDATE character_profiles
          SET allocated_stats = ${JSON.stringify(currentAlloc)}::jsonb, updated_at = now()
          WHERE character_id = ${row.character_id}
        `

        if (redis) {
          try {
            await redis.cacheDelete('character:active', ownerKey)
          } catch {}
        }

        return {
          data: {
            ok: true,
            allocated_stats: currentAlloc,
            message: `Berhasil mengalokasikan ${amount} token ke ${statKey.toUpperCase()}.`,
          },
          error: null,
        }
      }

      if (functionName === 'character_retire') {
        const guideKey = String(args.p_guide_key ?? '')
        const ownerKey = String(args.p_owner_key ?? '')
        const characterId = String(args.p_character_id ?? '')

        await sql`
          UPDATE character_profiles
          SET status = 'off', updated_at = now()
          WHERE character_id = ${characterId} AND owner_key = ${ownerKey}
        `

        // Invalidate Redis cache
        if (redis) {
          await redis.cacheDelete('character:active', ownerKey).catch(() => {})
        }

        return { data: { ok: true, code: 'retired' }, error: null }
      }

      if (functionName === 'character_delivery_pending') {
        const ownerKey = String(args.p_owner_key ?? '')

        const rows = await sql`
          SELECT delivery_id FROM character_delivery_outbox
          WHERE owner_key = ${ownerKey} AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        `

        if (rows.length === 0) {
          return { data: { ok: true, code: 'not_found' }, error: null }
        }

        return { data: { ok: true, code: 'found', delivery_id: rows[0].delivery_id }, error: null }
      }

      if (functionName === 'character_delivery_mark') {
        const deliveryId = String(args.p_delivery_id ?? '')
        const status = String(args.p_status ?? 'sent')
        const errorCode = args.p_error_code ? String(args.p_error_code) : null

        await sql`
          UPDATE character_delivery_outbox
          SET status = ${status}, last_error_code = ${errorCode}, sent_at = now()
          WHERE delivery_id = ${deliveryId}
        `

        return { data: { ok: true, code: 'marked' }, error: null }
      }

      return { data: { ok: true }, error: null }
    },
  }
}
