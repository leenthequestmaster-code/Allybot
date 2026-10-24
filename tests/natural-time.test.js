import assert from 'node:assert/strict'
import test from 'node:test'
import {
  translateIndonesianTimeText,
  parseNaturalTimeIndonesian,
  formatWibDateTime,
} from '../dist/services/natural-time.js'

test('1. translateIndonesianTimeText converts relative and colloquial time expressions', () => {
  assert.equal(translateIndonesianTimeText('30 menit lagi'), 'in 30 minutes')
  assert.equal(translateIndonesianTimeText('setengah jam lagi'), 'in 30 minutes')
  assert.equal(translateIndonesianTimeText('2 jam lagi'), 'in 2 hours')
  assert.equal(translateIndonesianTimeText('besok jam 7 pagi'), 'tomorrow 7:00 am')
  assert.equal(translateIndonesianTimeText('lusa jam 2 siang'), 'in 2 days 14:00')
  assert.equal(translateIndonesianTimeText('nanti malam jam 8'), 'tonight at 8:00')
})

test('2. parseNaturalTimeIndonesian computes exact future dates with WIB anchor', () => {
  // Fixed reference date: 2026-10-24 09:00:00 WIB (02:00:00 UTC)
  const refDate = new Date('2026-10-24T02:00:00.000Z')

  // Case A: "30 menit lagi angkat jemuran"
  const r1 = parseNaturalTimeIndonesian('30 menit lagi angkat jemuran', refDate)
  assert.ok(r1.date)
  assert.equal(r1.isFuture, true)
  assert.equal(r1.date.getTime(), refDate.getTime() + 30 * 60 * 1000)
  assert.ok(r1.remainingText.includes('angkat jemuran'))

  // Case B: "besok jam 7 pagi bangunin sahur"
  const r2 = parseNaturalTimeIndonesian('besok jam 7 pagi bangunin sahur', refDate)
  assert.ok(r2.date)
  assert.equal(r2.isFuture, true)
  // Expected: 2026-10-25 07:00:00 WIB (00:00:00 UTC)
  assert.equal(r2.date.toISOString(), '2026-10-25T00:00:00.000Z')
  assert.ok(r2.remainingText.includes('bangunin sahur'))

  // Case C: "lusa jam 14:00 rapat kerja"
  const r3 = parseNaturalTimeIndonesian('lusa jam 2 siang rapat kerja', refDate)
  assert.ok(r3.date)
  // Expected: 2026-10-26 14:00:00 WIB (07:00:00 UTC)
  assert.equal(r3.date.toISOString(), '2026-10-26T07:00:00.000Z')
  assert.ok(r3.remainingText.includes('rapat kerja'))
})

test('3. formatWibDateTime produces Indonesian weekday and month formatted string', () => {
  const d = new Date('2026-10-25T00:00:00.000Z') // 2026-10-25 07:00 WIB (Minggu)
  const str = formatWibDateTime(d)
  assert.ok(str.includes('Minggu') || str.includes('minggu'))
  assert.ok(str.includes('Oktober') || str.includes('oktober'))
  assert.ok(str.includes('2026'))
  assert.ok(str.includes('WIB'))
})
