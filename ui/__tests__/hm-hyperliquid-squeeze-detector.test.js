jest.mock('../scripts/hm-telegram', () => ({
  sendTelegram: jest.fn().mockResolvedValue({ ok: true, chatId: '5613428850', messageId: 123 }),
}));

jest.mock('../scripts/hm-agent-alert', () => ({
  DEFAULT_AGENT_TARGETS: ['architect', 'oracle'],
  normalizeTargets: jest.fn((value) => Array.isArray(value) ? value : String(value || '').split(',').map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)),
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['architect', 'oracle'], results: [{ target: 'architect', ok: true }, { target: 'oracle', ok: true }] })),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const {
  analyzeTransition,
  normalizeSymbols,
  runDetector,
} = require('../scripts/hm-hyperliquid-squeeze-detector');

describe('hm-hyperliquid-squeeze-detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes comma-delimited symbols', () => {
    expect(normalizeSymbols('btc, ETH ,sol,BTC')).toEqual(['BTC', 'ETH', 'SOL']);
  });

  test('detects squeeze when price and OI rise and funding flips positive', () => {
    const detection = analyzeTransition(
      { coin: 'BTC', price: 70000, openInterest: 1000, fundingRate: -0.00001, recordedAt: '2026-04-13T00:00:00.000Z' },
      { coin: 'BTC', price: 70600, openInterest: 1020, fundingRate: 0.00001, volumeUsd24h: 1000000000, recordedAt: '2026-04-13T00:05:00.000Z' },
      { minPriceMovePct: 0.005, minOpenInterestMovePct: 0.01 }
    );

    expect(detection).toEqual(expect.objectContaining({
      coin: 'BTC',
      type: 'squeeze_starting',
      ticker: 'BTC/USD',
    }));
  });

  test('detects cascade when price falls, OI rises, and funding is negative', () => {
    const detection = analyzeTransition(
      { coin: 'ETH', price: 2100, openInterest: 5000, fundingRate: 0.00001, recordedAt: '2026-04-13T00:00:00.000Z' },
      { coin: 'ETH', price: 2080, openInterest: 5100, fundingRate: -0.00002, volumeUsd24h: 500000000, recordedAt: '2026-04-13T00:05:00.000Z' },
      { minPriceMovePct: 0.005, minOpenInterestMovePct: 0.01 }
    );

    expect(detection).toEqual(expect.objectContaining({
      coin: 'ETH',
      type: 'cascade_starting',
      ticker: 'ETH/USD',
    }));
  });

  test('baseline run stores snapshots without alerting and second run emits a squeeze', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sq-detector-'));
    const statePath = path.join(tempDir, 'hyperliquid-squeeze-detector-state.json');

    hyperliquidClient.getUniverseMarketData
      .mockResolvedValueOnce([
        { coin: 'BTC', ticker: 'BTC/USD', price: 70000, fundingRate: -0.00001, openInterest: 1000, volumeUsd24h: 1000000000 },
      ])
      .mockResolvedValueOnce([
        { coin: 'BTC', ticker: 'BTC/USD', price: 70600, fundingRate: 0.00001, openInterest: 1020, volumeUsd24h: 1100000000 },
      ]);

    const first = await runDetector({
      statePath,
      sendAgents: false,
      sendTelegram: false,
      symbols: ['BTC'],
      minPriceMovePct: 0.005,
      minOpenInterestMovePct: 0.01,
    });
    expect(first.detectionCount).toBe(0);
    expect(first.initialized).toBe(false);

    const second = await runDetector({
      statePath,
      sendAgents: false,
      sendTelegram: false,
      symbols: ['BTC'],
      minPriceMovePct: 0.005,
      minOpenInterestMovePct: 0.01,
    });
    expect(second.initialized).toBe(true);
    expect(second.detectionCount).toBe(1);
    expect(second.detections[0]).toEqual(expect.objectContaining({
      coin: 'BTC',
      type: 'squeeze_starting',
    }));
  });

  test('routes detections to architect and oracle instead of Telegram by default', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sq-detector-alert-'));
    const statePath = path.join(tempDir, 'hyperliquid-squeeze-detector-state.json');

    hyperliquidClient.getUniverseMarketData
      .mockResolvedValueOnce([
        { coin: 'BTC', ticker: 'BTC/USD', price: 70000, fundingRate: -0.00001, openInterest: 1000, volumeUsd24h: 1000000000 },
      ])
      .mockResolvedValueOnce([
        { coin: 'BTC', ticker: 'BTC/USD', price: 70600, fundingRate: 0.00001, openInterest: 1020, volumeUsd24h: 1100000000 },
      ]);

    await runDetector({
      statePath,
      sendTelegram: false,
      symbols: ['BTC'],
      minPriceMovePct: 0.005,
      minOpenInterestMovePct: 0.01,
    });
    const second = await runDetector({
      statePath,
      sendTelegram: false,
      symbols: ['BTC'],
      minPriceMovePct: 0.005,
      minOpenInterestMovePct: 0.01,
    });

    expect(second.alerted).toBe(true);
    expect(second.agentAlerts).toEqual(expect.objectContaining({
      ok: true,
      targets: ['architect', 'oracle'],
    }));
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('Route this to agent action, not James'),
      expect.objectContaining({
        targets: ['architect', 'oracle'],
      })
    );
  });
});
