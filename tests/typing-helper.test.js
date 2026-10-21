import assert from 'node:assert/strict'
import test from 'node:test'
import { withTyping } from '../dist/framework/typing-helper.js'

test('withTyping sends composing on start, refreshes on heartbeat, and pauses on completion', async () => {
  const presenceLog = []
  
  const mockContext = {
    message: { remoteJid: '120363000000000099@g.us' },
    whatsapp: {
      sendPresenceUpdate: async (jid, type) => {
        presenceLog.push({ jid, type })
      },
    },
    sendPresence: async (type) => {
      presenceLog.push({ jid: '120363000000000099@g.us', type })
    },
  }

  const result = await withTyping(
    mockContext,
    async () => {
      // Simulate asynchronous work longer than the heartbeat
      await new Promise((resolve) => setTimeout(resolve, 60))
      return 'work-done'
    },
    { intervalMs: 25 },
  )

  assert.equal(result, 'work-done')
  assert.ok(presenceLog.length >= 3, `Expected at least 3 presence calls, got ${presenceLog.length}`)
  assert.equal(presenceLog[0].type, 'composing')
  assert.equal(presenceLog[presenceLog.length - 1].type, 'paused')
})

test('withTyping guarantees paused presence cleanup even when action throws', async () => {
  const presenceLog = []

  const mockContext = {
    message: { remoteJid: 'user123@s.whatsapp.net' },
    whatsapp: {
      sendPresenceUpdate: async (jid, type) => {
        presenceLog.push({ jid, type })
      },
    },
  }

  await assert.rejects(
    async () => {
      await withTyping(mockContext, async () => {
        throw new Error('Action failed')
      })
    },
    /Action failed/,
  )

  assert.ok(presenceLog.length >= 2)
  assert.equal(presenceLog[0].type, 'composing')
  assert.equal(presenceLog[presenceLog.length - 1].type, 'paused')
})

test('withTyping supports recording presence type', async () => {
  const presenceLog = []

  const mockContext = {
    message: { remoteJid: 'audio-user@s.whatsapp.net' },
    whatsapp: {
      sendPresenceUpdate: async (jid, type) => {
        presenceLog.push({ jid, type })
      },
    },
  }

  await withTyping(
    mockContext,
    async () => 'audio-done',
    { type: 'recording' },
  )

  assert.equal(presenceLog[0].type, 'recording')
  assert.equal(presenceLog[presenceLog.length - 1].type, 'paused')
})
