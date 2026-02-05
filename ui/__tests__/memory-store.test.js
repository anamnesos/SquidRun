/**
 * Memory Store Tests
 * Target: Full coverage of modules/memory/memory-store.js
 */

// Mock fs before requiring module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(),
}));

const fs = require('fs');
const memoryStore = require('../modules/memory/memory-store');

describe('Memory Store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: directories exist
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
  });

  describe('Constants', () => {
    test('exports MEMORY_ROOT path', () => {
      expect(memoryStore.MEMORY_ROOT).toBeDefined();
      expect(memoryStore.MEMORY_ROOT).toContain('memory');
    });

    test('exports directory paths', () => {
      expect(memoryStore.TRANSCRIPTS_DIR).toContain('transcripts');
      expect(memoryStore.CONTEXT_DIR).toContain('context');
      expect(memoryStore.SUMMARIES_DIR).toContain('summaries');
      expect(memoryStore.INDEX_DIR).toContain('index');
    });

    test('exports PANE_ROLES mapping', () => {
      expect(memoryStore.PANE_ROLES['1']).toBe('Architect');
      expect(memoryStore.PANE_ROLES['2']).toBe('Infra');
      expect(memoryStore.PANE_ROLES['3']).toBe('Frontend');
      expect(memoryStore.PANE_ROLES['4']).toBe('Backend');
      expect(memoryStore.PANE_ROLES['5']).toBe('Analyst');
      expect(memoryStore.PANE_ROLES['6']).toBe('Reviewer');
    });
  });

  describe('ensureDirectories', () => {
    test('creates missing directories', () => {
      fs.existsSync.mockReturnValue(false);

      memoryStore.ensureDirectories();

      expect(fs.mkdirSync).toHaveBeenCalled();
      // Should create base dirs + per-role context dirs (6 roles)
      expect(fs.mkdirSync.mock.calls.length).toBeGreaterThan(5);
    });

    test('skips existing directories', () => {
      fs.existsSync.mockReturnValue(true);

      memoryStore.ensureDirectories();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('getRoleFromPaneId', () => {
    test('returns correct role for valid pane IDs', () => {
      expect(memoryStore.getRoleFromPaneId('1')).toBe('Architect');
      expect(memoryStore.getRoleFromPaneId('6')).toBe('Reviewer');
    });

    test('returns fallback for unknown pane ID', () => {
      expect(memoryStore.getRoleFromPaneId('99')).toBe('pane-99');
    });

    test('handles numeric pane ID', () => {
      expect(memoryStore.getRoleFromPaneId(1)).toBe('Architect');
    });
  });

  describe('getPaneIdFromRole', () => {
    test('returns correct pane ID for valid roles', () => {
      expect(memoryStore.getPaneIdFromRole('architect')).toBe('1');
      expect(memoryStore.getPaneIdFromRole('reviewer')).toBe('6');
    });

    test('is case insensitive', () => {
      expect(memoryStore.getPaneIdFromRole('ARCHITECT')).toBe('1');
      expect(memoryStore.getPaneIdFromRole('Reviewer')).toBe('6');
    });

    test('returns null for unknown role', () => {
      expect(memoryStore.getPaneIdFromRole('unknown')).toBeNull();
    });
  });

  describe('getDateString', () => {
    test('returns YYYY-MM-DD format', () => {
      const result = memoryStore.getDateString();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // Note: getTranscriptPath and getContextPath are internal functions (not exported)

  describe('Transcript Operations', () => {
    describe('appendTranscript', () => {
      test('appends entry to transcript file', () => {
        const entry = { type: 'input', content: 'test message' };

        const result = memoryStore.appendTranscript('architect', entry);

        expect(result).toBe(true);
        expect(fs.appendFileSync).toHaveBeenCalled();
        const writtenData = fs.appendFileSync.mock.calls[0][1];
        expect(writtenData).toContain('input');
        expect(writtenData).toContain('test message');
        expect(writtenData).toContain('timestamp');
      });

      test('adds timestamp if missing', () => {
        const entry = { type: 'input', content: 'no timestamp' };

        memoryStore.appendTranscript('architect', entry);

        const writtenData = fs.appendFileSync.mock.calls[0][1];
        const parsed = JSON.parse(writtenData);
        expect(parsed.timestamp).toBeDefined();
      });

      test('handles write error gracefully', () => {
        fs.appendFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = memoryStore.appendTranscript('architect', { type: 'input' });

        expect(result).toBe(false);
      });
    });

    describe('readTranscript', () => {
      test('returns empty array when file missing', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.readTranscript('architect');

        expect(result).toEqual([]);
      });

      test('parses JSONL content', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
          '{"type":"input","content":"msg1","timestamp":"2026-01-30T10:00:00Z"}\n' +
          '{"type":"output","content":"msg2","timestamp":"2026-01-30T10:01:00Z"}\n'
        );

        const result = memoryStore.readTranscript('architect');

        expect(result.length).toBe(2);
        expect(result[0].type).toBe('input');
        expect(result[1].type).toBe('output');
      });

      test('filters by since timestamp', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
          '{"type":"input","timestamp":"2026-01-30T10:00:00Z"}\n' +
          '{"type":"output","timestamp":"2026-01-30T12:00:00Z"}\n'
        );

        const result = memoryStore.readTranscript('architect', {
          since: '2026-01-30T11:00:00Z'
        });

        expect(result.length).toBe(1);
        expect(result[0].type).toBe('output');
      });

      test('applies limit from end', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
          '{"type":"a","timestamp":"2026-01-01"}\n' +
          '{"type":"b","timestamp":"2026-01-01"}\n' +
          '{"type":"c","timestamp":"2026-01-01"}\n'
        );

        const result = memoryStore.readTranscript('architect', { limit: 2 });

        expect(result.length).toBe(2);
        expect(result[0].type).toBe('b');
        expect(result[1].type).toBe('c');
      });

      test('handles malformed JSON lines', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
          '{"valid":"entry"}\n' +
          'not valid json\n' +
          '{"another":"valid"}\n'
        );

        const result = memoryStore.readTranscript('architect');

        expect(result.length).toBe(2);
      });

      test('handles read error gracefully', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => {
          throw new Error('Read failed');
        });

        const result = memoryStore.readTranscript('architect');

        expect(result).toEqual([]);
      });
    });

    describe('listTranscriptDates', () => {
      test('returns dates for role', () => {
        fs.readdirSync.mockReturnValue([
          'architect-2026-01-29.jsonl',
          'architect-2026-01-30.jsonl',
          'reviewer-2026-01-30.jsonl'
        ]);

        const result = memoryStore.listTranscriptDates('architect');

        expect(result).toContain('2026-01-30');
        expect(result).toContain('2026-01-29');
        expect(result).not.toContain('reviewer');
      });

      test('returns dates in reverse order (most recent first)', () => {
        fs.readdirSync.mockReturnValue([
          'architect-2026-01-28.jsonl',
          'architect-2026-01-30.jsonl',
          'architect-2026-01-29.jsonl'
        ]);

        const result = memoryStore.listTranscriptDates('architect');

        expect(result[0]).toBe('2026-01-30');
        expect(result[2]).toBe('2026-01-28');
      });

      test('handles readdir error', () => {
        fs.readdirSync.mockImplementation(() => {
          throw new Error('Read dir failed');
        });

        const result = memoryStore.listTranscriptDates('architect');

        expect(result).toEqual([]);
      });
    });

    describe('getTranscriptStats', () => {
      test('returns stats for transcript', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
          '{"type":"input","timestamp":"2026-01-30T10:00:00Z","metadata":{"tokens":100}}\n' +
          '{"type":"output","timestamp":"2026-01-30T10:01:00Z","metadata":{"tokens":200}}\n' +
          '{"type":"input","timestamp":"2026-01-30T10:02:00Z","metadata":{"tokens":50}}\n'
        );

        const result = memoryStore.getTranscriptStats('architect');

        expect(result.role).toBe('architect');
        expect(result.totalEntries).toBe(3);
        expect(result.inputCount).toBe(2);
        expect(result.outputCount).toBe(1);
        expect(result.totalTokens).toBe(350);
        expect(result.firstEntry).toBe('2026-01-30T10:00:00Z');
        expect(result.lastEntry).toBe('2026-01-30T10:02:00Z');
      });

      test('handles empty transcript', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.getTranscriptStats('architect');

        expect(result.totalEntries).toBe(0);
        expect(result.firstEntry).toBeNull();
        expect(result.lastEntry).toBeNull();
      });
    });
  });

  describe('Context Operations', () => {
    describe('saveContext', () => {
      test('saves context to file', () => {
        const context = { currentTask: 'test', learnings: [] };

        const result = memoryStore.saveContext('architect', context);

        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.currentTask).toBe('test');
        expect(writtenData.role).toBe('architect');
        expect(writtenData.lastUpdated).toBeDefined();
      });

      test('handles write error', () => {
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = memoryStore.saveContext('architect', {});

        expect(result).toBe(false);
      });
    });

    describe('loadContext', () => {
      test('returns null when file missing', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.loadContext('architect');

        expect(result).toBeNull();
      });

      test('parses and returns context', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          currentTask: 'review code',
          learnings: ['item1']
        }));

        const result = memoryStore.loadContext('architect');

        expect(result.currentTask).toBe('review code');
        expect(result.learnings).toContain('item1');
      });

      test('handles parse error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('not valid json');

        const result = memoryStore.loadContext('architect');

        expect(result).toBeNull();
      });
    });

    describe('mergeContext', () => {
      test('merges updates into existing context', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          existingKey: 'value1',
          otherKey: 'value2'
        }));

        memoryStore.mergeContext('architect', { existingKey: 'updated', newKey: 'new' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.existingKey).toBe('updated');
        expect(writtenData.otherKey).toBe('value2');
        expect(writtenData.newKey).toBe('new');
      });

      test('creates new context if none exists', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.mergeContext('architect', { newKey: 'value' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.newKey).toBe('value');
      });
    });

    describe('pushToContextArray', () => {
      test('adds item to array in context', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          items: [{ value: 'existing' }]
        }));

        memoryStore.pushToContextArray('architect', 'items', { value: 'new' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.items.length).toBe(2);
        expect(writtenData.items[1].value).toBe('new');
        expect(writtenData.items[1].addedAt).toBeDefined();
      });

      test('creates array if not exists', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.pushToContextArray('architect', 'newArray', 'item');

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.newArray.length).toBe(1);
        expect(writtenData.newArray[0].value).toBe('item');
      });

      test('trims array to maxItems', () => {
        const existingItems = Array(100).fill(null).map((_, i) => ({ idx: i }));
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({ items: existingItems }));

        memoryStore.pushToContextArray('architect', 'items', { idx: 100 }, 50);

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.items.length).toBe(50);
        // Should keep the most recent (end of array)
        expect(writtenData.items[49].idx).toBe(100);
      });
    });
  });

  describe('Summary Operations', () => {
    describe('saveSummary', () => {
      test('saves summary with metadata', () => {
        // Reset mocks explicitly
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync.mockImplementation(() => {}); // Successful write

        const summary = { keyPoints: ['point1'], decisions: [] };

        const result = memoryStore.saveSummary('architect', summary);

        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.keyPoints).toContain('point1');
        expect(writtenData.role).toBe('architect');
        expect(writtenData.generatedAt).toBeDefined();
      });

      test('handles write error', () => {
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = memoryStore.saveSummary('architect', {});

        expect(result).toBe(false);
      });
    });

    describe('loadSummary', () => {
      test('returns null when file missing', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.loadSummary('architect');

        expect(result).toBeNull();
      });

      test('parses and returns summary', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          keyPoints: ['summary point']
        }));

        const result = memoryStore.loadSummary('architect');

        expect(result.keyPoints).toContain('summary point');
      });

      test('handles parse error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('invalid json');

        const result = memoryStore.loadSummary('architect');

        expect(result).toBeNull();
      });
    });
  });

  describe('Index Operations', () => {
    beforeEach(() => {
      // Ensure directories "exist" by default
      fs.existsSync.mockReturnValue(true);
    });

    describe('loadKeywordIndex', () => {
      test('returns default when file missing', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.loadKeywordIndex();

        expect(result.keywords).toEqual({});
        expect(result.lastUpdated).toBeNull();
      });

      test('parses and returns index', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          keywords: { test: [{ role: 'architect' }] }
        }));

        const result = memoryStore.loadKeywordIndex();

        expect(result.keywords.test).toBeDefined();
        expect(result.keywords.test[0].role).toBe('architect');
      });

      test('handles parse error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('bad json');

        const result = memoryStore.loadKeywordIndex();

        expect(result.keywords).toEqual({});
      });
    });

    describe('saveKeywordIndex', () => {
      test('saves index with lastUpdated', () => {
        // Reset mocks explicitly
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync.mockImplementation(() => {}); // Successful write

        const index = { keywords: { test: [] } };

        const result = memoryStore.saveKeywordIndex(index);

        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.keywords.test).toEqual([]);
        expect(writtenData.lastUpdated).toBeDefined();
      });

      test('handles write error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = memoryStore.saveKeywordIndex({});

        expect(result).toBe(false);
      });
    });

    describe('indexKeywords', () => {
      test('adds keywords to index', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.indexKeywords(['api', 'handler'], {
          role: 'architect',
          date: '2026-01-30',
          entryIndex: 5
        });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.keywords.api).toBeDefined();
        expect(writtenData.keywords.handler).toBeDefined();
        expect(writtenData.keywords.api[0].role).toBe('architect');
      });

      test('normalizes keywords to lowercase', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.indexKeywords(['API', 'Handler'], { role: 'architect' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.keywords.api).toBeDefined();
        expect(writtenData.keywords.handler).toBeDefined();
      });

      test('limits references per keyword to 1000', () => {
        const existingRefs = Array(1000).fill({ role: 'old' });
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          keywords: { test: existingRefs }
        }));

        memoryStore.indexKeywords(['test'], { role: 'new' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.keywords.test.length).toBe(1000);
        // Should keep most recent
        expect(writtenData.keywords.test[999].role).toBe('new');
      });
    });
  });

  describe('Shared Memory Operations', () => {
    beforeEach(() => {
      // Ensure directories "exist" by default for save operations
      fs.existsSync.mockReturnValue(true);
    });

    describe('loadSharedMemory', () => {
      test('returns default when file missing', () => {
        fs.existsSync.mockReturnValue(false);

        const result = memoryStore.loadSharedMemory();

        expect(result.learnings).toEqual([]);
        expect(result.decisions).toEqual([]);
        expect(result.lastUpdated).toBeNull();
      });

      test('parses and returns shared memory', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          learnings: [{ topic: 'test' }],
          decisions: []
        }));

        const result = memoryStore.loadSharedMemory();

        expect(result.learnings[0].topic).toBe('test');
      });

      test('handles parse error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('invalid');

        const result = memoryStore.loadSharedMemory();

        expect(result.learnings).toEqual([]);
      });
    });

    describe('saveSharedMemory', () => {
      test('saves with lastUpdated', () => {
        // Reset mocks explicitly
        jest.clearAllMocks();
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync.mockImplementation(() => {}); // Successful write

        const memory = { learnings: [], decisions: [] };

        const result = memoryStore.saveSharedMemory(memory);

        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.lastUpdated).toBeDefined();
      });

      test('handles write error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = memoryStore.saveSharedMemory({});

        expect(result).toBe(false);
      });
    });

    describe('addSharedLearning', () => {
      test('adds learning with id and timestamp', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.addSharedLearning({
          topic: 'API patterns',
          content: 'Use async/await',
          source: 'reviewer',
          confidence: 0.9
        });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.learnings.length).toBe(1);
        expect(writtenData.learnings[0].topic).toBe('API patterns');
        expect(writtenData.learnings[0].id).toMatch(/^learn-/);
        expect(writtenData.learnings[0].addedAt).toBeDefined();
      });

      test('limits to 500 learnings', () => {
        const existingLearnings = Array(500).fill({ topic: 'old' });
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          learnings: existingLearnings,
          decisions: []
        }));

        memoryStore.addSharedLearning({ topic: 'new' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.learnings.length).toBe(500);
        expect(writtenData.learnings[499].topic).toBe('new');
      });
    });

    describe('addSharedDecision', () => {
      test('adds decision with id and timestamp', () => {
        fs.existsSync.mockReturnValue(false);

        memoryStore.addSharedDecision({
          action: 'Use TypeScript',
          rationale: 'Type safety',
          outcome: 'positive',
          agent: 'architect'
        });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.decisions.length).toBe(1);
        expect(writtenData.decisions[0].action).toBe('Use TypeScript');
        expect(writtenData.decisions[0].id).toMatch(/^dec-/);
        expect(writtenData.decisions[0].recordedAt).toBeDefined();
      });

      test('limits to 500 decisions', () => {
        const existingDecisions = Array(500).fill({ action: 'old' });
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
          learnings: [],
          decisions: existingDecisions
        }));

        memoryStore.addSharedDecision({ action: 'new' });

        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.decisions.length).toBe(500);
        expect(writtenData.decisions[499].action).toBe('new');
      });
    });
  });
});
