import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupSetupMissionDefinition } from '../dist/framework/group-setup.js'

test('createGroupSetupMissionDefinition includes mode step for normal, ooc, guide, and ic/rp', async () => {
  let appliedDraft
  const mission = createGroupSetupMissionDefinition({
    apply: (draft) => { appliedDraft = draft },
  })

  assert.equal(typeof mission.states.mode, 'object')
  assert.equal(typeof mission.states.icsubtype, 'object')

  // Step rules -> skip
  let step = mission.states.rules.onInput({ mission: { data: { groupJid: 'g@g.us', updatedBy: 'u@s.whatsapp.net' } } }, 'skip')
  assert.equal(step.state, 'welcome')

  // welcome -> skip
  step = mission.states.welcome.onInput({ mission: { data: step.data } }, 'skip')
  assert.equal(step.state, 'leave')

  // leave -> skip
  step = mission.states.leave.onInput({ mission: { data: step.data } }, 'skip')
  assert.equal(step.state, 'prefix')

  // prefix -> skip
  step = mission.states.prefix.onInput({ mission: { data: step.data } }, 'skip')
  assert.equal(step.state, 'language')

  // language -> skip
  step = mission.states.language.onInput({ mission: { data: step.data } }, 'skip')
  assert.equal(step.state, 'timezone')

  // timezone -> skip -> goes to mode!
  step = mission.states.timezone.onInput({ mission: { data: step.data } }, 'skip')
  assert.equal(step.state, 'mode')

  // mode -> rp -> goes to icsubtype!
  step = mission.states.mode.onInput({ mission: { data: step.data } }, 'rp')
  assert.equal(step.state, 'icsubtype')
  assert.equal(step.data.mode, 'ic')

  // icsubtype -> market -> goes to review!
  step = mission.states.icsubtype.onInput({ mission: { data: step.data } }, 'market')
  assert.equal(step.state, 'review')
  assert.equal(step.data.icSubtype, 'market')

  // review -> confirm -> calls apply
  const confirmed = await mission.states.review.onInput({ mission: { data: step.data } }, 'confirm')
  assert.equal(confirmed.type, 'complete')
  assert.equal(appliedDraft?.mode, 'ic')
  assert.equal(appliedDraft?.icSubtype, 'market')
})
