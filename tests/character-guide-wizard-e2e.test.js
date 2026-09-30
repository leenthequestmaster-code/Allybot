import dotenv from 'dotenv'
dotenv.config({ path: '.env.test' })

import test from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import pino from 'pino'
import { randomBytes } from 'node:crypto'
import { createPostgresCharacterClient } from '../dist/services/character-postgres-client.js'
import { CharacterGuideService } from '../dist/services/character-guide-service.js'
import { CharacterRegistrationWizardService } from '../dist/services/character-registration-wizard.js'

const TEST_POSTGRES_URL = process.env.DISPOSABLE_POSTGRES_URL || 'postgres://allybot_test_runner:***@127.0.0.1:5433/allybot_isolated_test'

test('Integration: Character Wizard full creation through Service & DB', async () => {
  const sql = postgres(TEST_POSTGRES_URL, { max: 2 })
  const logger = pino({ level: 'silent' })

  // Initialize DB client & service matching Allybot contracts
  const charClient = createPostgresCharacterClient({ postgresUrl: TEST_POSTGRES_URL })
  const service = new CharacterGuideService(logger, {
    env: { CHARACTER_GUIDE_ENABLED: 'true' },
    createClient: () => charClient,
  })
  service.initialize({ logger, config: {}, services: {} })

  const wizard = new CharacterRegistrationWizardService()
  const nonce = randomBytes(4).toString('hex')
  const testUser = `62812${Math.floor(10000000 + Math.random() * 90000000)}@s.whatsapp.net`
  const charName = `Hero ${nonce}`

  try {
    // 1. Initial state: user has no character
    const preCheck = await service.getActiveForOwner(testUser)
    assert.equal(preCheck, undefined)

    // 2. Start wizard session
    const start = wizard.startSession(testUser)
    assert.match(start.prompt, /Siapakah nama karakter/)

    // 3. Step 1: Name
    const s1 = await wizard.handleInput(testUser, charName)
    assert.match(s1.reply, /Pilih jenis kelamin/)

    // 4. Step 2: Gender
    const s2 = await wizard.handleInput(testUser, '1') // Male
    assert.match(s2.reply, /Berapa usia karaktermu/)

    // 5. Step 3: Age
    const s3 = await wizard.handleInput(testUser, '25')
    assert.match(s3.reply, /Pilih hari dan bulan kelahiran/)

    // 6. Step 4: Birthday (auto)
    const s4 = await wizard.handleInput(testUser, 'auto')
    assert.match(s4.reply, /Pilih Ras untuk karaktermu/)

    // 7. Step 5: Race
    const s5 = await wizard.handleInput(testUser, 'Elf')
    assert.match(s5.reply, /Pilih Kelas bertarung/)

    // 8. Step 6: Class
    const s6 = await wizard.handleInput(testUser, 'Archer')
    assert.match(s6.reply, /Pilih Elemen kekuatan/)

    // 9. Step 7: Element (Nature allowed for Elf)
    const s7 = await wizard.handleInput(testUser, 'Nature')
    assert.match(s7.reply, /Pilih Jalur Kehendak/)

    // 10. Step 8: Will of Path
    const s8 = await wizard.handleInput(testUser, '1') // Light
    assert.match(s8.reply, /Langkah Opsional/)

    // 11. Step 9: Flavor (Motto)
    const s9 = await wizard.handleInput(testUser, 'Motto: Selalu Berjuang')
    assert.match(s9.reply, /KONFIRMASI PENDAFTARAN KARAKTER/)
    assert.match(s9.reply, new RegExp(charName))

    // 12. Step 10: Confirm
    const finish = await wizard.handleInput(testUser, '!confirm')
    assert.equal(finish.isComplete, true)
    assert.ok(finish.data)

    // 13. Save via service.saveFromWizard
    const saved = await service.saveFromWizard(testUser, finish.data)
    assert.equal(saved.name, charName)
    assert.equal(saved.status, 'saved')

    // 14. Verify in DB
    const active = await service.getActiveForOwner(testUser)
    assert.ok(active)
    assert.equal(active.name, charName)
    assert.equal(active.race, 'Elf')
    assert.equal(active.className, 'Archer')
    assert.equal(active.element, 'Nature')
    assert.equal(active.willOfPath, 'Light')
    assert.equal(active.level, 1)
    assert.equal(active.rank, 'F-')
    assert.equal(active.motto, 'Selalu Berjuang')

    // 15. Verify that starting wizard again is blocked by getActiveForOwner
    const existing = await service.getActiveForOwner(testUser)
    assert.ok(existing)
  } finally {
    // Cleanup synthetic test character
    await sql`DELETE FROM character_profiles WHERE name = ${charName}`.catch(() => {})
    await sql.end()
  }
})
