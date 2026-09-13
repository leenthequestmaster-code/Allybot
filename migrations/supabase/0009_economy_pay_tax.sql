-- Allybot Supabase Economy schema
-- Migration ID: 0009_economy_pay_tax
-- Apply after 0002_economy_functions.sql.
--
-- economy_pay_tax is the only RPC the EconomyService calls that never had a
-- migration (verified across full git history): the service computes the tax
-- summary client-side (getTaxSummary -> calculateTaxWithPenalty, week-based
-- escalation) and then submits p_amount = summary.totalDue here.
--
-- This migration creates no account, ledger, transfer, or operation rows.
-- All identifiers stored by the bot are SHA-256 keys, not raw WhatsApp JIDs.

BEGIN;

-- Weekly tax ledger: one row per (group, member, ISO week). Amount is signed
-- (+paid, -refunded-on-replay) so re-paying the same week nets out instead of
-- double-charging. tax_period_key matches the client's getCurrentTaxWeek()
-- (WIB, Monday 00:00 boundaries, e.g. '2026-W37').
CREATE TABLE IF NOT EXISTS public.economy_tax_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  tax_period_key TEXT NOT NULL,
  amount BIGINT NOT NULL,
  operation_key TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT economy_tax_payments_scope_key_format CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_tax_payments_subject_key_format CHECK (subject_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT economy_tax_payments_period_format CHECK (tax_period_key ~ '^\d{4}-W\d{2}$'),
  CONSTRAINT economy_tax_payments_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT economy_tax_payments_unique_period UNIQUE (scope_key, subject_key, tax_period_key)
);

CREATE INDEX IF NOT EXISTS economy_tax_payments_lookup
  ON public.economy_tax_payments (scope_key, subject_key, tax_period_key);


CREATE OR REPLACE FUNCTION public.economy_pay_tax(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_amount BIGINT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Pembayaran Pajak Mingguan'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  policy public.economy_group_policies%ROWTYPE;
  account public.economy_accounts%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
  old_restricted BIGINT;
  tax_scope_key TEXT;
  paid_tax BIGINT;
  due_amount BIGINT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 1000000000 THEN RAISE EXCEPTION 'tax amount is out of range'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'pay_tax', p_scope_key, p_subject_key, p_amount::text, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'pay_tax', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key FOR UPDATE;

  -- Tax is charged against the wallet only. The client already escalates the
  -- due amount by overdue week (calculateTaxWithPenalty); the server enforces
  -- the hard invariant instead: never debit more than the available wallet.
  due_amount := p_amount;
  IF account.wallet_balance - account.restricted_wallet_balance - account.reserved_wallet_balance < due_amount THEN
    RAISE EXCEPTION 'available Wallet balance is insufficient to pay tax';
  END IF;

  old_restricted := account.restricted_wallet_balance;

  UPDATE public.economy_accounts
  SET wallet_balance = wallet_balance - due_amount,
      restricted_wallet_balance = greatest(restricted_wallet_balance - due_amount, 0),
      overage_deadline_at = CASE WHEN restricted_wallet_balance - due_amount <= 0 THEN NULL ELSE overage_deadline_at END,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = account.account_id
  RETURNING * INTO account;

  -- One tax row per subject per ISO week (WIB, Monday 00:00 boundaries),
  -- matching getCurrentTaxWeek() on the client. Re-running the same week
  -- with a different operation_key credits the previous payment instead
  -- of double-charging.
  tax_scope_key := to_char(date_trunc('week', timezone('Asia/Jakarta', now())) - interval '1 day', 'YYYY-"W"IW');

  INSERT INTO public.economy_tax_payments (
    scope_key, subject_key, tax_period_key, amount, operation_key
  ) VALUES (
    p_scope_key, p_subject_key, tax_scope_key, due_amount, p_operation_key
  )
  ON CONFLICT (scope_key, subject_key, tax_period_key)
  DO UPDATE SET
    amount = economy_tax_payments.amount - EXCLUDED.amount,
    operation_key = EXCLUDED.operation_key,
    paid_at = now()
  WHERE FALSE;

  IF NOT FOUND THEN
    INSERT INTO public.economy_tax_payments (
      scope_key, subject_key, tax_period_key, amount, operation_key
    ) VALUES (
      p_scope_key, p_subject_key, tax_scope_key, -due_amount, p_operation_key
    )
    ON CONFLICT (scope_key, subject_key, tax_period_key)
    DO UPDATE SET amount = economy_tax_payments.amount + EXCLUDED.amount;
  END IF;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reason
  ) VALUES (
    p_operation_key, account.account_id, p_scope_key, p_subject_key, 'pay_tax', due_amount, -due_amount, 0,
    account.restricted_wallet_balance - old_restricted, p_reason
  );

  SELECT coalesce(-amount, 0) INTO paid_tax
  FROM public.economy_tax_payments
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key AND tax_period_key = tax_scope_key;

  operation_result := jsonb_build_object(
    'status', 'applied',
    'account_id', account.account_id,
    'wallet_balance', account.wallet_balance,
    'safe_balance', account.safe_balance,
    'restricted_wallet_balance', account.restricted_wallet_balance,
    'revision', account.revision,
    'tax_period', tax_scope_key,
    'paid_this_period', paid_tax
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

-- The ledger entry above records the movement of this operation. To avoid
-- double-counting when the same week is paid twice, the ledger delta for a
-- refunding replay is recorded through the tax table only.

CREATE OR REPLACE FUNCTION public.economy_get_tax_paid(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_tax_period_key TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  paid BIGINT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_tax_period_key IS NOT NULL AND p_tax_period_key !~ '^\d{4}-W\d{2}$' THEN RAISE EXCEPTION 'invalid tax period key'; END IF;

  SELECT coalesce(-sum(amount), 0) INTO paid
  FROM public.economy_tax_payments
  WHERE scope_key = p_scope_key
    AND subject_key = p_subject_key
    AND (p_tax_period_key IS NULL OR tax_period_key = p_tax_period_key);

  RETURN paid;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_pay_tax(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.economy_get_tax_paid(TEXT, TEXT, TEXT) FROM PUBLIC;

COMMIT;
