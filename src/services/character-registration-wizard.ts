import {
  CHARACTER_GENDERS,
  CHARACTER_RACES,
  CHARACTER_CLASSES,
  CHARACTER_ELEMENTS,
  CHARACTER_BIRTH_MONTHS,
  CHARACTER_WILL_OF_PATHS,
  type CharacterGender,
  type CharacterRace,
  type CharacterClass,
  type CharacterElement,
  type CharacterWillOfPath,
  type CharacterSheetPayload,
} from './character-sheet-parser.js'

export type WizardStep =
  | 'name'
  | 'gender'
  | 'age'
  | 'birthday'
  | 'race'
  | 'class'
  | 'element'
  | 'will_of_path'
  | 'flavor'
  | 'confirm'

export interface WizardDraftData {
  name?: string
  gender?: CharacterGender
  age?: number
  birthdayDay?: number
  birthdayMonth?: string
  birthdayYear?: number
  race?: CharacterRace
  className?: CharacterClass
  element?: CharacterElement
  willOfPath?: CharacterWillOfPath
  spirit?: string
  crew?: string
  profession?: string
  motto?: string
  origin?: string
}

export interface WizardSession {
  readonly userJid: string
  readonly originGroupJid?: string
  currentStep: WizardStep
  draft: WizardDraftData
  history: WizardStep[]
  createdAt: number
  lastActivityAt: number
}

const STEP_ORDER: WizardStep[] = [
  'name',
  'gender',
  'age',
  'birthday',
  'race',
  'class',
  'element',
  'will_of_path',
  'flavor',
  'confirm',
]

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

export class CharacterRegistrationWizardService {
  private readonly sessions = new Map<string, WizardSession>()

  private normalizeKey(userJid: string): string {
    return userJid.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
  }

  getSession(userJid: string): WizardSession | undefined {
    this.pruneExpired()
    const key = this.normalizeKey(userJid)
    return this.sessions.get(key)
  }

  hasActiveSession(userJid: string): boolean {
    return this.getSession(userJid) !== undefined
  }

  startSession(userJid: string, originGroupJid?: string): { prompt: string } {
    this.pruneExpired()
    const key = this.normalizeKey(userJid)
    const session: WizardSession = {
      userJid: key,
      originGroupJid,
      currentStep: 'name',
      draft: {},
      history: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    }
    this.sessions.set(key, session)
    return { prompt: this.renderPromptForStep(session) }
  }

  cancelSession(userJid: string): { ok: boolean; message: string } {
    const key = this.normalizeKey(userJid)
    if (this.sessions.has(key)) {
      this.sessions.delete(key)
      return { ok: true, message: '🚪 Sesi pendaftaran karakter berhasil dibatalkan. Ketik *!daftar* kapan saja jika ingin memulai kembali.' }
    }
    return { ok: false, message: 'Tidak ada sesi pendaftaran aktif yang sedang berjalan.' }
  }

  previousStep(userJid: string): { prompt: string; ok: boolean } {
    const session = this.getSession(userJid)
    if (!session) {
      return { ok: false, prompt: 'Tidak ada sesi pendaftaran aktif. Ketik *!daftar* untuk memulai.' }
    }
    if (session.history.length === 0) {
      return { ok: false, prompt: `Kamu sudah berada di langkah pertama!\n\n${this.renderPromptForStep(session)}` }
    }
    const previous = session.history.pop()!
    session.currentStep = previous
    session.lastActivityAt = Date.now()
    return { ok: true, prompt: `🔙 *Kembali ke langkah sebelumnya:*\n\n${this.renderPromptForStep(session)}` }
  }

