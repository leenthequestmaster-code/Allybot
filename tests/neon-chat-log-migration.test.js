import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = join(root, 'migrations', 'neon', '0001_whatsapp_chat_logs.sql')

test('Neon chat-log migration is review-only DDL with writer invariants', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.whatsapp_chat_logs/i)
  assert.match(sql, /event_key\s+TEXT\s+PRIMARY KEY/i)
  assert.match(sql, /message_timestamp\s+BIGINT\s+NOT NULL/i)
  assert.match(sql, /mentioned_jids_json\s+JSONB\s+NOT NULL/i)
  assert.match(sql, /content_sha256\s+CHAR\(64\)\s+NOT NULL/i)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS whatsapp_chat_logs_group_time_idx/i)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS whatsapp_chat_logs_content_hash_idx/i)
  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE\s+|MERGE\s+INTO)\b/i)
})
