import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unlinkSync } from 'node:fs'
import { ReminderService } from '../dist/services/reminder-service.js'
import { generateAllysseaCertificate } from '../dist/services/certificate-generator.js'
import { inspectExif } from '../dist/services/exif-inspector.js'

test('1. ReminderService: creates, lists, cancels, and dispatches due reminders', async () => {
  const dbPath = join(tmpdir(), `test_reminders_${Date.now()}.sqlite`)
  const sent = []
  const fakeWhatsapp = {
    sendText: async (jid, text, options) => {
      sent.push({ jid, text, options })
    },
  }

  const service = new ReminderService(dbPath, fakeWhatsapp, undefined, 60_000)
  service.initialize()

  try {
    const user = '628123456789@s.whatsapp.net'
    const target = '120363000001@g.us'

    // Create 1 past/due reminder and 1 future reminder
    const pastDue = Date.now() - 5_000
    const futureDue = Date.now() + 60_000

    const rem1 = service.createReminder(user, target, 'angkat jemuran', pastDue)
    const rem2 = service.createReminder(user, target, 'rapat penting', futureDue)

    assert.ok(rem1.id)
    assert.ok(rem2.id)

    // List pending
    const list = service.listPending(user)
    assert.equal(list.length, 2)

    // Cancel rem2
    const cancelled = service.cancelReminder(rem2.id, user)
    assert.equal(cancelled, true)

    const listAfterCancel = service.listPending(user)
    assert.equal(listAfterCancel.length, 1)
    assert.equal(listAfterCancel[0].id, rem1.id)

    // Check and dispatch due reminders
    const dispatched = await service.checkAndDispatchDueReminders()
    assert.equal(dispatched, 1)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('angkat jemuran'))
    assert.ok(sent[0].options?.mentions?.includes(user))

    // After dispatch, pending list is empty
    assert.equal(service.listPending(user).length, 0)
  } finally {
    service.shutdown()
    try {
      unlinkSync(dbPath)
    } catch {}
  }
})

test('2. generateAllysseaCertificate generates valid PDF document buffer', async () => {
  const pdfBytes = await generateAllysseaCertificate({
    recipientName: 'Cyrus',
    achievementText: 'Juara 1 Turnamen Catur Akbar Allyssea',
    certNumber: 'REG-TEST-001',
  })

  assert.ok(pdfBytes instanceof Uint8Array)
  assert.ok(pdfBytes.length > 500)

  // Verify PDF header %PDF-1.
  const header = Buffer.from(pdfBytes.subarray(0, 5)).toString('utf8')
  assert.equal(header, '%PDF-')
})

test('3. inspectExif returns null safely for clean or non-exif images', async () => {
  const cleanBuf = Buffer.alloc(1024, 0)
  const res = await inspectExif(cleanBuf)
  assert.equal(res, null)
})
