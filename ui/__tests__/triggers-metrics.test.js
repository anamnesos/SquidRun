/**
 * Triggers - Reliability Metrics Tests
 * Target: Full coverage of triggers/metrics.js
 */

'use strict';

jest.mock('../config', () => ({
  PANE_IDS: ['1', '2', '5'],
}));

jest.mock('../modules/formatters', () => ({
  formatDuration: jest.fn((ms) => `${Math.round(ms / 1000)}s`),
}));

// We need to isolate module state between tests — re-require each time
let metrics;

function loadFreshModule() {
  jest.resetModules();
  jest.mock('../config', () => ({ PANE_IDS: ['1', '2', '5'] }));
  jest.mock('../modules/formatters', () => ({
    formatDuration: jest.fn((ms) => `${Math.round(ms / 1000)}s`),
  }));
  return require('../modules/triggers/metrics');
}

describe('Triggers Metrics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    metrics = loadFreshModule();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── recordSent ──

  describe('recordSent', () => {
    test('increments aggregate sent count', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      metrics.recordSent('pty', 'trigger', ['2']);
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.sent).toBe(2);
    });

    test('increments mode stats', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.byMode.pty.sent).toBe(1);
    });

    test('increments type stats', () => {
      metrics.recordSent('pty', 'broadcast', ['1', '2']);
      const stats = metrics.getReliabilityStats();
      expect(stats.byType.broadcast.sent).toBe(1);
    });

    test('increments per-pane stats for each pane', () => {
      metrics.recordSent('pty', 'trigger', ['1', '2', '5']);
      const stats = metrics.getReliabilityStats();
      expect(stats.byPane['1'].sent).toBe(1);
      expect(stats.byPane['2'].sent).toBe(1);
      expect(stats.byPane['5'].sent).toBe(1);
    });

    test('returns sentAt timestamp', () => {
      const result = metrics.recordSent('pty', 'trigger', ['1']);
      expect(typeof result.sentAt).toBe('number');
      expect(result.sentAt).toBeGreaterThan(0);
    });

    test('returns queuedAt when provided', () => {
      const result = metrics.recordSent('pty', 'trigger', ['1'], 12345);
      expect(result.queuedAt).toBe(12345);
    });

    test('ignores unknown mode gracefully', () => {
      metrics.recordSent('unknown_mode', 'trigger', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.sent).toBe(1);
    });

    test('ignores unknown type gracefully', () => {
      metrics.recordSent('pty', 'unknown_type', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.sent).toBe(1);
    });

    test('ignores unknown paneId gracefully', () => {
      metrics.recordSent('pty', 'trigger', ['99']);
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.sent).toBe(1);
      expect(stats.byPane['99']).toBeUndefined();
    });
  });

  // ── recordDelivered ──

  describe('recordDelivered', () => {
    test('increments aggregate delivered count', () => {
      metrics.recordDelivered('pty', 'trigger', '1');
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.delivered).toBe(1);
    });

    test('increments mode stats', () => {
      metrics.recordDelivered('pty', 'direct', '2');
      const stats = metrics.getReliabilityStats();
      expect(stats.byMode.pty.delivered).toBe(1);
    });

    test('increments type stats', () => {
      metrics.recordDelivered('pty', 'direct', '2');
      const stats = metrics.getReliabilityStats();
      expect(stats.byType.direct.delivered).toBe(1);
    });

    test('increments pane stats', () => {
      metrics.recordDelivered('pty', 'trigger', '5');
      const stats = metrics.getReliabilityStats();
      expect(stats.byPane['5'].delivered).toBe(1);
    });

    test('tracks latency when sentAt provided', () => {
      const sentAt = Date.now() - 150;
      metrics.recordDelivered('pty', 'trigger', '1', sentAt);
      const stats = metrics.getReliabilityStats();
      expect(stats.latency.sampleCount).toBe(1);
      expect(stats.latency.avg).toBe(150);
      expect(stats.latency.min).toBe(150);
      expect(stats.latency.max).toBe(150);
    });

    test('does not track latency when sentAt is null', () => {
      metrics.recordDelivered('pty', 'trigger', '1', null);
      const stats = metrics.getReliabilityStats();
      expect(stats.latency.sampleCount).toBe(0);
    });

    test('calculates avg/min/max across multiple samples', () => {
      const now = Date.now();
      metrics.recordDelivered('pty', 'trigger', '1', now - 100);
      metrics.recordDelivered('pty', 'trigger', '1', now - 200);
      metrics.recordDelivered('pty', 'trigger', '1', now - 300);
      const stats = metrics.getReliabilityStats();
      expect(stats.latency.sampleCount).toBe(3);
      expect(stats.latency.avg).toBe(200);
      expect(stats.latency.min).toBe(100);
      expect(stats.latency.max).toBe(300);
    });

    test('evicts oldest latency sample when exceeding maxSamples', () => {
      const now = Date.now();
      // Default maxSamples is 100; push 101
      for (let i = 0; i < 101; i++) {
        metrics.recordDelivered('pty', 'trigger', '1', now - (i + 1) * 10);
      }
      const stats = metrics.getReliabilityStats();
      expect(stats.latency.sampleCount).toBe(100);
    });
  });

  // ── recordFailed ──

  describe('recordFailed', () => {
    test('increments aggregate failed count', () => {
      metrics.recordFailed('pty', 'trigger', '1', 'timeout');
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.failed).toBe(1);
    });

    test('increments mode, type, and pane stats', () => {
      metrics.recordFailed('pty', 'broadcast', '2', 'error');
      const stats = metrics.getReliabilityStats();
      expect(stats.byMode.pty.failed).toBe(1);
      expect(stats.byType.broadcast.failed).toBe(1);
      expect(stats.byPane['2'].failed).toBe(1);
    });
  });

  // ── recordTimeout ──

  describe('recordTimeout', () => {
    test('increments aggregate timedOut count', () => {
      metrics.recordTimeout('pty', 'trigger', ['1', '2']);
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.timedOut).toBe(1);
    });

    test('increments mode timedOut', () => {
      metrics.recordTimeout('pty', 'direct', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.byMode.pty.timedOut).toBe(1);
    });
  });

  // ── recordSkipped ──

  describe('recordSkipped', () => {
    test('increments aggregate skipped count', () => {
      metrics.recordSkipped('pane1', 42, 'pane2');
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.skipped).toBe(1);
    });
  });

  // ── getReliabilityStats ──

  describe('getReliabilityStats', () => {
    test('returns uptime', () => {
      jest.advanceTimersByTime(5000);
      const stats = metrics.getReliabilityStats();
      expect(stats.uptime).toBe(5000);
      expect(stats.uptimeFormatted).toBe('5s');
    });

    test('returns 100% success rate when no messages sent', () => {
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.successRate).toBe(100);
    });

    test('calculates correct success rate', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      metrics.recordSent('pty', 'trigger', ['2']);
      metrics.recordSent('pty', 'trigger', ['5']);
      metrics.recordDelivered('pty', 'trigger', '1');
      metrics.recordDelivered('pty', 'trigger', '2');
      // 3rd not delivered
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.successRate).toBe(67); // Math.round(2/3*100)
    });

    test('includes rolling window stats (15m and 1h)', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.windows).toBeDefined();
      expect(stats.windows.last15m).toBeDefined();
      expect(stats.windows.last1h).toBeDefined();
      expect(stats.windows.last15m.sent).toBe(1);
      expect(stats.windows.last1h.sent).toBe(1);
    });

    test('rolling window excludes old events', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      // Advance past 15m window but within 1h
      jest.advanceTimersByTime(16 * 60 * 1000);
      metrics.recordSent('pty', 'trigger', ['2']);
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.sent).toBe(1); // only the recent one
      expect(stats.windows.last1h.sent).toBe(2); // both
    });

    test('rolling window excludes events older than 1h', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      jest.advanceTimersByTime(61 * 60 * 1000);
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.sent).toBe(0);
      expect(stats.windows.last1h.sent).toBe(0);
    });

    test('returns zero latency when no samples', () => {
      const stats = metrics.getReliabilityStats();
      expect(stats.latency.avg).toBe(0);
      expect(stats.latency.min).toBe(0);
      expect(stats.latency.max).toBe(0);
      expect(stats.latency.sampleCount).toBe(0);
    });

    test('returns deep copies (not references)', () => {
      metrics.recordSent('pty', 'trigger', ['1']);
      const stats1 = metrics.getReliabilityStats();
      metrics.recordSent('pty', 'trigger', ['2']);
      const stats2 = metrics.getReliabilityStats();
      expect(stats1.aggregate.sent).toBe(1);
      expect(stats2.aggregate.sent).toBe(2);
    });
  });

  // ── Event log overflow ──

  describe('event log overflow', () => {
    test('caps event log at MAX_METRICS_EVENTS', () => {
      // Send more than 2000 events
      for (let i = 0; i < 2010; i++) {
        metrics.recordSent('pty', 'trigger', ['1']);
      }
      // The aggregate counter should still track all
      const stats = metrics.getReliabilityStats();
      expect(stats.aggregate.sent).toBe(2010);
      // But window stats should only have recent ones (within window)
      expect(stats.windows.last15m.sent).toBeLessThanOrEqual(2000);
    });
  });

  // ── Window stats counting ──

  describe('window stats counting', () => {
    test('counts delivered events in window', () => {
      metrics.recordDelivered('pty', 'trigger', '1');
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.delivered).toBe(1);
    });

    test('counts failed events in window', () => {
      metrics.recordFailed('pty', 'trigger', '1', 'error');
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.failed).toBe(1);
    });

    test('counts timeout events in window', () => {
      metrics.recordTimeout('pty', 'trigger', ['1']);
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.timedOut).toBe(1);
    });

    test('counts skipped events in window', () => {
      metrics.recordSkipped('sender', 1, 'recipient');
      const stats = metrics.getReliabilityStats();
      expect(stats.windows.last15m.skipped).toBe(1);
    });
  });
});
