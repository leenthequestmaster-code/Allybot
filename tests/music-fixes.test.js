import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeQuery } from '../dist/services/music-cache.js'

test('normalizeQuery preserves hyphens, apostrophes, and parentheses for title integrity', () => {
  assert.equal(normalizeQuery('1000x - Ghea Indrawari'), '1000x - ghea indrawari')
  assert.equal(normalizeQuery('Goodbye (from the 1999) - Erigga'), 'goodbye (from the 1999) - erigga')
  assert.equal(normalizeQuery("Don't Stop Believin'"), "don't stop believin'")
  // Strips emojis and special symbols but keeps clean single whitespace
  assert.equal(normalizeQuery('Anti ✨ Hero !!!'), 'anti hero')
})
