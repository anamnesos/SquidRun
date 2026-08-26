/**
 * Shared Context IPC Handler Tests
 * Target: Full coverage of shared-context-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const fs = require('fs');
const { registerSharedContextHandlers } = require('../modules/ipc/shared-context-handlers');

describe('Shared Context Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.SHARED_CONTEXT_PATH = '/test/workspace/shared_context.md';
    registerSharedContextHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('read-shared-context', () => {
    test('returns content when file exists', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('# Shared Context\nTest content');

      const result = await harness.invoke('read-shared-context');

      expect(fs.existsSync).toHaveBeenCalledWith('/test/workspace/shared_context.md');
      expect(fs.readFileSync).toHaveBeenCalledWith('/test/workspace/shared_context.md', 'utf-8');
      expect(result).toEqual({
        success: true,
        content: '# Shared Context\nTest content',
      });
    });

    test('returns error when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('read-shared-context');

      expect(result).toEqual({
        success: false,
        error: 'File not found',
      });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('returns error on read exception', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read permission denied');
      });

      const result = await harness.invoke('read-shared-context');

      expect(result).toEqual({
        success: false,
        error: 'Read permission denied',
      });
    });
  });

  describe('write-shared-context', () => {
    test('writes content to file', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('write-shared-context', 'New content');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/test/workspace/shared_context.md',
        'New content',
        'utf-8'
      );
      expect(result).toEqual({ success: true });
    });

    test('creates directory if not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      await harness.invoke('write-shared-context', 'Content');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/workspace', { recursive: true });
    });

    test('does not create directory if exists', async () => {
      fs.existsSync.mockReturnValue(true);

      await harness.invoke('write-shared-context', 'Content');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('returns error on write exception', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write permission denied');
      });

      const result = await harness.invoke('write-shared-context', 'Content');

      expect(result).toEqual({
        success: false,
        error: 'Write permission denied',
      });
    });

    test('returns error on mkdir exception', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create directory');
      });

      const result = await harness.invoke('write-shared-context', 'Content');

      expect(result).toEqual({
        success: false,
        error: 'Cannot create directory',
      });
    });
  });

  describe('get-shared-context-path', () => {
    test('returns the shared context path', async () => {
      const result = await harness.invoke('get-shared-context-path');

      expect(result).toBe('/test/workspace/shared_context.md');
    });

    test('returns different path when configured differently', async () => {
      ctx.SHARED_CONTEXT_PATH = '/custom/path/context.md';

      // Re-register with new path
      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      newCtx.SHARED_CONTEXT_PATH = '/custom/path/context.md';
      registerSharedContextHandlers(newCtx);

      const result = await newHarness.invoke('get-shared-context-path');

      expect(result).toBe('/custom/path/context.md');
    });
  });
});
