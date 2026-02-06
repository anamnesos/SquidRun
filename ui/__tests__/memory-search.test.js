/**
 * Memory Search Tests
 * Target: Full coverage of modules/memory/memory-search.js
 */

// Mock memory-store before requiring module
const mockMemoryStore = {
  PANE_ROLES: {
    '1': 'architect',
    '2': 'infra',
    '4': 'backend',
    '5': 'analyst',
  },
  listTranscriptDates: jest.fn(() => []),
  readTranscript: jest.fn(() => []),
  loadContext: jest.fn(() => null),
  loadSharedMemory: jest.fn(() => ({ learnings: [], decisions: [] })),
  loadKeywordIndex: jest.fn(() => ({ keywords: {} })),
  indexKeywords: jest.fn(),
  getDateString: jest.fn(() => '2026-01-30'),
};

jest.mock('../modules/memory/memory-store', () => mockMemoryStore);

const memorySearch = require('../modules/memory/memory-search');

describe('Memory Search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMemoryStore.listTranscriptDates.mockReturnValue([]);
    mockMemoryStore.readTranscript.mockReturnValue([]);
    mockMemoryStore.loadContext.mockReturnValue(null);
    mockMemoryStore.loadSharedMemory.mockReturnValue({ learnings: [], decisions: [] });
    mockMemoryStore.loadKeywordIndex.mockReturnValue({ keywords: {} });
  });

  describe('extractKeywords', () => {
    test('extracts words from text', () => {
      const keywords = memorySearch.extractKeywords('hello world testing');

      expect(keywords).toContain('hello');
      expect(keywords).toContain('world');
      expect(keywords).toContain('testing');
    });

    test('filters out stop words', () => {
      const keywords = memorySearch.extractKeywords('the quick brown fox and the lazy dog');

      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('and');
      expect(keywords).toContain('quick');
      expect(keywords).toContain('brown');
    });

    test('filters out short words', () => {
      const keywords = memorySearch.extractKeywords('a b c hello world');

      expect(keywords).not.toContain('a');
      expect(keywords).not.toContain('b');
      expect(keywords).toContain('hello');
    });

    test('normalizes to lowercase', () => {
      const keywords = memorySearch.extractKeywords('Hello WORLD Testing');

      expect(keywords).toContain('hello');
      expect(keywords).toContain('world');
    });

    test('sorts by frequency', () => {
      const keywords = memorySearch.extractKeywords('test test test hello hello world');

      expect(keywords[0]).toBe('test');
      expect(keywords[1]).toBe('hello');
    });

    test('handles empty input', () => {
      expect(memorySearch.extractKeywords('')).toEqual([]);
      expect(memorySearch.extractKeywords(null)).toEqual([]);
      expect(memorySearch.extractKeywords(undefined)).toEqual([]);
    });

    test('handles non-string input', () => {
      expect(memorySearch.extractKeywords(123)).toEqual([]);
      expect(memorySearch.extractKeywords({})).toEqual([]);
    });
  });

  describe('extractEntryKeywords', () => {
    test('extracts keywords from content', () => {
      const entry = { content: 'implementing feature' };

      const keywords = memorySearch.extractEntryKeywords(entry);

      expect(keywords).toContain('implementing');
      expect(keywords).toContain('feature');
    });

    test('includes tool name from metadata', () => {
      const entry = {
        content: 'using tool',
        metadata: { toolName: 'Bash' }
      };

      const keywords = memorySearch.extractEntryKeywords(entry);

      expect(keywords).toContain('bash');
    });

    test('includes rationale from metadata', () => {
      const entry = {
        content: 'decision',
        metadata: { rationale: 'performance improvement' }
      };

      const keywords = memorySearch.extractEntryKeywords(entry);

      expect(keywords).toContain('performance');
      expect(keywords).toContain('improvement');
    });

    test('deduplicates keywords', () => {
      const entry = { content: 'test test test' };

      const keywords = memorySearch.extractEntryKeywords(entry);

      expect(keywords.filter(k => k === 'test').length).toBe(1);
    });
  });

  describe('searchRoleTranscripts', () => {
    test('returns empty when no transcripts', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue([]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test');

      expect(results).toEqual([]);
    });

    test('finds matching entries', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test message', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'output', content: 'no match', timestamp: '2026-01-30T10:01:00Z' },
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test');

      expect(results.length).toBe(1);
      expect(results[0].data.content).toBe('test message');
      expect(results[0].type).toBe('transcript');
    });

    test('scores exact phrase match higher', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'api handler implementation', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'output', content: 'api handler', timestamp: '2026-01-30T10:01:00Z' },
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'api handler');

      expect(results.length).toBe(2);
      // Exact phrase gets higher score
      expect(results[0].data.content).toBe('api handler');
    });

    test('filters by type', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test input', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'output', content: 'test output', timestamp: '2026-01-30T10:01:00Z' },
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test', {
        types: ['input']
      });

      expect(results.length).toBe(1);
      expect(results[0].data.type).toBe('input');
    });

    test('searches specific date', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30', '2026-01-29']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test', {
        date: '2026-01-30'
      });

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith('architect', expect.objectContaining({
        date: '2026-01-30'
      }));
    });

    test('respects limit option', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      const entries = Array(100).fill(null).map((_, i) => ({
        type: 'input',
        content: `test message ${i}`,
        timestamp: '2026-01-30T10:00:00Z'
      }));
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const results = memorySearch.searchRoleTranscripts('architect', 'test', { limit: 10 });

      expect(results.length).toBe(10);
    });

    test('case insensitive by default', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'TEST MESSAGE', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test');

      expect(results.length).toBe(1);
    });

    test('supports case sensitive search', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'Test message', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'test', {
        caseSensitive: true
      });

      expect(results.length).toBe(0);
    });

    test('gives bonus for error type on error query', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'error', content: 'error occurred', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'input', content: 'error message', timestamp: '2026-01-30T10:01:00Z' },
      ]);

      const results = memorySearch.searchRoleTranscripts('architect', 'error');

      // Error type should rank higher
      expect(results[0].type).toBe('transcript');
      expect(results[0].data.type).toBe('error');
    });
  });

  describe('searchAllTranscripts', () => {
    test('searches all roles', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      memorySearch.searchAllTranscripts('test');

      // Should be called for each role
      expect(mockMemoryStore.listTranscriptDates).toHaveBeenCalled();
    });

    test('filters by specified roles', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      memorySearch.searchAllTranscripts('test', { roles: ['architect', 'reviewer'] });

      // Only architect and reviewer should be searched
      expect(mockMemoryStore.listTranscriptDates).toHaveBeenCalledTimes(2);
    });

    test('combines and sorts results', () => {
      let callCount = 0;
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockImplementation(() => {
        callCount++;
        return [{
          type: 'input',
          content: callCount === 1 ? 'test exact match' : 'test',
          timestamp: '2026-01-30T10:00:00Z'
        }];
      });

      const results = memorySearch.searchAllTranscripts('test exact');

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('searchContext', () => {
    test('returns empty when no context', () => {
      mockMemoryStore.loadContext.mockReturnValue(null);

      const results = memorySearch.searchContext('architect', 'test');

      expect(results).toEqual([]);
    });

    test('searches learnings', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [
          { topic: 'api testing', content: 'always test endpoints' },
          { topic: 'unrelated', content: 'no match here' }
        ]
      });

      const results = memorySearch.searchContext('architect', 'testing');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('learning');
    });

    test('searches decisions', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        recentDecisions: [
          { action: 'use typescript', rationale: 'type safety' }
        ]
      });

      const results = memorySearch.searchContext('architect', 'typescript');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('decision');
    });

    test('searches tasks', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        recentTasks: [
          { task: 'implement feature', description: 'add new functionality' }
        ]
      });

      const results = memorySearch.searchContext('architect', 'feature');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('task');
    });

    test('searches file expertise', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        fileExpertise: {
          'src/main.js': { reads: 5, writes: 2 },
          'README.md': { reads: 1 }
        }
      });

      const results = memorySearch.searchContext('architect', 'main.js');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('file');
    });

    test('filters by sections', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [{ topic: 'test', content: 'learning' }],
        recentDecisions: [{ action: 'test', rationale: 'decision' }]
      });

      const results = memorySearch.searchContext('architect', 'test', {
        sections: ['learnings']
      });

      expect(results.every(r => r.type === 'learning')).toBe(true);
    });
  });

  describe('searchSharedMemory', () => {
    test('returns empty when no shared memory', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({ learnings: [], decisions: [] });

      const results = memorySearch.searchSharedMemory('test');

      expect(results).toEqual([]);
    });

    test('searches shared learnings', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [
          { topic: 'api testing', content: 'shared knowledge', source: 'reviewer' }
        ],
        decisions: []
      });

      const results = memorySearch.searchSharedMemory('testing');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('shared_learning');
    });

    test('searches shared decisions', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [],
        decisions: [
          { action: 'use mongodb', rationale: 'scalability', agent: 'architect' }
        ]
      });

      const results = memorySearch.searchSharedMemory('mongodb');

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('shared_decision');
    });

    test('filters by types', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [{ topic: 'test', content: 'learning' }],
        decisions: [{ action: 'test', rationale: 'decision' }]
      });

      const results = memorySearch.searchSharedMemory('test', {
        types: ['learnings']
      });

      expect(results.every(r => r.type === 'shared_learning')).toBe(true);
    });
  });

  describe('searchAll', () => {
    test('returns categorized results', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue([]);
      mockMemoryStore.loadContext.mockReturnValue(null);
      mockMemoryStore.loadSharedMemory.mockReturnValue({ learnings: [], decisions: [] });

      const results = memorySearch.searchAll('test');

      expect(results.query).toBe('test');
      expect(results.timestamp).toBeDefined();
      expect(results.totals).toBeDefined();
      expect(results.results.transcripts).toBeDefined();
      expect(results.results.context).toBeDefined();
      expect(results.results.shared).toBeDefined();
    });

    test('counts totals correctly', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test', timestamp: '2026-01-30T10:00:00Z' }
      ]);
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [{ topic: 'test', content: 'learning' }]
      });
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [{ topic: 'test', content: 'shared' }],
        decisions: []
      });

      const results = memorySearch.searchAll('test');

      expect(results.totals.total).toBeGreaterThan(0);
    });
  });

  describe('findByFile', () => {
    test('finds entries mentioning file path', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'editing src/main.js', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'output', content: 'no file mentioned', timestamp: '2026-01-30T10:01:00Z' }
      ]);

      const results = memorySearch.findByFile('src/main.js', { roles: ['architect'] });

      expect(results.length).toBe(1);
      expect(results[0].data.content).toContain('src/main.js');
    });

    test('finds entries mentioning just filename', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'working on main.js', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.findByFile('src/main.js', { roles: ['architect'] });

      expect(results.length).toBe(1);
    });

    test('checks metadata for file references', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        {
          type: 'tool_use',
          content: 'reading file',
          metadata: { file: 'src/main.js' },
          timestamp: '2026-01-30T10:00:00Z'
        }
      ]);

      const results = memorySearch.findByFile('src/main.js', { roles: ['architect'] });

      expect(results.length).toBe(1);
    });
  });

  describe('findByType', () => {
    test('finds entries of specific type', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'error', content: 'failed', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'input', content: 'message', timestamp: '2026-01-30T10:01:00Z' }
      ]);

      const results = memorySearch.findByType('error', { roles: ['architect'] });

      expect(results.length).toBe(1);
      expect(results[0].data.type).toBe('error');
    });

    test('sorts by timestamp descending', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'error', content: 'older', timestamp: '2026-01-30T09:00:00Z' },
        { type: 'error', content: 'newer', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.findByType('error', { roles: ['architect'] });

      expect(results[0].data.content).toBe('newer');
    });
  });

  describe('findRecentErrors', () => {
    test('finds errors from last 24 hours by default', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'error', content: 'recent error', timestamp: new Date().toISOString() }
      ]);

      const results = memorySearch.findRecentErrors();

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ since: expect.any(String) })
      );
    });

    test('respects custom since option', () => {
      const customSince = '2026-01-29T00:00:00Z';
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockReturnValue([]);

      memorySearch.findRecentErrors({ since: customSince });

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ since: customSince })
      );
    });
  });

  describe('analyzeToolUsage', () => {
    test('returns usage stats for all tools', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockImplementation((role) => {
        if (role === 'architect') {
          return [
            { type: 'tool_use', metadata: { toolName: 'Bash' }, timestamp: '2026-01-30T10:00:00Z' },
            { type: 'tool_use', metadata: { toolName: 'Bash' }, timestamp: '2026-01-30T10:01:00Z' },
            { type: 'tool_use', metadata: { toolName: 'Read' }, timestamp: '2026-01-30T10:02:00Z' }
          ];
        }
        return [];
      });

      const results = memorySearch.analyzeToolUsage();

      expect(results.tools.Bash).toBeDefined();
      expect(results.tools.Bash.count).toBe(2);
      expect(results.tools.Read).toBeDefined();
      expect(results.tools.Read.count).toBe(1);
    });

    test('filters by tool name', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockImplementation((role) => {
        if (role === 'architect') {
          return [
            { type: 'tool_use', metadata: { toolName: 'Bash' }, timestamp: '2026-01-30T10:00:00Z' },
            { type: 'tool_use', metadata: { toolName: 'Read' }, timestamp: '2026-01-30T10:01:00Z' }
          ];
        }
        return [];
      });

      const results = memorySearch.analyzeToolUsage('bash');

      expect(results.query).toBe('bash');
      expect(results.tools.Bash).toBeDefined();
      expect(results.tools.Read).toBeUndefined();
    });

    test('tracks first and last usage', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockImplementation((role) => {
        if (role === 'architect') {
          return [
            { type: 'tool_use', metadata: { toolName: 'Bash' }, timestamp: '2026-01-30T09:00:00Z' },
            { type: 'tool_use', metadata: { toolName: 'Bash' }, timestamp: '2026-01-30T11:00:00Z' }
          ];
        }
        return [];
      });

      const results = memorySearch.analyzeToolUsage('bash');

      expect(results.tools.Bash.firstUsed).toBe('2026-01-30T09:00:00Z');
      expect(results.tools.Bash.lastUsed).toBe('2026-01-30T11:00:00Z');
    });

    test('tracks agents using tools', () => {
      mockMemoryStore.listTranscriptDates.mockReturnValue(['2026-01-30']);
      mockMemoryStore.readTranscript.mockImplementation((role) => {
        if (role === 'architect') {
          return [{
            type: 'tool_use',
            metadata: { toolName: 'Bash' },
            timestamp: '2026-01-30T10:00:00Z'
          }];
        }
        return [];
      });

      const results = memorySearch.analyzeToolUsage('bash');

      expect(results.tools.Bash.agents).toContain('architect');
    });
  });

  describe('indexTranscript', () => {
    test('indexes keywords from transcript entries', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { content: 'implementing api handler', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      memorySearch.indexTranscript('architect', '2026-01-30');

      expect(mockMemoryStore.indexKeywords).toHaveBeenCalled();
    });

    test('skips entries with no keywords', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { content: 'a b c', timestamp: '2026-01-30T10:00:00Z' } // All filtered out
      ]);

      memorySearch.indexTranscript('architect', '2026-01-30');

      expect(mockMemoryStore.indexKeywords).not.toHaveBeenCalled();
    });
  });

  describe('searchByKeyword', () => {
    test('searches using keyword index', () => {
      mockMemoryStore.loadKeywordIndex.mockReturnValue({
        keywords: {
          api: [{ role: 'architect', date: '2026-01-30', entryIndex: 0 }]
        }
      });
      mockMemoryStore.readTranscript.mockReturnValue([
        { content: 'api implementation', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.searchByKeyword('api');

      expect(results.length).toBe(1);
      expect(results[0].data.content).toBe('api implementation');
    });

    test('handles missing entries gracefully', () => {
      mockMemoryStore.loadKeywordIndex.mockReturnValue({
        keywords: {
          api: [{ role: 'architect', date: '2026-01-30', entryIndex: 5 }]
        }
      });
      mockMemoryStore.readTranscript.mockReturnValue([]); // Entry doesn't exist

      const results = memorySearch.searchByKeyword('api');

      expect(results).toEqual([]);
    });

    test('normalizes keyword to lowercase', () => {
      mockMemoryStore.loadKeywordIndex.mockReturnValue({
        keywords: {
          api: [{ role: 'architect', date: '2026-01-30', entryIndex: 0 }]
        }
      });
      mockMemoryStore.readTranscript.mockReturnValue([
        { content: 'api', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const results = memorySearch.searchByKeyword('API');

      expect(results.length).toBe(1);
    });
  });
});
