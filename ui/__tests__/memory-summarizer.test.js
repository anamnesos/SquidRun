/**
 * Memory Summarizer Tests
 * Target: Full coverage of modules/memory/memory-summarizer.js
 */

// Mock dependencies before requiring the module
const mockMemoryStore = {
  PANE_ROLES: {
    '1': 'architect',
    '2': 'devops',
    '5': 'analyst',
  },
  getRoleFromPaneId: jest.fn(id => mockMemoryStore.PANE_ROLES[String(id)] || `pane-${id}`),
  getDateString: jest.fn(() => '2026-01-30'),
  readTranscript: jest.fn(() => []),
  loadContext: jest.fn(() => null),
  loadSummary: jest.fn(() => null),
  saveSummary: jest.fn(),
  loadSharedMemory: jest.fn(() => ({ learnings: [], decisions: [] }))
};

const mockMemorySearch = {
  searchAll: jest.fn(() => ({ results: {} }))
};

jest.mock('../modules/memory/memory-store', () => mockMemoryStore);
jest.mock('../modules/memory/memory-search', () => mockMemorySearch);

// Require after mocking
const memorySummarizer = require('../modules/memory/memory-summarizer');

describe('Memory Summarizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMemoryStore.readTranscript.mockReturnValue([]);
    mockMemoryStore.loadContext.mockReturnValue(null);
    mockMemoryStore.loadSharedMemory.mockReturnValue({ learnings: [], decisions: [] });
  });

  describe('truncateContent', () => {
    test('returns empty string for null/undefined', () => {
      expect(memorySummarizer.truncateContent(null)).toBe('');
      expect(memorySummarizer.truncateContent(undefined)).toBe('');
    });

    test('returns short content unchanged', () => {
      expect(memorySummarizer.truncateContent('Hello world')).toBe('Hello world');
    });

    test('truncates long content at sentence boundary', () => {
      const content = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
      const result = memorySummarizer.truncateContent(content, 50);

      expect(result.length).toBeLessThan(60);
      expect(result).toContain('...');
    });

    test('truncates at newline boundary if better', () => {
      const content = 'First line\nSecond line\nThird line which is really long and should trigger truncation';
      const result = memorySummarizer.truncateContent(content, 40);

      expect(result).toContain('...');
    });

    test('truncates mid-word if no good boundary', () => {
      const content = 'onesinglelongwordwithnobreaksatall'.repeat(20);
      const result = memorySummarizer.truncateContent(content, 50);

      expect(result.length).toBeLessThanOrEqual(53); // +3 for ...
    });
  });

  describe('calculateImportance', () => {
    test('scores decision entries highly', () => {
      const entry = { type: 'decision', content: 'Use TypeScript' };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(score).toBeGreaterThanOrEqual(10);
      expect(reasons).toContain('decision entry');
    });

    test('scores error entries highly', () => {
      const entry = { type: 'error', content: 'Failed to compile', metadata: { errorMessage: 'Syntax error' } };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(score).toBeGreaterThanOrEqual(8);
      expect(reasons).toContain('error with details');
    });

    test('scores tool_use entries', () => {
      const entry = { type: 'tool_use', content: 'Tool: Read', metadata: { toolName: 'Read' } };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(score).toBeGreaterThanOrEqual(5);
      expect(reasons.some(r => r.includes('tool:'))).toBe(true);
    });

    test('scores state entries', () => {
      const entry = { type: 'state', content: 'idle -> working' };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(reasons).toContain('state change');
    });

    test('boosts score for important keywords', () => {
      const entry = { type: 'output', content: 'CRITICAL bug fixed successfully' };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(reasons).toContain('important keyword');
      expect(score).toBeGreaterThan(4);
    });

    test('boosts score for file references', () => {
      const entry = { type: 'input', content: 'Editing src/main.js file' };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(reasons).toContain('file reference');
    });

    test('boosts score for decision rationale', () => {
      const entry = { type: 'decision', content: 'Use React', metadata: { rationale: 'Component model' } };
      const { score, reasons } = memorySummarizer.calculateImportance(entry);

      expect(reasons).toContain('has rationale');
    });

    test('boosts score for long content', () => {
      const longContent = 'x'.repeat(600);
      const entry = { type: 'output', content: longContent };
      const { score } = memorySummarizer.calculateImportance(entry);

      const shortEntry = { type: 'output', content: 'short' };
      const { score: shortScore } = memorySummarizer.calculateImportance(shortEntry);

      expect(score).toBeGreaterThan(shortScore);
    });

    test('handles missing content', () => {
      const entry = { type: 'system' };
      const { score } = memorySummarizer.calculateImportance(entry);

      expect(score).toBeGreaterThanOrEqual(0);
    });

    test('handles unknown entry type', () => {
      const entry = { type: 'unknown', content: 'simple message' };
      const { score } = memorySummarizer.calculateImportance(entry);

      expect(score).toBe(1); // Default weight, no keywords
    });
  });

  describe('SummaryEntry', () => {
    test('creates summary entry from transcript entry', () => {
      const entry = {
        timestamp: '2026-01-30T10:00:00Z',
        type: 'decision',
        content: 'Use TypeScript for type safety',
        metadata: { rationale: 'Better maintainability' }
      };

      const summaryEntry = new memorySummarizer.SummaryEntry(entry, 10, 'decision entry');

      expect(summaryEntry.timestamp).toBe('2026-01-30T10:00:00Z');
      expect(summaryEntry.type).toBe('decision');
      expect(summaryEntry.content).toBe('Use TypeScript for type safety');
      expect(summaryEntry.importance).toBe(10);
      expect(summaryEntry.reason).toBe('decision entry');
      expect(summaryEntry.metadata.rationale).toBe('Better maintainability');
    });

    test('truncates long content', () => {
      const entry = {
        timestamp: '2026-01-30T10:00:00Z',
        type: 'output',
        content: 'x'.repeat(1000),
        metadata: {}
      };

      const summaryEntry = new memorySummarizer.SummaryEntry(entry, 5, 'test');

      expect(summaryEntry.content.length).toBeLessThan(1000);
    });
  });

  describe('summarizeTranscript', () => {
    test('returns message for few entries', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const result = memorySummarizer.summarizeTranscript('architect');

      expect(result.needsSummary).toBe(false);
      expect(result.message).toContain('Not enough entries');
    });

    test('summarizes transcript with enough entries', () => {
      const entries = Array(30).fill(null).map((_, i) => ({
        type: i % 5 === 0 ? 'decision' : 'output',
        content: `Entry ${i} with important bug fix`,
        timestamp: `2026-01-30T10:${String(i).padStart(2, '0')}:00Z`,
        metadata: {}
      }));
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const result = memorySummarizer.summarizeTranscript('architect');

      expect(result.totalEntries).toBe(30);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeDefined();
      expect(mockMemoryStore.saveSummary).toHaveBeenCalled();
    });

    test('filters by importance threshold', () => {
      const entries = [
        ...Array(10).fill({ type: 'system', content: 'low importance', timestamp: '2026-01-30T10:00:00Z' }),
        ...Array(15).fill({ type: 'decision', content: 'high importance fix', timestamp: '2026-01-30T10:00:00Z', metadata: { rationale: 'test' } })
      ];
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const result = memorySummarizer.summarizeTranscript('architect', { threshold: 10 });

      // Should filter out low importance entries
      expect(result.entries.length).toBeLessThan(25);
    });

    test('respects maxEntries option', () => {
      const entries = Array(50).fill(null).map((_, i) => ({
        type: 'decision',
        content: `Decision ${i} fix`,
        timestamp: `2026-01-30T10:${String(i).padStart(2, '0')}:00Z`,
        metadata: { rationale: 'test' }
      }));
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const result = memorySummarizer.summarizeTranscript('architect', { maxEntries: 5 });

      expect(result.entries.length).toBeLessThanOrEqual(5);
    });

    test('passes date option to readTranscript', () => {
      mockMemoryStore.readTranscript.mockReturnValue([]);

      memorySummarizer.summarizeTranscript('architect', { date: '2026-01-29' });

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith('architect', { date: '2026-01-29' });
    });
  });

  describe('generateTranscriptStats', () => {
    test('calculates type counts', () => {
      const entries = [
        { type: 'input', content: 'a', metadata: {} },
        { type: 'input', content: 'b', metadata: {} },
        { type: 'output', content: 'c', metadata: {} },
        { type: 'error', content: 'd', metadata: {} }
      ];
      const scoredEntries = entries.map(e => ({ entry: e, score: 5 }));

      const stats = memorySummarizer.generateTranscriptStats(entries, scoredEntries);

      expect(stats.typeCounts.input).toBe(2);
      expect(stats.typeCounts.output).toBe(1);
      expect(stats.errorCount).toBe(1);
    });

    test('calculates tool usage', () => {
      const entries = [
        { type: 'tool_use', content: 'Tool: Read', metadata: { toolName: 'Read' } },
        { type: 'tool_use', content: 'Tool: Read', metadata: { toolName: 'Read' } },
        { type: 'tool_use', content: 'Tool: Write', metadata: { toolName: 'Write' } }
      ];
      const scoredEntries = entries.map(e => ({ entry: e, score: 5 }));

      const stats = memorySummarizer.generateTranscriptStats(entries, scoredEntries);

      expect(stats.toolUsage.Read).toBe(2);
      expect(stats.toolUsage.Write).toBe(1);
    });

    test('calculates average importance', () => {
      const entries = [{ type: 'output', content: 'a', metadata: {} }];
      const scoredEntries = [
        { entry: entries[0], score: 10 },
        { entry: entries[0], score: 20 }
      ];

      const stats = memorySummarizer.generateTranscriptStats(entries, scoredEntries);

      expect(parseFloat(stats.avgImportance)).toBe(15);
    });

    test('handles empty scored entries', () => {
      const stats = memorySummarizer.generateTranscriptStats([], []);

      expect(stats.avgImportance).toBe('0.00');
    });

    test('calculates timespan', () => {
      const entries = [
        { type: 'input', content: 'a', timestamp: '2026-01-30T10:00:00Z', metadata: {} },
        { type: 'output', content: 'b', timestamp: '2026-01-30T12:00:00Z', metadata: {} }
      ];

      const stats = memorySummarizer.generateTranscriptStats(entries, []);

      expect(stats.timespan.first).toBe('2026-01-30T10:00:00Z');
      expect(stats.timespan.last).toBe('2026-01-30T12:00:00Z');
    });

    test('sums tokens from metadata', () => {
      const entries = [
        { type: 'output', content: 'a', metadata: { tokens: 100 } },
        { type: 'output', content: 'b', metadata: { tokens: 200 } }
      ];

      const stats = memorySummarizer.generateTranscriptStats(entries, []);

      expect(stats.totalTokens).toBe(300);
    });

    test('counts decisions', () => {
      const entries = [
        { type: 'decision', content: 'a', metadata: {} },
        { type: 'decision', content: 'b', metadata: {} },
        { type: 'output', content: 'c', metadata: {} }
      ];

      const stats = memorySummarizer.generateTranscriptStats(entries, []);

      expect(stats.decisionCount).toBe(2);
    });
  });

  describe('summarizeContext', () => {
    test('returns message for missing context', () => {
      mockMemoryStore.loadContext.mockReturnValue(null);

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.exists).toBe(false);
      expect(result.message).toContain('No context found');
    });

    test('summarizes learnings by topic', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [
          { topic: 'API', content: 'Use REST', confidence: 0.9, timestamp: '2026-01-30T10:00:00Z' },
          { topic: 'API', content: 'Use async', confidence: 0.8, timestamp: '2026-01-30T11:00:00Z' },
          { topic: 'Testing', content: 'Use Jest', confidence: 0.95, timestamp: '2026-01-30T12:00:00Z' }
        ],
        fileExpertise: {},
        recentDecisions: [],
        taskStats: { completed: 0, failed: 0, abandoned: 0 },
        recentErrors: []
      });

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.learningsByTopic.API).toHaveLength(2);
      expect(result.learningsByTopic.Testing).toHaveLength(1);
    });

    test('gets top files by expertise', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [],
        fileExpertise: {
          '/src/main.js': { readCount: 10, writeCount: 5, lastAccess: '2026-01-30T10:00:00Z' },
          '/src/utils.js': { readCount: 3, writeCount: 2, lastAccess: '2026-01-30T11:00:00Z' }
        },
        recentDecisions: [],
        taskStats: { completed: 0, failed: 0, abandoned: 0 },
        recentErrors: []
      });

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.topFiles).toHaveLength(2);
      expect(result.topFiles[0].path).toBe('/src/main.js');
      expect(result.topFiles[0].interactions).toBe(15);
    });

    test('calculates task success rate', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [],
        fileExpertise: {},
        recentDecisions: [],
        taskStats: { completed: 8, failed: 2, abandoned: 0 },
        recentErrors: []
      });

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.taskPerformance.successRate).toBe('80.0%');
    });

    test('handles no tasks completed', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [],
        fileExpertise: {},
        recentDecisions: [],
        taskStats: { completed: 0, failed: 0, abandoned: 0 },
        recentErrors: []
      });

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.taskPerformance.successRate).toBe('N/A%');
    });

    test('counts unresolved errors', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [],
        fileExpertise: {},
        recentDecisions: [],
        taskStats: { completed: 0, failed: 0, abandoned: 0 },
        recentErrors: [
          { message: 'error1', resolved: true },
          { message: 'error2', resolved: false },
          { message: 'error3', resolved: false }
        ]
      });

      const result = memorySummarizer.summarizeContext('architect');

      expect(result.unresolvedErrors).toBe(2);
    });
  });

  describe('generateSessionSummary', () => {
    test('generates comprehensive session summary', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'output', content: 'Completed the feature', timestamp: '2026-01-30T10:00:00Z', metadata: {} }
      ]);
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [],
        fileExpertise: {},
        recentDecisions: [],
        taskStats: { completed: 1, failed: 0, abandoned: 0 },
        recentErrors: []
      });

      const result = memorySummarizer.generateSessionSummary('architect');

      expect(result.role).toBe('architect');
      expect(result.date).toBe('2026-01-30');
      expect(result.overview).toBeDefined();
      expect(result.accomplishments).toBeDefined();
      expect(result.context).toBeDefined();
    });
  });

  describe('extractAccomplishments', () => {
    test('extracts entries with completion phrases', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'output', content: 'Completed the feature', timestamp: '2026-01-30T10:00:00Z' },
        { type: 'output', content: 'Fixed the bug', timestamp: '2026-01-30T11:00:00Z' },
        { type: 'output', content: 'Regular message', timestamp: '2026-01-30T12:00:00Z' }
      ]);

      const result = memorySummarizer.extractAccomplishments('architect', '2026-01-30');

      expect(result.length).toBe(2);
    });

    test('limits to 20 accomplishments', () => {
      const entries = Array(30).fill(null).map((_, i) => ({
        type: 'output',
        content: `Finished task ${i}`,
        timestamp: `2026-01-30T10:${String(i).padStart(2, '0')}:00Z`
      }));
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const result = memorySummarizer.extractAccomplishments('architect', '2026-01-30');

      expect(result.length).toBeLessThanOrEqual(20);
    });

    test('handles entries without content', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'system', timestamp: '2026-01-30T10:00:00Z' }
      ]);

      const result = memorySummarizer.extractAccomplishments('architect', '2026-01-30');

      expect(result).toHaveLength(0);
    });
  });

  describe('extractTodayLearnings', () => {
    test('extracts learnings from today', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        learnings: [
          { topic: 'API', content: 'Use REST', timestamp: '2026-01-30T10:00:00Z', confidence: 0.9 },
          { topic: 'Old', content: 'Old learning', timestamp: '2026-01-29T10:00:00Z', confidence: 0.8 }
        ]
      });

      const result = memorySummarizer.extractTodayLearnings('architect', '2026-01-30');

      expect(result.length).toBe(1);
      expect(result[0].topic).toBe('API');
    });

    test('returns empty array for no context', () => {
      mockMemoryStore.loadContext.mockReturnValue(null);

      const result = memorySummarizer.extractTodayLearnings('architect', '2026-01-30');

      expect(result).toEqual([]);
    });

    test('returns empty array for no learnings', () => {
      mockMemoryStore.loadContext.mockReturnValue({});

      const result = memorySummarizer.extractTodayLearnings('architect', '2026-01-30');

      expect(result).toEqual([]);
    });
  });

  describe('extractErrorSummary', () => {
    test('extracts error summary', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'error', content: 'Error 1', timestamp: '2026-01-30T10:00:00Z', metadata: { resolved: true } },
        { type: 'error', content: 'Error 2', timestamp: '2026-01-30T11:00:00Z', metadata: {} },
        { type: 'output', content: 'Not an error', timestamp: '2026-01-30T12:00:00Z' }
      ]);

      const result = memorySummarizer.extractErrorSummary('architect', '2026-01-30');

      expect(result.total).toBe(2);
      expect(result.resolved).toBe(1);
      expect(result.unresolved).toBe(1);
      expect(result.recentErrors).toHaveLength(2);
    });

    test('limits to 5 recent errors', () => {
      const errors = Array(10).fill(null).map((_, i) => ({
        type: 'error',
        content: `Error ${i}`,
        timestamp: `2026-01-30T10:${String(i).padStart(2, '0')}:00Z`,
        metadata: {}
      }));
      mockMemoryStore.readTranscript.mockReturnValue(errors);

      const result = memorySummarizer.extractErrorSummary('architect', '2026-01-30');

      expect(result.recentErrors).toHaveLength(5);
    });
  });

  describe('generateTeamSummary', () => {
    test('generates team summary across all roles', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'output', content: 'work', timestamp: '2026-01-30T10:00:00Z', metadata: {} }
      ]);

      const result = memorySummarizer.generateTeamSummary();

      expect(result.date).toBe('2026-01-30');
      expect(result.overview).toBeDefined();
      expect(result.agentSummaries).toBeDefined();
      expect(Object.keys(result.agentSummaries)).toHaveLength(3);
    });

    test('calculates total entries across agents', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'output', content: 'work', timestamp: '2026-01-30T10:00:00Z', metadata: {} }
      ]);

      const result = memorySummarizer.generateTeamSummary();

      expect(result.overview.totalEntries).toBeGreaterThanOrEqual(0);
    });

    test('aggregates tool usage', () => {
      const entries = Array(25).fill(null).map((_, i) => ({
        type: 'tool_use',
        content: 'Tool: Read',
        timestamp: `2026-01-30T10:${String(i).padStart(2, '0')}:00Z`,
        metadata: { toolName: 'Read' }
      }));
      mockMemoryStore.readTranscript.mockReturnValue(entries);

      const result = memorySummarizer.generateTeamSummary();

      expect(result.toolUsage.length).toBeGreaterThan(0);
    });

    test('includes shared learnings from today', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [
          { topic: 'test', addedAt: '2026-01-30T10:00:00Z' },
          { topic: 'old', addedAt: '2026-01-29T10:00:00Z' }
        ],
        decisions: []
      });
      mockMemoryStore.readTranscript.mockReturnValue([]);

      const result = memorySummarizer.generateTeamSummary({ date: '2026-01-30' });

      expect(result.sharedLearnings).toHaveLength(1);
    });

    test('includes shared decisions from today', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [],
        decisions: [
          { action: 'test', recordedAt: '2026-01-30T10:00:00Z' },
          { action: 'old', recordedAt: '2026-01-29T10:00:00Z' }
        ]
      });
      mockMemoryStore.readTranscript.mockReturnValue([]);

      const result = memorySummarizer.generateTeamSummary({ date: '2026-01-30' });

      expect(result.sharedDecisions).toHaveLength(1);
    });

    test('counts active agents', () => {
      let callCount = 0;
      mockMemoryStore.readTranscript.mockImplementation(() => {
        callCount++;
        // First 3 roles have entries, rest don't
        if (callCount <= 3) {
          return [{ type: 'output', content: 'work', timestamp: '2026-01-30T10:00:00Z', metadata: {} }];
        }
        return [];
      });

      const result = memorySummarizer.generateTeamSummary();

      expect(result.overview.activeAgents).toBe(3);
    });
  });

  describe('generateContextInjection', () => {
    test('generates context injection string', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [],
        fileExpertise: {},
        recentErrors: []
      });

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('# Agent Context: architect');
      expect(result).toContain('Last active:');
    });

    test('includes current task', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        currentTask: { description: 'Fix the bug' },
        learnings: [],
        fileExpertise: {},
        recentErrors: []
      });

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('Current task:');
      expect(result).toContain('Fix the bug');
    });

    test('includes recent learnings', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [
          { topic: 'API', content: 'Use REST patterns' }
        ],
        fileExpertise: {},
        recentErrors: []
      });

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('## Recent Learnings');
      expect(result).toContain('API');
    });

    test('includes expert files', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [],
        fileExpertise: {
          '/src/main.js': { readCount: 10, writeCount: 5 }
        },
        recentErrors: []
      });

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('## Files you know well');
      expect(result).toContain('/src/main.js');
    });

    test('includes unresolved errors', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [],
        fileExpertise: {},
        recentErrors: [
          { message: 'Compilation failed', resolved: false }
        ]
      });

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('## Unresolved Errors');
      expect(result).toContain('Compilation failed');
    });

    test('includes recent activity from summary', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [],
        fileExpertise: {},
        recentErrors: []
      });
      mockMemoryStore.loadSummary.mockReturnValue({
        entries: [
          { type: 'decision', content: 'Used TypeScript' }
        ]
      });

      const result = memorySummarizer.generateContextInjection('architect', { includeHistory: true });

      expect(result).toContain('## Recent Activity Highlights');
    });

    test('respects maxLength option', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: Array(50).fill({ topic: 'test', content: 'x'.repeat(100) }),
        fileExpertise: {},
        recentErrors: []
      });

      const result = memorySummarizer.generateContextInjection('architect', { maxLength: 500 });

      expect(result.length).toBeLessThanOrEqual(500);
      expect(result).toContain('[Context truncated...]');
    });

    test('excludes history when includeHistory is false', () => {
      mockMemoryStore.loadContext.mockReturnValue({
        lastActive: '2026-01-30T10:00:00Z',
        learnings: [],
        fileExpertise: {},
        recentErrors: []
      });
      mockMemoryStore.loadSummary.mockReturnValue({
        entries: [{ type: 'decision', content: 'test' }]
      });

      const result = memorySummarizer.generateContextInjection('architect', { includeHistory: false });

      expect(result).not.toContain('## Recent Activity Highlights');
    });

    test('handles missing context gracefully', () => {
      mockMemoryStore.loadContext.mockReturnValue(null);

      const result = memorySummarizer.generateContextInjection('architect');

      expect(result).toContain('# Agent Context: architect');
      expect(result).toContain('unknown');
    });
  });

  describe('estimateTokens', () => {
    test('returns 0 for empty or null text', () => {
      expect(memorySummarizer.estimateTokens('')).toBe(0);
      expect(memorySummarizer.estimateTokens(null)).toBe(0);
      expect(memorySummarizer.estimateTokens(undefined)).toBe(0);
    });

    test('estimates tokens based on word count', () => {
      const text = 'hello world test';
      const result = memorySummarizer.estimateTokens(text);
      // 3 words * 1.3 tokens/word = 3.9 -> 4 tokens (word-based)
      // 16 chars / 4 chars/token = 4 tokens (char-based)
      // max(4, 4) = 4
      expect(result).toBeGreaterThanOrEqual(4);
    });

    test('estimates tokens based on character count for long words', () => {
      const text = 'supercalifragilisticexpialidocious';
      const result = memorySummarizer.estimateTokens(text);
      // 1 word * 1.3 = 1.3 -> 2 tokens (word-based)
      // 34 chars / 4 = 8.5 -> 9 tokens (char-based)
      // max(2, 9) = 9
      expect(result).toBeGreaterThanOrEqual(8);
    });

    test('uses custom tokensPerWord option', () => {
      const text = 'hello world test';
      const result = memorySummarizer.estimateTokens(text, { tokensPerWord: 2 });
      // 3 words * 2 tokens/word = 6 tokens
      expect(result).toBeGreaterThanOrEqual(6);
    });

    test('uses custom charsPerToken option', () => {
      const text = 'hello world';
      const result = memorySummarizer.estimateTokens(text, { charsPerToken: 2 });
      // 11 chars / 2 = 5.5 -> 6 tokens
      expect(result).toBeGreaterThanOrEqual(6);
    });

    test('handles text with multiple spaces', () => {
      const text = 'hello    world';
      const result = memorySummarizer.estimateTokens(text);
      // Should still count only 2 words
      expect(result).toBeGreaterThanOrEqual(2);
    });
  });
});
