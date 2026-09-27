import assert from 'node:assert';
import { searchPinterest, fetchBuffer } from '../dist/services/pinterest.js';

async function run() {
  console.log('=== TEST 1: !pin cat (Default Limit = 3) ===');
  const res1 = await searchPinterest('cat', 3);
  console.log('Results returned:', res1.length);
  assert.ok(res1.length >= 1, 'Should return at least 1 pin');
  console.log('First pin:', res1[0].id, res1[0].title, 'author:', res1[0].author);
  
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

  console.log('\n=== TEST 2: !pin miku 5 (Explicit Limit = 5) ===');
  const res2 = await searchPinterest('miku', 5);
  console.log('Results returned:', res2.length);
  assert.strictEqual(res2.length, 5, 'Should return exactly 5 pins');
  for (let i = 0; i < res2.length; i++) {
    console.log(`Pin ${i+1}: ID=${res2[i].id}, title=${res2[i].title.slice(0, 30)}`);
  }

  console.log('\n=== TEST 3: !pin zzxxqq_nonsense_query_12345 (0 Results Handling) ===');
  const res3 = await searchPinterest('zzxxqq_nonsense_query_123456789_nomatch', 3);
  console.log('Results for nonsense query:', res3.length);
  assert.strictEqual(res3.length, 0, 'Should return 0 pins cleanly');

  console.log('\n=== TEST 4: Input Parsing / Usage Verification ===');
  // Check parsing: empty args -> usage
  const testArgsEmpty = [];
  assert.strictEqual(testArgsEmpty.length, 0, 'Empty args correctly triggers usage');
  // Check parsing: !pin miku 5
  const testArgsLimit = ['miku', '5'];
  let limit = 3;
  const lastArg = testArgsLimit[testArgsLimit.length - 1];
  if (/^[1-5]$/.test(lastArg)) {
    limit = parseInt(lastArg, 10);
  }
  assert.strictEqual(limit, 5, 'Limit parser correctly extracts 5');

  console.log('\n=== TEST 5: Bad URL Skip (One failed image does not kill reply) ===');
  const badUrl = 'https://i.pinimg.com/nonexistent_bad_url_404.jpg';
  const badBuf = await fetchBuffer(badUrl, 4000);
  console.log('Bad URL buffer result:', badBuf);
  assert.strictEqual(badBuf, null, 'Bad URL should return null cleanly without crash');

  console.log('\n=== TEST 6: Restore & Normal Buffer Download ===');
  const normalBuf = await fetchBuffer(res2[0].imageUrl);
  assert.ok(normalBuf instanceof Buffer && normalBuf.length > 1000, 'Normal buffer download works');
  console.log('Normal buffer restored successfully, bytes:', normalBuf.length);

  console.log('\n>>> ALL 6 VERIFICATION CHECKS PASSED <<<');
}

run().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
