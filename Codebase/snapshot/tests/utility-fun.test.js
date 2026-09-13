import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { utilityPlugin } from '../dist/framework/plugins/utility.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

class FakeCore {
  isConnected = true
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.groupParticipantListeners.add(listener); return () => this.groupParticipantListeners.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async start() {}
  async close() {}
  async emitMessage(message) {
    await Promise.all([...this.messages].map((listener) => listener(message)))
  }
}

function message(id, senderJid, remoteJid, text, mentionedJids = [], metadata = {}) {
  return {
    id,
    senderJid,
    remoteJid,
    text,
    mentionedJids,
    timestamp: Date.now(),
    fromMe: false,
    ...metadata,
  }
}

// Every fun command declares cooldownMs: 1500 and the cooldown key is
// `${command.name}:${senderJid}`, so stateless exercises rotate unique senders
// (numeric JIDs to satisfy the strict JID grammar) and only stateful RPS flows
// ever reuse a sender across a sleep.
let senderSequence = 0
function nextSender() {
  senderSequence += 1
  return `62819${String(10000000 + senderSequence).slice(1)}@s.whatsapp.net`
}

async function createHarness() {
  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core)
  app.registerPlugin(utilityPlugin)
  await app.start()
  const send = (id, senderJid, remoteJid, text, mentionedJids = [], metadata = {}) => {
    const before = core.sent.length
    return core.emitMessage(message(id, senderJid, remoteJid, text, mentionedJids, metadata))
      .then(() => core.sent.slice(before))
  }
  return { core, app, send }
}

test('utility-fun registers the fun command surface with aliases and category', async () => {
  const harness = await createHarness()
  try {
    const names = harness.app.commands.list().map((command) => command.name)
    for (const name of ['random', 'choose', 'flip', 'roll', 'truth', 'dare', 'rps', '8ball']) {
      assert.equal(names.includes(name), true, `missing fun command ${name}`)
    }
    assert.equal(harness.app.commands.get('dice')?.name, 'roll')
    assert.equal(harness.app.commands.get('suit')?.name, 'rps')
    assert.equal(harness.app.commands.get('jujur')?.name, 'truth')
    assert.equal(harness.app.commands.get('tantangan')?.name, 'dare')
    assert.equal(harness.app.commands.get('rps')?.category, 'fun')
  } finally {
    await harness.app.stop()
  }
})

test('random replies with an in-range number and rejects malformed ranges', async () => {
  const harness = await createHarness()
  try {
    const [first] = await harness.send('rand-1', nextSender(), '<jid-redacted@g.us>', '!random 1 3')
    assert.match(first.text, /Angka acaknya: \*[1-3]\*/)

    const seen = new Set()
    for (let index = 0; index < 40; index += 1) {
      const [reply] = await harness.send(`rand-loop-${index}`, nextSender(), '<jid-redacted@g.us>', '!random 1 3')
      seen.add(Number(/\*([1-3])\*/.exec(reply.text)[1]))
    }
    assert.equal(seen.size >= 2, true, `expected multiple outcomes across 40 draws, saw ${[...seen]}`)

    const [missingMax] = await harness.send('rand-2', nextSender(), '<jid-redacted@g.us>', '!random 5')
    assert.match(missingMax.text, /Format: !random <min> <max>/)
    assert.match(missingMax.text, /Contoh: `!random 1 100`/)

    const [inverted] = await harness.send('rand-3', nextSender(), '<jid-redacted@g.us>', '!random 10 2')
    assert.match(inverted.text, /Format: !random <min> <max>/)

    const [nonInteger] = await harness.send('rand-4', nextSender(), '<jid-redacted@g.us>', '!random 1.5 3')
    assert.match(nonInteger.text, /Format: !random <min> <max>/)

    const [outOfBounds] = await harness.send('rand-5', nextSender(), '<jid-redacted@g.us>', '!random -1000000 1000001')
    assert.match(outOfBounds.text, /Format: !random <min> <max>/)
  } finally {
    await harness.app.stop()
  }
})

