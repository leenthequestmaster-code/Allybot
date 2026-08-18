import test from 'node:test'
import assert from 'node:assert/strict'
import { extractButtonId, WhatsAppConnection } from '../dist/whatsapp.js'

const message = (content) => ({ message: content })

test('WhatsApp adapter extracts supported legacy and native-flow callback ids', () => {
  assert.equal(extractButtonId(message({ buttonsResponseMessage: { selectedButtonId: 'general' } })), 'general')
  assert.equal(extractButtonId(message({ templateButtonReplyMessage: { selectedId: 'template-choice' } })), 'template-choice')
  assert.equal(extractButtonId(message({ listResponseMessage: { singleSelectReply: { selectedRowId: 'row-choice' } } })), 'row-choice')
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'native-choice' }) },
  } })), 'native-choice')
})

test('WhatsApp adapter preserves phone identity from private-message remoteJidAlt when primary chat JID is a LID', async () => {
  const connection = new WhatsAppConnection({}, {}, {})
  const messages = []
  connection.onMessage((normalized) => messages.push(normalized))

  await connection.emitMessages([
    {
      key: {
        remoteJid: 'owner-lid@lid',
        remoteJidAlt: '6283197859955@s.whatsapp.net',
        id: 'private-lid-owner',
        fromMe: false,
      },
      message: { conversation: '!dev help' },
      messageTimestamp: 1_700_000_000,
    },
  ])

  assert.equal(messages[0]?.senderJid, '6283197859955@s.whatsapp.net')
  assert.equal(messages[0]?.remoteJid, 'owner-lid@lid')
  assert.equal(messages[0]?.text, '!dev help')
})

test('WhatsApp adapter ignores malformed or oversized native-flow params', () => {
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: '{not-json' },
  } })), undefined)
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: 'x'.repeat(4097) },
  } })), undefined)
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: JSON.stringify({ url: 'https://example.test' }) },
  } })), undefined)
})
