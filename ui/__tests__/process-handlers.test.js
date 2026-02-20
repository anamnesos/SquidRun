/**
 * Process IPC Handler Tests
 * Target: Full coverage of process-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');
const { EventEmitter } = require('events');

// Mock os and child_process
jest.mock('os', () => ({
  platform: jest.fn(() => 'win32'),
  homedir: jest.fn(() => '/tmp'),
}));

// Create a mock process factory
const createMockProcess = (pid = 1234) => {
  const mockProc = new EventEmitter();
  mockProc.pid = pid;
  mockProc.stdout = new EventEmitter();
  mockProc.stderr = new EventEmitter();
  mockProc.kill = jest.fn();
  return mockProc;
};

jest.mock('child_process', () => ({
  spawn: jest.fn(() => createMockProcess()),
}));

const os = require('os');
const { spawn } = require('child_process');
const { registerProcessHandlers } = require('../modules/ipc/process-handlers');

describe('Process Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Make isDestroyed a mock function
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Reset spawn mock for each test
    spawn.mockImplementation(() => createMockProcess());

    registerProcessHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('spawn-process', () => {
    test('spawns a process and returns id', async () => {
      const result = await harness.invoke('spawn-process', 'npm', ['test']);

      expect(spawn).toHaveBeenCalledWith('npm.cmd', ['test'], expect.objectContaining({
        shell: false,
        cwd: expect.any(String),
      }));
      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^proc-\d+$/);
      expect(result.pid).toBeDefined();
    });

    test('uses custom cwd when provided', async () => {
      await harness.invoke('spawn-process', 'git', [], '/custom/path');

      expect(spawn).toHaveBeenCalledWith('git', [], expect.objectContaining({
        cwd: '/custom/path',
      }));
    });

    test('uses shell: false on non-Windows', async () => {
      os.platform.mockReturnValue('linux');

      await harness.invoke('spawn-process', 'git', []);

      expect(spawn).toHaveBeenCalledWith('git', [], expect.objectContaining({
        shell: false,
      }));
    });

    test('rejects commands not in whitelist', async () => {
      const result = await harness.invoke('spawn-process', 'rm', ['-rf', '/']);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/);
      expect(spawn).not.toHaveBeenCalled();
    });

    test('stores process in backgroundProcesses', async () => {
      const result = await harness.invoke('spawn-process', 'npm', ['start']);

      expect(ctx.backgroundProcesses.has(result.id)).toBe(true);
    });

    test('broadcasts process list after spawn', async () => {
      await harness.invoke('spawn-process', 'npm', ['test']);

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('processes-changed', expect.any(Array));
    });

    test('handles spawn error', async () => {
      spawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      const result = await harness.invoke('spawn-process', 'node', []);

      expect(result).toEqual({ success: false, error: 'Spawn failed' });
    });

    test('captures stdout output', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'node', ['--version']);

      // Simulate stdout data
      mockProc.stdout.emit('data', 'Hello World\n');

      const entry = ctx.backgroundProcesses.get(result.id);
      expect(entry.info.output).toContain('Hello World');
    });

    test('captures stderr output', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'eslint', []);

      // Simulate stderr data
      mockProc.stderr.emit('data', 'Error occurred\n');

      const entry = ctx.backgroundProcesses.get(result.id);
      expect(entry.info.output).toContain('Error occurred');
    });

    test('limits output to 100 lines', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'npx', ['verbose']);

      // Simulate many lines of output
      for (let i = 0; i < 150; i++) {
        mockProc.stdout.emit('data', `Line ${i}\n`);
      }

      const entry = ctx.backgroundProcesses.get(result.id);
      expect(entry.info.output.length).toBeLessThanOrEqual(100);
    });

    test('removes process from map on process exit with code 0', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'npm', ['test']);

      mockProc.emit('exit', 0);

      expect(ctx.backgroundProcesses.has(result.id)).toBe(false);
    });

    test('removes process from map on process exit with error code', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'jest', []);

      mockProc.emit('exit', 1);

      expect(ctx.backgroundProcesses.has(result.id)).toBe(false);
    });

    test('removes process from map on process error', async () => {
      const mockProc = createMockProcess();
      spawn.mockImplementation(() => mockProc);

      const result = await harness.invoke('spawn-process', 'jest', []);

      mockProc.emit('error', new Error('Process crashed'));

      expect(ctx.backgroundProcesses.has(result.id)).toBe(false);
    });
  });

  describe('list-processes', () => {
    test('returns empty list when no processes', async () => {
      const result = await harness.invoke('list-processes');

      expect(result).toEqual({ success: true, processes: [] });
    });

    test('returns all processes', async () => {
      ctx.backgroundProcesses.set('proc-1', {
        process: {},
        info: {
          id: 'proc-1',
          command: 'npm',
          args: ['test'],
          cwd: '/test',
          pid: 1234,
          startTime: '2026-01-30T10:00:00.000Z',
          status: 'running',
        },
      });

      const result = await harness.invoke('list-processes');

      expect(result.success).toBe(true);
      expect(result.processes.length).toBe(1);
      expect(result.processes[0]).toEqual({
        id: 'proc-1',
        command: 'npm',
        args: ['test'],
        cwd: '/test',
        pid: 1234,
        startTime: '2026-01-30T10:00:00.000Z',
        status: 'running',
        exitCode: undefined,
        error: undefined,
      });
    });
  });

  describe('kill-process', () => {
    test('kills process on Windows', async () => {
      os.platform.mockReturnValue('win32');
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { id: 'proc-1', status: 'running' },
      });

      const result = await harness.invoke('kill-process', 'proc-1');

      expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/f', '/t']);
      expect(result).toEqual({ success: true });
    });

    test('kills process on non-Windows', async () => {
      os.platform.mockReturnValue('linux');
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { id: 'proc-1', status: 'running' },
      });

      const result = await harness.invoke('kill-process', 'proc-1');

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toEqual({ success: true });
    });

    test('returns error when process not found', async () => {
      const result = await harness.invoke('kill-process', 'unknown');

      expect(result).toEqual({ success: false, error: 'Process not found' });
    });

    test('updates status after kill', async () => {
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { id: 'proc-1', status: 'running' },
      });

      await harness.invoke('kill-process', 'proc-1');

      const entry = ctx.backgroundProcesses.get('proc-1');
      expect(entry.info.status).toBe('stopped');
    });

    test('handles kill error', async () => {
      os.platform.mockReturnValue('linux');
      const mockProc = {
        pid: 1234,
        kill: jest.fn(() => { throw new Error('Kill failed'); }),
      };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { id: 'proc-1', status: 'running' },
      });

      const result = await harness.invoke('kill-process', 'proc-1');

      expect(result).toEqual({ success: false, error: 'Kill failed' });
    });
  });

  describe('get-process-output', () => {
    test('returns process output', async () => {
      ctx.backgroundProcesses.set('proc-1', {
        process: {},
        info: {
          id: 'proc-1',
          output: ['Line 1', 'Line 2', 'Line 3'],
        },
      });

      const result = await harness.invoke('get-process-output', 'proc-1');

      expect(result).toEqual({
        success: true,
        output: 'Line 1\nLine 2\nLine 3',
      });
    });

    test('returns error when process not found', async () => {
      const result = await harness.invoke('get-process-output', 'unknown');

      expect(result).toEqual({ success: false, error: 'Process not found' });
    });

    test('returns empty output when no output', async () => {
      ctx.backgroundProcesses.set('proc-1', {
        process: {},
        info: { id: 'proc-1', output: [] },
      });

      const result = await harness.invoke('get-process-output', 'proc-1');

      expect(result).toEqual({ success: true, output: '' });
    });
  });
});