test('choose picks one pipe-separated option and enforces arity and length bounds', async () => {
  const harness = await createHarness()
  try {
    const seen = new Set()
    for (let index = 0; index < 40; index += 1) {
      const [reply] = await harness.send(`choose-${index}`, nextSender(), '<jid-redacted@g.us>', '!choose teh | kopi | susu')
      seen.add(/Pilihanku: \*(teh|kopi|susu)\*/.exec(reply.text)[1])
    }
    assert.equal(seen.size >= 2, true, `expected multiple outcomes across 40 draws, saw ${[...seen]}`)

    const [oneOption] = await harness.send('choose-1', nextSender(), '<jid-redacted@g.us>', '!choose teh')
    assert.match(oneOption.text, /Format: !choose <opsi 1> \| <opsi 2>/)

    const many = Array.from({ length: 21 }, (_, index) => `opsi${index}`).join(' | ')
    const [tooMany] = await harness.send('choose-2', nextSender(), '<jid-redacted@g.us>', `!choose ${many}`)
    assert.match(tooMany.text, /Format: !choose/)

    const [longOption] = await harness.send('choose-3', nextSender(), '<jid-redacted@g.us>', `!choose ${'x'.repeat(81)} | teh`)
    assert.match(longOption.text, /Format: !choose/)

    const [trimmed] = await harness.send('choose-4', nextSender(), '<jid-redacted@g.us>', '!choose   teh   |   kopi  ')
    assert.match(trimmed.text, /Pilihanku: \*(teh|kopi)\*/)
  } finally {
    await harness.app.stop()
  }
})

test('flip always lands on Kepala or Ekor', async () => {
  const harness = await createHarness()
  try {
    const seen = new Set()
    for (let index = 0; index < 20; index += 1) {
      const [reply] = await harness.send(`flip-${index}`, nextSender(), '<jid-redacted@g.us>', '!flip')
      seen.add(/Hasil lempar koin: \*(Kepala|Ekor)\*/.exec(reply.text)[1])
    }
    assert.deepEqual([...seen].every((face) => face === 'Kepala' || face === 'Ekor'), true)
    assert.equal(seen.size >= 1, true)
  } finally {
    await harness.app.stop()
  }
})

test('roll reports per-die values with a consistent total and rejects malformed dice', async () => {
  const harness = await createHarness()
  try {
    for (let index = 0; index < 10; index += 1) {
      const [reply] = await harness.send(`roll-${index}`, nextSender(), '<jid-redacted@g.us>', '!roll 3d6')
      const match = /🎲 3d6: ([1-6], [1-6], [1-6])\nTotal: \*(\d+)\*/.exec(reply.text)
      assert.equal(Boolean(match), true, `unexpected roll reply: ${reply.text}`)
      const dice = match[1].split(', ').map(Number)
      assert.equal(dice.length, 3)
      assert.equal(dice.every((value) => value >= 1 && value <= 6), true)
      assert.equal(Number(match[2]), dice.reduce((sum, value) => sum + value, 0))
    }

    const [alias] = await harness.send('roll-alias', nextSender(), '<jid-redacted@g.us>', '!dice 2d20')
    assert.match(alias.text, /2d20: /)

    for (const bad of ['!roll 0d6', '!roll 11d6', '!roll 2d1', '!roll 2d101', '!roll abc', '!roll']) {
      const [reply] = await harness.send(`roll-bad-${bad.replace(/\W+/g, '-')}`, nextSender(), '<jid-redacted@g.us>', bad)
      assert.match(reply.text, /Format: !roll <jumlah>d<sisi>/, `${bad} should be rejected`)
    }
  } finally {
    await harness.app.stop()
  }
})

