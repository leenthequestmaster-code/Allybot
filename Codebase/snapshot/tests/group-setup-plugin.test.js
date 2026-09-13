import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { createGroupSetupMissionPlugin } from '../dist/framework/plugins/group-setup-mission.js'

function createHarness(databasePath) {
  const sent = []
  const listeners = []
  const commands = []
  const whatsapp = {
    userJid: 'bot@s.whatsapp.net',
    async sendText(remoteJid, text) { sent.push({ remoteJid, text }) },
    async getGroupMetadata(groupJid) {
      return { jid: groupJid, subject: 'Test Group', participants: [{ jid: 'admin@s.whatsapp.net', role: 'admin' }] }
    },
  }
  const configuration = { applied: [], applySetup(draft) { this.applied.push(draft) } }
  const plugin = createGroupSetupMissionPlugin(whatsapp)
  const context = {
    logger: pino({ level: 'silent' }),
    config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath },
    events: { on(_name, listener) { listeners.push(listener); return () => {} } },
    commands: { register(command) { commands.push(command); return () => {} } },
    services: { get() { return configuration } },
  }
  return { plugin, context, sent, listeners, commands, whatsapp, configuration }
}

test('Group Setup Mission plugin persists and resumes active wizard across plugin reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-setup-'))
  const databasePath = join(directory, 'core.sqlite')
  try {
    const first = createHarness(databasePath)
    first.plugin.load(first.context)
    const command = first.commands.find(({ name }) => name === 'groupsetup')
    const replies = []
    await command.handler({
      message: { id: 'command-1', remoteJid: '123@g.us', senderJid: 'admin@s.whatsapp.net', timestamp: 1, fromMe: false },
      args: [], prefix: '!', config: first.context.config, logger: first.context.logger, services: first.context.services, whatsapp: first.whatsapp,
      reply: async (text) => replies.push(text),
    })
    assert.match(replies[0], /dimulai/)
    await first.listeners[0]({ id: 'input-1', remoteJid: '123@g.us', senderJid: 'admin@s.whatsapp.net', text: 'Rules', timestamp: 2, fromMe: false })
    assert.match(first.sent[0].text, /welcome/)
    first.plugin.unload(first.context)

    const second = createHarness(databasePath)
    second.plugin.load(second.context)
    const resumedCommand = second.commands.find(({ name }) => name === 'groupsetup')
    const resumed = []
    await resumedCommand.handler({
      message: { id: 'command-2', remoteJid: '123@g.us', senderJid: 'admin@s.whatsapp.net', timestamp: 3, fromMe: false },
      args: [], prefix: '!', config: second.context.config, logger: second.context.logger, services: second.context.services, whatsapp: second.whatsapp,
      reply: async (text) => resumed.push(text),
    })
    assert.match(resumed[0], /welcome/)
    second.plugin.unload(second.context)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Group Setup Mission plugin denies input after actor loses admin role', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-setup-deny-'))
  const databasePath = join(directory, 'core.sqlite')
  try {
    const harness = createHarness(databasePath)
    harness.whatsapp.getGroupMetadata = async () => ({ jid: '123@g.us', subject: 'Test Group', participants: [{ jid: 'admin@s.whatsapp.net', role: 'member' }] })
    harness.plugin.load(harness.context)
    const command = harness.commands.find(({ name }) => name === 'groupsetup')
    await command.handler({
      message: { id: 'command-1', remoteJid: '123@g.us', senderJid: 'admin@s.whatsapp.net', timestamp: 1, fromMe: false },
      args: [], prefix: '!', config: harness.context.config, logger: harness.context.logger, services: harness.context.services, whatsapp: harness.whatsapp,
      reply: async () => {},
    })
    await harness.listeners[0]({ id: 'input-1', remoteJid: '123@g.us', senderJid: 'admin@s.whatsapp.net', text: 'Rules', timestamp: 2, fromMe: false })
    assert.match(harness.sent[0].text, /dicabut/)
    harness.plugin.unload(harness.context)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
