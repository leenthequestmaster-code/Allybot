import 'dotenv/config';
import assert from 'node:assert';
import { searchIllust, fetchImage, pixivApi, PixivError } from '../dist/services/pixiv.js';

async function run() {
  console.log('=== TEST 1: !pixiv miku (Page 1) ===');
  const res1 = await searchIllust('miku', 1);
  console.log('Item count:', res1.items.length);
  assert.strictEqual(res1.items.length, 5, 'Should return exactly 5 items');
  
  const page1Ids = res1.items.map(it => it.id);
  console.log('Page 1 IDs:', page1Ids);

  for (const item of res1.items) {
    assert.ok(item.id, 'Item must have id');
    assert.ok(item.title, 'Item must have title');
    assert.ok(item.author, 'Item must have author');
    assert.ok(Array.isArray(item.tags), 'Tags must be array');
    assert.ok(item.imageUrls.length > 0, 'Must have imageUrls');
    for (const url of item.imageUrls) {
      assert.ok(!url.includes('i.pximg.net'), 'URL must NOT contain i.pximg.net');
      assert.ok(url.includes('i.pixiv.re'), 'URL must contain i.pixiv.re');
    }
  }

  // Test downloading first image of item 0
  const firstUrl = res1.items[0].imageUrls[0];
  console.log('Testing image download:', firstUrl);
  const buf = await fetchImage(firstUrl);
  assert.ok(buf instanceof Buffer, 'Image should be a Buffer');
  assert.ok(buf.length > 1000, 'Image buffer should have content');
  console.log('Downloaded image size bytes:', buf.length);

  // Caption format verification
  const item0 = res1.items[0];
  const tagsStr = item0.tags.slice(0, 5).map(t => '#' + t.replace(/\s+/g, '_')).join(' ');
  const caption = `${item0.title}\nby ${item0.author}${tagsStr ? '\n' + tagsStr : ''}\n#${item0.id}`;
  console.log('Formatted caption sample:\n' + caption);

  console.log('\n=== TEST 2: !pixiv miku --page 2 ===');
  const res2 = await searchIllust('miku', 2);
  console.log('Item count:', res2.items.length);
  assert.strictEqual(res2.items.length, 5, 'Should return exactly 5 items');
  const page2Ids = res2.items.map(it => it.id);
  console.log('Page 2 IDs:', page2Ids);
  const overlap = page1Ids.filter(id => page2Ids.includes(id));
  console.log('Overlap count:', overlap.length);
  assert.strictEqual(overlap.length, 0, 'Page 1 and Page 2 must not have overlapping IDs');

  console.log('\n=== TEST 3: Query with 0 results ===');
  const res0 = await searchIllust('ksadjhfkjasdhf9283749283749823749823', 1);
  console.log('Items for nonsense query:', res0.items.length);
  assert.strictEqual(res0.items.length, 0, 'Should return 0 items');

  console.log('\n=== TEST 4: Corrupt token, retry & clean error ===');
  const originalToken = pixivApi.getRefreshToken();
  pixivApi.setRefreshToken('corrupted_invalid_token_12345');
  try {
    await pixivApi.searchIllust('miku', 1);
    assert.fail('Should have thrown PixivError');
  } catch (err) {
    assert.ok(err instanceof PixivError, 'Should be PixivError instance');
    console.log('Caught expected typed error:', err.name, '-', err.message.slice(0, 100));
  }

  console.log('\n=== TEST 5: Restore token & verify recovery ===');
  pixivApi.setRefreshToken(originalToken);
  const resRestored = await searchIllust('miku', 1);
  console.log('Restored query item count:', resRestored.items.length);
  assert.strictEqual(resRestored.items.length, 5, 'Should work after restoring token');
  console.log('First restored item:', resRestored.items[0].title, 'by', resRestored.items[0].author);

  console.log('\n>>> ALL 5 VERIFICATION CHECKS PASSED <<<');
}

run().catch(err => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
