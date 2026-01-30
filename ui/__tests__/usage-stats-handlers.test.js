/**
 * Usage Stats IPC Handler Tests
 * Target: Full coverage of usage-stats-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { registerUsageStatsHandlers } = require('../modules/ipc/usage-stats-handlers');

describe('Usage Stats Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Make isDestroyed a mock function
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Set up usage stats
    ctx.usageStats = {
      totalSpawns: 10,
      spawnsPerPane: { '1': 2, '2': 3, '3': 1, '4': 2, '5': 1, '6': 1 },
      totalSessionTimeMs: 3600000, // 1 hour
      sessionTimePerPane: { '1': 600000, '2': 900000, '3': 300000, '4': 600000, '5': 600000, '6': 600000 },
      sessionsToday: 5,
      lastResetDate: '2026-01-30',
      history: [
        { pane: '1', duration: 1800000, startTime: '2026-01-30T10:00:00Z' },
        { pane: '2', duration: 900000, startTime: '2026-01-30T11:00:00Z' },
      ],
    };

    ctx.currentSettings = {
      costAlertEnabled: false,
      costAlertThreshold: 5.00,
    };

    ctx.costAlertSent = false;

    deps = {
      saveUsageStats: jest.fn(),
    };

    registerUsageStatsHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get-usage-stats', () => {
    test('returns all usage stats', async () => {
      const result = await harness.invoke('get-usage-stats');

      expect(result.totalSpawns).toBe(10);
      expect(result.spawnsPerPane).toEqual({ '1': 2, '2': 3, '3': 1, '4': 2, '5': 1, '6': 1 });
      expect(result.totalSessionTimeMs).toBe(3600000);
      expect(result.sessionsToday).toBe(5);
      expect(result.lastResetDate).toBe('2026-01-30');
    });

    test('formats duration in hours and minutes', async () => {
      ctx.usageStats.totalSessionTimeMs = 7260000; // 2h 1m

      const result = await harness.invoke('get-usage-stats');

      expect(result.totalSessionTime).toBe('2h 1m');
    });

    test('formats duration in minutes and seconds', async () => {
      ctx.usageStats.totalSessionTimeMs = 125000; // 2m 5s

      const result = await harness.invoke('get-usage-stats');

      expect(result.totalSessionTime).toBe('2m 5s');
    });

    test('formats duration in seconds only', async () => {
      ctx.usageStats.totalSessionTimeMs = 45000; // 45s

      const result = await harness.invoke('get-usage-stats');

      expect(result.totalSessionTime).toBe('45s');
    });

    test('calculates estimated cost', async () => {
      ctx.usageStats.totalSessionTimeMs = 6000000; // 100 minutes = $5.00

      const result = await harness.invoke('get-usage-stats');

      expect(result.estimatedCost).toBe('5.00');
    });

    test('calculates estimated cost per pane', async () => {
      const result = await harness.invoke('get-usage-stats');

      expect(result.estimatedCostPerPane).toBeDefined();
      // Pane 1: 600000ms = 10 minutes = $0.50
      expect(result.estimatedCostPerPane['1']).toBe('0.50');
    });

    test('formats session time per pane', async () => {
      const result = await harness.invoke('get-usage-stats');

      expect(result.sessionTimePerPane).toBeDefined();
      expect(result.sessionTimePerPane['1']).toBe('10m 0s'); // 600000ms
    });

    test('returns recent sessions with formatted duration', async () => {
      const result = await harness.invoke('get-usage-stats');

      expect(result.recentSessions.length).toBe(2);
      expect(result.recentSessions[0].durationFormatted).toBe('30m 0s'); // 1800000ms
    });

    test('limits recent sessions to 10', async () => {
      ctx.usageStats.history = Array.from({ length: 15 }, (_, i) => ({
        pane: '1',
        duration: 60000,
        startTime: `2026-01-30T${10 + i}:00:00Z`,
      }));

      const result = await harness.invoke('get-usage-stats');

      expect(result.recentSessions.length).toBe(10);
    });

    test('sends cost alert when threshold exceeded', async () => {
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 2.00;
      ctx.usageStats.totalSessionTimeMs = 6000000; // 100 min = $5.00

      await harness.invoke('get-usage-stats');

      expect(ctx.costAlertSent).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('cost-alert', {
        cost: '5.00',
        threshold: 2.00,
        message: expect.stringContaining('$5.00'),
      });
    });

    test('sends external notification when threshold exceeded and externalNotifier available', async () => {
      const mockNotify = jest.fn().mockResolvedValue({});
      ctx.externalNotifier = { notify: mockNotify };
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 2.00;
      ctx.usageStats.totalSessionTimeMs = 6000000; // 100 min = $5.00

      await harness.invoke('get-usage-stats');

      expect(mockNotify).toHaveBeenCalledWith({
        category: 'alert',
        title: 'Cost alert',
        message: expect.stringContaining('$5.00'),
      });
    });

    test('does not send cost alert when disabled', async () => {
      ctx.currentSettings.costAlertEnabled = false;
      ctx.usageStats.totalSessionTimeMs = 6000000; // $5.00

      await harness.invoke('get-usage-stats');

      expect(ctx.costAlertSent).toBe(false);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalledWith('cost-alert', expect.anything());
    });

    test('does not send duplicate cost alert', async () => {
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 2.00;
      ctx.costAlertSent = true; // Already sent
      ctx.usageStats.totalSessionTimeMs = 6000000;

      await harness.invoke('get-usage-stats');

      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalledWith('cost-alert', expect.anything());
    });

    test('does not send alert when below threshold', async () => {
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 10.00;
      ctx.usageStats.totalSessionTimeMs = 3600000; // 60 min = $3.00

      await harness.invoke('get-usage-stats');

      expect(ctx.costAlertSent).toBe(false);
    });

    test('uses default threshold when not set', async () => {
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = undefined;
      ctx.usageStats.totalSessionTimeMs = 6000000; // $5.00 >= default $5.00

      await harness.invoke('get-usage-stats');

      expect(ctx.costAlertSent).toBe(true);
    });

    test('handles destroyed mainWindow for cost alert', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 2.00;
      ctx.usageStats.totalSessionTimeMs = 6000000;

      await harness.invoke('get-usage-stats');

      expect(ctx.costAlertSent).toBe(true); // Still sets flag
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('handles null mainWindow for cost alert', async () => {
      ctx.mainWindow = null;
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 2.00;
      ctx.usageStats.totalSessionTimeMs = 6000000;

      // Should not throw
      const result = await harness.invoke('get-usage-stats');
      expect(result.totalSpawns).toBe(10);
    });

    test('returns cost alert settings in response', async () => {
      ctx.currentSettings.costAlertEnabled = true;
      ctx.currentSettings.costAlertThreshold = 7.50;
      ctx.costAlertSent = true;

      const result = await harness.invoke('get-usage-stats');

      expect(result.costAlertEnabled).toBe(true);
      expect(result.costAlertThreshold).toBe(7.50);
      expect(result.costAlertSent).toBe(true);
    });
  });

  describe('reset-usage-stats', () => {
    test('resets all stats to defaults', async () => {
      const result = await harness.invoke('reset-usage-stats');

      expect(result).toEqual({ success: true });
      expect(ctx.usageStats.totalSpawns).toBe(0);
      expect(ctx.usageStats.totalSessionTimeMs).toBe(0);
      expect(ctx.usageStats.sessionsToday).toBe(0);
      expect(ctx.usageStats.history).toEqual([]);
    });

    test('resets spawns per pane', async () => {
      await harness.invoke('reset-usage-stats');

      expect(ctx.usageStats.spawnsPerPane).toEqual({
        '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0,
      });
    });

    test('resets session time per pane', async () => {
      await harness.invoke('reset-usage-stats');

      expect(ctx.usageStats.sessionTimePerPane).toEqual({
        '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0,
      });
    });

    test('updates lastResetDate to today', async () => {
      const today = new Date().toISOString().split('T')[0];

      await harness.invoke('reset-usage-stats');

      expect(ctx.usageStats.lastResetDate).toBe(today);
    });

    test('resets cost alert sent flag', async () => {
      ctx.costAlertSent = true;

      await harness.invoke('reset-usage-stats');

      expect(ctx.costAlertSent).toBe(false);
    });

    test('calls saveUsageStats', async () => {
      await harness.invoke('reset-usage-stats');

      expect(deps.saveUsageStats).toHaveBeenCalled();
    });
  });
});
