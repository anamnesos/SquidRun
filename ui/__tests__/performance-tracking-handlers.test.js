/**
 * Performance Tracking IPC Handler Tests
 * Target: Full coverage of performance-tracking-handlers.js
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
const { registerPerformanceTrackingHandlers } = require('../modules/ipc/performance-tracking-handlers');

describe('Performance Tracking Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.PANE_ROLES = {
      '1': 'Architect',
      '2': 'Orchestrator',
      '3': 'Implementer A',
      '4': 'Implementer B',
      '5': 'Investigator',
      '6': 'Reviewer',
    };

    // Default: no existing performance file
    fs.existsSync.mockReturnValue(false);

    registerPerformanceTrackingHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('record-completion', () => {
    test('records completion for pane', async () => {
      const result = await harness.invoke('record-completion', '1');

      expect(result.success).toBe(true);
      expect(result.completions).toBe(1);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('increments existing completions', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '1': { completions: 5, errors: 0, totalResponseTime: 0, responseCount: 0 } },
      }));

      const result = await harness.invoke('record-completion', '1');

      expect(result.completions).toBe(6);
    });

    test('initializes new agent data', async () => {
      const result = await harness.invoke('record-completion', '7');

      expect(result.success).toBe(true);
      expect(result.completions).toBe(1);
    });
  });

  describe('record-error', () => {
    test('records error for pane', async () => {
      const result = await harness.invoke('record-error', '2');

      expect(result.success).toBe(true);
      expect(result.errors).toBe(1);
    });

    test('increments existing errors', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '2': { completions: 0, errors: 3, totalResponseTime: 0, responseCount: 0 } },
      }));

      const result = await harness.invoke('record-error', '2');

      expect(result.errors).toBe(4);
    });

    test('initializes new agent data for unknown pane', async () => {
      // Pane '7' is not in DEFAULT_PERFORMANCE (only 1-6), so triggers line 66
      const result = await harness.invoke('record-error', '7');

      expect(result.success).toBe(true);
      expect(result.errors).toBe(1);
    });
  });

  describe('record-response-time', () => {
    test('records response time', async () => {
      const result = await harness.invoke('record-response-time', '1', 5000);

      expect(result.success).toBe(true);
      expect(result.avgResponseTime).toBe(5000);
    });

    test('calculates average over multiple calls', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '1': { completions: 0, errors: 0, totalResponseTime: 3000, responseCount: 1 } },
      }));

      const result = await harness.invoke('record-response-time', '1', 5000);

      expect(result.avgResponseTime).toBe(4000); // (3000 + 5000) / 2
    });

    test('initializes new agent data for unknown pane', async () => {
      // Pane '8' is not in DEFAULT_PERFORMANCE (only 1-6), so triggers line 77
      const result = await harness.invoke('record-response-time', '8', 3000);

      expect(result.success).toBe(true);
      expect(result.avgResponseTime).toBe(3000);
    });
  });

  describe('get-performance', () => {
    test('returns empty performance data', async () => {
      const result = await harness.invoke('get-performance');

      expect(result.success).toBe(true);
      expect(result.agents).toBeDefined();
      expect(Object.keys(result.agents).length).toBe(6);
    });

    test('returns performance with roles', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: {
          '1': { completions: 10, errors: 2, totalResponseTime: 5000, responseCount: 5 },
        },
        lastUpdated: '2026-01-01T00:00:00Z',
      }));

      const result = await harness.invoke('get-performance');

      expect(result.success).toBe(true);
      expect(result.agents['1'].role).toBe('Architect');
      expect(result.agents['1'].avgResponseTime).toBe(1000);
      expect(result.agents['1'].successes).toBe(8); // 10 - 2
      expect(result.lastUpdated).toBe('2026-01-01T00:00:00Z');
    });

    test('handles missing role', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '99': { completions: 5, errors: 0, totalResponseTime: 0, responseCount: 0 } },
      }));

      const result = await harness.invoke('get-performance');

      expect(result.agents['99'].role).toBe('Pane 99');
    });
  });

  describe('get-performance-stats', () => {
    test('returns stats format', async () => {
      const result = await harness.invoke('get-performance-stats');

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
    });

    test('calculates avgResponseTime correctly', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: {
          '1': { completions: 5, errors: 1, totalResponseTime: 10000, responseCount: 4 },
        },
      }));

      const result = await harness.invoke('get-performance-stats');

      expect(result.stats['1'].avgResponseTime).toBe(2500);
    });

    test('handles zero responseCount', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: {
          '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
        },
      }));

      const result = await harness.invoke('get-performance-stats');

      expect(result.stats['1'].avgResponseTime).toBe(0);
    });
  });

  describe('reset-performance', () => {
    test('resets all performance data', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '1': { completions: 100 } },
      }));

      const result = await harness.invoke('reset-performance');

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('reset-performance-stats', () => {
    test('resets all stats (alias for reset-performance)', async () => {
      const result = await harness.invoke('reset-performance-stats');

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('atomic save', () => {
    test('saves atomically with temp file', async () => {
      await harness.invoke('record-completion', '1');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('handles save error gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      // Should not throw
      const result = await harness.invoke('record-completion', '1');

      expect(result.success).toBe(true);
    });
  });

  describe('load error handling', () => {
    test('returns defaults on parse error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json');

      const result = await harness.invoke('get-performance');

      expect(result.success).toBe(true);
      expect(result.agents).toBeDefined();
    });

    test('returns defaults on read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('get-performance');

      expect(result.success).toBe(true);
    });
  });
});
