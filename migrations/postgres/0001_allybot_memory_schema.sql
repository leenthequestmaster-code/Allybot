CREATE SCHEMA IF NOT EXISTS allybot_memory;

CREATE TABLE IF NOT EXISTS allybot_memory.user_memory_slots (
  sender_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  slot_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'conversation',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_key, slot_key)
);

CREATE TABLE IF NOT EXISTS allybot_memory.episodic_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('dm', 'group', 'global')),
  scope_key TEXT NOT NULL,
  sender_key TEXT,
  summary TEXT NOT NULL,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allybot_episodic_fts ON allybot_memory.episodic_memories USING GIN (fts_vector);
CREATE INDEX IF NOT EXISTS idx_allybot_episodic_scope ON allybot_memory.episodic_memories (scope_type, scope_key, last_reinforced_at DESC);

CREATE TABLE IF NOT EXISTS allybot_memory.group_chat_archive (
  id BIGSERIAL PRIMARY KEY,
  group_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  push_name TEXT NOT NULL,
  text TEXT NOT NULL,
  quoted_message_id TEXT,
  timestamp_ms BIGINT NOT NULL,
  fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(push_name, '') || ' ' || coalesce(text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_jid, message_id)
);
CREATE INDEX IF NOT EXISTS idx_allybot_chat_archive_group_ts ON allybot_memory.group_chat_archive (group_jid, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_allybot_chat_archive_fts ON allybot_memory.group_chat_archive USING GIN (fts_vector);

CREATE TABLE IF NOT EXISTS allybot_memory.knowledge_vault (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allybot_vault_fts ON allybot_memory.knowledge_vault USING GIN (fts_vector);

CREATE TABLE IF NOT EXISTS allybot_memory.wake_corpus (
  id BIGSERIAL PRIMARY KEY,
  group_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  message_text TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allybot_wake_corpus_created ON allybot_memory.wake_corpus (created_at DESC);

CREATE TABLE IF NOT EXISTS allybot_memory.moderation_auto_reopen (
  group_jid TEXT PRIMARY KEY,
  reopen_at_ms BIGINT NOT NULL,
  locked_at_ms BIGINT NOT NULL,
  sop_id TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allybot_memory.moderation_lock_cooldown (
  group_jid TEXT PRIMARY KEY,
  last_locked_at_ms BIGINT NOT NULL
);
