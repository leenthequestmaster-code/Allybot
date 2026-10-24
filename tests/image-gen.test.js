import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImageWithAi, AiHandlerError } from '../dist/ai-handler.js'
import { matchNaturalLanguageCommand } from '../dist/framework/plugins/ai.js'

test('1. generateImageWithAi rejects empty prompt safely', async () => {
  await assert.rejects(
    () => generateImageWithAi('   '),
    (err) => err instanceof AiHandlerError && err.code === 'invalid_input',
  )
})

test('2. matchNaturalLanguageCommand routes drawing and painting requests to text2img', () => {
  const dummyMsg = { id: 'm1', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false }

  const res1 = matchNaturalLanguageCommand('gambarin kucing lucu di luar angkasa', dummyMsg)
  assert.equal(res1?.commandName, 'text2img')
  assert.equal(res1?.argsText, 'kucing lucu di luar angkasa')

  const res2 = matchNaturalLanguageCommand('tolong buatkan gambar pemandangan pantai sore hari', dummyMsg)
  assert.equal(res2?.commandName, 'text2img')
  assert.equal(res2?.argsText, 'pemandangan pantai sore hari')

  const res3 = matchNaturalLanguageCommand('lukiskan robot cyberpunk yang keren', dummyMsg)
  assert.equal(res3?.commandName, 'text2img')
  assert.equal(res3?.argsText, 'robot cyberpunk yang keren')
})
