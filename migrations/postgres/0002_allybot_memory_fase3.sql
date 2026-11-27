CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_allybot_episodic_trgm
  ON allybot_memory.episodic_memories USING GIN (summary gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_allybot_vault_trgm
  ON allybot_memory.knowledge_vault USING GIN (content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS allybot_memory.consolidation_state (
  scope_key TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('dm', 'group')),
  last_consolidated_ms BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allybot_memory.faq_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allybot_faq_candidates_status
  ON allybot_memory.faq_candidates (status, created_at DESC);
