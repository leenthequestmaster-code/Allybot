import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebCompanionService } from '../dist/services/web-companion-service.js'

test('WebCompanion /health endpoint returns 200 when connected and 503 when disconnected', async () => {
  const mockLogger = { info() {}, error() {}, warn() {}, debug() {} }
  const mockWhatsapp = {
    isConnected: true,
    currentStatus: 'connected',
  }

  const service = new WebCompanionService(mockLogger, { port: 19877, whatsapp: mockWhatsapp })
  service.initialize({ services: new Map() })

  try {
    const res = await fetch('http://127.0.0.1:19877/health')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.equal(data.ok, true)
    assert.equal(data.status, 'connected')
    assert.equal(typeof data.uptime, 'number')
    assert.equal(typeof data.memoryRssMb, 'number')

    mockWhatsapp.isConnected = false
    mockWhatsapp.currentStatus = 'failed'
    const resFail = await fetch('http://127.0.0.1:19877/health')
    const dataFail = await resFail.json()
    assert.equal(resFail.status, 503)
    assert.equal(dataFail.ok, false)
    assert.equal(dataFail.status, 'failed')
  } finally {
    service.stopService()
  }
})
