'use strict';

const mockExecFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();

jest.mock('child_process', () => ({
  execFileSync: (...args) => mockExecFileSync(...args),
}));

jest.mock('fs', () => ({
  writeFileSync: (...args) => mockWriteFileSync(...args),
  unlinkSync: (...args) => mockUnlinkSync(...args),
}));

const { sendDailySummary } = require('../telegram-summary');

describe('telegram-summary', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear();
    mockWriteFileSync.mockClear();
    mockUnlinkSync.mockClear();
  });

  test('formats end-of-day summaries when positions use camelCase fields', () => {
    expect(() => {
      sendDailySummary({
        date: '2026-03-26',
        equity: 10150,
        pnl: 150,
        pnlPct: 0.015,
        peakEquity: 10200,
        weekPnlPct: 0.02,
        trades: [
          { ticker: 'AAPL', direction: 'BUY', shares: 1, price: 100.5 },
        ],
        openPositions: [
          { ticker: 'AAPL', shares: 1, avgPrice: 100.5, stopLossPrice: 95 },
        ],
      });
    }).not.toThrow();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('hm-send.js'), 'telegram']),
      expect.any(Object)
    );
  });
});
