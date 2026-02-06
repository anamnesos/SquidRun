/**
 * Context Manager Tests
 * Target: Full coverage of modules/memory/context-manager.js
 */

// Mock memory-store before requiring the module
const mockContexts = new Map();

const mockMemoryStore = {
  PANE_ROLES: {
    '1': 'architect',
    '2': 'infra',
    '4': 'backend',
    '5': 'analyst',
  },
  getRoleFromPaneId: jest.fn(id => mockMemoryStore.PANE_ROLES[String(id)] || `pane-${id}`),
  loadContext: jest.fn(role => mockContexts.get(role) || null),
  saveContext: jest.fn((role, context) => {
    mockContexts.set(role, context);
    return true;
  }),
  addSharedLearning: jest.fn()
};

jest.mock('../modules/memory/memory-store', () => mockMemoryStore);

// Require after mocking
const contextManager = require('../modules/memory/context-manager');

describe('Context Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContexts.clear();
  });

  describe('initContext', () => {
    test('creates default context when none exists', () => {
      const context = contextManager.initContext('architect');

      expect(mockMemoryStore.loadContext).toHaveBeenCalledWith('architect');
      expect(mockMemoryStore.saveContext).toHaveBeenCalledWith('architect', expect.objectContaining({
        role: 'architect',
        version: 1,
        currentTask: null,
        recentTasks: [],
        learnings: []
      }));
      expect(context.role).toBe('architect');
    });

    test('returns existing context when available', () => {
      const existingContext = {
        version: 1,
        role: 'architect',
        sessionCount: 5,
        recentTasks: [{ id: 'task-1' }]
      };
      mockContexts.set('architect', existingContext);

      const context = contextManager.initContext('architect');

      expect(context.sessionCount).toBe(5);
      expect(context.recentTasks).toHaveLength(1);
    });

    test('migrates old context version', () => {
      const oldContext = {
        version: 0, // Old version
        role: 'architect'
      };
      mockContexts.set('architect', oldContext);

      const context = contextManager.initContext('architect');

      expect(context.version).toBe(1);
      expect(mockMemoryStore.saveContext).toHaveBeenCalled();
    });
  });

  describe('getContext', () => {
    test('returns context for role', () => {
      const context = contextManager.getContext('reviewer');
      expect(context.role).toBe('reviewer');
    });
  });

  describe('getContextForPane', () => {
    test('returns context for pane ID', () => {
      const context = contextManager.getContextForPane('1');

      expect(mockMemoryStore.getRoleFromPaneId).toHaveBeenCalledWith('1');
      expect(context.role).toBe('architect');
    });
  });

  describe('Session Management', () => {
    test('startSession initializes session', () => {
      const context = contextManager.startSession('architect', 'session-123');

      expect(context.currentSessionId).toBe('session-123');
      expect(context.sessionCount).toBe(1);
      expect(context.sessionStartTime).toBeDefined();
      expect(mockMemoryStore.saveContext).toHaveBeenCalled();
    });

    test('startSession generates session ID if not provided', () => {
      const context = contextManager.startSession('architect');

      expect(context.currentSessionId).toMatch(/^session-\d+$/);
    });

    test('startSession increments session count', () => {
      contextManager.startSession('architect');
      const context = contextManager.startSession('architect');

      expect(context.sessionCount).toBe(2);
    });

    test('endSession calculates active time', () => {
      const startContext = contextManager.startSession('architect');
      const startTime = startContext.sessionStartTime;

      // Simulate time passing
      mockContexts.get('architect').sessionStartTime = startTime - 10000;

      const endContext = contextManager.endSession('architect');

      expect(endContext.totalActiveTime).toBeGreaterThanOrEqual(10000);
      expect(endContext.currentSessionId).toBeNull();
      expect(endContext.sessionStartTime).toBeNull();
    });

    test('endSession handles no start time', () => {
      const context = contextManager.endSession('architect');

      expect(context.currentSessionId).toBeNull();
    });

    test('touch updates lastActive', () => {
      const before = new Date().toISOString();
      contextManager.touch('architect');
      const context = mockContexts.get('architect');

      expect(new Date(context.lastActive).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe('Task Management', () => {
    test('setCurrentTask sets task and state', () => {
      const task = { id: 'task-1', description: 'Fix bug' };
      const context = contextManager.setCurrentTask('architect', task);

      expect(context.currentTask.id).toBe('task-1');
      expect(context.currentTask.description).toBe('Fix bug');
      expect(context.currentTask.startedAt).toBeDefined();
      expect(context.currentState).toBe('working');
    });

    test('completeTask records completed task', () => {
      contextManager.setCurrentTask('architect', { id: 'task-1' });
      const context = contextManager.completeTask('architect', 'completed', { notes: 'Done' });

      expect(context.currentTask).toBeNull();
      expect(context.currentState).toBe('idle');
      expect(context.recentTasks).toHaveLength(1);
      expect(context.recentTasks[0].outcome).toBe('completed');
      expect(context.taskStats.completed).toBe(1);
    });

    test('completeTask records failed task', () => {
      contextManager.setCurrentTask('architect', { id: 'task-1' });
      const context = contextManager.completeTask('architect', 'failed');

      expect(context.taskStats.failed).toBe(1);
    });

    test('completeTask records abandoned task', () => {
      contextManager.setCurrentTask('architect', { id: 'task-1' });
      const context = contextManager.completeTask('architect', 'abandoned');

      expect(context.taskStats.abandoned).toBe(1);
    });

    test('completeTask handles no current task', () => {
      const context = contextManager.completeTask('architect', 'completed');

      expect(context.currentTask).toBeNull();
      expect(context.recentTasks).toHaveLength(0);
    });

    test('completeTask trims task history to max', () => {
      // Fill up tasks
      for (let i = 0; i < 55; i++) {
        contextManager.setCurrentTask('architect', { id: `task-${i}` });
        contextManager.completeTask('architect', 'completed');
      }

      const context = contextManager.getContext('architect');
      expect(context.recentTasks.length).toBeLessThanOrEqual(50);
    });

    test('getTaskHistory returns recent tasks', () => {
      contextManager.setCurrentTask('architect', { id: 'task-1' });
      contextManager.completeTask('architect', 'completed');
      contextManager.setCurrentTask('architect', { id: 'task-2' });
      contextManager.completeTask('architect', 'completed');

      const history = contextManager.getTaskHistory('architect', 5);

      expect(history).toHaveLength(2);
    });

    test('getTaskHistory respects limit', () => {
      for (let i = 0; i < 10; i++) {
        contextManager.setCurrentTask('architect', { id: `task-${i}` });
        contextManager.completeTask('architect', 'completed');
      }

      const history = contextManager.getTaskHistory('architect', 3);

      expect(history).toHaveLength(3);
    });
  });

  describe('File Interaction Tracking', () => {
    test('recordFileInteraction adds to recent files', () => {
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');
      const context = contextManager.getContext('architect');

      expect(context.recentFiles).toHaveLength(1);
      expect(context.recentFiles[0].path).toBe('/src/main.js');
      expect(context.recentFiles[0].action).toBe('read');
    });

    test('recordFileInteraction tracks expertise', () => {
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');
      contextManager.recordFileInteraction('architect', '/src/main.js', 'write');

      const context = contextManager.getContext('architect');
      const expertise = context.fileExpertise['/src/main.js'];

      expect(expertise.readCount).toBe(2);
      expect(expertise.writeCount).toBe(1);
    });

    test('recordFileInteraction handles create action', () => {
      contextManager.recordFileInteraction('architect', '/src/new.js', 'create');

      const context = contextManager.getContext('architect');
      const expertise = context.fileExpertise['/src/new.js'];

      expect(expertise.writeCount).toBe(1);
    });

    test('recordFileInteraction trims to max files', () => {
      for (let i = 0; i < 210; i++) {
        contextManager.recordFileInteraction('architect', `/file-${i}.js`, 'read');
      }

      const context = contextManager.getContext('architect');
      expect(context.recentFiles.length).toBeLessThanOrEqual(200);
    });

    test('recordFileInteraction updates currentFile', () => {
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');

      const context = contextManager.getContext('architect');
      expect(context.currentFile).toBe('/src/main.js');
    });

    test('getExpertFiles returns files with enough interactions', () => {
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');
      contextManager.recordFileInteraction('architect', '/src/main.js', 'read');
      contextManager.recordFileInteraction('architect', '/src/main.js', 'write');
      contextManager.recordFileInteraction('architect', '/src/other.js', 'read');

      const expertFiles = contextManager.getExpertFiles('architect', 3);

      expect(expertFiles).toHaveLength(1);
      expect(expertFiles[0].path).toBe('/src/main.js');
      expect(expertFiles[0].totalInteractions).toBe(3);
    });

    test('getExpertFiles sorts by interaction count', () => {
      for (let i = 0; i < 5; i++) {
        contextManager.recordFileInteraction('architect', '/src/frequent.js', 'read');
      }
      for (let i = 0; i < 3; i++) {
        contextManager.recordFileInteraction('architect', '/src/less.js', 'read');
      }

      const expertFiles = contextManager.getExpertFiles('architect', 3);

      expect(expertFiles[0].path).toBe('/src/frequent.js');
    });

    test('getRecentFiles returns recent file activity', () => {
      contextManager.recordFileInteraction('architect', '/file1.js', 'read');
      contextManager.recordFileInteraction('architect', '/file2.js', 'write');

      const recent = contextManager.getRecentFiles('architect', 10);

      expect(recent).toHaveLength(2);
    });

    test('getRecentFiles respects limit', () => {
      for (let i = 0; i < 30; i++) {
        contextManager.recordFileInteraction('architect', `/file-${i}.js`, 'read');
      }

      const recent = contextManager.getRecentFiles('architect', 5);

      expect(recent).toHaveLength(5);
    });
  });

  describe('Learning and Knowledge', () => {
    test('addLearning stores learning', () => {
      const learning = { topic: 'API patterns', content: 'Use async/await', confidence: 0.9 };
      const record = contextManager.addLearning('architect', learning);

      expect(record.id).toMatch(/^learn-\d+-/);
      expect(record.topic).toBe('API patterns');
      expect(record.timestamp).toBeDefined();

      const context = contextManager.getContext('architect');
      expect(context.learnings).toHaveLength(1);
    });

    test('addLearning shares to shared memory', () => {
      contextManager.addLearning('architect', { topic: 'test', content: 'content' });

      expect(mockMemoryStore.addSharedLearning).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test',
          agent: 'architect'
        })
      );
    });

    test('addLearning trims to max learnings', () => {
      for (let i = 0; i < 110; i++) {
        contextManager.addLearning('architect', { topic: `topic-${i}`, content: 'content' });
      }

      const context = contextManager.getContext('architect');
      expect(context.learnings.length).toBeLessThanOrEqual(100);
    });

    test('getLearnings returns all learnings', () => {
      contextManager.addLearning('architect', { topic: 'A', content: 'a' });
      contextManager.addLearning('architect', { topic: 'B', content: 'b' });

      const learnings = contextManager.getLearnings('architect');

      expect(learnings).toHaveLength(2);
    });

    test('getLearnings filters by topic', () => {
      contextManager.addLearning('architect', { topic: 'API patterns', content: 'a' });
      contextManager.addLearning('architect', { topic: 'Testing', content: 'b' });

      const learnings = contextManager.getLearnings('architect', { topic: 'API' });

      expect(learnings).toHaveLength(1);
      expect(learnings[0].topic).toBe('API patterns');
    });

    test('getLearnings filters by minConfidence', () => {
      contextManager.addLearning('architect', { topic: 'A', content: 'a', confidence: 0.9 });
      contextManager.addLearning('architect', { topic: 'B', content: 'b', confidence: 0.5 });

      const learnings = contextManager.getLearnings('architect', { minConfidence: 0.8 });

      expect(learnings).toHaveLength(1);
    });

    test('getLearnings filters by since', () => {
      const oldLearning = { topic: 'old', content: 'old', timestamp: '2024-01-01T00:00:00Z' };
      contextManager.addLearning('architect', { topic: 'new', content: 'new' });

      // Manually add old learning
      const context = contextManager.getContext('architect');
      context.learnings.unshift(oldLearning);

      const learnings = contextManager.getLearnings('architect', { since: '2024-12-01T00:00:00Z' });

      expect(learnings).toHaveLength(1);
      expect(learnings[0].topic).toBe('new');
    });

    test('addPattern stores new pattern', () => {
      contextManager.addPattern('architect', { pattern: 'async/await', description: 'Use async' });

      const context = contextManager.getContext('architect');
      expect(context.knownPatterns).toHaveLength(1);
      expect(context.knownPatterns[0].frequency).toBe(1);
    });

    test('addPattern increments existing pattern frequency', () => {
      contextManager.addPattern('architect', { pattern: 'async/await', description: 'Use async' });
      contextManager.addPattern('architect', { pattern: 'async/await', description: 'Use async' });

      const context = contextManager.getContext('architect');
      expect(context.knownPatterns).toHaveLength(1);
      expect(context.knownPatterns[0].frequency).toBe(2);
    });
  });

  describe('Decision Tracking', () => {
    test('recordDecision stores decision', () => {
      const decision = { action: 'Use TypeScript', rationale: 'Type safety' };
      const record = contextManager.recordDecision('architect', decision);

      expect(record.id).toMatch(/^dec-\d+$/);
      expect(record.action).toBe('Use TypeScript');

      const context = contextManager.getContext('architect');
      expect(context.recentDecisions).toHaveLength(1);
    });

    test('recordDecision trims to max decisions', () => {
      for (let i = 0; i < 110; i++) {
        contextManager.recordDecision('architect', { action: `decision-${i}` });
      }

      const context = contextManager.getContext('architect');
      expect(context.recentDecisions.length).toBeLessThanOrEqual(100);
    });

    test('updateDecisionOutcome updates existing decision', () => {
      const record = contextManager.recordDecision('architect', { action: 'Test' });
      contextManager.updateDecisionOutcome('architect', record.id, 'success', 'Worked well');

      const context = contextManager.getContext('architect');
      const decision = context.recentDecisions.find(d => d.id === record.id);

      expect(decision.outcome).toBe('success');
      expect(decision.outcomeNotes).toBe('Worked well');
      expect(decision.resolvedAt).toBeDefined();
    });

    test('updateDecisionOutcome ignores unknown decision', () => {
      // First init the context
      contextManager.initContext('architect');
      jest.clearAllMocks();

      contextManager.updateDecisionOutcome('architect', 'nonexistent', 'success');

      // initContext is called but since decision not found, no additional save
      // Actually the function calls initContext which may save - check no decision was modified
      const context = contextManager.getContext('architect');
      expect(context.recentDecisions).toHaveLength(0);
    });

    test('getRecentDecisions returns decisions', () => {
      contextManager.recordDecision('architect', { action: 'A' });
      contextManager.recordDecision('architect', { action: 'B' });

      const decisions = contextManager.getRecentDecisions('architect');

      expect(decisions).toHaveLength(2);
    });

    test('getRecentDecisions respects limit', () => {
      for (let i = 0; i < 20; i++) {
        contextManager.recordDecision('architect', { action: `decision-${i}` });
      }

      const decisions = contextManager.getRecentDecisions('architect', 5);

      expect(decisions).toHaveLength(5);
    });
  });

  describe('Error Tracking', () => {
    test('recordError stores error', () => {
      const error = { message: 'Something failed', stack: 'Error trace' };
      const record = contextManager.recordError('architect', error);

      expect(record.id).toMatch(/^err-\d+$/);
      expect(record.resolved).toBe(false);

      const context = contextManager.getContext('architect');
      expect(context.recentErrors).toHaveLength(1);
    });

    test('recordError trims to max errors', () => {
      for (let i = 0; i < 60; i++) {
        contextManager.recordError('architect', { message: `error-${i}` });
      }

      const context = contextManager.getContext('architect');
      expect(context.recentErrors.length).toBeLessThanOrEqual(50);
    });

    test('resolveError marks error resolved', () => {
      const record = contextManager.recordError('architect', { message: 'Bug' });
      contextManager.resolveError('architect', record.id, 'Fixed the issue');

      const context = contextManager.getContext('architect');
      const error = context.recentErrors.find(e => e.id === record.id);

      expect(error.resolved).toBe(true);
      expect(error.resolution).toBe('Fixed the issue');
      expect(error.resolvedAt).toBeDefined();
    });

    test('resolveError ignores unknown error', () => {
      // First init the context
      contextManager.initContext('architect');
      jest.clearAllMocks();

      contextManager.resolveError('architect', 'nonexistent', 'fix');

      // Should not throw - check no error was resolved
      const errors = contextManager.getUnresolvedErrors('architect');
      expect(errors).toHaveLength(0);
    });

    test('getUnresolvedErrors returns only unresolved', () => {
      const err1 = contextManager.recordError('architect', { message: 'error1' });
      contextManager.recordError('architect', { message: 'error2' });
      contextManager.resolveError('architect', err1.id, 'fixed');

      const unresolved = contextManager.getUnresolvedErrors('architect');

      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].message).toBe('error2');
    });
  });

  describe('Collaboration Tracking', () => {
    test('recordInteraction tracks sent message', () => {
      contextManager.recordInteraction('architect', 'analyst', 'sent', 'Please review');

      const context = contextManager.getContext('architect');
      const interaction = context.lastInteractions.analyst;

      expect(interaction.sent).toBe(1);
      expect(interaction.lastDirection).toBe('sent');
      expect(interaction.lastMessage).toBe('Please review');
    });

    test('recordInteraction tracks received message', () => {
      contextManager.recordInteraction('architect', 'analyst', 'received', 'LGTM');

      const context = contextManager.getContext('architect');
      const interaction = context.lastInteractions.analyst;

      expect(interaction.received).toBe(1);
    });

    test('recordInteraction increments counts', () => {
      contextManager.recordInteraction('architect', 'analyst', 'sent', 'msg1');
      contextManager.recordInteraction('architect', 'analyst', 'sent', 'msg2');
      contextManager.recordInteraction('architect', 'analyst', 'received', 'reply');

      const context = contextManager.getContext('architect');
      const interaction = context.lastInteractions.analyst;

      expect(interaction.sent).toBe(2);
      expect(interaction.received).toBe(1);
    });

    test('getCollaborationStats returns all interactions', () => {
      contextManager.recordInteraction('architect', 'analyst', 'sent', 'a');
      contextManager.recordInteraction('architect', 'backend', 'sent', 'b');

      const stats = contextManager.getCollaborationStats('architect');

      expect(stats.analyst).toBeDefined();
      expect(stats['backend']).toBeDefined();
    });
  });

  describe('Context Summary', () => {
    test('getContextSummary returns summary', () => {
      contextManager.startSession('architect');
      contextManager.setCurrentTask('architect', { id: 'task-1' });
      contextManager.recordFileInteraction('architect', '/main.js', 'read');
      contextManager.addLearning('architect', { topic: 'test', content: 'content' });

      const summary = contextManager.getContextSummary('architect');

      expect(summary.role).toBe('architect');
      expect(summary.sessionCount).toBe(1);
      expect(summary.currentTask).toBeDefined();
      expect(summary.expertFileCount).toBeGreaterThanOrEqual(0);
      expect(summary.learningCount).toBe(1);
    });

    test('getContextSummary includes unresolved error count', () => {
      contextManager.recordError('architect', { message: 'err1' });
      contextManager.recordError('architect', { message: 'err2' });

      const summary = contextManager.getContextSummary('architect');

      expect(summary.unresolvedErrors).toBe(2);
    });

    test('getFullContext returns complete context', () => {
      contextManager.startSession('architect');
      contextManager.addLearning('architect', { topic: 'test', content: 'content' });

      const full = contextManager.getFullContext('architect');

      expect(full.version).toBeDefined();
      expect(full.role).toBe('architect');
      expect(full.learnings).toBeDefined();
      expect(full.recentTasks).toBeDefined();
    });
  });
});
