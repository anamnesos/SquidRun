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
jest.mock('../config', () => ({
  INSTANCE_DIRS: {
    '1': '/mock/instances/lead',
    '5': '/mock/instances/investigator',
  },
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Infra',
    '3': 'Frontend',
    '4': 'Backend',
    '5': 'Analyst',
    '6': 'Reviewer',
  },
}));

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { registerModelSwitchHandlers } = require('../modules/ipc/model-switch-handlers');

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
        paneCommands: {
          '1': 'claude',
          '5': 'gemini --yolo --include-directories "D:\\projects\\hivemind\\workspace"',
        },
        paneRoles: {
          '1': 'Architect',
          '5': 'Analyst',
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
      contextInjection: {
        injectContext: jest.fn().mockResolvedValue(undefined),
      },
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
      const switchPromise = switchHandler({}, { paneId: '3', model: 'codex' });

      // Simulate the exit event
      mockCtx.daemonClient._killedHandler('3');

      await switchPromise;

      // Verify broadcast was written to all.txt trigger file
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('all.txt'),
        '(SYSTEM): Frontend switched to Codex\n'
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

      // Verify settings were updated and saved (using string check to bypass path resolution issues in mock)
      expect(mockCtx.currentSettings.paneCommands['1']).toMatch(/gemini --yolo --include-directories ".*workspace"/);
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });

      // Verify renderer was signaled
      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-model-changed', { paneId: '1', model: 'gemini' });

      // Verify success result
      expect(result).toEqual({ success: true, paneId: '1', model: 'gemini' });
    });

    it('should proceed after a timeout if exit event is not received', async () => {
      const logger = require('../modules/logger');

      // Get the promise for the handler
      const switchPromise = switchHandler({}, { paneId: '5', model: 'claude' });

      // Ensure kill was still called
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('5');

      // Advance timers to trigger the timeout
      jest.advanceTimersByTime(2000);

      // Wait for the handler to resolve after the timeout
      const result = await switchPromise;

      // Check that a warning was logged
      expect(logger.warn).toHaveBeenCalledWith('ModelSwitch', 'Kill timeout for pane 5, proceeding anyway');

      // Verify settings were still updated and saved
      expect(mockCtx.currentSettings.paneCommands['5']).toBe('claude');
      expect(mockDeps.saveSettings).toHaveBeenCalledWith({ paneCommands: mockCtx.currentSettings.paneCommands });

      // Verify renderer was still signaled
      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-model-changed', { paneId: '5', model: 'claude' });

      // Verify it still returns success
      expect(result).toEqual({ success: true, paneId: '5', model: 'claude' });
    });

    it('should construct the gemini command with the correct workspace path', async () => {
      const switchPromise = switchHandler({}, { paneId: '1', model: 'gemini' });
      mockCtx.daemonClient._killedHandler('1');
      await switchPromise;

      expect(mockCtx.currentSettings.paneCommands['1']).toMatch(/gemini --yolo --include-directories ".*workspace"/);
    });

    it('should auto-inject context files after model switch', async () => {
      const switchPromise = switchHandler({}, { paneId: '1', model: 'claude' });
      mockCtx.daemonClient._killedHandler('1');
      await switchPromise;

      // Verify contextInjection.injectContext was called with correct params
      // delay is 5000ms for claude, 6000ms for codex
      expect(mockDeps.contextInjection.injectContext).toHaveBeenCalledWith('1', 'claude', 5000);
    });

    it('should use longer delay for codex context injection', async () => {
      const switchPromise = switchHandler({}, { paneId: '1', model: 'codex' });
      mockCtx.daemonClient._killedHandler('1');
      await switchPromise;

      // Codex gets 6000ms delay
      expect(mockDeps.contextInjection.injectContext).toHaveBeenCalledWith('1', 'codex', 6000);
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
});
