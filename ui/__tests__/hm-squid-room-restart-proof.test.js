/* global describe, expect, it, jest */

jest.mock('../modules/main/arm-state-projection', () => ({
  buildArmStateProjection: jest.fn(),
}));

const {
  REQUIRED_ARMS,
  REQUIRED_PANES,
  buildBaselineSnapshot,
  parseArmReceipts,
  summarizeSessionState,
  verifyRestartSurvival,
} = require('../scripts/hm-squid-room-restart-proof');
const {
  buildRestartScrollbackSnapshot,
  hydrateTerminalFromRestartSnapshot,
} = require('../modules/terminal-restart-scrollback-store');

const ALL_READY = [...REQUIRED_PANES];

function terminal(paneId, text, cwd = 'D:/projects/squidrun') {
  return {
    paneId,
    cwd,
    alive: true,
    scrollback: [text],
    lastActivity: 1000,
    lastInputTime: 900,
  };
}

function armReceiptRows(sessionScope, overrides = {}) {
  return REQUIRED_ARMS.map((arm, index) => {
    const override = overrides[arm.paneId] || {};
    const cwd = override.cwd || arm.cwd;
    const role = override.role || arm.role;
    const paneId = override.paneId || arm.paneId;
    return {
      rowId: 100 + index,
      scope: 'squid-room',
      rawBody: [
        `SQUIDRUN_ROLE=${role}`,
        `SQUIDRUN_PANE_ID=${paneId}`,
        `SQUIDRUN_SESSION_SCOPE_ID=${sessionScope}`,
        'SQUIDRUN_WINDOW_KEY=squid-room',
        `SQUIDRUN_WORKING_DIR=${cwd}`,
      ].join('\n'),
    };
  });
}

function armProjection() {
  return {
    ok: true,
    status: 'ready',
    desiredCount: 4,
    readyCount: 4,
    registryArms: REQUIRED_ARMS.map((arm) => ({ paneId: arm.paneId, role: arm.role })),
  };
}

function eventRates(overrides = {}) {
  return {
    sinceMs: 1,
    nowMs: 31000,
    elapsedSec: 30,
    trailingWindowSec: 30,
    panes: Object.fromEntries(REQUIRED_PANES.map((paneId) => [
      paneId,
      {
        daemonResizePerSec: overrides[paneId]?.daemonResizePerSec || 0,
        daemonResizeTrailingPerSec: overrides[paneId]?.daemonResizeTrailingPerSec || 0,
        daemonCounts: {},
        busCounts: {},
      },
    ])),
  };
}

function evidence({
  session = 416,
  started = '2026-06-08T22:26:06.425Z',
  windowReason = 'open_app_window',
  windowUpdatedAt = '2026-06-08T22:26:10.000Z',
  readyPanes = ALL_READY,
  terminalSuffix = '',
  terminalOverrides = {},
  receiptOverrides = {},
  rateOverrides = {},
  currentLane = {
    status: 'active',
    activeLane: { id: 'test-active-lane' },
    activeLanePresent: true,
    objective: 'prove restart continuity',
  },
} = {}) {
  const sessionScope = `app-session-${session}:squid-room`;
  const terminals = [
    terminal('1', `architect body ${terminalSuffix}`),
    terminal('2', `builder body baseline tail ${terminalSuffix}`),
    terminal('3', `oracle body baseline tail ${terminalSuffix}`),
    ...REQUIRED_ARMS.map((arm) => terminal(
      arm.paneId,
      `${arm.paneId} TrustQuote arm body baseline tail ${terminalSuffix}`,
      arm.cwd,
    )),
  ];

  for (const [paneId, override] of Object.entries(terminalOverrides)) {
    const index = terminals.findIndex((entry) => entry.paneId === paneId);
    if (index >= 0) {
      terminals[index] = { ...terminals[index], ...override };
    }
  }

  const rows = armReceiptRows(sessionScope, receiptOverrides);
  return {
    generatedAt: '2026-06-08T23:00:00.000Z',
    gitHead: 'testhead',
    paths: {},
    appStatus: {
      session,
      started,
      readyPanes,
      paneHost: {
        degraded: false,
        hiddenModeEnabled: true,
      },
    },
    windowState: {
      windowKey: 'squid-room',
      open: true,
      reason: windowReason,
      updatedAt: windowUpdatedAt,
      sessionScopeId: sessionScope,
    },
    sessionScope,
    terminalSummary: summarizeSessionState({ terminals }),
    armProjection: armProjection(),
    commsRows: rows,
    armReceipts: parseArmReceipts(rows, { sessionScope }),
    eventRates: eventRates(rateOverrides),
    currentLane,
  };
}

