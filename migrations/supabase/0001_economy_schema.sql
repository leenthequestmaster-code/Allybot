-- Allybot Supabase Economy schema
-- Migration ID: 0001_economy_schema
-- Apply before 0002_economy_functions.sql.
--
-- This migration creates no account, ledger, transfer, or operation rows.
-- All identifiers stored by the bot are SHA-256 keys, not raw WhatsApp JIDs.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.economy_group_policies (
  scope_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  wallet_limit BIGINT NOT NULL DEFAULT 20000,
  safe_base_limit BIGINT NOT NULL DEFAULT 50000,
  overage_grace_seconds INTEGER NOT NULL DEFAULT 86400,
  max_transfer_amount BIGINT NOT NULL DEFAULT 100000,
  transfer_ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  policy_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT economy_group_policies_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_group_policies_wallet_limit CHECK (wallet_limit = 20000),
  CONSTRAINT economy_group_policies_safe_base_limit CHECK (safe_base_limit BETWEEN 0 AND 2000000000),
  CONSTRAINT economy_group_policies_overage_grace CHECK (overage_grace_seconds BETWEEN 3600 AND 604800),
  CONSTRAINT economy_group_policies_transfer_amount CHECK (max_transfer_amount BETWEEN 1 AND 1000000000),
  CONSTRAINT economy_group_policies_transfer_ttl CHECK (transfer_ttl_seconds BETWEEN 300 AND 604800),
  CONSTRAINT economy_group_policies_version CHECK (policy_version > 0)
);

CREATE TABLE IF NOT EXISTS public.economy_accounts (
  account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  wallet_balance BIGINT NOT NULL DEFAULT 0,
  safe_balance BIGINT NOT NULL DEFAULT 0,
  safe_limit BIGINT NOT NULL DEFAULT 50000,
  restricted_wallet_balance BIGINT NOT NULL DEFAULT 0,
  reserved_wallet_balance BIGINT NOT NULL DEFAULT 0,
  membership_tier TEXT NOT NULL DEFAULT 'basic',
  safe_status TEXT NOT NULL DEFAULT 'not_open',
  overage_deadline_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT economy_accounts_scope_subject_unique UNIQUE (scope_key, subject_key),
  CONSTRAINT economy_accounts_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_accounts_subject_key_format CHECK (subject_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_accounts_wallet_non_negative CHECK (wallet_balance BETWEEN 0 AND 2000000000),
  CONSTRAINT economy_accounts_safe_non_negative CHECK (safe_balance BETWEEN 0 AND 2000000000),
  CONSTRAINT economy_accounts_safe_limit_valid CHECK (safe_limit BETWEEN 0 AND 2000000000),
  CONSTRAINT economy_accounts_restricted_valid CHECK (
    restricted_wallet_balance BETWEEN 0 AND wallet_balance
  ),
  CONSTRAINT economy_accounts_reserved_valid CHECK (
    reserved_wallet_balance BETWEEN 0 AND wallet_balance
    AND restricted_wallet_balance + reserved_wallet_balance <= wallet_balance
  ),
  CONSTRAINT economy_accounts_wallet_available_limit CHECK (
    wallet_balance - restricted_wallet_balance - reserved_wallet_balance <= 20000
  ),
  CONSTRAINT economy_accounts_membership_valid CHECK (
    membership_tier IN ('basic', 'bronze', 'silver', 'gold', 'star')
  ),
  CONSTRAINT economy_accounts_status_valid CHECK (
    safe_status IN ('not_open', 'pending', 'active', 'frozen')
  ),
  CONSTRAINT economy_accounts_revision_valid CHECK (revision >= 0),
  CONSTRAINT economy_accounts_safe_capacity CHECK (safe_balance <= safe_limit)
);

CREATE TABLE IF NOT EXISTS public.economy_operations (
  operation_key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT economy_operations_key_format CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  CONSTRAINT economy_operations_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_operations_actor_key_format CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_operations_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_operations_type_format CHECK (operation_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT economy_operations_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT economy_operations_status_valid CHECK (status IN ('pending', 'applied', 'rejected', 'expired'))
);

CREATE TABLE IF NOT EXISTS public.economy_ledger_entries (
  entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL REFERENCES public.economy_operations(operation_key),
  account_id UUID NOT NULL REFERENCES public.economy_accounts(account_id),
  scope_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  wallet_delta BIGINT NOT NULL DEFAULT 0,
  safe_delta BIGINT NOT NULL DEFAULT 0,
  restricted_wallet_delta BIGINT NOT NULL DEFAULT 0,
  reserved_wallet_delta BIGINT NOT NULL DEFAULT 0,
  counterparty_account_id UUID REFERENCES public.economy_accounts(account_id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT economy_ledger_operation_account_type_unique UNIQUE (operation_key, account_id, entry_type),
  CONSTRAINT economy_ledger_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_ledger_subject_key_format CHECK (subject_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_ledger_entry_type_valid CHECK (
    entry_type IN (
      'safe_open',
      'reward',
      'deposit',
      'withdraw',
      'membership_purchase',
      'transfer_debit',
      'transfer_credit',
      'transfer_reserve',
      'transfer_release',
      'seizure',
      'reversal',
      'admin_adjustment'
    )
  ),
  CONSTRAINT economy_ledger_amount_valid CHECK (amount BETWEEN 0 AND 2000000000),
  CONSTRAINT economy_ledger_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS public.economy_transfers (
  transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE REFERENCES public.economy_operations(operation_key),
  scope_key TEXT NOT NULL,
  sender_account_id UUID NOT NULL REFERENCES public.economy_accounts(account_id),
  recipient_account_id UUID NOT NULL REFERENCES public.economy_accounts(account_id),
  sender_key TEXT NOT NULL,
  recipient_key TEXT NOT NULL,
  amount BIGINT NOT NULL,
  context_type TEXT NOT NULL DEFAULT 'ic',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT economy_transfers_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_transfers_sender_key_format CHECK (sender_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_transfers_recipient_key_format CHECK (recipient_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_transfers_different_accounts CHECK (sender_account_id <> recipient_account_id),
  CONSTRAINT economy_transfers_amount_valid CHECK (amount BETWEEN 1 AND 1000000000),
  CONSTRAINT economy_transfers_context_valid CHECK (context_type = 'ic'),
  CONSTRAINT economy_transfers_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT economy_transfers_status_valid CHECK (status IN ('pending', 'settled', 'rejected', 'expired'))
);

CREATE INDEX IF NOT EXISTS economy_accounts_scope_subject_idx
  ON public.economy_accounts (scope_key, subject_key);

CREATE INDEX IF NOT EXISTS economy_ledger_account_created_idx
  ON public.economy_ledger_entries (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS economy_ledger_scope_subject_created_idx
  ON public.economy_ledger_entries (scope_key, subject_key, created_at DESC);

CREATE INDEX IF NOT EXISTS economy_transfers_recipient_pending_idx
  ON public.economy_transfers (scope_key, recipient_key, status, expires_at);

CREATE INDEX IF NOT EXISTS economy_transfers_expiry_idx
  ON public.economy_transfers (status, expires_at);

ALTER TABLE public.economy_group_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.economy_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.economy_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.economy_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.economy_transfers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.economy_group_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.economy_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.economy_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.economy_ledger_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.economy_transfers FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.economy_group_policies TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.economy_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.economy_operations TO service_role;
GRANT SELECT, INSERT ON TABLE public.economy_ledger_entries TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.economy_transfers TO service_role;

COMMIT;
