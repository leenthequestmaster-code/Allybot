import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TypoGuard } from '../dist/framework/typo-guard.js'

const ALLYBOT_COMMANDS = [
  'menu', 'help', 'ping', 'status', 'info', 'rules', 'welcome', 'setwelcome',
  'clearwelcome', 'left', 'setleave', 'clearleave', 'afk', 'tagme', 'prefix',
  'setprefix', 'link', 'invite', 'role', 'permissions', 'groupsettings',
  'suggest', 'kick', 'ban', 'unban', 'mute', 'unmute', 'warn', 'warnings',
  'unwarn', 'clearwarn', 'setlimit', 'antilink', 'antispam', 'antitoxic',
  'safety', 'setsafety', 'lock', 'unlock', 'groupmode', 'promote', 'demote',
  'tagall', 'hidetag', 'del', 'clear', 'report', 'cases', 'case', 'character',
  'stats', 'inspectchar', 'daftar', 'alokasi', 'pensiun', 'savecharacter',
  'timerp', 'bank', 'wallet', 'vela', 'pay', 'tax', 'taxbayar', 'ai', 'ally',
  'translate', 'summarize', 'tts', 'text2img', 'img2text', 'sticker',
  'stickerwm', 'brat', 'brats', 'bratvid', 'smeme', 'emojimix', 'qc', 'iqc',
  'tweet', 'ttstalk', 'igstalk', 'toimg', 'togif', 'toaudio', 'tovideo',
  'compress', 'hd', 'spack', 'removebg', 'google', 'image', 'wiki', 'cuaca',
  'lirik', 'pin', 'pixiv', 'tik', 'dl', 'catur', 'chess', 'review',
  'leaderboardchess', 'elochess',
]

test('TypoGuard: OSA Damerau-Levenshtein 4 edit operations & transposition accuracy', () => {
  const guard = new TypoGuard()

  // 1. Exact match
  assert.equal(guard.distance('status', 'status'), 0)

  // 2. Insertion (+1)
  assert.equal(guard.distance('staus', 'status'), 1)

  // 3. Deletion (+1)
  assert.equal(guard.distance('statuus', 'status'), 1)

  // 4. Substitution (+1)
  assert.equal(guard.distance('statis', 'status'), 1)

  // 5. Adjacent Transposition (+1, NOT 2)
  assert.equal(guard.distance('stauts', 'status'), 1)
  assert.equal(guard.distance('cautr', 'catur'), 1)
  assert.equal(guard.distance('menfses', 'menfess'), 1)
  assert.equal(guard.distance('ab', 'ba'), 1)

  // 6. OSA Restricted property ("ca" -> "abc" = 3 in OSA)
  assert.equal(guard.distance('ca', 'abc', 5), 3)
})

test('TypoGuard: k-bounded early termination and O(1) length difference rejection', () => {
  const guard = new TypoGuard()

  // O(1) length difference > maxDistance returns maxDistance + 1 immediately
  assert.equal(guard.distance('menu', 'leaderboardchess', 2), 3)
  assert.equal(guard.distance('a', 'abcdef', 3), 4)

  // Same-length completely different strings abort when band minimum > maxDistance
  assert.equal(guard.distance('abcdef', 'uvwxyz', 2), 3)
  assert.equal(guard.distance('status', 'stauts', 1), 1)
  assert.equal(guard.distance('status', 'stauxx', 1), 2)
})

test('TypoGuard: Dual-Path equivalence (Bit-Parallel <= 32 vs Bounded Flat Int32Array DP > 32)', () => {
  const guard = new TypoGuard({ maxWordLength: 128 })

  // Long strings (> 32 chars) exercising the flat Int32Array 3-row bounded DP path
  const baseLong = 'a_allybot_community_command_super_long_identifier_v1_z'
  const transposedLong = 'b_allybot_community_command_supre_long_identifier_v1_z' // 'a'->'b' (1) + 'er'->'re' (1) over 52-char interior
  const singleTransLong = 'a_allybot_community_command_supre_long_identifier_v1_z' // 'er' -> 're' (1)
  const farLong = 'z_zzzzzzz_community_command_super_long_identifier_v1_a'

  assert.equal(guard.distance(baseLong, singleTransLong, 2), 1)
  assert.equal(guard.distance(baseLong, transposedLong, 2), 2)
  assert.equal(guard.distance(baseLong, farLong, 2), 3)
})

