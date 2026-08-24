import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { InMemoryInteractionSessionStore, SqliteInteractionSessionStore } from '../dist/platform/index.js'

const input = (id, overrides = {}) => ({
  id,
  menuId: 'main',
  menuVersion: 1,
  remoteJid: 'chat@g.us',
  actorJid: 'user@s.whatsapp.net',
  createdAt: 1_000,
  expiresAt: 5_000,
  ...overrides,
})

function exerciseStore(createStore) {
  const store = createStore()
  const created = store.create(input('session-1'))
  assert.equal(created.status, 'active')
  assert.equal(store.findActive({ remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', now: 1_001 })?.id, 'session-1')
  assert.equal(store.complete({ id: 'session-1', actorJid: 'other@s.whatsapp.net', expectedRevision: 0, operationKey: 'op-1', selectedItemId: 'general', rawInput: '1' }), undefined)

  const completed = store.complete({ id: 'session-1', actorJid: 'user@s.whatsapp.net', expectedRevision: 0, operationKey: 'op-1', selectedItemId: 'general', rawInput: '1' })
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.revision, 1)
  assert.equal(store.complete({ id: 'session-1', actorJid: 'user@s.whatsapp.net', expectedRevision: 0, operationKey: 'op-1', selectedItemId: 'general', rawInput: '1' })?.id, 'session-1')
  assert.equal(store.complete({ id: 'session-1', actorJid: 'user@s.whatsapp.net', expectedRevision: 0, operationKey: 'op-2', selectedItemId: 'other', rawInput: '2' }), undefined)

  store.create(input('session-2', { expiresAt: 2_000 }))
  assert.equal(store.expire(2_000), 1)
  assert.equal(store.get('session-2')?.status, 'expired')
  assert.equal(store.findActive({ remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', now: 2_000 })?.id, undefined)

  store.create(input('session-3'))
  assert.equal(store.cancel({ id: 'session-3', actorJid: 'user@s.whatsapp.net', expectedRevision: 99 }), undefined)
  assert.equal(store.cancel({ id: 'session-3', actorJid: 'user@s.whatsapp.net', expectedRevision: 0 })?.status, 'cancelled')
  return store
}

test('in-memory session store enforces ownership, expiry, revision, and idempotency', () => {
  exerciseStore(() => new InMemoryInteractionSessionStore({ clock: { now: () => 1_500 } }))
})

test('SQLite session store has parity with in-memory behavior and persists across instances', () => {
  const db = new Database(':memory:')
  exerciseStore(() => new SqliteInteractionSessionStore(db, { namespace: 'test', clock: { now: () => 1_500 } }))
  const store = new SqliteInteractionSessionStore(db, { namespace: 'test', clock: { now: () => 1_500 } })
  assert.equal(store.get('session-1')?.status, 'completed')
  assert.throws(() => store.create(input('session-1')), /UNIQUE|constraint/i)
  db.close()
})

test('session input rejects invalid expiry and empty identity fields', () => {
  const store = new InMemoryInteractionSessionStore()
  assert.throws(() => store.create(input('bad', { expiresAt: 1_000 })), /expiresAt/)
  assert.throws(() => store.create(input(' ', { id: ' ' })), /id must not be empty/)
})
