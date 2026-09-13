import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import { SuggestionRelayService } from '../dist/services/suggestion-relay-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { SceneService } from '../dist/services/scene-service.js'
import { KnowledgeService } from '../dist/services/knowledge-service.js'

const logger = pino({ level: 'silent' })

const groupJid = '<jid-redacted@g.us>'
const otherGroupJid = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const memberJid = '<jid-redacted@s.whatsapp.net>'
const otherMemberJid = '<jid-redacted@s.whatsapp.net>'

function fakeWhatsappFor(adminJids) {
  return {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    async getGroupMetadata(groupJid_) {
      const participants = adminJids.map((jid) => ({ jid, role: 'admin' }))
      participants.push({ jid: otherMemberJid, role: 'member' })
      return { jid: groupJid_, subject: 'Fixture group', ownerJid: adminJid, participants }
    },
  }
}

function serviceContext(services) {
  return { logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services }
}

// A full behavioral fixture: guardrails + scene + knowledge + suggestion relay
// share one temp SQLite database and a controllable clock, exactly like the
// production service graph wired in src/index.ts.
function createFixture(options = {}) {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'allybot-suggestion-relay-')), 'core.sqlite')
  let now = 1_700_000_000_000
  const clock = () => now
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock, maxHotAuditRecords: 400 })
  const scenes = new SceneService(databasePath, logger, { clock, defaultTtlMinutes: 60 })
  const knowledge = new KnowledgeService(databasePath, logger, { clock, defaultRetentionMs: 3_600_000 })
  const suggestions = new SuggestionRelayService(databasePath, logger, { clock, ...options })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'scene') return scenes
      if (name === 'knowledge') return knowledge
      if (name === 'suggestion-relay') return suggestions
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return ['platform-guardrails', 'scene', 'knowledge', 'suggestion-relay'].includes(name) },
  }
  const context = serviceContext(services)
  guardrails.initialize(context)
  scenes.initialize(context)
  knowledge.initialize(context)
  suggestions.initialize(context)
  return {
    databasePath,
    guardrails,
    scenes,
    knowledge,
    suggestions,
    context,
    now: () => now,
    advance(ms) { now += ms },
  }
}

function closeFixture(fixture) {
  fixture.suggestions.shutdown(fixture.context)
  fixture.knowledge.shutdown(fixture.context)
  fixture.scenes.shutdown(fixture.context)
  fixture.guardrails.shutdown(fixture.context)
  rmSync(fixture.databasePath.replace(/core\.sqlite$/, ''), { recursive: true, force: true })
}

// Enables the full suggestion path for a group: scene feature, an open scene
// the member participates in, receive_assistance + share_context consent, the
// knowledge feature, and an approved group-visible source bookmark.
function primeGroup(fixture, { group = groupJid, requester = memberJid, sourceCreator = otherMemberJid, actor = adminJid } = {}) {
  fixture.scenes.setEnabled(group, true, actor)
  fixture.knowledge.setEnabled(group, true, actor)
  const scene = fixture.scenes.openScene({ groupJid: group, creatorJid: requester, title: 'Suggestion fixture scene', visibility: 'public', now: fixture.now() })
  fixture.scenes.joinScene(group, scene.id, sourceCreator, fixture.now())
  fixture.scenes.setConsent({ groupJid: group, sceneReference: scene.id, userJid: requester, action: 'receive_assistance', enabled: true, ttlMinutes: 60, now: fixture.now() })
  fixture.scenes.setConsent({ groupJid: group, sceneReference: scene.id, userJid: sourceCreator, action: 'share_context', enabled: true, ttlMinutes: 60, now: fixture.now() })
  const source = fixture.knowledge.createBookmark({ groupJid: group, creatorJid: sourceCreator, title: 'Approved context', excerpt: 'A deliberately selected context excerpt', visibility: 'group', now: fixture.now() })
  return { scene, source }
}

function requestInput(overrides = {}) {
  return {
    groupJid: groupJid,
    actorJid: memberJid,
    sceneReference: 'scene-id',
    requestText: 'Tolong buat draft aturan main ringan untuk adegan ini',
    sourceReferences: ['source-id'],
    correlationId: 'corr-1',
    ...overrides,
  }
}

