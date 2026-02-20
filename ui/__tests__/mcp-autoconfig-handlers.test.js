/**
 * MCP Autoconfig IPC Handler Tests
 * Target: Full coverage of mcp-autoconfig-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock child_process
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { execFile } = require('child_process');
const { registerMcpAutoconfigHandlers } = require('../modules/ipc/mcp-autoconfig-handlers');

describe('MCP Autoconfig Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Default: execFile succeeds
    execFile.mockImplementation((command, args, opts, callback) => {
      callback(null, 'success');
    });

    registerMcpAutoconfigHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerMcpAutoconfigHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerMcpAutoconfigHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('mcp-configure-agent', () => {
    test('configures MCP agent successfully', async () => {
      const result = await harness.invoke('mcp-configure-agent', '1');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('1');
      expect(result.serverName).toBe('hivemind-1');
      expect(execFile).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['mcp', 'add', 'hivemind-1']),
        expect.any(Object),
        expect.any(Function)
      );
    });

    test('sends mcp-agent-connecting event on success', async () => {
      await harness.invoke('mcp-configure-agent', '2');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('mcp-agent-connecting', { paneId: '2' });
    });

    test('handles exec error', async () => {
      execFile.mockImplementation((command, args, opts, callback) => {
        callback(new Error('Command failed'));
      });

      const result = await harness.invoke('mcp-configure-agent', '1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Command failed');
    });

    test('sends mcp-agent-error event on failure', async () => {
      execFile.mockImplementation((command, args, opts, callback) => {
        callback(new Error('Config failed'));
      });

      await harness.invoke('mcp-configure-agent', '3');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('mcp-agent-error', {
        paneId: '3',
        error: 'Config failed',
      });
    });

    test('handles null mainWindow gracefully', async () => {
      ctx.mainWindow = null;

      const result = await harness.invoke('mcp-configure-agent', '1');

      expect(result.success).toBe(true);
    });
  });

  describe('mcp-reconnect-agent', () => {
    test('reconnects agent successfully', async () => {
      const result = await harness.invoke('mcp-reconnect-agent', '4');

      expect(result.success).toBe(true);
      expect(result.serverName).toBe('hivemind-4');
    });

    test('handles reconnect error', async () => {
      execFile.mockImplementation((command, args, opts, callback) => {
        callback(new Error('Reconnect failed'));
      });

      const result = await harness.invoke('mcp-reconnect-agent', '1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reconnect failed');
    });
  });

  describe('mcp-remove-agent-config', () => {
    test('removes agent config successfully', async () => {
      const result = await harness.invoke('mcp-remove-agent-config', '3');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('3');
      expect(execFile).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['mcp', 'remove', 'hivemind-3']),
        expect.any(Object),
        expect.any(Function)
      );
    });

    test('sends mcp-agent-disconnected event on success', async () => {
      await harness.invoke('mcp-remove-agent-config', '6');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('mcp-agent-disconnected', { paneId: '6' });
    });

    test('handles remove error', async () => {
      execFile.mockImplementation((command, args, opts, callback) => {
        callback(new Error('Remove failed'));
      });

      const result = await harness.invoke('mcp-remove-agent-config', '1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Remove failed');
    });
  });
});
