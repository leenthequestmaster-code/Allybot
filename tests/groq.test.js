import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatGroq } from '../dist/groq.js'

function withGroqKey(value, callback) {
  const previous = process.env.GROQ_API_KEY
  if (value === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = value

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous === undefined) delete process.env.GROQ_API_KEY
      else process.env.GROQ_API_KEY = previous
    })
}

test('chatGroq rejects empty input before making an API request', async () => {
  await assert.rejects(
    () => chatGroq('   '),
    (error) => error instanceof TypeError && error.message === 'message must be a non-empty string',
  )
})

test('chatGroq fails closed when GROQ_API_KEY is missing', async () => {
  await withGroqKey(undefined, async () => {
    await assert.rejects(
      () => chatGroq('Halo Allybot'),
      (error) => error instanceof Error && error.message === 'GROQ_API_KEY is not configured',
    )
  })
})

test('chatGroq fails closed when GROQ_API_KEY is blank', async () => {
  await withGroqKey('   ', async () => {
    await assert.rejects(
      () => chatGroq('Halo Allybot'),
      (error) => error instanceof Error && error.message === 'GROQ_API_KEY is not configured',
    )
  })
})
