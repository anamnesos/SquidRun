'use strict';

const path = require('path');

const mockExecFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

jest.mock('child_process', () => ({
  execFileSync: (...args) => mockExecFileSync(...args),
}));

jest.mock('fs', () => ({
  writeFileSync: (...args) => mockWriteFileSync(...args),
  unlinkSync: (...args) => mockUnlinkSync(...args),
}));

jest.mock('../../../config', () => ({
  getProjectRoot: () => '/repo-root',
}));

const { sendDailySummary } = require('../telegram-summary');

describe('telegram-summary', () => {
  const originalTelegramChatId = process.env.TELEGRAM_CHAT_ID;

  beforeEach(() => {
    mockExecFileSync.mockClear();
    mockWriteFileSync.mockClear();
    mockUnlinkSync.mockClear();
    mockWarn.mockClear();
    process.env.TELEGRAM_CHAT_ID = '5613428850';
  });

  afterAll(() => {
    if (typeof originalTelegramChatId === 'string') {
      process.env.TELEGRAM_CHAT_ID = originalTelegramChatId;
    } else {
      delete process.env.TELEGRAM_CHAT_ID;
    }
    mockWarn.mockRestore();
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
      expect.arrayContaining([path.join('/repo-root', 'ui', 'scripts', 'hm-send.js'), 'telegram', '--chat-id', '5613428850']),
      expect.objectContaining({ cwd: '/repo-root' })
    );
  });

  test('suppresses trading telegram sends when TELEGRAM_CHAT_ID is missing', () => {
    delete process.env.TELEGRAM_CHAT_ID;

    sendDailySummary({
      date: '2026-03-26',
      equity: 10150,
      pnl: 150,
      pnlPct: 0.015,
      peakEquity: 10200,
      weekPnlPct: 0.02,
      trades: [],
      openPositions: [],
    });

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('Trading Telegram notify suppressed: TELEGRAM_CHAT_ID is not configured.');
  });
});
