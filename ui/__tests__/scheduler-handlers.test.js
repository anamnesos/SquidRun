/**
 * Scheduler IPC Handler Tests
 * Target: Full coverage of scheduler-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock scheduler module
const mockScheduler = {
  init: jest.fn(),
  listSchedules: jest.fn(() => []),
  addSchedule: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
  runNow: jest.fn(),
  emitEvent: jest.fn(),
  markCompleted: jest.fn(),
};

jest.mock('../modules/scheduler', () => ({
  createScheduler: jest.fn(() => mockScheduler),
}));

const { registerSchedulerHandlers } = require('../modules/ipc/scheduler-handlers');

describe('Scheduler Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.triggers = { routeTask: jest.fn() };

    // Reset mock behaviors
    mockScheduler.listSchedules.mockReturnValue([]);
    mockScheduler.addSchedule.mockImplementation(payload => ({
      id: 'sched-123',
      ...payload,
      createdAt: new Date().toISOString(),
    }));
    mockScheduler.updateSchedule.mockImplementation((id, patch) => ({
      id,
      ...patch,
      updatedAt: new Date().toISOString(),
    }));
    mockScheduler.deleteSchedule.mockReturnValue(true);
    mockScheduler.runNow.mockReturnValue({ success: true, results: [] });
    mockScheduler.emitEvent.mockReturnValue([]);
    mockScheduler.markCompleted.mockReturnValue(true);

    registerSchedulerHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerSchedulerHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerSchedulerHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('creates scheduler on ctx', () => {
      expect(ctx.scheduler).toBeDefined();
      expect(mockScheduler.init).toHaveBeenCalled();
    });

    test('reuses existing scheduler', () => {
      const existingScheduler = { existing: true };
      const harness2 = createIpcHarness();
      const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
      ctx2.WORKSPACE_PATH = '/test';
      ctx2.scheduler = existingScheduler;

      registerSchedulerHandlers(ctx2);

      expect(ctx2.scheduler).toBe(existingScheduler);
    });
  });

  describe('get-schedules', () => {
    test('returns empty list initially', async () => {
      const result = await harness.invoke('get-schedules');

      expect(result.success).toBe(true);
      expect(result.schedules).toEqual([]);
    });

    test('returns schedules list', async () => {
      mockScheduler.listSchedules.mockReturnValue([
        { id: 'sched-1', name: 'Daily backup', type: 'interval' },
        { id: 'sched-2', name: 'Deploy', type: 'cron' },
      ]);

      const result = await harness.invoke('get-schedules');

      expect(result.success).toBe(true);
      expect(result.schedules.length).toBe(2);
    });

    test('returns error when scheduler missing', async () => {
      ctx.scheduler = null;

      const result = await harness.invoke('get-schedules');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('add-schedule', () => {
    test('adds interval schedule', async () => {
      const payload = {
        name: 'Health check',
        type: 'interval',
        intervalMs: 60000,
        input: 'Check system health',
      };

      const result = await harness.invoke('add-schedule', payload);

      expect(result.success).toBe(true);
      expect(result.schedule.id).toBe('sched-123');
      expect(mockScheduler.addSchedule).toHaveBeenCalledWith(payload);
    });

    test('adds cron schedule', async () => {
      const payload = {
        name: 'Nightly build',
        type: 'cron',
        cron: '0 0 * * *',
        input: 'Build project',
      };

      const result = await harness.invoke('add-schedule', payload);

      expect(result.success).toBe(true);
      expect(mockScheduler.addSchedule).toHaveBeenCalledWith(payload);
    });

    test('adds event-based schedule', async () => {
      const payload = {
        name: 'On deploy',
        type: 'event',
        eventName: 'deploy-complete',
        input: 'Run smoke tests',
      };

      const result = await harness.invoke('add-schedule', payload);

      expect(result.success).toBe(true);
    });

    test('adds chained schedule', async () => {
      const payload = {
        name: 'After tests',
        type: 'chain',
        chainAfter: 'sched-1',
        input: 'Deploy if tests pass',
      };

      const result = await harness.invoke('add-schedule', payload);

      expect(result.success).toBe(true);
    });

    test('handles empty payload', async () => {
      const result = await harness.invoke('add-schedule', null);

      expect(result.success).toBe(true);
      expect(mockScheduler.addSchedule).toHaveBeenCalledWith({});
    });
  });

  describe('update-schedule', () => {
    test('updates schedule', async () => {
      const result = await harness.invoke('update-schedule', 'sched-123', {
        name: 'Updated name',
        intervalMs: 120000,
      });

      expect(result.success).toBe(true);
      expect(result.schedule.id).toBe('sched-123');
      expect(mockScheduler.updateSchedule).toHaveBeenCalledWith('sched-123', {
        name: 'Updated name',
        intervalMs: 120000,
      });
    });

    test('returns error when not found', async () => {
      mockScheduler.updateSchedule.mockReturnValue(null);

      const result = await harness.invoke('update-schedule', 'unknown', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });

    test('handles null patch', async () => {
      const result = await harness.invoke('update-schedule', 'sched-1', null);

      expect(mockScheduler.updateSchedule).toHaveBeenCalledWith('sched-1', {});
    });
  });

  describe('delete-schedule', () => {
    test('deletes schedule', async () => {
      const result = await harness.invoke('delete-schedule', 'sched-123');

      expect(result.success).toBe(true);
      expect(mockScheduler.deleteSchedule).toHaveBeenCalledWith('sched-123');
    });

    test('returns false when delete fails', async () => {
      mockScheduler.deleteSchedule.mockReturnValue(false);

      const result = await harness.invoke('delete-schedule', 'unknown');

      expect(result.success).toBe(false);
    });
  });

  describe('run-schedule-now', () => {
    test('runs schedule immediately', async () => {
      mockScheduler.runNow.mockReturnValue({
        success: true,
        results: [{ agent: '1', status: 'completed' }],
      });

      const result = await harness.invoke('run-schedule-now', 'sched-123');

      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
      expect(mockScheduler.runNow).toHaveBeenCalledWith('sched-123');
    });

    test('returns error when run fails', async () => {
      mockScheduler.runNow.mockReturnValue({
        success: false,
        error: 'Schedule not found',
      });

      const result = await harness.invoke('run-schedule-now', 'unknown');

      expect(result.success).toBe(false);
    });
  });

  describe('emit-schedule-event', () => {
    test('emits event to trigger schedules', async () => {
      mockScheduler.emitEvent.mockReturnValue([
        { scheduleId: 'sched-1', triggered: true },
      ]);

      const result = await harness.invoke('emit-schedule-event', 'deploy-complete', { version: '1.0' });

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(1);
      expect(mockScheduler.emitEvent).toHaveBeenCalledWith('deploy-complete', { version: '1.0' });
    });

    test('returns empty results when no schedules match', async () => {
      mockScheduler.emitEvent.mockReturnValue([]);

      const result = await harness.invoke('emit-schedule-event', 'unknown-event', null);

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });
  });

  describe('complete-schedule', () => {
    test('marks chained schedule as completed', async () => {
      const result = await harness.invoke('complete-schedule', 'sched-123', 'success');

      expect(result.success).toBe(true);
      expect(mockScheduler.markCompleted).toHaveBeenCalledWith('sched-123', 'success');
    });

    test('marks schedule as failed', async () => {
      const result = await harness.invoke('complete-schedule', 'sched-123', 'failed');

      expect(result.success).toBe(true);
      expect(mockScheduler.markCompleted).toHaveBeenCalledWith('sched-123', 'failed');
    });

    test('returns false when completion fails', async () => {
      mockScheduler.markCompleted.mockReturnValue(false);

      const result = await harness.invoke('complete-schedule', 'unknown', 'success');

      expect(result.success).toBe(false);
    });
  });

  describe('missing scheduler', () => {
    beforeEach(() => {
      ctx.scheduler = null;
    });

    test('add-schedule returns error when scheduler missing', async () => {
      const result = await harness.invoke('add-schedule', { name: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('update-schedule returns error when scheduler missing', async () => {
      const result = await harness.invoke('update-schedule', 'sched-1', { name: 'Updated' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('delete-schedule returns error when scheduler missing', async () => {
      const result = await harness.invoke('delete-schedule', 'sched-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('run-schedule-now returns error when scheduler missing', async () => {
      const result = await harness.invoke('run-schedule-now', 'sched-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('emit-schedule-event returns error when scheduler missing', async () => {
      const result = await harness.invoke('emit-schedule-event', 'deploy', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('complete-schedule returns error when scheduler missing', async () => {
      const result = await harness.invoke('complete-schedule', 'sched-1', 'success');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });
});
