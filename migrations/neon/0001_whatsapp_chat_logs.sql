-- Allybot Neon chat-log schema proposal
-- Migration ID: 0001_whatsapp_chat_logs
-- STATUS: REVIEW-ONLY. Do not execute automatically.
--
-- This file is intentionally not executed by Allybot startup, CI, or deployment.
-- Apply only after explicit operator approval, consent/notice review, backup/recovery
-- rehearsal, and a Neon branch/staging verification.

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_chat_logs (
  event_key TEXT PRIMARY KEY,
  group_jid TEXT NOT NULL,
  group_name TEXT,
  sender_jid TEXT,
  message_id TEXT NOT NULL,
  message_timestamp BIGINT NOT NULL,
  received_at BIGINT,
  from_me BOOLEAN NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'button', 'text_button', 'other')),
  content_text TEXT,
  button_id TEXT,
  quoted_text TEXT,
  quoted_sender_jid TEXT,
  mentioned_jids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_adapter TEXT NOT NULL DEFAULT 'baileys',
  capture_policy_version TEXT NOT NULL DEFAULT 'v1',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_chat_logs_event_key_length CHECK (char_length(event_key) BETWEEN 3 AND 1024),
  CONSTRAINT whatsapp_chat_logs_group_jid_length CHECK (char_length(group_jid) BETWEEN 1 AND 512),
  CONSTRAINT whatsapp_chat_logs_message_id_length CHECK (char_length(message_id) BETWEEN 1 AND 512),
  CONSTRAINT whatsapp_chat_logs_message_timestamp_valid CHECK (message_timestamp > 0),
  CONSTRAINT whatsapp_chat_logs_received_at_valid CHECK (received_at IS NULL OR received_at > 0),
  CONSTRAINT whatsapp_chat_logs_mentioned_jids_array CHECK (jsonb_typeof(mentioned_jids_json) = 'array')
);

CREATE INDEX IF NOT EXISTS whatsapp_chat_logs_group_time_idx
  ON public.whatsapp_chat_logs (group_jid, message_timestamp);

CREATE INDEX IF NOT EXISTS whatsapp_chat_logs_content_hash_idx
  ON public.whatsapp_chat_logs (content_sha256);

COMMENT ON TABLE public.whatsapp_chat_logs IS
  'Immutable, consent-scoped WhatsApp group chat-log records for roleplay provenance; application writer is asynchronous and idempotent.';

COMMENT ON COLUMN public.whatsapp_chat_logs.event_key IS
  'Stable idempotency key: group_jid:message_id. Must remain unique.';

COMMENT ON COLUMN public.whatsapp_chat_logs.message_timestamp IS
  'Source-of-truth event time in epoch milliseconds; timezone is display-only.';

COMMENT ON COLUMN public.whatsapp_chat_logs.content_sha256 IS
  'Integrity hash of the canonical normalized message representation, not an encryption substitute.';

COMMIT;
