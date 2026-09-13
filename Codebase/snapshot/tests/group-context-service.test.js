import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { GroupContextService } from '../dist/services/group-context-service.js'

const logger = pino({ level: 'silent' })
const groupJid = '<jid-redacted@g.us>'
const actorJid = '<jid-redacted@s.whatsapp.net>'
const targetJid = '<jid-redacted@s.whatsapp.net>'

function createService() {
  const calls = []
  const client = {
    async rpc(functionName, args) {
      calls.push({ functionName, args })
      if (functionName === 'group_context_set') return { data: { ok: true, code: 'changed', mode: 'ic', ic_subtype: 'bank', ooc_policy: 'strict', revision: 1 }, error: null }
      if (functionName === 'group_context_get') return { data: { ok: true, mode: 'ic', ic_subtype: 'bank', ooc_policy: 'strict', revision: 1 }, error: null }
      if (functionName === 'group_ooc_allowlist_check') return { data: { ok: true, allowed: true }, error: null }
      if (functionName === 'group_ooc_allowlist_list') return { data: { ok: true, entries: [{ member_key: 'a'.repeat(64), role: 'narrator', reason_code: 'story_access' }] }, error: null }
      return { data: { ok: true, code: 'changed' }, error: null }
    },
  }
  const service = new GroupContextService(logger, {
    env: { GROUP_CONTEXT_ENABLED: 'true', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-value' },
    createClient: () => client,
    clock: () => 1_700_000_000_000,
  })
  service.initialize({ logger, config: {}, services: {} })
  return { service, calls }
}

test('Group Context service hashes identities and preserves server-authoritative mode result', async () => {
  const { service, calls } = createService()
  const result = await service.set(groupJid, 'ic', 'bank', 'strict', actorJid)
  const current = await service.get(groupJid)
  const allowed = await service.isOocAllowed(groupJid, targetJid)
  const entries = await service.listAllowlist(groupJid)
  await service.addAllowlist(groupJid, targetJid, actorJid)
  await service.removeAllowlist(groupJid, targetJid, actorJid)
  await service.clearAllowlist(groupJid, actorJid)

  assert.equal(result.mode, 'ic')
  assert.equal(result.icSubtype, 'bank')
  assert.equal(current.mode, 'ic')
  assert.equal(allowed, true)
  assert.equal(entries.length, 1)
  assert.equal(calls.every(({ args }) => !JSON.stringify(args).includes('@g.us') && !JSON.stringify(args).includes('@s.whatsapp.net')), true)
  assert.equal(calls.filter(({ functionName }) => functionName === 'group_ooc_allowlist_set').length, 1)
  assert.equal(calls.filter(({ functionName }) => functionName === 'group_ooc_allowlist_remove').length, 1)
  assert.equal(calls.filter(({ functionName }) => functionName === 'group_ooc_allowlist_clear').length, 1)
})

test('disabled Group Context returns safe normal defaults without a client', async () => {
  const service = new GroupContextService(logger, { env: { GROUP_CONTEXT_ENABLED: 'false' }, createClient: () => { throw new Error('must not construct') } })
  service.initialize({ logger, config: {}, services: {} })
  const current = await service.get(groupJid)
  assert.equal(current.mode, 'normal')
  assert.equal(current.enabled, false)
  assert.equal(service.isReady, false)
})
