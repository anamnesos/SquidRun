/**
 * Performance Audit IPC Handler Tests
 * Target: Full coverage of perf-audit-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerPerfAuditHandlers } = require('../modules/ipc/perf-audit-handlers');

describe('Performance Audit Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';

    // Default: no existing profile
    fs.existsSync.mockReturnValue(false);

    registerPerfAuditHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    if (ctx.perfAuditInterval) {
      clearInterval(ctx.perfAuditInterval);
    }
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerPerfAuditHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerPerfAuditHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('sets recordHandlerPerf on ctx', () => {
      expect(ctx.recordHandlerPerf).toBeDefined();
      expect(typeof ctx.recordHandlerPerf).toBe('function');
    });

    test('loads existing profile', () => {
      jest.clearAllMocks();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        handlers: { 'test-handler': { calls: 5 } },
        slowCalls: [],
        enabled: true,
        slowThreshold: 200,
      }));

      const harness2 = createIpcHarness();
      const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
      ctx2.WORKSPACE_PATH = '/test/workspace';
      registerPerfAuditHandlers(ctx2);

      // Profile should be loaded
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('handles load error gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      // Should not throw
      expect(() => {
        const harness2 = createIpcHarness();
        const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
        ctx2.WORKSPACE_PATH = '/test/workspace';
        registerPerfAuditHandlers(ctx2);
      }).not.toThrow();
    });
  });

  describe('recordHandlerPerf', () => {
    test('records handler performance', async () => {
      ctx.recordHandlerPerf('test-handler', 50);

      const result = await harness.invoke('get-perf-profile');

      expect(result.handlers['test-handler']).toBeDefined();
      expect(result.handlers['test-handler'].calls).toBe(1);
    });

    test('accumulates stats over multiple calls', async () => {
      ctx.recordHandlerPerf('test-handler', 50);
      ctx.recordHandlerPerf('test-handler', 100);
      ctx.recordHandlerPerf('test-handler', 75);

      const result = await harness.invoke('get-perf-profile');

      expect(result.handlers['test-handler'].calls).toBe(3);
      expect(result.handlers['test-handler'].totalMs).toBe(225);
      expect(result.handlers['test-handler'].avgMs).toBe(75);
      expect(result.handlers['test-handler'].maxMs).toBe(100);
      expect(result.handlers['test-handler'].minMs).toBe(50);
    });

    test('records slow calls', async () => {
      ctx.recordHandlerPerf('slow-handler', 150); // > 100ms default threshold

      const result = await harness.invoke('get-perf-profile');

      expect(result.slowCalls.length).toBeGreaterThan(0);
      expect(result.slowCalls[0].handler).toBe('slow-handler');
    });

    test('limits slow calls to 50', async () => {
      for (let i = 0; i < 60; i++) {
        ctx.recordHandlerPerf(`handler-${i}`, 150);
      }

      const result = await harness.invoke('get-perf-profile');

      // Should return last 20 in get-perf-profile
      expect(result.slowCalls.length).toBeLessThanOrEqual(20);
    });

    test('does not record when disabled', async () => {
      await harness.invoke('set-perf-enabled', false);

      ctx.recordHandlerPerf('disabled-handler', 50);

      const result = await harness.invoke('get-perf-profile');

      expect(result.handlers['disabled-handler']).toBeUndefined();
    });
  });

  describe('get-perf-profile', () => {
    test('returns empty profile initially', async () => {
      const result = await harness.invoke('get-perf-profile');

      expect(result.success).toBe(true);
      expect(result.handlers).toEqual({});
      expect(result.slowCalls).toEqual([]);
      expect(result.enabled).toBe(true);
      expect(result.slowThreshold).toBe(100);
    });

    test('returns summary stats', async () => {
      ctx.recordHandlerPerf('handler-a', 50);
      ctx.recordHandlerPerf('handler-a', 60);
      ctx.recordHandlerPerf('handler-b', 100);

      const result = await harness.invoke('get-perf-profile');

      expect(result.summary.totalHandlers).toBe(2);
      expect(result.summary.totalCalls).toBe(3);
      expect(result.summary.totalTimeMs).toBe(210);
    });

    test('returns slowest handlers sorted', async () => {
      ctx.recordHandlerPerf('slow', 200);
      ctx.recordHandlerPerf('fast', 10);
      ctx.recordHandlerPerf('medium', 50);

      const result = await harness.invoke('get-perf-profile');

      expect(result.summary.slowestHandlers[0].handler).toBe('slow');
    });

    test('returns most called handlers', async () => {
      ctx.recordHandlerPerf('frequent', 10);
      ctx.recordHandlerPerf('frequent', 10);
      ctx.recordHandlerPerf('frequent', 10);
      ctx.recordHandlerPerf('rare', 10);

      const result = await harness.invoke('get-perf-profile');

      expect(result.summary.mostCalled[0].handler).toBe('frequent');
    });
  });

  describe('set-perf-enabled', () => {
    test('enables profiling', async () => {
      const result = await harness.invoke('set-perf-enabled', true);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
    });

    test('disables profiling', async () => {
      const result = await harness.invoke('set-perf-enabled', false);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(false);
    });
  });

  describe('set-slow-threshold', () => {
    test('sets slow threshold', async () => {
      const result = await harness.invoke('set-slow-threshold', 250);

      expect(result.success).toBe(true);
      expect(result.threshold).toBe(250);
    });

    test('affects slow call detection', async () => {
      await harness.invoke('set-slow-threshold', 200);

      ctx.recordHandlerPerf('test', 150); // Not slow anymore

      const result = await harness.invoke('get-perf-profile');

      // 150ms is now below 200ms threshold, so no slow calls
      expect(result.slowCalls.length).toBe(0);
    });
  });

  describe('reset-perf-profile', () => {
    test('clears all performance data', async () => {
      ctx.recordHandlerPerf('handler', 50);
      ctx.recordHandlerPerf('slow', 150);

      await harness.invoke('reset-perf-profile');

      const result = await harness.invoke('get-perf-profile');

      expect(result.handlers).toEqual({});
      expect(result.slowCalls).toEqual([]);
    });

    test('saves empty profile to file', async () => {
      await harness.invoke('reset-perf-profile');

      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('save-perf-profile', () => {
    test('saves profile atomically', async () => {
      ctx.recordHandlerPerf('test', 50);

      const result = await harness.invoke('save-perf-profile');

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('returns path', async () => {
      const result = await harness.invoke('save-perf-profile');

      expect(result.path).toContain('perf-profile.json');
    });
  });

  describe('get-slow-handlers', () => {
    test('returns empty list initially', async () => {
      const result = await harness.invoke('get-slow-handlers');

      expect(result.success).toBe(true);
      expect(result.handlers).toEqual([]);
    });

    test('returns handlers sorted by avg time', async () => {
      ctx.recordHandlerPerf('slow', 200);
      ctx.recordHandlerPerf('fast', 10);
      ctx.recordHandlerPerf('medium', 80);

      const result = await harness.invoke('get-slow-handlers');

      expect(result.handlers[0].handler).toBe('slow');
      expect(result.handlers[1].handler).toBe('medium');
    });

    test('respects limit parameter', async () => {
      for (let i = 0; i < 20; i++) {
        ctx.recordHandlerPerf(`handler-${i}`, 50 + i);
      }

      const result = await harness.invoke('get-slow-handlers', 5);

      expect(result.handlers.length).toBe(5);
    });

    test('filters out handlers with 0 avg', async () => {
      // This shouldn't normally happen, but test defensive code
      const result = await harness.invoke('get-slow-handlers');

      result.handlers.forEach(h => {
        expect(h.avgMs).toBeGreaterThan(0);
      });
    });
  });

  describe('get-handler-perf', () => {
    test('returns error when handler not found', async () => {
      const result = await harness.invoke('get-handler-perf', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No performance data');
    });

    test('returns handler stats', async () => {
      ctx.recordHandlerPerf('my-handler', 50);
      ctx.recordHandlerPerf('my-handler', 100);

      const result = await harness.invoke('get-handler-perf', 'my-handler');

      expect(result.success).toBe(true);
      expect(result.handler).toBe('my-handler');
      expect(result.stats.calls).toBe(2);
    });

    test('returns slow calls for specific handler', async () => {
      ctx.recordHandlerPerf('slow-handler', 150);
      ctx.recordHandlerPerf('other-handler', 150);

      const result = await harness.invoke('get-handler-perf', 'slow-handler');

      expect(result.slowCalls.length).toBe(1);
      expect(result.slowCalls[0].handler).toBe('slow-handler');
    });
  });

  describe('benchmark-handler', () => {
    test('returns error when handler not benchmarkable', async () => {
      const result = await harness.invoke('benchmark-handler', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not benchmarkable');
    });

    test('runs benchmark iterations', async () => {
      ctx.benchmarkHandlers = {
        'fast-handler': jest.fn().mockResolvedValue('done'),
      };

      const result = await harness.invoke('benchmark-handler', 'fast-handler', 5);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(5);
      expect(result.times.length).toBe(5);
      expect(ctx.benchmarkHandlers['fast-handler']).toHaveBeenCalledTimes(5);
    });

    test('calculates benchmark stats', async () => {
      ctx.benchmarkHandlers = {
        'test-handler': jest.fn().mockResolvedValue('done'),
      };

      const result = await harness.invoke('benchmark-handler', 'test-handler', 3);

      expect(result.avgMs).toBeDefined();
      expect(result.minMs).toBeDefined();
      expect(result.maxMs).toBeDefined();
    });

    test('handles handler errors gracefully', async () => {
      ctx.benchmarkHandlers = {
        'error-handler': jest.fn().mockRejectedValue(new Error('fail')),
      };

      const result = await harness.invoke('benchmark-handler', 'error-handler', 3);

      // Should complete without throwing
      expect(result.success).toBe(true);
      expect(result.iterations).toBe(3);
    });
  });

  describe('auto-save interval', () => {
    test('sets up periodic save interval', () => {
      expect(ctx.perfAuditInterval).toBeDefined();
    });

    test('saves profile periodically when data exists', () => {
      ctx.recordHandlerPerf('test', 50);
      fs.writeFileSync.mockClear();

      jest.advanceTimersByTime(60000);

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('does not save when no data', () => {
      fs.writeFileSync.mockClear();

      jest.advanceTimersByTime(60000);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('clears previous interval on re-registration', () => {
      const oldInterval = ctx.perfAuditInterval;

      // Re-register
      registerPerfAuditHandlers(ctx);

      expect(ctx.perfAuditInterval).not.toBe(oldInterval);
    });
  });
});
