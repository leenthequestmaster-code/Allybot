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
  const step4 = await wizard.handleInput(user, '15 Akmesya')
  assert.match(step4.reply, /Pilih Ras untuk karaktermu/)

  // 5. Race
  const step5 = await wizard.handleInput(user, 'Dragon')
  assert.match(step5.reply, /Pilih Spesialisasi Kelas/)

  // 6. Class
  const step6 = await wizard.handleInput(user, 'Warrior')
  assert.match(step6.reply, /Pilih Elemen kekuatan/)

  // 7. Element
  const step7 = await wizard.handleInput(user, 'Fire')
  assert.match(step7.reply, /Pilih Poros Peradaban/)

  // 8. Will of Path
  const step8 = await wizard.handleInput(user, '1') // Light
  assert.match(step8.reply, /Langkah Opsional/)

  // 9. Flavor (skip)
  const step9 = await wizard.handleInput(user, 'skip')
  assert.match(step9.reply, /KONFIRMASI PENDAFTARAN KARAKTER/)
  assert.match(step9.reply, /Zean Serfort/)
  assert.match(step9.reply, /Dragon/)
  assert.match(step9.reply, /Warrior/)
  assert.match(step9.reply, /Fire/)

  // 10. Confirm
  const finish = await wizard.handleInput(user, '!confirm')
  assert.equal(finish.isComplete, true)
  assert.ok(finish.data)
  assert.equal(finish.data.name, 'Zean Serfort')
  assert.equal(finish.data.gender, 'Male')
  assert.equal(finish.data.age, 24)
  assert.equal(finish.data.birthdayDay, 15)
  assert.equal(finish.data.birthdayMonth, 'Akmesya')
  assert.equal(finish.data.birthdayYear, 478 - 24)
  assert.equal(finish.data.race, 'Dragon')
  assert.equal(finish.data.className, 'Warrior')
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

test('Wizard: Race and Class selection flow', async () => {
  const wizard = new CharacterRegistrationWizardService()
  const userGiant = '6281111111111@s.whatsapp.net'

  wizard.startSession(userGiant)
  await wizard.handleInput(userGiant, 'Gorg')
  await wizard.handleInput(userGiant, '1') // Male
  await wizard.handleInput(userGiant, '30')
  await wizard.handleInput(userGiant, 'auto') // random bday
  const raceRes = await wizard.handleInput(userGiant, 'Giant') // Race Giant (Primordial)
  assert.match(raceRes.reply, /Pilih Spesialisasi Kelas/)

  // Select class
  const classRes = await wizard.handleInput(userGiant, 'Guardian')
  assert.match(classRes.reply, /Pilih Elemen kekuatan/)
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