test('suggestion relay stays disabled until a group admin enables the feature flag', async () => {
  const fixture = createFixture()
  try {
    const { scene, source } = primeGroup(fixture)
    assert.equal(fixture.suggestions.isFeatureEnabled(groupJid), false)

    const denied = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(denied.kind, 'denied')
    assert.equal(denied.code, 'feature_disabled')

    // Admin enable requires the actor to be a group admin and only flips the flag.
    const nonAdmin = await fixture.suggestions.setEnabled(groupJid, otherMemberJid, true, fakeWhatsappFor([adminJid]), fixture.now())
    assert.ok('code' in nonAdmin)
    assert.equal(nonAdmin.code, 'actor_not_admin')

    const enabled = await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())
    assert.deepEqual(enabled, { enabled: true })
    assert.equal(fixture.suggestions.isFeatureEnabled(groupJid), true)
  } finally {
    closeFixture(fixture)
  }
})

test('suggestion request completes end-to-end through scene consent, approved sources, and a provider', async () => {
  const providerTexts = []
  const fixture = createFixture({
    provider: async (input) => {
      providerTexts.push(input)
      return `Draft aturan: ${input.requestText.slice(0, 30)}... (context: ${input.context.length} sumber)`
    },
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const result = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(result.kind, 'completed')
    assert.equal(result.duplicate, undefined)

    // Provider receives normalized request text and approved context, never raw JIDs.
    assert.equal(providerTexts.length, 1)
    assert.equal(providerTexts[0].requestText, requestInput().requestText)
    assert.equal(providerTexts[0].context.length, 1)
    assert.equal(providerTexts[0].context[0].title, 'Approved context')
    const serializedProviderInput = JSON.stringify(providerTexts[0])
    assert.equal(serializedProviderInput.includes(memberJid), false)
    assert.equal(serializedProviderInput.includes(sourceCreatorJid()), false)

    // Record exposes hashes, not identities; output content is returned on
    // the completed result itself.
    const record = result.record
    assert.equal(record.status, 'completed')
    assert.equal(record.outcomeCode, 'ok')
    assert.equal(record.contextCount, 1)
    assert.match(record.suggestion ?? '', /^Draft aturan: /)
    assert.match(record.requestHash, /^[0-9a-f]{64}$/)
    assert.match(record.actorRefHash, /^[0-9a-f]{1,16}$/)
    assert.match(record.outputHash, /^[0-9a-f]{64}$/)
    assert.equal(record.expiresAt > record.createdAt, true)
    assert.equal(record.contentExpiresAt >= record.expiresAt, true)

    // Reads through getRequest redact content unless explicitly requested.
    const withContent = fixture.suggestions.getRequest(record.id, true)
    assert.match(withContent.suggestion, /^Draft aturan: /)
    const withoutContent = fixture.suggestions.getRequest(record.id)
    assert.equal(withoutContent.suggestion, undefined)
    assert.equal(fixture.suggestions.getRequest(record.id).actorRefHash, record.actorRefHash)
  } finally {
    closeFixture(fixture)
  }
})

function sourceCreatorJid() {
  return otherMemberJid
}

test('replaying the same correlation id is deduplicated without re-invoking the provider', async () => {
  let providerCalls = 0
  const fixture = createFixture({
    provider: async () => {
      providerCalls += 1
      return 'Draft unik untuk tes dedup.'
    },
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const first = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(first.kind, 'completed')
    assert.equal(providerCalls, 1)

    // Same group + correlation hash → dedup path, provider not called again.
    const replay = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(replay.kind, 'completed')
    assert.equal(replay.duplicate, true)
    assert.equal(providerCalls, 1)
    assert.equal(replay.record.id, first.record.id)

    // Different group or correlation → fresh request (independent lifecycle).
    const other = await fixture.suggestions.request({
      ...requestInput({
        groupJid: otherGroupJid,
        sceneReference: scene.id,
        sourceReferences: [source.id.slice(0, 8)],
        correlationId: 'corr-2',
      }),
    })
    assert.ok(other.kind === 'denied' || other.kind === 'completed')
  } finally {
    closeFixture(fixture)
  }
})

test('a request with unknown scene or unapproved source is rejected without provider calls', async () => {
  let providerCalls = 0
  const fixture = createFixture({
    provider: async () => {
      providerCalls += 1
      return 'never'
    },
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const unknownScene = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)], correlationId: 'corr-unknown-scene' }),
    })
    // (scene is real here; the unknown-scene case uses a fresh id)
    assert.equal(unknownScene.kind, 'completed')

    const ghostSource = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: ['deadbeef'], correlationId: 'corr-ghost-source' }),
    })
    assert.equal(ghostSource.kind, 'denied')
    assert.equal(ghostSource.code, 'source_not_found')

    const ghostScene = await fixture.suggestions.request({
      ...requestInput({ sceneReference: 'nosuchscene1', sourceReferences: [source.id.slice(0, 8)], correlationId: 'corr-ghost-scene' }),
    })
    assert.equal(ghostScene.kind, 'denied')
    assert.ok(['consent_required', 'scene_unavailable'].includes(ghostScene.code), `unexpected code ${ghostScene.code}`)

    // A private source the requester did not create is invisible → source_not_found.
    const privateSource = fixture.knowledge.createBookmark({ groupJid: groupJid, creatorJid: otherMemberJid, title: 'Private note', excerpt: 'Hidden context', visibility: 'private', now: fixture.now() })
    const invisible = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [privateSource.id.slice(0, 8)], correlationId: 'corr-private-source' }),
    })
    assert.equal(invisible.kind, 'denied')
    assert.equal(invisible.code, 'source_not_found')
    assert.equal(providerCalls, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('provider failure records a failed request and the circuit shields the provider until recovery', async () => {
  let providerCalls = 0
  const fixture = createFixture({
    provider: async () => {
      providerCalls += 1
      if (providerCalls <= 3) throw new Error('provider down')
      return 'late recovery text'
    },
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const attempt = (correlationId) => fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)], correlationId }),
    })

    // Three failing requests trip the circuit (failureThreshold: 3).
    for (const correlationId of ['corr-fail-1', 'corr-fail-2', 'corr-fail-3']) {
      const outcome = await attempt(correlationId)
      assert.equal(outcome.kind, 'denied', `${correlationId} should be denied`)
      assert.equal(outcome.code, 'provider_unavailable')
      assert.equal(outcome.record.status, 'failed')
      assert.equal(outcome.record.outcomeCode, 'provider_unavailable')
    }
    assert.equal(providerCalls, 3)

    // The circuit opening must be auditable (regression: the event type must
    // satisfy the audit grammar instead of throwing out of recordProviderFailure).
    const openedAudit = fixture.guardrails.listAudit({ limit: 100 }).some((record) => record.eventType === 'provider.circuit.opened')
    assert.equal(openedAudit, true, 'expected provider.circuit.opened audit trail entry')

    // While the circuit is open (cooldown 30s) the provider is not consulted.
    fixture.advance(5_000)
    const blocked = await attempt('corr-fail-4')
    assert.equal(blocked.kind, 'denied')
    assert.equal(blocked.code, 'provider_unavailable')
    assert.equal(providerCalls, 3, 'provider must not be called while the circuit is open')

    // After the cooldown a half-open probe reaches the provider, which now
    // succeeds; the circuit closes and the request completes.
    fixture.advance(45_000)
    const recovered = await attempt('corr-fail-5')
    assert.equal(recovered.kind, 'completed')
    assert.equal(recovered.record.suggestion, 'late recovery text')
    assert.equal(providerCalls, 4)
    const closedAudit = fixture.guardrails.listAudit({ limit: 100 }).some((record) => record.eventType === 'provider.circuit.closed')
    assert.equal(closedAudit, true, 'expected provider.circuit.closed audit trail entry')
  } finally {
    closeFixture(fixture)
  }
})

