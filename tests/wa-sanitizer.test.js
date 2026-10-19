import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeWAMarkdown,
  stripZeroWidth,
  stripAnsi,
  truncateWAMessage,
  formatPhoneMention,
  extractMentions,
  sanitizeWAMessage,
  WA_MAX_TEXT_CHARS,
} from '../dist/framework/utils/wa-sanitizer.js'

// --- escapeWAMarkdown -------------------------------------------------------

test('escapeWAMarkdown returns empty string unchanged', () => {
  assert.equal(escapeWAMarkdown(''), '')
})

test('escapeWAMarkdown leaves plain text untouched', () => {
  assert.equal(escapeWAMarkdown('halo dunia'), 'halo dunia')
  assert.equal(escapeWAMarkdown('emoji 😀 tetap aman'), 'emoji 😀 tetap aman')
})

test('escapeWAMarkdown escapes every WhatsApp markdown character', () => {
  assert.equal(escapeWAMarkdown('*bold*'), '\\*bold\\*')
  assert.equal(escapeWAMarkdown('_italic_'), '\\_italic\\_')
  assert.equal(escapeWAMarkdown('~strike~'), '\\~strike\\~')
  assert.equal(escapeWAMarkdown('`mono`'), '\\`mono\\`')
  assert.equal(escapeWAMarkdown('```block```'), '\\`\\`\\`block\\`\\`\\`')
})

test('escapeWAMarkdown escapes existing backslashes first', () => {
  assert.equal(escapeWAMarkdown('a\\b'), 'a\\\\b')
  assert.equal(escapeWAMarkdown('\\*'), '\\\\\\*')
})

test('escapeWAMarkdown handles a mixed message', () => {
  assert.equal(escapeWAMarkdown('*_~`'), '\\*\\_\\~\\`')
})

// --- stripZeroWidth ---------------------------------------------------------

test('stripZeroWidth returns empty string unchanged', () => {
  assert.equal(stripZeroWidth(''), '')
})

test('stripZeroWidth removes zero-width and invisible characters', () => {
  assert.equal(stripZeroWidth('a\u200Bb'), 'ab')
  assert.equal(stripZeroWidth('a\u200Cb'), 'ab')
  assert.equal(stripZeroWidth('a\uFEFFb'), 'ab')
  assert.equal(stripZeroWidth('a\u00ADb'), 'ab')
  assert.equal(stripZeroWidth('a\u200Eb\u200Fc'), 'abc')
  assert.equal(stripZeroWidth('a\u202Ab\u202Ec'), 'abc')
  assert.equal(stripZeroWidth('a\u2060b\u2061c'), 'abc')
  assert.equal(stripZeroWidth('a\u034Fb\u180Ec'), 'abc')
  assert.equal(stripZeroWidth('a\u061Cb'), 'ab')
})

test('stripZeroWidth preserves emoji zero-width joiners', () => {
  assert.equal(stripZeroWidth('👨\u200D👩\u200D👧'), '👨\u200D👩\u200D👧')
  assert.equal(stripZeroWidth('👩\u200D💻'), '👩\u200D💻')
  assert.equal(stripZeroWidth('❤\u200D🔥'), '❤\u200D🔥')
})

test('stripZeroWidth keeps ZWJ across variation selectors', () => {
  const rainbowFlag = '\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08' // 🏳️‍🌈
  const coupleWithHeart = '\uD83D\uDC68\u200D\u2764\uFE0F\u200D\uD83D\uDC68' // 👨‍❤️‍👨
  assert.equal(stripZeroWidth(rainbowFlag), rainbowFlag)
  assert.equal(stripZeroWidth(coupleWithHeart), coupleWithHeart)
  assert.equal(stripZeroWidth(`x${rainbowFlag}y`), `x${rainbowFlag}y`)
})

test('stripZeroWidth keeps ZWJ across skin tone modifiers', () => {
  const womanAstronaut = '\uD83D\uDC69\uD83C\uDFFD\u200D\uD83D\uDE80' // 👩🏽‍🚀
  const familySkin = '\uD83D\uDC68\uD83C\uDFFB\u200D\uD83D\uDC69\u200D\uD83D\uDC67'
  assert.equal(stripZeroWidth(womanAstronaut), womanAstronaut)
  assert.equal(stripZeroWidth(familySkin), familySkin)
})

test('stripZeroWidth removes joiners that do not join emoji', () => {
  assert.equal(stripZeroWidth('a\u200Db'), 'ab')
  assert.equal(stripZeroWidth('👨\u200Da'), '👨a')
})

test('stripZeroWidth strips surrounding invisibles but keeps the emoji', () => {
  assert.equal(stripZeroWidth('\u200B👨\u200D👩\uFEFF'), '👨\u200D👩')
})

// --- stripAnsi --------------------------------------------------------------

