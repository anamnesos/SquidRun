/**
 * Resource Handlers Tests
 * Target: Full coverage of modules/ipc/resource-handlers.js
 */

const os = require('os');
const childProcess = require('child_process');

// Mock dependencies
jest.mock('os');
jest.mock('child_process');
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const log = require('../modules/logger');
const { registerResourceHandlers } = require('../modules/ipc/resource-handlers');

describe('resource-handlers', () => {
  let mockIpcMain;
  let handlers;

  beforeEach(() => {
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    // Default OS mocks
    os.cpus.mockReturnValue([
      { times: { user: 1000, nice: 0, sys: 500, irq: 0, idle: 8500 } },
      { times: { user: 1000, nice: 0, sys: 500, irq: 0, idle: 8500 } },
    ]);
    os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16GB
    os.freemem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8GB

    // Default exec mock - no output
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      callback(null, '', '');
    });
  });

  describe('registerResourceHandlers', () => {
    test('does nothing if ipcMain is missing', () => {
      registerResourceHandlers({});
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('does nothing if WORKSPACE_PATH is missing', () => {
      registerResourceHandlers({ ipcMain: mockIpcMain });
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('registers resource:get-usage handler', () => {
      registerResourceHandlers({
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: '/workspace',
      });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('resource:get-usage', expect.any(Function));
    });
  });

  describe('resource:get-usage handler', () => {
    const setupHandler = (overrides = {}) => {
      const ctx = {
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: overrides.workspacePath || 'D:\\workspace',
        daemonClient: overrides.daemonClient || {
          getTerminals: () => [],
        },
      };
      registerResourceHandlers(ctx);
      return handlers['resource:get-usage'];
    };

    test('returns system memory stats', async () => {
      const handler = setupHandler();

      const result = await handler();

      expect(result.success).toBe(true);
      expect(result.system.memTotalMB).toBe(16384);
      expect(result.system.memUsedMB).toBe(8192);
      expect(result.system.memPercent).toBe(50);
    });

    test('returns null CPU on first call (no baseline)', async () => {
      const handler = setupHandler();

      const result = await handler();

      expect(result.system.cpuPercent).toBeNull();
    });

    test('returns CPU usage on second call', async () => {
      const handler = setupHandler();

      await handler(); // First call sets baseline

      // Simulate some CPU work
      os.cpus.mockReturnValue([
        { times: { user: 2000, nice: 0, sys: 1000, irq: 0, idle: 9000 } },
        { times: { user: 2000, nice: 0, sys: 1000, irq: 0, idle: 9000 } },
      ]);

      const result = await handler();

      expect(result.system.cpuPercent).not.toBeNull();
    });

    test('handles no terminals', async () => {
      const handler = setupHandler({
        daemonClient: { getTerminals: () => [] },
      });

      const result = await handler();

      expect(result.success).toBe(true);
      expect(result.agents).toEqual({});
    });

    test('returns agent stats from terminals', async () => {
      const handler = setupHandler({
        daemonClient: {
          getTerminals: () => [
            { paneId: '1', pid: 1234, alive: true, mode: 'pty' },
            { paneId: '2', pid: 5678, alive: true, mode: 'sdk' },
          ],
        },
      });

      const result = await handler();

      expect(result.agents['1']).toEqual({
        pid: 1234,
        alive: true,
        mode: 'pty',
        cpuPercent: null,
        memMB: null,
      });
      expect(result.agents['2']).toEqual({
        pid: 5678,
        alive: true,
        mode: 'sdk',
        cpuPercent: null,
        memMB: null,
      });
    });

    test('handles missing daemonClient', async () => {
      const ctx = {
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: 'D:\\workspace',
        daemonClient: null,
      };
      registerResourceHandlers(ctx);
      const handler = handlers['resource:get-usage'];

      const result = await handler();

      expect(result.success).toBe(true);
      expect(result.agents).toEqual({});
    });

    test('handles terminal without mode', async () => {
      const handler = setupHandler({
        daemonClient: {
          getTerminals: () => [
            { paneId: '1', pid: 1234, alive: true },
          ],
        },
      });

      const result = await handler();

      expect(result.agents['1'].mode).toBe('pty');
    });

    test('handles error and returns failure', async () => {
      os.totalmem.mockImplementation(() => {
        throw new Error('OS error');
      });

      const handler = setupHandler();
      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.error).toBe('OS error');
      expect(log.error).toHaveBeenCalledWith('Resources', 'Failed to get usage', 'OS error');
    });

    test('filters out invalid PIDs', async () => {
      const handler = setupHandler({
        daemonClient: {
          getTerminals: () => [
            { paneId: '1', pid: 0, alive: true },
            { paneId: '2', pid: -1, alive: false },
            { paneId: '3', pid: null, alive: true },
            { paneId: '4', pid: 1234, alive: true },
          ],
        },
      });

      const result = await handler();

      expect(result.success).toBe(true);
      // All panes listed but only valid PIDs used for process stats
      expect(Object.keys(result.agents)).toEqual(['1', '2', '3', '4']);
    });
  });

  describe('disk usage (Windows)', () => {
    const originalPlatform = process.platform;

    beforeAll(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    afterAll(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    const setupHandler = (workspacePath = 'D:\\workspace') => {
      handlers = {};
      registerResourceHandlers({
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: workspacePath,
        daemonClient: { getTerminals: () => [] },
      });
      return handlers['resource:get-usage'];
    };

    test('fetches disk usage via PowerShell', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-PSDrive')) {
          callback(null, JSON.stringify({
            Used: 500 * 1024 * 1024 * 1024, // 500GB
            Free: 500 * 1024 * 1024 * 1024, // 500GB
            Name: 'D',
          }), '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler('D:\\workspace');
      const result = await handler();

      expect(result.system.disk).toEqual({
        drive: 'D',
        totalGB: 1000,
        freeGB: 500,
        usedPercent: 50,
      });
    });

    test('handles empty disk output', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        callback(null, '', '');
      });

      const handler = setupHandler();
      const result = await handler();

      expect(result.system.disk).toBeNull();
    });

    test('handles disk lookup error', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-PSDrive')) {
          callback(new Error('PowerShell error'), '', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler();
      const result = await handler();

      expect(result.system.disk).toBeNull();
      expect(log.warn).toHaveBeenCalledWith('Resources', 'Disk usage lookup failed', 'PowerShell error');
    });

    test('extracts drive letter from various paths', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-PSDrive')) {
          const match = cmd.match(/-Name\s+(\w)/);
          const drive = match ? match[1] : 'C';
          callback(null, JSON.stringify({
            Used: 100 * 1024 * 1024 * 1024,
            Free: 100 * 1024 * 1024 * 1024,
            Name: drive,
          }), '');
        } else {
          callback(null, '', '');
        }
      });

      // Test with C:
      const handler1 = setupHandler('C:\\Users\\test');
      const result1 = await handler1();
      expect(result1.system.disk.drive).toBe('C');

      // Test with E:
      handlers = {};
      const handler2 = setupHandler('E:\\projects');
      const result2 = await handler2();
      expect(result2.system.disk.drive).toBe('E');
    });

    test('defaults to C drive when path has no drive letter', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-PSDrive')) {
          callback(null, JSON.stringify({
            Used: 100 * 1024 * 1024 * 1024,
            Free: 100 * 1024 * 1024 * 1024,
            Name: 'C',
          }), '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler('/some/unix/path');
      const result = await handler();

      expect(result.success).toBe(true);
    });
  });

  describe('disk usage (Unix)', () => {
    const originalPlatform = process.platform;

    beforeAll(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    afterAll(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    const setupHandler = () => {
      handlers = {};
      registerResourceHandlers({
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: '/home/user/workspace',
        daemonClient: { getTerminals: () => [] },
      });
      return handlers['resource:get-usage'];
    };

    test('fetches disk usage via df', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('df -kP')) {
          callback(null, 'Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/sda1     1048576000 524288000 524288000  50% /', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler();
      const result = await handler();

      expect(result.system.disk).toEqual({
        drive: '/dev/sda1',
        totalGB: 1000,
        freeGB: 500,
        usedPercent: 50,
      });
    });

    test('handles empty df output', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        callback(null, '', '');
      });

      const handler = setupHandler();
      const result = await handler();

      expect(result.system.disk).toBeNull();
    });
  });

  describe('process stats (Windows)', () => {
    const originalPlatform = process.platform;

    beforeAll(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    afterAll(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    const setupHandler = (terminals) => {
      handlers = {};
      registerResourceHandlers({
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: 'D:\\workspace',
        daemonClient: { getTerminals: () => terminals },
      });
      return handlers['resource:get-usage'];
    };

    test('fetches process stats via PowerShell', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-Process')) {
          callback(null, JSON.stringify([
            { Id: 1234, CPU: 10.5, WorkingSet64: 200 * 1024 * 1024 },
            { Id: 5678, CPU: 5.2, WorkingSet64: 100 * 1024 * 1024 },
          ]), '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
        { paneId: '2', pid: 5678, alive: true },
      ]);

      // First call establishes baseline
      await handler();

      // Second call should show stats
      const result = await handler();

      expect(result.agents['1'].memMB).toBe(200);
      expect(result.agents['2'].memMB).toBe(100);
    });

    test('handles single process response (non-array)', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-Process')) {
          callback(null, JSON.stringify(
            { Id: 1234, CPU: 10.5, WorkingSet64: 200 * 1024 * 1024 }
          ), '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(result.agents['1'].memMB).toBe(200);
    });

    test('handles process lookup error', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-Process')) {
          callback(new Error('Process error'), '', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(log.warn).toHaveBeenCalledWith('Resources', 'Process usage lookup failed', 'Process error');
      expect(result.agents['1'].cpuPercent).toBeNull();
      expect(result.agents['1'].memMB).toBeNull();
    });

    test('handles invalid JSON from Get-Process', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-Process')) {
          callback(null, 'not valid json', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(result.agents['1'].cpuPercent).toBeNull();
    });

    test('handles missing PID in process response', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('Get-Process')) {
          callback(null, JSON.stringify([
            { Id: null, CPU: 10.5, WorkingSet64: 200 * 1024 * 1024 },
          ]), '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(result.agents['1'].cpuPercent).toBeNull();
    });
  });

  describe('process stats (Unix)', () => {
    const originalPlatform = process.platform;

    beforeAll(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    afterAll(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    const setupHandler = (terminals) => {
      handlers = {};
      registerResourceHandlers({
        ipcMain: mockIpcMain,
        WORKSPACE_PATH: '/workspace',
        daemonClient: { getTerminals: () => terminals },
      });
      return handlers['resource:get-usage'];
    };

    test('fetches process stats via ps', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('ps -p')) {
          callback(null, '1234 5.5 102400\n5678 2.3 51200', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
        { paneId: '2', pid: 5678, alive: true },
      ]);

      const result = await handler();

      expect(result.agents['1'].cpuPercent).toBe(5.5);
      expect(result.agents['1'].memMB).toBe(100);
      expect(result.agents['2'].cpuPercent).toBe(2.3);
      expect(result.agents['2'].memMB).toBe(50);
    });

    test('handles ps error', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('ps -p')) {
          callback(new Error('ps error'), '', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(result.agents['1'].cpuPercent).toBeNull();
    });

    test('handles malformed ps output', async () => {
      childProcess.exec.mockImplementation((cmd, opts, callback) => {
        if (cmd.includes('ps -p')) {
          callback(null, 'malformed line\n1234', '');
        } else {
          callback(null, '', '');
        }
      });

      const handler = setupHandler([
        { paneId: '1', pid: 1234, alive: true },
      ]);

      const result = await handler();

      expect(result.success).toBe(true);
    });
  });

  describe('helper functions', () => {
    test('handles null/invalid bytes in bytesToMB', async () => {
      const setupHandler = () => {
        handlers = {};
        registerResourceHandlers({
          ipcMain: mockIpcMain,
          WORKSPACE_PATH: '/workspace',
          daemonClient: { getTerminals: () => [] },
        });
        return handlers['resource:get-usage'];
      };

      os.totalmem.mockReturnValue(NaN);
      os.freemem.mockReturnValue(Infinity);

      const handler = setupHandler();
      const result = await handler();

      expect(result.system.memTotalMB).toBeNull();
    });

    test('CPU calculation handles zero totalDiff', async () => {
      const setupHandler = () => {
        handlers = {};
        registerResourceHandlers({
          ipcMain: mockIpcMain,
          WORKSPACE_PATH: '/workspace',
          daemonClient: { getTerminals: () => [] },
        });
        return handlers['resource:get-usage'];
      };

      const handler = setupHandler();

      // First call
      await handler();

      // Same values = zero diff
      const result = await handler();

      expect(result.system.cpuPercent).toBeNull();
    });
  });
});
