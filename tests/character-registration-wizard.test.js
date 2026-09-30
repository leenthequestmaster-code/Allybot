import test from 'node:test'
import assert from 'node:assert/strict'
import { CharacterRegistrationWizardService } from '../dist/services/character-registration-wizard.js'

test('Wizard: Happy path completes full character registration payload', async () => {
  const wizard = new CharacterRegistrationWizardService()
  const user = '6281234567890@s.whatsapp.net'

  // Start
  const start = wizard.startSession(user)
  assert.match(start.prompt, /Siapakah nama karakter/)

  // 1. Name
  const step1 = await wizard.handleInput(user, 'Zean Serfort')
  assert.match(step1.reply, /Pilih jenis kelamin/)

  // 2. Gender
  const step2 = await wizard.handleInput(user, '1') // Male
  assert.match(step2.reply, /Berapa usia karaktermu/)

  // 3. Age
  const step3 = await wizard.handleInput(user, '24')
  assert.match(step3.reply, /Pilih hari dan bulan kelahiran/)

  // 4. Birthday
  const step4 = await wizard.handleInput(user, '15 Zephyra')
  assert.match(step4.reply, /Pilih Ras untuk karaktermu/)

  // 5. Race
  const step5 = await wizard.handleInput(user, 'Dragonborn')
  assert.match(step5.reply, /Pilih Kelas bertarung/)

  // 6. Class
  const step6 = await wizard.handleInput(user, 'Knight')
  assert.match(step6.reply, /Pilih Elemen kekuatan/)

  // 7. Element
  const step7 = await wizard.handleInput(user, 'Fire')
  assert.match(step7.reply, /Pilih Jalur Kehendak/)

  // 8. Will of Path
  const step8 = await wizard.handleInput(user, '1') // Light
  assert.match(step8.reply, /Langkah Opsional/)

  // 9. Flavor (skip)
  const step9 = await wizard.handleInput(user, 'skip')
  assert.match(step9.reply, /KONFIRMASI PENDAFTARAN KARAKTER/)
  assert.match(step9.reply, /Zean Serfort/)
  assert.match(step9.reply, /Dragonborn/)
  assert.match(step9.reply, /Knight/)
  assert.match(step9.reply, /Fire/)

  // 10. Confirm
  const finish = await wizard.handleInput(user, '!confirm')
  assert.equal(finish.isComplete, true)
  assert.ok(finish.data)
  assert.equal(finish.data.name, 'Zean Serfort')
  assert.equal(finish.data.gender, 'Male')
  assert.equal(finish.data.age, 24)
  assert.equal(finish.data.birthdayDay, 15)
  assert.equal(finish.data.birthdayMonth, 'Zephyra')
  assert.equal(finish.data.birthdayYear, 800 - 24)
  assert.equal(finish.data.race, 'Dragonborn')
  assert.equal(finish.data.className, 'Knight')
  assert.equal(finish.data.element, 'Fire')
  assert.equal(finish.data.willOfPath, 'Light')

  // After completion, session should be deleted
  assert.equal(wizard.hasActiveSession(user), false)
})

test('Wizard: Navigation !prev goes back and recovers prompt', async () => {
  const wizard = new CharacterRegistrationWizardService()
  const user = '6281234567890@s.whatsapp.net'

  wizard.startSession(user)
  await wizard.handleInput(user, 'Arthur')
  await wizard.handleInput(user, '1') // Male -> now on age step

  const prevRes = await wizard.handleInput(user, '!prev')
  assert.match(prevRes.reply, /Pilih jenis kelamin/)

  // Change to female
  const changeRes = await wizard.handleInput(user, '2')
  assert.match(changeRes.reply, /Berapa usia karaktermu/)
  assert.match(changeRes.reply, /Female/)
})

test('Wizard: Racial element locking for Slime (Gel) and Vampire (Blood)', async () => {
  const wizard = new CharacterRegistrationWizardService()
  const userSlime = '6281111111111@s.whatsapp.net'

  wizard.startSession(userSlime)
  await wizard.handleInput(userSlime, 'Slimey')
  await wizard.handleInput(userSlime, '3') // Non-Binary
  await wizard.handleInput(userSlime, '10')
  await wizard.handleInput(userSlime, 'auto') // random bday
  await wizard.handleInput(userSlime, 'Slime') // Race Slime

  // Select class
  const classRes = await wizard.handleInput(userSlime, 'Sorcerer')
  // Should auto lock Gel and jump to Will of Path
  assert.match(classRes.reply, /Penyelarasan Rasial/)
  assert.match(classRes.reply, /Gel/)
  assert.match(classRes.reply, /Pilih Jalur Kehendak/)
})

test('Wizard: Input validation catches invalid values', async () => {
  const wizard = new CharacterRegistrationWizardService()
  const user = '6289999999999@s.whatsapp.net'

  wizard.startSession(user)

  // Name starting with @
  const badName = await wizard.handleInput(user, '@Zean')
  assert.match(badName.reply, /tidak boleh diawali dengan tanda @/)

  // Valid name
  await wizard.handleInput(user, 'Valid Name')

  // Invalid gender
  const badGender = await wizard.handleInput(user, 'unknown')
  assert.match(badGender.reply, /Pilihan jenis kelamin tidak valid/)

  await wizard.handleInput(user, '1') // Male

  // Invalid age
  const badAge = await wizard.handleInput(user, '999')
  assert.match(badAge.reply, /antara 5 sampai 500 tahun/)

  // Cancel
  const cancel = await wizard.handleInput(user, '!batal')
  assert.match(cancel.reply, /berhasil dibatalkan/)
  assert.equal(wizard.hasActiveSession(user), false)
})
