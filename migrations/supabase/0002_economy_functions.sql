-- Allybot Supabase Economy RPCs
-- Migration ID: 0002_economy_functions
-- Apply after 0001_economy_schema.sql.
--
-- Every mutation is performed in one PostgreSQL transaction. Redis is not used
-- by these functions and is never an authoritative balance store.
-- The bot must call these functions only from its server-side service-role client.

BEGIN;

CREATE OR REPLACE FUNCTION public.economy_get_account_snapshot(
  p_scope_key TEXT,
  p_subject_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  policy public.economy_group_policies%ROWTYPE;
  account public.economy_accounts%ROWTYPE;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid economy scope key';
  END IF;

  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid economy subject key';
  END IF;

  SELECT *
  INTO policy
  FROM public.economy_group_policies
  WHERE scope_key = p_scope_key;

  IF NOT FOUND OR NOT policy.enabled THEN
    RETURN jsonb_build_object(
      'economy_enabled', false,
      'wallet_balance', 0,
      'safe_balance', 0,
      'safe_limit', coalesce(policy.safe_base_limit, 50000),
      'restricted_wallet_balance', 0,
      'reserved_wallet_balance', 0,
      'membership_tier', 'basic',
      'safe_status', 'not_open',
      'revision', 0,
      'as_of', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  SELECT *
  INTO account
  FROM public.economy_accounts
  WHERE scope_key = p_scope_key
    AND subject_key = p_subject_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'economy_enabled', true,
      'wallet_balance', 0,
      'safe_balance', 0,
      'safe_limit', coalesce(policy.safe_base_limit, 50000),
      'restricted_wallet_balance', 0,
      'reserved_wallet_balance', 0,
      'membership_tier', 'basic',
      'safe_status', 'not_open',
      'revision', 0,
      'as_of', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  RETURN jsonb_build_object(
    'economy_enabled', true,
    'wallet_balance', account.wallet_balance,
    'safe_balance', account.safe_balance,
    'safe_limit', account.safe_limit,
    'restricted_wallet_balance', account.restricted_wallet_balance,
    'reserved_wallet_balance', account.reserved_wallet_balance,
    'membership_tier', account.membership_tier,
    'safe_status', account.safe_status,
    'revision', account.revision,
    'as_of', to_char(account.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_set_group_policy(
  p_scope_key TEXT,
  p_enabled BOOLEAN,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  policy public.economy_group_policies%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  request_hash := encode(digest(concat_ws('|', 'policy', p_scope_key, p_enabled::text, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'policy_update', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  INSERT INTO public.economy_group_policies (scope_key, enabled)
  VALUES (p_scope_key, p_enabled)
  ON CONFLICT (scope_key) DO UPDATE SET enabled = EXCLUDED.enabled, policy_version = public.economy_group_policies.policy_version + 1, updated_at = now()
  RETURNING * INTO policy;

  operation_result := jsonb_build_object(
    'status', 'applied', 'scope_key', policy.scope_key,
    'enabled', policy.enabled, 'policy_version', policy.policy_version
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_open_safe(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Safe dibuka melalui workflow Bank'
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
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key)
  VALUES (p_scope_key)
  ON CONFLICT (scope_key) DO NOTHING;

  SELECT * INTO policy
  FROM public.economy_group_policies
  WHERE scope_key = p_scope_key;

  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'safe_open', p_scope_key, p_subject_key, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'safe_open', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;

  SELECT * INTO operation
  FROM public.economy_operations
  WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;

  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account
  FROM public.economy_accounts
  WHERE scope_key = p_scope_key
    AND subject_key = p_subject_key
  FOR UPDATE;

  IF account.safe_status = 'active' THEN
    operation_result := jsonb_build_object('status', 'already_active', 'account_id', account.account_id, 'revision', account.revision);
  ELSE
    UPDATE public.economy_accounts
    SET safe_status = 'active',
        safe_limit = policy.safe_base_limit,
        revision = revision + 1,
        updated_at = now()
    WHERE account_id = account.account_id
    RETURNING * INTO account;

    INSERT INTO public.economy_ledger_entries (
      operation_key, account_id, scope_key, subject_key, entry_type, amount,
      wallet_delta, safe_delta, restricted_wallet_delta, reason
    ) VALUES (
      p_operation_key, account.account_id, p_scope_key, p_subject_key, 'safe_open', 0,
      0, 0, 0, p_reason
    );

    operation_result := jsonb_build_object('status', 'opened', 'account_id', account.account_id, 'revision', account.revision);
  END IF;

  UPDATE public.economy_operations
  SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;

  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_grant_reward(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_amount BIGINT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT
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
  new_wallet BIGINT;
  new_restricted BIGINT;
  old_restricted BIGINT;
  new_deadline TIMESTAMPTZ;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 1000000000 THEN RAISE EXCEPTION 'reward amount is out of range'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key)
  VALUES (p_scope_key)
  ON CONFLICT (scope_key) DO NOTHING;

  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'reward', p_scope_key, p_subject_key, p_amount::text, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'reward', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;

  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account
  FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key
  FOR UPDATE;

  old_restricted := account.restricted_wallet_balance;
  new_wallet := account.wallet_balance + p_amount;
  IF new_wallet > 2000000000 THEN RAISE EXCEPTION 'reward would exceed account limit'; END IF;
  new_restricted := greatest(new_wallet - 20000, 0);
  new_deadline := CASE
    WHEN new_restricted > 0 THEN coalesce(account.overage_deadline_at, now() + make_interval(secs => policy.overage_grace_seconds))
    ELSE NULL
  END;

  UPDATE public.economy_accounts
  SET wallet_balance = new_wallet,
      restricted_wallet_balance = new_restricted,
      overage_deadline_at = new_deadline,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = account.account_id
  RETURNING * INTO account;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reason
  ) VALUES (
    p_operation_key, account.account_id, p_scope_key, p_subject_key, 'reward',     p_amount, p_amount, 0, new_restricted - old_restricted, p_reason

  );

  operation_result := jsonb_build_object(
    'status', 'applied',
    'account_id', account.account_id,
    'wallet_balance', account.wallet_balance,
    'restricted_wallet_balance', account.restricted_wallet_balance,
    'revision', account.revision
  );

  UPDATE public.economy_operations
  SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;

  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_deposit(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_amount BIGINT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Setoran Wallet ke Safe'
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
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 1000000000 THEN RAISE EXCEPTION 'deposit amount is out of range'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'deposit', p_scope_key, p_subject_key, p_amount::text, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'deposit', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key FOR UPDATE;
  old_restricted := account.restricted_wallet_balance;
  IF account.safe_status <> 'active' THEN RAISE EXCEPTION 'Safe is not active'; END IF;
  IF p_amount > account.wallet_balance - account.restricted_wallet_balance - account.reserved_wallet_balance THEN RAISE EXCEPTION 'available Wallet balance is insufficient'; END IF;
  IF account.safe_balance + p_amount > account.safe_limit THEN RAISE EXCEPTION 'Safe capacity is insufficient'; END IF;

  UPDATE public.economy_accounts
  SET wallet_balance = wallet_balance - p_amount,
      safe_balance = safe_balance + p_amount,
      restricted_wallet_balance = greatest(restricted_wallet_balance - p_amount, 0),
      overage_deadline_at = CASE WHEN restricted_wallet_balance - p_amount <= 0 THEN NULL ELSE overage_deadline_at END,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = account.account_id
  RETURNING * INTO account;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reason
  ) VALUES (
    p_operation_key, account.account_id, p_scope_key, p_subject_key, 'deposit',     p_amount, -p_amount, p_amount, account.restricted_wallet_balance - old_restricted, p_reason

  );

  operation_result := jsonb_build_object(
    'status', 'applied', 'account_id', account.account_id,
    'wallet_balance', account.wallet_balance, 'safe_balance', account.safe_balance,
    'restricted_wallet_balance', account.restricted_wallet_balance, 'revision', account.revision
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_withdraw(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_amount BIGINT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Penarikan Safe ke Wallet'
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
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 1000000000 THEN RAISE EXCEPTION 'withdraw amount is out of range'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'withdraw', p_scope_key, p_subject_key, p_amount::text, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'withdraw', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key FOR UPDATE;
  IF account.safe_status <> 'active' THEN RAISE EXCEPTION 'Safe is not active'; END IF;
  IF p_amount > account.safe_balance THEN RAISE EXCEPTION 'Safe balance is insufficient'; END IF;
  IF account.wallet_balance + p_amount - account.restricted_wallet_balance - account.reserved_wallet_balance > 20000 THEN RAISE EXCEPTION 'Wallet capacity is insufficient'; END IF;

  UPDATE public.economy_accounts
  SET safe_balance = safe_balance - p_amount,
      wallet_balance = wallet_balance + p_amount,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = account.account_id
  RETURNING * INTO account;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reason
  ) VALUES (
    p_operation_key, account.account_id, p_scope_key, p_subject_key, 'withdraw', p_amount,
    p_amount, -p_amount, 0, p_reason
  );

  operation_result := jsonb_build_object(
    'status', 'applied', 'account_id', account.account_id,
    'wallet_balance', account.wallet_balance, 'safe_balance', account.safe_balance,
    'restricted_wallet_balance', account.restricted_wallet_balance, 'revision', account.revision
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_upgrade_membership(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_target_tier TEXT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Peningkatan membership Safe'
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
  target_rank INTEGER;
  current_rank INTEGER;
  price BIGINT;
  new_limit BIGINT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_target_tier NOT IN ('bronze', 'silver', 'gold', 'star') THEN RAISE EXCEPTION 'invalid membership tier'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  target_rank := CASE p_target_tier WHEN 'bronze' THEN 1 WHEN 'silver' THEN 2 WHEN 'gold' THEN 3 WHEN 'star' THEN 4 END;
  price := CASE p_target_tier WHEN 'bronze' THEN 10000 WHEN 'silver' THEN 50000 WHEN 'gold' THEN 150000 WHEN 'star' THEN 500000 END;
  new_limit := CASE p_target_tier WHEN 'bronze' THEN 150000 WHEN 'silver' THEN 300000 WHEN 'gold' THEN 700000 WHEN 'star' THEN 2000000000 END;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;
  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_subject_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'membership', p_scope_key, p_subject_key, p_target_tier, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'membership_purchase', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key FOR UPDATE;
  IF account.safe_status <> 'active' THEN RAISE EXCEPTION 'Safe is not active'; END IF;
  current_rank := CASE account.membership_tier WHEN 'basic' THEN 0 WHEN 'bronze' THEN 1 WHEN 'silver' THEN 2 WHEN 'gold' THEN 3 WHEN 'star' THEN 4 ELSE -1 END;
  IF target_rank <= current_rank THEN RAISE EXCEPTION 'membership tier cannot be downgraded or repurchased'; END IF;
  IF account.safe_balance < price THEN RAISE EXCEPTION 'Safe balance is insufficient for membership purchase'; END IF;

  UPDATE public.economy_accounts
  SET membership_tier = p_target_tier,
      safe_limit = new_limit,
      safe_balance = safe_balance - price,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = account.account_id
  RETURNING * INTO account;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reason
  ) VALUES (
    p_operation_key, account.account_id, p_scope_key, p_subject_key, 'membership_purchase', price,
    0, -price, 0, p_reason
  );

  operation_result := jsonb_build_object(
    'status', 'applied', 'account_id', account.account_id,
    'membership_tier', account.membership_tier, 'safe_limit', account.safe_limit,
    'safe_balance', account.safe_balance, 'revision', account.revision
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_create_transfer(
  p_scope_key TEXT,
  p_sender_key TEXT,
  p_recipient_key TEXT,
  p_amount BIGINT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_note TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  policy public.economy_group_policies%ROWTYPE;
  sender public.economy_accounts%ROWTYPE;
  recipient public.economy_accounts%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  transfer public.economy_transfers%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_sender_key IS NULL OR p_sender_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid sender key'; END IF;
  IF p_recipient_key IS NULL OR p_recipient_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recipient key'; END IF;
  IF p_sender_key = p_recipient_key THEN RAISE EXCEPTION 'self transfer is not allowed'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 1000000000 THEN RAISE EXCEPTION 'transfer amount is out of range'; END IF;
  IF char_length(coalesce(p_note, '')) > 500 THEN RAISE EXCEPTION 'transfer note is too long'; END IF;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;
  IF p_amount > policy.max_transfer_amount THEN RAISE EXCEPTION 'transfer exceeds group policy limit'; END IF;

  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_sender_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;
  INSERT INTO public.economy_accounts (scope_key, subject_key, safe_limit)
  VALUES (p_scope_key, p_recipient_key, policy.safe_base_limit)
  ON CONFLICT (scope_key, subject_key) DO NOTHING;

  request_hash := encode(digest(concat_ws('|', 'transfer_create', p_scope_key, p_sender_key, p_recipient_key, p_amount::text, p_actor_key, p_note), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'transfer_create', p_actor_key, request_hash, coalesce(nullif(p_note, ''), 'Transfer Vela'))
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  IF p_sender_key < p_recipient_key THEN
    SELECT * INTO sender FROM public.economy_accounts
    WHERE scope_key = p_scope_key AND subject_key = p_sender_key FOR UPDATE;
    SELECT * INTO recipient FROM public.economy_accounts
    WHERE scope_key = p_scope_key AND subject_key = p_recipient_key FOR UPDATE;
  ELSE
    SELECT * INTO recipient FROM public.economy_accounts
    WHERE scope_key = p_scope_key AND subject_key = p_recipient_key FOR UPDATE;
    SELECT * INTO sender FROM public.economy_accounts
    WHERE scope_key = p_scope_key AND subject_key = p_sender_key FOR UPDATE;
  END IF;
  IF sender.safe_status = 'frozen' OR recipient.safe_status = 'frozen' THEN RAISE EXCEPTION 'account is frozen'; END IF;
  IF p_amount > sender.wallet_balance - sender.restricted_wallet_balance - sender.reserved_wallet_balance THEN RAISE EXCEPTION 'available Wallet balance is insufficient'; END IF;
  IF recipient.wallet_balance - recipient.restricted_wallet_balance - recipient.reserved_wallet_balance + p_amount > 20000 THEN RAISE EXCEPTION 'recipient Wallet capacity is insufficient'; END IF;

  INSERT INTO public.economy_transfers (
    operation_key, scope_key, sender_account_id, recipient_account_id,
    sender_key, recipient_key, amount, context_type, note, expires_at
  ) VALUES (
    p_operation_key, p_scope_key, sender.account_id, recipient.account_id,
    p_sender_key, p_recipient_key, p_amount, 'ic', coalesce(p_note, ''),
    now() + make_interval(secs => policy.transfer_ttl_seconds)
  ) RETURNING * INTO transfer;

  UPDATE public.economy_accounts
  SET reserved_wallet_balance = reserved_wallet_balance + transfer.amount,
      revision = revision + 1,
      updated_at = now()
  WHERE account_id = sender.account_id
  RETURNING * INTO sender;

  INSERT INTO public.economy_ledger_entries (
    operation_key, account_id, scope_key, subject_key, entry_type, amount,
    wallet_delta, safe_delta, restricted_wallet_delta, reserved_wallet_delta,
    counterparty_account_id, reason
  ) VALUES (
    p_operation_key, sender.account_id, p_scope_key, sender.subject_key, 'transfer_reserve', transfer.amount,
    0, 0, 0, transfer.amount, recipient.account_id, coalesce(nullif(p_note, ''), 'Transfer Vela')
  );

  operation_result := jsonb_build_object(
    'status', 'pending', 'transfer_id', transfer.transfer_id,
    'amount', transfer.amount, 'expires_at', transfer.expires_at,
    'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key
  );
  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_accept_transfer(
  p_scope_key TEXT,
  p_transfer_id UUID,
  p_recipient_key TEXT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Transfer Vela diterima'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  policy public.economy_group_policies%ROWTYPE;
  transfer public.economy_transfers%ROWTYPE;
  sender public.economy_accounts%ROWTYPE;
  recipient public.economy_accounts%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_recipient_key IS NULL OR p_recipient_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recipient key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  INSERT INTO public.economy_group_policies (scope_key) VALUES (p_scope_key) ON CONFLICT (scope_key) DO NOTHING;
  SELECT * INTO policy FROM public.economy_group_policies WHERE scope_key = p_scope_key;
  IF NOT policy.enabled THEN RAISE EXCEPTION 'economy is disabled for this group'; END IF;

  request_hash := encode(digest(concat_ws('|', 'transfer_accept', p_scope_key, p_transfer_id::text, p_recipient_key, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'transfer_accept', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO transfer FROM public.economy_transfers
  WHERE transfer_id = p_transfer_id AND scope_key = p_scope_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF transfer.recipient_key <> p_recipient_key THEN RAISE EXCEPTION 'transfer recipient mismatch'; END IF;

  IF transfer.status = 'settled' THEN
    operation_result := jsonb_build_object('status', 'already_settled', 'transfer_id', transfer.transfer_id, 'amount', transfer.amount,
      'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key);
  ELSIF transfer.status <> 'pending' THEN
    operation_result := jsonb_build_object('status', transfer.status, 'transfer_id', transfer.transfer_id,
      'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key);
  ELSIF transfer.expires_at <= now() THEN
    SELECT * INTO sender FROM public.economy_accounts
    WHERE account_id = transfer.sender_account_id FOR UPDATE;
    IF sender.reserved_wallet_balance < transfer.amount THEN RAISE EXCEPTION 'transfer reservation invariant failed'; END IF;

    UPDATE public.economy_accounts
    SET reserved_wallet_balance = reserved_wallet_balance - transfer.amount,
        revision = revision + 1,
        updated_at = now()
    WHERE account_id = sender.account_id;

    INSERT INTO public.economy_ledger_entries (
      operation_key, account_id, scope_key, subject_key, entry_type, amount,
      wallet_delta, safe_delta, restricted_wallet_delta, reserved_wallet_delta,
      counterparty_account_id, reason
    ) VALUES (
      p_operation_key, sender.account_id, p_scope_key, sender.subject_key, 'transfer_release', transfer.amount,
      0, 0, 0, -transfer.amount, transfer.recipient_account_id, 'Transfer Vela kedaluwarsa'
    );

    UPDATE public.economy_transfers SET status = 'expired' WHERE transfer_id = transfer.transfer_id;
    operation_result := jsonb_build_object('status', 'expired', 'transfer_id', transfer.transfer_id,
      'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key);
    UPDATE public.economy_operations SET status = 'expired', result = operation_result, completed_at = now()
    WHERE operation_key = p_operation_key;
    RETURN operation_result;
  ELSE
    IF transfer.sender_account_id < transfer.recipient_account_id THEN
      SELECT * INTO sender FROM public.economy_accounts WHERE account_id = transfer.sender_account_id FOR UPDATE;
      SELECT * INTO recipient FROM public.economy_accounts WHERE account_id = transfer.recipient_account_id FOR UPDATE;
    ELSE
      SELECT * INTO recipient FROM public.economy_accounts WHERE account_id = transfer.recipient_account_id FOR UPDATE;
      SELECT * INTO sender FROM public.economy_accounts WHERE account_id = transfer.sender_account_id FOR UPDATE;
    END IF;

    IF sender.safe_status = 'frozen' OR recipient.safe_status = 'frozen' THEN RAISE EXCEPTION 'account is frozen'; END IF;
    IF sender.wallet_balance - sender.restricted_wallet_balance - sender.reserved_wallet_balance < 0 THEN RAISE EXCEPTION 'sender Wallet balance is invalid'; END IF;
    IF sender.reserved_wallet_balance < transfer.amount THEN RAISE EXCEPTION 'transfer reservation invariant failed'; END IF;
    IF recipient.wallet_balance - recipient.restricted_wallet_balance - recipient.reserved_wallet_balance + transfer.amount > 20000 THEN RAISE EXCEPTION 'recipient Wallet capacity is insufficient'; END IF;

    UPDATE public.economy_accounts
    SET wallet_balance = wallet_balance - transfer.amount,
        reserved_wallet_balance = reserved_wallet_balance - transfer.amount,
        revision = revision + 1,
        updated_at = now()
    WHERE account_id = sender.account_id
    RETURNING * INTO sender;

    UPDATE public.economy_accounts
    SET wallet_balance = wallet_balance + transfer.amount, revision = revision + 1, updated_at = now()
    WHERE account_id = recipient.account_id
    RETURNING * INTO recipient;

    INSERT INTO public.economy_ledger_entries (
      operation_key, account_id, scope_key, subject_key, entry_type, amount,
      wallet_delta, safe_delta, restricted_wallet_delta, counterparty_account_id, reason
    ) VALUES
      (p_operation_key, sender.account_id, p_scope_key, sender.subject_key, 'transfer_debit', transfer.amount,
       -transfer.amount, 0, 0, 0, recipient.account_id, p_reason),
      (p_operation_key, sender.account_id, p_scope_key, sender.subject_key, 'transfer_release', transfer.amount,
       0, 0, 0, -transfer.amount, recipient.account_id, p_reason),
      (p_operation_key, recipient.account_id, p_scope_key, recipient.subject_key, 'transfer_credit', transfer.amount,
       transfer.amount, 0, 0, 0, sender.account_id, p_reason);

    UPDATE public.economy_transfers
    SET status = 'settled', settled_at = now()
    WHERE transfer_id = transfer.transfer_id;

    operation_result := jsonb_build_object(
      'status', 'settled', 'transfer_id', transfer.transfer_id,
      'amount', transfer.amount, 'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key
    );
  END IF;

  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_reject_transfer(
  p_scope_key TEXT,
  p_transfer_id UUID,
  p_recipient_key TEXT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Transfer Vela ditolak'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  transfer public.economy_transfers%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_recipient_key IS NULL OR p_recipient_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recipient key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  request_hash := encode(digest(concat_ws('|', 'transfer_reject', p_scope_key, p_transfer_id::text, p_recipient_key, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'transfer_reject', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO transfer FROM public.economy_transfers
  WHERE transfer_id = p_transfer_id AND scope_key = p_scope_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF transfer.recipient_key <> p_recipient_key THEN RAISE EXCEPTION 'transfer recipient mismatch'; END IF;

  IF transfer.status = 'pending' THEN
    SELECT * INTO sender FROM public.economy_accounts
    WHERE account_id = transfer.sender_account_id FOR UPDATE;
    IF sender.reserved_wallet_balance < transfer.amount THEN RAISE EXCEPTION 'transfer reservation invariant failed'; END IF;

    UPDATE public.economy_accounts
    SET reserved_wallet_balance = reserved_wallet_balance - transfer.amount,
        revision = revision + 1,
        updated_at = now()
    WHERE account_id = sender.account_id;

    INSERT INTO public.economy_ledger_entries (
      operation_key, account_id, scope_key, subject_key, entry_type, amount,
      wallet_delta, safe_delta, restricted_wallet_delta, reserved_wallet_delta,
      counterparty_account_id, reason
    ) VALUES (
      p_operation_key, sender.account_id, p_scope_key, sender.subject_key, 'transfer_release', transfer.amount,
      0, 0, 0, -transfer.amount, transfer.recipient_account_id, p_reason
    );

    UPDATE public.economy_transfers SET status = 'rejected' WHERE transfer_id = transfer.transfer_id;
    operation_result := jsonb_build_object('status', 'rejected', 'transfer_id', transfer.transfer_id,
      'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key);
  ELSE
    operation_result := jsonb_build_object('status', transfer.status, 'transfer_id', transfer.transfer_id,
      'sender_key', transfer.sender_key, 'recipient_key', transfer.recipient_key);
  END IF;

  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_sweep_overage(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT DEFAULT 'Penyitaan Wallet setelah masa tenggang'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  account public.economy_accounts%ROWTYPE;
  operation public.economy_operations%ROWTYPE;
  operation_result JSONB;
  request_hash TEXT;
  seized BIGINT;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy scope key'; END IF;
  IF p_subject_key IS NULL OR p_subject_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy subject key'; END IF;
  IF p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid economy actor key'; END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' THEN RAISE EXCEPTION 'invalid economy operation key'; END IF;
  IF char_length(coalesce(p_reason, '')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid economy operation reason'; END IF;

  request_hash := encode(digest(concat_ws('|', 'overage_seizure', p_scope_key, p_subject_key, p_actor_key, p_reason), 'sha256'), 'hex');

  INSERT INTO public.economy_operations (operation_key, scope_key, operation_type, actor_key, request_hash, reason)
  VALUES (p_operation_key, p_scope_key, 'overage_seizure', p_actor_key, request_hash, p_reason)
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO operation FROM public.economy_operations WHERE operation_key = p_operation_key;
  IF operation.request_hash <> request_hash THEN RAISE EXCEPTION 'economy operation payload mismatch'; END IF;
  IF operation.status = 'applied' THEN RETURN coalesce(operation.result, '{}'::jsonb); END IF;
  IF operation.status <> 'pending' THEN RAISE EXCEPTION 'economy operation cannot be replayed'; END IF;

  SELECT * INTO account FROM public.economy_accounts
  WHERE scope_key = p_scope_key AND subject_key = p_subject_key FOR UPDATE;
  IF NOT FOUND THEN
    operation_result := jsonb_build_object('status', 'nothing_to_sweep');
  ELSIF account.restricted_wallet_balance = 0 THEN
    operation_result := jsonb_build_object('status', 'nothing_to_sweep', 'account_id', account.account_id);
  ELSIF account.overage_deadline_at IS NULL OR account.overage_deadline_at > now() THEN
    operation_result := jsonb_build_object('status', 'grace_period', 'account_id', account.account_id, 'deadline_at', account.overage_deadline_at);
  ELSE
    seized := account.restricted_wallet_balance;
    UPDATE public.economy_accounts
    SET wallet_balance = wallet_balance - seized,
        restricted_wallet_balance = 0,
        overage_deadline_at = NULL,
        revision = revision + 1,
        updated_at = now()
    WHERE account_id = account.account_id
    RETURNING * INTO account;

    INSERT INTO public.economy_ledger_entries (
      operation_key, account_id, scope_key, subject_key, entry_type, amount,
      wallet_delta, safe_delta, restricted_wallet_delta, reason
    ) VALUES (
      p_operation_key, account.account_id, p_scope_key, p_subject_key, 'seizure', seized,
      -seized, 0, -seized, p_reason
    );

    operation_result := jsonb_build_object('status', 'seized', 'account_id', account.account_id, 'amount', seized, 'revision', account.revision);
  END IF;

  UPDATE public.economy_operations SET status = 'applied', result = operation_result, completed_at = now()
  WHERE operation_key = p_operation_key;
  RETURN operation_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.economy_get_history(
  p_scope_key TEXT,
  p_subject_key TEXT,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  entry_id UUID,
  entry_type TEXT,
  amount BIGINT,
  wallet_delta BIGINT,
  safe_delta BIGINT,
  reserved_wallet_delta BIGINT,
  reason TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT entry_id, entry_type, amount, wallet_delta, safe_delta, reserved_wallet_delta, reason, created_at
  FROM public.economy_ledger_entries
  WHERE scope_key = p_scope_key
    AND subject_key = p_subject_key
  ORDER BY created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

REVOKE ALL ON FUNCTION public.economy_get_account_snapshot(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_set_group_policy(TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_open_safe(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_grant_reward(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_deposit(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_withdraw(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_upgrade_membership(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_create_transfer(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_accept_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_reject_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_sweep_overage(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.economy_get_history(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.economy_get_account_snapshot(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_set_group_policy(TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_open_safe(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_grant_reward(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_deposit(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_withdraw(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_upgrade_membership(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_create_transfer(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_accept_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_reject_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_sweep_overage(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.economy_get_history(TEXT, TEXT, INTEGER) TO service_role;

COMMIT;
