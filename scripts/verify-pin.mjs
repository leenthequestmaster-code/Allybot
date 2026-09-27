import assert from 'node:assert';
import { searchPinterest, fetchBuffer } from '../dist/services/pinterest.js';

async function run() {
  console.log('=== TEST 1: !pin cat (Single image, randomize) ===');
  const res1 = await searchPinterest('cat', { randomize: true });
  console.log('Results returned in pool:', res1.length);
  assert.ok(res1.length >= 1, 'Should return at least 1 pin');
  console.log('First random pin:', res1[0].id, res1[0].title, 'author:', res1[0].author);

  // Test image download
  const buf1 = await fetchBuffer(res1[0].imageUrl);
  assert.ok(buf1 instanceof Buffer, 'Should download Buffer');
  assert.ok(buf1.length > 1000, 'Image buffer should have valid size');
  console.log('Image buffer size:', buf1.length, 'bytes');

  // Verify caption format
  const pin0 = res1[0];
  const captionLines = [];
  if (pin0.title) captionLines.push(pin0.title.slice(0, 120));
  if (pin0.author) captionLines.push(`by @${pin0.author}`);
  captionLines.push(`pinterest.com/pin/${pin0.id}`);
  const caption = captionLines.join('\n');
  console.log('Caption format:\n' + caption);

  console.log('\n=== TEST 2: Multiple calls return different pins (Randomness & Variation) ===');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await searchPinterest('miku', { randomize: true });
    ids.push(r[0].id);
    console.log(`Call ${i + 1} chosen ID: ${r[0].id} (${r[0].title.slice(0, 30)})`);
  }
  const uniqueCount = new Set(ids).size;
  console.log(`Unique pins out of 3 runs: ${uniqueCount}`);
  assert.ok(uniqueCount >= 2, 'Should pick varied pins across calls');

  console.log('\n=== TEST 3: !pin zzxxqq_nonsense_query_12345 (0 Results Handling) ===');
  const res3 = await searchPinterest('zzxxqq_nonsense_query_123456789_nomatch', { randomize: true });
  console.log('Results for nonsense query:', res3.length);
  assert.strictEqual(res3.length, 0, 'Should return 0 pins cleanly');

  console.log('\n=== TEST 4: Bad URL Skip (One failed image does not kill reply) ===');
  const badUrl = 'https://i.pinimg.com/nonexistent_bad_url_404.jpg';
  const badBuf = await fetchBuffer(badUrl, 4000);
  console.log('Bad URL buffer result:', badBuf);
  assert.strictEqual(badBuf, null, 'Bad URL should return null cleanly without crash');

  console.log('\n>>> ALL VERIFICATION CHECKS PASSED <<<');
}

run().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
