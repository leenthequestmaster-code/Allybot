import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { EconomyRpcClient, EconomyRpcValue } from './economy-service.js'
import { initSqliteDatabase } from '../storage-helpers.js'

export function createSqliteEconomyClient(databasePath: string): EconomyRpcClient {
  const db = initSqliteDatabase(databasePath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS economy_accounts (
      scope_key TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      wallet_balance INTEGER NOT NULL DEFAULT 1000,
      safe_balance INTEGER NOT NULL DEFAULT 0,
      safe_limit INTEGER NOT NULL DEFAULT 50000,
      restricted_wallet_balance INTEGER NOT NULL DEFAULT 0,
      reserved_wallet_balance INTEGER NOT NULL DEFAULT 0,
      membership_tier TEXT NOT NULL DEFAULT 'basic',
      safe_status TEXT NOT NULL DEFAULT 'not_open',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, subject_key)
    );

    CREATE TABLE IF NOT EXISTS economy_group_policies (
      scope_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS economy_history (
      entry_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      wallet_delta INTEGER NOT NULL DEFAULT 0,
      safe_delta INTEGER NOT NULL DEFAULT 0,
      reserved_wallet_delta INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS economy_transfers (
      transfer_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
  `)

  function getOrCreateAccount(scopeKey: string, subjectKey: string) {
    const existing = db.prepare(`
      SELECT * FROM economy_accounts WHERE scope_key = ? AND subject_key = ?
    `).get(scopeKey, subjectKey) as any

    if (existing) return existing

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO economy_accounts (
        scope_key, subject_key, wallet_balance, safe_balance, safe_limit,
        restricted_wallet_balance, reserved_wallet_balance, membership_tier,
        safe_status, revision, updated_at
      ) VALUES (?, ?, 1000, 0, 50000, 0, 0, 'basic', 'not_open', 1, ?)
    `).run(scopeKey, subjectKey, now)

    return db.prepare(`
      SELECT * FROM economy_accounts WHERE scope_key = ? AND subject_key = ?
    `).get(scopeKey, subjectKey) as any
  }

  function isGroupEnabled(scopeKey: string): boolean {
    const policy = db.prepare(`SELECT enabled FROM economy_group_policies WHERE scope_key = ?`).get(scopeKey) as { enabled: number } | undefined
    return policy ? policy.enabled === 1 : true
  }

  return {
    async rpc(functionName: string, args: Record<string, EconomyRpcValue>) {
      const now = new Date().toISOString()

      if (functionName === 'economy_get_account_snapshot') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const enabled = isGroupEnabled(scopeKey)
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        return {
          data: {
            economy_enabled: enabled,
            wallet_balance: acc.wallet_balance,
            safe_balance: acc.safe_balance,
            safe_limit: acc.safe_limit,
            restricted_wallet_balance: acc.restricted_wallet_balance,
            reserved_wallet_balance: acc.reserved_wallet_balance,
            membership_tier: acc.membership_tier,
            safe_status: acc.safe_status,
            revision: acc.revision,
            as_of: now,
          },
          error: null,
        }
      }

      if (functionName === 'economy_set_group_policy') {
        const scopeKey = String(args.p_scope_key ?? '')
        const enabled = Boolean(args.p_enabled) ? 1 : 0
        db.prepare(`
          INSERT INTO economy_group_policies (scope_key, enabled, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(scope_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
        `).run(scopeKey, enabled, now)
        return { data: { ok: true, enabled: Boolean(enabled) }, error: null }
      }

      if (functionName === 'economy_open_safe') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        db.prepare(`
          UPDATE economy_accounts
          SET safe_status = 'active', revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(now, scopeKey, subjectKey)

        db.prepare(`
          INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
          VALUES (?, ?, ?, 'open_safe', 0, 0, 0, 0, ?, ?)
        `).run(randomUUID(), scopeKey, subjectKey, String(args.p_reason ?? 'Open safe'), now)

        return { data: { ok: true, code: 'opened' }, error: null }
      }

      if (functionName === 'economy_grant_reward') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        db.prepare(`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance + ?, revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(amount, now, scopeKey, subjectKey)

        db.prepare(`
          INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
          VALUES (?, ?, ?, 'reward', ?, ?, 0, 0, ?, ?)
        `).run(randomUUID(), scopeKey, subjectKey, amount, amount, String(args.p_reason ?? 'Reward'), now)

        return { data: { ok: true, code: 'granted' }, error: null }
      }

      if (functionName === 'economy_deposit') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        if (acc.safe_status !== 'active') {
          return { data: null, error: { message: 'Safe belum active. Buka safe dengan !bank open.' } }
        }
        if (acc.wallet_balance < amount) {
          return { data: null, error: { message: 'insufficient funds in wallet' } }
        }
        if (acc.safe_balance + amount > acc.safe_limit) {
          return { data: null, error: { message: 'capacity limit exceeded for safe' } }
        }

        db.prepare(`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance - ?, safe_balance = safe_balance + ?, revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(amount, amount, now, scopeKey, subjectKey)

        db.prepare(`
          INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
          VALUES (?, ?, ?, 'deposit', ?, ?, ?, 0, ?, ?)
        `).run(randomUUID(), scopeKey, subjectKey, amount, -amount, amount, String(args.p_reason ?? 'Deposit'), now)

        return { data: { ok: true, code: 'deposited' }, error: null }
      }

      if (functionName === 'economy_withdraw') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        if (acc.safe_status !== 'active') {
          return { data: null, error: { message: 'Safe belum active.' } }
        }
        if (acc.safe_balance < amount) {
          return { data: null, error: { message: 'insufficient safe balance' } }
        }

        db.prepare(`
          UPDATE economy_accounts
          SET safe_balance = safe_balance - ?, wallet_balance = wallet_balance + ?, revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(amount, amount, now, scopeKey, subjectKey)

        db.prepare(`
          INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
          VALUES (?, ?, ?, 'withdraw', ?, ?, ?, 0, ?, ?)
        `).run(randomUUID(), scopeKey, subjectKey, amount, amount, -amount, String(args.p_reason ?? 'Withdraw'), now)

        return { data: { ok: true, code: 'withdrawn' }, error: null }
      }

      if (functionName === 'economy_upgrade_membership') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const tier = String(args.p_tier ?? 'bronze')
        getOrCreateAccount(scopeKey, subjectKey)

        const limits: Record<string, number> = {
          basic: 50000,
          bronze: 100000,
          silver: 250000,
          gold: 500000,
          star: 1000000,
        }
        const limit = limits[tier] ?? 50000

        db.prepare(`
          UPDATE economy_accounts
          SET membership_tier = ?, safe_limit = ?, revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(tier, limit, now, scopeKey, subjectKey)

        return { data: { ok: true, code: 'upgraded', tier }, error: null }
      }

      if (functionName === 'economy_create_transfer') {
        const scopeKey = String(args.p_scope_key ?? '')
        const sourceKey = String(args.p_source_key ?? '')
        const targetKey = String(args.p_target_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))

        const source = getOrCreateAccount(scopeKey, sourceKey)
        const target = getOrCreateAccount(scopeKey, targetKey)

        if (source.wallet_balance < amount) {
          return { data: null, error: { message: 'insufficient funds for transfer' } }
        }

        const transferId = randomUUID()

        const txn = db.transaction(() => {
          db.prepare(`
            UPDATE economy_accounts
            SET wallet_balance = wallet_balance - ?, revision = revision + 1, updated_at = ?
            WHERE scope_key = ? AND subject_key = ?
          `).run(amount, now, scopeKey, sourceKey)

          db.prepare(`
            UPDATE economy_accounts
            SET wallet_balance = wallet_balance + ?, revision = revision + 1, updated_at = ?
            WHERE scope_key = ? AND subject_key = ?
          `).run(amount, now, scopeKey, targetKey)

          db.prepare(`
            INSERT INTO economy_transfers (transfer_id, scope_key, source_key, target_key, amount, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'completed', ?)
          `).run(transferId, scopeKey, sourceKey, targetKey, amount, now)

          db.prepare(`
            INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
            VALUES (?, ?, ?, 'transfer_out', ?, ?, 0, 0, ?, ?)
          `).run(randomUUID(), scopeKey, sourceKey, amount, -amount, String(args.p_reason ?? 'Transfer to ' + targetKey), now)

          db.prepare(`
            INSERT INTO economy_history (entry_id, scope_key, subject_key, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at)
            VALUES (?, ?, ?, 'transfer_in', ?, ?, 0, 0, ?, ?)
          `).run(randomUUID(), scopeKey, targetKey, amount, amount, String(args.p_reason ?? 'Transfer from ' + sourceKey), now)
        })

        txn()

        return { data: { ok: true, transfer_id: transferId, status: 'completed' }, error: null }
      }

      if (functionName === 'economy_get_history') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 10)))

        const rows = db.prepare(`
          SELECT entry_id, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at
          FROM economy_history
          WHERE scope_key = ? AND subject_key = ?
          ORDER BY rowid DESC
          LIMIT ?
        `).all(scopeKey, subjectKey, limit)

        return { data: rows, error: null }
      }

      if (functionName === 'economy_pay_tax') {
        const scopeKey = String(args.p_scope_key ?? '')
        const subjectKey = String(args.p_subject_key ?? '')
        const amount = Math.max(0, Math.floor(Number(args.p_amount ?? 0)))
        const acc = getOrCreateAccount(scopeKey, subjectKey)

        if (acc.wallet_balance < amount) {
          return { data: null, error: { message: 'insufficient funds for tax payment' } }
        }

        db.prepare(`
          UPDATE economy_accounts
          SET wallet_balance = wallet_balance - ?, revision = revision + 1, updated_at = ?
          WHERE scope_key = ? AND subject_key = ?
        `).run(amount, now, scopeKey, subjectKey)

        return { data: { ok: true, code: 'paid' }, error: null }
      }

      // Default fallback for any other RPC function
      return { data: { ok: true }, error: null }
    },
  }
}
