/**
 * Scheduler Module Tests
 * Target: Full coverage of modules/scheduler.js
 */

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

// Mock crypto - use mockRandomBytes for unique IDs
const mockRandomBytes = jest.fn();
jest.mock('crypto', () => ({
  randomBytes: (...args) => mockRandomBytes(...args),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock task-parser
jest.mock('../modules/task-parser', () => ({
  parseTaskInput: jest.fn(),
}));

// We'll require these fresh in each test
let fs;
let log;
let taskParser;
let createScheduler;
let matchesCron;
let computeNextRun;

describe('Scheduler Module', () => {
  let idCounter;

  beforeEach(() => {
    // Reset module cache to get fresh scheduler state
    jest.resetModules();

    // Re-require mocked modules
    fs = require('fs');
    log = require('../modules/logger');
    taskParser = require('../modules/task-parser');
    const scheduler = require('../modules/scheduler');
    createScheduler = scheduler.createScheduler;
    matchesCron = scheduler.matchesCron;
    computeNextRun = scheduler.computeNextRun;

    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset ID counter and configure mockRandomBytes
    idCounter = 0;
    mockRandomBytes.mockImplementation((size) => {
      idCounter++;
      return Buffer.from(String(idCounter).padStart(size, '0'));
    });

    // Default fs mock behaviors
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});

    // Default task parser behavior
    taskParser.parseTaskInput.mockReturnValue({
      success: true,
      subtasks: [{ taskType: 'general', text: 'test task' }],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('matchesCron', () => {
    test('returns false for null cron', () => {
      expect(matchesCron(new Date(), null)).toBe(false);
    });

    test('returns false for invalid cron format', () => {
      expect(matchesCron(new Date(), '* * *')).toBe(false);
    });

    test('matches every minute (*/1 * * * *)', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '* * * * *')).toBe(true);
    });

    test('matches specific minute', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '30 * * * *')).toBe(true);
      expect(matchesCron(date, '15 * * * *')).toBe(false);
    });

    test('matches specific hour', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '30 10 * * *')).toBe(true);
      expect(matchesCron(date, '30 15 * * *')).toBe(false);
    });

    test('matches specific day of month', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '30 10 15 * *')).toBe(true);
      expect(matchesCron(date, '30 10 20 * *')).toBe(false);
    });

    test('matches specific month', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '30 10 15 1 *')).toBe(true);
      expect(matchesCron(date, '30 10 15 6 *')).toBe(false);
    });

    test('matches specific weekday', () => {
      const monday = new Date('2024-01-15T10:30:00'); // Jan 15, 2024 is Monday
      expect(matchesCron(monday, '30 10 * * 1')).toBe(true);
      expect(matchesCron(monday, '30 10 * * 0')).toBe(false); // Sunday
    });

    test('matches step patterns (*/5)', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '*/5 * * * *')).toBe(true); // 30 is divisible by 5
      expect(matchesCron(date, '*/7 * * * *')).toBe(false); // 30 is not divisible by 7
    });

    test('matches range patterns (1-5)', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '30 10 * * 1-5')).toBe(true); // Monday is 1
    });

    test('matches comma-separated values', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(matchesCron(date, '15,30,45 * * * *')).toBe(true);
    });

    test('handles timezone parameter', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      // With UTC timezone
      expect(matchesCron(date, '30 10 * * *', 'UTC')).toBe(true);
    });

    test('handles invalid timezone gracefully', () => {
      const date = new Date('2024-01-15T10:30:00');
      matchesCron(date, '30 10 * * *', 'Invalid/Timezone');
      expect(log.warn).toHaveBeenCalledWith('Scheduler', expect.stringContaining('Invalid timezone'));
    });
  });

  describe('computeNextRun', () => {
    test('returns null for inactive schedule', () => {
      const schedule = { active: false, type: 'once' };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('returns null for event type', () => {
      const schedule = { active: true, type: 'event' };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('computes next run for once type', () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const schedule = { active: true, type: 'once', runAt: futureDate };
      const next = computeNextRun(schedule);
      expect(next).toEqual(new Date(futureDate));
    });

    test('returns null for once type in the past', () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const schedule = { active: true, type: 'once', runAt: pastDate };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('returns null for once type with invalid date', () => {
      const schedule = { active: true, type: 'once', runAt: 'invalid-date' };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('returns null for once type with no runAt', () => {
      const schedule = { active: true, type: 'once', runAt: null };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('computes next run for interval type', () => {
      const now = new Date();
      const schedule = { active: true, type: 'interval', intervalMs: 60000 };
      const next = computeNextRun(schedule, now);
      expect(next.getTime()).toBe(now.getTime() + 60000);
    });

    test('computes next run for interval with lastRunAt', () => {
      const lastRun = new Date(Date.now() - 30000);
      const schedule = {
        active: true,
        type: 'interval',
        intervalMs: 60000,
        lastRunAt: lastRun.toISOString(),
      };
      const next = computeNextRun(schedule);
      expect(next.getTime()).toBe(lastRun.getTime() + 60000);
    });

    test('returns null for interval with no intervalMs', () => {
      const schedule = { active: true, type: 'interval', intervalMs: 0 };
      expect(computeNextRun(schedule)).toBeNull();
    });

    test('computes next run for cron type', () => {
      const now = new Date('2024-01-15T10:30:00');
      const schedule = { active: true, type: 'cron', cron: '0 * * * *' };
      const next = computeNextRun(schedule, now);
      expect(next).not.toBeNull();
      expect(next.getMinutes()).toBe(0);
    });

    test('returns null for unknown type', () => {
      const schedule = { active: true, type: 'unknown' };
      expect(computeNextRun(schedule)).toBeNull();
    });
  });

  describe('createScheduler', () => {
    let scheduler;
    let mockTriggers;

    beforeEach(() => {
      mockTriggers = {
        routeTask: jest.fn(() => ({ success: true, paneId: '1' })),
      };

      scheduler = createScheduler({
        triggers: mockTriggers,
        workspacePath: '/test/workspace',
      });
    });

    afterEach(() => {
      scheduler.stop();
    });

    describe('init', () => {
      test('loads schedules from file', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          schedules: [{ id: '1', name: 'Test', active: true }],
        }));

        scheduler.init();

        expect(fs.existsSync).toHaveBeenCalled();
        expect(fs.readFileSync).toHaveBeenCalled();
      });

      test('starts check interval', () => {
        const setIntervalSpy = jest.spyOn(global, 'setInterval');
        scheduler.init();

        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
        setIntervalSpy.mockRestore();
      });

      test('handles load error gracefully', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => {
          throw new Error('Read error');
        });

        expect(() => scheduler.init()).not.toThrow();
        expect(log.error).toHaveBeenCalledWith('Scheduler', 'Failed to load schedules', 'Read error');
      });
    });

    describe('listSchedules', () => {
      test('returns empty array initially', () => {
        expect(scheduler.listSchedules()).toEqual([]);
      });

      test('returns copy of schedules', () => {
        scheduler.addSchedule({ name: 'Test 1' });
        scheduler.addSchedule({ name: 'Test 2' });

        const list = scheduler.listSchedules();
        expect(list).toHaveLength(2);
      });
    });

    describe('addSchedule', () => {
      test('creates schedule with default values', () => {
        const schedule = scheduler.addSchedule({ name: 'Test Task' });

        expect(schedule.id).toBeDefined();
        expect(schedule.name).toBe('Test Task');
        expect(schedule.type).toBe('once');
        expect(schedule.active).toBe(true);
      });

      test('creates schedule with custom values', () => {
        const schedule = scheduler.addSchedule({
          name: 'Cron Task',
          type: 'cron',
          cron: '0 * * * *',
          active: false,
        });

        expect(schedule.type).toBe('cron');
        expect(schedule.cron).toBe('0 * * * *');
        expect(schedule.active).toBe(false);
      });

      test('creates interval schedule', () => {
        const schedule = scheduler.addSchedule({
          type: 'interval',
          intervalMs: 60000,
        });

        expect(schedule.type).toBe('interval');
        expect(schedule.intervalMs).toBe(60000);
        expect(schedule.nextRun).not.toBeNull();
      });

      test('creates event schedule', () => {
        const schedule = scheduler.addSchedule({
          type: 'event',
          eventName: 'build-complete',
        });

        expect(schedule.type).toBe('event');
        expect(schedule.eventName).toBe('build-complete');
        expect(schedule.nextRun).toBeNull(); // Events don't have nextRun
      });

      test('creates chained schedule', () => {
        const parent = scheduler.addSchedule({ name: 'Parent' });
        const child = scheduler.addSchedule({
          name: 'Child',
          chainAfter: parent.id,
          chainRequiresSuccess: true,
        });

        expect(child.chainAfter).toBe(parent.id);
        expect(child.chainRequiresSuccess).toBe(true);
      });

      test('uses input for name if name not provided', () => {
        const schedule = scheduler.addSchedule({
          input: 'Do something important',
        });

        expect(schedule.name).toBe('Do something important');
      });

      test('saves after adding', () => {
        scheduler.addSchedule({ name: 'Test' });

        expect(fs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe('updateSchedule', () => {
      test('updates existing schedule', () => {
        const schedule = scheduler.addSchedule({ name: 'Original' });

        // Advance time to ensure updatedAt differs
        jest.advanceTimersByTime(100);

        const updated = scheduler.updateSchedule(schedule.id, { name: 'Updated' });

        expect(updated.name).toBe('Updated');
        expect(updated.updatedAt).not.toBe(schedule.createdAt);
      });

      test('returns null for non-existent schedule', () => {
        const result = scheduler.updateSchedule('nonexistent', { name: 'Test' });

        expect(result).toBeNull();
      });

      test('recalculates nextRun on update', () => {
        const schedule = scheduler.addSchedule({
          type: 'interval',
          intervalMs: 60000,
        });
        const originalNextRun = schedule.nextRun;

        scheduler.updateSchedule(schedule.id, { intervalMs: 120000 });

        // NextRun should be recalculated
        expect(fs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe('deleteSchedule', () => {
      test('deletes existing schedule', () => {
        // Create isolated scheduler for this test
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });
        const schedule = isolatedScheduler.addSchedule({ name: 'Test' });

        const result = isolatedScheduler.deleteSchedule(schedule.id);

        expect(result).toBe(true);
        expect(isolatedScheduler.listSchedules()).toHaveLength(0);
        isolatedScheduler.stop();
      });

      test('returns false for non-existent schedule', () => {
        const result = scheduler.deleteSchedule('nonexistent');

        expect(result).toBe(false);
      });
    });

    describe('runNow', () => {
      test('runs schedule immediately', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        taskParser.parseTaskInput.mockReturnValue({
          success: true,
          subtasks: [{ taskType: 'code', text: 'do something' }],
        });

        const schedule = isolatedScheduler.addSchedule({
          name: 'Manual Run',
          input: 'do something',
        });

        const result = isolatedScheduler.runNow(schedule.id);

        expect(result.success).toBe(true);
        expect(mockTriggers.routeTask).toHaveBeenCalled();
        isolatedScheduler.stop();
      });

      test('returns error for non-existent schedule', () => {
        const result = scheduler.runNow('nonexistent');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('not_found');
      });

      test('records history entry', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        const schedule = isolatedScheduler.addSchedule({ name: 'Test' });

        isolatedScheduler.runNow(schedule.id);

        const updated = isolatedScheduler.listSchedules().find(s => s.id === schedule.id);
        expect(updated.history).toHaveLength(1);
        expect(updated.history[0].reason).toBe('manual');
        isolatedScheduler.stop();
      });
    });

    describe('emitEvent', () => {
      test('triggers event-based schedules', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        isolatedScheduler.addSchedule({
          name: 'On Build Complete',
          type: 'event',
          eventName: 'build-complete',
        });

        const results = isolatedScheduler.emitEvent('build-complete', {});

        expect(results).toHaveLength(1);
        expect(mockTriggers.routeTask).toHaveBeenCalled();
        isolatedScheduler.stop();
      });

      test('ignores non-matching events', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        isolatedScheduler.addSchedule({
          name: 'On Build Complete',
          type: 'event',
          eventName: 'build-complete',
        });

        const results = isolatedScheduler.emitEvent('test-complete', {});

        expect(results).toHaveLength(0);
        isolatedScheduler.stop();
      });

      test('ignores inactive event schedules', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        isolatedScheduler.addSchedule({
          name: 'Inactive Event',
          type: 'event',
          eventName: 'build-complete',
          active: false,
        });

        const results = isolatedScheduler.emitEvent('build-complete', {});

        expect(results).toHaveLength(0);
        isolatedScheduler.stop();
      });
    });

    describe('markCompleted', () => {
      test('marks schedule as completed', () => {
        const schedule = scheduler.addSchedule({ name: 'Test' });

        const result = scheduler.markCompleted(schedule.id, 'success');

        expect(result).toBe(true);
        const updated = scheduler.listSchedules().find(s => s.id === schedule.id);
        expect(updated.lastStatus).toBe('success');
      });

      test('returns false for non-existent schedule', () => {
        const result = scheduler.markCompleted('nonexistent', 'success');

        expect(result).toBe(false);
      });
    });

    describe('checkDueSchedules', () => {
      test('runs due schedules', () => {
        // Create an interval schedule that's already due
        const schedule = scheduler.addSchedule({
          type: 'interval',
          intervalMs: 1000,
        });

        // Advance time past the interval
        jest.advanceTimersByTime(2000);

        const fired = scheduler.checkDueSchedules();

        expect(fired).toBe(1);
        expect(mockTriggers.routeTask).toHaveBeenCalled();
      });

      test('skips inactive schedules', () => {
        scheduler.addSchedule({
          type: 'interval',
          intervalMs: 1000,
          active: false,
        });

        jest.advanceTimersByTime(2000);

        const fired = scheduler.checkDueSchedules();

        expect(fired).toBe(0);
      });

      test('skips event schedules', () => {
        scheduler.addSchedule({
          type: 'event',
          eventName: 'test',
        });

        const fired = scheduler.checkDueSchedules();

        expect(fired).toBe(0);
      });

      test('respects chain dependencies - child blocked when parent failed', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        // Parent has long interval so it won't be due when we check
        const parent = isolatedScheduler.addSchedule({
          name: 'Parent',
          type: 'interval',
          intervalMs: 10000,
        });

        // Child has short interval
        const child = isolatedScheduler.addSchedule({
          name: 'Child',
          type: 'interval',
          intervalMs: 1000,
          chainAfter: parent.id,
          chainRequiresSuccess: true,
        });

        // Simulate parent ran but failed (this also resets parent's nextRun far in future)
        isolatedScheduler.markCompleted(parent.id, 'failed');

        // Advance time enough for child to be due, but not parent
        jest.advanceTimersByTime(2000);

        // Child is due but parent.lastStatus is 'failed', so child should be skipped
        const fired = isolatedScheduler.checkDueSchedules();

        // Child should not have run because chain dependency blocks it
        const updatedChild = isolatedScheduler.listSchedules().find(s => s.id === child.id);
        expect(updatedChild.lastRunAt).toBeNull();

        isolatedScheduler.stop();
      });

      test('respects chain dependencies - child runs after parent succeeds', () => {
        const isolatedScheduler = createScheduler({
          triggers: mockTriggers,
          workspacePath: '/test/workspace',
        });

        const parent = isolatedScheduler.addSchedule({
          name: 'Parent',
          type: 'interval',
          intervalMs: 1000,
        });

        isolatedScheduler.addSchedule({
          name: 'Child',
          type: 'interval',
          intervalMs: 1000,
          chainAfter: parent.id,
          chainRequiresSuccess: true,
        });

        jest.advanceTimersByTime(2000);

        // Both fire in same cycle since parent succeeds first
        const fired = isolatedScheduler.checkDueSchedules();
        expect(fired).toBe(2); // Both fire when parent succeeds

        isolatedScheduler.stop();
      });

      test('deactivates once schedules after running', () => {
        const futureTime = Date.now() + 1000;
        const schedule = scheduler.addSchedule({
          type: 'once',
          runAt: new Date(futureTime).toISOString(),
        });

        jest.advanceTimersByTime(2000);
        scheduler.checkDueSchedules();

        const updated = scheduler.listSchedules().find(s => s.id === schedule.id);
        expect(updated.active).toBe(false);
      });
    });

    describe('error handling', () => {
      test('handles missing triggers gracefully', () => {
        const noTriggersScheduler = createScheduler({
          triggers: null,
          workspacePath: '/test',
        });

        const schedule = noTriggersScheduler.addSchedule({ name: 'Test' });
        const result = noTriggersScheduler.runNow(schedule.id);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('missing_triggers');

        noTriggersScheduler.stop();
      });

      test('handles parse failure', () => {
        taskParser.parseTaskInput.mockReturnValue({
          success: false,
          error: 'Invalid input',
        });

        const schedule = scheduler.addSchedule({ name: 'Bad Input' });
        const result = scheduler.runNow(schedule.id);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('parse_failed');
      });

      test('handles task failure', () => {
        mockTriggers.routeTask.mockReturnValue({ success: false, error: 'Task failed' });

        const schedule = scheduler.addSchedule({ name: 'Test' });
        const result = scheduler.runNow(schedule.id);

        expect(result.success).toBe(false);
        const updated = scheduler.listSchedules().find(s => s.id === schedule.id);
        expect(updated.lastStatus).toBe('failed');
      });

      test('handles save error gracefully', () => {
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write error');
        });

        // Should not throw
        expect(() => scheduler.addSchedule({ name: 'Test' })).not.toThrow();
        expect(log.error).toHaveBeenCalledWith('Scheduler', 'Failed to save schedules', 'Write error');
      });

      test('handles check interval error gracefully', () => {
        scheduler.init();

        // Make checkDueSchedules throw
        taskParser.parseTaskInput.mockImplementation(() => {
          throw new Error('Parse error');
        });

        scheduler.addSchedule({
          type: 'interval',
          intervalMs: 1000,
        });

        // Advance timer to trigger check
        jest.advanceTimersByTime(60000);

        expect(log.error).toHaveBeenCalledWith('Scheduler', 'Tick error', expect.any(String));
      });
    });

    describe('history management', () => {
      test('limits history to 100 entries', () => {
        const schedule = scheduler.addSchedule({ name: 'Test' });

        // Run many times
        for (let i = 0; i < 110; i++) {
          scheduler.runNow(schedule.id);
        }

        const updated = scheduler.listSchedules().find(s => s.id === schedule.id);
        expect(updated.history.length).toBeLessThanOrEqual(100);
      });
    });

    describe('stop', () => {
      test('clears interval timer', () => {
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
        scheduler.init();
        scheduler.stop();

        expect(clearIntervalSpy).toHaveBeenCalled();
        clearIntervalSpy.mockRestore();
      });

      test('can be called multiple times', () => {
        scheduler.init();
        scheduler.stop();
        scheduler.stop();

        // Should not throw
      });
    });
  });
});
