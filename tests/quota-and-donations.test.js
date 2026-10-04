import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pino from 'pino'
import { QuotaService } from '../dist/services/quota-service.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { utilityPlugin } from '../dist/framework/plugins/utility.js'

const logger = pino({ level: 'silent' })

test('QuotaService handles tier identification, limits, atomic reservation, and refund/commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-quota-test-'))
  const dbPath = join(root, 'quota-test.sqlite')
  const ownerJid = '6283197859955@s.whatsapp.net'
  const donatorJid = '6281111111111@s.whatsapp.net'
  const freeJid = '6282222222222@s.whatsapp.net'

  try {
    const quota = new QuotaService(dbPath, logger, {
      botOwnerJid: ownerJid,
      limits: {
        downloader: { free: 2, donator: 5 },
      },
    })
    quota.initialize()

    // 1. Initial tiers
    assert.equal(quota.isOwner(ownerJid), true)
    assert.equal(quota.getTier(ownerJid), 'owner')
    assert.equal(quota.isDonator(ownerJid), true)

    assert.equal(quota.isOwner(freeJid), false)
    assert.equal(quota.isDonator(freeJid), false)
    assert.equal(quota.getTier(freeJid), 'free')

    // 2. Set donator status
    quota.setDonator(donatorJid, true, 'Test Donator')
    assert.equal(quota.isDonator(donatorJid), true)
    assert.equal(quota.getTier(donatorJid), 'donator')

    const donators = quota.listDonators()
    assert.equal(donators.length, 1)
    assert.equal(donators[0].notes, 'Test Donator')

    // 3. Free user reservation and quota consumption
    const r1 = quota.reserveQuota(freeJid, 'downloader')
    assert.equal(r1.ok, true)
    assert.equal(r1.limit, 2)
    assert.equal(r1.remaining, 1)

    const r2 = quota.reserveQuota(freeJid, 'downloader')
    assert.equal(r2.ok, true)
    assert.equal(r2.limit, 2)
    assert.equal(r2.remaining, 0)

    // 3rd reservation should fail (limit 2 exhausted)
    const r3 = quota.reserveQuota(freeJid, 'downloader')
    assert.equal(r3.ok, false)
    assert.equal(r3.remaining, 0)

    // 4. Refund a reservation
    quota.refundQuota(freeJid, 'downloader')
    const r4 = quota.reserveQuota(freeJid, 'downloader')
    assert.equal(r4.ok, true)
    assert.equal(r4.remaining, 0)

    // 5. Commit quota
    quota.commitQuota(freeJid, 'downloader')
    const checkAfterCommit = quota.checkQuota(freeJid, 'downloader')
    assert.equal(checkAfterCommit.used, 1)

    // 6. Donator user has higher limit (5)
    for (let i = 0; i < 5; i++) {
      const res = quota.reserveQuota(donatorJid, 'downloader')
      assert.equal(res.ok, true)
      quota.commitQuota(donatorJid, 'downloader')
    }
    const donatorLimitExceeded = quota.reserveQuota(donatorJid, 'downloader')
    assert.equal(donatorLimitExceeded.ok, false)

    // 7. Owner has infinite quota
    const ownerRes = quota.reserveQuota(ownerJid, 'downloader')
    assert.equal(ownerRes.ok, true)
    assert.equal(ownerRes.remaining, 999999)

    // 8. Remove donator
    quota.setDonator(donatorJid, false)
    assert.equal(quota.isDonator(donatorJid), false)
    assert.equal(quota.getTier(donatorJid), 'free')

    quota.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('!donasi shows lifetime benefits and !setdonasi modifies donator status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allybot-donasi-test-'))
  const dbPath = join(root, 'donasi-test.sqlite')
  const ownerJid = '6283197859955@s.whatsapp.net'
  const userJid = '6287777777777@s.whatsapp.net'

  const sent = []
  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent,
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text, options) {
      sent.push({ remoteJid, text, options })
    },
  }

  try {
    const quota = new QuotaService(dbPath, logger, { botOwnerJid: ownerJid })
    quota.initialize()

    const events = new EventBus(logger)
    const services = new ServiceRegistry(logger)
    services.register(quota)

    const config = { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid }
    const registry = new CommandRegistry(config, logger, whatsapp, services, events, (perm, ctx) => {
      if (perm === 'bot.owner') {
        const sender = ctx.message.senderJid ?? ctx.message.remoteJid
        return sender === ownerJid
      }
      return true
    })

    utilityPlugin.load({
      logger,
      config,
      events,
      commands: registry,
      services,
    })

    // 1. Regular user runs !donasi
    await registry.dispatch({
      id: 'm1',
      remoteJid: userJid,
      senderJid: userJid,
      text: '!donasi',
      timestamp: Date.now(),
      fromMe: false,
    })

    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /𝐃𝗼𝗻𝐚𝐬𝗶 𝐀𝗹𝗹𝘆𝐬𝐬𝗲𝐚/)
    assert.match(sent[0].text, /Member Regular/)
    assert.match(sent[0].text, /Seumur Hidup/)

    // 2. Non-owner tries !setdonasi -> rejected by permission
    await registry.dispatch({
      id: 'm2',
      remoteJid: userJid,
      senderJid: userJid,
      text: '!setdonasi 6287777777777 on',
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.match(sent.at(-1)?.text ?? '', /hanya tersedia untuk owner|belum memiliki izin/)

    // 3. Owner runs !setdonasi -> success
    await registry.dispatch({
      id: 'm3',
      remoteJid: ownerJid,
      senderJid: ownerJid,
      text: '!setdonasi 6287777777777 on',
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.match(sent.at(-1)?.text ?? '', /berhasil diaktifkan/)
    assert.equal(quota.isDonator(userJid), true)

    // 4. Now user runs !donasi again (after cooldown) -> status Donator Seumur Hidup
    await new Promise((r) => setTimeout(r, 1100))
    await registry.dispatch({
      id: 'm4',
      remoteJid: userJid,
      senderJid: userJid,
      text: '!donasi',
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.match(sent.at(-1)?.text ?? '', /Donator Seumur Hidup \(Aktif\)/)

    quota.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
