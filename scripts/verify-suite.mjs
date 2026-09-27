import assert from 'node:assert';
import fs from 'node:fs';
import { searchPinterest } from '../dist/services/pinterest.js';
import { resolveMedia, resolveTikWm, fetchMediaBuffer, extractMediaUrl } from '../dist/services/multidl.js';
import { upscaleImage } from '../dist/services/upscaler.js';

async function run() {
  console.log('=== TEST 1: Pinterest Cache Layer ===');
  const t0 = Date.now();
  const res1 = await searchPinterest('cat', { randomize: true });
  const d1 = Date.now() - t0;
  console.log(`Run 1 (API call): ${res1.length} pins in ${d1}ms`);

  const t1 = Date.now();
  const res2 = await searchPinterest('cat', { randomize: true });
  const d2 = Date.now() - t1;
  console.log(`Run 2 (Cache hit): ${res2.length} pins in ${d2}ms`);
  assert.ok(d2 <= 50, 'Cache hit should be near instantaneous (<50ms)');

  console.log('\n=== TEST 2: TikTok Resolver & Buffer Fetch ===');
  const ttUrl = 'https://www.tiktok.com/@tiktok/video/7106594312292453675';
  const ttInfo = await resolveTikWm(ttUrl);
  console.log('TikTok resolved:', {
    id: ttInfo?.id,
    title: ttInfo?.title?.slice(0, 30),
    author: ttInfo?.author,
    hasPlayUrl: Boolean(ttInfo?.playUrl),
    hasMusicUrl: Boolean(ttInfo?.musicUrl),
  });
  assert.ok(ttInfo && ttInfo.playUrl, 'Must resolve playUrl from TikWM');

  const vBuf = await fetchMediaBuffer(ttInfo.playUrl, 25 * 1024 * 1024);
  console.log('Video downloaded bytes:', vBuf?.length);
  assert.ok(vBuf && vBuf.length > 100_000, 'Video buffer must be valid size');

  if (ttInfo.musicUrl) {
    const aBuf = await fetchMediaBuffer(ttInfo.musicUrl, 10 * 1024 * 1024);
    console.log('Audio downloaded bytes:', aBuf?.length);
    assert.ok(aBuf && aBuf.length > 10_000, 'Audio buffer must be valid size');
  }

  console.log('\n=== TEST 3: Multi-Platform URL Detection & Cache ===');
  const sampleText = 'Cek link ini ya: https://www.tiktok.com/@tiktok/video/7106594312292453675 seru banget!';
  const detected = extractMediaUrl(sampleText);
  console.log('Detected platform:', detected?.platform, 'url:', detected?.url);
  assert.strictEqual(detected?.platform, 'tiktok');

  const resolved = await resolveMedia(detected.url, detected.platform);
  assert.ok(resolved && resolved.playUrl);
  console.log('Universal resolve title:', resolved.title?.slice(0, 30));

  console.log('\n=== TEST 4: Image Upscaler (PicWish Native Node.js) ===');
  const sampleB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQEA1StCErIngcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfdegAlYMQ8EIAAAAAElFTkSuQmCC';
  const testImg = Buffer.from(sampleB64, 'base64');
  const up1 = await upscaleImage(testImg);
  console.log(`Upscale live: ${up1.buffer.length} bytes in ${up1.latencyMs}ms (fromCache: ${up1.fromCache})`);
  assert.ok(up1.buffer.length > 1000, 'Upscaled buffer must be valid');
  assert.strictEqual(up1.fromCache, false);

  const up2 = await upscaleImage(testImg);
  console.log(`Upscale cache: ${up2.buffer.length} bytes in ${up2.latencyMs}ms (fromCache: ${up2.fromCache})`);
  assert.strictEqual(up2.fromCache, true);

  console.log('\n>>> ALL SUITE VERIFICATIONS PASSED 100% <<<');
}

run().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
