-- Migration ID: 0005_character_guide_group_context
-- Creates Character Guide and Group Context storage without seed or user data.
-- All WhatsApp identities are SHA-256 keys; raw JIDs are never stored.

BEGIN;

CREATE TABLE IF NOT EXISTS public.group_contexts (
  group_key TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'normal',
  ic_subtype TEXT,
  ooc_policy TEXT NOT NULL DEFAULT 'disabled',
  revision BIGINT NOT NULL DEFAULT 1,
  changed_by_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT group_contexts_group_key_format CHECK (group_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_contexts_mode_valid CHECK (mode IN ('normal', 'ooc', 'guide', 'ic')),
  CONSTRAINT group_contexts_ic_subtype_valid CHECK (
    ic_subtype IS NULL OR ic_subtype IN (
      'bank', 'market', 'miningplace', 'fishingplace', 'divingplace',
      'gatheringplace', 'dungeon', 'other', 'story_event'
    )
  ),
  CONSTRAINT group_contexts_mode_subtype_consistent CHECK (
    (mode = 'ic' AND ic_subtype IS NOT NULL)
    OR (mode <> 'ic' AND ic_subtype IS NULL)
  ),
  CONSTRAINT group_contexts_ooc_policy_valid CHECK (ooc_policy IN ('disabled', 'strict', 'permissive')),
  CONSTRAINT group_contexts_changed_by_key_format CHECK (changed_by_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_contexts_revision_valid CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS public.group_context_operations (
  operation_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT group_context_operations_key_format CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  CONSTRAINT group_context_operations_group_key_format CHECK (group_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_context_operations_actor_key_format CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_context_operations_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.group_context_audit_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL REFERENCES public.group_context_operations(operation_key),
  group_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  old_mode TEXT,
  old_ic_subtype TEXT,
  new_mode TEXT NOT NULL,
  new_ic_subtype TEXT,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT group_context_audit_group_key_format CHECK (group_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_context_audit_actor_key_format CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_context_audit_outcome_valid CHECK (outcome IN ('changed', 'unchanged', 'rejected'))
);

CREATE TABLE IF NOT EXISTS public.group_ooc_allowlist (
  group_key TEXT NOT NULL,
  member_key TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'narrator',
  reason_code TEXT NOT NULL DEFAULT 'narrator_access',
  added_by_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_key, member_key),
  CONSTRAINT group_ooc_allowlist_group_key_format CHECK (group_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_ooc_allowlist_member_key_format CHECK (member_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_ooc_allowlist_added_by_key_format CHECK (added_by_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_ooc_allowlist_role_valid CHECK (role IN ('narrator', 'moderator', 'admin', 'custom')),
  CONSTRAINT group_ooc_allowlist_reason_length CHECK (char_length(reason_code) BETWEEN 1 AND 80),
  CONSTRAINT group_ooc_allowlist_revision_valid CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS public.character_registration_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_key TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  quoted_reference_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_id_card_reply',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_sessions_guide_key_format CHECK (guide_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_sessions_owner_key_format CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_sessions_reference_key_format CHECK (quoted_reference_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_sessions_status_valid CHECK (status IN ('awaiting_id_card_reply', 'validated', 'completed', 'cancelled', 'expired')),
  CONSTRAINT character_sessions_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT character_sessions_revision_valid CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS character_sessions_one_open_per_owner
  ON public.character_registration_sessions (guide_key, owner_key)
  WHERE status IN ('awaiting_id_card_reply', 'validated');

CREATE TABLE IF NOT EXISTS public.character_profiles (
  character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_key TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  registration_session_id UUID NOT NULL REFERENCES public.character_registration_sessions(session_id),
  name TEXT NOT NULL,
  gender TEXT NOT NULL,
  age INTEGER NOT NULL,
  birthday_day INTEGER NOT NULL,
  birthday_month TEXT NOT NULL,
  birthday_year INTEGER NOT NULL,
  race TEXT NOT NULL,
  class_name TEXT NOT NULL,
  element TEXT NOT NULL,
  spirit TEXT,
  crew TEXT,
  rank TEXT NOT NULL DEFAULT 'F-',
  level INTEGER NOT NULL DEFAULT 1,
  will_of_path TEXT NOT NULL,
  profession TEXT,
  titles JSONB NOT NULL DEFAULT '["Allyssea Citizens"]'::jsonb,
  motto TEXT,
  visual TEXT,
  origin TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_profiles_guide_key_format CHECK (guide_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_profiles_owner_key_format CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_profiles_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT character_profiles_gender_valid CHECK (gender IN ('Male', 'Female', 'Non-Binary')),
  CONSTRAINT character_profiles_age_valid CHECK (age BETWEEN 5 AND 500),
  CONSTRAINT character_profiles_birthday_day_valid CHECK (birthday_day BETWEEN 1 AND 31),
  CONSTRAINT character_profiles_birthday_month_valid CHECK (birthday_month IN ('Aurion', 'Florentis', 'Zephyra', 'Emberfall', 'Luminara', 'Verdantia', 'Solmora', 'Astravia', 'Umbralis', 'Crystelle', 'Nocturne', 'Everglen')),
  CONSTRAINT character_profiles_birthday_year_valid CHECK (birthday_year BETWEEN 300 AND 800),
  CONSTRAINT character_profiles_birthday_age_consistent CHECK (birthday_year = 800 - age),
  CONSTRAINT character_profiles_race_valid CHECK (race IN ('Human', 'Elf', 'Dark Elf', 'Dwarf', 'Giant', 'Orc', 'Fairy', 'Vampire', 'Pisces', 'Harpy', 'Slime', 'Dragonborn', 'Beastfolk', 'Kitsune', 'Dryad', 'Demon', 'Angel')),
  CONSTRAINT character_profiles_class_length CHECK (char_length(class_name) BETWEEN 2 AND 40),
  CONSTRAINT character_profiles_element_valid CHECK (element IN ('Fire', 'Water', 'Wind', 'Earth', 'Nature', 'Electro', 'Ice', 'Dark', 'Light', 'Sound', 'Blood', 'Bone', 'Sand', 'Mist', 'Fruits', 'Paper', 'Magma', 'Gel')),
  CONSTRAINT character_profiles_element_race_lock CHECK (
    (element NOT IN ('Nature', 'Blood', 'Gel'))
    OR (element = 'Nature' AND race IN ('Dryad', 'Elf'))
    OR (element = 'Blood' AND race = 'Vampire')
    OR (element = 'Gel' AND race = 'Slime')
  ),
  CONSTRAINT character_profiles_rank_initial_valid CHECK (rank = 'F-'),
  CONSTRAINT character_profiles_level_initial_valid CHECK (level = 1),
  CONSTRAINT character_profiles_will_valid CHECK (will_of_path IN ('Light', 'Dark', 'Neutral')),
  CONSTRAINT character_profiles_titles_array CHECK (jsonb_typeof(titles) = 'array'),
  CONSTRAINT character_profiles_text_lengths CHECK (
    (spirit IS NULL OR char_length(spirit) <= 120)
    AND (crew IS NULL OR char_length(crew) <= 120)
    AND (profession IS NULL OR char_length(profession) <= 120)
    AND (motto IS NULL OR char_length(motto) <= 500)
    AND (visual IS NULL OR char_length(visual) <= 160)
    AND (origin IS NULL OR char_length(origin) <= 160)
  ),
  CONSTRAINT character_profiles_status_valid CHECK (status IN ('active', 'dead', 'missing', 'off')),
  CONSTRAINT character_profiles_revision_valid CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS character_profiles_one_active_per_owner
  ON public.character_profiles (guide_key, owner_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.character_operations (
  operation_key TEXT PRIMARY KEY,
  session_id UUID REFERENCES public.character_registration_sessions(session_id),
  owner_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_operations_key_format CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  CONSTRAINT character_operations_owner_key_format CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_operations_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.character_lifecycle_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES public.character_profiles(character_id),
  operation_key TEXT NOT NULL REFERENCES public.character_operations(operation_key),
  actor_key TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_lifecycle_actor_key_format CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_lifecycle_status_valid CHECK (to_status IN ('active', 'dead', 'missing', 'off')),
  CONSTRAINT character_lifecycle_reason_length CHECK (char_length(reason_code) BETWEEN 1 AND 120)
);

CREATE TABLE IF NOT EXISTS public.character_delivery_outbox (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES public.character_profiles(character_id),
  owner_key TEXT NOT NULL,
  guide_key TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'your_character_guide',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_delivery_unique_type UNIQUE (character_id, message_type),
  CONSTRAINT character_delivery_owner_key_format CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_delivery_guide_key_format CHECK (guide_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT character_delivery_type_valid CHECK (message_type IN ('your_character_guide')),
  CONSTRAINT character_delivery_status_valid CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT character_delivery_attempts_valid CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX IF NOT EXISTS group_ooc_allowlist_active_idx
  ON public.group_ooc_allowlist (group_key, member_key, expires_at);
CREATE INDEX IF NOT EXISTS character_profiles_owner_status_idx
  ON public.character_profiles (guide_key, owner_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS character_profiles_group_status_idx
  ON public.character_profiles (guide_key, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS character_lifecycle_character_created_idx
  ON public.character_lifecycle_events (character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS character_delivery_pending_idx
  ON public.character_delivery_outbox (status, next_attempt_at);

ALTER TABLE public.group_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_context_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_context_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_ooc_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_registration_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_delivery_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.group_contexts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.group_context_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.group_context_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.group_ooc_allowlist FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.character_registration_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.character_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.character_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.character_lifecycle_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.character_delivery_outbox FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.group_contexts TO service_role;
GRANT SELECT, INSERT ON TABLE public.group_context_operations TO service_role;
GRANT SELECT, INSERT ON TABLE public.group_context_audit_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.group_ooc_allowlist TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.character_registration_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.character_profiles TO service_role;
GRANT SELECT, INSERT ON TABLE public.character_operations TO service_role;
GRANT SELECT, INSERT ON TABLE public.character_lifecycle_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.character_delivery_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.group_context_get(p_group_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  result JSONB;
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_group_key');
  END IF;
  SELECT jsonb_build_object(
    'ok', true,
    'group_key', group_key,
    'mode', mode,
    'ic_subtype', ic_subtype,
    'ooc_policy', ooc_policy,
    'revision', revision,
    'updated_at', updated_at
  ) INTO result
  FROM public.group_contexts
  WHERE group_key = p_group_key;
  RETURN COALESCE(result, jsonb_build_object('ok', true, 'group_key', p_group_key, 'mode', 'normal', 'ic_subtype', NULL, 'ooc_policy', 'disabled', 'revision', 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.group_context_set(
  p_group_key TEXT,
  p_mode TEXT,
  p_ic_subtype TEXT,
  p_ooc_policy TEXT,
  p_actor_key TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  previous RECORD;
  result JSONB;
  normalized_subtype TEXT;
  normalized_policy TEXT;
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' OR p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity');
  END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_operation');
  END IF;
  SELECT o.result INTO result FROM public.group_context_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  IF COALESCE(p_mode, '') NOT IN ('normal', 'ooc', 'guide', 'ic') THEN
    result := jsonb_build_object('ok', false, 'code', 'invalid_mode');
  ELSE
    normalized_subtype := NULLIF(lower(trim(COALESCE(p_ic_subtype, ''))), '');
    normalized_policy := lower(trim(COALESCE(p_ooc_policy, 'disabled')));
    IF p_mode = 'ic' AND normalized_subtype NOT IN ('bank', 'market', 'miningplace', 'fishingplace', 'divingplace', 'gatheringplace', 'dungeon', 'other', 'story_event') THEN
      result := jsonb_build_object('ok', false, 'code', 'invalid_ic_subtype');
    ELSIF p_mode <> 'ic' AND normalized_subtype IS NOT NULL THEN
      result := jsonb_build_object('ok', false, 'code', 'subtype_requires_ic');
    ELSIF normalized_policy NOT IN ('disabled', 'strict', 'permissive') THEN
      result := jsonb_build_object('ok', false, 'code', 'invalid_ooc_policy');
    ELSE
      IF p_mode IN ('normal', 'guide', 'ooc') THEN normalized_subtype := NULL; END IF;
      IF p_mode IN ('normal', 'guide', 'ooc') THEN normalized_policy := CASE WHEN p_mode = 'ooc' THEN 'disabled' ELSE 'disabled' END; END IF;
      SELECT * INTO previous FROM public.group_contexts WHERE group_key = p_group_key FOR UPDATE;
      IF previous.group_key IS NULL THEN
        INSERT INTO public.group_contexts (group_key, mode, ic_subtype, ooc_policy, changed_by_key)
        VALUES (p_group_key, p_mode, normalized_subtype, normalized_policy, p_actor_key);
        result := jsonb_build_object('ok', true, 'code', 'changed', 'mode', p_mode, 'ic_subtype', normalized_subtype, 'ooc_policy', normalized_policy, 'revision', 1);
      ELSE
        UPDATE public.group_contexts
        SET mode = p_mode, ic_subtype = normalized_subtype, ooc_policy = normalized_policy, revision = previous.revision + 1, changed_by_key = p_actor_key, updated_at = now()
        WHERE group_key = p_group_key;
        result := jsonb_build_object('ok', true, 'code', CASE WHEN previous.mode = p_mode AND previous.ic_subtype IS NOT DISTINCT FROM normalized_subtype AND previous.ooc_policy = normalized_policy THEN 'unchanged' ELSE 'changed' END, 'mode', p_mode, 'ic_subtype', normalized_subtype, 'ooc_policy', normalized_policy, 'revision', previous.revision + 1);
      END IF;
      INSERT INTO public.group_context_operations (operation_key, group_key, actor_key, request_hash, result) VALUES (p_operation_key, p_group_key, p_actor_key, p_request_hash, result);
      INSERT INTO public.group_context_audit_events (operation_key, group_key, actor_key, old_mode, old_ic_subtype, new_mode, new_ic_subtype, outcome)
      VALUES (p_operation_key, p_group_key, p_actor_key, previous.mode, previous.ic_subtype, p_mode, normalized_subtype, CASE WHEN result->>'code' = 'unchanged' THEN 'unchanged' ELSE 'changed' END);
    END IF;
  END IF;
  IF result->>'ok' = 'false' THEN
    INSERT INTO public.group_context_operations (operation_key, group_key, actor_key, request_hash, result) VALUES (p_operation_key, p_group_key, p_actor_key, p_request_hash, result);
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.group_ooc_allowlist_check(p_group_key TEXT, p_member_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' OR p_member_key IS NULL OR p_member_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity', 'allowed', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'allowed', EXISTS (
    SELECT 1 FROM public.group_ooc_allowlist
    WHERE group_key = p_group_key AND member_key = p_member_key AND (expires_at IS NULL OR expires_at > now())
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.group_ooc_allowlist_set(
  p_group_key TEXT,
  p_member_key TEXT,
  p_role TEXT,
  p_reason_code TEXT,
  p_expires_at TIMESTAMPTZ,
  p_actor_key TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  result JSONB;
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' OR p_member_key IS NULL OR p_member_key !~ '^[0-9a-f]{64}$' OR p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity');
  END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_operation');
  END IF;
  SELECT o.result INTO result FROM public.group_context_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  IF p_role NOT IN ('narrator', 'moderator', 'admin', 'custom') THEN
    result := jsonb_build_object('ok', false, 'code', 'invalid_role');
  ELSE
    INSERT INTO public.group_ooc_allowlist (group_key, member_key, role, reason_code, added_by_key, expires_at, revision, updated_at)
    VALUES (p_group_key, p_member_key, p_role, left(COALESCE(NULLIF(trim(p_reason_code), ''), 'narrator_access'), 80), p_actor_key, p_expires_at, 1, now())
    ON CONFLICT (group_key, member_key) DO UPDATE SET role = EXCLUDED.role, reason_code = EXCLUDED.reason_code, added_by_key = EXCLUDED.added_by_key, expires_at = EXCLUDED.expires_at, revision = group_ooc_allowlist.revision + 1, updated_at = now();
    result := jsonb_build_object('ok', true, 'code', 'changed');
  END IF;
  INSERT INTO public.group_context_operations (operation_key, group_key, actor_key, request_hash, result) VALUES (p_operation_key, p_group_key, p_actor_key, p_request_hash, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.group_ooc_allowlist_list(p_group_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_group_key', 'entries', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('member_key', member_key, 'role', role, 'reason_code', reason_code, 'expires_at', expires_at) ORDER BY member_key)
      FROM public.group_ooc_allowlist
      WHERE group_key = p_group_key AND (expires_at IS NULL OR expires_at > now())
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.group_ooc_allowlist_remove(
  p_group_key TEXT,
  p_member_key TEXT,
  p_actor_key TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  result JSONB;
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' OR p_member_key IS NULL OR p_member_key !~ '^[0-9a-f]{64}$' OR p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity');
  END IF;
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_operation');
  END IF;
  SELECT o.result INTO result FROM public.group_context_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  UPDATE public.group_ooc_allowlist SET expires_at = now(), revision = revision + 1, updated_at = now() WHERE group_key = p_group_key AND member_key = p_member_key;
  result := jsonb_build_object('ok', true, 'code', 'removed');
  INSERT INTO public.group_context_operations (operation_key, group_key, actor_key, request_hash, result) VALUES (p_operation_key, p_group_key, p_actor_key, p_request_hash, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.group_ooc_allowlist_clear(
  p_group_key TEXT,
  p_actor_key TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE result JSONB;
BEGIN
  IF p_group_key IS NULL OR p_group_key !~ '^[0-9a-f]{64}$' OR p_actor_key IS NULL OR p_actor_key !~ '^[0-9a-f]{64}$' OR p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;
  SELECT o.result INTO result FROM public.group_context_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  UPDATE public.group_ooc_allowlist SET expires_at = now(), revision = revision + 1, updated_at = now()
  WHERE group_key = p_group_key AND (expires_at IS NULL OR expires_at > now());
  result := jsonb_build_object('ok', true, 'code', 'cleared');
  INSERT INTO public.group_context_operations (operation_key, group_key, actor_key, request_hash, result) VALUES (p_operation_key, p_group_key, p_actor_key, p_request_hash, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.character_registration_start(
  p_guide_key TEXT,
  p_owner_key TEXT,
  p_quoted_reference_key TEXT,
  p_ttl_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  existing RECORD;
  new_id UUID;
BEGIN
  IF p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' OR p_quoted_reference_key IS NULL OR p_quoted_reference_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity');
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 300 AND 86400 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_ttl');
  END IF;
  SELECT session_id, quoted_reference_key, status, expires_at INTO existing
  FROM public.character_registration_sessions
  WHERE guide_key = p_guide_key AND owner_key = p_owner_key AND status IN ('awaiting_id_card_reply', 'validated')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF existing.session_id IS NOT NULL THEN
    IF existing.expires_at > now() THEN
      RETURN jsonb_build_object('ok', true, 'code', 'existing', 'session_id', existing.session_id, 'quoted_reference_key', existing.quoted_reference_key, 'expires_at', existing.expires_at);
    END IF;
    UPDATE public.character_registration_sessions SET status = 'expired', revision = revision + 1, updated_at = now() WHERE session_id = existing.session_id;
  END IF;
  INSERT INTO public.character_registration_sessions (guide_key, owner_key, quoted_reference_key, expires_at)
  VALUES (p_guide_key, p_owner_key, p_quoted_reference_key, now() + make_interval(secs => p_ttl_seconds))
  RETURNING session_id INTO new_id;
  RETURN jsonb_build_object('ok', true, 'code', 'created', 'session_id', new_id, 'quoted_reference_key', p_quoted_reference_key, 'expires_at', now() + make_interval(secs => p_ttl_seconds));
END;
$$;

CREATE OR REPLACE FUNCTION public.character_save(
  p_session_id UUID,
  p_guide_key TEXT,
  p_owner_key TEXT,
  p_quoted_reference_key TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  session_row RECORD;
  active_row RECORD;
  character_id UUID;
  delivery_id UUID;
  result JSONB;
  normalized_gender TEXT;
  normalized_race TEXT;
  normalized_element TEXT;
  normalized_will TEXT;
  normalized_month TEXT;
  normalized_class TEXT;
  birthday_day INTEGER;
  birthday_year INTEGER;
  age_value INTEGER;
  spirit_value TEXT;
  crew_value TEXT;
  profession_value TEXT;
  motto_value TEXT;
  visual_value TEXT;
  origin_value TEXT;
BEGIN
  IF p_session_id IS NULL OR p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' OR p_quoted_reference_key IS NULL OR p_quoted_reference_key !~ '^[0-9a-f]{64}$' OR p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;
  SELECT o.result INTO result FROM public.character_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  SELECT * INTO session_row FROM public.character_registration_sessions WHERE session_id = p_session_id FOR UPDATE;
  IF session_row.session_id IS NULL OR session_row.guide_key <> p_guide_key OR session_row.owner_key <> p_owner_key OR session_row.quoted_reference_key <> p_quoted_reference_key THEN
    result := jsonb_build_object('ok', false, 'code', 'wrong_registration_session');
  ELSIF session_row.expires_at <= now() THEN
    UPDATE public.character_registration_sessions SET status = 'expired', revision = revision + 1, updated_at = now() WHERE session_id = p_session_id;
    result := jsonb_build_object('ok', false, 'code', 'session_expired');
  ELSIF session_row.status = 'completed' THEN
    result := jsonb_build_object('ok', false, 'code', 'session_completed');
  ELSE
    normalized_gender := initcap(lower(trim(COALESCE(p_payload->>'gender', ''))));
    IF normalized_gender = 'Non-binary' THEN normalized_gender := 'Non-Binary'; END IF;
    normalized_race := initcap(lower(trim(COALESCE(p_payload->>'race', ''))));
    normalized_element := initcap(lower(trim(COALESCE(p_payload->>'element', ''))));
    normalized_will := initcap(lower(trim(COALESCE(p_payload->>'will_of_path', ''))));
    normalized_month := initcap(lower(trim(COALESCE(p_payload->>'birthday_month', ''))));
    normalized_class := left(trim(COALESCE(p_payload->>'class_name', '')), 40);
    age_value := NULLIF(trim(COALESCE(p_payload->>'age', '')), '')::INTEGER;
    birthday_day := NULLIF(trim(COALESCE(p_payload->>'birthday_day', '')), '')::INTEGER;
    birthday_year := NULLIF(trim(COALESCE(p_payload->>'birthday_year', '')), '')::INTEGER;
    spirit_value := NULLIF(left(trim(COALESCE(p_payload->>'spirit', '')), 120), '');
    crew_value := NULLIF(left(trim(COALESCE(p_payload->>'crew', '')), 120), '');
    profession_value := NULLIF(left(trim(COALESCE(p_payload->>'profession', '')), 120), '');
    motto_value := NULLIF(left(trim(COALESCE(p_payload->>'motto', '')), 500), '');
    visual_value := NULLIF(left(trim(COALESCE(p_payload->>'visual', '')), 160), '');
    origin_value := NULLIF(left(trim(COALESCE(p_payload->>'origin', '')), 160), '');
    IF NULLIF(trim(COALESCE(p_payload->>'name', '')), '') IS NULL THEN
      result := jsonb_build_object('ok', false, 'code', 'name_required');
    ELSIF normalized_gender NOT IN ('Male', 'Female', 'Non-Binary') THEN
      result := jsonb_build_object('ok', false, 'code', 'gender_invalid');
    ELSIF age_value IS NULL OR age_value NOT BETWEEN 5 AND 500 THEN
      result := jsonb_build_object('ok', false, 'code', 'age_invalid');
    ELSIF birthday_day IS NULL OR birthday_day NOT BETWEEN 1 AND 31 OR normalized_month NOT IN ('Aurion', 'Florentis', 'Zephyra', 'Emberfall', 'Luminara', 'Verdantia', 'Solmora', 'Astravia', 'Umbralis', 'Crystelle', 'Nocturne', 'Everglen') OR birthday_year IS NULL OR birthday_year <> 800 - age_value THEN
      result := jsonb_build_object('ok', false, 'code', 'birthday_invalid');
    ELSIF normalized_race NOT IN ('Human', 'Elf', 'Dark Elf', 'Dwarf', 'Giant', 'Orc', 'Fairy', 'Vampire', 'Pisces', 'Harpy', 'Slime', 'Dragonborn', 'Beastfolk', 'Kitsune', 'Dryad', 'Demon', 'Angel') THEN
      result := jsonb_build_object('ok', false, 'code', 'race_invalid');
    ELSIF normalized_element NOT IN ('Fire', 'Water', 'Wind', 'Earth', 'Nature', 'Electro', 'Ice', 'Dark', 'Light', 'Sound', 'Blood', 'Bone', 'Sand', 'Mist', 'Fruits', 'Paper', 'Magma', 'Gel') OR (normalized_element = 'Nature' AND normalized_race NOT IN ('Dryad', 'Elf')) OR (normalized_element = 'Blood' AND normalized_race <> 'Vampire') OR (normalized_element = 'Gel' AND normalized_race <> 'Slime') THEN
      result := jsonb_build_object('ok', false, 'code', 'element_invalid_or_locked');
    ELSIF char_length(normalized_class) < 2 OR normalized_class !~ '^[A-Za-z][A-Za-z -]{1,39}$' THEN
      result := jsonb_build_object('ok', false, 'code', 'class_invalid');
    ELSIF normalized_will NOT IN ('Light', 'Dark', 'Neutral') THEN
      result := jsonb_build_object('ok', false, 'code', 'will_of_path_invalid');
    ELSE
      SELECT character_id INTO active_row FROM public.character_profiles WHERE guide_key = p_guide_key AND owner_key = p_owner_key AND status = 'active' LIMIT 1 FOR UPDATE;
      IF active_row.character_id IS NOT NULL THEN
        result := jsonb_build_object('ok', false, 'code', 'active_character_exists');
      ELSE
        INSERT INTO public.character_profiles (
          guide_key, owner_key, registration_session_id, name, gender, age, birthday_day, birthday_month, birthday_year,
          race, class_name, element, spirit, crew, will_of_path, profession, motto, visual, origin
        ) VALUES (
          p_guide_key, p_owner_key, p_session_id, left(trim(p_payload->>'name'), 60), normalized_gender, age_value,
          birthday_day, normalized_month, birthday_year, normalized_race, normalized_class, normalized_element,
          spirit_value, crew_value, normalized_will, profession_value, motto_value, visual_value, origin_value
        ) RETURNING character_id INTO character_id;
        INSERT INTO public.character_operations (operation_key, session_id, owner_key, request_hash, result)
        VALUES (p_operation_key, p_session_id, p_owner_key, p_request_hash, jsonb_build_object('ok', true, 'code', 'saved', 'character_id', character_id));
        INSERT INTO public.character_lifecycle_events (character_id, operation_key, actor_key, from_status, to_status, reason_code)
        VALUES (character_id, p_operation_key, p_owner_key, NULL, 'active', 'registration_saved');
        INSERT INTO public.character_delivery_outbox (character_id, owner_key, guide_key)
        VALUES (character_id, p_owner_key, p_guide_key)
        RETURNING delivery_id INTO delivery_id;
        UPDATE public.character_registration_sessions SET status = 'completed', payload = p_payload, revision = revision + 1, updated_at = now() WHERE session_id = p_session_id;
        result := jsonb_build_object('ok', true, 'code', 'saved', 'character_id', character_id, 'delivery_id', delivery_id);
        UPDATE public.character_operations SET result = result WHERE operation_key = p_operation_key;
      END IF;
    END IF;
  END IF;
  IF result->>'ok' = 'false' THEN
    INSERT INTO public.character_operations (operation_key, session_id, owner_key, request_hash, result) VALUES (p_operation_key, p_session_id, p_owner_key, p_request_hash, result);
  END IF;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('ok', false, 'code', 'payload_invalid');
WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'code', 'concurrent_registration');
END;
$$;

CREATE OR REPLACE FUNCTION public.character_registration_cancel(p_session_id UUID, p_guide_key TEXT, p_owner_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE current_row RECORD;
BEGIN
  IF p_session_id IS NULL OR p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;
  SELECT * INTO current_row FROM public.character_registration_sessions
  WHERE session_id = p_session_id AND guide_key = p_guide_key AND owner_key = p_owner_key
  FOR UPDATE;
  IF current_row.session_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'session_not_found'); END IF;
  IF current_row.status = 'completed' THEN RETURN jsonb_build_object('ok', false, 'code', 'session_completed'); END IF;
  UPDATE public.character_registration_sessions SET status = 'cancelled', revision = revision + 1, updated_at = now() WHERE session_id = p_session_id;
  RETURN jsonb_build_object('ok', true, 'code', 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION public.character_get_active(p_guide_key TEXT, p_owner_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE result JSONB;
BEGIN
  IF p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_identity'); END IF;
  SELECT jsonb_build_object('ok', true, 'code', 'found', 'character_id', character_id, 'name', name, 'gender', gender, 'age', age, 'birthday_day', birthday_day, 'birthday_month', birthday_month, 'birthday_year', birthday_year, 'race', race, 'class_name', class_name, 'element', element, 'spirit', spirit, 'crew', crew, 'rank', rank, 'level', level, 'will_of_path', will_of_path, 'profession', profession, 'titles', titles, 'motto', motto, 'visual', visual, 'origin', origin, 'status', status, 'revision', revision) INTO result
  FROM public.character_profiles WHERE guide_key = p_guide_key AND owner_key = p_owner_key AND status = 'active' LIMIT 1;
  RETURN COALESCE(result, jsonb_build_object('ok', true, 'code', 'not_found'));
END;
$$;

CREATE OR REPLACE FUNCTION public.character_retire(
  p_guide_key TEXT,
  p_owner_key TEXT,
  p_character_id UUID,
  p_to_status TEXT,
  p_operation_key TEXT,
  p_request_hash TEXT,
  p_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE current_row RECORD; result JSONB;
BEGIN
  IF p_guide_key IS NULL OR p_guide_key !~ '^[0-9a-f]{64}$' OR p_owner_key IS NULL OR p_owner_key !~ '^[0-9a-f]{64}$' OR p_character_id IS NULL OR p_to_status NOT IN ('dead', 'missing', 'off') THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_request'); END IF;
  SELECT o.result INTO result FROM public.character_operations AS o WHERE o.operation_key = p_operation_key;
  IF result IS NOT NULL THEN RETURN result; END IF;
  SELECT * INTO current_row FROM public.character_profiles WHERE character_id = p_character_id AND guide_key = p_guide_key AND owner_key = p_owner_key FOR UPDATE;
  IF current_row.character_id IS NULL THEN result := jsonb_build_object('ok', false, 'code', 'character_not_found');
  ELSIF current_row.status <> 'active' THEN result := jsonb_build_object('ok', false, 'code', 'character_not_active');
  ELSE
    UPDATE public.character_profiles SET status = p_to_status, revision = revision + 1, updated_at = now() WHERE character_id = p_character_id;
    INSERT INTO public.character_operations (operation_key, session_id, owner_key, request_hash, result) VALUES (p_operation_key, current_row.registration_session_id, p_owner_key, p_request_hash, jsonb_build_object('ok', true, 'code', 'retired', 'character_id', p_character_id, 'status', p_to_status));
    INSERT INTO public.character_lifecycle_events (character_id, operation_key, actor_key, from_status, to_status, reason_code) VALUES (p_character_id, p_operation_key, p_owner_key, current_row.status, p_to_status, left(COALESCE(NULLIF(trim(p_reason_code), ''), 'owner_requested'), 120));
    result := jsonb_build_object('ok', true, 'code', 'retired', 'character_id', p_character_id, 'status', p_to_status);
  END IF;
  IF result->>'ok' = 'false' THEN INSERT INTO public.character_operations (operation_key, session_id, owner_key, request_hash, result) VALUES (p_operation_key, current_row.registration_session_id, p_owner_key, p_request_hash, result); END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.character_delivery_mark(
  p_delivery_id UUID,
  p_status TEXT,
  p_error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_delivery_id IS NULL OR p_status NOT IN ('sent', 'failed', 'pending') THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_delivery'); END IF;
  UPDATE public.character_delivery_outbox
  SET status = p_status,
      attempts = LEAST(attempts + 1, 5),
      last_error_code = CASE WHEN p_status = 'sent' THEN NULL ELSE left(NULLIF(trim(COALESCE(p_error_code, 'delivery_failed')), ''), 120) END,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      updated_at = now()
  WHERE delivery_id = p_delivery_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'delivery_not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'code', p_status);
END;
$$;

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

COMMIT;

NOTIFY pgrst, 'reload schema';


