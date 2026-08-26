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
      `${arm.paneId} ExampleApp arm body baseline tail ${terminalSuffix}`,
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
    expect(result.checks.find((entry) => entry.id === 'exampleapp_arm_startup_receipts').status).toBe('PASS');
  });

  it('fails when a required ExampleApp arm startup receipt has the wrong cwd', () => {
    const before = buildBaselineSnapshot(evidence({ session: 416 }));
    const after = evidence({
      session: 417,
      started: '2026-06-08T23:00:00.000Z',
      windowReason: 'startup_restore',
      windowUpdatedAt: '2026-06-08T23:00:04.000Z',
      receiptOverrides: {
        'exampleapp-lead': { cwd: 'D:/projects/squidrun' },
      },
    });

    const result = verifyRestartSurvival(after, before);
    const receiptCheck = result.checks.find((entry) => entry.id === 'exampleapp_arm_startup_receipts');

    expect(result.status).toBe('FAIL');
    expect(receiptCheck.status).toBe('FAIL');
    expect(receiptCheck.evidence.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ paneId: 'exampleapp-lead', field: 'cwd' }),
    ]));
  });

  it('parses semicolon and prose startup receipt env tokens', () => {
    const sessionScope = 'app-session-417:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 200,
        rawBody: [
          'Live env proof: SQUIDRUN_ROLE=exampleapp-schedule-dispatch; SQUIDRUN_PANE_ID=exampleapp-schedule-dispatch;',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-417:squid-room; SQUIDRUN_WINDOW_KEY=squid-room. Main app-status follows.',
          'cwd=D:/projects/ExampleApp. Standing by.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['exampleapp-schedule-dispatch']).toEqual(expect.objectContaining({
      role: 'exampleapp-schedule-dispatch',
      paneId: 'exampleapp-schedule-dispatch',
      sessionScope,
      windowKey: 'squid-room',
      cwd: 'D:/projects/ExampleApp',
    }));
  });

  it('parses ExampleApp cwd when startup prose says online in the project path', () => {
    const sessionScope = 'app-session-417:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 201,
        rawBody: [
          '(EXAMPLEAPP APP #1): ExampleApp App pane online in D:\\projects\\ExampleApp.',
          'Env binding: SQUIDRUN_ROLE=exampleapp-app, SQUIDRUN_PANE_ID=exampleapp-app,',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-417:squid-room, SQUIDRUN_PROFILE=main.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['exampleapp-app']).toEqual(expect.objectContaining({
      role: 'exampleapp-app',
      paneId: 'exampleapp-app',
      sessionScope,
      cwd: 'D:\\projects\\ExampleApp',
    }));
  });

  it('parses live ExampleApp arm receipts from comms metadata and Pane/env binding prose', () => {
    const sessionScope = 'app-session-418:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 68833,
        sessionId: sessionScope,
        sender: 'exampleapp-app',
        status: 'routed',
        rawBody: [
          '(EXAMPLEAPP APP STARTUP RECEIPT): ExampleApp App online in D:\\projects\\ExampleApp.',
          'Pane/env binding: role=exampleapp-app, pane=exampleapp-app,',
          'session=app-session-418:squid-room, window=squid-room.',
        ].join(' '),
      },
      {
        rowId: 68838,
        sessionId: sessionScope,
        senderRole: 'exampleapp-schedule-dispatch',
        status: 'routed',
        metadata: {
          project: {
            name: 'ExampleApp',
            path: 'D:\\projects\\ExampleApp',
            session_id: sessionScope,
          },
          sender: { role: 'exampleapp-schedule-dispatch' },
          session_id: sessionScope,
        },
        rawBody: [
          '[EXAMPLEAPP SCHEDULE DISPATCH STARTUP CORRECTION / S418]',
          'Live env proof: SQUIDRUN_ROLE=exampleapp-schedule-dispatch;',
          'SQUIDRUN_PANE_ID=exampleapp-schedule-dispatch;',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-418:squid-room;',
          'SQUIDRUN_PROFILE=main.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['exampleapp-app']).toEqual(expect.objectContaining({
      rowId: 68833,
      sender: 'exampleapp-app',
      role: 'exampleapp-app',
      paneId: 'exampleapp-app',
      sessionScope,
      windowKey: 'squid-room',
      cwd: 'D:\\projects\\ExampleApp',
      status: 'routed',
    }));
    expect(receipts['exampleapp-schedule-dispatch']).toEqual(expect.objectContaining({
      rowId: 68838,
      sender: 'exampleapp-schedule-dispatch',
      role: 'exampleapp-schedule-dispatch',
      paneId: 'exampleapp-schedule-dispatch',
      sessionScope,
      cwd: 'D:\\projects\\ExampleApp',
      status: 'routed',
    }));
  });

  it('accepts routed comms-row identity metadata as primary startup receipt proof', () => {
    const sessionScope = 'app-session-418:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 68839,
        status: 'routed',
        metadata_json: JSON.stringify({
          session_id: sessionScope,
          sender: { role: 'exampleapp-invoice' },
          project: { name: 'ExampleApp', path: 'D:\\projects\\ExampleApp' },
        }),
        rawBody: 'ExampleApp invoice arm online. Ready for routed assignment.',
      },
    ], { sessionScope });

    expect(receipts['exampleapp-invoice']).toEqual(expect.objectContaining({
      rowId: 68839,
      sender: 'exampleapp-invoice',
      role: 'exampleapp-invoice',
      paneId: 'exampleapp-invoice',
      sessionScope,
      cwd: 'D:\\projects\\ExampleApp',
      status: 'routed',
    }));
  });

  it('rejects prior-session and sessionless routed arm rows when proving current receipts', () => {
    const sessionScope = 'app-session-418:squid-room';
    const receipts = parseArmReceipts([
      {
        rowId: 68830,
        sessionId: 'app-session-417:squid-room',
        senderRole: 'exampleapp-app',
        status: 'routed',
        metadata: {
          sender: { role: 'exampleapp-app' },
          project: { path: 'D:\\projects\\ExampleApp' },
        },
        rawBody: 'ExampleApp app historical routed receipt with plausible cwd.',
      },
      {
        rowId: 68831,
        senderRole: 'exampleapp-invoice',
        status: 'routed',
        metadata: {
          sender: { role: 'exampleapp-invoice' },
          project: { path: 'D:\\projects\\ExampleApp' },
        },
        rawBody: 'ExampleApp invoice routed receipt missing session.',
      },
      {
        rowId: 68832,
        sessionId: 'app-session-417:squid-room',
        senderRole: 'exampleapp-schedule-dispatch',
        status: 'routed',
        rawBody: [
          'Live env proof: SQUIDRUN_ROLE=exampleapp-schedule-dispatch;',
          'SQUIDRUN_PANE_ID=exampleapp-schedule-dispatch;',
          'SQUIDRUN_SESSION_SCOPE_ID=app-session-417:squid-room;',
          'SQUIDRUN_WORKING_DIR=D:/projects/ExampleApp.',
        ].join(' '),
      },
    ], { sessionScope });

    expect(receipts['exampleapp-app']).toBeUndefined();
    expect(receipts['exampleapp-invoice']).toBeUndefined();
    expect(receipts['exampleapp-schedule-dispatch']).toBeUndefined();
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
