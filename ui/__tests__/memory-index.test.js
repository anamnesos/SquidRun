/**
 * Memory Index Tests
 * Target: Full coverage of modules/memory/index.js (main entry point)
 */

// Create mock sub-modules before requiring index
const mockMemoryStore = {
  ensureDirectories: jest.fn(),
  MEMORY_ROOT: '/test/memory',
  PANE_ROLES: {
    '1': 'architect',
    '2': 'devops',
    '5': 'analyst',
  },
  getRoleFromPaneId: jest.fn(id => mockMemoryStore.PANE_ROLES[String(id)] || `pane-${id}`),
  loadSharedMemory: jest.fn(() => ({ learnings: [], decisions: [] })),
};

const mockTranscriptLogger = {
  logInput: jest.fn(),
  logOutput: jest.fn(),
  logToolUse: jest.fn(),
  logDecision: jest.fn(),
  logError: jest.fn(),
  logTriggerMessage: jest.fn(),
  logCodexEvent: jest.fn(),
  getRecentTranscript: jest.fn(() => []),
  getTranscriptStats: jest.fn(() => ({})),
  forceFlush: jest.fn(),
  startSession: jest.fn(),
  endSession: jest.fn(),
};

const mockContextManager = {
  recordDecision: jest.fn(),
  recordError: jest.fn(),
  addLearning: jest.fn(),
  recordFileInteraction: jest.fn(),
  recordInteraction: jest.fn(),
  getContextSummary: jest.fn(() => ({})),
  startSession: jest.fn(),
  endSession: jest.fn(),
  setCurrentTask: jest.fn(),
  completeTask: jest.fn(),
  getTaskHistory: jest.fn(() => []),
  getCollaborationStats: jest.fn(() => ({})),
  getExpertFiles: jest.fn(() => []),
};

const mockMemorySearch = {
  searchAll: jest.fn(() => ({ results: {} })),
  searchAllTranscripts: jest.fn(() => []),
  analyzeToolUsage: jest.fn(() => ({})),
};

const mockMemorySummarizer = {
  generateSessionSummary: jest.fn(() => ({})),
  generateContextInjection: jest.fn(() => ''),
  generateTeamSummary: jest.fn(() => ({})),
};

jest.mock('../modules/memory/memory-store', () => mockMemoryStore);
jest.mock('../modules/memory/transcript-logger', () => mockTranscriptLogger);
jest.mock('../modules/memory/context-manager', () => mockContextManager);
jest.mock('../modules/memory/memory-search', () => mockMemorySearch);
jest.mock('../modules/memory/memory-summarizer', () => mockMemorySummarizer);

// Now require the module under test
const memory = require('../modules/memory');

