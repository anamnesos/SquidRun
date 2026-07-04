'use strict';

/**
 * TYPED SEAMS — runtime contracts (S468, four-day plan Day-2 lane).
 *
 * ui/types/contracts.d.ts declares the load-bearing seam shapes; these
 * tests pin the PRODUCERS to those declarations at runtime, so a drifted
 * field set fails a suite instead of silently starving a consumer
 * (the born-blind seam-audit law: diff what consumers read against what
 * producers emit — then make the diff a test).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const verdictLedger = require('../modules/verdict-ledger');
const { applyLaneCommand } = require('../scripts/hm-lane');
const { lastOutboundFromRows } = require('../scripts/hm-lane-heartbeat');
const receipt = require('../modules/model-prompt-receipt');
const { buildInjectMessageIpcPackets } = require('../modules/inject-message-ipc');
const engine = require('../modules/squid-room-creature-engine');
const creatureRuntime = require('../modules/squid-room-creature-runtime');
const workItemLedger = require('../modules/main/work-item-ledger');

describe('verdict ledger seam (VerdictRecord)', () => {
  const record = verdictLedger.createVerdict({
    issuer: 'architect',
    kind: 'claim',
    subject: 'typed-seams',
    statement: 'contract fixture',
    evidence: 'this test',
    issuedAt: '2026-07-04T05:00:00.000Z',
  });

  test('createVerdict emits exactly the VerdictRecord field set', () => {
    expect(Object.keys(record).sort()).toEqual([
      'evidence', 'expiresAt', 'id', 'issuedAt', 'issuer', 'kind',
      'outcome', 'source', 'statement', 'subject',
    ]);
    expect(Object.keys(record.outcome).sort()).toEqual([
      'note', 'pendsOn', 'resolvedAt', 'resolver', 'status', 'supersededBy',
    ]);
  });

  test('credibility emits exactly the VerdictCredibility field set', () => {
    const standing = verdictLedger.credibility([record], 'architect');
    expect(Object.keys(standing).sort()).toEqual(
      ['accuracy', 'expired', 'issuer', 'open', 'resolved', 'status'],
    );
  });
});

describe('lane seam (LaneRecord)', () => {
  test('open emits exactly the LaneRecord field set', () => {
    const state = { version: 1, lanes: {} };
    applyLaneCommand(state, 'open', 'seam-fixture', {
      owner: 'builder', objective: 'pin the shape',
    }, 1000);
    expect(Object.keys(state.lanes['seam-fixture']).sort()).toEqual([
      'id', 'lastPokeAtMs', 'objective', 'openedAtMs', 'owner',
      'pokes', 'reason', 'status', 'updatedAtMs',
    ]);
  });

  test('lane statuses stay within the LaneStatus union', () => {
    const union = ['open', 'done', 'blocked', 'stalled'];
    const state = { version: 1, lanes: {} };
    applyLaneCommand(state, 'open', 'l1', { owner: 'b', objective: 'o' }, 1);
    expect(union).toContain(state.lanes.l1.status);
    applyLaneCommand(state, 'block', 'l1', { reason: 'r' }, 2);
    expect(union).toContain(state.lanes.l1.status);
    applyLaneCommand(state, 'close', 'l1', {}, 3);
    expect(union).toContain(state.lanes.l1.status);
  });
});

describe('comms journal seam (CommsJournalJsonRow -> heartbeat idle read)', () => {
  test('lastOutboundFromRows consumes --json rows, newest wins, roles filter', () => {
    const rows = [
      { sender: 'builder', timestampMs: 100, rawBody: 'x' },
      { sender: 'builder', timestampMs: 300, rawBody: 'y' },
      { sender: 'oracle', timestampMs: 200, rawBody: 'z' },
      { sender: 'stranger', timestampMs: 999, rawBody: 'w' },
      { sender: 'builder' }, // no timestampMs — ignored, never NaN
    ];
    expect(lastOutboundFromRows(rows, ['builder', 'oracle'])).toEqual({
      builder: 300, oracle: 200,
    });
    expect(lastOutboundFromRows(undefined, ['builder'])).toEqual({});
  });
});

describe('receipt seam (ReceiptMarkerFields)', () => {
  test('buildReceiptMarker round-trips through extractReceiptMarker', () => {
    const marker = receipt.buildReceiptMarker({ deliveryId: 'd-77', messageId: 'm-88' });
    expect(marker.startsWith(receipt.RECEIPT_MARKER_PREFIX)).toBe(true);
    const extracted = receipt.extractReceiptMarker(`hello\n${marker}`);
    expect(extracted).toMatchObject({
      semanticEvent: 'prompt_submit',
      deliveryId: 'd-77',
      rawDeliveryId: 'd-77',
      messageId: 'm-88',
    });
  });

  test('every version-floor mapping status has a proof rank', () => {
    for (const mapping of receipt.VERSION_FLOOR_MAPPINGS) {
      expect(receipt.getProofRank(mapping.status)).toBeGreaterThan(0);
    }
  });
});

describe('pane-host IPC seam (InjectMessageBridgePayload/IpcChunkInfo)', () => {
  test('chunked packets carry the full IpcChunkInfo field set', () => {
    const big = 'x'.repeat(64);
    const packets = buildInjectMessageIpcPackets(
      { panes: ['1'], message: big, meta: { runtimeHint: 'claude' } },
      { chunkThresholdBytes: 16, chunkSizeBytes: 16 },
    );
    expect(packets.length).toBeGreaterThan(1);
    for (const packet of packets) {
      expect(Object.keys(packet.ipcChunk).sort()).toEqual(
        ['chunkBytes', 'count', 'groupId', 'index', 'totalBytes'],
      );
      expect(typeof packet.message).toBe('string');
      expect(typeof packet.messageBytes).toBe('number');
      expect(packet.meta.ipcChunked).toBe(true);
      expect(packet.meta.ipcOriginalBytes).toBe(64);
      expect(packet.meta.runtimeHint).toBe('claude');
    }
  });

  test('small payloads pass through unchunked with ipcChunk null', () => {
    const [packet] = buildInjectMessageIpcPackets({ panes: ['2'], message: 'hi' });
    expect(packet.ipcChunk).toBeNull();
    expect(packet.meta.ipcChunked).toBe(false);
  });
});

describe('pane status seam (three vocabularies, split on purpose)', () => {
  test('runtime motion classes map onto exactly the engine-accepted activities', () => {
    const mapped = Object.values(creatureRuntime.ACTIVITY_BY_MOTION_CLASS).sort();
    const accepted = Object.keys(engine.ACTIVITY_PROFILES).sort();
    expect(mapped).toEqual(accepted); // 'working', 'settling', 'resting' — no orphans either way
  });
});

describe('creature engine seam (CreatureEngineConsumedState)', () => {
  test('engine state carries every field the runtime consumes', () => {
    const creature = engine.createSquidCreature({ petId: 'oracle', seed: 5 });
    const { state } = creature;
    expect(typeof state.petId).toBe('string');
    expect(typeof state.x).toBe('number');
    expect(typeof state.y).toBe('number');
    expect(typeof state.heading).toBe('number');
    expect(Object.keys(engine.ACTIVITY_PROFILES)).toContain(state.activity);
    expect(typeof state.palette.rim).toBe('string');
  });
});

describe('queue cross-read seam (QueueActiveTaskView.updatedAt)', () => {
  test('updatedAt derives from producer ms fields; absent timestamps stay null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-queue-'));
    const queuePath = path.join(dir, 'agent-task-queue.json');
    const lanePath = path.join(dir, 'current-lane.json');
    fs.writeFileSync(queuePath, JSON.stringify({
      version: 3,
      agents: {
        builder: { pending: [], history: [], active: {
          taskId: 't-1', title: 'has timestamp', state: 'active',
          lastAdvancedAt: 1751600000000,
        } },
        oracle: { pending: [], history: [], active: {
          taskId: 't-2', title: 'no timestamps', state: 'active',
        } },
      },
    }));
    fs.writeFileSync(lanePath, JSON.stringify({ activeLane: null }));

    const result = workItemLedger.buildActiveWorkReconciliation({
      queuePath,
      currentLanePath: lanePath,
      listResult: { items: [], staleMarkers: [] },
    });
    const byId = Object.fromEntries(result.queueActive.map((t) => [t.taskId, t]));
    expect(byId['t-1'].updatedAt).toBe(new Date(1751600000000).toISOString());
    expect(byId['t-2'].updatedAt).toBeNull(); // never a fabricated "now"

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
