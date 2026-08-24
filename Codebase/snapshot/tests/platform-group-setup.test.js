import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUP_SETUP_MISSION_ID,
  InMemoryMissionStore,
  MissionEngine,
  createGroupSetupMissionDefinition,
} from '../dist/platform/index.js'

async function input(engine, id, actorJid, operationKey, value) {
  return engine.handleInput({ id, actorJid, operationKey, value })
}

test('Group Setup Mission validates each stage, reviews draft, and applies atomically through gateway', async () => {
  const applied = []
  const engine = new MissionEngine(new InMemoryMissionStore(), { clock: { now: () => 1_000 } })
  engine.register(createGroupSetupMissionDefinition({ apply: (draft) => applied.push(draft) }))
  const actorJid = 'admin@s.whatsapp.net'
  engine.start(GROUP_SETUP_MISSION_ID, {
    id: 'group-setup-1', remoteJid: '123@g.us', actorJid, createdAt: 1_000,
    data: { groupJid: '123@g.us', updatedBy: actorJid },
  })

  assert.match((await input(engine, 'group-setup-1', actorJid, '1', '   ')).response.text, /tidak boleh kosong/)
  assert.equal((await input(engine, 'group-setup-1', actorJid, '2', 'Rules grup')).record.state, 'welcome')
  assert.equal((await input(engine, 'group-setup-1', actorJid, '3', 'Halo member')).record.state, 'leave')
  assert.equal((await input(engine, 'group-setup-1', actorJid, '4', 'Selamat tinggal')).record.state, 'prefix')
  assert.match((await input(engine, 'group-setup-1', actorJid, '5', 'abc')).response.text, /Prefix harus/)
  assert.equal((await input(engine, 'group-setup-1', actorJid, '6', '!')).record.state, 'language')
  assert.match((await input(engine, 'group-setup-1', actorJid, '7', 'jp')).response.text, /id.*en/)
  assert.equal((await input(engine, 'group-setup-1', actorJid, '8', 'id')).record.state, 'timezone')
  assert.equal((await input(engine, 'group-setup-1', actorJid, '9', 'Asia/Jakarta')).record.state, 'review')
  assert.match((await input(engine, 'group-setup-1', actorJid, '10', 'confirm')).response.text, /selesai/)
  assert.equal(engine.get('group-setup-1')?.status, 'completed')
  assert.deepEqual(applied, [{ groupJid: '123@g.us', updatedBy: actorJid, rules: 'Rules grup', welcome: 'Halo member', leave: 'Selamat tinggal', prefix: '!', language: 'id', timezone: 'Asia/Jakarta' }])
})

test('Group Setup Mission supports skip and cancel without applying changes', async () => {
  let applyCount = 0
  const engine = new MissionEngine(new InMemoryMissionStore(), { clock: { now: () => 1_000 } })
  engine.register(createGroupSetupMissionDefinition({ apply: () => { applyCount += 1 } }))
  const actorJid = 'admin@s.whatsapp.net'
  engine.start(GROUP_SETUP_MISSION_ID, { id: 'group-setup-2', remoteJid: '123@g.us', actorJid, createdAt: 1_000, data: { groupJid: '123@g.us', updatedBy: actorJid } })
  for (const [index, value] of ['skip', 'skip', 'skip', 'skip', 'skip', 'skip'].entries()) {
    await input(engine, 'group-setup-2', actorJid, `skip-${index}`, value)
  }
  assert.equal((await input(engine, 'group-setup-2', actorJid, 'cancel', 'cancel')).record.status, 'cancelled')
  assert.equal(applyCount, 0)
})

test('Group Setup Mission contains gateway failure and marks mission failed', async () => {
  const engine = new MissionEngine(new InMemoryMissionStore(), { clock: { now: () => 1_000 } })
  engine.register(createGroupSetupMissionDefinition({ apply: () => { throw new Error('storage failure') } }))
  const actorJid = 'admin@s.whatsapp.net'
  engine.start(GROUP_SETUP_MISSION_ID, { id: 'group-setup-3', remoteJid: '123@g.us', actorJid, createdAt: 1_000, data: { groupJid: '123@g.us', updatedBy: actorJid } })
  for (const [index, value] of ['skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'Asia/Jakarta'].entries()) {
    await input(engine, 'group-setup-3', actorJid, `value-${index}`, value)
  }
  const result = await input(engine, 'group-setup-3', actorJid, 'confirm', 'confirm')
  assert.equal(result?.record.status, 'failed')
  assert.equal(result?.record.errorCode, 'group_setup_apply_failed')
})
