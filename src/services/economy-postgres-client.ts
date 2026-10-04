import postgres, { type Sql } from 'postgres'
import { randomUUID } from 'node:crypto'
import type { EconomyRpcClient, EconomyRpcValue } from './economy-service.js'

export interface EconomyPostgresClientOptions {
  readonly postgresUrl: string
}

export function createPostgresEconomyClient(options: EconomyPostgresClientOptions): EconomyRpcClient {
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
        CREATE TABLE IF NOT EXISTS economy_accounts (
          scope_key TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          wallet_balance BIGINT NOT NULL DEFAULT 1000,
          safe_balance BIGINT NOT NULL DEFAULT 0,
          safe_limit BIGINT NOT NULL DEFAULT 50000,
          restricted_wallet_balance BIGINT NOT NULL DEFAULT 0,
          reserved_wallet_balance BIGINT NOT NULL DEFAULT 0,
          membership_tier TEXT NOT NULL DEFAULT 'basic',
          safe_status TEXT NOT NULL DEFAULT 'not_open',
          revision BIGINT NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (scope_key, subject_key)
        );

        CREATE TABLE IF NOT EXISTS economy_group_policies (
          scope_key TEXT PRIMARY KEY,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS economy_history (
          entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scope_key TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          entry_type TEXT NOT NULL,
          amount BIGINT NOT NULL DEFAULT 0,
          wallet_delta BIGINT NOT NULL DEFAULT 0,
          safe_delta BIGINT NOT NULL DEFAULT 0,
          reserved_wallet_delta BIGINT NOT NULL DEFAULT 0,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS economy_transfers (
          transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scope_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          target_key TEXT NOT NULL,
          amount BIGINT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS economy_outbox (
          outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scope_key TEXT NOT NULL,
          target_jid TEXT NOT NULL,
          payload JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          retry_count INT NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          lease_until TIMESTAMPTZ,
          attempt_id TEXT,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          sent_at TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS economy_outbox_pending_idx
        ON economy_outbox (next_attempt_at, created_at)
        WHERE status = 'pending';

        CREATE INDEX IF NOT EXISTS economy_outbox_lease_idx
        ON economy_outbox (lease_until)
        WHERE status = 'sending';
      `)
      schemaInitialized = true
    } catch {
      // Schema may already exist
    }
  }

  ensureSchema().catch(() => {})

  async function getOrCreateAccount(scopeKey: string, subjectKey: string) {
    const rows = await sql`
      SELECT * FROM economy_accounts WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
    `
    if (rows.length > 0) return rows[0]

    const inserted = await sql`
      INSERT INTO economy_accounts (
        scope_key, subject_key, wallet_balance, safe_balance, safe_limit,
        restricted_wallet_balance, reserved_wallet_balance, membership_tier,
        safe_status, revision, updated_at
      ) VALUES (
        ${scopeKey}, ${subjectKey}, 1000, 0, 50000, 0, 0, 'basic', 'not_open', 1, now()
      )
      ON CONFLICT (scope_key, subject_key) DO NOTHING
      RETURNING *
    `
    if (inserted.length > 0) return inserted[0]

    const refetched = await sql`
      SELECT * FROM economy_accounts WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
    `
    return refetched[0]
  }

  async function isGroupEnabled(scopeKey: string): Promise<boolean> {
    const rows = await sql`
      SELECT enabled FROM economy_group_policies WHERE scope_key = ${scopeKey}
    `
    return rows.length > 0 ? Boolean(rows[0].enabled) : true
  }

  return {
    async rpc(functionName: string, args: Record<string, EconomyRpcValue>) {
      await ensureSchema()
      const now = new Date().toISOString()

      if (functionName === 'economy_get_account_snapshot') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const enabled = await isGroupEnabled(scopeKey)
        const acc = await getOrCreateAccount(scopeKey, subjectKey)

        return {
          data: {
            economy_enabled: enabled,
            wallet_balance: Number(acc.wallet_balance),
            safe_balance: Number(acc.safe_balance),
            safe_limit: Number(acc.safe_limit),
            restricted_wallet_balance: Number(acc.restricted_wallet_balance),
            reserved_wallet_balance: Number(acc.reserved_wallet_balance),
            membership_tier: String(acc.membership_tier),
            safe_status: String(acc.safe_status),
            revision: Number(acc.revision),
            as_of: now,
          },
          error: null,
        }
      }

      if (functionName === 'economy_set_group_policy') {
        const scopeKey = String(args.p_scope_key ?? '')
        const enabled = Boolean(args.p_enabled)
        await sql`
          INSERT INTO economy_group_policies (scope_key, enabled, updated_at)
          VALUES (${scopeKey}, ${enabled}, now())
          ON CONFLICT(scope_key) DO UPDATE SET enabled = ${enabled}, updated_at = now()
        `
        return { data: { ok: true, enabled }, error: null }
      }

      if (functionName === 'economy_open_safe') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        await getOrCreateAccount(scopeKey, subjectKey)

        await sql`
          UPDATE economy_accounts
          SET safe_status = 'active', revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        await sql`
          INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
          VALUES (${scopeKey}, ${subjectKey}, 'open_safe', 0, 0, 0, 0, ${String(args.p_reason ?? 'Open safe')})
        `

        return { data: { ok: true, code: 'opened' }, error: null }
      }

      if (functionName === 'economy_grant_reward') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const outboxTargetJid = typeof args.p_outbox_target_jid === 'string' ? args.p_outbox_target_jid.trim() : ''
        const outboxPayload = args.p_outbox_payload
          ? (typeof args.p_outbox_payload === 'string' ? args.p_outbox_payload : JSON.stringify(args.p_outbox_payload))
          : ''
        await getOrCreateAccount(scopeKey, subjectKey)

        await sql.begin(async (tx) => {
          await tx`
            UPDATE economy_accounts
            SET wallet_balance = wallet_balance + ${amount}, revision = revision + 1, updated_at = now()
            WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
          `
          await tx`
            INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
            VALUES (${scopeKey}, ${subjectKey}, 'reward', ${amount}, ${amount}, 0, 0, ${String(args.p_reason ?? 'Reward')})
          `
          if (outboxTargetJid && outboxPayload) {
            await tx`
              INSERT INTO economy_outbox (scope_key, target_jid, payload, status)
              VALUES (${scopeKey}, ${outboxTargetJid}, ${outboxPayload}::jsonb, 'pending')
            `
          }
        })

        return { data: { ok: true, code: 'granted' }, error: null }
      }

      if (functionName === 'economy_deposit') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = await getOrCreateAccount(scopeKey, subjectKey)

        if (acc.safe_status !== 'active') {
          return { data: null, error: { message: 'Safe belum active. Buka safe dengan !bank open.' } }
        }
        if (Number(acc.wallet_balance) < amount) {
          return { data: null, error: { message: 'insufficient funds in wallet' } }
        }
        if (Number(acc.safe_balance) + amount > Number(acc.safe_limit)) {
          return { data: null, error: { message: 'capacity limit exceeded for safe' } }
        }

        await sql`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance - ${amount}, safe_balance = safe_balance + ${amount}, revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        await sql`
          INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
          VALUES (${scopeKey}, ${subjectKey}, 'deposit', ${amount}, ${-amount}, ${amount}, 0, ${String(args.p_reason ?? 'Deposit')})
        `

        return { data: { ok: true, code: 'deposited' }, error: null }
      }

      if (functionName === 'economy_withdraw') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = await getOrCreateAccount(scopeKey, subjectKey)

        if (acc.safe_status !== 'active') {
          return { data: null, error: { message: 'Safe belum active.' } }
        }
        if (Number(acc.safe_balance) < amount) {
          return { data: null, error: { message: 'insufficient safe balance' } }
        }

        await sql`
          UPDATE economy_accounts
          SET safe_balance = safe_balance - ${amount}, wallet_balance = wallet_balance + ${amount}, revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        await sql`
          INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
          VALUES (${scopeKey}, ${subjectKey}, 'withdraw', ${amount}, ${amount}, ${-amount}, 0, ${String(args.p_reason ?? 'Withdraw')})
        `

        return { data: { ok: true, code: 'withdrawn' }, error: null }
      }

      if (functionName === 'economy_upgrade_membership') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const tier = String(args.p_tier ?? 'bronze')
        await getOrCreateAccount(scopeKey, subjectKey)

        const limits: Record<string, number> = {
          basic: 50000,
          bronze: 100000,
          silver: 250000,
          gold: 500000,
          star: 1000000,
        }
        const limit = limits[tier] ?? 50000

        await sql`
          UPDATE economy_accounts
          SET membership_tier = ${tier}, safe_limit = ${limit}, revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        return { data: { ok: true, code: 'upgraded', tier }, error: null }
      }

      if (functionName === 'economy_create_transfer') {
        const scopeKey = String(args.p_scope_key ?? '')
        const sourceKey = String(args.p_sender_key ?? args.p_source_key ?? '')
        const targetKey = String(args.p_recipient_key ?? args.p_target_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const outboxTargetJid = typeof args.p_outbox_target_jid === 'string' ? args.p_outbox_target_jid.trim() : ''
        const outboxPayload = args.p_outbox_payload
          ? (typeof args.p_outbox_payload === 'string' ? args.p_outbox_payload : JSON.stringify(args.p_outbox_payload))
          : ''

        const source = await getOrCreateAccount(scopeKey, sourceKey)
        await getOrCreateAccount(scopeKey, targetKey)

        if (Number(source.wallet_balance) < amount) {
          return { data: null, error: { message: 'insufficient funds for transfer' } }
        }

        const transferId = randomUUID()

        await sql.begin(async (tx) => {
          await tx`
            UPDATE economy_accounts
            SET wallet_balance = wallet_balance - ${amount}, revision = revision + 1, updated_at = now()
            WHERE scope_key = ${scopeKey} AND subject_key = ${sourceKey}
          `
          await tx`
            UPDATE economy_accounts
            SET wallet_balance = wallet_balance + ${amount}, revision = revision + 1, updated_at = now()
            WHERE scope_key = ${scopeKey} AND subject_key = ${targetKey}
          `
          await tx`
            INSERT INTO economy_transfers (transfer_id, scope_key, source_key, target_key, amount, status)
            VALUES (${transferId}, ${scopeKey}, ${sourceKey}, ${targetKey}, ${amount}, 'completed')
          `
          await tx`
            INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
            VALUES (${scopeKey}, ${sourceKey}, 'transfer_out', ${amount}, ${-amount}, 0, 0, ${String(args.p_reason ?? 'Transfer out')})
          `
          await tx`
            INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
            VALUES (${scopeKey}, ${targetKey}, 'transfer_in', ${amount}, ${amount}, 0, 0, ${String(args.p_reason ?? 'Transfer in')})
          `
          if (outboxTargetJid && outboxPayload) {
            await tx`
              INSERT INTO economy_outbox (scope_key, target_jid, payload, status)
              VALUES (${scopeKey}, ${outboxTargetJid}, ${outboxPayload}::jsonb, 'pending')
            `
          }
        })

        return { data: { ok: true, transfer_id: transferId, status: 'completed' }, error: null }
      }

      if (functionName === 'economy_outbox_claim') {
        const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 10)))
        const attemptId = randomUUID()
        const rows = await sql`
          WITH jobs AS (
            SELECT outbox_id
            FROM economy_outbox
            WHERE (status = 'pending' AND next_attempt_at <= now())
               OR (status = 'sending' AND lease_until <= now())
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE economy_outbox o
          SET status = 'sending',
              attempt_id = ${attemptId},
              lease_until = now() + interval '30 seconds',
              retry_count = retry_count + 1
          FROM jobs
          WHERE o.outbox_id = jobs.outbox_id
          RETURNING o.outbox_id, o.scope_key, o.target_jid, o.payload, o.attempt_id, o.retry_count
        `
        return {
          data: {
            jobs: rows.map((r) => ({
              outbox_id: String(r.outbox_id),
              scope_key: String(r.scope_key),
              target_jid: String(r.target_jid),
              payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
              attempt_id: String(r.attempt_id),
              retry_count: Number(r.retry_count),
            })),
          },
          error: null,
        }
      }

      if (functionName === 'economy_outbox_mark_sent') {
        const outboxId = String(args.p_outbox_id ?? '')
        const attemptId = String(args.p_attempt_id ?? '')
        await sql`
          UPDATE economy_outbox
          SET status = 'sent', sent_at = now()
          WHERE outbox_id = ${outboxId} AND attempt_id = ${attemptId}
        `
        return { data: { ok: true }, error: null }
      }

      if (functionName === 'economy_outbox_mark_failed') {
        const outboxId = String(args.p_outbox_id ?? '')
        const attemptId = String(args.p_attempt_id ?? '')
        const errorMsg = String(args.p_error ?? 'unknown error').slice(0, 500)
        await sql`
          UPDATE economy_outbox
          SET status = 'pending',
              next_attempt_at = now() + interval '15 seconds',
              last_error = ${errorMsg}
          WHERE outbox_id = ${outboxId} AND attempt_id = ${attemptId}
        `
        return { data: { ok: true }, error: null }
      }

      if (functionName === 'economy_outbox_enqueue') {
        const scopeKey = String(args.p_scope_key ?? '')
        const targetJid = String(args.p_target_jid ?? '')
        const payload = args.p_payload
          ? (typeof args.p_payload === 'string' ? args.p_payload : JSON.stringify(args.p_payload))
          : '{}'
        const outboxId = randomUUID()
        await sql`
          INSERT INTO economy_outbox (outbox_id, scope_key, target_jid, payload, status)
          VALUES (${outboxId}, ${scopeKey}, ${targetJid}, ${payload}::jsonb, 'pending')
        `
        return { data: { ok: true, outbox_id: outboxId }, error: null }
      }

      if (functionName === 'economy_get_history') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 10)))

        const rows = await sql`
          SELECT entry_id, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at
          FROM economy_history
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `

        return {
          data: rows.map((r) => ({
            entry_id: String(r.entry_id),
            entry_type: String(r.entry_type),
            amount: Number(r.amount),
            wallet_delta: Number(r.wallet_delta),
            safe_delta: Number(r.safe_delta),
            reserved_wallet_delta: Number(r.reserved_wallet_delta),
            reason: String(r.reason),
            created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          })),
          error: null,
        }
      }

      if (functionName === 'economy_pay_tax') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = await getOrCreateAccount(scopeKey, subjectKey)

        if (Number(acc.wallet_balance) < amount) {
          return { data: null, error: { message: 'insufficient funds for tax payment' } }
        }

        await sql`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance - ${amount}, revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        return { data: { ok: true, code: 'paid' }, error: null }
      }

      return { data: { ok: true }, error: null }
    },
  }
}
