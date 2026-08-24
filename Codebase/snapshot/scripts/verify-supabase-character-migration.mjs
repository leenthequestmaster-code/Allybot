import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? process.cwd())
const paths = {
  context: resolve(root, 'migrations/supabase/0005_character_guide_group_context.sql'),
  lookup: resolve(root, 'migrations/supabase/0006_character_delivery_lookup.sql'),
  grants: resolve(root, 'migrations/supabase/0007_character_group_context_function_grants.sql'),
  indexes: resolve(root, 'migrations/supabase/0008_character_group_context_fk_indexes.sql'),
}
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

for (const [name, path] of Object.entries(paths)) check(existsSync(path), `${name}: migration file is missing`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

const context = readFileSync(paths.context, 'utf8')
const lookup = readFileSync(paths.lookup, 'utf8')
const grants = readFileSync(paths.grants, 'utf8')
const indexes = readFileSync(paths.indexes, 'utf8')
const all = `${context}\n${lookup}\n${grants}\n${indexes}`

for (const [name, source] of [['context', context], ['lookup', lookup], ['grants', grants], ['indexes', indexes]]) {
  check((source.match(/\bBEGIN\s*;/g) ?? []).length === 1, `${name}: expected exactly one BEGIN`)
  check((source.match(/\bCOMMIT\s*;/g) ?? []).length === 1, `${name}: expected exactly one COMMIT`)
  check((source.match(/\$\$/g) ?? []).length % 2 === 0, `${name}: unbalanced dollar quote`)
  check(!/\bDROP\s+(?:TABLE|FUNCTION|SCHEMA|POLICY)\b/i.test(source), `${name}: destructive DROP is forbidden`)
  check(!/\bTRUNCATE\b/i.test(source), `${name}: TRUNCATE is forbidden`)
  check(!/\bDELETE\s+FROM\b/i.test(source), `${name}: destructive DELETE is forbidden`)
  check(!/postgres(?:ql)?:\/\/[^<\s]+/i.test(source), `${name}: concrete postgres connection string found`)
  check(!/redis:\/\/[^<\s]+/i.test(source), `${name}: concrete redis URL found`)
  check(!/\b\d{7,}@(s\.whatsapp\.net|g\.us)\b/.test(source), `${name}: raw WhatsApp JID found`)
}

const tables = [...context.matchAll(/^CREATE TABLE(?: IF NOT EXISTS)? public\.([a-z0-9_]+)/gm)].map((match) => match[1])
const requiredTables = [
  'group_contexts',
  'group_context_operations',
  'group_context_audit_events',
  'group_ooc_allowlist',
  'character_registration_sessions',
  'character_profiles',
  'character_operations',
  'character_lifecycle_events',
  'character_delivery_outbox',
]
check(tables.length === requiredTables.length, `expected ${requiredTables.length} Character/Group Context tables, found ${tables.length}`)
for (const table of requiredTables) check(tables.includes(table), `required table missing: ${table}`)
check((context.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length === requiredTables.length, 'RLS is not enabled on every Character/Group Context table')
check((context.match(/^REVOKE ALL ON TABLE public\./gm) ?? []).length === requiredTables.length, 'table privilege revoke coverage is incomplete')
check((context.match(/^GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL)/gm) ?? []).length >= requiredTables.length, 'service_role table grant coverage is incomplete')

const contextFunctions = [...context.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
const lookupFunctions = [...lookup.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
const requiredFunctions = [
  'group_context_get',
  'group_context_set',
  'group_ooc_allowlist_check',
  'group_ooc_allowlist_list',
  'group_ooc_allowlist_set',
  'group_ooc_allowlist_remove',
  'group_ooc_allowlist_clear',
  'character_registration_start',
  'character_registration_cancel',
  'character_save',
  'character_get_active',
  'character_retire',
  'character_delivery_mark',
  'character_registration_get',
  'character_delivery_pending',
]
const declaredFunctions = [...contextFunctions, ...lookupFunctions]
check(declaredFunctions.length === requiredFunctions.length, `expected ${requiredFunctions.length} required RPC functions, found ${declaredFunctions.length}`)
for (const functionName of requiredFunctions) check(declaredFunctions.includes(functionName), `required RPC missing: ${functionName}`)
check((all.match(/SECURITY DEFINER/g) ?? []).length >= requiredFunctions.length, 'SECURITY DEFINER missing from one or more RPC definitions')
check((all.match(/SET search_path = public, extensions/g) ?? []).length >= requiredFunctions.length, 'hardened search_path missing from one or more RPC definitions')

const grantNames = [...grants.matchAll(/^GRANT EXECUTE ON FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
const revokeNames = [...grants.matchAll(/^REVOKE ALL ON FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
check(grantNames.length === requiredFunctions.length, `0007 service_role grant count mismatch: ${grantNames.length}`)
check(revokeNames.length === requiredFunctions.length, `0007 public revoke count mismatch: ${revokeNames.length}`)
check(new Set(grantNames).size === requiredFunctions.length, '0007 contains duplicate function grants')
check(new Set(revokeNames).size === requiredFunctions.length, '0007 contains duplicate function revokes')
check(requiredFunctions.every((name) => grantNames.includes(name) && revokeNames.includes(name)), '0007 privilege coverage is incomplete')
check(grants.includes('FROM PUBLIC, anon, authenticated'), '0007 does not revoke default API roles')
check(grants.includes('TO service_role'), '0007 does not restore service_role execution')
check(context.includes('character_registration_cancel') && context.includes('group_ooc_allowlist_clear'), 'applied 0005 corrective RPCs are missing')
check(context.includes("NOTIFY pgrst, 'reload schema';") && lookup.includes("NOTIFY pgrst, 'reload schema';") && grants.includes("NOTIFY pgrst, 'reload schema';") && indexes.includes("NOTIFY pgrst, 'reload schema';"), 'PostgREST schema refresh notification missing')
check(context.includes('request_hash TEXT NOT NULL') && context.includes('character_profiles_one_active_per_owner'), 'idempotency or active-character uniqueness guard missing')
for (const indexName of ['group_context_audit_events_operation_idx', 'character_operations_session_idx', 'character_profiles_registration_session_idx']) check(indexes.includes(`CREATE INDEX IF NOT EXISTS ${indexName}`), `required FK index missing: ${indexName}`)
check(!/INSERT\s+INTO\s+public\.character_profiles\s*\([^)]*\)\s*VALUES\s*\([^)]*\)/is.test(context.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$[\s\S]*?\$\$/g, '')), 'Character profile seed row detected outside function bodies')

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`SUPABASE_CHARACTER_SCHEMA=PASS (tables=${tables.length}, rpc=${declaredFunctions.length}, grants=${grantNames.length}, rls=${(context.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length}, fk_indexes=3)`)
