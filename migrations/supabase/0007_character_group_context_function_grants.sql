-- Migration ID: 0007_character_group_context_function_grants
-- Hardens RPC privileges after 0005/0006: only server-side service_role may execute them.

BEGIN;

REVOKE ALL ON FUNCTION public.group_context_get(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_context_set(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_ooc_allowlist_check(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_ooc_allowlist_list(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_ooc_allowlist_set(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_ooc_allowlist_remove(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_ooc_allowlist_clear(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_registration_start(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_registration_cancel(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_save(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_get_active(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_retire(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_delivery_mark(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_registration_get(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.character_delivery_pending(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.group_context_get(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_context_set(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_ooc_allowlist_check(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_ooc_allowlist_list(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_ooc_allowlist_set(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_ooc_allowlist_remove(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_ooc_allowlist_clear(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_registration_start(TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_registration_cancel(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_save(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_get_active(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_retire(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_delivery_mark(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_registration_get(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_delivery_pending(TEXT, TEXT) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
