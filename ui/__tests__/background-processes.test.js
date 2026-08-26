/**
 * Background Processes Controller Tests
 * Target: Full coverage of background-processes.js
 */

const {
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock os and child_process
jest.mock('os', () => ({
  platform: jest.fn(() => 'win32'),
  homedir: jest.fn(() => '/tmp'),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({ pid: 1234 })),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const os = require('os');
const { spawn } = require('child_process');
const { createBackgroundProcessController } = require('../modules/ipc/background-processes');

describe('Background Processes Controller', () => {
  let ctx;
  let controller;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createDefaultContext({});
    ctx.mainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    };
    ctx.backgroundProcesses = new Map();

    controller = createBackgroundProcessController(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('broadcastProcessList', () => {
    test('broadcasts empty list when no processes', () => {
      controller.broadcastProcessList();

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('processes-changed', []);
    });

    test('broadcasts process info when processes exist', () => {
      ctx.backgroundProcesses.set('proc-1', {
        process: { pid: 1234 },
        info: {
          id: 'proc-1',
          command: 'npm',
          args: ['test'],
          pid: 1234,
          status: 'running',
        },
      });

      controller.broadcastProcessList();

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('processes-changed', [
        {
          id: 'proc-1',
          command: 'npm',
          args: ['test'],
          pid: 1234,
          status: 'running',
        },
      ]);
    });

    test('handles destroyed mainWindow', () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      controller.broadcastProcessList();

      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('handles null mainWindow', () => {
      ctx.mainWindow = null;

      // Should not throw
      controller.broadcastProcessList();
    });
  });

  describe('getBackgroundProcesses', () => {
    test('returns backgroundProcesses map', () => {
      const result = controller.getBackgroundProcesses();

      expect(result).toBe(ctx.backgroundProcesses);
    });
  });

  describe('cleanupProcesses', () => {
    test('kills running processes on Windows', () => {
      os.platform.mockReturnValue('win32');
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { status: 'running', id: 'proc-1' },
      });

      controller.cleanupProcesses();

      expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/f', '/t'], { shell: true });
      expect(ctx.backgroundProcesses.size).toBe(0);
    });

    test('kills running processes on non-Windows', () => {
      os.platform.mockReturnValue('linux');
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { status: 'running', id: 'proc-1' },
      });

      controller.cleanupProcesses();

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    test('skips non-running processes', () => {
      const mockProc = { pid: 1234, kill: jest.fn() };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { status: 'stopped', id: 'proc-1' },
      });

      controller.cleanupProcesses();

      expect(spawn).not.toHaveBeenCalled();
      expect(mockProc.kill).not.toHaveBeenCalled();
    });

    test('handles cleanup errors gracefully', () => {
      os.platform.mockReturnValue('linux');
      const mockProc = {
        pid: 1234,
        kill: jest.fn(() => { throw new Error('Kill failed'); }),
      };
      ctx.backgroundProcesses.set('proc-1', {
        process: mockProc,
        info: { status: 'running', id: 'proc-1' },
      });

      // Should not throw
      controller.cleanupProcesses();

      expect(ctx.backgroundProcesses.size).toBe(0);
    });

    test('handles null process gracefully', () => {
      ctx.backgroundProcesses.set('proc-1', {
        process: null,
        info: { status: 'running', id: 'proc-1' },
      });

      // Should not throw
      controller.cleanupProcesses();
    });
  });
});
