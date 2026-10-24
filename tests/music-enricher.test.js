import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanSearchQuery,
  resolveCanonicalMetadata,
  fetchLyricsEnriched,
  ensureStandardMp3Buffer,
  enrichAudioBuffer,
} from '../dist/services/music-enricher.js'
import NodeID3 from 'node-id3'

test('1. cleanSearchQuery strips video labels, feat tags, and YouTube noise', () => {
  assert.equal(
    cleanSearchQuery('Alan Walker - Faded (Official Music Video)'),
    'Alan Walker - Faded',
  )
  assert.equal(
    cleanSearchQuery('Last Child - Duka [Official Audio]'),
    'Last Child - Duka',
  )
  assert.equal(
    cleanSearchQuery('Bernadya - Satu Bulan (Official Lyric Video)'),
    'Bernadya - Satu Bulan',
  )
  assert.equal(
    cleanSearchQuery('Sheila On 7 - Dan (MV HD) | Sony Music'),
    'Sheila On 7 - Dan',
  )
  assert.equal(
    cleanSearchQuery('Coldplay ft. BTS - My Universe'),
    'Coldplay - My Universe',
  )
})

test('2. resolveCanonicalMetadata resolves structured artist & title', async () => {
  // Test with canonical Indonesian song
  const meta = await resolveCanonicalMetadata('Duka Last Child')
  assert.ok(meta.title.toLowerCase().includes('duka'))
  assert.ok(meta.artist.toLowerCase().includes('last child'))
  assert.ok(meta.album.length > 0)
  assert.ok(meta.year && meta.year.length === 4)
  assert.ok(meta.artworkUrl && meta.artworkUrl.startsWith('http'))
})

test('3. fetchLyricsEnriched finds lyrics with title cleaning fallback', async () => {
  const lyricsResult = await fetchLyricsEnriched('Last Child', 'Duka (Studio Session)', 'Duka')
  assert.ok(lyricsResult.plainLyrics, 'Expected plainLyrics to be found')
  assert.ok(lyricsResult.plainLyrics.includes('Kau membunuhku dengan kepedihan ini'))
})

test('4. ensureStandardMp3Buffer accepts MP3 syncwords and ID3 headers', async () => {
  const dummyMp3 = Buffer.alloc(2048, 0)
  dummyMp3[0] = 0xff
  dummyMp3[1] = 0xfb // Standard MP3 frame syncword

  const verified = await ensureStandardMp3Buffer(dummyMp3)
  assert.equal(verified.length, 2048)
})

test('5. enrichAudioBuffer injects Title, Artist, Album, Year, Genre, Lyrics & Cover Art into ID3', async () => {
  // Create synthetic audio buffer
  const baseMp3 = Buffer.alloc(4096, 0)
  baseMp3[0] = 0xff
  baseMp3[1] = 0xfb

  const enriched = await enrichAudioBuffer({
    query: 'Last Child - Duka',
    rawAudio: baseMp3,
    explicitLyrics: 'Kau membunuhku dengan kepedihan ini\nKau hempaskanku ke dalam retaknya hati',
  })

  assert.ok(enriched.buffer.length > baseMp3.length, 'Tagged buffer must include ID3 tags')
  assert.ok(enriched.title.toLowerCase().includes('duka'))
  assert.ok(enriched.artist.toLowerCase().includes('last child'))
  assert.ok(enriched.year)
  assert.ok(enriched.lyrics)

  // Verify ID3 tags by reading them back directly with NodeID3
  const tags = NodeID3.read(enriched.buffer)
  assert.equal(tags.title, enriched.title)
  assert.equal(tags.artist, enriched.artist)
  assert.equal(tags.album, enriched.album)
  assert.equal(tags.year, enriched.year)
  assert.ok(tags.unsynchronisedLyrics?.text?.includes('Kau membunuhku'))
})
