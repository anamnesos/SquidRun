'use strict';

const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

jest.mock('../journal', () => ({
  getDb: jest.fn(() => ({})),
  recordTrade: jest.fn(() => ({ lastInsertRowid: 1 })),
}));

jest.mock('../hyperliquid-client', () => ({
  getAccountSnapshot: jest.fn(),
  getOpenPositions: jest.fn(),
  getSnapshots: jest.fn(),
  getLatestBars: jest.fn(),
  getHistoricalBars: jest.fn(),
}));

const executor = require('../executor');
const journal = require('../journal');
const hyperliquidClient = require('../hyperliquid-client');

describe('executor Hyperliquid live path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks live Hyperliquid execution until scalp mode is explicitly armed', async () => {
    await expect(executor.submitHyperliquidOrder({
      ticker: 'ETH/USD',
      direction: 'BUY',
      shares: 0.1,
      referencePrice: 2400,
      margin: 12,
    }, {
      hyperliquidExecuteScriptPath: 'C:\\tmp\\hm-defi-execute.js',
    })).rejects.toThrow('explicitly armed');
  });

  test('routes an armed Hyperliquid consensus trade through hm-defi-execute', async () => {
    mockExecFile.mockImplementation((file, args, options, callback) => {
      callback(null, 'entry accepted', '');
    });

    const result = await executor.executeConsensusTrade({
      consensus: {
        consensus: true,
        decision: 'BUY',
        ticker: 'ETH/USD',
        confidence: 0.81,
      },
      ticker: 'ETH/USD',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      price: 2400,
      referencePrice: 2400,
      requestedShares: 0.1,
      riskCheckDetail: {
        stopLossPrice: 2360,
        leverage: 20,
        margin: 12,
        positionNotional: 240,
      },
      account: {
        equity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        tradesToday: 0,
        openPositions: [],
      },
    }, {
      hyperliquidScalpModeArmed: true,
      allowHyperliquidLiveExecution: true,
      hyperliquidExecutionEnv: {
        SQUIDRUN_HYPERLIQUID_SCALP_MODE: '1',
      },
      hyperliquidExecuteScriptPath: 'C:\\tmp\\hm-defi-execute.js',
      recordJournal: false,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'accepted',
      broker: 'hyperliquid',
      payload: expect.objectContaining({
        asset: 'ETH',
        direction: 'BUY',
        leverage: 20,
        margin: 12,
        scriptPath: 'C:\\tmp\\hm-defi-execute.js',
      }),
    }));

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'C:\\tmp\\hm-defi-execute.js',
        'trade',
        '--asset',
        'ETH',
        '--direction',
        'BUY',
        '--leverage',
        '20',
        '--margin',
        '12',
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_HYPERLIQUID_SCALP_MODE: '1',
        }),
      }),
      expect.any(Function)
    );
  });

  test('routes Hyperliquid SELL against an existing long through hm-defi-close instead of opening a short', async () => {
    hyperliquidClient.getOpenPositions.mockResolvedValue([{
      ticker: 'ETH/USD',
      side: 'long',
      shares: 0.1,
      assetClass: 'crypto',
    }]);
    mockExecFile.mockImplementation((file, args, options, callback) => {
      callback(null, 'close accepted', '');
    });

    const result = await executor.submitOrder({
      ticker: 'ETH/USD',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      direction: 'SELL',
      shares: 0.1,
      referencePrice: 2400,
      notes: 'close-long',
    }, {
      hyperliquidScalpModeArmed: true,
      allowHyperliquidLiveExecution: true,
      hyperliquidCloseScriptPath: 'C:\\tmp\\hm-defi-close.js',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      broker: 'hyperliquid',
      payload: expect.objectContaining({
        direction: 'SELL',
        closingPosition: true,
        scriptPath: 'C:\\tmp\\hm-defi-close.js',
      }),
    }));

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'C:\\tmp\\hm-defi-close.js',
        '--asset',
        'ETH',
        '--size',
        '0.1',
      ]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('journals a Hyperliquid SHORT submission through the normal path', async () => {
    mockExecFile.mockImplementation((file, args, options, callback) => {
      callback(null, 'short accepted', '');
    });

    await executor.submitOrder({
      ticker: 'ETH/USD',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      direction: 'SHORT',
      shares: 0.1,
      referencePrice: 2400,
      margin: 12,
      stopLossPrice: 2460,
      riskCheckDetail: {
        leverage: 20,
        margin: 12,
        positionNotional: 240,
      },
      notes: 'open-short',
    }, {
      hyperliquidScalpModeArmed: true,
      allowHyperliquidLiveExecution: true,
      hyperliquidExecuteScriptPath: 'C:\\tmp\\hm-defi-execute.js',
    });

    expect(journal.recordTrade).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        ticker: 'ETH/USD',
        direction: 'SHORT',
      })
    );
  });
});