  skipStep(userJid: string): { prompt: string; ok: boolean } {
    const session = this.getSession(userJid)
    if (!session) {
      return { ok: false, prompt: 'Tidak ada sesi pendaftaran aktif. Ketik *!daftar* untuk memulai.' }
    }

    if (session.currentStep === 'flavor') {
      session.history.push(session.currentStep)
      session.currentStep = 'confirm'
      session.lastActivityAt = Date.now()
      return { ok: true, prompt: this.renderPromptForStep(session) }
    }

    return {
      ok: false,
      prompt: '⚠️ Langkah ini wajib diisi dan tidak dapat dilewati. Silakan masukkan jawabanmu atau ketik *!prev* untuk kembali ke langkah sebelumnya.',
    }
  }

  async handleInput(
    userJid: string,
    rawText: string,
    nameAvailabilityChecker?: (name: string) => Promise<boolean>,
  ): Promise<{ reply: string; isComplete?: boolean; data?: CharacterSheetPayload }> {
    const session = this.getSession(userJid)
    if (!session) {
      return { reply: 'Tidak ada sesi pendaftaran aktif. Ketik *!daftar* untuk memulai petualanganmu!' }
    }

    const text = rawText.trim()
    session.lastActivityAt = Date.now()

    // 1. Navigation shortcuts
    const lower = text.toLowerCase()
    if (lower === '!batal' || lower === 'batal' || lower === 'cancel') {
      const res = this.cancelSession(userJid)
      return { reply: res.message }
    }
    if (lower === '!prev' || lower === 'prev' || lower === 'kembali') {
      const res = this.previousStep(userJid)
      return { reply: res.prompt }
    }
    if (lower === '!next' || lower === 'next' || lower === 'skip' || lower === 'lewati') {
      const res = this.skipStep(userJid)
      return { reply: res.prompt }
    }

    // 2. Process current step
    switch (session.currentStep) {
      case 'name': {
        if (text.length < 2 || text.length > 60) {
          return { reply: '⚠️ Nama karakter harus memiliki panjang antara 2 sampai 60 karakter. Silakan coba lagi:' }
        }
        if (text.startsWith('@')) {
          return { reply: '⚠️ Nama karakter tidak boleh diawali dengan tanda @. Silakan masukkan nama lain:' }
        }
        if (/^(\+?62|08)[0-9]{8,13}$/u.test(text.replace(/[\s-]/gu, ''))) {
          return { reply: '⚠️ Nama karakter tidak boleh berupa nomor telepon. Masukkan nama roleplay karaktermu:' }
        }

        if (nameAvailabilityChecker) {
          const isAvailable = await nameAvailabilityChecker(text)
          if (!isAvailable) {
            return { reply: `⚠️ Nama *${text}* sudah digunakan oleh karakter aktif lain. Silakan pilih nama yang berbeda ya!` }
          }
        }

        session.draft.name = text
        session.history.push(session.currentStep)
        session.currentStep = 'gender'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'gender': {
        let gender: CharacterGender | undefined
        if (lower === '1' || lower === 'pria' || lower === 'male' || lower === 'laki-laki' || lower === 'laki laki') {
          gender = 'Male'
        } else if (lower === '2' || lower === 'wanita' || lower === 'female' || lower === 'perempuan') {
          gender = 'Female'
        } else if (lower === '3' || lower === 'non-binary' || lower === 'nonbinary' || lower === 'non biner') {
          gender = 'Non-Binary'
        }

        if (!gender) {
          return { reply: '⚠️ Pilihan jenis kelamin tidak valid. Balas dengan angka *1* (Pria), *2* (Wanita), atau *3* (Non-Binary):' }
        }

        session.draft.gender = gender
        session.history.push(session.currentStep)
        session.currentStep = 'age'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'age': {
        const ageNum = parseInt(text, 10)
        if (isNaN(ageNum) || ageNum < 5 || ageNum > 500 || !/^[0-9]+$/.test(text)) {
          return { reply: '⚠️ Usia harus berupa bilangan bulat positif antara 5 sampai 500 tahun. Contoh: 20\nSilakan coba lagi:' }
        }

        session.draft.age = ageNum
        session.history.push(session.currentStep)
        session.currentStep = 'birthday'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'birthday': {
        if (lower === 'auto' || lower === 'random' || lower === 'acak') {
          const randomDay = Math.floor(Math.random() * 30) + 1
          const randomMonth = CHARACTER_BIRTH_MONTHS[Math.floor(Math.random() * CHARACTER_BIRTH_MONTHS.length)]!
          session.draft.birthdayDay = randomDay
          session.draft.birthdayMonth = randomMonth
          session.draft.birthdayYear = 800 - (session.draft.age ?? 20)
        } else {
          // Format expected: "<day 1-30> <month>"
          const parts = text.split(/\s+/)
          if (parts.length < 2) {
            return { reply: '⚠️ Format tidak valid. Contoh format: `15 Zephyra` atau `15 3` (atau ketik *auto* untuk dipilihkan otomatis):' }
          }
          const day = parseInt(parts[0] ?? '', 10)
          if (isNaN(day) || day < 1 || day > 30) {
            return { reply: '⚠️ Hari kelahiran harus antara 1 sampai 30. Contoh: `15 Zephyra`:' }
          }

          let month: string | undefined
          const monthQuery = parts.slice(1).join(' ').trim().toLowerCase()
          const monthNum = parseInt(monthQuery, 10)

          if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
            month = CHARACTER_BIRTH_MONTHS[monthNum - 1]
          } else {
            month = CHARACTER_BIRTH_MONTHS.find((m) => m.toLowerCase() === monthQuery)
          }

          if (!month) {
            return { reply: `⚠️ Bulan tidak ditemukan. Pilihan bulan (1-12):\n${CHARACTER_BIRTH_MONTHS.map((m, idx) => `${idx + 1}. ${m}`).join(', ')}\n\nContoh: \`15 Zephyra\` atau \`15 3\`:` }
          }

          session.draft.birthdayDay = day
          session.draft.birthdayMonth = month
          session.draft.birthdayYear = 800 - (session.draft.age ?? 20)
        }

        session.history.push(session.currentStep)
        session.currentStep = 'race'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'race': {
        let race: CharacterRace | undefined
        const num = parseInt(text, 10)
        if (!isNaN(num) && num >= 1 && num <= CHARACTER_RACES.length) {
          race = CHARACTER_RACES[num - 1]
        } else {
          race = CHARACTER_RACES.find((r) => r.toLowerCase() === lower)
        }

        if (!race) {
          return { reply: `⚠️ Ras *${text}* tidak dikenal. Silakan pilih nomor (1-17) atau nama ras yang tersedia:\n${CHARACTER_RACES.map((r, i) => `${i + 1}. ${r}`).join(', ')}` }
        }

        session.draft.race = race
        session.history.push(session.currentStep)
        session.currentStep = 'class'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'class': {
        let className: CharacterClass | undefined
        const num = parseInt(text, 10)
        if (!isNaN(num) && num >= 1 && num <= CHARACTER_CLASSES.length) {
          className = CHARACTER_CLASSES[num - 1]
        } else {
          className = CHARACTER_CLASSES.find((c) => c.toLowerCase() === lower)
        }

        if (!className) {
          return { reply: `⚠️ Kelas *${text}* tidak ditemukan. Silakan ketik nama kelas dari daftar yang ada (contoh: *Knight*, *Mage*, *Archer*, *Samurai*):` }
        }

        session.draft.className = className
        session.history.push(session.currentStep)

        // Racial element lock check:
        // Slime -> Gel, Vampire -> Blood
        if (session.draft.race === 'Slime') {
          session.draft.element = 'Gel'
          session.currentStep = 'will_of_path'
          return {
            reply: `💧 *Penyelarasan Rasial:*\nKarena ras karaktermu adalah *Slime*, elemenmu otomatis diselaraskan dengan *Gel* (Lendir Magis)!\n\n` + this.renderPromptForStep(session),
          }
        }

        if (session.draft.race === 'Vampire') {
          session.draft.element = 'Blood'
          session.currentStep = 'will_of_path'
          return {
            reply: `🩸 *Penyelarasan Rasial:*\nKarena ras karaktermu adalah *Vampire*, elemenmu otomatis diselaraskan dengan *Blood* (Darah Terkutuk)!\n\n` + this.renderPromptForStep(session),
          }
        }

        session.currentStep = 'element'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'element': {
        let element: CharacterElement | undefined
        element = CHARACTER_ELEMENTS.find((e) => e.toLowerCase() === lower)

        if (!element) {
          return { reply: `⚠️ Elemen *${text}* tidak valid. Pilihan elemen yang tersedia:\nFire, Water, Wind, Earth, Electro, Ice, Dark, Light, Sound, Bone, Sand, Mist, Fruits, Paper, Magma` }
        }

        // Validate racial element restrictions
        if (element === 'Nature' && session.draft.race !== 'Dryad' && session.draft.race !== 'Elf') {
          return { reply: '⚠️ Elemen *Nature* murni dikhususkan untuk ras *Dryad* dan *Elf*. Silakan pilih elemen lain:' }
        }
        if (element === 'Blood' && session.draft.race !== 'Vampire') {
          return { reply: '⚠️ Elemen *Blood* hanya dapat dikuasai oleh ras *Vampire*. Silakan pilih elemen lain:' }
        }
        if (element === 'Gel' && session.draft.race !== 'Slime') {
          return { reply: '⚠️ Elemen *Gel* hanya dapat dikuasai oleh ras *Slime*. Silakan pilih elemen lain:' }
        }

        session.draft.element = element
        session.history.push(session.currentStep)
        session.currentStep = 'will_of_path'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'will_of_path': {
        let will: CharacterWillOfPath | undefined
        if (lower === '1' || lower === 'light' || lower === 'terang') will = 'Light'
        else if (lower === '2' || lower === 'dark' || lower === 'kegelapan') will = 'Dark'
        else if (lower === '3' || lower === 'neutral' || lower === 'netral') will = 'Neutral'

        if (!will) {
          return { reply: '⚠️ Pilihan jalur kehendak tidak valid. Balas dengan angka *1* (Light), *2* (Dark), atau *3* (Neutral):' }
        }

        session.draft.willOfPath = will
        session.history.push(session.currentStep)
        session.currentStep = 'flavor'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'flavor': {
        if (lower !== 'skip' && lower !== 'lewati' && lower !== '-') {
          // Parse flavor fields: Asal, Profesi, Motto, Spirit
          const segments = text.split('|').map((s) => s.trim())
          for (const seg of segments) {
            const [k, ...v] = seg.split(':')
            const key = k?.trim().toLowerCase()
            const val = v.join(':').trim()
            if (val) {
              if (key === 'asal' || key === 'origin') session.draft.origin = val.slice(0, 60)
              if (key === 'profesi' || key === 'job') session.draft.profession = val.slice(0, 60)
              if (key === 'motto' || key === 'quote') session.draft.motto = val.slice(0, 120)
              if (key === 'spirit' || key === 'roh') session.draft.spirit = val.slice(0, 60)
            }
          }
          if (!session.draft.origin && !session.draft.profession && !session.draft.motto && !session.draft.spirit) {
            session.draft.motto = text.slice(0, 120)
          }
        }

        session.history.push(session.currentStep)
        session.currentStep = 'confirm'
        return { reply: this.renderPromptForStep(session) }
      }

      case 'confirm': {
        if (lower === '!confirm' || lower === 'confirm' || lower === 'ya' || lower === 'setuju' || lower === 'selesai') {
          // Build final payload
          const d = session.draft
          const payload: CharacterSheetPayload = {
            name: d.name!,
            gender: d.gender!,
            age: d.age!,
            birthdayDay: d.birthdayDay!,
            birthdayMonth: d.birthdayMonth!,
            birthdayYear: d.birthdayYear!,
            race: d.race!,
            className: d.className!,
            element: d.element!,
            willOfPath: d.willOfPath!,
            spirit: d.spirit,
            crew: d.crew,
            profession: d.profession,
            motto: d.motto,
            origin: d.origin,
          }

          // Complete session
          this.sessions.delete(this.normalizeKey(userJid))
          return {
            reply: '🎉 *Pendaftaran Sukses!* Menghubungkan ke registri Benua Allyssea...',
            isComplete: true,
            data: payload,
          }
        }

        return {
          reply: '⚠️ Ketik *!confirm* untuk meresmikan karaktermu, atau ketik *!prev* jika ingin memperbaiki data sebelumnya.\n(Ketik *!batal* untuk membatalkan)',
        }
      }
    }
  }

  private renderPromptForStep(session: WizardSession): string {
    const d = session.draft
    switch (session.currentStep) {
      case 'name':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [1/9]',
          '─────────────────────────────────',
          'Selamat datang, petualang! Siapakah nama karakter yang ingin kamu daftarkan?',
          '',
          '• _Panjang nama 2 - 60 karakter._',
          '• _Dilarang menggunakan awalan @ atau nomor telepon._',
          '• _Contoh: Zean Serfort, Arthur Pendragon, Risami_',
          '',
          'Ketik nama karaktermu di bawah ini:',
        ].join('\n')

      case 'gender':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [2/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}*`,
          '',
          'Pilih jenis kelamin karaktermu:',
          '1. 👨 *Pria* (Male)',
          '2. 👩 *Wanita* (Female)',
          '3. ⚧️ *Non-Binary*',
          '',
          'Balas dengan angka *1*, *2*, atau *3*:',
          '_(Ketik !prev untuk mengganti nama)_',
        ].join('\n')

      case 'age':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [3/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}* (${d.gender})`,
          '',
          'Berapa usia karaktermu?',
          '• _Rentang usia: 5 sampai 500 tahun._',
          '• _Contoh: 20_',
          '',
          'Ketik usia karaktermu:',
          '_(Ketik !prev untuk kembali ke pilihan jenis kelamin)_',
        ].join('\n')

      case 'birthday':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [4/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}* · Usia: ${d.age} Tahun`,
          '',
          'Pilih hari dan bulan kelahiran (Kalender Allyssea):',
          '• Format: `<hari 1-30> <bulan 1-12>` (Contoh: `15 3` atau `15 Zephyra`)',
          '',
          'Daftar Bulan Allyssea:',
          '1. Aurion       5. Luminara     9. Umbralis',
          '2. Florentis    6. Verdantia   10. Crystelle',
          '3. Zephyra      7. Solmora     11. Nocturne',
          '4. Emberfall    8. Astravia    12. Everglen',
          '',
          '_Atau ketik *auto* untuk dipilihkan tanggal lahir acak secara otomatis._',
          '_(Ketik !prev untuk kembali ke langkah usia)_',
        ].join('\n')

      case 'race':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [5/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}*`,
          '',
          'Pilih Ras untuk karaktermu:',
          '1. Human        7. Fairy        13. Beastfolk',
          '2. Elf          8. Vampire      14. Kitsune',
          '3. Dark Elf     9. Pisces       15. Dryad',
          '4. Dwarf       10. Harpy        16. Demon',
          '5. Giant       11. Slime        17. Angel',
          '6. Orc         12. Dragonborn',
          '',
          'Balas dengan nomor (1-17) atau nama ras pilihanmu:',
          '_(Ketik !prev untuk kembali ke tanggal lahir)_',
        ].join('\n')

      case 'class':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [6/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}* · Ras: *${d.race}*`,
          '',
          'Pilih Kelas bertarung untuk karaktermu:',
          '',
          '⚔️ *Fisik:*',
          'Knight, Samurai, Berserker, Guardian, Sentinel, Bulwark',
          '',
          '🏹 *Jarak Jauh & Kelincahan:*',
          'Archer, Gunslinger, Sniper, Thief, Assassin, Ninja',
          '',
          '🔮 *Sihir & Supranatural:*',
          'Sorcerer, Necromancer, Illusionist, Summoner',
          '',
          '✨ *Taktis & Suportif:*',
          'Paladin, Bard, Cleric, Trapper, Mechanist, Saboteur, Puppeteer, Jester, Sigil Scribe, Beastmaster, Shapeshifter',
          '',
          'Ketik nama kelas pilihanmu:',
          '_(Ketik !prev untuk kembali ke pilihan ras)_',
        ].join('\n')

      case 'element': {
        const isNatureAllowed = d.race === 'Dryad' || d.race === 'Elf'
        const natureNote = isNatureAllowed ? ', Nature' : ''
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [7/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}* · Kelas: *${d.className}*`,
          '',
          'Pilih Elemen kekuatan karaktermu:',
          `Fire, Water, Wind, Earth, Electro, Ice, Dark, Light, Sound, Bone, Sand, Mist, Fruits, Paper, Magma${natureNote}`,
          '',
          'Ketik nama elemen pilihanmu:',
          '_(Ketik !prev untuk kembali ke pilihan kelas)_',
        ].join('\n')
      }

      case 'will_of_path':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [8/9]',
          '─────────────────────────────────',
          `Karakter: *${d.name}*`,
          '',
          'Pilih Jalur Kehendak (*Will of Path*):',
          '1. ☀️ *Light* (Penjaga Harmoni, Kebaikan)',
          '2. 🌑 *Dark* (Pemberontak, Ambisi Gelap)',
          '3. ⚖️ *Neutral* (Keseimbangan, Pengelana Bebas)',
          '',
          'Balas dengan angka *1*, *2*, atau *3*:',
          '_(Ketik !prev untuk kembali ke pilihan elemen)_',
        ].join('\n')

      case 'flavor':
        return [
          '📜 *REGISTRI WARGA BENUA ALLYSSEA* [9/9]',
          '─────────────────────────────────',
          '[Langkah Opsional] Tambahkan latar belakang karaktermu:',
          'Format: `Asal: <daerah> | Profesi: <pekerjaan> | Motto: <motto>`',
          '',
          'Contoh:',
          'Asal: Hutan Zephyra | Profesi: Ksatria Pengembara | Motto: Pantang Menyerah',
          '',
          '_Ketik *skip* atau *!next* untuk melewati langkah ini._',
          '_(Ketik !prev untuk kembali ke pilihan kehendak)_',
        ].join('\n')

      case 'confirm':
        return [
          '╔═══════════════════════════════╗',
          '    KONFIRMASI PENDAFTARAN KARAKTER',
          '╚═══════════════════════════════╝',
          `Nama       : *${d.name}*`,
          `Kelamin    : ${d.gender}`,
          `Usia       : ${d.age} Tahun`,
          `Kelahiran  : ${d.birthdayDay} ${d.birthdayMonth} ${d.birthdayYear} KAR`,
          `Ras        : ${d.race}`,
          `Kelas      : ${d.className}`,
          `Elemen     : ${d.element}`,
          `Kehendak   : ${d.willOfPath}`,
          d.origin ? `Asal       : ${d.origin}` : '',
          d.profession ? `Profesi    : ${d.profession}` : '',
          d.motto ? `Motto      : "${d.motto}"` : '',
          '─────────────────────────────────',
          'Apakah semua data di atas sudah benar?',
          '',
          '• Ketik *!confirm* untuk meresmikan karakter & menerima Status Card!',
          '• Ketik *!prev* jika ingin memperbaiki langkah sebelumnya.',
          '• Ketik *!batal* untuk membatalkan pendaftaran.',
        ].filter(Boolean).join('\n')
    }
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS) {
        this.sessions.delete(key)
      }
    }
  }
}
