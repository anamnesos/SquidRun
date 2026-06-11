/**
 * Tests for model-switch-handlers.js
 */

// Mock dependencies
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
  },
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// Mock config
jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { registerModelSwitchHandlers, executePaneModelSwitch } = require('../modules/ipc/model-switch-handlers');
const { executePaneControlAction } = require('../modules/main/pane-control-service');

describe('registerModelSwitchHandlers', () => {
  let mockCtx;
  let mockDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Mock context object passed to the function
    mockCtx = {
      ipcMain: require('electron').ipcMain,
      currentSettings: {
        geminiModel: 'gemini-3-pro-preview',
        paneCommands: {
          '1': 'claude',
          '3': 'gemini --yolo --model gemini-3-pro-preview',
        },
        paneProjects: {
          '1': null,
          '2': null,
          '3': null,
        },
        paneRoles: {
          '1': 'Architect',
          '3': 'Oracle',
        }
      },
      daemonClient: {
        connected: true,
        kill: jest.fn(),
        on: jest.fn((event, handler) => {
          // Store handler to be called manually
          // Listen for 'killed' event (not 'exit') - daemon emits 'killed' when kill() completes
          if (event === 'killed') {
            mockCtx.daemonClient._killedHandler = handler;
          }
        }),
        off: jest.fn(),
        _killedHandler: null, // To store the handler
      },
      mainWindow: {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          send: jest.fn(),
        },
      },
      recoveryManager: {
        markExpectedExit: jest.fn(),
      },
    };

    // Mock dependencies passed to the function
    mockDeps = {
      saveSettings: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should throw an error if ipcMain is not provided in ctx', () => {
    const invalidCtx = { ...mockCtx, ipcMain: null };
    expect(() => registerModelSwitchHandlers(invalidCtx, mockDeps)).toThrow(
      'registerModelSwitchHandlers requires ctx.ipcMain'
    );
  });

  it('should register "get-pane-commands" and "switch-pane-model" handlers', () => {
    registerModelSwitchHandlers(mockCtx, mockDeps);
    expect(ipcMain.handle).toHaveBeenCalledWith('get-pane-commands', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('switch-pane-model', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledTimes(2);
  });

  describe('"get-pane-commands" handler', () => {
    it('should return the current pane commands from settings', async () => {
      registerModelSwitchHandlers(mockCtx, mockDeps);
      const handler = ipcMain.handle.mock.calls.find(call => call[0] === 'get-pane-commands')[1];

      const result = await handler();

      expect(result).toEqual(mockCtx.currentSettings.paneCommands);
    });
  });

  describe('"switch-pane-model" handler', () => {
    let switchHandler;

    beforeEach(() => {
      registerModelSwitchHandlers(mockCtx, mockDeps);
      // Extract the handler function for 'switch-pane-model'
      const handlerCall = ipcMain.handle.mock.calls.find(call => call[0] === 'switch-pane-model');
      if (handlerCall) {
        switchHandler = handlerCall[1];
      }
    });

    it('should return an error for an invalid paneId', async () => {
      const result = await switchHandler({}, { paneId: '99', model: 'claude' });
      expect(result).toEqual({ success: false, error: 'Invalid paneId' });
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
    });

    it('should return an error for an unknown model', async () => {
      const result = await switchHandler({}, { paneId: '1', model: 'unknown-model' });
      expect(result).toEqual({ success: false, error: 'Unknown model' });
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
    });

    it('should call daemonClient.kill for the specified pane', async () => {
      switchHandler({}, { paneId: '1', model: 'codex' });
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('1');
    });

    it('should call recoveryManager.markExpectedExit before daemonClient.kill', async () => {
      // Track call order
      const callOrder = [];
      mockCtx.recoveryManager.markExpectedExit.mockImplementation(() => {
        callOrder.push('markExpectedExit');
      });
      mockCtx.daemonClient.kill.mockImplementation(() => {
        callOrder.push('kill');
      });

      switchHandler({}, { paneId: '2', model: 'claude' });

      // Verify markExpectedExit was called before kill
      expect(mockCtx.recoveryManager.markExpectedExit).toHaveBeenCalledWith('2', 'model-switch');
      expect(callOrder).toEqual(['markExpectedExit', 'kill']);
    });

    it('should broadcast model switch to all agents via trigger file', async () => {
      // Get the promise for the handler
      const switchPromise = switchHandler({}, { paneId: '2', model: 'codex' });

      // Simulate the exit event
      mockCtx.daemonClient._killedHandler('2');

      await switchPromise;

      // Verify broadcast was written to all.txt trigger file
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('all.txt'),
        '(SYSTEM): Builder switched to Codex\n'
      );
    });

    it('should perform a full switch, save, and signal on success', async () => {
      // Get the promise for the handler
      const switchPromise = switchHandler({}, { paneId: '1', model: 'gemini' });

      // Check that kill was called
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('1');

      // Simulate the exit event from the daemon
      expect(mockCtx.daemonClient._killedHandler).toBeDefined();
      mockCtx.daemonClient._killedHandler('1');

      // Wait for the handler promise to resolve
      const result = await switchPromise;

      // Verify settings were updated and saved
      expect(mockCtx.currentSettings.paneCommands['1']).toBe('gemini --yolo --model gemini-3-pro-preview');
      expect(mockCtx.currentSettings.geminiModel).toBe('gemini-3-pro-preview');
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({
        paneCommands: mockCtx.currentSettings.paneCommands,
        geminiModel: 'gemini-3-pro-preview',
      });

      // Verify renderer was signaled
      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-model-changed', {
        paneId: '1',
        model: 'gemini',
        ownerWindowKey: 'main',
      });

      // Verify success result
      expect(result).toEqual({ success: true, paneId: '1', model: 'gemini' });
    });

    it('fans pane-model-changed out via deps.sendPaneModelChanged when provided (wave 3)', async () => {
      const sendPaneModelChanged = jest.fn();
      const { executePaneModelSwitch } = require('../modules/ipc/model-switch-handlers');
      const switchPromise = executePaneModelSwitch(
        mockCtx,
        { paneId: '2', model: 'claude' },
        { ...mockDeps, sendPaneModelChanged }
      );
      mockCtx.daemonClient._killedHandler('2');
      const result = await switchPromise;
      expect(result.success).toBe(true);
      // The seam carries the completion; mainWindow-only send must NOT fire
      // (the squid room's dropdown depended on exactly this fan-out).
      expect(sendPaneModelChanged).toHaveBeenCalledWith({
        paneId: '2',
        model: 'claude',
        ownerWindowKey: 'main',
      });
      expect(mockCtx.mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'pane-model-changed',
        { paneId: '2', model: 'claude' }
      );
    });

    it('switches Squid Room arm panes by persisting the arm command and signaling the owner window', async () => {
      const sendPaneModelChanged = jest.fn();
      const paneRestartArbiter = {
        getActiveClaim: jest.fn(() => null),
        resolveOwner: jest.fn(() => ({
          ownerWindowKey: 'squid-room',
          ownerProfileName: 'main',
          ownerSessionScopeId: 'app-session-428:squid-room',
          ownerInstance: {
            profileName: 'main',
            windowKey: 'squid-room',
            sessionScopeId: 'app-session-428:squid-room',
          },
        })),
      };
      const { executePaneModelSwitch } = require('../modules/ipc/model-switch-handlers');

      const result = await executePaneModelSwitch(
        mockCtx,
        { paneId: 'trustquote-app', model: 'claude' },
        { ...mockDeps, sendPaneModelChanged, paneRestartArbiter }
      );

      expect(result).toEqual({ success: true, paneId: 'trustquote-app', model: 'claude' });
      expect(paneRestartArbiter.getActiveClaim).toHaveBeenCalledWith('trustquote-app');
      expect(paneRestartArbiter.resolveOwner).toHaveBeenCalledWith('trustquote-app');
      expect(mockCtx.recoveryManager.markExpectedExit).not.toHaveBeenCalled();
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
      expect(mockCtx.currentSettings.paneCommands['trustquote-app']).toBe('claude');
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('all.txt'),
        '(SYSTEM): TrustQuote App switched to Claude\n'
      );
      expect(sendPaneModelChanged).toHaveBeenCalledWith({
        paneId: 'trustquote-app',
        model: 'claude',
        ownerWindowKey: 'squid-room',
        ownerProfileName: 'main',
        ownerSessionScopeId: 'app-session-428:squid-room',
        ownerInstance: {
          profileName: 'main',
          windowKey: 'squid-room',
          sessionScopeId: 'app-session-428:squid-room',
        },
        command: 'claude',
      });
    });

    it('should proceed after a timeout if exit event is not received', async () => {
      const logger = require('../modules/logger');

      // Get the promise for the handler
      const switchPromise = switchHandler({}, { paneId: '3', model: 'claude' });

      // Ensure kill was still called
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('3');

      // Advance timers to trigger the timeout
      jest.advanceTimersByTime(2000);

      // Wait for the handler to resolve after the timeout
      const result = await switchPromise;

      // Check that a warning was logged
      expect(logger.warn).toHaveBeenCalledWith('ModelSwitch', 'Kill timeout for Pane 3, proceeding anyway');

      // Verify settings were still updated and saved
      expect(mockCtx.currentSettings.paneCommands['3']).toBe('claude');
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });

      // Verify renderer was still signaled
      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-model-changed', {
        paneId: '3',
        model: 'claude',
        ownerWindowKey: 'main',
      });

      // Verify it still returns success
      expect(result).toEqual({ success: true, paneId: '3', model: 'claude' });
    });

    it('should construct the gemini command with explicit model', async () => {
      const switchPromise = switchHandler({}, { paneId: '1', model: 'gemini' });
      mockCtx.daemonClient._killedHandler('1');
      await switchPromise;

      expect(mockCtx.currentSettings.paneCommands['1']).toBe('gemini --yolo --model gemini-3-pro-preview');
    });

    it('ignores include-directory defaults even when paneProjects is assigned', async () => {
      mockCtx.currentSettings.paneProjects['1'] = '<external-project-root>';
      const switchPromise = switchHandler({}, { paneId: '1', model: 'gemini' });
      mockCtx.daemonClient._killedHandler('1');
      await switchPromise;

      expect(mockCtx.currentSettings.paneCommands['1']).toBe('gemini --yolo --model gemini-3-pro-preview');
    });

    it('should handle missing daemonClient gracefully', async () => {
      mockCtx.daemonClient = null;
      const result = await switchHandler({}, { paneId: '1', model: 'claude' });
      expect(result.success).toBe(true);
      expect(mockCtx.currentSettings.paneCommands['1']).toBe('claude');
    });

    it('should handle disconnected daemonClient gracefully', async () => {
      mockCtx.daemonClient.connected = false;
      const switchPromise = switchHandler({}, { paneId: '1', model: 'claude' });
      
      // Advance timers to trigger the timeout (since kill is skipped)
      jest.advanceTimersByTime(2000);
      
      const result = await switchPromise;
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle missing mainWindow gracefully', async () => {
      mockCtx.mainWindow = null;
      const switchPromise = switchHandler({}, { paneId: '1', model: 'claude' });
      
      // Simulate exit
      mockCtx.daemonClient._killedHandler('1');
      
      const result = await switchPromise;
      expect(result.success).toBe(true);
    });

    it('should handle missing saveSettings gracefully', async () => {
      // Re-register with empty deps
      ipcMain.handle.mockClear();
      registerModelSwitchHandlers(mockCtx, {});
      const handlerCall = ipcMain.handle.mock.calls.find(call => call[0] === 'switch-pane-model');
      const localSwitchHandler = handlerCall[1];

      const switchPromise = localSwitchHandler({}, { paneId: '1', model: 'claude' });
      
      // Simulate exit
      mockCtx.daemonClient._killedHandler('1');
      
      const result = await switchPromise;
      expect(result.success).toBe(true);
    });

    it('should handle numeric paneId correctly', async () => {
      const switchPromise = switchHandler({}, { paneId: 1, model: 'claude' });

      // Simulate exit
      mockCtx.daemonClient._killedHandler('1');

      const result = await switchPromise;
      expect(result.success).toBe(true);
      expect(result.paneId).toBe(1);
    });
  });

  describe('executePaneModelSwitch (shared flow / remote entry points)', () => {
    it('is blocked while a restart lease is open, leaves the lease undisturbed, and succeeds after completion', async () => {
      let activeClaim = { claimId: 'lease-1', paneId: '1', source: 'watchdog' };
      const paneRestartArbiter = {
        getActiveClaim: jest.fn(() => activeClaim),
      };

      const blocked = await executePaneModelSwitch(mockCtx, { paneId: '1', model: 'codex' }, {
        saveSettings: mockDeps.saveSettings,
        paneRestartArbiter,
      });

      expect(blocked).toEqual(expect.objectContaining({
        success: false,
        reason: 'model_switch_blocked_restart_in_progress',
        activeClaimId: 'lease-1',
        paneId: '1',
      }));
      expect(paneRestartArbiter.getActiveClaim).toHaveBeenCalledWith('1');
      expect(mockCtx.recoveryManager.markExpectedExit).not.toHaveBeenCalled();
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
      expect(mockDeps.saveSettings).not.toHaveBeenCalled();
      expect(mockCtx.mainWindow.webContents.send).not.toHaveBeenCalled();

      // Lease completes (arbiter releases it) - second attempt succeeds
      activeClaim = null;
      const retryPromise = executePaneModelSwitch(mockCtx, { paneId: '1', model: 'codex' }, {
        saveSettings: mockDeps.saveSettings,
        paneRestartArbiter,
      });
      mockCtx.daemonClient._killedHandler('1');
      const retry = await retryPromise;

      expect(retry).toEqual(expect.objectContaining({ success: true, model: 'codex' }));
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('1');
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });
    });

    it('WS pane-control switch-model path persists settings and signals pane-model-changed exactly once', async () => {
      const paneControlCtx = {
        instanceScope: { profileName: 'main', windowKey: 'main' },
        switchPaneModel: (paneId, model) => executePaneModelSwitch(mockCtx, { paneId, model }, {
          saveSettings: mockDeps.saveSettings,
          paneRestartArbiter: { getActiveClaim: jest.fn(() => null) },
        }),
      };

      const resultPromise = executePaneControlAction(paneControlCtx, 'switch-model', {
        paneId: '1',
        model: 'codex',
        targetInstance: { profileName: 'main', windowKey: 'main' },
      });
      mockCtx.daemonClient._killedHandler('1');
      const result = await resultPromise;

      expect(result).toEqual(expect.objectContaining({
        success: true,
        paneId: '1',
        action: 'switch-model',
        method: 'switch-pane-model',
        model: 'codex',
      }));
      expect(mockCtx.currentSettings.paneCommands['1']).toBe('codex');
      expect(mockDeps.saveSettings).toHaveBeenCalledTimes(1);
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });
      const modelChangedSends = mockCtx.mainWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'pane-model-changed');
      expect(modelChangedSends).toEqual([
        ['pane-model-changed', { paneId: '1', model: 'codex', ownerWindowKey: 'main' }],
      ]);
    });

    it('rejects an invalid model through the WS path without touching the pane', async () => {
      const paneControlCtx = {
        instanceScope: { profileName: 'main', windowKey: 'main' },
        switchPaneModel: (paneId, model) => executePaneModelSwitch(mockCtx, { paneId, model }, {
          saveSettings: mockDeps.saveSettings,
          paneRestartArbiter: { getActiveClaim: jest.fn(() => null) },
        }),
      };

      const result = await executePaneControlAction(paneControlCtx, 'switch-model', {
        paneId: '1',
        model: 'not-a-model',
        targetInstance: { profileName: 'main', windowKey: 'main' },
      });

      expect(result).toEqual(expect.objectContaining({
        success: false,
        reason: 'Unknown model',
        paneId: '1',
      }));
      expect(mockCtx.daemonClient.kill).not.toHaveBeenCalled();
      expect(mockDeps.saveSettings).not.toHaveBeenCalled();
      expect(mockCtx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('normalizes model casing from remote callers', async () => {
      const switchPromise = executePaneModelSwitch(mockCtx, { paneId: '1', model: 'Codex' }, {
        saveSettings: mockDeps.saveSettings,
      });
      mockCtx.daemonClient._killedHandler('1');
      const result = await switchPromise;

      expect(result).toEqual(expect.objectContaining({ success: true, model: 'codex' }));
      expect(mockCtx.currentSettings.paneCommands['1']).toBe('codex');
    });
  });
});