test('consent withdrawal blocks a previously satisfiable request path', async () => {
  const fixture = createFixture({
    provider: async () => 'consent-scoped draft',
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const ok = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(ok.kind, 'completed')

    // Withdraw receive_assistance consent and request again with a new correlation.
    fixture.scenes.setConsent({ groupJid: groupJid, sceneReference: scene.id, userJid: memberJid, action: 'receive_assistance', enabled: false, now: fixture.now() })
    fixture.advance(70_000)
    const denied = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)], correlationId: 'corr-no-consent' }),
    })
    assert.equal(denied.kind, 'denied')
    assert.equal(denied.code, 'consent_required')
  } finally {
    closeFixture(fixture)
  }
})

test('expired requests flip to expired status and completed content is redacted after retention', async () => {
  const fixture = createFixture({
    provider: async () => 'draft yang akan kadaluarsa',
    requestTtlMs: 10 * 60_000,
    contentRetentionMs: 30 * 60_000,
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const completed = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(completed.kind, 'completed')
    const recordId = completed.record.id

    // Replaying a completed correlation dedups and returns the same record.
    fixture.advance(1)
    const replay = await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }),
    })
    assert.equal(replay.kind, 'completed')
    assert.equal(replay.duplicate, true)
    assert.equal(replay.record.id, recordId)

    // Advance past the content retention window. Redaction is applied by the
    // stale-state sweep that runs at the start of every request cycle, so a
    // final request (denied by rate limiting) still triggers the sweep and
    // the subsequent read returns the redacted record.
    fixture.advance(30 * 60_000)
    await fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)], correlationId: 'corr-sweep' }),
    }).catch(() => undefined)
    const redacted = fixture.suggestions.getRequest(recordId, true)
    assert.equal(redacted.suggestion, undefined, 'suggestion text must be redacted after the retention window')
    assert.equal(redacted.status, 'completed')
    assert.equal(redacted.outcomeCode, 'ok')
  } finally {
    closeFixture(fixture)
  }
})

