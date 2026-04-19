jest.mock('../scripts/hm-agent-alert', () => ({
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['oracle'], results: [{ target: 'oracle', ok: true }] })),
}));

jest.mock('../scripts/hm-tokenomist-unlocks', () => ({
  runScan: jest.fn(async () => ({
    ok: true,
    unlocks: [
      {
        token: 'ZRO',
        countdownText: '0 D 06 H 00 M 00 S',
        unlockSizeText: '$4.20M',
        unlockPctSupplyText: '1.2%',
      },
    ],
  })),
}));

jest.mock('../modules/main/comms-journal', () => ({
  queryCommsJournalEntries: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const { runScan } = require('../scripts/hm-tokenomist-unlocks');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const { buildOracleWakeMessage } = require('../scripts/hm-oracle-wake-context');
const { runWakeCycle } = require('../scripts/hm-oracle-wake-watchdog');
const { runHeartbeatCycle } = require('../scripts/hm-bidirectional-wake-watchdog');

describe('oracle wake watchdog context injection', () => {
  let tempDir;
  let watchRulesPath;
  let watchStatePath;
  let marketScannerStatePath;
  let oracleWakeStatePath;
  let bidirectionalStatePath;

  beforeEach(() => {
    jest.clearAllMocks();
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
        { coin: 'ZRO', ticker: 'ZRO/USD', volumeUsd24h: 33355078.51 },
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
  });

  test('buildOracleWakeMessage inlines unlocks, movers, and stale-rule context', async () => {
    const message = await buildOracleWakeMessage('wake base', {
      watchRulesPath,
      watchStatePath,
      marketScannerStatePath,
      staleDistancePct: 0.015,
      nowMs: Date.parse('2026-04-19T05:20:00.000Z'),
    });

    expect(runScan).toHaveBeenCalledWith(expect.objectContaining({
      maxHours: 24,
      marketData: expect.any(Array),
    }));
    expect(message).toContain('wake base');
    expect(message).toContain('unlocks24h=ZRO 0 D 06 H 00 M 00 S $4.20M 1.2%');
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
      nowMs: Date.parse('2026-04-19T05:20:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('unlocks24h=ZRO 0 D 06 H 00 M 00 S $4.20M 1.2%'),
      expect.objectContaining({
        targets: ['oracle'],
        role: 'oracle-wake-watchdog',
      })
    );
    const persistedState = JSON.parse(fs.readFileSync(oracleWakeStatePath, 'utf8'));
    expect(persistedState.lastMessage).toContain('topMovers=ORDI/USD -33.0% @ 3.8765');
    expect(persistedState.lastMessage).toContain('staleRules=BTC/USD 75300.00-75380.00 vs 76500.00');
  });

  test('bidirectional wake watchdog injects the same context into Oracle repokes', async () => {
    const nowMs = Date.parse('2026-04-19T05:20:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    queryCommsJournalEntries.mockImplementation(({ senderRole }) => {
      if (senderRole === 'architect') {
        return [{ sentAtMs: nowMs - (2 * 60 * 1000) }];
      }
      if (senderRole === 'oracle') {
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
});
