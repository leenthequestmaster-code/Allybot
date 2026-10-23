import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRRScheduler, AdaptivePacer, AegisQueueService } from '../dist/services/aegis-queue/index.js';
test('1. Starvation Test: Group B (5 light tasks) finishes well before Group A (100 heavy tasks)', () => {
  const scheduler = new DRRScheduler({
    quantum: 300,
    maxDeficit: 1800,
    maxQueueDepthPerJid: 500,
    sparseFlowBoost: true
  });
  const groupA = '120363000001@g.us'; // Noisy neighbor (500 members spamming media)
  const groupB = '120363000002@g.us'; // Quiet group running !ping / !catur

  // Group A floods 100 heavy video tasks (cost = 450 credits each)
  for (let i = 1; i <= 100; i++) {
    const ok = scheduler.enqueue(groupA, `A-${i}`, `heavy-video-${i}`, {
      kind: 'video',
      sizeBytes: 2 * 1024 * 1024
    });
    assert.equal(ok, true);
  }

  // Group B sends 5 light text commands (cost = 40 credits each)
  for (let i = 1; i <= 5; i++) {
    const ok = scheduler.enqueue(groupB, `B-${i}`, `light-ping-${i}`, {
      kind: 'text',
      textLength: 16
    });
    assert.equal(ok, true);
  }
  assert.equal(scheduler.size, 105);
  const dispatchOrder = [];
  let lastGroupBIndex = -1;
  let lastGroupAIndex = -1;
  while (scheduler.size > 0) {
    const pkt = scheduler.dequeue();
    assert.ok(pkt);
    const idx = dispatchOrder.length;
    dispatchOrder.push(pkt.id);
    if (pkt.jid === groupB) lastGroupBIndex = idx;
    if (pkt.jid === groupA) lastGroupAIndex = idx;
  }
  assert.equal(dispatchOrder.length, 105);
  // All 5 light tasks from Group B must complete within the very first quantum rounds (< 15 total dispatches),
  // whereas Group A finishes at index 104!
  assert.ok(lastGroupBIndex < 15, `Expected Group B to finish within first 15 dispatches, but finished at index ${lastGroupBIndex}`);
  assert.ok(lastGroupBIndex < lastGroupAIndex);
});
test('2. Adaptive Pacer Test: Meta-BBR interval expands on RTT spikes and recovers on low RTT with Gaussian jitter', () => {
  let now = 1_000_000;
  const pacer = new AdaptivePacer({
    initialIntervalMs: 120,
    minIntervalMs: 80,
    maxIntervalMs: 400,
    jitterStdDevMs: 15,
    emaAlpha: 0.25,
    lowRttThresholdMs: 200,
    highRttThresholdMs: 350,
    spikeRttThresholdMs: 500,
    backoffMultiplier: 1.35,
    recoveryStepMs: 10,
    clock: () => now
  });
  const initialSnap = pacer.getSnapshot();
  assert.equal(initialSnap.baseIntervalMs, 120);
  assert.equal(initialSnap.state, 'CRUISE');

  // Simulate outbound messages followed by high-latency Baileys status=3 ACKs (650ms RTT spike)
  for (let i = 1; i <= 5; i++) {
    const msgId = `MSG-SPIKE-${i}`;
    pacer.trackOutboundMessage(msgId, now);
    now += 650;
    const count = pacer.onBaileysMessagesUpdate([{
      key: {
        id: msgId
      },
      update: {
        status: 3
      }
    }], now);
    assert.equal(count, 1);
  }
  const congestedSnap = pacer.getSnapshot();
  assert.equal(congestedSnap.state, 'BACKOFF');
  assert.ok(congestedSnap.baseIntervalMs > 250, `Expected baseIntervalMs > 250ms under RTT spike, got ${congestedSnap.baseIntervalMs}ms`);
  assert.ok(congestedSnap.baseIntervalMs <= 400);

  // Now simulate healthy low-RTT samples (85ms) and verify additive recovery
  for (let i = 1; i <= 25; i++) {
    pacer.recordRttSample(85);
  }
  const recoveredSnap = pacer.getSnapshot();
  assert.equal(recoveredSnap.state, 'CRUISE');
  assert.ok(recoveredSnap.baseIntervalMs <= 120 && recoveredSnap.baseIntervalMs >= 80, `Expected baseIntervalMs to recover to [80, 120], got ${recoveredSnap.baseIntervalMs}ms`);

  // Verify Box-Muller Gaussian micro-jitter produces natural variance (not constant static delay)
  const delays = new Set();
  for (let i = 0; i < 30; i++) {
    const d = pacer.computeNextDelayMs();
    assert.ok(d >= 60 && d <= 445);
    delays.add(d);
  }
  assert.ok(delays.size > 5, 'Expected Gaussian micro-jitter to produce varied intervals');
  pacer.shutdown();
});
test('3. Zero Leak Test: Idle JID queues and stale in-flight ACK entries are pruned after timeout', () => {
  let now = 5_000_000;
  const scheduler = new DRRScheduler({
    idleTimeoutMs: 60_000,
    clock: () => now
  });
  const pacer = new AdaptivePacer({
    inflightAckTtlMs: 60_000,
    clock: () => now
  });

  // Create 50 ephemeral group JIDs, enqueue & drain 1 message each
  for (let i = 0; i < 50; i++) {
    const jid = `1203630099${i}@g.us`;
    scheduler.enqueue(jid, `pkt-${i}`, 'hello', {
      kind: 'text',
      textLength: 5
    });
    pacer.trackOutboundMessage(`ack-${i}`, now);
  }
  assert.equal(scheduler.trackedFlowCount, 50);
  assert.equal(pacer.getSnapshot().inflightAckCount, 50);

  // Drain all packets from scheduler so all 50 JID queues become idle/empty
  while (scheduler.size > 0) {
    scheduler.dequeue();
  }

  // Advance clock by 30s (< 60s timeout): nothing should be pruned yet
  now += 30_000;
  assert.equal(scheduler.pruneIdleFlows(now), 0);
  assert.equal(pacer.pruneStaleInflightAcks(now), 0);
  assert.equal(scheduler.trackedFlowCount, 50);

  // Advance clock past 60s idle timeout: all 50 idle flows and stale ACKs must be pruned
  now += 35_000;
  const prunedFlows = scheduler.pruneIdleFlows(now);
  const prunedAcks = pacer.pruneStaleInflightAcks(now);
  assert.equal(prunedFlows, 50);
  assert.equal(prunedAcks, 50);
  assert.equal(scheduler.trackedFlowCount, 0);
  assert.equal(pacer.getSnapshot().inflightAckCount, 0);
  pacer.shutdown();
});
test('4. Unified Two-Plane Execution, Single-Writer Socket Serialization, and Speculative Reactions', async () => {
  let activeSocketWriters = 0;
  let maxObservedConcurrentWriters = 0;
  const sentEvents = [];
  const fakeWhatsapp = {
    isConnected: true,
    onMessage: () => () => {},
    onGroupParticipantUpdate: () => () => {},
    onConnectionState: () => () => {},
    getGroupMetadata: async jid => ({
      jid,
      subject: 'Test',
      participants: []
    }),
    getGroupInviteLink: async () => undefined,
    start: async () => {},
    close: async () => {},
    sendText: async (remoteJid, text) => {
      activeSocketWriters++;
      if (activeSocketWriters > maxObservedConcurrentWriters) {
        maxObservedConcurrentWriters = activeSocketWriters;
      }
      await new Promise(r => setTimeout(r, 5));
      sentEvents.push({
        kind: 'text',
        jid: remoteJid,
        detail: text
      });
      activeSocketWriters--;
    },
    sendMedia: async (remoteJid, payload) => {
      activeSocketWriters++;
      if (activeSocketWriters > maxObservedConcurrentWriters) {
        maxObservedConcurrentWriters = activeSocketWriters;
      }
      await new Promise(r => setTimeout(r, 8));
      sentEvents.push({
        kind: 'media',
        jid: remoteJid,
        detail: payload.kind
      });
      activeSocketWriters--;
    },
    sendReaction: async (remoteJid, _key, emoji) => {
      activeSocketWriters++;
      if (activeSocketWriters > maxObservedConcurrentWriters) {
        maxObservedConcurrentWriters = activeSocketWriters;
      }
      await new Promise(r => setTimeout(r, 2));
      sentEvents.push({
        kind: 'reaction',
        jid: remoteJid,
        detail: emoji
      });
      activeSocketWriters--;
    }
  };
  const aegis = new AegisQueueService(fakeWhatsapp, undefined, {
    enablePacing: false,
    // disable sleep delay for fast unit test execution
    durableThresholdMs: 500,
    retryBackoffBaseMs: 10
  });
  aegis.initialize();
  let flakyAttempts = 0;

  // Dispatch 10 concurrent tasks across Hot-Plane and Durable-Plane (including a flaky durable job)
  const receipts = await Promise.all([
  // Hot-plane task with speculative reaction (⏳ -> ✅)
  aegis.dispatch({
    remoteJid: 'group-hot@g.us',
    estimatedDurationMs: 50,
    sourceMessage: {
      id: 'm1',
      remoteJid: 'group-hot@g.us',
      fromMe: false
    },
    speculativeReaction: true,
    execute: async () => ({
      outbound: {
        kind: 'text',
        text: 'Pong!'
      },
      result: 42
    })
  }),
  // Durable-plane task (>500ms estimated) that fails once and succeeds on retry
  aegis.dispatch({
    remoteJid: 'group-durable@g.us',
    estimatedDurationMs: 1_500,
    maxRetries: 2,
    execute: async () => {
      flakyAttempts++;
      if (flakyAttempts === 1) {
        throw new Error('Transient ffmpeg error');
      }
      return {
        outbound: {
          kind: 'media',
          media: {
            kind: 'video',
            data: new Uint8Array(1024),
            mimeType: 'video/mp4',
            caption: 'Review MP4'
          }
        },
        result: 'video-ok'
      };
    }
  })]);
  assert.equal(receipts[0].planeUsed, 'hot');
  assert.equal(receipts[0].result, 42);
  assert.equal(receipts[1].planeUsed, 'durable');
  assert.equal(receipts[1].retriesUsed, 1);
  assert.equal(receipts[1].result, 'video-ok');

  // Single-Writer invariant: maxObservedConcurrentWriters MUST be strictly 1!
  assert.equal(maxObservedConcurrentWriters, 1, `Single-Writer invariant violated: observed ${maxObservedConcurrentWriters} concurrent socket writes`);

  // Verify speculative reactions (⏳ and ✅) were sent for group-hot@g.us
  const hotReactions = sentEvents.filter(e => e.jid === 'group-hot@g.us' && e.kind === 'reaction').map(e => e.detail);
  assert.deepEqual(hotReactions, ['⏳', '✅']);
  await aegis.shutdown();
});