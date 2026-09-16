import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CharacterGuideService } from '../dist/services/character-guide-service.js'
import { createPostgresCharacterClient } from '../dist/services/character-postgres-client.js'

const logger = pino({ level: 'silent' })

test('createPostgresCharacterClient initializes and exports expected factory function', () => {
  assert.equal(typeof createPostgresCharacterClient, 'function')
})
