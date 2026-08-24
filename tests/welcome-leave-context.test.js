import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { createGroupContextPlugin } from '../dist/framework/plugins/group-context.js'
import { createWelcomeLeavePlugin } from '../dist/framework/plugins/welcome-leave.js'
import { GroupContextService } from '../dist/services/group-context-service.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000000@g.us'

class ContextCore {
  isConnected = true
  userJid = 'bot@s.whatsapp.net'
  sent = []
  participants = new Set()
  messages = new Set()
  connections = new Set()
  mode = 'ic'

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async getGroupMetadata(jid) { return { jid, subject: 'Context Test', participants: [{ jid: 'admin@s.whatsapp.net', role: 'admin' }] } }
  async start() {}
  async close() {}
  async emitParticipants(event) { for (const listener of [...this.participants]) await listener(event) }
}

function createApp(core, databasePath) {
  const groupContext = new GroupContextService(logger, {
    env: {
      GROUP_CONTEXT_ENABLED: 'true',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-value',
    },
    createClient: () => ({
      async rpc(functionName) {
        if (functionName !== 'group_context_get') throw new Error(`unexpected RPC ${functionName}`)
        return {
          data: {
            ok: true,
            mode: core.mode,
            ic_subtype: core.mode === 'ic' ? 'other' : null,
            ooc_policy: core.mode === 'ic' ? 'strict' : 'disabled',
            revision: 1,
          },
          error: null,
        }
      },
    }),
  })
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, core)
  app.registerService(new GroupConfigurationService(databasePath, logger))
  app.registerService(groupContext)
  app.registerPlugin(menuPlugin)
  app.registerPlugin(groupPlugin)
  app.registerPlugin(createGroupContextPlugin(core))
  app.registerPlugin(createWelcomeLeavePlugin(core))
  return app
}

function participantEvent() {
  return {
    groupJid,
    groupName: 'Context Test',
    participantJids: ['628120000000@s.whatsapp.net'],
    action: 'add',
    at: Date.now(),
  }
}

test('generic Welcome/Leave is locked outside OOC mode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-welcome-context-'))
  const core = new ContextCore()
  const app = createApp(core, join(directory, 'core.sqlite'))
  try {
    await app.start()
    core.mode = 'ic'
    await core.emitParticipants(participantEvent())
    assert.equal(core.sent.length, 0)
    core.mode = 'guide'
    await core.emitParticipants(participantEvent())
    assert.equal(core.sent.length, 0)
    core.mode = 'ooc'
    await core.emitParticipants(participantEvent())
    assert.equal(core.sent.length, 1)
    assert.match(core.sent[0].text, /Selamat datang di keluarga Allyssea Roleplay Community\./)
  } finally {
    await app.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