test('stripAnsi returns empty string unchanged', () => {
  assert.equal(stripAnsi(''), '')
})

test('stripAnsi leaves clean text untouched', () => {
  assert.equal(stripAnsi('plain text 😀'), 'plain text 😀')
})

test('stripAnsi removes color and style sequences', () => {
  assert.equal(stripAnsi('\u001B[31mred\u001B[0m'), 'red')
  assert.equal(stripAnsi('\u001B[1;32mbold green\u001B[22;39m'), 'bold green')
  assert.equal(stripAnsi('\u001B[38;5;208morange'), 'orange')
  assert.equal(stripAnsi('\u001B[38;2;255;0;0mtruecolor'), 'truecolor')
})

test('stripAnsi removes cursor and screen control sequences', () => {
  assert.equal(stripAnsi('line1\u001B[2Kline2'), 'line1line2')
  assert.equal(stripAnsi('\u001B[2J\u001B[Hcleared'), 'cleared')
})

test('stripAnsi removes OSC hyperlink sequences', () => {
  const linked = '\u001B]8;;https://example.com\u0007klik\u001B]8;;\u0007'
  assert.equal(stripAnsi(linked), 'klik')
})

test('stripAnsi preserves emoji while removing escapes', () => {
  assert.equal(stripAnsi('\u001B[36m😀 \u001B[39m👨\u200D👩'), '😀 👨\u200D👩')
})

// --- truncateWAMessage ------------------------------------------------------

test('truncateWAMessage returns empty string unchanged', () => {
  assert.equal(truncateWAMessage(''), '')
})

test('truncateWAMessage keeps short messages intact', () => {
  assert.equal(truncateWAMessage('halo', 10), 'halo')
  assert.equal(truncateWAMessage('👨\u200D👩', 10), '👨\u200D👩')
})

test('truncateWAMessage uses the default 4096 character budget', () => {
  assert.equal(WA_MAX_TEXT_CHARS, 4096)
  const exact = 'a'.repeat(WA_MAX_TEXT_CHARS)
  assert.equal(truncateWAMessage(exact), exact)

  const overflow = truncateWAMessage('b'.repeat(WA_MAX_TEXT_CHARS + 100))
  assert.equal(overflow.length, WA_MAX_TEXT_CHARS)
  assert.equal(overflow, `${'b'.repeat(WA_MAX_TEXT_CHARS - 1)}…`)
})

test('truncateWAMessage applies a custom suffix inside the budget', () => {
  assert.equal(truncateWAMessage('abcdefghij', 5), 'abcd…')
  assert.equal(truncateWAMessage('abcdefghij', 5, '...'), 'ab...')
  assert.equal(truncateWAMessage('abcdefghij', 5, ''), 'abcde')
})

test('truncateWAMessage handles degenerate limits', () => {
  assert.equal(truncateWAMessage('abcdef', 0), '')
  assert.equal(truncateWAMessage('abcdef', -3), '')
  assert.equal(truncateWAMessage('abcdef', Number.NaN), 'abcdef')
  assert.equal(truncateWAMessage('a'.repeat(5000), Number.POSITIVE_INFINITY).length, WA_MAX_TEXT_CHARS)
})

test('truncateWAMessage clamps when the suffix alone exceeds the budget', () => {
  assert.equal(truncateWAMessage('abcdef', 2, '...'), '..')
  assert.equal(truncateWAMessage('abcdef', 1, '…'), '…')
})

test('truncateWAMessage never splits a surrogate pair', () => {
  assert.equal(truncateWAMessage('a😀b', 2, ''), 'a😀')
  assert.equal(truncateWAMessage('😀😀😀', 2, ''), '😀😀')
})

test('truncateWAMessage never splits a composite emoji', () => {
  const family = '👨\u200D👩\u200D👧'
  assert.equal(truncateWAMessage(`x${family}y`, 2, ''), 'x')
  assert.equal(truncateWAMessage(`${family}${family}`, 5, ''), family)
})

// --- formatPhoneMention -----------------------------------------------------

test('formatPhoneMention normalizes a bare number', () => {
  assert.deepEqual(formatPhoneMention('628123456789'), {
    jid: '628123456789@s.whatsapp.net',
    mentionText: '@628123456789',
  })
})

test('formatPhoneMention strips formatting characters and prefixes', () => {
  assert.equal(formatPhoneMention('+62 812-3456-789').mentionText, '@628123456789')
  assert.equal(formatPhoneMention('(628) 123.4567').jid, '6281234567@s.whatsapp.net')
  assert.equal(formatPhoneMention('00628123456789').jid, '628123456789@s.whatsapp.net')
})

test('formatPhoneMention normalizes existing JIDs and drops device suffixes', () => {
  assert.deepEqual(formatPhoneMention('628123456789:12@s.whatsapp.net'), {
    jid: '628123456789@s.whatsapp.net',
    mentionText: '@628123456789',
  })
  assert.equal(formatPhoneMention('628123456789@S.WHATSAPP.NET').jid, '628123456789@s.whatsapp.net')
})

