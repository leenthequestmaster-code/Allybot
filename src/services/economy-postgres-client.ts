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
      await sql`
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
      `
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
        await getOrCreateAccount(scopeKey, subjectKey)

        await sql`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance + ${amount}, revision = revision + 1, updated_at = now()
          WHERE scope_key = ${scopeKey} AND subject_key = ${subjectKey}
        `

        await sql`
          INSERT INTO economy_history (scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason)
          VALUES (${scopeKey}, ${subjectKey}, 'reward', ${amount}, ${amount}, 0, 0, ${String(args.p_reason ?? 'Reward')})
        `

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
        const sourceKey = String(args.p_source_key ?? '')
        const targetKey = String(args.p_target_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))

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
        })

        return { data: { ok: true, transfer_id: transferId, status: 'completed' }, error: null }
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
