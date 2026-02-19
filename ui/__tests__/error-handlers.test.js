/**
 * Error IPC Handler Tests
 * Target: Full coverage of error-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

// Mock the logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { registerErrorHandlers } = require('../modules/ipc/error-handlers');

describe('Error Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Make isDestroyed a mock function
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    deps = createDepsMock();
    registerErrorHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerErrorHandlers(null)).toThrow('registerErrorHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerErrorHandlers({})).toThrow('registerErrorHandlers requires ctx.ipcMain');
    });
  });

  describe('get-error-message', () => {
    test('returns error info for known error code', async () => {
      const result = await harness.invoke('get-error-message', 'DAEMON_NOT_CONNECTED');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Daemon Disconnected');
      expect(result.message).toContain('not running');
      expect(result.recovery).toContain('npm run daemon:start');
    });

    test('returns error info for CLAUDE_NOT_FOUND', async () => {
      const result = await harness.invoke('get-error-message', 'CLAUDE_NOT_FOUND');

      expect(result.success).toBe(true);
      expect(result.title).toBe('CLI Not Found');
    });

    test('returns error info for PROJECT_NOT_FOUND', async () => {
      const result = await harness.invoke('get-error-message', 'PROJECT_NOT_FOUND');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Project Not Found');
    });

    test('returns error info for FILE_WRITE_ERROR', async () => {
      const result = await harness.invoke('get-error-message', 'FILE_WRITE_ERROR');

      expect(result.success).toBe(true);
      expect(result.title).toBe('File Write Failed');
    });

    test('returns error info for TEST_TIMEOUT', async () => {
      const result = await harness.invoke('get-error-message', 'TEST_TIMEOUT');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Test Timeout');
    });

    test('returns error info for GIT_NOT_FOUND', async () => {
      const result = await harness.invoke('get-error-message', 'GIT_NOT_FOUND');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Git Not Found');
    });

    test('returns error info for VALIDATION_FAILED', async () => {
      const result = await harness.invoke('get-error-message', 'VALIDATION_FAILED');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Validation Failed');
    });

    test('returns error info for STATE_TRANSITION_BLOCKED', async () => {
      const result = await harness.invoke('get-error-message', 'STATE_TRANSITION_BLOCKED');

      expect(result.success).toBe(true);
      expect(result.title).toBe('Transition Blocked');
    });

    test('returns fallback for unknown error code', async () => {
      const result = await harness.invoke('get-error-message', 'UNKNOWN_ERROR');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error code');
      expect(result.fallback.title).toBe('Error');
    });
  });

  describe('show-error-toast', () => {
    test('sends error toast to mainWindow', async () => {
      const result = await harness.invoke('show-error-toast', 'DAEMON_NOT_CONNECTED');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('error-toast', expect.objectContaining({
        title: 'Daemon Disconnected',
        code: 'DAEMON_NOT_CONNECTED',
        timestamp: expect.any(String),
      }));
      expect(result).toEqual({ success: true, shown: true });
    });

    test('includes additional info in toast', async () => {
      await harness.invoke('show-error-toast', 'TEST_TIMEOUT', { testName: 'my-test' });

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('error-toast', expect.objectContaining({
        testName: 'my-test',
      }));
    });

    test('logs activity when logActivity provided', async () => {
      await harness.invoke('show-error-toast', 'GIT_NOT_FOUND');

      expect(deps.logActivity).toHaveBeenCalledWith(
        'error',
        null,
        expect.stringContaining('Git Not Found'),
        expect.any(Object)
      );
    });

    test('handles destroyed mainWindow gracefully', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('show-error-toast', 'DAEMON_NOT_CONNECTED');

      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, shown: true });
    });

    test('handles null mainWindow gracefully', async () => {
      ctx.mainWindow = null;

      const result = await harness.invoke('show-error-toast', 'DAEMON_NOT_CONNECTED');

      expect(result).toEqual({ success: true, shown: true });
    });

    test('uses fallback for unknown error code', async () => {
      await harness.invoke('show-error-toast', 'CUSTOM_ERROR', { message: 'Custom message' });

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('error-toast', expect.objectContaining({
        title: 'Error',
        message: 'Custom message',
      }));
    });
  });

  describe('list-error-codes', () => {
    test('returns all error codes', async () => {
      const result = await harness.invoke('list-error-codes');

      expect(result.success).toBe(true);
      expect(result.codes).toContain('DAEMON_NOT_CONNECTED');
      expect(result.codes).toContain('CLAUDE_NOT_FOUND');
      expect(result.codes).toContain('FILE_WRITE_ERROR');
      expect(result.errors).toBeDefined();
      expect(result.errors.DAEMON_NOT_CONNECTED).toBeDefined();
    });
  });

  describe('handle-error', () => {
    test('maps daemon error to DAEMON_NOT_CONNECTED', async () => {
      const result = await harness.invoke('handle-error', { message: 'daemon not connected' });

      expect(result).toEqual({ success: true, code: 'DAEMON_NOT_CONNECTED', handled: true });
    });

    test('maps claude not found to CLAUDE_NOT_FOUND', async () => {
      const result = await harness.invoke('handle-error', { message: 'claude not found in PATH' });

      expect(result.code).toBe('CLAUDE_NOT_FOUND');
    });

    test('maps codex not found to CLAUDE_NOT_FOUND', async () => {
      const result = await harness.invoke('handle-error', { message: 'codex not found' });

      expect(result.code).toBe('CLAUDE_NOT_FOUND');
    });

    test('maps gemini not found to CLAUDE_NOT_FOUND', async () => {
      const result = await harness.invoke('handle-error', { message: 'gemini not found' });

      expect(result.code).toBe('CLAUDE_NOT_FOUND');
    });

    test('maps ENOENT to PROJECT_NOT_FOUND', async () => {
      const result = await harness.invoke('handle-error', { message: 'ENOENT: no such file' });

      expect(result.code).toBe('PROJECT_NOT_FOUND');
    });

    test('maps EACCES to FILE_WRITE_ERROR', async () => {
      const result = await harness.invoke('handle-error', { message: 'EACCES: permission denied' });

      expect(result.code).toBe('FILE_WRITE_ERROR');
    });

    test('maps timeout to TEST_TIMEOUT', async () => {
      const result = await harness.invoke('handle-error', { message: 'test timeout exceeded' });

      expect(result.code).toBe('TEST_TIMEOUT');
    });

    test('maps git error to GIT_NOT_FOUND', async () => {
      const result = await harness.invoke('handle-error', { message: 'git command failed' });

      expect(result.code).toBe('GIT_NOT_FOUND');
    });

    test('uses UNKNOWN for unrecognized errors', async () => {
      const result = await harness.invoke('handle-error', { message: 'some random error' });

      expect(result.code).toBe('UNKNOWN');
    });

    test('handles string error', async () => {
      const result = await harness.invoke('handle-error', 'daemon failed');

      expect(result.code).toBe('DAEMON_NOT_CONNECTED');
    });

    test('passes context to toast', async () => {
      await harness.invoke('handle-error', { message: 'error' }, { paneId: '1' });

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('error-toast', expect.objectContaining({
        paneId: '1',
      }));
    });
  });

  describe('full-restart', () => {
    test('handler is registered', async () => {
      expect(harness.handlers.has('full-restart')).toBe(true);
    });
  });
});

// Separate describe block for full-restart tests with proper mocking
describe('full-restart handler', () => {
  let mockApp;
  let mockSpawn;
  let mockFs;
  let mockPath;
  let harness;
  let ctx;

  beforeEach(() => {
    jest.resetModules();

    mockApp = { exit: jest.fn() };
    mockSpawn = jest.fn(() => ({}));
    mockFs = {
      existsSync: jest.fn(() => false),
      readFileSync: jest.fn(),
      unlinkSync: jest.fn(),
    };
    mockPath = {
      join: jest.fn((...args) => args.join('/')),
      resolve: jest.fn((...args) => args.join('/')),
    };

    // Mock electron
    jest.doMock('electron', () => ({ app: mockApp }));
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
    jest.doMock('fs', () => mockFs);
    jest.doMock('path', () => mockPath);
    jest.doMock('os', () => ({
      platform: jest.fn(() => 'win32'),
      homedir: jest.fn(() => '<home-dir>'),
    }));

    // Import fresh after mocks
    const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');
    const { registerErrorHandlers } = require('../modules/ipc/error-handlers');

    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.mainWindow.isDestroyed = jest.fn(() => false);
    ctx.daemonClient = { shutdown: jest.fn() };

    registerErrorHandlers(ctx, {});
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('shuts down daemon client if available', async () => {
    await harness.invoke('full-restart');

    expect(ctx.daemonClient.shutdown).toHaveBeenCalled();
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });

  test('handles daemon shutdown error gracefully', async () => {
    ctx.daemonClient.shutdown.mockImplementation(() => {
      throw new Error('Shutdown failed');
    });

    const result = await harness.invoke('full-restart');

    expect(result.success).toBe(true);
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });

  test('handles missing daemon client', async () => {
    ctx.daemonClient = null;

    const result = await harness.invoke('full-restart');

    expect(result.success).toBe(true);
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });

  test('kills daemon PID on Windows when pid file exists', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('12345');

    await harness.invoke('full-restart');

    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '12345', '/f', '/t'],
      { shell: true, detached: true }
    );
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });

  test('handles error killing daemon PID on Windows', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('Read failed');
    });

    const result = await harness.invoke('full-restart');

    // Should still succeed despite error
    expect(result.success).toBe(true);
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });

  test('skips daemon PID kill when pid file does not exist', async () => {
    mockFs.existsSync.mockReturnValue(false);

    await harness.invoke('full-restart');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });
});

// Test non-Windows platform behavior
describe('full-restart handler (non-Windows)', () => {
  let mockApp;
  let mockSpawn;
  let mockFs;
  let harness;
  let ctx;

  beforeEach(() => {
    jest.resetModules();

    mockApp = { exit: jest.fn() };
    mockSpawn = jest.fn();
    mockFs = {
      existsSync: jest.fn(),
      readFileSync: jest.fn(),
      unlinkSync: jest.fn(),
    };

    jest.doMock('electron', () => ({ app: mockApp }));
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
    jest.doMock('fs', () => mockFs);
    jest.doMock('path', () => ({ join: jest.fn((...args) => args.join('/')), resolve: jest.fn((...args) => args.join('/')) }));
    jest.doMock('os', () => ({
      platform: jest.fn(() => 'darwin'),
      homedir: jest.fn(() => '<home-dir>'),
    }));

    const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');
    const { registerErrorHandlers } = require('../modules/ipc/error-handlers');

    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    registerErrorHandlers(ctx, {});
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('skips Windows-specific daemon kill on non-Windows', async () => {
    await harness.invoke('full-restart');

    expect(mockFs.existsSync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });
});
