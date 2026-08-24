import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isCanonicalNarrativeText,
  parseCharacterSheet,
} from '../dist/services/character-sheet-parser.js'

const validSheet = `
*Name*: Aruna
_Gender_ = Female
Age: 24
Birthday: 12 Zephyra 776 KAR
Race - Human
Class: Knight
Element: Fire
Will Of Path: Neutral
Rank: S-
Level: 99
Money: 999999
Motto:
*Penjaga yang tidak pernah menyerah.*
Tetap berdiri saat malam panjang.
Origin: _Allyssea_
`

test('Character Sheet parser normalizes WhatsApp formatting and ignores server-owned fields', () => {
  const result = parseCharacterSheet(validSheet)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.payload, {
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
    motto: 'Penjaga yang tidak pernah menyerah. Tetap berdiri saat malam panjang.',
    origin: 'Allyssea',
  })
  assert.deepEqual(result.ignoredFields.sort(), ['level', 'money', 'rank'])
})

test('Character Sheet parser rejects duplicate and unknown labeled fields', () => {
  const result = parseCharacterSheet(`${validSheet}\nName: Another\nUnknown Field: value`)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((item) => item.code === 'duplicate' && item.field === 'name'))
  assert.ok(result.issues.some((item) => item.code === 'unsupported' && item.message.includes('Unknown Field')))
})

test('Character Sheet parser rejects invalid gameplay values without guessing typos', () => {
  const result = parseCharacterSheet(validSheet.replace('Element: Fire', 'Element: Frier').replace('Age: 24', 'Age: twenty four'))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((item) => item.field === 'age' && item.code === 'invalid'))
  assert.ok(result.issues.some((item) => item.field === 'element' && item.code === 'invalid'))
})

test('IC narrative grammar accepts anchored action/dialog variants', () => {
  assert.equal(isCanonicalNarrativeText('> Narasi singkat.'), true)
  assert.equal(isCanonicalNarrativeText('> *Narasi*\n"Dialog"'), true)
  assert.equal(isCanonicalNarrativeText('> _*Narasi.*_\n“Dialog.”'), true)
  assert.equal(isCanonicalNarrativeText('『Aruna』: "Dialog"'), true)
  assert.equal(isCanonicalNarrativeText('> _*Narasi*_'), true)
})

test('IC narrative grammar does not treat markup or manual OOC markers as narrative', () => {
  assert.equal(isCanonicalNarrativeText('*Percakapan biasa*'), false)
  assert.equal(isCanonicalNarrativeText('_Percakapan biasa_'), false)
  assert.equal(isCanonicalNarrativeText('(( izin off ))'), false)
  assert.equal(isCanonicalNarrativeText('[OOC] izin off'), false)
  assert.equal(isCanonicalNarrativeText('OOC: izin off'), false)
  assert.equal(isCanonicalNarrativeText('Narasi tanpa anchor'), false)
})
