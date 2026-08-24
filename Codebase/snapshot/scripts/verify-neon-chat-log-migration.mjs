import { readFile } from 'node:fs/promises'

const migrationPath = new URL('../migrations/neon/0001_whatsapp_chat_logs.sql', import.meta.url)
const sql = await readFile(migrationPath, 'utf8')
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().toUpperCase()

const requiredFragments = [
  'BEGIN;',
  'CREATE TABLE IF NOT EXISTS PUBLIC.WHATSAPP_CHAT_LOGS',
  'EVENT_KEY TEXT PRIMARY KEY',
  'MESSAGE_TIMESTAMP BIGINT NOT NULL',
  'MENTIONED_JIDS_JSON JSONB NOT NULL',
  'CONTENT_SHA256 CHAR(64) NOT NULL',
  'CREATE INDEX IF NOT EXISTS WHATSAPP_CHAT_LOGS_GROUP_TIME_IDX',
  'CREATE INDEX IF NOT EXISTS WHATSAPP_CHAT_LOGS_CONTENT_HASH_IDX',
  'COMMIT;',
]

for (const fragment of requiredFragments) {
  if (!normalized.includes(fragment)) throw new Error(`Migration invariant missing: ${fragment}`)
}

const forbiddenMutation = /\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE\s+|MERGE\s+INTO)\b/i
if (forbiddenMutation.test(normalized)) throw new Error('Migration must not contain data mutation statements')

const tableMatch = normalized.match(/CREATE TABLE IF NOT EXISTS PUBLIC\.WHATSAPP_CHAT_LOGS \((.+)\); CREATE INDEX/s)
if (!tableMatch) throw new Error('Could not isolate chat-log table definition')
const columnCount = (tableMatch[1].match(/\n|,/g) ?? []).length
if (columnCount < 10) throw new Error('Migration table definition appears incomplete')

process.stdout.write('NEON_CHAT_LOG_MIGRATION=PASS (offline-ddl-invariants)\n')
