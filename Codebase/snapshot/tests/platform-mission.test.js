import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { InMemoryMissionStore, MissionEngine, SqliteMissionStore } from '../dist/framework/index.js'

const definition = {
  id: 'test-mission',
  version: 1,
  initialState: 'collect',
  states: {
    collect: {
      onInput: (context, input) => input === 'finish'
        ? { type: 'complete', data: { value: input }, response: { kind: 'text', text: 'Done' } }
        : { type: 'transition', state: 'confirm', data: { value: input }, response: { kind: 'text', text: 'Confirm?' } },
    },
    confirm: {
      onInput: (_context, input) => input === 'yes'
        ? { type: 'complete', response: { kind: 'text', text: 'Confirmed' } }
        : { type: 'fail', errorCode: 'confirmation_rejected', response: { kind: 'text', text: 'Rejected' } },
    },
  },
}

async function exerciseEngine(createStore) {
  let now = 1_000
  const engine = new MissionEngine(createStore(), { clock: { now: () => now } })
  engine.register(definition)
  const started = engine.start('test-mission', { id: 'mission-1', remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', data: { value: null }, createdAt: now, expiresAt: 10_000 })
  assert.equal(started.state, 'collect')

  const moved = await engine.handleInput({ id: 'mission-1', actorJid: 'user@s.whatsapp.net', operationKey: 'op-1', value: 'hello' })
  assert.equal(moved?.record.state, 'confirm')
  assert.equal(moved?.record.status, 'running')
  assert.equal(moved?.response?.text, 'Confirm?')
  assert.equal((await engine.handleInput({ id: 'mission-1', actorJid: 'user@s.whatsapp.net', operationKey: 'op-1', value: 'hello' }))?.record.revision, 1)
  assert.equal(await engine.handleInput({ id: 'mission-1', actorJid: 'other@s.whatsapp.net', operationKey: 'op-2', value: 'yes' }), undefined)

  const completed = await engine.handleInput({ id: 'mission-1', actorJid: 'user@s.whatsapp.net', operationKey: 'op-2', value: 'yes' })
  assert.equal(completed?.record.status, 'completed')
  assert.equal(completed?.response?.text, 'Confirmed')
  assert.equal((await engine.handleInput({ id: 'mission-1', actorJid: 'user@s.whatsapp.net', operationKey: 'op-2', value: 'yes' }))?.record.status, 'completed')
  assert.equal(engine.cancel('mission-1', 'user@s.whatsapp.net', 1), undefined)

  const failed = engine.start('test-mission', { id: 'mission-2', remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', data: { value: null }, createdAt: now })
  await engine.handleInput({ id: failed.id, actorJid: failed.actorJid, operationKey: 'reject', value: 'bad' })
  const failure = await engine.handleInput({ id: failed.id, actorJid: failed.actorJid, operationKey: 'reject-2', value: 'no' })
  assert.equal(failure?.record.status, 'failed')
  assert.equal(failure?.record.errorCode, 'confirmation_rejected')

  engine.start('test-mission', { id: 'mission-3', remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', data: {}, createdAt: now, expiresAt: 2_000 })
  now = 2_000
  assert.equal(engine.expire(), 1)
  assert.equal(engine.get('mission-3')?.status, 'expired')
}

test('in-memory Mission Engine handles transitions and recovery invariants', async () => {
  await exerciseEngine(() => new InMemoryMissionStore())
})

test('SQLite Mission Engine persists state and reloads records', async () => {
  const db = new Database(':memory:')
  await exerciseEngine(() => new SqliteMissionStore(db, 'test'))
  const store = new SqliteMissionStore(db, 'test')
  assert.equal(store.get('mission-1')?.status, 'completed')
  db.close()
})

test('Mission Engine rejects oversized inputs and undefined transitions', async () => {
  const engine = new MissionEngine(new InMemoryMissionStore(), { maxInputSize: 4 })
  engine.register(definition)
  engine.start('test-mission', { id: 'small', remoteJid: 'chat@g.us', actorJid: 'user@s.whatsapp.net', data: {}, createdAt: 1 })
  await assert.rejects(() => engine.handleInput({ id: 'small', actorJid: 'user@s.whatsapp.net', operationKey: 'big', value: '12345' }), /maximum size/)
  assert.throws(() => engine.register({ ...definition, id: 'bad mission' }), /Invalid mission definition id/)
})