test('formatPhoneMention preserves LID JIDs', () => {
  assert.deepEqual(formatPhoneMention('123456789012345@lid'), {
    jid: '123456789012345@lid',
    mentionText: '@123456789012345',
  })
})

test('formatPhoneMention rejects invalid input', () => {
  assert.throws(() => formatPhoneMention(''), RangeError)
  assert.throws(() => formatPhoneMention('   '), RangeError)
  assert.throws(() => formatPhoneMention('abc'), RangeError)
  assert.throws(() => formatPhoneMention('123'), RangeError)
  assert.throws(() => formatPhoneMention('1234567890123456'), RangeError)
  assert.throws(() => formatPhoneMention('628123456789@g.us'), RangeError)
  assert.throws(() => formatPhoneMention(null), TypeError)
})

// --- extractMentions --------------------------------------------------------

test('extractMentions returns an empty array for empty input', () => {
  assert.deepEqual(extractMentions(''), [])
  assert.deepEqual(extractMentions('tidak ada mention di sini'), [])
})

test('extractMentions finds phone mentions', () => {
  assert.deepEqual(extractMentions('hai @628123456789 apa kabar'), ['628123456789@s.whatsapp.net'])
})

test('extractMentions normalizes separators and prefixes', () => {
  assert.deepEqual(extractMentions('@+62 812-3456-789'), ['628123456789@s.whatsapp.net'])
  assert.deepEqual(extractMentions('@00628123456789'), ['628123456789@s.whatsapp.net'])
})

test('extractMentions returns unique JIDs in first-appearance order', () => {
  const text = '@628111111111 dan @628222222222 lalu @628111111111 lagi'
  assert.deepEqual(extractMentions(text), [
    '628111111111@s.whatsapp.net',
    '628222222222@s.whatsapp.net',
  ])
})

test('extractMentions ignores emails and inline handles', () => {
  assert.deepEqual(extractMentions('kirim ke admin@628123456789.com'), [])
  assert.deepEqual(extractMentions('x@628123456789'), [])
})

test('extractMentions trims trailing punctuation', () => {
  assert.deepEqual(extractMentions('hai @628123456789, apa kabar?'), ['628123456789@s.whatsapp.net'])
  assert.deepEqual(extractMentions('hai @628123456789.'), ['628123456789@s.whatsapp.net'])
})

test('extractMentions rejects out-of-range candidates', () => {
  assert.deepEqual(extractMentions('@12345'), [])
  assert.deepEqual(extractMentions('@1234567890123456789'), [])
})

test('extractMentions recovers the leading number from an over-captured run', () => {
  assert.deepEqual(extractMentions('@628123456789 12345'), ['628123456789@s.whatsapp.net'])
})

test('extractMentions does not swallow newlines', () => {
  assert.deepEqual(extractMentions('@123456\n7890'), ['123456@s.whatsapp.net'])
  assert.deepEqual(extractMentions('@628123456789\r\n123'), ['628123456789@s.whatsapp.net'])
  assert.deepEqual(extractMentions('@6281234567\n0896123456'), ['6281234567@s.whatsapp.net'])
})

// --- sanitizeWAMessage ------------------------------------------------------

test('sanitizeWAMessage returns empty string unchanged', () => {
  assert.equal(sanitizeWAMessage(''), '')
})

test('sanitizeWAMessage composes ANSI and zero-width cleanup with markdown escaping', () => {
  assert.equal(sanitizeWAMessage('\u001B[31mha\u200Blo\u001B[0m'), 'halo')
  assert.equal(sanitizeWAMessage('*bold*'), '\\*bold\\*')
})

test('sanitizeWAMessage preserves composite emoji while cleaning', () => {
  const rainbowFlag = '\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08' // 🏳️‍🌈
  assert.equal(sanitizeWAMessage(`\u200B${rainbowFlag}\uFEFF`), rainbowFlag)
})

test('sanitizeWAMessage truncates without a dangling backslash', () => {
  // Markdown escaping turns `*` into `\*`; a hard cut at the escape boundary
  // would leave a lone trailing backslash.
  assert.equal(sanitizeWAMessage('a*b', 2), 'a')
  assert.equal(sanitizeWAMessage('*a*b', 1), '')
  const long = sanitizeWAMessage('*'.repeat(100), 10)
  assert.equal(long.length, 10)
  assert.equal(long.endsWith('\\'), false)
})

test('sanitizeWAMessage keeps the default 4096 character budget', () => {
  assert.equal(sanitizeWAMessage('a'.repeat(WA_MAX_TEXT_CHARS + 50)).length, WA_MAX_TEXT_CHARS)
})
