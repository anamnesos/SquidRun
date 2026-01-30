/**
 * Task Parser IPC Handler Tests
 * Target: Full coverage of task-parser-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

// Mock task-parser
jest.mock('../modules/task-parser', () => ({
  parseTaskInput: jest.fn(),
}));

const fs = require('fs');
const taskParser = require('../modules/task-parser');
const { registerTaskParserHandlers } = require('../modules/ipc/task-parser-handlers');

describe('Task Parser Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.triggers = {
      routeTask: jest.fn(() => ({ success: true, paneId: '1' })),
    };

    // Default mock behaviors
    fs.existsSync.mockReturnValue(false);
    taskParser.parseTaskInput.mockReturnValue({
      success: true,
      subtasks: [{ taskType: 'code', text: 'Write a function' }],
      ambiguity: { isAmbiguous: false },
    });

    registerTaskParserHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerTaskParserHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerTaskParserHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('parse-task-input', () => {
    test('parses input successfully', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [{ taskType: 'code', text: 'Build a feature' }],
        ambiguity: { isAmbiguous: false },
      });

      const result = await harness.invoke('parse-task-input', 'Build a feature');

      expect(result.success).toBe(true);
      expect(result.subtasks).toBeDefined();
      expect(taskParser.parseTaskInput).toHaveBeenCalledWith('Build a feature');
    });

    test('returns parser error', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: false,
        error: 'Invalid input',
      });

      const result = await harness.invoke('parse-task-input', '');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid input');
    });

    test('returns ambiguity info', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [{ taskType: 'code', text: 'Build something' }],
        ambiguity: { isAmbiguous: true, reason: 'Unclear scope' },
      });

      const result = await harness.invoke('parse-task-input', 'Build something');

      expect(result.success).toBe(true);
      expect(result.ambiguity.isAmbiguous).toBe(true);
    });
  });

  describe('route-task-input', () => {
    test('routes task to agents', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [
          { taskType: 'code', text: 'Write code' },
          { taskType: 'review', text: 'Review code' },
        ],
        ambiguity: { isAmbiguous: false },
      });

      const result = await harness.invoke('route-task-input', 'Write and review code', {});

      expect(result.success).toBe(true);
      expect(result.routed.length).toBe(2);
      expect(ctx.triggers.routeTask).toHaveBeenCalledTimes(2);
    });

    test('returns error when triggers not available', async () => {
      ctx.triggers = null;
      const harness2 = createIpcHarness();
      const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
      ctx2.WORKSPACE_PATH = '/test/workspace';
      ctx2.triggers = null;
      registerTaskParserHandlers(ctx2);

      const result = await harness2.invoke('route-task-input', 'Test', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('returns error when routeTask function missing', async () => {
      const harness2 = createIpcHarness();
      const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
      ctx2.WORKSPACE_PATH = '/test/workspace';
      ctx2.triggers = {}; // No routeTask
      registerTaskParserHandlers(ctx2);

      const result = await harness2.invoke('route-task-input', 'Test', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('stops on ambiguous input without force', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [{ taskType: 'unclear', text: 'Something vague' }],
        ambiguity: { isAmbiguous: true, reason: 'Unclear intent' },
      });

      const result = await harness.invoke('route-task-input', 'Do something', {});

      expect(result.success).toBe(false);
      expect(result.reason).toBe('ambiguous');
      expect(result.ambiguity.isAmbiguous).toBe(true);
    });

    test('routes ambiguous input with force option', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [{ taskType: 'unclear', text: 'Something vague' }],
        ambiguity: { isAmbiguous: true, reason: 'Unclear intent' },
      });

      const result = await harness.invoke('route-task-input', 'Do something', { force: true });

      expect(result.success).toBe(true);
      expect(result.routed.length).toBe(1);
    });

    test('returns parse error', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: false,
        error: 'Parse failed',
      });

      const result = await harness.invoke('route-task-input', 'Bad input', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Parse failed');
    });

    test('loads performance data if available', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        agents: { '1': { completions: 10 } },
      }));

      await harness.invoke('route-task-input', 'Test task', {});

      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('tracks routing failures', async () => {
      ctx.triggers.routeTask.mockReturnValue({ success: false, error: 'No agent' });
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        subtasks: [{ taskType: 'code', text: 'Task' }],
        ambiguity: { isAmbiguous: false },
      });

      const result = await harness.invoke('route-task-input', 'Task', {});

      expect(result.success).toBe(false);
      expect(result.routed[0].routing.success).toBe(false);
    });
  });
});
