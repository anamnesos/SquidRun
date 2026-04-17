'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../modules/trading/orchestrator', () => ({
  createOrchestrator: jest.fn(() => ({})),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getHistoricalBars: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../modules/trading/hyperliquid-native-layer', () => ({
  buildNativeFeatureBundle: jest.fn().mockResolvedValue(null),
  recordNativeFeatureSnapshot: jest.fn(),
}));

jest.mock('../modules/trading/smart-money-scanner', () => ({
  SmartMoneyScanner: class SmartMoneyScanner {},
  createEtherscanProvider: jest.fn(() => null),
}));

const { SupervisorDaemon } = require('../supervisor-daemon');

describe('supervisor range conviction', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-supervisor-rc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('executes conviction-managed exits before trying a fresh entry cycle', async () => {
    const closePosition = jest.fn().mockResolvedValue({ ok: true });
    const daemon = new SupervisorDaemon({
      dbPath: path.join(tmpDir, 'supervisor.db'),
      logPath: path.join(tmpDir, 'supervisor.log'),
      statusPath: path.join(tmpDir, 'supervisor-status.json'),
      pidPath: path.join(tmpDir, 'supervisor.pid'),
      cryptoTradingEnabled: true,
      cryptoTradingOrchestrator: {},
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor: {
        closePosition,
        getAccountState: jest.fn().mockResolvedValue({
          accountValue: 1000,
          positions: [],
        }),
      },
    });
    daemon.cryptoTradingStrategyMode = 'range_conviction';
    daemon.rangeConvictionIntervalMs = 60_000;
    daemon.getCryptoSymbolCandidates = jest.fn().mockResolvedValue(['AVAX/USD']);
    daemon.buildRangeConvictionSelection = jest.fn().mockResolvedValue({
      selectedTicker: 'AVAX/USD',
      activePosition: {
        coin: 'AVAX',
        side: 'long',
        entryPx: 20,
        unrealizedPnl: 44,
      },
      positionAction: {
        action: 'abort_thesis',
        rationale: 'Range broke below the planned invalidation.',
      },
      confidence: 0.84,
    });
    daemon.notifyTelegramTrading = jest.fn();
    daemon.triggerImmediateCryptoConsensus = jest.fn();

    const result = await daemon.maybeRunRangeConvictionCycle({
      force: true,
      reentryAfterManagement: false,
    });

    expect(closePosition).toHaveBeenCalledWith({ asset: 'AVAX' });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'abort_thesis',
      ticker: 'AVAX/USD',
    }));
    expect(daemon.triggerImmediateCryptoConsensus).not.toHaveBeenCalled();
  });
});
