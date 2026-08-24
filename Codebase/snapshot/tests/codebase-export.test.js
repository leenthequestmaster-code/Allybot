import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { codebasePlugin } from '../dist/framework/plugins/codebase.js'

const logger = pino({ level: 'silent' })

class FakeCore {
  isConnected = false
  userJid = 'bot@s.whatsapp.net'
  sent = []
  media = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.groupParticipantListeners.add(listener); return () => this.groupParticipantListeners.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text) { this.sent.push({ type: 'text', remoteJid, text }) }
  async sendMedia(remoteJid, payload) { this.media.push({ remoteJid, payload }) }
  async start() {
    this.isConnected = true
    await Promise.all([...this.connections].map((listener) => listener({ status: 'connected', at: Date.now() })))
  }
  async close() {
    this.isConnected = false
    await Promise.all([...this.connections].map((listener) => listener({ status: 'idle', at: Date.now() })))
  }
  async emitMessage(message) {
    await Promise.all([...this.messages].map((listener) => listener(message)))
  }
}

async function withArchive(content, callback) {
  const directory = await mkdtemp(join(process.cwd(), '.allybot-codebase-test-'))
  const archivePath = join(directory, 'export.zip')
  await writeFile(archivePath, content)
  try {
    return await callback(relative(process.cwd(), archivePath))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function message(id, text, remoteJid = 'owner@s.whatsapp.net', senderJid = 'owner@s.whatsapp.net') {
  return { id, remoteJid, senderJid, text, timestamp: Date.now(), fromMe: false }
}

test('codebase command sends a bounded ZIP document to an authorized developer', async () => {
  await withArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), async (archivePath) => {
    const core = new FakeCore()
    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net', codebaseExportEnabled: true, codebaseExportPath: archivePath, codebaseExportMaxBytes: 1024 },
      logger,
      core,
      { permissionResolver: () => true },
    )
    app.registerPlugin(codebasePlugin)
    await app.start()
    await core.emitMessage(message('codebase', '!codebase'))

    assert.equal(core.media.length, 1)
    assert.equal(core.media[0].payload.kind, 'document')
    assert.equal(core.media[0].payload.mimeType, 'application/zip')
    assert.equal(core.media[0].payload.fileName, 'allybot-codebase-latest.zip')
    assert.equal(core.media[0].payload.data.length, 6)
    assert.equal(core.media[0].payload.caption.includes('allybot-codebase-test-'), false)
    assert.equal(core.sent.length, 0)
    await app.stop()
  })
})

test('codebase command fails safely for an unavailable or invalid export', async () => {
  await withArchive(Buffer.from('not a zip'), async (archivePath) => {
    const core = new FakeCore()
    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net', codebaseExportEnabled: true, codebaseExportPath: archivePath, codebaseExportMaxBytes: 1024 },
      logger,
      core,
      { permissionResolver: () => true },
    )
    app.registerPlugin(codebasePlugin)
    await app.start()
    await core.emitMessage(message('invalid-codebase', '!codebase'))

    assert.equal(core.media.length, 0)
    assert.match(core.sent[0].text, /Codebase export belum tersedia/)
    assert.equal(core.sent[0].text.includes('not a zip'), false)
    await app.stop()
  })
})

test('codebase command rejects symlinked export paths', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.allybot-codebase-test-'))
  const targetPath = join(directory, 'target.zip')
  const linkPath = join(directory, 'export.zip')
  await writeFile(targetPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  await symlink(targetPath, linkPath)
  try {
    const core = new FakeCore()
    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net', codebaseExportEnabled: true, codebaseExportPath: relative(process.cwd(), linkPath), codebaseExportMaxBytes: 1024 },
      logger,
      core,
      { permissionResolver: () => true },
    )
    app.registerPlugin(codebasePlugin)
    await app.start()
    await core.emitMessage(message('symlink-codebase', '!codebase'))

    assert.equal(core.media.length, 0)
    assert.match(core.sent[0].text, /Codebase export belum tersedia/)
    await app.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('codebase command is permission-gated', async () => {
  await withArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04]), async (archivePath) => {
    const core = new FakeCore()
    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net', codebaseExportEnabled: true, codebaseExportPath: archivePath, codebaseExportMaxBytes: 1024 },
      logger,
      core,
      { permissionResolver: () => false },
    )
    app.registerPlugin(codebasePlugin)
    await app.start()
    await core.emitMessage(message('denied-codebase', '!codebase', 'private@s.whatsapp.net', 'stranger@s.whatsapp.net'))

    assert.equal(core.media.length, 0)
    assert.match(core.sent[0].text, /Developer Mode/)
    await app.stop()
  })
})
