import postgres, { type Sql } from 'postgres'
import type { GroupContextRpcClient } from './group-context-service.js'

export interface GroupContextPostgresClientOptions {
  readonly postgresUrl: string
}

export function createPostgresGroupContextClient(options: GroupContextPostgresClientOptions): GroupContextRpcClient {
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
        CREATE TABLE IF NOT EXISTS group_contexts (
          group_key TEXT PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'normal',
          ic_subtype TEXT,
          ooc_policy TEXT NOT NULL DEFAULT 'disabled',
          revision BIGINT NOT NULL DEFAULT 1,
          changed_by_key TEXT NOT NULL DEFAULT 'system',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS group_ooc_allowlist (
          group_key TEXT NOT NULL,
          member_key TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'narrator',
          reason_code TEXT NOT NULL DEFAULT 'narrator_access',
          added_by_key TEXT NOT NULL,
          expires_at TIMESTAMPTZ,
          revision BIGINT NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (group_key, member_key)
        );
      `)
      schemaInitialized = true
    } catch {
      // Ignored if tables already exist
    }
  }

  ensureSchema().catch(() => {})

  return {
    async rpc(functionName: string, args: Record<string, string | number | boolean | null>) {
      await ensureSchema()

      if (functionName === 'group_context_get') {
        const groupKey = String(args.p_group_key ?? '')
        const rows = await sql`
          SELECT group_key, mode, ic_subtype, ooc_policy, revision, changed_by_key, updated_at
          FROM group_contexts
          WHERE group_key = ${groupKey}
          LIMIT 1
        `

        if (rows.length === 0) {
          return {
            data: {
              ok: true,
              group_key: groupKey,
              mode: 'normal',
              ic_subtype: null,
              ooc_policy: 'disabled',
              revision: 0,
            },
            error: null,
          }
        }

        const row = rows[0]
        return {
          data: {
            ok: true,
            group_key: row.group_key,
            mode: row.mode,
            ic_subtype: row.ic_subtype,
            ooc_policy: row.ooc_policy,
            revision: Number(row.revision),
            changed_by_key: row.changed_by_key,
            updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
          },
          error: null,
        }
      }

      if (functionName === 'group_context_set') {
        const groupKey = String(args.p_group_key ?? '')
        const mode = String(args.p_mode ?? 'normal')
        const icSubtype = args.p_ic_subtype ? String(args.p_ic_subtype) : null
        const oocPolicy = String(args.p_ooc_policy ?? 'disabled')
        const actorKey = String(args.p_actor_key ?? '')

        const rows = await sql`
          INSERT INTO group_contexts (group_key, mode, ic_subtype, ooc_policy, revision, changed_by_key, updated_at)
          VALUES (${groupKey}, ${mode}, ${icSubtype}, ${oocPolicy}, 1, ${actorKey}, now())
          ON CONFLICT (group_key) DO UPDATE SET
            mode = ${mode},
            ic_subtype = ${icSubtype},
            ooc_policy = ${oocPolicy},
            revision = group_contexts.revision + 1,
            changed_by_key = ${actorKey},
            updated_at = now()
          RETURNING group_key, mode, ic_subtype, ooc_policy, revision, changed_by_key, updated_at
        `

        const row = rows[0]
        return {
          data: {
            ok: true,
            group_key: row.group_key,
            mode: row.mode,
            ic_subtype: row.ic_subtype,
            ooc_policy: row.ooc_policy,
            revision: Number(row.revision),
            changed_by_key: row.changed_by_key,
            updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
          },
          error: null,
        }
      }

      if (functionName === 'group_ooc_allowlist_check') {
        const groupKey = String(args.p_group_key ?? '')
        const memberKey = String(args.p_member_key ?? '')

        const rows = await sql`
          SELECT 1 FROM group_ooc_allowlist
          WHERE group_key = ${groupKey} AND member_key = ${memberKey}
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1
        `

        return { data: { ok: true, allowed: rows.length > 0 }, error: null }
      }

      if (functionName === 'group_ooc_allowlist_list') {
        const groupKey = String(args.p_group_key ?? '')

        const rows = await sql`
          SELECT member_key, role, reason_code, expires_at
          FROM group_ooc_allowlist
          WHERE group_key = ${groupKey} AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at ASC
        `

        return {
          data: rows.map((r) => ({
            member_key: String(r.member_key),
            role: String(r.role),
            reason_code: String(r.reason_code),
            expires_at: r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at ? String(r.expires_at) : undefined,
          })),
          error: null,
        }
      }

      if (functionName === 'group_ooc_allowlist_set') {
        const groupKey = String(args.p_group_key ?? '')
        const memberKey = String(args.p_member_key ?? '')
        const role = String(args.p_role ?? 'narrator')
        const reasonCode = String(args.p_reason_code ?? 'narrator_access')
        const addedByKey = String(args.p_added_by_key ?? '')

        await sql`
          INSERT INTO group_ooc_allowlist (group_key, member_key, role, reason_code, added_by_key, updated_at)
          VALUES (${groupKey}, ${memberKey}, ${role}, ${reasonCode}, ${addedByKey}, now())
          ON CONFLICT (group_key, member_key) DO UPDATE SET
            role = ${role},
            reason_code = ${reasonCode},
            added_by_key = ${addedByKey},
            updated_at = now()
        `

        return { data: { ok: true, code: 'saved' }, error: null }
      }

      if (functionName === 'group_ooc_allowlist_remove') {
        const groupKey = String(args.p_group_key ?? '')
        const memberKey = String(args.p_member_key ?? '')

        await sql`
          DELETE FROM group_ooc_allowlist
          WHERE group_key = ${groupKey} AND member_key = ${memberKey}
        `

        return { data: { ok: true, code: 'removed' }, error: null }
      }

      if (functionName === 'group_ooc_allowlist_clear') {
        const groupKey = String(args.p_group_key ?? '')

        await sql`
          DELETE FROM group_ooc_allowlist
          WHERE group_key = ${groupKey}
        `

        return { data: { ok: true, code: 'cleared' }, error: null }
      }

      return { data: { ok: true }, error: null }
    },
  }
}
