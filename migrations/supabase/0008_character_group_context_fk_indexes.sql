-- Migration ID: 0008_character_group_context_fk_indexes
-- Adds covering indexes for new-domain foreign keys identified by the performance advisor.

BEGIN;

CREATE INDEX IF NOT EXISTS group_context_audit_events_operation_idx
  ON public.group_context_audit_events (operation_key);

CREATE INDEX IF NOT EXISTS character_operations_session_idx
  ON public.character_operations (session_id);

CREATE INDEX IF NOT EXISTS character_profiles_registration_session_idx
  ON public.character_profiles (registration_session_id);

COMMIT;

NOTIFY pgrst, 'reload schema';
