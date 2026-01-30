/**
 * Session History IPC Handler Tests
 * Target: Full coverage of session-history-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerSessionHistoryHandlers } = require('../modules/ipc/session-history-handlers');

describe('Session History Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add usage stats with history
    ctx.usageStats = {
      history: [
        { pane: '1', duration: 3600000, timestamp: new Date('2026-01-30T10:00:00').getTime() },
        { pane: '2', duration: 1800000, timestamp: new Date('2026-01-30T11:00:00').getTime() },
        { pane: '3', duration: 45000, timestamp: new Date('2026-01-30T12:00:00').getTime() },
        { pane: '4', duration: 90000, timestamp: new Date('2026-01-30T13:00:00').getTime() },
      ],
    };

    registerSessionHistoryHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get-session-history', () => {
    test('returns session history with formatted data', async () => {
      const result = await harness.invoke('get-session-history');

      expect(result.success).toBe(true);
      expect(result.history.length).toBe(4);
      expect(result.total).toBe(4);

      // Should be reversed (newest first)
      expect(result.history[0].pane).toBe('4');
    });

    test('formats hours correctly', async () => {
      const result = await harness.invoke('get-session-history');

      // 3600000ms = 1 hour
      const oneHourEntry = result.history.find(e => e.pane === '1');
      expect(oneHourEntry.durationFormatted).toBe('1h 0m');
    });

    test('formats minutes correctly', async () => {
      const result = await harness.invoke('get-session-history');

      // 1800000ms = 30 minutes
      const thirtyMinEntry = result.history.find(e => e.pane === '2');
      expect(thirtyMinEntry.durationFormatted).toBe('30m 0s');
    });

    test('formats seconds correctly', async () => {
      const result = await harness.invoke('get-session-history');

      // 45000ms = 45 seconds
      const secondsEntry = result.history.find(e => e.pane === '3');
      expect(secondsEntry.durationFormatted).toBe('45s');
    });

    test('formats mixed minutes and seconds', async () => {
      const result = await harness.invoke('get-session-history');

      // 90000ms = 1 minute 30 seconds
      const mixedEntry = result.history.find(e => e.pane === '4');
      expect(mixedEntry.durationFormatted).toBe('1m 30s');
    });

    test('includes role from PANE_ROLES', async () => {
      const result = await harness.invoke('get-session-history');

      result.history.forEach(entry => {
        expect(entry.role).toBeDefined();
      });
    });

    test('uses fallback role when not in PANE_ROLES', async () => {
      ctx.usageStats.history = [
        { pane: '99', duration: 1000, timestamp: Date.now() },
      ];

      const result = await harness.invoke('get-session-history');

      expect(result.history[0].role).toBe('Pane 99');
    });

    test('respects limit parameter', async () => {
      const result = await harness.invoke('get-session-history', 2);

      expect(result.history.length).toBe(2);
      expect(result.total).toBe(4); // Total is still 4
    });

    test('returns empty history when no history exists', async () => {
      ctx.usageStats.history = [];

      const result = await harness.invoke('get-session-history');

      expect(result.success).toBe(true);
      expect(result.history).toEqual([]);
      expect(result.total).toBe(0);
    });

    test('returns empty history when usageStats.history is undefined', async () => {
      ctx.usageStats = {};

      const result = await harness.invoke('get-session-history');

      expect(result.success).toBe(true);
      expect(result.history).toEqual([]);
      expect(result.total).toBe(0);
    });

    test('includes formatted date and time', async () => {
      const result = await harness.invoke('get-session-history');

      result.history.forEach(entry => {
        expect(entry.date).toBeDefined();
        expect(entry.time).toBeDefined();
        expect(entry.id).toMatch(/^session-\d+$/);
      });
    });
  });
});
