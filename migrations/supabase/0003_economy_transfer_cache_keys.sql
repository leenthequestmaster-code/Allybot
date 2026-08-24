-- Migration ID: 0003_economy_transfer_cache_keys
-- Apply after 0001_economy_schema.sql and 0002_economy_functions.sql.
--
-- This additive migration refreshes only transfer terminal-state RPCs so their
-- JSON response includes hashed sender/recipient keys for cache invalidation.
-- It does not return raw WhatsApp identifiers or modify account balances by itself.

BEGIN;

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

REVOKE ALL ON FUNCTION public.economy_accept_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_accept_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

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
  sender public.economy_accounts%ROWTYPE;
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

REVOKE ALL ON FUNCTION public.economy_reject_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_reject_transfer(TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
