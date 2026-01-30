/**
 * Knowledge Base Tests
 * Target: Full coverage of modules/knowledge-base.js
 */

const path = require('path');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
}));

// Mock crypto
jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mocked-hash'),
  })),
}));

const fs = require('fs');
const crypto = require('crypto');
const KnowledgeBase = require('../modules/knowledge-base');

describe('KnowledgeBase', () => {
  let kb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default fs mock behaviors
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockImplementation(() => {});
    fs.readFileSync.mockReturnValue('');
    fs.writeFileSync.mockImplementation(() => {});
    fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
    fs.readdirSync.mockReturnValue([]);
  });

  describe('constructor', () => {
    test('creates instance with default options', () => {
      kb = new KnowledgeBase('/test/base');

      expect(kb.baseDir).toBe('/test/base');
      expect(kb.dim).toBe(128);
      expect(kb.maxChunkChars).toBe(1200);
      expect(kb.maxChunkLines).toBe(120);
    });

    test('creates instance with custom options', () => {
      kb = new KnowledgeBase('/test/base', {
        dim: 256,
        maxChunkChars: 2000,
        maxChunkLines: 200,
      });

      expect(kb.dim).toBe(256);
      expect(kb.maxChunkChars).toBe(2000);
      expect(kb.maxChunkLines).toBe(200);
    });

    test('uses embedder dimension if provided', () => {
      const mockEmbedder = { dim: 384, embed: jest.fn() };
      kb = new KnowledgeBase('/test/base', { embedder: mockEmbedder });

      expect(kb.dim).toBe(384);
      expect(kb.embedder).toBe(mockEmbedder);
    });

    test('loads existing index from file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: 1,
        dim: 128,
        documents: { doc1: { path: '/test/doc1.md' } },
        chunks: {},
      }));

      kb = new KnowledgeBase('/test/base');

      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/test/base', 'index.json'),
        'utf-8'
      );
      expect(kb.index.documents).toHaveProperty('doc1');
    });

    test('creates empty index if existing has different dim', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: 1,
        dim: 256,
        documents: { doc1: { path: '/test/doc1.md' } },
        chunks: {},
      }));

      kb = new KnowledgeBase('/test/base', { dim: 128 });

      // Should have reset the index
      expect(kb.index.documents).toEqual({});
      expect(kb.index.dim).toBe(128);
    });

    test('handles malformed index file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not json');

      kb = new KnowledgeBase('/test/base');

      expect(kb.index.documents).toEqual({});
      expect(kb.index.chunks).toEqual({});
    });

    test('handles null index content', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('null');

      kb = new KnowledgeBase('/test/base');

      expect(kb.index.documents).toEqual({});
    });
  });

  describe('_ensureDir', () => {
    test('creates directory if not exists', () => {
      fs.existsSync.mockReturnValue(false);

      kb = new KnowledgeBase('/test/base');
      // Constructor calls _loadIndex which calls _ensureDir

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/base', { recursive: true });
    });

    test('does not create if exists', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{}');

      kb = new KnowledgeBase('/test/base');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('_hashContent', () => {
    test('hashes text content', () => {
      kb = new KnowledgeBase('/test/base');

      const result = kb._hashContent('test content');

      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(result).toBe('mocked-hash');
    });
  });

  describe('_isBinary', () => {
    test('returns true for buffer with null bytes', () => {
      kb = new KnowledgeBase('/test/base');

      const buffer = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]);
      expect(kb._isBinary(buffer)).toBe(true);
    });

    test('returns false for text buffer', () => {
      kb = new KnowledgeBase('/test/base');

      const buffer = Buffer.from('Hello World');
      expect(kb._isBinary(buffer)).toBe(false);
    });

    test('handles large buffer by sampling', () => {
      kb = new KnowledgeBase('/test/base');

      // Create buffer larger than 8000 bytes
      const buffer = Buffer.alloc(10000, 'a');
      expect(kb._isBinary(buffer)).toBe(false);
    });
  });

  describe('_isSupported', () => {
    test('returns true for supported extensions', () => {
      kb = new KnowledgeBase('/test/base');

      expect(kb._isSupported('/test/file.md')).toBe(true);
      expect(kb._isSupported('/test/file.js')).toBe(true);
      expect(kb._isSupported('/test/file.ts')).toBe(true);
      expect(kb._isSupported('/test/file.py')).toBe(true);
      expect(kb._isSupported('/test/file.json')).toBe(true);
      expect(kb._isSupported('/test/file.txt')).toBe(true);
    });

    test('returns false for unsupported extensions', () => {
      kb = new KnowledgeBase('/test/base');

      expect(kb._isSupported('/test/file.exe')).toBe(false);
      expect(kb._isSupported('/test/file.png')).toBe(false);
      expect(kb._isSupported('/test/file.pdf')).toBe(false);
    });

    test('handles case insensitivity', () => {
      kb = new KnowledgeBase('/test/base');

      expect(kb._isSupported('/test/file.MD')).toBe(true);
      expect(kb._isSupported('/test/file.JS')).toBe(true);
    });
  });

  describe('_docIdForPath', () => {
    test('generates consistent id for path', () => {
      kb = new KnowledgeBase('/test/base');

      const id1 = kb._docIdForPath('/test/file.md');
      const id2 = kb._docIdForPath('/test/file.md');

      expect(id1).toBe(id2);
      expect(crypto.createHash).toHaveBeenCalledWith('md5');
    });
  });

  describe('_tokenize', () => {
    test('extracts alphanumeric tokens', () => {
      kb = new KnowledgeBase('/test/base');

      const tokens = kb._tokenize('Hello World_123 test');
      expect(tokens).toEqual(['hello', 'world_123', 'test']);
    });

    test('returns empty array for no matches', () => {
      kb = new KnowledgeBase('/test/base');

      const tokens = kb._tokenize('!@#$%^&*()');
      expect(tokens).toEqual([]);
    });
  });

  describe('_hashEmbed', () => {
    test('generates vector of correct dimension', () => {
      kb = new KnowledgeBase('/test/base', { dim: 64 });

      const vec = kb._hashEmbed('test text');
      expect(vec).toHaveLength(64);
    });

    test('generates normalized vector', () => {
      kb = new KnowledgeBase('/test/base');

      const vec = kb._hashEmbed('test text');
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    test('generates consistent vectors for same text', () => {
      kb = new KnowledgeBase('/test/base');

      const vec1 = kb._hashEmbed('test text');
      const vec2 = kb._hashEmbed('test text');
      expect(vec1).toEqual(vec2);
    });

    test('handles empty text', () => {
      kb = new KnowledgeBase('/test/base');

      const vec = kb._hashEmbed('');
      expect(vec).toHaveLength(128);
      // All zeros should still normalize (divides by 1)
      expect(vec.every(v => v === 0)).toBe(true);
    });
  });

  describe('_resetDim', () => {
    test('updates dimension and resets index', () => {
      kb = new KnowledgeBase('/test/base', { dim: 128 });
      kb.index.documents = { doc1: {} };
      kb.index.chunks = { chunk1: {} };

      kb._resetDim(256);

      expect(kb.dim).toBe(256);
      expect(kb.index.documents).toEqual({});
      expect(kb.index.chunks).toEqual({});
    });

    test('does nothing for same dimension', () => {
      kb = new KnowledgeBase('/test/base', { dim: 128 });
      kb.index.documents = { doc1: {} };

      kb._resetDim(128);

      expect(kb.index.documents).toHaveProperty('doc1');
    });

    test('ignores invalid dimension', () => {
      kb = new KnowledgeBase('/test/base', { dim: 128 });

      kb._resetDim(null);
      expect(kb.dim).toBe(128);

      kb._resetDim(NaN);
      expect(kb.dim).toBe(128);

      kb._resetDim(undefined);
      expect(kb.dim).toBe(128);
    });
  });

  describe('_embed', () => {
    test('uses embedder if provided', async () => {
      const mockEmbedder = {
        dim: 384,
        embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      };
      kb = new KnowledgeBase('/test/base', { embedder: mockEmbedder });

      const vec = await kb._embed('test text');

      expect(mockEmbedder.embed).toHaveBeenCalledWith('test text');
      expect(vec).toEqual([0.1, 0.2, 0.3]);
      expect(kb.dim).toBe(3); // Should update dimension
    });

    test('falls back to hash embedding on embedder error', async () => {
      const mockEmbedder = {
        embed: jest.fn().mockRejectedValue(new Error('API error')),
      };
      kb = new KnowledgeBase('/test/base', { embedder: mockEmbedder });

      const vec = await kb._embed('test text');

      expect(vec).toHaveLength(128); // Hash embedding dimension
    });

    test('falls back to hash embedding on empty result', async () => {
      const mockEmbedder = {
        embed: jest.fn().mockResolvedValue([]),
      };
      kb = new KnowledgeBase('/test/base', { embedder: mockEmbedder });

      const vec = await kb._embed('test text');

      expect(vec).toHaveLength(128);
    });

    test('uses hash embedding when no embedder', async () => {
      kb = new KnowledgeBase('/test/base');

      const vec = await kb._embed('test text');

      expect(vec).toHaveLength(128);
    });
  });

  describe('_cosine', () => {
    test('computes cosine similarity', () => {
      kb = new KnowledgeBase('/test/base');

      const a = [1, 0, 0];
      const b = [1, 0, 0];
      expect(kb._cosine(a, b)).toBe(1);

      const c = [1, 0, 0];
      const d = [0, 1, 0];
      expect(kb._cosine(c, d)).toBe(0);

      const e = [1, 0, 0];
      const f = [-1, 0, 0];
      expect(kb._cosine(e, f)).toBe(-1);
    });
  });

  describe('_chunkByLines', () => {
    test('chunks text by lines', () => {
      kb = new KnowledgeBase('/test/base', { maxChunkLines: 2, maxChunkChars: 1000 });

      const chunks = kb._chunkByLines('line1\nline2\nline3\nline4');

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe('line1\nline2');
      expect(chunks[0].lineStart).toBe(1);
      expect(chunks[0].lineEnd).toBe(2);
      expect(chunks[1].text).toBe('line3\nline4');
      expect(chunks[1].lineStart).toBe(3);
      expect(chunks[1].lineEnd).toBe(4);
    });

    test('chunks text by char limit', () => {
      kb = new KnowledgeBase('/test/base', { maxChunkLines: 100, maxChunkChars: 10 });

      const chunks = kb._chunkByLines('12345\n12345\n12345');

      expect(chunks.length).toBeGreaterThan(1);
    });

    test('handles single line', () => {
      kb = new KnowledgeBase('/test/base');

      const chunks = kb._chunkByLines('single line');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('single line');
    });

    test('handles empty text', () => {
      kb = new KnowledgeBase('/test/base');

      const chunks = kb._chunkByLines('');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('');
    });

    test('handles windows line endings', () => {
      kb = new KnowledgeBase('/test/base', { maxChunkLines: 2, maxChunkChars: 1000 });

      const chunks = kb._chunkByLines('line1\r\nline2\r\nline3');

      expect(chunks).toHaveLength(2);
    });
  });

  describe('_removeDoc', () => {
    test('removes document and its chunks', () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.documents = {
        doc1: { path: '/test/doc1.md', chunks: ['doc1:0', 'doc1:1'] },
      };
      kb.index.chunks = {
        'doc1:0': { text: 'chunk 0' },
        'doc1:1': { text: 'chunk 1' },
      };

      kb._removeDoc('doc1');

      expect(kb.index.documents).not.toHaveProperty('doc1');
      expect(kb.index.chunks).not.toHaveProperty('doc1:0');
      expect(kb.index.chunks).not.toHaveProperty('doc1:1');
    });

    test('handles non-existent document', () => {
      kb = new KnowledgeBase('/test/base');

      expect(() => kb._removeDoc('nonexistent')).not.toThrow();
    });

    test('handles document without chunks array', () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.documents = { doc1: { path: '/test/doc1.md' } };

      expect(() => kb._removeDoc('doc1')).not.toThrow();
      expect(kb.index.documents).not.toHaveProperty('doc1');
    });
  });

  describe('_ingestFile', () => {
    test('skips unsupported file types', async () => {
      kb = new KnowledgeBase('/test/base');

      const result = await kb._ingestFile('/test/file.exe');

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('unsupported');
    });

    test('skips binary files', async () => {
      kb = new KnowledgeBase('/test/base');
      fs.readFileSync.mockReturnValue(Buffer.from([0x00, 0x01, 0x02]));

      const result = await kb._ingestFile('/test/file.js');

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('binary');
    });

    test('returns unchanged for same content', async () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.documents = {
        'mocked-hash': { path: '/test/file.js', hash: 'mocked-hash' },
      };
      fs.readFileSync.mockReturnValue(Buffer.from('test content'));

      const result = await kb._ingestFile('/test/file.js');

      expect(result.status).toBe('unchanged');
    });

    test('ingests new file', async () => {
      kb = new KnowledgeBase('/test/base');
      fs.readFileSync.mockReturnValue(Buffer.from('line1\nline2'));

      const result = await kb._ingestFile('/test/file.js');

      expect(result.status).toBe('ingested');
      expect(result.chunks).toBe(1);
    });

    test('removes old chunks when re-ingesting', async () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.documents = {
        'mocked-hash': { path: '/test/file.js', hash: 'old-hash', chunks: ['mocked-hash:0'] },
      };
      kb.index.chunks = {
        'mocked-hash:0': { text: 'old content' },
      };

      // New content with different hash
      crypto.createHash.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('new-hash'),
      });
      fs.readFileSync.mockReturnValue(Buffer.from('new content'));

      const result = await kb._ingestFile('/test/file.js');

      expect(result.status).toBe('ingested');
    });
  });

  describe('ingestDocument', () => {
    test('skips empty inputs', async () => {
      kb = new KnowledgeBase('/test/base');

      expect((await kb.ingestDocument(null, 'text')).status).toBe('skipped');
      expect((await kb.ingestDocument('id', null)).status).toBe('skipped');
      expect((await kb.ingestDocument('', 'text')).status).toBe('skipped');
      expect((await kb.ingestDocument('id', '')).status).toBe('skipped');
    });

    test('returns unchanged for same content', async () => {
      kb = new KnowledgeBase('/test/base');
      // Must match what _hashContent returns for 'text content'
      kb.index.documents = {
        doc1: { hash: 'mocked-hash' },
      };

      // Override _hashContent to return the matching hash
      kb._hashContent = jest.fn().mockReturnValue('mocked-hash');

      const result = await kb.ingestDocument('doc1', 'text content');

      expect(result.status).toBe('unchanged');
    });

    test('ingests new document', async () => {
      kb = new KnowledgeBase('/test/base');

      const result = await kb.ingestDocument('doc1', 'line1\nline2', { name: 'Test Doc' });

      expect(result.status).toBe('ingested');
      expect(result.docId).toBe('doc1');
      expect(result.chunks).toBe(1);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('includes source metadata in chunks', async () => {
      kb = new KnowledgeBase('/test/base');

      await kb.ingestDocument('doc1', 'content', { path: '/custom/path', name: 'Test' });

      const chunk = kb.index.chunks['doc1:0'];
      expect(chunk.source.path).toBe('/custom/path');
      expect(chunk.source.name).toBe('Test');
      expect(chunk.source.docId).toBe('doc1');
    });
  });

  describe('_walkDir', () => {
    test('recursively collects files', () => {
      kb = new KnowledgeBase('/test/base');

      fs.readdirSync.mockImplementation((dirPath) => {
        if (dirPath === '/test/dir') {
          return [
            { name: 'file1.js', isDirectory: () => false, isFile: () => true },
            { name: 'subdir', isDirectory: () => true, isFile: () => false },
          ];
        }
        if (dirPath === path.join('/test/dir', 'subdir')) {
          return [
            { name: 'file2.js', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      });

      const files = kb._walkDir('/test/dir');

      expect(files).toContain(path.join('/test/dir', 'file1.js'));
      expect(files).toContain(path.join('/test/dir', 'subdir', 'file2.js'));
    });
  });

  describe('ingestPaths', () => {
    test('handles directory paths', async () => {
      kb = new KnowledgeBase('/test/base');

      fs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false });
      fs.readdirSync.mockReturnValue([
        { name: 'file.js', isDirectory: () => false, isFile: () => true },
      ]);
      fs.readFileSync.mockReturnValue(Buffer.from('content'));

      const result = await kb.ingestPaths(['/test/dir']);

      expect(result.total).toBe(1);
    });

    test('handles file paths', async () => {
      kb = new KnowledgeBase('/test/base');

      fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      fs.readFileSync.mockReturnValue(Buffer.from('content'));

      const result = await kb.ingestPaths(['/test/file.js']);

      expect(result.total).toBe(1);
    });

    test('handles non-existent paths', async () => {
      kb = new KnowledgeBase('/test/base');

      fs.statSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await kb.ingestPaths(['/nonexistent']);

      expect(result.errors).toBe(1);
      expect(result.results[0].status).toBe('error');
      expect(result.results[0].reason).toBe('not_found');
    });

    test('handles empty/null paths', async () => {
      kb = new KnowledgeBase('/test/base');

      const result = await kb.ingestPaths([null, '', undefined]);

      expect(result.total).toBe(0);
    });

    test('handles file processing errors', async () => {
      kb = new KnowledgeBase('/test/base');

      fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await kb.ingestPaths(['/test/file.js']);

      expect(result.errors).toBe(1);
      expect(result.results[0].status).toBe('error');
    });

    test('returns summary of results', async () => {
      kb = new KnowledgeBase('/test/base');
      let callCount = 0;

      fs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true });
      fs.readFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('content1');
        if (callCount === 2) return Buffer.from('content1'); // Same content for unchanged
        return Buffer.from([0x00]); // Binary
      });

      // First ingest
      await kb.ingestPaths(['/test/file1.js']);

      // Second ingest with same content
      const result = await kb.ingestPaths(['/test/file1.js', '/test/file2.exe']);

      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('ingested');
      expect(result).toHaveProperty('unchanged');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('search', () => {
    test('returns empty for invalid query', async () => {
      kb = new KnowledgeBase('/test/base');

      expect(await kb.search(null)).toEqual([]);
      expect(await kb.search('')).toEqual([]);
      expect(await kb.search(123)).toEqual([]);
    });

    test('returns top results by similarity', async () => {
      kb = new KnowledgeBase('/test/base');
      // Create some chunks with vectors
      kb.index.chunks = {
        'chunk1': { text: 'hello', vector: [1, 0], source: { path: '/a.js' } },
        'chunk2': { text: 'world', vector: [0.9, 0.1], source: { path: '/b.js' } },
        'chunk3': { text: 'test', vector: [0, 1], source: { path: '/c.js' } },
      };

      // Mock _embed to return a known vector
      kb._embed = jest.fn().mockResolvedValue([1, 0]);

      const results = await kb.search('query', 2);

      expect(results).toHaveLength(2);
      expect(results[0].chunkId).toBe('chunk1');
      expect(results[0].score).toBe(1);
    });

    test('handles NaN scores', async () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.chunks = {
        'chunk1': { text: 'test', vector: [NaN], source: {} },
      };
      kb._embed = jest.fn().mockResolvedValue([1]);

      const results = await kb.search('query');

      // NaN scores should be filtered out
      expect(results).toHaveLength(0);
    });

    test('respects topK parameter', async () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.chunks = {
        'chunk1': { text: 'a', vector: [1], source: {} },
        'chunk2': { text: 'b', vector: [0.9], source: {} },
        'chunk3': { text: 'c', vector: [0.8], source: {} },
      };
      kb._embed = jest.fn().mockResolvedValue([1]);

      const results = await kb.search('query', 2);

      expect(results).toHaveLength(2);
    });

    test('returns at least 1 result when topK is 0 or negative', async () => {
      kb = new KnowledgeBase('/test/base');
      kb.index.chunks = {
        'chunk1': { text: 'test', vector: [1], source: {} },
      };
      kb._embed = jest.fn().mockResolvedValue([1]);

      const results = await kb.search('query', 0);

      expect(results).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    test('returns statistics', () => {
      kb = new KnowledgeBase('/test/base', { dim: 256 });
      kb.index.documents = { doc1: {}, doc2: {} };
      kb.index.chunks = { chunk1: {}, chunk2: {}, chunk3: {} };
      kb.index.updatedAt = '2024-01-01T00:00:00.000Z';

      const stats = kb.getStats();

      expect(stats.documents).toBe(2);
      expect(stats.chunks).toBe(3);
      expect(stats.dim).toBe(256);
      expect(stats.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('_saveIndex', () => {
    test('saves index to file', () => {
      kb = new KnowledgeBase('/test/base');

      kb._saveIndex();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        kb.indexPath,
        expect.any(String),
        'utf-8'
      );
    });

    test('updates timestamp on save', () => {
      kb = new KnowledgeBase('/test/base');

      // Just verify the updatedAt gets set to current time
      kb._saveIndex();

      const timestamp = new Date(kb.index.updatedAt);
      expect(timestamp.getTime()).toBeGreaterThan(0);
      expect(typeof kb.index.updatedAt).toBe('string');
    });
  });
});
