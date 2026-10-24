import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveCityCoordinate,
  calculateJadwalOffline,
  INDONESIAN_CITIES,
} from '../dist/services/sholat-offline.js'

test('1. resolveCityCoordinate maps direct names, aliases, and prefixes', () => {
  assert.equal(resolveCityCoordinate('jakarta')?.name, 'Jakarta')
  assert.equal(resolveCityCoordinate('jogja')?.name, 'Yogyakarta')
  assert.equal(resolveCityCoordinate('solo')?.name, 'Surakarta')
  assert.equal(resolveCityCoordinate('bali')?.name, 'Denpasar')
  assert.equal(resolveCityCoordinate('kota bandung')?.name, 'Bandung')
  assert.equal(resolveCityCoordinate('tangsel')?.name, 'Tangerang Selatan')
})

test('2. calculateJadwalOffline computes exact Jakarta times for 24 Oct 2026', () => {
  const jakarta = INDONESIAN_CITIES['jakarta']
  assert.ok(jakarta)

  const date = new Date('2026-10-24T00:00:00.000Z')
  const jadwal = calculateJadwalOffline(jakarta, date)

  assert.equal(jadwal.subuh, '04:12')
  assert.equal(jadwal.imsak, '04:02')
  assert.equal(jadwal.dzuhur, '11:40')
  assert.equal(jadwal.ashar, '14:51')
  assert.equal(jadwal.maghrib, '17:49')
  assert.equal(jadwal.isya, '18:59')
})

test('3. calculateJadwalOffline computes proper WITA and WIT times', () => {
  const denpasar = resolveCityCoordinate('denpasar') // WITA (+8)
  const jayapura = resolveCityCoordinate('jayapura') // WIT (+9)

  assert.equal(denpasar?.tzName, 'WITA')
  assert.equal(jayapura?.tzName, 'WIT')

  assert.ok(denpasar)
  assert.ok(jayapura)
  const date = new Date('2026-10-24T00:00:00.000Z')
  const jBali = calculateJadwalOffline(denpasar, date)
  const jJayapura = calculateJadwalOffline(jayapura, date)

  assert.ok(jBali.subuh)
  assert.ok(jJayapura.subuh)
})
