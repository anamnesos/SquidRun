/**
 * API Docs IPC Handler Tests
 * Target: Full coverage of api-docs-handlers.js
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

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerApiDocsHandlers } = require('../modules/ipc/api-docs-handlers');

describe('API Docs Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';

    // Default: no existing docs file
    fs.existsSync.mockReturnValue(false);

    registerApiDocsHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerApiDocsHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerApiDocsHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('generate-api-docs', () => {
    test('generates documentation', async () => {
      const result = await harness.invoke('generate-api-docs');

      expect(result.success).toBe(true);
      expect(result.handlerCount).toBeGreaterThan(0);
      expect(result.categoryCount).toBeGreaterThan(0);
      expect(result.path).toContain('api-docs.md');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('generates markdown content', async () => {
      await harness.invoke('generate-api-docs');

      const writeCall = fs.writeFileSync.mock.calls[0];
      const content = writeCall[1];

      expect(content).toContain('# Hivemind IPC API Documentation');
      expect(content).toContain('## Table of Contents');
      expect(content).toContain('## PTY/Terminal');
    });

    test('handles write error gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = await harness.invoke('generate-api-docs');

      // Still returns success structure
      expect(result.handlerCount).toBeGreaterThan(0);
    });
  });

  describe('get-api-docs', () => {
    test('returns existing docs', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('# API Docs\nContent here');

      const result = await harness.invoke('get-api-docs');

      expect(result.success).toBe(true);
      expect(result.content).toContain('# API Docs');
      expect(result.path).toContain('api-docs.md');
    });

    test('generates docs if not exists', async () => {
      fs.existsSync.mockImplementation(path => {
        // First call: file doesn't exist
        // After generation: file exists
        return fs.writeFileSync.mock.calls.length > 0;
      });
      fs.readFileSync.mockReturnValue('# Generated docs');

      const result = await harness.invoke('get-api-docs');

      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('get-api-docs');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read error');
    });
  });

  describe('get-handler-doc', () => {
    test('returns handler documentation', async () => {
      const result = await harness.invoke('get-handler-doc', 'pty-create');

      expect(result.success).toBe(true);
      expect(result.handler).toBe('pty-create');
      expect(result.category).toBe('PTY/Terminal');
      expect(result.description).toBeDefined();
      expect(result.params).toBeDefined();
      expect(result.returns).toBeDefined();
    });

    test('returns error for unknown handler', async () => {
      const result = await harness.invoke('get-handler-doc', 'unknown-handler');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Handler not found');
    });

    test('documents various handlers', async () => {
      const handlers = ['broadcast-message', 'get-settings', 'save-template', 'run-tests'];

      for (const handler of handlers) {
        const result = await harness.invoke('get-handler-doc', handler);
        expect(result.success).toBe(true);
        expect(result.description).toBeDefined();
      }
    });
  });

  describe('list-api-handlers', () => {
    test('returns all handlers', async () => {
      const result = await harness.invoke('list-api-handlers');

      expect(result.success).toBe(true);
      expect(result.handlers.length).toBeGreaterThan(0);
      expect(result.total).toBe(result.handlers.length);
    });

    test('handlers have required fields', async () => {
      const result = await harness.invoke('list-api-handlers');

      for (const handler of result.handlers.slice(0, 5)) {
        expect(handler.name).toBeDefined();
        expect(handler.category).toBeDefined();
        expect(handler.description).toBeDefined();
      }
    });
  });

  describe('search-api-docs', () => {
    test('searches by handler name', async () => {
      const result = await harness.invoke('search-api-docs', 'pty');

      expect(result.success).toBe(true);
      expect(result.query).toBe('pty');
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.count).toBe(result.matches.length);
    });

    test('searches by description', async () => {
      const result = await harness.invoke('search-api-docs', 'terminal');

      expect(result.success).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    test('searches by category', async () => {
      const result = await harness.invoke('search-api-docs', 'Settings');

      expect(result.success).toBe(true);
      expect(result.matches.some(m => m.category === 'Settings')).toBe(true);
    });

    test('returns empty for no matches', async () => {
      const result = await harness.invoke('search-api-docs', 'zzzznonexistent');

      expect(result.success).toBe(true);
      expect(result.matches).toEqual([]);
      expect(result.count).toBe(0);
    });

    test('case insensitive search', async () => {
      const result = await harness.invoke('search-api-docs', 'PTY');
      const result2 = await harness.invoke('search-api-docs', 'pty');

      expect(result.count).toBe(result2.count);
    });

    test('returns handler details in matches', async () => {
      const result = await harness.invoke('search-api-docs', 'create');

      for (const match of result.matches.slice(0, 3)) {
        expect(match.handler).toBeDefined();
        expect(match.category).toBeDefined();
        expect(match.description).toBeDefined();
      }
    });
  });
});
