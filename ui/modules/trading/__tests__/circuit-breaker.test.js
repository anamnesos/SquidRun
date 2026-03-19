'use strict';

const { CircuitBreaker, _internals } = require('../circuit-breaker');
const { pickPrice, normTicker } = _internals;

// Helpers
function makePosition(ticker, shares, avgPrice, marketValue) {
  return { ticker, shares, avgPrice, marketValue: marketValue ?? shares * avgPrice, side: 'long', assetClass: 'crypto' };
}

function makeSnapshot(tradePrice) {
  return { tradePrice, askPrice: 0, bidPrice: 0, minuteClose: 0, dailyClose: 0 };
}

describe('pickPrice', () => {
  test('returns tradePrice first', () => {
    expect(pickPrice({ tradePrice: 100, askPrice: 101 })).toBe(100);
  });

  test('falls back to askPrice', () => {
    expect(pickPrice({ tradePrice: 0, askPrice: 101 })).toBe(101);
  });

  test('returns null for empty snapshot', () => {
    expect(pickPrice(null)).toBeNull();
    expect(pickPrice({})).toBeNull();
  });
});

describe('normTicker', () => {
  test('strips slashes and dashes', () => {
    expect(normTicker('BTC/USD')).toBe('BTCUSD');
    expect(normTicker('BTC-USD')).toBe('BTCUSD');
    expect(normTicker('BTCUSD')).toBe('BTCUSD');
  });
});

