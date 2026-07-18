'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  closeArmSpawnJournalStores,
  queryArmSpawnSessions,
  recordArmSpawnLifecycle,
  recordArmSpawnLivenessProof,
  recordArmSpawnStarted,
} = require('../modules/main/arm-spawn-journal');

function hasSqliteDriver() {
  try {
    const mod = require('node:sqlite');
    if (mod?.DatabaseSync) return true;
  } catch {}
  try {
    require('better-sqlite3');
    return true;
  } catch {}
  return false;
}

function startedInput(overrides = {}) {
  const durableAddress = overrides.durableAddress || 'arm://build-1a-qa/0123456789abcdef/trustquote-qa/dev-qa';
  const spawnLeaseId = overrides.spawnLeaseId || 'lease-1';
  const paneId = overrides.paneId || 'trustquote-dev-qa';
  const pid = overrides.pid || 4321;
  const sourceMessageId = overrides.sourceMessageId || 'ping-1';
  const expectedResponseClass = overrides.expectedResponseClass || 'arm.liveness.pong';
  const owner = overrides.owner || 'terminal-daemon';
  const recoveryEvent = overrides.recoveryEvent || 'lease_check_on_spawn';
  return {
    durableAddress,
    spawnLeaseId,
    previousSpawnLeaseId: overrides.previousSpawnLeaseId || null,
    registryId: 'arm-registry-qa',
    armId: 'arm-qa',
    appRoomId: 'trustquote-qa',
    armKey: 'dev-qa',
    paneId,
    role: 'trustquote-dev-qa',
    profileName: 'build-1a-qa',
    workspacePath: 'D:\\qa\\trustquote-test-copy',
    owner,
    recoveryEvent,
    sourceMessageId,
    expectedResponseClass,
    mainSessionId: overrides.mainSessionId || 'app-session-qa-1',
    terminal: {
      paneId,
      pid,
      alive: true,
      durableAddress,
      spawnLeaseId,
    },
    receipt: {
      schema: 'squidrun.arm_spawn_receipt.v0',
      eventClass: 'arm.spawn.started',
      status: 'spawned',
      reason: null,
      sourceMessageId,
      expectedResponseClass,
      durableAddress,
      spawnLeaseId,
      previousSpawnLeaseId: overrides.previousSpawnLeaseId || null,
      paneId,
      pid,
      owner,
      recoveryEvent,
      atMs: overrides.atMs || 1_000,
      ...overrides.receipt,
    },
    ...overrides.input,
  };
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('arm spawn session journal', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-spawn-journal-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
  });

  afterEach(() => {
    closeArmSpawnJournalStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('mints the active session and lifecycle journal in one SQLite transaction', () => {
    const inserted = recordArmSpawnStarted(startedInput(), { dbPath, nowMs: 1_000 });

    expect(inserted).toEqual(expect.objectContaining({
      ok: true,
      status: 'inserted',
      inserted: true,
      session: expect.objectContaining({
        durableAddress: 'arm://build-1a-qa/0123456789abcdef/trustquote-qa/dev-qa',
        spawnLeaseId: 'lease-1',
        status: 'active',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
      }),
    }));

    closeArmSpawnJournalStores();
    const reopened = new EvidenceLedgerStore({ dbPath });
    expect(reopened.init().ok).toBe(true);
    expect(reopened.queryArmSpawnSessions({ status: 'active' })).toHaveLength(1);
    expect(reopened.queryEvents({ type: 'arm.spawn.started' })).toEqual([
      expect.objectContaining({
        type: 'arm.spawn.started',
        payload: expect.objectContaining({
          durableAddress: 'arm://build-1a-qa/0123456789abcdef/trustquote-qa/dev-qa',
          spawnLeaseId: 'lease-1',
        }),
      }),
    ]);
    reopened.close();
  });

  test('refuses malformed or non-live acknowledgments without leaving a session row', () => {
    const notLive = startedInput({
      input: { terminal: {
        paneId: 'trustquote-dev-qa',
        pid: 4321,
        alive: false,
        durableAddress: 'arm://build-1a-qa/0123456789abcdef/trustquote-qa/dev-qa',
        spawnLeaseId: 'lease-1',
      } },
    });
    const result = recordArmSpawnStarted(notLive, { dbPath, nowMs: 1_000 });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'invalid',
      reason: 'live_terminal_required',
    }));
    expect(queryArmSpawnSessions({}, { dbPath })).toEqual([]);
  });

  test('chains a post-restart generation and retires the old active row atomically', () => {
    expect(recordArmSpawnStarted(startedInput({
      mainSessionId: 'app-session-qa-1',
      spawnLeaseId: 'lease-1',
      atMs: 1_000,
    }), { dbPath, nowMs: 1_000 }).ok).toBe(true);

    const replacement = recordArmSpawnStarted(startedInput({
      mainSessionId: 'app-session-qa-2',
      spawnLeaseId: 'lease-2',
      pid: 4322,
      sourceMessageId: 'ping-2',
      atMs: 2_000,
    }), { dbPath, nowMs: 2_000 });

    expect(replacement).toEqual(expect.objectContaining({
      ok: true,
      session: expect.objectContaining({
        spawnLeaseId: 'lease-2',
        previousSpawnLeaseId: 'lease-1',
        status: 'active',
      }),
    }));
    expect(queryArmSpawnSessions({ order: 'asc' }, { dbPath })).toEqual([
      expect.objectContaining({
        spawnLeaseId: 'lease-1',
        status: 'released',
        lastLifecycleEvent: 'arm.spawn.released',
      }),
      expect.objectContaining({
        spawnLeaseId: 'lease-2',
        previousSpawnLeaseId: 'lease-1',
        status: 'active',
      }),
    ]);
  });

  test('journals process exit and releases the exact generation', () => {
    const started = recordArmSpawnStarted(startedInput(), { dbPath, nowMs: 1_000 });
    const released = recordArmSpawnLifecycle({
      receipt: {
        eventClass: 'arm.spawn.released',
        status: 'released',
        reason: 'process_exit',
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
        durableAddress: started.session.durableAddress,
        spawnLeaseId: 'lease-1',
        paneId: 'trustquote-dev-qa',
        pid: 4321,
        owner: 'terminal-daemon',
        recoveryEvent: 'pty_exit',
        atMs: 2_000,
      },
    }, { dbPath, nowMs: 2_000 });

    expect(released).toEqual(expect.objectContaining({
      ok: true,
      status: 'released',
      session: expect.objectContaining({
        status: 'released',
        endedAtMs: 2_000,
        lastLifecycleEvent: 'arm.spawn.released',
      }),
    }));
    const store = new EvidenceLedgerStore({ dbPath });
    expect(store.init().ok).toBe(true);
    expect(store.queryEvents({ type: 'arm.spawn.released' })).toHaveLength(1);
    store.close();
  });

  test('accepts liveness only from the correlated own-pane comms row', () => {
    const started = recordArmSpawnStarted(startedInput(), { dbPath, nowMs: 1_000 });
    const store = new EvidenceLedgerStore({ dbPath });
    expect(store.init().ok).toBe(true);
    expect(store.upsertCommsJournal({
      messageId: 'hm-qa-pong-1',
      sessionId: 'app-session-qa-1',
      senderRole: 'trustquote-dev-qa',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: 2_000,
      brokeredAtMs: 2_001,
      rawBody: `(TRUSTQUOTE DEV QA #1): [SQUIDRUN_ARM_LIVENESS_PONG] ${JSON.stringify({
        schema: 'squidrun.arm_liveness_pong.v0',
        sourceMessageId: 'ping-1',
        responseClass: 'arm.liveness.pong',
        durableAddress: started.session.durableAddress,
        spawnLeaseId: 'lease-1',
        paneId: 'trustquote-dev-qa',
      })}`,
      status: 'routed',
      metadata: {
        sender: { role: 'trustquote-dev-qa', pane_id: 'trustquote-dev-qa' },
      },
    }, { nowMs: 2_001 }).ok).toBe(true);
    store.close();

    const proved = recordArmSpawnLivenessProof({
      durableAddress: started.session.durableAddress,
      spawnLeaseId: 'lease-1',
      messageId: 'hm-qa-pong-1',
    }, { dbPath, nowMs: 2_002 });

    expect(proved).toEqual(expect.objectContaining({
      ok: true,
      status: 'proved',
      comms: expect.objectContaining({ messageId: 'hm-qa-pong-1', status: 'routed' }),
      session: expect.objectContaining({
        livenessMessageId: 'hm-qa-pong-1',
        livenessRowId: expect.any(Number),
        livenessAtMs: 2_001,
        livenessReceipt: expect.objectContaining({
          sourceMessageId: 'ping-1',
          expectedResponseClass: 'arm.liveness.pong',
          durableAddress: started.session.durableAddress,
          spawnLeaseId: 'lease-1',
        }),
      }),
    }));
  });

  test('rejects a routed reply whose response class does not match the spawn obligation', () => {
    const started = recordArmSpawnStarted(startedInput(), { dbPath, nowMs: 1_000 });
    const store = new EvidenceLedgerStore({ dbPath });
    expect(store.init().ok).toBe(true);
    expect(store.upsertCommsJournal({
      messageId: 'hm-qa-wrong-class',
      senderRole: 'trustquote-dev-qa',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: 2_000,
      brokeredAtMs: 2_001,
      rawBody: '(TRUSTQUOTE DEV QA #1): online',
      status: 'routed',
      metadata: {
        sender: { role: 'trustquote-dev-qa', pane_id: 'trustquote-dev-qa' },
        armLiveness: {
          schema: 'squidrun.arm_liveness_pong.v0',
          sourceMessageId: 'ping-1',
          responseClass: 'arm.startup.receipt',
          durableAddress: started.session.durableAddress,
          spawnLeaseId: 'lease-1',
          paneId: 'trustquote-dev-qa',
        },
      },
    }, { nowMs: 2_001 }).ok).toBe(true);
    store.close();

    expect(recordArmSpawnLivenessProof({
      durableAddress: started.session.durableAddress,
      spawnLeaseId: 'lease-1',
      messageId: 'hm-qa-wrong-class',
    }, { dbPath, nowMs: 2_002 })).toEqual(expect.objectContaining({
      ok: false,
      status: 'rejected',
      reason: 'liveness_response_class_mismatch',
    }));
    expect(queryArmSpawnSessions({ status: 'active' }, { dbPath })[0].livenessMessageId).toBeNull();
  });
});