describe('hm-squid-room-restart-proof', () => {
  it('passes when restart advances session, restores squid-room, preserves bodies, and binds arms', () => {
    const before = evidence({ session: 416 });
    const baseline = buildBaselineSnapshot(before);
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      terminalSuffix: 'plus post restart output',
    });

    const result = verifyRestartSurvival(after, baseline);

    expect(result.status).toBe('PASS');
    expect(result.checks.find((entry) => entry.id === 'squid_room_window_restore').status).toBe('PASS');
    expect(result.checks.find((entry) => entry.id === 'trustquote_arm_startup_receipts').status).toBe('PASS');
  });

  it('fails when a required TrustQuote arm startup receipt has the wrong cwd', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      receiptOverrides: {
        'trustquote-lead': { cwd: 'D:/projects/squidrun' },
      },
    });

    const result = verifyRestartSurvival(after, before);
    const receiptCheck = result.checks.find((entry) => entry.id === 'trustquote_arm_startup_receipts');

    expect(result.status).toBe('FAIL');
    expect(receiptCheck.status).toBe('FAIL');
    expect(receiptCheck.evidence.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ paneId: 'trustquote-lead', field: 'cwd' }),
    ]));
  });

  it('parses semicolon and prose startup receipt env tokens', () => {
    const sessionScope = 'app-session-417:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 200,
        rawBody: [
          'Live env proof: SQUIDRUN_ROLE=trustquote-schedule-dispatch; SQUIDRUN_PANE_ID=trustquote-schedule-dispatch;',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-417:squid-room; SQUIDRUN_WINDOW_KEY=squid-room. Main app-status follows.',
          'cwd=D:/projects/TrustQuote. Standing by.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['trustquote-schedule-dispatch']).toEqual(expect.objectContaining({
      role: 'trustquote-schedule-dispatch',
      paneId: 'trustquote-schedule-dispatch',
      sessionScope,
      windowKey: 'squid-room',
      cwd: 'D:/projects/TrustQuote',
    }));
  });

  it('parses TrustQuote cwd when startup prose says online in the project path', () => {
    const sessionScope = 'app-session-417:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 201,
        rawBody: [
          '(TRUSTQUOTE APP #1): TrustQuote App pane online in D:\\projects\\TrustQuote.',
          'Env binding: SQUIDRUN_ROLE=trustquote-app, SQUIDRUN_PANE_ID=trustquote-app,',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-417:squid-room, SQUIDRUN_PROFILE=main.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['trustquote-app']).toEqual(expect.objectContaining({
      role: 'trustquote-app',
      paneId: 'trustquote-app',
      sessionScope,
      cwd: 'D:\\projects\\TrustQuote',
    }));
  });

  it('fails when baseline does not prove active mid-work', () => {
    const before = buildBaselineSnapshot(evidence({
      session: 416,
      currentLane: {
        status: 'none',
        activeLane: null,
        activeLanePresent: false,
        objective: null,
      },
    }));
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
    });

    const result = verifyRestartSurvival(after, before);
    const dropCheck = result.checks.find((entry) => entry.id === 'in_progress_not_silently_dropped');

    expect(result.status).toBe('FAIL');
    expect(dropCheck.status).toBe('FAIL');
    expect(dropCheck.why).toContain('active current lane');
  });

  it('passes when a mid-work baseline tail is restored somewhere in the post-restart body', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));

    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      terminalSuffix: 'fresh post restart output',
      terminalOverrides: {
        2: {
          scrollback: ['builder body baseline tail\nfresh Builder startup body after respawn'],
        },
      },
    });

    const result = verifyRestartSurvival(after, before);
    const dropCheck = result.checks.find((entry) => entry.id === 'in_progress_not_silently_dropped');

    expect(dropCheck.status).toBe('PASS');
    expect(result.status).toBe('PASS');
  });

  it('proves restart scrollback hydration without a full restart', () => {
    const before = evidence({ session: 416 });
    const baseline = buildBaselineSnapshot(before);
    const preservedPane = {
      paneId: '2',
      cwd: 'D:/projects/squidrun',
      scrollback: before.terminalSummary.panes['2'].bodyText,
      scrollbackMaxSize: 50000,
    };
    const snapshot = buildRestartScrollbackSnapshot([preservedPane]);
    const respawnedPane = {
      paneId: '2',
      cwd: 'D:/projects/squidrun',
      alive: true,
      scrollback: 'fresh prompt after respawn',
      scrollbackMaxSize: 50000,
      lastActivity: 2000,
      lastInputTime: 1900,
    };

    hydrateTerminalFromRestartSnapshot(respawnedPane, snapshot);

    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      terminalOverrides: {
        2: respawnedPane,
      },
    });

    const result = verifyRestartSurvival(after, baseline);
    const dropCheck = result.checks.find((entry) => entry.id === 'in_progress_not_silently_dropped');

    expect(respawnedPane.restartScrollbackHydrated).toBe(true);
    expect(dropCheck.status).toBe('PASS');
    expect(result.status).toBe('PASS');
  });

  it('fails when a baseline pane body disappears across restart', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      terminalOverrides: {
        2: {
          scrollback: ['new tiny'],
        },
      },
    });

    const result = verifyRestartSurvival(after, before);
    const dropCheck = result.checks.find((entry) => entry.id === 'in_progress_not_silently_dropped');

    expect(result.status).toBe('FAIL');
    expect(dropCheck.status).toBe('FAIL');
    expect(dropCheck.evidence.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ paneId: '2' }),
    ]));
  });

  it('fails when trailing resize rates are not steady-state', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      rateOverrides: {
        3: { daemonResizeTrailingPerSec: 2.4 },
      },
    });

    const result = verifyRestartSurvival(after, before);
    const rateCheck = result.checks.find((entry) => entry.id === 'steady_state_event_rates');

    expect(result.status).toBe('FAIL');
    expect(rateCheck.status).toBe('FAIL');
    expect(rateCheck.evidence.offenders).toEqual(expect.arrayContaining([
      expect.objectContaining({ paneId: '3', resizeRate: 2.4 }),
    ]));
  });

  it('classifies same-session verification as a hard failure unless explicitly allowed', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));
    const after = evidence({ session: 416 });

    const result = verifyRestartSurvival(after, before);
    const sessionCheck = result.checks.find((entry) => entry.id === 'session_bump');

    expect(result.status).toBe('FAIL');
    expect(sessionCheck.status).toBe('FAIL');

    const dryRun = verifyRestartSurvival(after, before, { allowSameSession: true });
    expect(dryRun.checks.find((entry) => entry.id === 'session_bump').status).toBe('WARN');
  });
});
