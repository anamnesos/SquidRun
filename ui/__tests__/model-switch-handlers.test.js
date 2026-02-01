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

const path = require('path');
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
      },
      daemonClient: {
        connected: true,
        kill: jest.fn(),
        on: jest.fn((event, handler) => {
          // Store handler to be called manually
          if (event === 'exit') {
            mockCtx.daemonClient._exitHandler = handler;
          }
        }),
        off: jest.fn(),
        _exitHandler: null, // To store the handler
      },
      mainWindow: {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          send: jest.fn(),
        },
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

    it('should perform a full switch, save, and signal on success', async () => {
      // Get the promise for the handler
      const switchPromise = switchHandler({}, { paneId: '1', model: 'gemini' });

      // Check that kill was called
      expect(mockCtx.daemonClient.kill).toHaveBeenCalledWith('1');
      
      // Simulate the exit event from the daemon
      expect(mockCtx.daemonClient._exitHandler).toBeDefined();
      mockCtx.daemonClient._exitHandler({ paneId: '1' });

      // Wait for the handler promise to resolve
      const result = await switchPromise;

      // Verify settings were updated and saved
      const expectedGeminiCmd = `gemini --yolo --include-directories "${path.resolve(__dirname, '..', '..', 'workspace')}"`;
      expect(mockCtx.currentSettings.paneCommands['1']).toBe(expectedGeminiCmd);
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
      mockCtx.daemonClient._exitHandler({ paneId: '1' });
      await switchPromise;

      const expectedPath = path.resolve(__dirname, '..', '..', 'workspace');
      const expectedCommand = `gemini --yolo --include-directories "${expectedPath}"`;

      expect(mockCtx.currentSettings.paneCommands['1']).toBe(expectedCommand);
    });
  });
});