describe('Memory Module (index.js)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    test('initialize calls ensureDirectories', () => {
      memory.initialize();

      expect(mockMemoryStore.ensureDirectories).toHaveBeenCalled();
    });

    test('initialize only runs once per session', () => {
      // Note: Module-level `initialized` flag persists across tests
      // This test verifies subsequent calls don't add more ensureDirectories calls
      const callsBefore = mockMemoryStore.ensureDirectories.mock.calls.length;

      memory.initialize();
      memory.initialize();
      memory.initialize();

      // Should not increase call count (already initialized from previous tests)
      const callsAfter = mockMemoryStore.ensureDirectories.mock.calls.length;
      expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
    });
  });

  describe('shutdown', () => {
    test('shutdown flushes logs and ends sessions', () => {
      memory.shutdown();

      expect(mockTranscriptLogger.forceFlush).toHaveBeenCalled();
      // Should end sessions for all roles
      expect(mockContextManager.endSession).toHaveBeenCalled();
    });
  });

  describe('Logging Functions', () => {
    test('logInput logs via transcript logger', () => {
      memory.logInput('1', 'test message', { source: 'user' });

      expect(mockTranscriptLogger.logInput).toHaveBeenCalledWith('1', 'test message', { source: 'user' });
    });

    test('logOutput logs via transcript logger', () => {
      memory.logOutput('1', 'response', { tokens: 100 });

      expect(mockTranscriptLogger.logOutput).toHaveBeenCalledWith('1', 'response', { tokens: 100 });
    });

    test('logToolUse logs via transcript logger', () => {
      memory.logToolUse('1', 'Bash', { command: 'ls' });

      expect(mockTranscriptLogger.logToolUse).toHaveBeenCalledWith('1', 'Bash', { command: 'ls' });
    });

    test('logDecision logs and records decision', () => {
      memory.logDecision('1', 'use TypeScript', 'type safety');

      expect(mockTranscriptLogger.logDecision).toHaveBeenCalledWith('1', 'use TypeScript', 'type safety');
      expect(mockContextManager.recordDecision).toHaveBeenCalledWith('architect', {
        action: 'use TypeScript',
        rationale: 'type safety'
      });
    });

    test('logError logs and records error', () => {
      const error = new Error('test error');
      memory.logError('1', 'Something failed', error);

      expect(mockTranscriptLogger.logError).toHaveBeenCalledWith('1', 'Something failed', error);
      expect(mockContextManager.recordError).toHaveBeenCalledWith('architect', {
        message: 'Something failed',
        stack: error.stack
      });
    });

    test('logError handles null error', () => {
      memory.logError('1', 'Something failed', null);

      expect(mockContextManager.recordError).toHaveBeenCalledWith('architect', {
        message: 'Something failed',
        stack: undefined
      });
    });

    test('logCodexEvent logs via transcript logger', () => {
      const event = { type: 'exec', data: 'command output' };
      memory.logCodexEvent('2', event);

      expect(mockTranscriptLogger.logCodexEvent).toHaveBeenCalledWith('2', event);
    });
  });

  describe('Context Functions', () => {
    test('recordLearning adds learning to context', () => {
      memory.recordLearning('1', 'api patterns', 'Always use async/await', 0.9);

      expect(mockContextManager.addLearning).toHaveBeenCalledWith('architect', {
        topic: 'api patterns',
        content: 'Always use async/await',
        confidence: 0.9
      });
    });

    test('recordLearning uses default confidence', () => {
      memory.recordLearning('1', 'topic', 'content');

      expect(mockContextManager.addLearning).toHaveBeenCalledWith('architect', expect.objectContaining({
        confidence: 0.8
      }));
    });

    test('recordFileAccess records file interaction', () => {
      memory.recordFileAccess('1', 'src/main.js', 'read');

      expect(mockContextManager.recordFileInteraction).toHaveBeenCalledWith('architect', 'src/main.js', 'read');
    });

    test('getContextSummary returns context summary', () => {
      mockContextManager.getContextSummary.mockReturnValue({ currentTask: 'test' });

      const result = memory.getContextSummary('1');

      expect(mockContextManager.getContextSummary).toHaveBeenCalledWith('architect');
      expect(result.currentTask).toBe('test');
    });

    test('getContextInjection returns injection string', () => {
      mockMemorySummarizer.generateContextInjection.mockReturnValue('Context: recent work...');

      const result = memory.getContextInjection('1', { maxLength: 500 });

      expect(mockMemorySummarizer.generateContextInjection).toHaveBeenCalledWith('architect', { maxLength: 500 });
      expect(result).toBe('Context: recent work...');
    });
  });

  describe('Session Management', () => {
    test('startSession starts session for pane', () => {
      memory.startSession('1', 'session-123');

      expect(mockTranscriptLogger.startSession).toHaveBeenCalledWith('1');
      expect(mockContextManager.startSession).toHaveBeenCalledWith('architect', 'session-123');
    });

    test('endSession ends session for pane', () => {
      memory.endSession('1');

      expect(mockTranscriptLogger.endSession).toHaveBeenCalledWith('1');
      expect(mockContextManager.endSession).toHaveBeenCalledWith('architect');
    });

    test('setCurrentTask sets task in context', () => {
      const task = { id: 'task-1', description: 'Implement feature' };
      memory.setCurrentTask('1', task);

      expect(mockContextManager.setCurrentTask).toHaveBeenCalledWith('architect', task);
    });

    test('completeTask completes task in context', () => {
      memory.completeTask('1', 'success', { duration: 1000 });

      expect(mockContextManager.completeTask).toHaveBeenCalledWith('architect', 'success', { duration: 1000 });
    });
  });

  describe('Query Functions', () => {
    test('getRecentTranscript returns transcript entries', () => {
      mockTranscriptLogger.getRecentTranscript.mockReturnValue([
        { type: 'input', content: 'test' }
      ]);

      const result = memory.getRecentTranscript('1', 10);

      expect(mockTranscriptLogger.getRecentTranscript).toHaveBeenCalledWith('1', 10);
      expect(result).toHaveLength(1);
    });

    test('getRecentTranscript uses default limit', () => {
      memory.getRecentTranscript('1');

      expect(mockTranscriptLogger.getRecentTranscript).toHaveBeenCalledWith('1', 50);
    });

    test('getSummary returns session summary', () => {
      mockMemorySummarizer.generateSessionSummary.mockReturnValue({ keyPoints: ['test'] });

      const result = memory.getSummary('1');

      expect(mockMemorySummarizer.generateSessionSummary).toHaveBeenCalledWith('architect');
      expect(result.keyPoints).toContain('test');
    });

    test('search calls unified search', () => {
      mockMemorySearch.searchAll.mockReturnValue({
        query: 'test',
        results: { transcripts: [] }
      });

      const result = memory.search('test', { limit: 20 });

      expect(mockMemorySearch.searchAll).toHaveBeenCalledWith('test', { limit: 20 });
      expect(result.query).toBe('test');
    });

    test('searchAllAgents searches all transcripts', () => {
      mockMemorySearch.searchAllTranscripts.mockReturnValue([{ type: 'transcript' }]);

      const result = memory.searchAllAgents('test', { limit: 30 });

      expect(mockMemorySearch.searchAllTranscripts).toHaveBeenCalledWith('test', { limit: 30 });
      expect(result).toHaveLength(1);
    });
  });

  describe('Team Operations', () => {
    test('getTeamSummary returns team summary', () => {
      mockMemorySummarizer.generateTeamSummary.mockReturnValue({
        activeAgents: 6,
        totalTasks: 10
      });

      const result = memory.getTeamSummary();

      expect(mockMemorySummarizer.generateTeamSummary).toHaveBeenCalled();
      expect(result.activeAgents).toBe(6);
    });

    test('getSharedLearnings returns shared learnings', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [{ topic: 'test1' }, { topic: 'test2' }, { topic: 'test3' }],
        decisions: []
      });

      const result = memory.getSharedLearnings(2);

      expect(result).toHaveLength(2);
    });

    test('getSharedLearnings uses default limit', () => {
      const learnings = Array(60).fill({ topic: 'test' });
      mockMemoryStore.loadSharedMemory.mockReturnValue({ learnings, decisions: [] });

      const result = memory.getSharedLearnings();

      expect(result).toHaveLength(50);
    });

    test('getSharedDecisions returns shared decisions', () => {
      mockMemoryStore.loadSharedMemory.mockReturnValue({
        learnings: [],
        decisions: [{ action: 'a' }, { action: 'b' }]
      });

      const result = memory.getSharedDecisions(1);

      expect(result).toHaveLength(1);
    });
  });

  describe('Trigger Integration', () => {
    test('logTriggerMessage logs message and records interactions', () => {
      memory.logTriggerMessage('1', '5', 'Review complete');

      expect(mockTranscriptLogger.logTriggerMessage).toHaveBeenCalledWith('1', '5', 'Review complete');
      expect(mockContextManager.recordInteraction).toHaveBeenCalledWith('architect', 'analyst', 'sent', expect.any(String));
      expect(mockContextManager.recordInteraction).toHaveBeenCalledWith('analyst', 'architect', 'received', expect.any(String));
    });

    test('logTriggerMessage truncates content for interaction', () => {
      const longContent = 'x'.repeat(200);
      memory.logTriggerMessage('1', '5', longContent);

      expect(mockContextManager.recordInteraction).toHaveBeenCalledWith(
        'architect', 'analyst', 'sent',
        expect.stringMatching(/^x{100}$/)
      );
    });
  });

  describe('Analytics', () => {
    test('getTranscriptStats returns transcript stats', () => {
      mockTranscriptLogger.getTranscriptStats.mockReturnValue({
        totalEntries: 100,
        inputCount: 50
      });

      const result = memory.getTranscriptStats('1');

      expect(mockTranscriptLogger.getTranscriptStats).toHaveBeenCalledWith('1');
      expect(result.totalEntries).toBe(100);
    });

    test('getTaskHistory returns task history', () => {
      mockContextManager.getTaskHistory.mockReturnValue([
        { task: 'task1' }, { task: 'task2' }
      ]);

      const result = memory.getTaskHistory('1', 5);

      expect(mockContextManager.getTaskHistory).toHaveBeenCalledWith('architect', 5);
      expect(result).toHaveLength(2);
    });

    test('getCollaborationStats returns collaboration stats', () => {
      mockContextManager.getCollaborationStats.mockReturnValue({
        totalMessages: 50,
        partners: ['analyst', 'infra']
      });

      const result = memory.getCollaborationStats('1');

      expect(mockContextManager.getCollaborationStats).toHaveBeenCalledWith('architect');
      expect(result.partners).toContain('analyst');
    });

    test('getExpertFiles returns expert files', () => {
      mockContextManager.getExpertFiles.mockReturnValue([
        { path: 'main.js', interactions: 10 }
      ]);

      const result = memory.getExpertFiles('1', 5);

      expect(mockContextManager.getExpertFiles).toHaveBeenCalledWith('architect', 5);
      expect(result[0].path).toBe('main.js');
    });

    test('analyzeToolUsage returns tool analysis', () => {
      mockMemorySearch.analyzeToolUsage.mockReturnValue({
        tools: { Bash: { count: 10 } }
      });

      const result = memory.analyzeToolUsage('Bash', { limit: 100 });

      expect(mockMemorySearch.analyzeToolUsage).toHaveBeenCalledWith('Bash', { limit: 100 });
      expect(result.tools.Bash.count).toBe(10);
    });
  });
});
