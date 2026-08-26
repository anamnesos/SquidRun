/**
 * Recovery IPC Handlers Tests
 * Target: Full coverage of modules/ipc/recovery-handlers.js
 */

const { registerRecoveryHandlers } = require('../modules/ipc/recovery-handlers');

describe('Recovery IPC Handlers', () => {
  let mockIpcMain;
  let handlers;
  let mockRecoveryManager;

  beforeEach(() => {
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    mockRecoveryManager = {
      getStatus: jest.fn().mockReturnValue({ active: true, pendingRestarts: 2 }),
      getHealthSnapshot: jest.fn().mockReturnValue({ healthy: 5, unhealthy: 1 }),
      getPlaybooks: jest.fn().mockReturnValue([{ name: 'restart' }, { name: 'escalate' }]),
      scheduleRestart: jest.fn(),
      resetCircuit: jest.fn(),
      scheduleTaskRetry: jest.fn(),
      recordTask: jest.fn(),
    };
  });

  describe('registerRecoveryHandlers', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerRecoveryHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ctx.ipcMain is missing', () => {
      expect(() => registerRecoveryHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('registers all expected handlers', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('get-recovery-status', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('get-health-snapshot', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('get-recovery-playbooks', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('trigger-recovery', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('reset-recovery-circuit', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('retry-recovery-task', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('record-recovery-task', expect.any(Function));
    });
  });

  describe('get-recovery-status', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['get-recovery-status']();

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns status from recovery manager', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['get-recovery-status']();

      expect(result).toEqual({
        success: true,
        status: { active: true, pendingRestarts: 2 },
      });
      expect(mockRecoveryManager.getStatus).toHaveBeenCalled();
    });

    test('uses ctx.recoveryManager if deps not provided', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain, recoveryManager: mockRecoveryManager });

      const result = handlers['get-recovery-status']();

      expect(result.success).toBe(true);
      expect(mockRecoveryManager.getStatus).toHaveBeenCalled();
    });
  });

  describe('get-health-snapshot', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['get-health-snapshot']();

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns snapshot from recovery manager', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['get-health-snapshot']();

      expect(result).toEqual({
        success: true,
        snapshot: { healthy: 5, unhealthy: 1 },
      });
      expect(mockRecoveryManager.getHealthSnapshot).toHaveBeenCalled();
    });
  });

  describe('get-recovery-playbooks', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['get-recovery-playbooks']();

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns playbooks from recovery manager', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['get-recovery-playbooks']();

      expect(result).toEqual({
        success: true,
        playbooks: [{ name: 'restart' }, { name: 'escalate' }],
      });
      expect(mockRecoveryManager.getPlaybooks).toHaveBeenCalled();
    });
  });

  describe('trigger-recovery', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['trigger-recovery']({}, '1');

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns error when paneId missing', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['trigger-recovery']({}, null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('schedules restart with default reason', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['trigger-recovery']({}, '1');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.scheduleRestart).toHaveBeenCalledWith('1', 'manual');
    });

    test('schedules restart with custom reason', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['trigger-recovery']({}, '1', 'stuck');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.scheduleRestart).toHaveBeenCalledWith('1', 'stuck');
    });
  });

  describe('reset-recovery-circuit', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['reset-recovery-circuit']({}, '1');

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns error when paneId missing', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['reset-recovery-circuit']({}, null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('resets circuit for pane', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['reset-recovery-circuit']({}, '1');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.resetCircuit).toHaveBeenCalledWith('1');
    });
  });

  describe('retry-recovery-task', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['retry-recovery-task']({}, '1');

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns error when paneId missing', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['retry-recovery-task']({}, null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('returns error when scheduleTaskRetry unavailable', () => {
      const managerWithoutRetry = {
        ...mockRecoveryManager,
        scheduleTaskRetry: undefined,
      };
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: managerWithoutRetry });

      const result = handlers['retry-recovery-task']({}, '1');

      expect(result).toEqual({ success: false, error: 'Task retry unavailable' });
    });

    test('schedules task retry with default reason', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['retry-recovery-task']({}, '1');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.scheduleTaskRetry).toHaveBeenCalledWith('1', 'manual');
    });

    test('schedules task retry with custom reason', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['retry-recovery-task']({}, '1', 'timeout');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.scheduleTaskRetry).toHaveBeenCalledWith('1', 'timeout');
    });
  });

  describe('record-recovery-task', () => {
    test('returns error when manager unavailable', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['record-recovery-task']({}, '1', 'test message');

      expect(result).toEqual({ success: false, error: 'Recovery manager unavailable' });
    });

    test('returns error when paneId missing', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['record-recovery-task']({}, null, 'test message');

      expect(result).toEqual({ success: false, error: 'paneId and message required' });
    });

    test('returns error when message missing', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['record-recovery-task']({}, '1', null);

      expect(result).toEqual({ success: false, error: 'paneId and message required' });
    });

    test('records task with default meta', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['record-recovery-task']({}, '1', 'test message');

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.recordTask).toHaveBeenCalledWith('1', 'test message', {});
    });

    test('records task with custom meta', () => {
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: mockRecoveryManager });

      const result = handlers['record-recovery-task']({}, '1', 'test message', { priority: 'high' });

      expect(result).toEqual({ success: true });
      expect(mockRecoveryManager.recordTask).toHaveBeenCalledWith('1', 'test message', { priority: 'high' });
    });

    test('succeeds even if recordTask not available', () => {
      const managerWithoutRecordTask = {
        ...mockRecoveryManager,
        recordTask: undefined,
      };
      registerRecoveryHandlers({ ipcMain: mockIpcMain }, { recoveryManager: managerWithoutRecordTask });

      const result = handlers['record-recovery-task']({}, '1', 'test message');

      expect(result).toEqual({ success: true });
    });
  });
});