test('TypoGuard: WhatsApp prefixes, case folding, NFC diacritics, and Emoji / Surrogate safety', () => {
  const guard = new TypoGuard({ prefixes: ['!', '/', '.', '#'] })

  // Prefix stripping + case insensitivity
  assert.equal(guard.distance('!stauts', 'status', 2), 1)
  assert.equal(guard.distance('/MENU', '.menu', 2), 0)
  assert.equal(guard.distance('#CaUtR', '!catur', 2), 1)

  // Case-sensitive mode
  const strictCaseGuard = new TypoGuard({ caseSensitive: true })
  assert.equal(strictCaseGuard.distance('Menu', 'menu', 2), 1)
  assert.equal(strictCaseGuard.distance('Menu', 'Menu', 2), 0)

  // NFC normalization equivalence ('é' precomposed U+00E9 vs decomposed 'e' + U+0301)
  assert.equal(guard.distance('caf\u00e9', 'cafe\u0301', 2), 0)

  // Surrogate pairs (🎲 U+1F3B2) and ZWJ family emojis (👨‍👩‍👧)
  assert.equal(guard.distance('!🎲', '🎲', 2), 0)
  assert.equal(guard.distance('🎲🎯', '🎯🎲', 2), 1) // Transposition of 2 astral emojis = 1!
  assert.equal(guard.distance('👨‍👩‍👧', '👨‍👩‍👧', 2), 0)
  assert.equal(guard.distance('!👨‍👩‍👧catur', 'catur👨‍👩‍👧', 2), 2)
})

test('TypoGuard: suggest() ranking, similarity formula, and high-throughput benchmark', async () => {
  const guard = new TypoGuard({ prefixes: ['!', '/', '.', '#'] })

  const s1 = guard.suggest('!stauts', ALLYBOT_COMMANDS, { maxDistance: 2, minSimilarity: 0.6, limit: 3 })
  assert.ok(s1.length >= 1)
  assert.equal(s1[0].candidate, 'status')
  assert.equal(s1[0].distance, 1)
  assert.equal(s1[0].similarity, 1 - 1 / 6)

  const s2 = guard.suggest('/leadrboardches', ALLYBOT_COMMANDS, { maxDistance: 2, minSimilarity: 0.7, limit: 1 })
  assert.equal(s2.length, 1)
  assert.equal(s2[0].candidate, 'leaderboardchess')
  assert.equal(s2[0].distance, 2)

  const s3 = guard.suggest('.cautr', ALLYBOT_COMMANDS)
  assert.equal(s3.length, 1)
  assert.equal(s3[0].candidate, 'catur')
  assert.equal(s3[0].distance, 1)

  // Concurrent / Reentrant safety across 40 simulated group tasks
  const concurrentInputs = Array.from({ length: 40 }, (_, idx) =>
    idx % 2 === 0 ? '!stauts' : '/stikcer',
  )
  const concurrentResults = await Promise.all(
    concurrentInputs.map((inp) => Promise.resolve(guard.suggest(inp, ALLYBOT_COMMANDS))),
  )
  for (let i = 0; i < concurrentResults.length; i++) {
    assert.equal(concurrentResults[i][0].candidate, i % 2 === 0 ? 'status' : 'sticker')
  }

  // Performance benchmark: 100,000 distance() calls + 5,000 full 104-command suggest() scans
  const t0 = performance.now()
  let checksum = 0
  for (let i = 0; i < 100_000; i++) {
    checksum += guard.distance('!stauts', 'status', 2)
  }
  const tDistMs = performance.now() - t0
  assert.equal(checksum, 100_000)

  const t1 = performance.now()
  for (let i = 0; i < 5_000; i++) {
    const r = guard.suggest('!stikcer', ALLYBOT_COMMANDS)
    checksum += r[0].distance
  }
  const tSuggestMs = performance.now() - t1
  console.log(
    `[TypoGuard Benchmark] 100k distance(): ${tDistMs.toFixed(1)}ms | 5k suggest() over ${ALLYBOT_COMMANDS.length} cmds: ${tSuggestMs.toFixed(1)}ms`,
  )
})
