jest.mock('../scripts/hm-agent-alert', () => ({
  sendAgentAlert: jest.fn(() => ({
    ok: true,
    targets: ['oracle'],
    results: [{ target: 'oracle', ok: true }],
  })),
}));

jest.mock('../modules/main/comms-journal', () => ({
  queryCommsJournalEntries: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const { buildOracleWakeMessage } = require('../scripts/hm-oracle-wake-context');
const { runWakeCycle } = require('../scripts/hm-oracle-wake-watchdog');
const {
  buildRunnerStatusSnapshot,
  hasPendingTeamWork,
  runHeartbeatCycle,
  summarizeHeartbeatResult,
} = require('../scripts/hm-bidirectional-wake-watchdog');

describe('oracle wake watchdog context', () => {
  let tempDir;
  let watchRulesPath;
  let watchStatePath;
  let marketScannerStatePath;
  let oracleWakeStatePath;
  let bidirectionalStatePath;
  let activeLanePath;
  let idleLanePath;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-wake-watchdogs-'));
    watchRulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    marketScannerStatePath = path.join(tempDir, 'market-scanner-state.json');
    oracleWakeStatePath = path.join(tempDir, 'oracle-wake-state.json');
    bidirectionalStatePath = path.join(tempDir, 'bidirectional-wake-state.json');

    // Active-window peer-wake pokes only fire when there is open team work.
    activeLanePath = path.join(tempDir, 'current-lane-active.json');
    fs.writeFileSync(activeLanePath, JSON.stringify({
      version: 1,
      status: 'active',
      activeLane: { id: 'lane-bug-b' },
      activeLaneCount: 1,
    }, null, 2));
    idleLanePath = path.join(tempDir, 'current-lane-idle.json');
    fs.writeFileSync(idleLanePath, JSON.stringify({
      version: 1,
      status: 'none',
      activeLane: null,
      activeLaneCount: 0,
      continuity: { next_action: null },
    }, null, 2));

    fs.writeFileSync(watchRulesPath, JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'btc-short-lose-75300-fail-retest',
          ticker: 'BTC/USD',
          trigger: 'lose_fail_retest',
          enabled: true,
          loseLevel: 75300,
          retestMin: 75300,
          retestMax: 75380,
        },
      ],
    }, null, 2));

    fs.writeFileSync(watchStatePath, JSON.stringify({
      version: 3,
      marketByTicker: {
        'BTC/USD': {
          price: 76500,
          checkedAt: '2026-04-19T05:18:28.280Z',
        },
      },
      rules: {},
    }, null, 2));

    fs.writeFileSync(marketScannerStatePath, JSON.stringify({
      // lastScanAt makes the scan "live" so cached movers are surfaced (the
      // 500f4887 stale-mover gate suppresses movers without a fresh lastScanAt).
      // Real-now keeps the scan fresh for real-timer tests, and is in the future
      // relative to the past timestamps the bidirectional tests mock, so its
      // age is non-positive and never reads as stale.
      lastScanAt: new Date().toISOString(),
      assets: [
        { coin: 'ZRO', ticker: 'ZRO/USD', price: 2.5, volumeUsd24h: 33355078.51, change24hPct: 0.117 },
      ],
      lastResult: {
        topMovers: [
          { coin: 'ORDI', ticker: 'ORDI/USD', price: 3.8765, change24hPct: -0.3297 },
          { coin: 'TST', ticker: 'TST/USD', price: 0.011186, change24hPct: -0.2661 },
        ],
      },
    }, null, 2));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('wake watchdog scripts load before a wake check runs', () => {
    expect(() => require('../scripts/hm-oracle-wake-watchdog')).not.toThrow();
    expect(() => require('../scripts/hm-bidirectional-wake-watchdog')).not.toThrow();
  });

  test('buildOracleWakeMessage inlines cached movers and stale-rule context', async () => {
    const message = await buildOracleWakeMessage('wake base', {
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
    });

    expect(message).toContain('wake base');
    expect(message).toContain('unlocks24h=none');
    expect(message).toContain('topMovers=ORDI/USD -33.0% @ 3.8765; TST/USD -26.6% @ 0.011186');
    expect(message).toContain('staleRules=BTC/USD 75300.00-75380.00 vs 76500.00');
  });

  test('oracle wake watchdog sends the injected context to Oracle', async () => {
    const result = await runWakeCycle({
      statePath: oracleWakeStatePath,
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
    });

    expect(result.ok).toBe(true);
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('topMovers=ORDI/USD -33.0% @ 3.8765'),
      expect.objectContaining({
        targets: ['oracle'],
        role: 'oracle-wake-watchdog',
      })
    );
    const persistedState = JSON.parse(fs.readFileSync(oracleWakeStatePath, 'utf8'));
    expect(persistedState.lastMessage).toContain('staleRules=BTC/USD 75300.00-75380.00 vs 76500.00');
  });

  test('bidirectional wake watchdog injects the same context into Oracle repokes', async () => {
    // 13:20Z = 06:20 America/Los_Angeles — inside an active window so the
    // peer-wake poke is not suppressed by the off-hours gate.
    const nowMs = Date.parse('2026-04-19T13:20:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    queryCommsJournalEntries.mockImplementation(({ senderRole, targetRole, direction }) => {
      if (senderRole === 'architect' && targetRole === 'oracle' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (2 * 60 * 1000) }];
      }
      if (senderRole === 'oracle' && targetRole === 'architect' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (20 * 60 * 1000) }];
      }
      return [];
    });

    const result = await runHeartbeatCycle({
      statePath: bidirectionalStatePath,
      currentLanePath: activeLanePath,
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
      oracleSilenceMs: 10 * 60 * 1000,
      architectSilenceMs: 8 * 60 * 1000,
      agentPaneAutoRecovery: false,
    });

    expect(result.ok).toBe(true);
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('(ARCHITECT PEER-WAKE): Oracle silent >10m. Status check now.'),
      expect.objectContaining({
        targets: ['oracle'],
        role: 'architect-peer-wake',
      })
    );
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('topMovers=ORDI/USD -33.0% @ 3.8765'),
      expect.any(Object)
    );
  });

  test('bidirectional wake watchdog suppresses BOTH peer-wake nags outside the active window', async () => {
    // 05:20Z = 22:20 America/Los_Angeles — off-hours. Intentional silence is
    // expected; neither peer should nag the other for it. Crash/dead-pane
    // detection (agentPaneAutoRecovery) is a separate path and is not gated.
    const nowMs = Date.parse('2026-04-19T05:20:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    queryCommsJournalEntries.mockImplementation(({ senderRole, targetRole, direction }) => {
      // Both peers are well past their silence thresholds...
      if (senderRole === 'architect' && targetRole === 'oracle' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (30 * 60 * 1000) }];
      }
      if (senderRole === 'oracle' && targetRole === 'architect' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (30 * 60 * 1000) }];
      }
      return [];
    });

    const result = await runHeartbeatCycle({
      statePath: bidirectionalStatePath,
      currentLanePath: activeLanePath,
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
      oracleSilenceMs: 10 * 60 * 1000,
      architectSilenceMs: 8 * 60 * 1000,
      agentPaneAutoRecovery: false,
    });

    expect(result.ok).toBe(true);
    // ...yet no peer-wake nag is emitted in either direction off-hours.
    expect(sendAgentAlert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ role: 'architect-peer-wake' })
    );
    expect(sendAgentAlert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ role: 'oracle-peer-wake' })
    );
    expect(result.alerts).toEqual([]);
  });

  test('active-window peer-wake is suppressed when there is no open team lane', async () => {
    // 13:20Z = 06:20 PT (active window), both peers past their silence
    // thresholds — but the current lane is idle-by-design (status none, no
    // active lane), so the "finished + idle" state must not be poked.
    const nowMs = Date.parse('2026-04-19T13:20:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    queryCommsJournalEntries.mockImplementation(({ senderRole, targetRole, direction }) => {
      if (senderRole === 'architect' && targetRole === 'oracle' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (30 * 60 * 1000) }];
      }
      if (senderRole === 'oracle' && targetRole === 'architect' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (30 * 60 * 1000) }];
      }
      return [];
    });

    const result = await runHeartbeatCycle({
      statePath: bidirectionalStatePath,
      currentLanePath: idleLanePath,
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
      oracleSilenceMs: 10 * 60 * 1000,
      architectSilenceMs: 8 * 60 * 1000,
      agentPaneAutoRecovery: false,
    });

    expect(result.ok).toBe(true);
    expect(sendAgentAlert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ role: 'architect-peer-wake' })
    );
    expect(sendAgentAlert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ role: 'oracle-peer-wake' })
    );
    expect(result.alerts).toEqual([]);
  });

  test('hasPendingTeamWork reads the current-lane signal', () => {
    expect(hasPendingTeamWork(activeLanePath)).toBe(true);
    expect(hasPendingTeamWork(idleLanePath)).toBe(false);
    expect(hasPendingTeamWork(path.join(tempDir, 'does-not-exist.json'))).toBe(false);

    const nextActionPath = path.join(tempDir, 'current-lane-next-action.json');
    fs.writeFileSync(nextActionPath, JSON.stringify({
      status: 'none',
      activeLane: null,
      activeLaneCount: 0,
      continuity: { next_action: 'finish the scroll-probe re-proof' },
    }, null, 2));
    expect(hasPendingTeamWork(nextActionPath)).toBe(true);
  });

  test('bidirectional wake watchdog runner status requires a live fresh matching runner', () => {
    const nowMs = Date.parse('2026-04-19T05:40:00.000Z');
    const fresh = buildRunnerStatusSnapshot({
      pid: 1234,
      pidAlive: true,
      pidMtimeMs: nowMs - 60_000,
      statusFile: {
        pid: 1234,
        running: true,
        intervalMs: 60_000,
        heartbeatAt: new Date(nowMs - 30_000).toISOString(),
      },
      statusMtimeMs: nowMs - 30_000,
      nowMs,
    });
    expect(fresh.running).toBe(true);
    expect(fresh.reason).toBeNull();

    const stale = buildRunnerStatusSnapshot({
      pid: 1234,
      pidAlive: true,
      pidMtimeMs: nowMs - 10 * 60_000,
      statusFile: {
        pid: 1234,
        running: true,
        intervalMs: 60_000,
        heartbeatAt: new Date(nowMs - 4 * 60_000).toISOString(),
      },
      statusMtimeMs: nowMs - 4 * 60_000,
      nowMs,
    });
    expect(stale.running).toBe(false);
    expect(stale.staleHeartbeat).toBe(true);
    expect(stale.reason).toBe('stale_bidirectional_wake_watchdog_status');

    const mismatched = buildRunnerStatusSnapshot({
      pid: 1234,
      pidAlive: true,
      pidMtimeMs: nowMs - 60_000,
      statusFile: {
        pid: 5678,
        running: true,
        intervalMs: 60_000,
        heartbeatAt: new Date(nowMs - 30_000).toISOString(),
      },
      statusMtimeMs: nowMs - 30_000,
      nowMs,
    });
    expect(mismatched.running).toBe(false);
    expect(mismatched.unknownLivePid).toBe(1234);
    expect(mismatched.reason).toBe('unknown_live_bidirectional_wake_watchdog_pid');
  });

  test('buildRunnerStatusSnapshot flags a live runner from a prior generation as stale', () => {
    const nowMs = Date.parse('2026-04-19T05:40:00.000Z');
    const base = {
      pid: 1234,
      pidAlive: true,
      pidMtimeMs: nowMs - 60_000,
      statusMtimeMs: nowMs - 30_000,
      nowMs,
    };
    const liveStatus = (appGenerationId) => ({
      pid: 1234,
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date(nowMs - 30_000).toISOString(),
      ...(appGenerationId === undefined ? {} : { appGenerationId }),
    });

    // Same token -> healthy, leave it.
    const matched = buildRunnerStatusSnapshot({
      ...base,
      statusFile: liveStatus('gen-current'),
      currentGenerationId: 'gen-current',
    });
    expect(matched.running).toBe(true);
    expect(matched.staleGeneration).toBe(false);
    expect(matched.reason).toBeNull();

    // Prior token -> stale generation, must be reaped.
    const priorGen = buildRunnerStatusSnapshot({
      ...base,
      statusFile: liveStatus('gen-prior'),
      currentGenerationId: 'gen-current',
    });
    expect(priorGen.running).toBe(true);
    expect(priorGen.staleGeneration).toBe(true);
    expect(priorGen.reason).toBe('stale_bidirectional_wake_watchdog_generation');

    // Pre-fix orphan carrying no token, but a current generation is known -> stale.
    const noToken = buildRunnerStatusSnapshot({
      ...base,
      statusFile: liveStatus(undefined),
      currentGenerationId: 'gen-current',
    });
    expect(noToken.staleGeneration).toBe(true);

    // No current generation supplied (CLI/no-app path) -> never stale on token.
    const noContext = buildRunnerStatusSnapshot({
      ...base,
      statusFile: liveStatus('gen-prior'),
    });
    expect(noContext.running).toBe(true);
    expect(noContext.staleGeneration).toBe(false);
    expect(noContext.reason).toBeNull();
  });

  test('bidirectional wake watchdog runner summary keeps probe status compact', () => {
    const summary = summarizeHeartbeatResult({
      ok: true,
      statePath: 'state.json',
      state: { updatedAt: '2026-04-19T05:40:00.000Z' },
      alerts: [
        { target: 'oracle', result: { ok: true, stdout: 'verbose delivery output' } },
      ],
      agentPaneRecovery: {
        ok: true,
        status: 'actions_taken',
        actions: [
          { kind: 'restart', paneId: '3', role: 'oracle', reason: 'dead', extra: 'not persisted' },
        ],
      },
    });

    expect(summary).toEqual({
      ok: true,
      statePath: 'state.json',
      stateUpdatedAt: '2026-04-19T05:40:00.000Z',
      alertCount: 1,
      alerts: [{ target: 'oracle', ok: true }],
      agentPaneRecovery: {
        ok: true,
        status: 'actions_taken',
        actionCount: 1,
        actions: [{ kind: 'restart', paneId: '3', role: 'oracle', reason: 'dead' }],
      },
    });
  });

  test('bidirectional watchdog can route accepted-unverified peer wake into pane auto-recovery', async () => {
    // 13:30Z = 06:30 America/Los_Angeles — active window, so the peer-wake poke
    // fires and can be routed into pane auto-recovery.
    const nowMs = Date.parse('2026-04-19T13:30:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    queryCommsJournalEntries.mockImplementation(({ senderRole, targetRole, direction }) => {
      if (senderRole === 'architect' && targetRole === 'oracle' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (2 * 60 * 1000) }];
      }
      if (senderRole === 'oracle' && direction === 'outbound') {
        return [{ sentAtMs: nowMs - (20 * 60 * 1000) }];
      }
      return [];
    });
    sendAgentAlert.mockImplementation((message, options) => {
      if (options?.targets?.includes('oracle')) {
        return {
          ok: true,
          targets: ['oracle'],
          results: [{ target: 'oracle', ok: true, stdout: 'Accepted by oracle but unverified: accepted.unverified' }],
        };
      }
      return {
        ok: true,
        targets: options?.targets || [],
        results: [],
      };
    });
    const restartPane = jest.fn(() => ({ ok: true }));
    const notifyArchitect = jest.fn(() => ({ ok: true }));
    const probePane = jest.fn(() => ({ success: false, reason: 'agent_not_running' }));
    const agentRecoveryStatePath = path.join(tempDir, 'agent-pane-auto-recovery-state.json');
    const agentRecoveryEventsPath = path.join(tempDir, 'agent-pane-auto-recovery-events.jsonl');

    const result = await runHeartbeatCycle({
      statePath: bidirectionalStatePath,
      currentLanePath: activeLanePath,
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
      oracleSilenceMs: 10 * 60 * 1000,
      architectSilenceMs: 8 * 60 * 1000,
      agentPaneAutoRecovery: {
        statePath: agentRecoveryStatePath,
        eventsPath: agentRecoveryEventsPath,
        paneSpecs: [{ paneId: '3', role: 'oracle' }],
        config: {
          bootGraceMs: 8 * 60 * 1000,
          deadConfirmCount: 2,
          deadSustainMs: 60 * 1000,
          deadProbeAfterMs: 0,
          probeCooldownMs: 0,
          wedgedConfirmCount: 2,
          wedgedMinMs: 0,
        },
        state: {
          version: 1,
          panes: {
            '3': {
              paneId: '3',
              role: 'oracle',
              deadFirstAtMs: nowMs - (2 * 60 * 1000),
              deadCount: 1,
            },
          },
        },
        scrollbackSnapshot: {
          panes: {
            '3': {
              paneId: '3',
              createdAt: nowMs - (20 * 60 * 1000),
              lastActivity: nowMs - (20 * 60 * 1000),
              scrollbackSha256: 'oracle-hash',
            },
          },
        },
        latestCommsByRole: { oracle: nowMs - (20 * 60 * 1000) },
        appStartedAtMs: nowMs - (20 * 60 * 1000),
        probePane,
        restartPane,
        notifyArchitect,
      },
    });

    expect(probePane).toHaveBeenCalledWith('3', expect.any(Object));
    expect(restartPane).toHaveBeenCalledWith('3', expect.any(Object));
    expect(notifyArchitect).toHaveBeenCalledWith(
      expect.stringContaining('Restarting pane'),
      expect.any(Object)
    );
    expect(result.agentPaneRecovery.actions).toEqual([
      expect.objectContaining({
        kind: 'restart',
        paneId: '3',
        reason: 'dead',
      }),
    ]);
  });
});
