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
const { runHeartbeatCycle } = require('../scripts/hm-bidirectional-wake-watchdog');

describe('oracle wake watchdog context', () => {
  let tempDir;
  let watchRulesPath;
  let watchStatePath;
  let marketScannerStatePath;
  let oracleWakeStatePath;
  let bidirectionalStatePath;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-wake-watchdogs-'));
    watchRulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    marketScannerStatePath = path.join(tempDir, 'market-scanner-state.json');
    oracleWakeStatePath = path.join(tempDir, 'oracle-wake-state.json');
    bidirectionalStatePath = path.join(tempDir, 'bidirectional-wake-state.json');

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
    const nowMs = Date.parse('2026-04-19T05:20:00.000Z');
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

  test('bidirectional watchdog can route accepted-unverified peer wake into pane auto-recovery', async () => {
    const nowMs = Date.parse('2026-04-19T05:30:00.000Z');
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
