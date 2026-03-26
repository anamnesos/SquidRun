/**
 * Task Parser IPC Handler Tests
 * Target: Full coverage of task-parser-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => {
  const existsSync = jest.fn();
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

var mockUpsertProblemCase = jest.fn();
jest.mock('../modules/problem-orchestrator', () => ({
  getSharedProblemOrchestrator: jest.fn(() => ({
    upsertProblemCase: mockUpsertProblemCase,
    previewProblemCase: jest.fn(() => ({
      ok: true,
      case: {
        caseId: 'preview-1',
        userFacing: {
          shortNotice: 'Here is what we can do: map the legal issue and build an evidence packet.',
        },
      },
    })),
  })),
}));

const fs = require('fs');
const taskParser = require('../modules/task-parser');
const { registerTaskParserHandlers } = require('../modules/ipc/task-parser-handlers');

describe('Task Parser Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsertProblemCase.mockReset();
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
      problemIntake: { detected: false, domain: null },
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
        problemIntake: { detected: false, domain: null },
      });

      const result = await harness.invoke('parse-task-input', 'Build a feature');

      expect(result.success).toBe(true);
      expect(result.subtasks).toBeDefined();
      expect(taskParser.parseTaskInput).toHaveBeenCalledWith('Build a feature');
    });

    test('returns problem preview for high-stakes input', async () => {
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        raw: 'My landlord is threatening eviction over a lease dispute.',
        subtasks: [{ taskType: 'coordination', text: 'Need help' }],
        ambiguity: { isAmbiguous: false },
        problemIntake: { detected: true, domain: 'legal' },
      });

      const result = await harness.invoke('parse-task-input', 'Need help');

      expect(result.problemPreview).toEqual(expect.objectContaining({
        ok: true,
      }));
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
        problemIntake: { detected: false, domain: null },
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
        problemIntake: { detected: false, domain: null },
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
        problemIntake: { detected: false, domain: null },
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
        problemIntake: { detected: false, domain: null },
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
        problemIntake: { detected: false, domain: null },
      });

      const result = await harness.invoke('route-task-input', 'Task', {});

      expect(result.success).toBe(false);
      expect(result.routed[0].routing.success).toBe(false);
    });

    test('creates a problem case when routed input is high-stakes', async () => {
      mockUpsertProblemCase.mockReturnValue({
        ok: true,
        created: true,
        case: {
          caseId: 'case-1',
          status: 'capability_plan',
          userFacing: {
            shortNotice: 'Here is what we can do: map the legal issue and build an evidence packet.',
          },
        },
      });
      taskParser.parseTaskInput.mockReturnValue({
        success: true,
        raw: 'My landlord is threatening eviction over a lease dispute.',
        subtasks: [{ taskType: 'coordination', text: 'Need help' }],
        ambiguity: { isAmbiguous: false },
        problemIntake: { detected: true, domain: 'legal' },
      });

      const result = await harness.invoke('route-task-input', 'Need help', {});

      expect(mockUpsertProblemCase).toHaveBeenCalledWith(expect.objectContaining({
        source: 'route-task-input',
        parsed: expect.objectContaining({
          raw: 'My landlord is threatening eviction over a lease dispute.',
        }),
      }));
      expect(result.problemCase).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));
      expect(result.problemCase.case.userFacing.shortNotice).toContain('Here is what we can do');
    });
  });
});