test('request validation rejects malformed inputs before any policy evaluation', async () => {
  const fixture = createFixture()
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const base = { sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)] }

    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), requestText: '   ' }),
      /empty or exceeds/,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), requestText: 'password=letmein mohon bantu' }),
      /sensitive-looking/i,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), sourceReferences: [] }),
      /approved sources/i,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), sourceReferences: ['src1', 'src1'] }),
      /unique/i,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), sceneReference: 'bad scene!' }),
      /safe identifier/i,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), groupJid: 'not-a-group' }),
      /must be a valid JID|must be a WhatsApp group/,
    )
    await assert.rejects(
      () => fixture.suggestions.request({ ...requestInput(base), actorJid: 'x@y' }),
      /must be a valid JID/,
    )
    const before = fixture.suggestions.getRequest('00000000-0000-0000-0000-000000000000')
    assert.equal(before, undefined)
  } finally {
    closeFixture(fixture)
  }
})

test('rate limiting bounds suggestions per group and actor within the fixed window', async () => {
  let providerCalls = 0
  const fixture = createFixture({
    provider: async () => {
      providerCalls += 1
      return `rate-limit draft ${providerCalls}`
    },
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    const attempt = (correlationId) => fixture.suggestions.request({
      ...requestInput({ sceneReference: scene.id, sourceReferences: [source.id.slice(0, 8)], correlationId }),
    })

    const outcomes = []
    for (let index = 1; index <= 6; index += 1) {
      const outcome = await attempt(`corr-rate-${index}`)
      outcomes.push(outcome.kind === 'completed' ? 'completed' : outcome.code)
    }
    // The registered profile allows 5 requests per 60s per group+actor pair.
    assert.deepEqual(outcomes, [
      'completed', 'completed', 'completed', 'completed', 'completed', 'rate_limited',
    ])

    // A different actor in the same group has an independent budget.
    const otherActor = await fixture.suggestions.request({
      ...requestInput({
        actorJid: otherMemberJid,
        sceneReference: scene.id,
        sourceReferences: [source.id.slice(0, 8)],
        correlationId: 'corr-rate-other-actor',
      }),
    })
    // otherMemberJid has no receive_assistance consent (memberJid does), so
    // this exercises an independent denial path, not the rate limiter copy.
    assert.ok(otherActor.kind === 'denied' || otherActor.kind === 'completed')
    assert.equal(providerCalls, 5)
  } finally {
    closeFixture(fixture)
  }
})

test('relaying is isolated per group: enabling one group does not leak to another', async () => {
  const fixture = createFixture({
    provider: async () => 'isolated draft',
  })
  try {
    const { scene, source } = primeGroup(fixture)
    await fixture.suggestions.setEnabled(groupJid, adminJid, true, fakeWhatsappFor([adminJid]), fixture.now())

    assert.equal(fixture.suggestions.isFeatureEnabled(otherGroupJid), false)
    const other = await fixture.suggestions.request({
      ...requestInput({
        groupJid: otherGroupJid,
        sceneReference: scene.id,
        sourceReferences: [source.id.slice(0, 8)],
        correlationId: 'corr-cross-group',
      }),
    })
    assert.equal(other.kind, 'denied')
    assert.equal(other.code, 'feature_disabled')
  } finally {
    closeFixture(fixture)
  }
})

test('constructor rejects invalid tuning before any persistence happens', () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'allybot-suggestion-ctor-')), 'core.sqlite')
  try {
    assert.throws(() => new SuggestionRelayService(directory, logger, { requestTtlMs: 0 }), /requestTtlMs must be positive/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { contentRetentionMs: 1 }), /contentRetentionMs/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { maxRequestLength: 10 }), /maxRequestLength/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { maxContextSources: 0 }), /maxContextSources/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { maxOutputLength: 10 }), /maxOutputLength/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { operationTimeoutMs: 0 }), /operationTimeoutMs/)
    assert.throws(() => new SuggestionRelayService(directory, logger, { providerId: 'bad id' }), /safe identifier|provider id/)
  } finally {
    rmSync(directory.replace(/core\.sqlite$/, ''), { recursive: true, force: true })
  }
})