test('truth and dare always answer from the curated prompt pools, including aliases', async () => {
  const harness = await createHarness()
  try {
    const truthPool = [
      'Apa hal kecil yang paling membuatmu senang minggu ini?',
      'Apa kebiasaan yang sedang ingin kamu perbaiki?',
      'Siapa yang paling sering membuatmu tertawa di grup ini?',
      'Apa keputusan sederhana yang ternyata paling membantu?',
      'Apa satu hal yang ingin kamu pelajari?',
    ]
    const seenTruth = new Set()
    for (let index = 0; index < 30; index += 1) {
      const [reply] = await harness.send(`truth-${index}`, nextSender(), '<jid-redacted@g.us>', '!truth')
      seenTruth.add(/🗣️ \*Truth:\* (.+)$/.exec(reply.text)[1])
    }
    assert.deepEqual([...seenTruth].every((prompt) => truthPool.includes(prompt)), true)

    const [aliasTruth] = await harness.send('truth-alias', nextSender(), '<jid-redacted@g.us>', '!jujur')
    assert.match(aliasTruth.text, /\*Truth:\*/)

    const darePool = [
      'Kirim satu pujian yang tulus kepada anggota grup.',
      'Tulis satu kalimat hanya dengan tiga kata.',
      'Gunakan emoji yang jarang kamu pakai untuk menggambarkan harimu.',
      'Bagikan rekomendasi lagu tanpa menjelaskan alasannya.',
      'Ucapkan terima kasih kepada seseorang di grup.',
    ]
    const seenDare = new Set()
    for (let index = 0; index < 30; index += 1) {
      const [reply] = await harness.send(`dare-${index}`, nextSender(), '<jid-redacted@g.us>', '!dare')
      seenDare.add(/🎯 \*Dare:\* (.+)$/.exec(reply.text)[1])
    }
    assert.deepEqual([...seenDare].every((prompt) => darePool.includes(prompt)), true)

    const [aliasDare] = await harness.send('dare-alias', nextSender(), '<jid-redacted@g.us>', '!tantangan')
    assert.match(aliasDare.text, /\*Dare:\*/)
  } finally {
    await harness.app.stop()
  }
})

test('8ball echoes the question and answers from the curated pool; empty input shows usage', async () => {
  const harness = await createHarness()
  try {
    const answers = [
      'Bisa jadi.',
      'Kemungkinannya cukup besar.',
      'Belum tentu; coba lihat lagi situasinya.',
      'Untuk sekarang, jawabannya belum jelas.',
      'Tanda-tandanya mengarah ke iya.',
      'Sepertinya belum.',
      'Coba tanyakan lagi nanti.',
      'Jawabannya: iya.',
    ]
    const seen = new Set()
    for (let index = 0; index < 40; index += 1) {
      const [reply] = await harness.send(`ball-${index}`, nextSender(), '<jid-redacted@g.us>', '!8ball apakah hari ini cerah?')
      const match = /🎱 \*apakah hari ini cerah\?\*\n(.+)$/.exec(reply.text)
      assert.equal(Boolean(match), true, `unexpected 8ball reply: ${reply.text}`)
      seen.add(match[1])
    }
    assert.deepEqual([...seen].every((answer) => answers.includes(answer)), true)

    const [empty] = await harness.send('ball-empty', nextSender(), '<jid-redacted@g.us>', '!8ball   ')
    assert.match(empty.text, /Format: !8ball <pertanyaan>/)
    assert.match(empty.text, /Contoh: `!8ball apakah hari ini cerah\?`/)
  } finally {
    await harness.app.stop()
  }
})

test('rps without a subcommand explains the PvP flow, including the help alias', async () => {
  const harness = await createHarness()
  try {
    const [help] = await harness.send('rps-help', nextSender(), '<jid-redacted@g.us>', '!rps')
    assert.match(help.text, /Suit PvP \(Player vs Player\)/)
    assert.match(help.text, /!rps challenge @pemain/)
    assert.match(help.text, /!rps batu\|gunting\|kertas/)
    assert.match(help.text, /!rps cancel/)
    assert.match(help.text, /!rps status/)

    const [explicit] = await harness.send('rps-help-2', nextSender(), '<jid-redacted@g.us>', '!rps help')
    assert.match(explicit.text, /Suit PvP/)
  } finally {
    await harness.app.stop()
  }
})

