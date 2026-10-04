import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pino from 'pino'
import { EconomyService } from '../dist/services/economy-service.js'
import { createSqliteEconomyClient } from '../dist/services/economy-sqlite-client.js'
import { economyPlugin } from '../dist/framework/plugins/economy.js'

const logger = pino({ level: 'silent' })

function fakeWhatsapp() {
  const sent = []
  return {
    sent,
    userJid: 'bot@s.whatsapp.net',
    async sendText(jid, text) {
      sent.push({ jid, text })
    },
  }
}

test('SQLite Economy Client initializes, creates account snapshot, and handles deposit and withdraw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-economy-test-'))
  const dbPath = join(root, 'test.sqlite')
  const groupJid = '1203630123456789@g.us'
  const userJid = '6281234567890@s.whatsapp.net'

  try {
    const service = new EconomyService(logger, {
      env: { ECONOMY_ENABLED: 'true' },
      createClient: () => createSqliteEconomyClient(dbPath),
    })

    service.initialize({ logger, config: {}, services: { has: () => false, get: () => undefined } })

    assert.equal(service.isEnabled, true)
    assert.equal(service.hasBackend, true)

    // Initial snapshot should give 1000 starter wallet balance
    const { snapshot } = await service.getAccountSnapshot(groupJid, userJid)
    assert.equal(snapshot.walletBalance, 1000)
    assert.equal(snapshot.safeBalance, 0)
    assert.equal(snapshot.safeStatus, 'not_open')

    // Open safe
    await service.openSafe(groupJid, userJid, userJid, 'op-1', 'Open test')
    const openedSnapshot = (await service.getAccountSnapshot(groupJid, userJid)).snapshot
    assert.equal(openedSnapshot.safeStatus, 'active')

    // Deposit 500
    await service.deposit(groupJid, userJid, 500, userJid, 'op-2', 'Deposit test')
    const depositedSnapshot = (await service.getAccountSnapshot(groupJid, userJid)).snapshot
    assert.equal(depositedSnapshot.walletBalance, 500)
    assert.equal(depositedSnapshot.safeBalance, 500)

    // Withdraw 200
    await service.withdraw(groupJid, userJid, 200, userJid, 'op-3', 'Withdraw test')
    const withdrawnSnapshot = (await service.getAccountSnapshot(groupJid, userJid)).snapshot
    assert.equal(withdrawnSnapshot.walletBalance, 700)
    assert.equal(withdrawnSnapshot.safeBalance, 300)

    // Reward 300
    await service.grantReward(groupJid, userJid, 300, userJid, 'op-4', 'Reward test')
    const rewardedSnapshot = (await service.getAccountSnapshot(groupJid, userJid)).snapshot
    assert.equal(rewardedSnapshot.walletBalance, 1000)
    assert.equal(rewardedSnapshot.safeBalance, 300)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Economy Outbox handles atomic transfer commit, local wakeup drain, and failed recovery backoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-economy-outbox-test-'))
  const dbPath = join(root, 'test.sqlite')
  const groupJid = '1203630123456789@g.us'
  const senderJid = '6281111111111@s.whatsapp.net'
  const recipientJid = '6282222222222@s.whatsapp.net'

  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    shouldFail: false,
    async sendText(jid, text) {
      if (this.shouldFail) throw new Error('WhatsApp network drop')
      this.sent.push({ jid, text })
    },
  }

  try {
    const service = new EconomyService(logger, {
      env: { ECONOMY_ENABLED: 'true' },
      createClient: () => createSqliteEconomyClient(dbPath),
      whatsapp,
    })

    service.initialize({ logger, config: {}, services: { has: () => false, get: () => undefined } })

    // 1. Transfer with outboxNotification (happy path)
    const outboxMsg = 'Bukti transfer: 200 Vela berhasil dikirim ke @6282222222222'
    await service.createTransfer(
      groupJid,
      senderJid,
      recipientJid,
      200,
      senderJid,
      'op-transfer-outbox-1',
      'Pembayaran item',
      { targetJid: groupJid, text: outboxMsg },
    )

    // Wait a brief tick for local wakeup drain
    await new Promise((r) => setTimeout(r, 50))

    // Verified: Outbox was claimed and sent via WhatsAppPort!
    assert.equal(whatsapp.sent.length, 1)
    assert.equal(whatsapp.sent[0].jid, groupJid)
    assert.equal(whatsapp.sent[0].text, outboxMsg)

    // Check balances
    const sender = (await service.getAccountSnapshot(groupJid, senderJid)).snapshot
    const recipient = (await service.getAccountSnapshot(groupJid, recipientJid)).snapshot
    assert.equal(sender.walletBalance, 800)
    assert.equal(recipient.walletBalance, 1200)

    // 2. Outbox send failure handling
    whatsapp.shouldFail = true
    await service.enqueueOutbox(groupJid, groupJid, { text: 'Pesan outbox gagal' })
    await new Promise((r) => setTimeout(r, 50))

    // WhatsApp sent length shouldn't increase
    assert.equal(whatsapp.sent.length, 1)

    // 3. Recovery backoff check
    whatsapp.shouldFail = false
    const client = service.client
    const claimedBeforeBackoff = await client.rpc('economy_outbox_claim', { p_limit: 10 })
    assert.equal(claimedBeforeBackoff.data.jobs.length, 0)

    await service.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
