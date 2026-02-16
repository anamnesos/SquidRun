/**
 * Learning Data IPC Handler Tests
 * Target: Full coverage of agent-metrics-handlers.js (learning channels)
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => {
  const existsSync = jest.fn();
  const readFileSync = jest.fn();
  const writeFileSync = jest.fn();
  const renameSync = jest.fn();

  const promises = {
    access: jest.fn((targetPath) => {
      if (existsSync(targetPath)) {
        return Promise.resolve();
      }
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      return Promise.reject(err);
    }),
    readFile: jest.fn((targetPath, encoding) => {
      try {
        return Promise.resolve(readFileSync(targetPath, encoding));
      } catch (err) {
        return Promise.reject(err);
      }
    }),
    writeFile: jest.fn((targetPath, data, encoding) => {
      try {
        writeFileSync(targetPath, data, encoding);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    }),
    rename: jest.fn((sourcePath, targetPath) => {
      try {
        renameSync(sourcePath, targetPath);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    }),
  };

  return {
    constants: { F_OK: 0 },
    existsSync,
    readFileSync,
    writeFileSync,
    renameSync,
    promises,
  };
});

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerAgentMetricsHandlers } = require('../modules/ipc/agent-metrics-handlers');

describe('Learning Data Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.PANE_ROLES = {
      '1': 'Architect',
      '2': 'Builder',
      '5': 'Oracle',
    };

    // Default: no existing learning file
    fs.existsSync.mockReturnValue(false);

    registerAgentMetricsHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerAgentMetricsHandlers(null)).toThrow('registerAgentMetricsHandlers requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerAgentMetricsHandlers({})).toThrow('registerAgentMetricsHandlers requires ctx.ipcMain');
    });
  });

  describe('record-task-outcome', () => {
    test('records successful task outcome', async () => {
      const result = await harness.invoke('record-task-outcome', 'code-review', '5', true, 5000);

      expect(result.success).toBe(true);
      expect(result.taskType).toBe('code-review');
      expect(result.paneId).toBe('5');
      expect(result.successRate).toBe(1);
      expect(result.newWeight).toBe(1.0); // 0.5 + (1.0 * 0.5)
    });

    test('records failed task outcome', async () => {
      const result = await harness.invoke('record-task-outcome', 'build', '2', false, 10000);

      expect(result.success).toBe(true);
      expect(result.successRate).toBe(0);
      expect(result.newWeight).toBe(0.5); // 0.5 + (0 * 0.5)
    });

    test('updates existing task type stats', async () => {
      // First outcome - success
      await harness.invoke('record-task-outcome', 'test', '1', true, 1000);

      // Simulate existing data
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          test: {
            agentStats: {
              '1': { success: 1, failure: 0, totalTime: 1000, attempts: 1 },
            },
            totalAttempts: 1,
          },
        },
        routingWeights: { '1': 1.0 },
        totalDecisions: 1,
      }));

      // Second outcome - failure
      const result = await harness.invoke('record-task-outcome', 'test', '1', false, 2000);

      expect(result.successRate).toBe(0.5); // 1 success / 2 attempts
      expect(result.newWeight).toBe(0.75); // 0.5 + (0.5 * 0.5)
    });

    test('saves learning data atomically', async () => {
      await harness.invoke('record-task-outcome', 'task', '1', true, 100);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('handles time as undefined', async () => {
      const result = await harness.invoke('record-task-outcome', 'quick-task', '2', true);

      expect(result.success).toBe(true);
    });

    test('handles load error gracefully', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      // Should use default learning data
      const result = await harness.invoke('record-task-outcome', 'task', '1', true, 100);

      expect(result.success).toBe(true);
    });
  });

  describe('get-learning-data', () => {
    test('returns default data when no file exists', async () => {
      const result = await harness.invoke('get-learning-data');

      expect(result.success).toBe(true);
      expect(result.taskTypes).toEqual({});
      expect(result.routingWeights).toEqual({
        '1': 1.0, '2': 1.0, '5': 1.0,
      });
      expect(result.totalDecisions).toBe(0);
    });

    test('returns existing learning data with insights', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          'code-review': {
            agentStats: {
              '5': { success: 10, failure: 2, totalTime: 120000, attempts: 12 },
              '1': { success: 3, failure: 1, totalTime: 40000, attempts: 4 },
            },
            totalAttempts: 16,
          },
        },
        routingWeights: { '1': 0.875, '5': 0.916 },
        totalDecisions: 16,
        lastUpdated: '2026-01-30T10:00:00Z',
      }));

      const result = await harness.invoke('get-learning-data');

      expect(result.success).toBe(true);
      expect(result.insights['code-review']).toBeDefined();
      expect(result.insights['code-review'].bestAgent.paneId).toBe('5');
      expect(result.insights['code-review'].rankings.length).toBe(2);
      expect(result.lastUpdated).toBe('2026-01-30T10:00:00Z');
    });

    test('calculates insights correctly', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          build: {
            agentStats: {
              '2': { success: 8, failure: 2, totalTime: 50000, attempts: 10 },
            },
            totalAttempts: 10,
          },
        },
        routingWeights: {},
        totalDecisions: 10,
      }));

      const result = await harness.invoke('get-learning-data');

      expect(result.insights.build.bestAgent.successRate).toBe(0.8);
      expect(result.insights.build.bestAgent.avgTime).toBe(5000);
      expect(result.insights.build.bestAgent.role).toBe('Builder');
    });
  });

  describe('get-best-agent-for-task', () => {
    test('returns null when no data for task type', async () => {
      const result = await harness.invoke('get-best-agent-for-task', 'unknown-task');

      expect(result.success).toBe(true);
      expect(result.bestAgent).toBeNull();
      expect(result.reason).toBe('No data for task type');
    });

    test('returns null when no agent has enough attempts', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          test: {
            agentStats: {
              '1': { success: 1, failure: 0, totalTime: 1000, attempts: 1 },
            },
          },
        },
      }));

      const result = await harness.invoke('get-best-agent-for-task', 'test');

      expect(result.bestAgent).toBeNull();
      expect(result.reason).toBe('Insufficient data');
    });

    test('returns best agent when data available', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          'code-review': {
            agentStats: {
              '5': { success: 9, failure: 1, totalTime: 100000, attempts: 10 },
              '1': { success: 6, failure: 4, totalTime: 80000, attempts: 10 },
            },
          },
        },
      }));

      const result = await harness.invoke('get-best-agent-for-task', 'code-review');

      expect(result.success).toBe(true);
      expect(result.bestAgent.paneId).toBe('5');
      expect(result.bestAgent.successRate).toBe(0.9);
      expect(result.bestAgent.role).toBe('Oracle');
      expect(result.reason).toContain('90%');
    });

    test('requires minimum 2 attempts for consideration', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {
          task: {
            agentStats: {
              '1': { success: 1, failure: 0, totalTime: 1000, attempts: 1 },
              '2': { success: 1, failure: 1, totalTime: 2000, attempts: 2 },
            },
          },
        },
      }));

      const result = await harness.invoke('get-best-agent-for-task', 'task');

      // Agent 2 has 2 attempts, agent 1 only has 1
      expect(result.bestAgent.paneId).toBe('2');
    });
  });

  describe('reset-learning', () => {
    test('resets all learning data', async () => {
      const result = await harness.invoke('reset-learning');

      expect(result).toEqual({ success: true });
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('saves default learning structure', async () => {
      await harness.invoke('reset-learning');

      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.taskTypes).toEqual({});
      expect(writtenData.totalDecisions).toBe(0);
      expect(writtenData.lastUpdated).toBeDefined();
    });
  });

  describe('get-routing-weights', () => {
    test('returns default weights when no file', async () => {
      const result = await harness.invoke('get-routing-weights');

      expect(result.success).toBe(true);
      expect(result.weights).toEqual({
        '1': 1.0, '2': 1.0, '5': 1.0,
      });
    });

    test('returns learned weights', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        routingWeights: { '1': 0.9, '2': 0.7, '3': 0.85 },
      }));

      const result = await harness.invoke('get-routing-weights');

      expect(result.weights['1']).toBe(0.9);
      expect(result.weights['2']).toBe(0.7);
    });
  });
});
