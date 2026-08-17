import test from 'node:test'
import assert from 'node:assert/strict'
import { extractButtonId } from '../dist/whatsapp.js'

const message = (content) => ({ message: content })

test('WhatsApp adapter extracts supported legacy and native-flow callback ids', () => {
  assert.equal(extractButtonId(message({ buttonsResponseMessage: { selectedButtonId: 'general' } })), 'general')
  assert.equal(extractButtonId(message({ templateButtonReplyMessage: { selectedId: 'template-choice' } })), 'template-choice')
  assert.equal(extractButtonId(message({ listResponseMessage: { singleSelectReply: { selectedRowId: 'row-choice' } } })), 'row-choice')
  assert.equal(extractButtonId(message({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'native-choice' }) },
  } })), 'native-choice')
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
