/**
 * Precommit IPC Handler Tests
 * Target: Full coverage of precommit-handlers.js
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
}));

// Mock child_process
jest.mock('child_process', () => {
  const execSync = jest.fn();
  const exec = jest.fn((cmd, opts, callback) => {
    try {
      const output = execSync(cmd, opts);
      callback(null, output, '');
    } catch (err) {
      callback(err, err.stdout?.toString() || '', err.stderr?.toString() || '');
    }
  });
  return { execSync, exec };
});

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { execSync } = require('child_process');
const { registerPrecommitHandlers } = require('../modules/ipc/precommit-handlers');

describe('Precommit Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Set up test runner mock
    ctx.runTests = jest.fn().mockResolvedValue({
      success: true,
      results: { passed: 10, failed: 0 },
    });

    // Set up validation mocks
    ctx.calculateConfidence = jest.fn(() => 80);
    ctx.INCOMPLETE_PATTERNS = [/TODO:/i, /FIXME:/i];

    // Default git mocks
    execSync.mockReturnValue('');
    fs.existsSync.mockReturnValue(false);

    registerPrecommitHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerPrecommitHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerPrecommitHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('run-pre-commit-checks', () => {
    test('runs tests and returns results', async () => {
      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^ci-\d+$/);
      expect(result.checks).toBeInstanceOf(Array);
    });

    test('includes passed test check', async () => {
      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const testCheck = result.checks.find(c => c.name === 'tests');
      expect(testCheck).toBeDefined();
      expect(testCheck.passed).toBe(true);
      expect(testCheck.message).toContain('10 tests passed');
    });

    test('fails when tests fail', async () => {
      ctx.runTests.mockResolvedValue({
        success: false,
        results: { passed: 8, failed: 2 },
      });

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      expect(result.passed).toBe(false);
      const testCheck = result.checks.find(c => c.name === 'tests');
      expect(testCheck.passed).toBe(false);
      expect(testCheck.message).toContain('2 tests failed');
    });

    test('handles runTests not being a function', async () => {
      ctx.runTests = 'not a function';

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      // Should not throw, just skip test check
      expect(result.success).toBe(true);
    });

    test('handles runTests throwing', async () => {
      ctx.runTests.mockRejectedValue(new Error('Test error'));

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      // Should not throw, test result marked as failed
      expect(result.success).toBe(true);
    });

    test('validates staged files', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--name-only')) {
          return 'file.js\ndata.json\n';
        }
        return '';
      });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('valid content');

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const validationCheck = result.checks.find(c => c.name === 'validation');
      expect(validationCheck).toBeDefined();
    });

    test('detects low confidence files', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--name-only')) {
          return 'file.js\n';
        }
        return '';
      });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('content');
      ctx.calculateConfidence.mockReturnValue(30);

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const validationCheck = result.checks.find(c => c.name === 'validation');
      expect(validationCheck.passed).toBe(false);
    });

    test('skips validation when not a git repo', async () => {
      execSync.mockImplementation(() => {
        throw new Error('Not a git repo');
      });

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const validationCheck = result.checks.find(c => c.name === 'validation');
      expect(validationCheck.message).toContain('Skipped');
    });

    test('checks for incomplete markers in staged diff', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--name-only')) {
          return '';
        }
        if (cmd.includes('git diff --cached')) {
          return '+ // TODO: finish this';
        }
        return '';
      });

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const incompleteCheck = result.checks.find(c => c.name === 'incomplete_check');
      expect(incompleteCheck).toBeDefined();
      expect(incompleteCheck.passed).toBe(false);
    });

    test('passes incomplete check when no markers', async () => {
      execSync.mockReturnValue('');

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      const incompleteCheck = result.checks.find(c => c.name === 'incomplete_check');
      if (incompleteCheck) {
        expect(incompleteCheck.passed).toBe(true);
      }
    });

    test('saves CI status to file', async () => {
      await harness.invoke('run-pre-commit-checks', '/test/project');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('ci-status.json'),
        expect.any(String),
        'utf-8'
      );
    });

    test('sends ci-check-complete event', async () => {
      await harness.invoke('run-pre-commit-checks', '/test/project');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('ci-check-complete', expect.any(Object));
    });

    test('handles destroyed mainWindow', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('run-pre-commit-checks', '/test/project');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('get-ci-status', () => {
    test('returns null when no status file exists', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('get-ci-status');

      expect(result.success).toBe(true);
      expect(result.status).toBeNull();
      expect(result.enabled).toBe(true);
    });

    test('returns saved status', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'ci-123',
        passed: true,
        checks: [],
      }));

      const result = await harness.invoke('get-ci-status');

      expect(result.success).toBe(true);
      expect(result.status.id).toBe('ci-123');
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const result = await harness.invoke('get-ci-status');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read failed');
    });
  });

  describe('set-ci-enabled', () => {
    test('enables CI checks', async () => {
      const result = await harness.invoke('set-ci-enabled', true);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
    });

    test('disables CI checks', async () => {
      const result = await harness.invoke('set-ci-enabled', false);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(false);
    });
  });

  describe('should-block-commit', () => {
    test('does not block when CI disabled', async () => {
      await harness.invoke('set-ci-enabled', false);

      const result = await harness.invoke('should-block-commit');

      expect(result.block).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    test('blocks when no CI check has run', async () => {
      const result = await harness.invoke('should-block-commit');

      expect(result.block).toBe(true);
      expect(result.reason).toContain('No CI check');
    });

    test('blocks when check is stale', async () => {
      // Run a check first
      await harness.invoke('run-pre-commit-checks', '/test/project');

      // Mock Date.now to return 10 minutes later
      const originalNow = Date.now;
      Date.now = () => originalNow() + 10 * 60 * 1000;

      const result = await harness.invoke('should-block-commit');

      Date.now = originalNow;

      expect(result.block).toBe(true);
      expect(result.reason).toContain('stale');
    });

    test('does not block when all checks passed', async () => {
      await harness.invoke('run-pre-commit-checks', '/test/project');

      const result = await harness.invoke('should-block-commit');

      expect(result.block).toBe(false);
      expect(result.reason).toContain('passed');
    });

    test('blocks when checks failed', async () => {
      ctx.runTests.mockResolvedValue({
        success: false,
        results: { passed: 0, failed: 5 },
      });

      await harness.invoke('run-pre-commit-checks', '/test/project');

      const result = await harness.invoke('should-block-commit');

      expect(result.block).toBe(true);
      expect(result.reason).toContain('failed');
    });
  });
});
