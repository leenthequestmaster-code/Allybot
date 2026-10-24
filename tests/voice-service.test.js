import assert from 'node:assert/strict'
import test from 'node:test'
import { synthesizeNaturalSpeech, DEFAULT_CHLONA_VOICE_ID } from '../dist/services/voice-service.js'

test('1. synthesizeNaturalSpeech generates WhatsApp OGG Opus audio with 64-sample waveform', async () => {
  const result = await synthesizeNaturalSpeech('Halo Cyrus, ini pengujian suara Chlona.')
  assert.ok(result.audioData instanceof Uint8Array)
  assert.ok(result.audioData.length > 500)
  assert.equal(result.mimeType, 'audio/ogg; codecs=opus')
  assert.equal(result.waveform.length, 64)

  // Verify second call is served from cache (fromCache = true)
  const cachedResult = await synthesizeNaturalSpeech('Halo Cyrus, ini pengujian suara Chlona.')
  assert.equal(cachedResult.fromCache, true)
  assert.equal(cachedResult.audioData.length, result.audioData.length)
})
