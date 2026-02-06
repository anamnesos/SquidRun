/**
 * Completion Detection IPC Handler Tests
 * Target: Full coverage of completion-detection-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerCompletionDetectionHandlers } = require('../modules/ipc/completion-detection-handlers');

describe('Completion Detection Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    registerCompletionDetectionHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('check-completion', () => {
    test('detects "task complete" pattern', async () => {
      const result = await harness.invoke('check-completion', 'The task complete and ready for review');

      expect(result.completed).toBe(true);
      expect(result.pattern).toBeDefined();
    });

    test('detects "task done" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Task done!');

      expect(result.completed).toBe(true);
    });

    test('detects "completed task" pattern', async () => {
      const result = await harness.invoke('check-completion', 'completed task successfully');

      expect(result.completed).toBe(true);
    });

    test('detects "ready for review" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Code is ready for review');

      expect(result.completed).toBe(true);
    });

    test('detects "ready for next" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Ready for next steps');

      expect(result.completed).toBe(true);
    });

    test('detects "ready for handoff" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Ready for handoff to reviewer');

      expect(result.completed).toBe(true);
    });

    test('detects "handing off to" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Handing off to Worker B');

      expect(result.completed).toBe(true);
    });

    test('detects "triggering lead" pattern', async () => {
      const result = await harness.invoke('check-completion', 'Triggering lead now');

      expect(result.completed).toBe(true);
    });

    test('detects "triggered backend" pattern', async () => {
      const result = await harness.invoke('check-completion', 'I triggered backend');

      expect(result.completed).toBe(true);
    });

    test('detects emoji done pattern', async () => {
      const result = await harness.invoke('check-completion', '✅ done with the feature');

      expect(result.completed).toBe(true);
    });

    test('detects "DONE:" prefix', async () => {
      const result = await harness.invoke('check-completion', 'DONE: Implemented the feature');

      expect(result.completed).toBe(true);
    });

    test('detects "COMPLETE:" prefix', async () => {
      const result = await harness.invoke('check-completion', 'COMPLETE: All tests passing');

      expect(result.completed).toBe(true);
    });

    test('returns false for non-completion text', async () => {
      const result = await harness.invoke('check-completion', 'Working on the implementation');

      expect(result.completed).toBe(false);
      expect(result.pattern).toBeUndefined();
    });

    test('is case insensitive', async () => {
      const result = await harness.invoke('check-completion', 'TASK COMPLETE');

      expect(result.completed).toBe(true);
    });

    test('handles empty string', async () => {
      const result = await harness.invoke('check-completion', '');

      expect(result.completed).toBe(false);
    });
  });

  describe('get-completion-patterns', () => {
    test('returns array of pattern strings', async () => {
      const result = await harness.invoke('get-completion-patterns');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      result.forEach(pattern => {
        expect(typeof pattern).toBe('string');
        expect(pattern.startsWith('/')).toBe(true);
      });
    });

    test('includes task completion pattern', async () => {
      const result = await harness.invoke('get-completion-patterns');

      const hasTaskPattern = result.some(p => p.includes('task') && p.includes('complete'));
      expect(hasTaskPattern).toBe(true);
    });

    test('includes DONE pattern', async () => {
      const result = await harness.invoke('get-completion-patterns');

      const hasDonePattern = result.some(p => p.includes('DONE'));
      expect(hasDonePattern).toBe(true);
    });
  });
});