describe('CircuitBreaker', () => {
  let cb;
  let sellCalls;
  let mockPositions;
  let mockSnapshots;
  let mockEquity;

  beforeEach(() => {
    sellCalls = [];
    mockPositions = [];
    mockSnapshots = new Map();
    mockEquity = 100000;

    cb = new CircuitBreaker({
      pollMs: 10000,
      hardStopPct: 0.04,
      trailingStopPct: 0.03,
      flashCrashPct: 0.05,
      minPositionValueUsd: 10,
      cooldownMs: 60000,
      statePath: '', // Don't persist to disk in tests
      state: {},
      getPositions: async () => mockPositions,
      getSnapshots: async () => mockSnapshots,
      executeSell: async (ticker, shares, reason) => {
        sellCalls.push({ ticker, shares, reason });
        return { ok: true };
      },
      getAccountEquity: async () => mockEquity,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => Date.now(),
    });
    // Disable persistence in tests
    cb.persistState = () => {};
  });

  afterEach(() => {
    cb.stop();
  });

  test('no positions → no exits', async () => {
    mockPositions = [];
    const result = await cb.runMonitorPass();
    expect(result.ok).toBe(true);
    expect(result.positions).toBe(0);
    expect(result.exits).toBe(0);
    expect(sellCalls).toHaveLength(0);
  });

  test('dust positions are skipped', async () => {
    mockPositions = [makePosition('ETHUSD', 0.0001, 2000, 0.20)];
    mockSnapshots.set('ETHUSD', makeSnapshot(1500)); // 25% loss but dust
    const result = await cb.runMonitorPass();
    expect(result.checked).toBe(0);
    expect(result.reason).toBe('all_dust');
    expect(sellCalls).toHaveLength(0);
  });

  test('hard stop-loss triggers sell at 4% loss', async () => {
    mockPositions = [makePosition('BTCUSD', 1, 70000, 66500)];
    mockSnapshots.set('BTCUSD', makeSnapshot(66500)); // 5% loss > 4% threshold
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(1);
    expect(sellCalls).toHaveLength(1);
    expect(sellCalls[0].ticker).toBe('BTCUSD');
    expect(sellCalls[0].shares).toBe(1);
    expect(sellCalls[0].reason).toMatch(/hard_stop/);
  });

  test('no exit when loss is below threshold', async () => {
    mockPositions = [makePosition('BTCUSD', 1, 70000, 69000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(69000)); // ~1.4% loss < 4% threshold
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(0);
    expect(sellCalls).toHaveLength(0);
  });

  test('trailing stop triggers when price drops from high-water mark', async () => {
    mockPositions = [makePosition('SOLUSD', 20, 90, 1960)];
    // Set high-water mark at $98
    cb.highWaterMarks.SOLUSD = { price: 98, updatedAt: new Date().toISOString() };
    // Current price $94 = 4.08% drop from $98 high > 3% trailing stop
    mockSnapshots.set('SOLUSD', makeSnapshot(94));
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(1);
    expect(sellCalls[0].reason).toMatch(/trailing_stop/);
  });

  test('trailing stop does NOT trigger within threshold', async () => {
    mockPositions = [makePosition('SOLUSD', 20, 90, 1940)];
    cb.highWaterMarks.SOLUSD = { price: 98, updatedAt: new Date().toISOString() };
    // $96 = 2.04% drop < 3% threshold
    mockSnapshots.set('SOLUSD', makeSnapshot(96));
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(0);
  });

  test('high-water mark updates when price rises', async () => {
    mockPositions = [makePosition('BTCUSD', 1, 70000, 72000)];
    cb.highWaterMarks.BTCUSD = { price: 71000, updatedAt: new Date().toISOString() };
    mockSnapshots.set('BTCUSD', makeSnapshot(72000));
    await cb.runMonitorPass();
    expect(cb.highWaterMarks.BTCUSD.price).toBe(72000);
  });

  test('flash crash triggers sell-all', async () => {
    cb.lastEquity = 100000;
    mockEquity = 94000; // 6% drop > 5% threshold
    mockPositions = [
      makePosition('BTCUSD', 0.5, 70000, 33000),
      makePosition('SOLUSD', 20, 90, 1700),
    ];
    mockSnapshots.set('BTCUSD', makeSnapshot(66000));
    mockSnapshots.set('SOLUSD', makeSnapshot(85));
    const result = await cb.runMonitorPass();
    expect(result.flashCrash).toBe(true);
    expect(sellCalls).toHaveLength(2);
    expect(sellCalls[0].reason).toBe('flash_crash');
    expect(sellCalls[1].reason).toBe('flash_crash');
  });

  test('flash crash does NOT trigger within threshold', async () => {
    cb.lastEquity = 100000;
    mockEquity = 96000; // 4% drop < 5%
    mockPositions = [makePosition('BTCUSD', 1, 70000, 70000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(70000));
    const result = await cb.runMonitorPass();
    expect(result.flashCrash).toBe(false);
    expect(sellCalls).toHaveLength(0);
  });

  test('cooldown prevents re-exit within window', async () => {
    const now = Date.now();
    cb.now = () => now;
    cb.cooldowns.BTCUSD = now - 30000; // 30s ago, cooldown is 60s
    mockPositions = [makePosition('BTCUSD', 1, 70000, 60000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(60000)); // 14% loss, should trigger
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(0); // Blocked by cooldown
    expect(sellCalls).toHaveLength(0);
  });

  test('cooldown expires and allows exit', async () => {
    const now = Date.now();
    cb.now = () => now;
    cb.cooldowns.BTCUSD = now - 120000; // 2 min ago, cooldown is 60s
    mockPositions = [makePosition('BTCUSD', 1, 70000, 60000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(60000));
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(1);
  });

  test('emits exit event', async () => {
    const events = [];
    cb.on('exit', (e) => events.push(e));
    mockPositions = [makePosition('BTCUSD', 1, 70000, 66000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(66000));
    await cb.runMonitorPass();
    expect(events).toHaveLength(1);
    expect(events[0].ticker).toBe('BTCUSD');
    expect(events[0].reason).toMatch(/hard_stop/);
  });

  test('cleans up high-water marks for closed positions', async () => {
    cb.highWaterMarks.BTCUSD = { price: 72000, updatedAt: new Date().toISOString() };
    cb.highWaterMarks.SOLUSD = { price: 100, updatedAt: new Date().toISOString() };
    mockPositions = [makePosition('BTCUSD', 1, 70000, 71000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(71000));
    await cb.runMonitorPass();
    expect(cb.highWaterMarks.BTCUSD).toBeDefined();
    expect(cb.highWaterMarks.SOLUSD).toBeUndefined(); // Cleaned up
  });

  test('missing callbacks returns error', async () => {
    const broken = new CircuitBreaker({ statePath: '', state: {} });
    broken.persistState = () => {};
    const result = await broken.runMonitorPass();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_callbacks');
  });

  test('start and stop manage timer', () => {
    cb.start({ immediate: false });
    expect(cb.running).toBe(true);
    expect(cb.timer).not.toBeNull();
    cb.stop();
    expect(cb.running).toBe(false);
    expect(cb.timer).toBeNull();
  });

  test('sell failure does not crash the pass', async () => {
    cb.executeSell = async () => { throw new Error('broker down'); };
    mockPositions = [makePosition('BTCUSD', 1, 70000, 66000)];
    mockSnapshots.set('BTCUSD', makeSnapshot(66000));
    const result = await cb.runMonitorPass();
    expect(result.ok).toBe(true);
    // Exit attempted but errored — still recorded in exitResults
    expect(result.exits).toBe(1);
    expect(result.exitDetails[0].result).toBe('error');
  });

  test('multiple positions checked independently', async () => {
    mockPositions = [
      makePosition('BTCUSD', 1, 70000, 71000), // 1.4% gain, safe
      makePosition('SOLUSD', 20, 90, 1700),     // ~5.6% loss, triggers
    ];
    mockSnapshots.set('BTCUSD', makeSnapshot(71000));
    mockSnapshots.set('SOLUSD', makeSnapshot(85)); // 5.6% loss
    const result = await cb.runMonitorPass();
    expect(result.exits).toBe(1);
    expect(sellCalls).toHaveLength(1);
    expect(sellCalls[0].ticker).toBe('SOLUSD');
  });
});
