import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? process.cwd())
const schemaPath = resolve(root, 'migrations/supabase/0001_economy_schema.sql')
const functionsPath = resolve(root, 'migrations/supabase/0002_economy_functions.sql')
const transferPath = resolve(root, 'migrations/supabase/0003_economy_transfer_cache_keys.sql')
const cryptoPath = resolve(root, 'migrations/supabase/0004_economy_pgcrypto_search_path.sql')
const schema = readFileSync(schemaPath, 'utf8')
const functions = readFileSync(functionsPath, 'utf8')
const transfer = readFileSync(transferPath, 'utf8')
const crypto = readFileSync(cryptoPath, 'utf8')
const all = `${schema}\n${functions}\n${transfer}\n${crypto}`
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

for (const [name, source] of [['schema', schema], ['functions', functions], ['transfer-cache', transfer], ['pgcrypto-search-path', crypto]]) {
  check((source.match(/\bBEGIN\s*;/g) ?? []).length === 1, `${name}: expected exactly one BEGIN`)
  check((source.match(/\bCOMMIT\s*;/g) ?? []).length === 1, `${name}: expected exactly one COMMIT`)
  check((source.match(/\$\$/g) ?? []).length % 2 === 0, `${name}: unbalanced dollar quote`)
  check(!/\bDROP\s+(TABLE|FUNCTION|SCHEMA)\b/i.test(source), `${name}: destructive DROP found`)
  check(!/\bTRUNCATE\b/i.test(source), `${name}: destructive TRUNCATE found`)
  check(!/\bDELETE\s+FROM\b/i.test(source), `${name}: destructive DELETE found`)
  check(!/postgres(?:ql)?:\/\/[^<\s]+/i.test(source), `${name}: concrete postgres connection string found`)
  check(!/redis:\/\/[^<\s]+/i.test(source), `${name}: concrete redis URL found`)
  check(!/\b\d{7,}@(s\.whatsapp\.net|g\.us)\b/.test(source), `${name}: numeric raw JID found`)
}

const created = [...functions.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
const revoked = [...functions.matchAll(/^REVOKE ALL ON FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
const granted = [...functions.matchAll(/^GRANT EXECUTE ON FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
check(created.length === 12, `expected 12 RPC functions, found ${created.length}`)
const transferFunctions = [...transfer.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm)].map((match) => match[1])
check(transferFunctions.length === 2, `expected 2 transfer refresh functions, found ${transferFunctions.length}`)
check(transferFunctions.includes('economy_accept_transfer') && transferFunctions.includes('economy_reject_transfer'), 'transfer refresh functions missing')
check(new Set(created).size === created.length, 'duplicate RPC function declaration found')
check(created.every((name) => revoked.includes(name)), 'one or more RPC functions lack PUBLIC/anon/authenticated revoke')
check(created.every((name) => granted.includes(name)), 'one or more RPC functions lack service_role execute grant')
check(schema.includes('request_hash TEXT NOT NULL'), 'operation request_hash column missing')
check(schema.includes('reserved_wallet_balance BIGINT NOT NULL DEFAULT 0'), 'account reservation column missing')
check(schema.includes('reserved_wallet_delta BIGINT NOT NULL DEFAULT 0'), 'ledger reservation delta missing')
check(schema.includes('restricted_wallet_balance + reserved_wallet_balance <= wallet_balance'), 'restricted/reserved invariant missing')
check((functions.match(/request_hash := /g) ?? []).length === 10, 'request fingerprint missing from one or more mutation RPCs')
check((functions.match(/operation\.request_hash <> request_hash/g) ?? []).length === 10, 'payload mismatch guard missing from one or more mutation RPCs')
check((functions.match(/FOR UPDATE/g) ?? []).length >= 18, 'row lock coverage unexpectedly low')
check(functions.includes("'sender_key', transfer.sender_key") && functions.includes("'recipient_key', transfer.recipient_key"), 'transfer cache invalidation keys missing')
check(transfer.includes("'sender_key', transfer.sender_key") && transfer.includes("'recipient_key', transfer.recipient_key"), 'transfer refresh migration missing hashed keys')
const cryptoFunctions = [...crypto.matchAll(/^ALTER FUNCTION public\.(economy_[a-z_]+)\([^\n]+\)\n  SET search_path = public, extensions;$/gm)].map((match) => match[1])
check(cryptoFunctions.length === 10, `expected 10 pgcrypto search_path updates, found ${cryptoFunctions.length}`)
check(new Set(cryptoFunctions).size === cryptoFunctions.length, 'duplicate pgcrypto search_path update found')
check(crypto.includes("NOTIFY pgrst, 'reload schema';"), 'PostgREST schema reload notification missing')
check(all.includes('extensions'), 'extensions schema reference missing')

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`SUPABASE_ECONOMY_SCHEMA=PASS (functions=${created.length}, transfer_refresh=${transferFunctions.length}, row_locks=${(functions.match(/FOR UPDATE/g) ?? []).length}, request_hashes=${(functions.match(/request_hash := /g) ?? []).length})`)
