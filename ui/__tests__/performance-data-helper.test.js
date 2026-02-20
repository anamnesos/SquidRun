/**
 * Performance Data IPC Helper Tests
 * Target: Shared performance default + loader behavior
 */

// Mock fs
jest.mock('fs', () => {
  const existsSync = jest.fn(() => false);
  const readFileSync = jest.fn();

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
  };

  return {
    constants: { F_OK: 0 },
    existsSync,
    readFileSync,
    promises,
  };
});

const fs = require('fs');
const {
  createDefaultPerformance,
  createPerformanceLoader,
} = require('../modules/performance-data');

describe('Performance Data Helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns defaults when workspace path is missing', async () => {
    const loadPerformance = createPerformanceLoader({ workspacePath: null });

    const result = await loadPerformance();

    expect(result).toEqual(createDefaultPerformance());
  });

  test('merges loaded data with default shape', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      agents: {
        '1': { completions: 12, errors: 2, totalResponseTime: 2000, responseCount: 2 },
      },
      lastUpdated: '2026-01-01T00:00:00Z',
    }));

    const loadPerformance = createPerformanceLoader({ workspacePath: '/test/workspace' });
    const result = await loadPerformance();

    expect(result.lastUpdated).toBe('2026-01-01T00:00:00Z');
    expect(result.agents['1'].completions).toBe(12);
    expect(result.agents['2']).toBeUndefined();
  });

  test('returns defaults and does not log for ENOENT', async () => {
    fs.existsSync.mockReturnValue(false);
    const logger = { error: jest.fn() };
    const loadPerformance = createPerformanceLoader({
      workspacePath: '/test/workspace',
      log: logger,
      logScope: 'Smart Routing',
      logMessage: 'Error loading performance:',
    });

    const result = await loadPerformance();

    expect(result).toEqual(createDefaultPerformance());
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('logs and returns defaults for parse error', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('invalid json');
    const logger = { error: jest.fn() };
    const loadPerformance = createPerformanceLoader({
      workspacePath: '/test/workspace',
      log: logger,
      logScope: 'TaskParser',
      logMessage: 'Error loading performance:',
    });

    const result = await loadPerformance();

    expect(result).toEqual(createDefaultPerformance());
    expect(logger.error).toHaveBeenCalledWith(
      'TaskParser',
      'Error loading performance:',
      expect.any(String)
    );
  });
});
