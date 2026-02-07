/**
 * Auto-Nudge IPC Handler Tests
 * Target: Full coverage of auto-nudge-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');
const { PANE_IDS } = require('../config');

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { registerAutoNudgeHandlers } = require('../modules/ipc/auto-nudge-handlers');

describe('Auto-Nudge Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Make isDestroyed a mock function
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Add agentRunning state (renamed from claudeRunning)
    ctx.agentRunning = new Map();
    ctx.agentRunning.set('1', 'running');
    ctx.agentRunning.set('2', 'idle');

    // Add daemon client with getLastActivity
    ctx.daemonClient = {
      connected: true,
      getLastActivity: jest.fn(() => Date.now() - 30000), // 30 seconds ago
    };

    registerAutoNudgeHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('nudge-agent', () => {
    test('sends nudge message to running agent', async () => {
      const result = await harness.invoke('nudge-agent', '1');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('inject-message', {
        panes: ['1'],
        message: expect.stringContaining('[HIVEMIND]'),
      });
      expect(result).toEqual({ success: true, pane: '1' });
    });

    test('uses custom message when provided', async () => {
      await harness.invoke('nudge-agent', '1', 'Custom nudge message');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('inject-message', {
        panes: ['1'],
        message: 'Custom nudge message\r',
      });
    });

    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;

      const result = await harness.invoke('nudge-agent', '1');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when daemonClient is null', async () => {
      ctx.daemonClient = null;

      const result = await harness.invoke('nudge-agent', '1');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when agent not running', async () => {
      const result = await harness.invoke('nudge-agent', '2');

      expect(result).toEqual({ success: false, error: 'Agent not running in this pane' });
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('nudge-agent', '1');

      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, pane: '1' });
    });

    test('handles null mainWindow gracefully', async () => {
      ctx.mainWindow = null;

      const result = await harness.invoke('nudge-agent', '1');

      expect(result).toEqual({ success: true, pane: '1' });
    });
  });

  describe('nudge-all-stuck', () => {
    test('nudges agents past stuck threshold', async () => {
      ctx.currentSettings.stuckThreshold = 60000; // 1 minute
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 120000); // 2 minutes ago

      const result = await harness.invoke('nudge-all-stuck');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('inject-message', expect.objectContaining({
        panes: ['1'],
      }));
      expect(result.success).toBe(true);
      expect(result.nudged).toContain('1');
    });

    test('does not nudge agents within threshold', async () => {
      ctx.currentSettings.stuckThreshold = 60000;
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 30000); // 30 seconds ago

      const result = await harness.invoke('nudge-all-stuck');

      expect(result.nudged).toEqual([]);
    });

    test('uses default threshold when not set', async () => {
      ctx.currentSettings.stuckThreshold = undefined;
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 120000);

      const result = await harness.invoke('nudge-all-stuck');

      expect(result.nudged).toContain('1');
    });

    test('only nudges running agents', async () => {
      ctx.agentRunning.set('2', 'running');
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 120000);

      const result = await harness.invoke('nudge-all-stuck');

      // Both running agents should be nudged
      expect(result.nudged).toContain('1');
      expect(result.nudged).toContain('2');
    });

    test('handles null lastActivity', async () => {
      ctx.daemonClient.getLastActivity.mockReturnValue(null);

      const result = await harness.invoke('nudge-all-stuck');

      expect(result.nudged).toEqual([]);
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 120000);

      const result = await harness.invoke('nudge-all-stuck');

      // Agent is still considered nudged even if window is destroyed
      // (the nudge is tracked, just not sent to UI)
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
      expect(result.nudged).toContain('1');
    });
  });

  describe('get-agent-health', () => {
    beforeEach(() => {
      // Setup additional daemon client properties
      ctx.daemonClient.terminals = new Map();
      ctx.daemonClient.terminals.set('1', { stuckCount: 2 });
    });

    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;

      const result = await harness.invoke('get-agent-health');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when daemonClient is null', async () => {
      ctx.daemonClient = null;

      const result = await harness.invoke('get-agent-health');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns health data for all configured panes', async () => {
      const extraPane = PANE_IDS.find(id => id !== '1' && id !== '2');
      if (extraPane) {
        ctx.agentRunning.set(extraPane, 'running');
      }

      const result = await harness.invoke('get-agent-health');

      expect(result.success).toBe(true);
      expect(Object.keys(result.agents)).toHaveLength(PANE_IDS.length);
      expect(result.agents['1'].alive).toBe(true);
      expect(result.agents['1'].status).toBe('running');
    });

    test('includes lastActivity from daemonClient', async () => {
      const testTime = Date.now() - 5000;
      ctx.daemonClient.getLastActivity.mockReturnValue(testTime);

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].lastActivity).toBe(testTime);
      expect(result.agents['1'].lastOutput).toBe(testTime);
    });

    test('marks dead when terminal is not alive', async () => {
      ctx.daemonClient.terminals.set('1', { alive: false });

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].status).toBe('dead');
      expect(result.agents['1'].alive).toBe(false);
    });

    test('handles null lastActivity', async () => {
      ctx.daemonClient.getLastActivity.mockReturnValue(null);

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].lastActivity).toBeNull();
    });

    test('gets stuckCount from terminal', async () => {
      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].stuckCount).toBe(2);
    });

    test('defaults stuckCount to 0', async () => {
      ctx.daemonClient.terminals = new Map(); // No terminal data

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].stuckCount).toBe(0);
    });

    test('includes recovery status when manager available', async () => {
      ctx.recoveryManager = {
        getStatus: jest.fn().mockReturnValue({
          '1': { status: 'restarting', stuckCount: 5, recoveryStep: 'restart' },
        }),
      };

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].recovering).toBe(true);
      expect(result.agents['1'].recoveryStep).toBe('restart');
      expect(result.agents['1'].stuckCount).toBe(5);
    });

    test('detects restarting status for recovery', async () => {
      ctx.recoveryManager = {
        getStatus: jest.fn().mockReturnValue({
          '1': { status: 'restarting' },
        }),
      };

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].recovering).toBe(true);
      expect(result.agents['1'].recoveryStep).toBe('restart');
    });

    test('detects stuck status for recovery', async () => {
      ctx.recoveryManager = {
        getStatus: jest.fn().mockReturnValue({
          '1': { status: 'stuck' },
        }),
      };

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].recovering).toBe(true);
      expect(result.agents['1'].recoveryStep).toBe('interrupt');
    });

    test('handles missing recovery manager', async () => {
      ctx.recoveryManager = null;

      const result = await harness.invoke('get-agent-health');

      expect(result.success).toBe(true);
      expect(result.agents['1'].recoveryStep).toBe('none');
      expect(result.agents['1'].recovering).toBe(false);
    });

    test('uses deps.recoveryManager if provided', async () => {
      const depsManager = {
        getStatus: jest.fn().mockReturnValue({
          '1': { status: 'restarting' },
        }),
      };

      // Re-register with deps
      harness = createIpcHarness();
      ctx = createDefaultContext({ ipcMain: harness.ipcMain });
      ctx.mainWindow.isDestroyed = jest.fn(() => false);
      ctx.agentRunning = new Map([['1', 'running']]);
      ctx.daemonClient = { connected: true, getLastActivity: jest.fn(), terminals: new Map() };

      registerAutoNudgeHandlers(ctx, { recoveryManager: depsManager });

      const result = await harness.invoke('get-agent-health');

      expect(depsManager.getStatus).toHaveBeenCalled();
      expect(result.agents['1'].recovering).toBe(true);
    });

    test('handles missing agentRunning gracefully', async () => {
      ctx.agentRunning = null;

      const result = await harness.invoke('get-agent-health');

      expect(result.success).toBe(true);
      expect(result.agents['1'].status).toBe('unknown');
    });

    test('marks stale when running and idle beyond threshold', async () => {
      ctx.currentSettings.stuckThreshold = 1000;
      ctx.daemonClient.getLastActivity.mockReturnValue(Date.now() - 2000);
      ctx.daemonClient.terminals.set('1', { alive: true });

      const result = await harness.invoke('get-agent-health');

      expect(result.agents['1'].status).toBe('stale');
      expect(result.agents['1'].idleMs).toBeGreaterThan(1000);
    });
  });

  describe('nudge-pane', () => {
    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;

      const result = await harness.invoke('nudge-pane', '1');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when paneId missing', async () => {
      const result = await harness.invoke('nudge-pane', null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('returns error when paneId is empty string', async () => {
      const result = await harness.invoke('nudge-pane', '');

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('sends nudge-pane event to renderer', async () => {
      const result = await harness.invoke('nudge-pane', '2');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('2');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('nudge-pane', { paneId: '2' });
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('nudge-pane', '1');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('handles null mainWindow gracefully', async () => {
      ctx.mainWindow = null;

      const result = await harness.invoke('nudge-pane', '1');

      expect(result.success).toBe(true);
    });
  });

  describe('restart-pane', () => {
    beforeEach(() => {
      ctx.recoveryManager = {
        markExpectedExit: jest.fn(),
        getStatus: jest.fn().mockReturnValue({}),
      };
    });

    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;

      const result = await harness.invoke('restart-pane', '1');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when paneId missing', async () => {
      const result = await harness.invoke('restart-pane', null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('marks expected exit and sends restart event', async () => {
      const result = await harness.invoke('restart-pane', '3');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('3');
      expect(ctx.recoveryManager.markExpectedExit).toHaveBeenCalledWith('3', 'manual-restart');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('restart-pane', { paneId: '3' });
    });

    test('handles missing recovery manager', async () => {
      ctx.recoveryManager = null;

      const result = await harness.invoke('restart-pane', '1');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalled();
    });

    test('handles recovery manager without markExpectedExit', async () => {
      ctx.recoveryManager = { getStatus: jest.fn() };

      const result = await harness.invoke('restart-pane', '1');

      expect(result.success).toBe(true);
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('restart-pane', '1');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('restart-all-panes', () => {
    beforeEach(() => {
      ctx.recoveryManager = {
        markExpectedExit: jest.fn(),
        getStatus: jest.fn().mockReturnValue({}),
      };
    });

    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;

      const result = await harness.invoke('restart-all-panes');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('marks expected exit for all configured panes', async () => {
      const result = await harness.invoke('restart-all-panes');

      expect(result.success).toBe(true);
      expect(ctx.recoveryManager.markExpectedExit).toHaveBeenCalledTimes(PANE_IDS.length);
      for (const paneId of PANE_IDS) {
        expect(ctx.recoveryManager.markExpectedExit).toHaveBeenCalledWith(String(paneId), 'manual-restart-all');
      }
    });

    test('sends restart-all-panes event to renderer', async () => {
      const result = await harness.invoke('restart-all-panes');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('restart-all-panes', {});
    });

    test('handles missing recovery manager', async () => {
      ctx.recoveryManager = null;

      const result = await harness.invoke('restart-all-panes');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalled();
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('restart-all-panes');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
