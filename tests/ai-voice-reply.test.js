import assert from 'node:assert/strict'
import test from 'node:test'
import { isVoiceResponseRequested, cleanTextForSpeech } from '../dist/framework/plugins/ai.js'

test('1. isVoiceResponseRequested accurately detects VN and voice requests', () => {
  assert.equal(isVoiceResponseRequested('Chlona bales pake vn dong'), true)
  assert.equal(isVoiceResponseRequested('jawab pake voice note ya'), true)
  assert.equal(isVoiceResponseRequested('coba ngomong dong Chlona'), true)
  assert.equal(isVoiceResponseRequested('kirim vn dong'), true)
  assert.equal(isVoiceResponseRequested('suara kamu gimana sih?'), true)
  // Incoming audio default: natural two-way voice chat
  assert.equal(isVoiceResponseRequested('halo Chlona apa kabar', true), true)

  // Contextual override: user spoke via VN but explicitly asked for text response
  assert.equal(isVoiceResponseRequested('Chlona tolong catat ini ya, balas pake teks aja', true), false)
  assert.equal(isVoiceResponseRequested('jangan vn ya Chlona', true), false)
  assert.equal(isVoiceResponseRequested('tolong ketik teks aja ya', true), false)

  // Negative tests
  assert.equal(isVoiceResponseRequested('Chlona tolong jelasin catur'), false)
  assert.equal(isVoiceResponseRequested('cara bikin stiker gimana'), false)
  assert.equal(isVoiceResponseRequested('apa itu bot WA'), false)
})

test('2. cleanTextForSpeech removes markdown formatting, emojis, and codeblocks for natural voice', () => {
  const dirty = 'Halo *Cyrus*! 👋 Aku lagi santai nih di https://allyssea.com/join _hehe_.'
  const clean = cleanTextForSpeech(dirty)
  assert.equal(clean, 'Halo Cyrus! Aku lagi santai nih di tautan hehe.')
  assert.ok(!clean.includes('*'))
  assert.ok(!clean.includes('👋'))
})
