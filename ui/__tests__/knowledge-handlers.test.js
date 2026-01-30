/**
 * Knowledge IPC Handler Tests
 * Target: Full coverage of knowledge-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock KnowledgeBase
const mockKb = {
  ingestPaths: jest.fn(),
  search: jest.fn(),
  getStats: jest.fn(),
};

jest.mock('../modules/knowledge-base', () => {
  return jest.fn().mockImplementation(() => mockKb);
});

// Mock local-embedder
jest.mock('../modules/local-embedder', () => ({
  createLocalEmbedder: jest.fn(() => ({ embed: jest.fn() })),
}));

const { registerKnowledgeHandlers } = require('../modules/ipc/knowledge-handlers');

describe('Knowledge Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';

    // Reset mock behaviors
    mockKb.ingestPaths.mockResolvedValue({ filesProcessed: 5, chunks: 20 });
    mockKb.search.mockResolvedValue([
      { content: 'Result 1', score: 0.95 },
      { content: 'Result 2', score: 0.85 },
    ]);
    mockKb.getStats.mockReturnValue({ totalChunks: 100, totalFiles: 10 });

    registerKnowledgeHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('does nothing without ipcMain', () => {
      const ctx2 = { WORKSPACE_PATH: '/test' };
      // Should not throw
      expect(() => registerKnowledgeHandlers(ctx2)).not.toThrow();
    });

    test('does nothing without WORKSPACE_PATH', () => {
      const harness2 = createIpcHarness();
      const ctx2 = { ipcMain: harness2.ipcMain };
      // Should not throw
      expect(() => registerKnowledgeHandlers(ctx2)).not.toThrow();
    });

    test('creates embedder and knowledge base on ctx', () => {
      expect(ctx.knowledgeEmbedder).toBeDefined();
      expect(ctx.knowledgeBase).toBeDefined();
    });

    test('reuses existing embedder', () => {
      const existingEmbedder = { embed: jest.fn() };
      const harness2 = createIpcHarness();
      const ctx2 = createDefaultContext({ ipcMain: harness2.ipcMain });
      ctx2.WORKSPACE_PATH = '/test';
      ctx2.knowledgeEmbedder = existingEmbedder;

      registerKnowledgeHandlers(ctx2);

      expect(ctx2.knowledgeEmbedder).toBe(existingEmbedder);
    });
  });

  describe('knowledge-ingest', () => {
    test('ingests paths successfully', async () => {
      const result = await harness.invoke('knowledge-ingest', {
        paths: ['/path/to/file1.js', '/path/to/file2.js'],
      });

      expect(result.success).toBe(true);
      expect(result.summary.filesProcessed).toBe(5);
      expect(mockKb.ingestPaths).toHaveBeenCalledWith(['/path/to/file1.js', '/path/to/file2.js']);
    });

    test('handles empty paths', async () => {
      const result = await harness.invoke('knowledge-ingest', {});

      expect(result.success).toBe(true);
      expect(mockKb.ingestPaths).toHaveBeenCalledWith([]);
    });

    test('handles ingest error', async () => {
      mockKb.ingestPaths.mockRejectedValue(new Error('Ingest failed'));

      const result = await harness.invoke('knowledge-ingest', { paths: ['/bad'] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Ingest failed');
    });
  });

  describe('knowledge-search', () => {
    test('searches successfully', async () => {
      const result = await harness.invoke('knowledge-search', {
        query: 'How does auth work?',
        topK: 3,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(2);
      expect(mockKb.search).toHaveBeenCalledWith('How does auth work?', 3);
    });

    test('uses default topK', async () => {
      await harness.invoke('knowledge-search', { query: 'Test' });

      expect(mockKb.search).toHaveBeenCalledWith('Test', 5);
    });

    test('uses empty query default', async () => {
      await harness.invoke('knowledge-search', {});

      expect(mockKb.search).toHaveBeenCalledWith('', 5);
    });

    test('handles search error', async () => {
      mockKb.search.mockRejectedValue(new Error('Search failed'));

      const result = await harness.invoke('knowledge-search', { query: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Search failed');
    });
  });

  describe('knowledge-stats', () => {
    test('returns stats', async () => {
      const result = await harness.invoke('knowledge-stats');

      expect(result.success).toBe(true);
      expect(result.stats.totalChunks).toBe(100);
      expect(result.stats.totalFiles).toBe(10);
    });

    test('handles stats error', async () => {
      mockKb.getStats.mockImplementation(() => {
        throw new Error('Stats error');
      });

      const result = await harness.invoke('knowledge-stats');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Stats error');
    });
  });
});