test('rps challenge requires a group, a mentioned opponent, and no self-challenge', async () => {
  const harness = await createHarness()
  try {
    const groupJid = '<jid-redacted@g.us>'

    const [privateAttempt] = await harness.send('rps-pm', '<jid-redacted@s.whatsapp.net>', '<jid-redacted@s.whatsapp.net>', '!rps challenge @bob', ['<jid-redacted@s.whatsapp.net>'])
    assert.match(privateAttempt.text, /Command challenge hanya bisa digunakan di grup/)

    const [noTarget] = await harness.send('rps-notarget', '<jid-redacted@s.whatsapp.net>', groupJid, '!rps challenge')
    assert.match(noTarget.text, /Mention atau reply pemain yang ingin ditantang/)

    const self = '<jid-redacted@s.whatsapp.net>'
    const [selfChallenge] = await harness.send('rps-self', self, groupJid, '!rps challenge @diri', [self])
    assert.match(selfChallenge.text, /Tidak bisa menantang diri sendiri/)
  } finally {
    await harness.app.stop()
  }
})

test('rps challenge announces in the group and DMs both players', async () => {
  const harness = await createHarness()
  try {
    const groupJid = '<jid-redacted@g.us>'
    const alice = '<jid-redacted@s.whatsapp.net>'
    const bob = '<jid-redacted@s.whatsapp.net>'

    const announcements = await harness.send('rps-ok', alice, groupJid, '!rps challenge @bob', [bob])
    assert.equal(announcements.length, 3, `expected group reply + 2 challenge DMs, got ${JSON.stringify(announcements)}`)

    assert.equal(announcements[0].remoteJid, groupJid)
    assert.match(announcements[0].text, /Tantangan Suit PvP/)
    assert.match(announcements[0].text, /berlaku 5 menit/i)
    assert.deepEqual([...announcements[0].options.mentions].sort(), [alice, bob].sort())

    assert.equal(announcements[1].remoteJid, alice)
    assert.match(announcements[1].text, /Kamu menantang @<phone-redacted>/)
    assert.match(announcements[1].text, /!rps batu/)

    assert.equal(announcements[2].remoteJid, bob)
    assert.match(announcements[2].text, /@<phone-redacted> menantangmu untuk Suit PvP/)
    assert.match(announcements[2].text, /!rps accept/)
  } finally {
    await harness.app.stop()
  }
})

test('rps choices are PM-only and need an active challenge; unknown choices show usage', async () => {
  const harness = await createHarness()
  try {
    const [groupChoice] = await harness.send('rps-group-choice', '<jid-redacted@s.whatsapp.net>', '<jid-redacted@g.us>', '!rps batu')
    assert.match(groupChoice.text, /Private Chat/)

    const loner = '<jid-redacted@s.whatsapp.net>'
    const [pmNoChallenge] = await harness.send('rps-pm-no-challenge', loner, loner, '!rps gunting')
    assert.match(pmNoChallenge.text, /Tidak ada tantangan aktif untukmu/)

    const [badChoice] = await harness.send('rps-bad', '<jid-redacted@s.whatsapp.net>', '<jid-redacted@s.whatsapp.net>', '!rps laser')
    assert.match(badChoice.text, /Format: !rps <batu\|gunting\|kertas>/)
  } finally {
    await harness.app.stop()
  }
})

