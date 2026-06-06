const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  upsertArmRegistryManifest,
  recordArmCheckinProof,
  queryArmMissingWatchdogs,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');
const {
  tickMissingArmWatchdog,
} = require('../modules/main/missing-arm-watchdog');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

function oneArmManifest(overrides = {}) {
  return {
    appRoomId: 'trustquote',
    sessionId: 'app-session-406:trustquote',
    mainSessionId: 'app-session-406',
    leadRole: 'trustquote-lead',
    leadPaneId: 'trustquote-lead',
    routeTarget: 'trustquote',
    arms: [
      {
        armKey: 'money-documents',
        role: 'trustquote-billing',
        paneId: 'trustquote-billing',
        routeTarget: 'trustquote-billing',
        armKind: 'domain',
        displayName: 'Money + Documents',
        dataSources: ['jobs', 'quotes', 'payments'],
        permissions: { read: ['money_records'], draft: ['invoice'] },
        checkInObligation: { required: true },
      },
    ],
    ...overrides,
  };
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('missing arm watchdog', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-arm-watchdog-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
  });

  afterEach(() => {
    closeArmRegistryStores();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('persists expected and nudge stages without duplicate nudge after reload', () => {
    expect(upsertArmRegistryManifest(oneArmManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);

    const expected = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 1_000 });
    expect(expected.ok).toBe(true);
    expect(expected.actions).toEqual([]);
    expect(expected.watchdogs[0]).toEqual(expect.objectContaining({
      status: 'expected',
      expectedAtMs: 1000,
      nudgeDueAtMs: 121000,
    }));

    closeArmRegistryStores();
    const nudged = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 121_000 });
    expect(nudged.actions).toEqual([
      expect.objectContaining({
        kind: 'nudge',
        armKey: 'money-documents',
        nextDueAtMs: 361000,
      }),
    ]);
    expect(nudged.watchdogs[0]).toEqual(expect.objectContaining({
      status: 'nudged',
      nudgedAtMs: 121000,
      escalateDueAtMs: 361000,
    }));

    closeArmRegistryStores();
    const duplicate = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 121_000 });
    expect(duplicate.actions).toEqual([]);
    expect(duplicate.watchdogs[0].status).toBe('nudged');
  });

  test('escalates once through injected architect sender after the wait window', () => {
    expect(upsertArmRegistryManifest(oneArmManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    expect(tickMissingArmWatchdog({ appRoomId: 'trustquote', sessionId: 'app-session-406:trustquote' }, {
      dbPath,
      nowMs: 1_000,
    }).ok).toBe(true);
    expect(tickMissingArmWatchdog({ appRoomId: 'trustquote', sessionId: 'app-session-406:trustquote' }, {
      dbPath,
      nowMs: 121_000,
    }).actions).toHaveLength(1);

    const sends = [];
    const escalated = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, {
      dbPath,
      nowMs: 361_000,
      sendEscalation: (action, result) => {
        sends.push({ action, result });
        return { ok: true, status: 0, message: `sent:${action.armKey}` };
      },
    });

    expect(escalated.actions).toEqual([
      expect.objectContaining({
        kind: 'escalate',
        target: 'architect',
        armKey: 'money-documents',
      }),
    ]);
    expect(escalated.dispatches).toEqual([
      expect.objectContaining({
        ok: true,
        target: 'architect',
        message: 'sent:money-documents',
      }),
    ]);
    expect(sends).toHaveLength(1);
    expect(queryArmMissingWatchdogs({ status: 'escalated' }, { dbPath })).toHaveLength(1);

    const duplicate = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, {
      dbPath,
      nowMs: 500_000,
      sendEscalation: () => {
        throw new Error('duplicate escalation should not dispatch');
      },
    });
    expect(duplicate.actions).toEqual([]);
    expect(duplicate.dispatches).toEqual([]);
  });

  test('satisfies a nudged watchdog when a valid check-in arrives before escalation', () => {
    expect(upsertArmRegistryManifest(oneArmManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    tickMissingArmWatchdog({ appRoomId: 'trustquote', sessionId: 'app-session-406:trustquote' }, {
      dbPath,
      nowMs: 1_000,
    });
    tickMissingArmWatchdog({ appRoomId: 'trustquote', sessionId: 'app-session-406:trustquote' }, {
      dbPath,
      nowMs: 121_000,
    });

    const checkin = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'money-documents',
      role: 'trustquote-billing',
      paneId: 'trustquote-billing',
      proofKind: 'startup_check_in',
      messageId: 'hm-billing-1',
      env: {
        SQUIDRUN_ROLE: 'trustquote-billing',
        SQUIDRUN_PANE_ID: 'trustquote-billing',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 200_000 });
    expect(checkin.ok).toBe(true);

    const afterCheckin = tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, {
      dbPath,
      nowMs: 361_000,
      sendEscalation: () => {
        throw new Error('satisfied arm should not escalate');
      },
    });
    expect(afterCheckin.actions).toEqual([]);
    expect(queryArmMissingWatchdogs({ status: 'satisfied' }, { dbPath })).toHaveLength(1);
  });
});
