import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CharacterGuideService } from '../dist/services/character-guide-service.js'

const logger = pino({ level: 'silent' })
const env = {
  CHARACTER_GUIDE_ENABLED: 'true',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-value',
}
const groupGuide = '120363000000000000@g.us'
const groupIc = '120363111111111111@g.us'
const owner = '628120000000@s.whatsapp.net'
const reference = 'a'.repeat(64)
const sessionId = '11111111-1111-4111-8111-111111111111'
const characterId = '22222222-2222-4222-8222-222222222222'
const deliveryId = '33333333-3333-4333-8333-333333333333'

const payload = {
  name: 'Aruna',
  gender: 'Female',
  age: 24,
  birthdayDay: 12,
  birthdayMonth: 'Zephyra',
  birthdayYear: 776,
  race: 'Human',
  className: 'Knight',
  element: 'Fire',
  willOfPath: 'Neutral',
}

function createService() {
  const calls = []
  const client = {
    async rpc(functionName, args) {
      calls.push({ functionName, args })
      if (functionName === 'character_registration_start') {
        return { data: { ok: true, code: 'created', session_id: sessionId, quoted_reference_key: args.p_quoted_reference_key }, error: null }
      }
      if (functionName === 'character_registration_get') {
        return { data: { ok: true, code: 'found', session_id: sessionId, quoted_reference_key: reference }, error: null }
      }
      if (functionName === 'character_save') {
        return { data: { ok: true, code: 'saved', character_id: characterId, delivery_id: deliveryId }, error: null }
      }
      if (functionName === 'character_get_active') {
        return { data: { ok: true, code: 'found', character_id: characterId, name: 'Aruna', gender: 'Female', age: 24, birthday_day: 12, birthday_month: 'Zephyra', birthday_year: 776, race: 'Human', class_name: 'Knight', element: 'Fire', will_of_path: 'Neutral', rank: 'F-', level: 1, titles: ['Allyssea Citizens'], revision: 1 }, error: null }
      }
      if (functionName === 'character_delivery_pending') {
        return { data: { ok: true, code: 'found', delivery_id: deliveryId }, error: null }
      }
      if (functionName === 'character_delivery_mark') return { data: { ok: true, code: 'marked' }, error: null }
      return { data: { ok: true, code: 'cancelled' }, error: null }
    },
  }
  const service = new CharacterGuideService(logger, { env, createClient: () => client })
  service.initialize({ logger, config: {}, services: {} })
  return { service, calls }
}

test('Character RPC uses one stable world scope across Guide and IC groups', async () => {
  const { service, calls } = createService()
  const started = await service.startRegistration(groupGuide, owner, reference, 1800)
  await service.getRegistration(groupIc, owner)
  await service.save(groupGuide, owner, sessionId, reference, payload, 'save-message')
  const active = await service.getActive(groupIc, owner)
  const pending = await service.pendingDeliveryForOwner(owner)

  assert.equal(started.sessionId, sessionId)
  assert.equal(active?.characterId, characterId)
  assert.equal(pending, deliveryId)
  const scopedCalls = calls.filter(({ functionName }) => ['character_registration_start', 'character_registration_get', 'character_save', 'character_get_active', 'character_delivery_pending'].includes(functionName))
  assert.ok(scopedCalls.length >= 5)
  assert.equal(new Set(scopedCalls.map(({ args }) => args.p_guide_key)).size, 1)
  assert.equal(scopedCalls.every(({ args }) => typeof args.p_owner_key === 'string' && args.p_owner_key.length === 64), true)
})

test('Character service stays disabled without feature flag and does not construct a client', () => {
  let constructed = false
  const service = new CharacterGuideService(logger, {
    env: { CHARACTER_GUIDE_ENABLED: 'false' },
    createClient: () => { constructed = true; throw new Error('must not construct') },
  })
  service.initialize({ logger, config: {}, services: {} })
  assert.equal(service.isEnabled, false)
  assert.equal(service.isReady, false)
  assert.equal(constructed, false)
})