test('rps duel completes when both players pick in PM and announces the result everywhere', async () => {
  const harness = await createHarness()
  try {
    const groupJid = '<jid-redacted@g.us>'
    const alice = '<jid-redacted@s.whatsapp.net>'
    const bob = '<jid-redacted@s.whatsapp.net>'

    await harness.send('duel-challenge', alice, groupJid, '!rps challenge @bob', [bob])
    const [accept] = await harness.send('duel-accept', bob, bob, '!rps accept')
    assert.match(accept.text, /Tantangan diterima/)
    assert.match(accept.text, /!rps batu.*!rps gunting.*!rps kertas/)

    // The 1500ms command cooldown is per command+sender; both players pick once
    // after the challenge/accept phase, so a single wait unblocks both.
    await new Promise((resolve) => setTimeout(resolve, 1_600))

    const [firstChoice] = await harness.send('duel-a1', alice, alice, '!rps batu')
    assert.match(firstChoice.text, /Pilihan \*batu\* dicatat/)
    assert.match(firstChoice.text, /Menunggu lawan/)
    assert.equal(harness.core.sent.some((entry) => entry.text.includes('Suit PvP Selesai')), false)

    const resolution = await harness.send('duel-b1', bob, bob, '!rps kertas')
    assert.equal(resolution.length, 4, `expected ack + 2 result DMs + group announcement, got ${JSON.stringify(resolution.map((e) => e.remoteJid))}`)
    assert.match(resolution[0].text, /Pilihan \*kertas\* dicatat/)

    for (const entry of resolution.slice(1)) {
      assert.match(entry.text, /Suit PvP Selesai/)
      assert.match(entry.text, /Challenger\* : batu/)
      assert.match(entry.text, /Challenged\* : kertas/)
      assert.match(entry.text, /\*Challenged menang!\*/)
    }
    assert.equal(resolution[1].remoteJid, alice)
    assert.equal(resolution[2].remoteJid, bob)
    assert.equal(resolution[3].remoteJid, groupJid)
    assert.deepEqual([...resolution[3].options.mentions].sort(), [alice, bob].sort())

    // The duel is consumed: neither player has an active challenge anymore.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    const [stale] = await harness.send('duel-a2', alice, alice, '!rps batu')
    assert.match(stale.text, /Tidak ada tantangan aktif untukmu/)
  } finally {
    await harness.app.stop()
  }
})

test('rps status lists active challenges with both participants and pending choices', async () => {
  const harness = await createHarness()
  try {
    const groupJid = '<jid-redacted@g.us>'
    const alice = '<jid-redacted@s.whatsapp.net>'
    const bob = '<jid-redacted@s.whatsapp.net>'

    const [empty] = await harness.send('status-empty', nextSender(), groupJid, '!rps status')
    assert.match(empty.text, /Tidak ada tantangan aktif/)

    await harness.send('status-challenge', alice, groupJid, '!rps challenge @bob', [bob])
    // Bob has not used !rps yet, so his status query is not throttled.
    const [status] = await harness.send('status-list', bob, groupJid, '!rps status')
    assert.match(status.text, /@<phone-redacted> vs @<phone-redacted>/)
    assert.match(status.text, /Challenger: belum pilih/)
    assert.match(status.text, /Challenged: belum pilih/)
    assert.match(status.text, /Expired: <t:\d+:R>/)
    assert.deepEqual([...status.options.mentions].sort(), [alice, bob].sort())
  } finally {
    await harness.app.stop()
  }
})

test('rps cancel drops the caller\u0027s challenge and frees both players', async () => {
  const harness = await createHarness()
  try {
    const groupJid = '<jid-redacted@g.us>'
    const alice = '<jid-redacted@s.whatsapp.net>'
    const bob = '<jid-redacted@s.whatsapp.net>'

    const [nothing] = await harness.send('cancel-empty', nextSender(), '<jid-redacted@g.us>', '!rps cancel')
    assert.match(nothing.text, /Tidak ada tantangan aktif untuk dibatalkan/)

    await harness.send('cancel-challenge', alice, groupJid, '!rps challenge @bob', [bob])
    const [cancelled] = await harness.send('cancel-do', bob, bob, '!rps cancel')
    assert.match(cancelled.text, /Tantangan dibatalkan/)

    await new Promise((resolve) => setTimeout(resolve, 1_600))
    const [afterCancel] = await harness.send('cancel-after', alice, alice, '!rps batu')
    assert.match(afterCancel.text, /Tidak ada tantangan aktif untukmu/)
  } finally {
    await harness.app.stop()
  }
})
