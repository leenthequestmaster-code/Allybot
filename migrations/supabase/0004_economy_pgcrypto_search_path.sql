-- Migration ID: 0004_economy_pgcrypto_search_path
-- Apply after 0001, 0002, and 0003.
--
-- Supabase installs pgcrypto in the extensions schema. The Economy RPCs use
-- digest() for request fingerprints, so include extensions in each function's
-- controlled search_path. This changes function configuration only; it does
-- not create, update, or delete Economy rows.

BEGIN;

ALTER FUNCTION public.economy_set_group_policy(text, boolean, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_open_safe(text, text, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_grant_reward(text, text, bigint, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_deposit(text, text, bigint, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_withdraw(text, text, bigint, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_upgrade_membership(text, text, text, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_create_transfer(text, text, text, bigint, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_accept_transfer(text, uuid, text, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_reject_transfer(text, uuid, text, text, text, text)
  SET search_path = public, extensions;
ALTER FUNCTION public.economy_sweep_overage(text, text, text, text, text)
  SET search_path = public, extensions;

NOTIFY pgrst, 'reload schema';

COMMIT;
