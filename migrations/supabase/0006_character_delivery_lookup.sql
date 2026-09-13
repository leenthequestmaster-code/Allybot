-- Migration ID: 0006_character_delivery_lookup
-- Adds read-only RPCs required by the Character Guide runtime.

BEGIN;

CREATE OR REPLACE FUNCTION public.character_registration_get(p_guide_key TEXT, p_owner_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE current_row RECORD;
BEGIN
  IF p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;
  SELECT * INTO current_row FROM public.character_registration_sessions
  WHERE guide_key = p_guide_key AND owner_key = p_owner_key AND status IN ('awaiting_id_card_reply', 'validated')
  ORDER BY created_at DESC LIMIT 1;
  IF current_row.session_id IS NULL THEN RETURN jsonb_build_object('ok', true, 'code', 'not_found'); END IF;
  IF current_row.expires_at <= now() THEN
    UPDATE public.character_registration_sessions SET status = 'expired', revision = revision + 1, updated_at = now() WHERE session_id = current_row.session_id;
    RETURN jsonb_build_object('ok', true, 'code', 'expired');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'found', 'session_id', current_row.session_id, 'quoted_reference_key', current_row.quoted_reference_key, 'expires_at', current_row.expires_at, 'revision', current_row.revision);
END;
$$;

CREATE OR REPLACE FUNCTION public.character_delivery_pending(p_guide_key TEXT, p_owner_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE result JSONB;
BEGIN
  IF p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity');
  END IF;
  SELECT jsonb_build_object('ok', true, 'code', 'found', 'delivery_id', delivery_id, 'character_id', character_id, 'attempts', attempts)
  INTO result
  FROM public.character_delivery_outbox
  WHERE guide_key = p_guide_key AND owner_key = p_owner_key AND status IN ('pending', 'failed') AND attempts < 5
  ORDER BY created_at DESC LIMIT 1;
  RETURN COALESCE(result, jsonb_build_object('ok', true, 'code', 'not_found'));
END;
$$;

GRANT EXECUTE ON FUNCTION public.character_registration_get(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.character_delivery_pending(TEXT, TEXT) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
