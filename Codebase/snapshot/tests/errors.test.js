import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllybotError } from '../dist/errors.js'

test('retryable defaults to network and protocol categories', () => {
  assert.equal(new AllybotError('network failure', 'network').retryable, true)
  assert.equal(new AllybotError('protocol failure', 'protocol').retryable, true)
  assert.equal(new AllybotError('configuration failure', 'configuration').retryable, false)
})

test('retryable option overrides category default', () => {
  assert.equal(new AllybotError('transient configuration failure', 'configuration', { retryable: true }).retryable, true)
  assert.equal(new AllybotError('permanent network failure', 'network', { retryable: false }).retryable, false)
})
