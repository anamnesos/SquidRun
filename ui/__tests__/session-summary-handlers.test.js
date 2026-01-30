/**
 * Session Summary IPC Handler Tests
 * Target: Full coverage of session-summary-handlers.js
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
  unlinkSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerSessionSummaryHandlers } = require('../modules/ipc/session-summary-handlers');

describe('Session Summary Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';

    registerSessionSummaryHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('save-session-summary', () => {
    test('saves summary to new file when none exists', async () => {
      fs.existsSync.mockReturnValue(false);

      const summary = { title: 'Test Session', notes: 'Some notes' };
      const result = await harness.invoke('save-session-summary', summary);

      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^session-\d+$/);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('appends to existing summaries', async () => {
      const existingSummaries = [
        { id: 'session-1', title: 'Old Session' },
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingSummaries));

      const summary = { title: 'New Session' };
      const result = await harness.invoke('save-session-summary', summary);

      expect(result.success).toBe(true);
      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBe(2);
    });

    test('limits summaries to 50', async () => {
      const existingSummaries = Array.from({ length: 55 }, (_, i) => ({
        id: `session-${i}`,
        title: `Session ${i}`,
      }));
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingSummaries));

      const result = await harness.invoke('save-session-summary', { title: 'Overflow' });

      expect(result.success).toBe(true);
      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBe(50);
    });

    test('adds savedAt and id to summary', async () => {
      fs.existsSync.mockReturnValue(false);

      const summary = { title: 'Test', content: 'Data' };
      await harness.invoke('save-session-summary', summary);

      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData[0]).toHaveProperty('savedAt');
      expect(writtenData[0]).toHaveProperty('id');
      expect(writtenData[0].title).toBe('Test');
    });

    test('uses atomic write (temp file + rename)', async () => {
      fs.existsSync.mockReturnValue(false);

      await harness.invoke('save-session-summary', { title: 'Atomic Test' });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('handles file read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const result = await harness.invoke('save-session-summary', { title: 'Error Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read failed');
    });

    test('handles file write error', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = await harness.invoke('save-session-summary', { title: 'Error Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });

    test('handles JSON parse error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json');

      const result = await harness.invoke('save-session-summary', { title: 'Parse Error' });

      expect(result.success).toBe(false);
    });
  });

  describe('get-session-summaries', () => {
    test('returns empty array when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('get-session-summaries');

      expect(result).toEqual({ success: true, summaries: [] });
    });

    test('returns summaries limited by default (10)', async () => {
      const summaries = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        title: `Session ${i}`,
      }));
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(summaries));

      const result = await harness.invoke('get-session-summaries');

      expect(result.success).toBe(true);
      expect(result.summaries.length).toBe(10);
      expect(result.total).toBe(20);
    });

    test('returns summaries with custom limit', async () => {
      const summaries = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        title: `Session ${i}`,
      }));
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(summaries));

      const result = await harness.invoke('get-session-summaries', 5);

      expect(result.summaries.length).toBe(5);
    });

    test('returns summaries in reverse order (newest first)', async () => {
      const summaries = [
        { id: 'session-1', title: 'Old' },
        { id: 'session-2', title: 'Middle' },
        { id: 'session-3', title: 'New' },
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(summaries));

      const result = await harness.invoke('get-session-summaries', 3);

      expect(result.summaries[0].title).toBe('New');
      expect(result.summaries[2].title).toBe('Old');
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('get-session-summaries');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read error');
      expect(result.summaries).toEqual([]);
    });
  });

  describe('get-latest-summary', () => {
    test('returns null when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('get-latest-summary');

      expect(result).toEqual({ success: true, summary: null });
    });

    test('returns null when summaries array is empty', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('get-latest-summary');

      expect(result).toEqual({ success: true, summary: null });
    });

    test('returns last summary in array', async () => {
      const summaries = [
        { id: 'session-1', title: 'First' },
        { id: 'session-2', title: 'Second' },
        { id: 'session-3', title: 'Latest' },
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(summaries));

      const result = await harness.invoke('get-latest-summary');

      expect(result.success).toBe(true);
      expect(result.summary.title).toBe('Latest');
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const result = await harness.invoke('get-latest-summary');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read failed');
      expect(result.summary).toBeNull();
    });
  });

  describe('clear-session-summaries', () => {
    test('deletes file when it exists', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('clear-session-summaries');

      expect(result).toEqual({ success: true });
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('succeeds when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('clear-session-summaries');

      expect(result).toEqual({ success: true });
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {
        throw new Error('Delete failed');
      });

      const result = await harness.invoke('clear-session-summaries');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });
  });
});
