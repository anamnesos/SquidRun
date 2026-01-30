/**
 * Context Manager - Per-agent persistent context
 *
 * Manages agent state, learnings, task history, and cross-session memory.
 * Enables agents to remember what they've worked on and learned.
 */

const memoryStore = require('./memory-store');

// Context schema version for migrations
const CONTEXT_VERSION = 1;

// Maximum items in various arrays
const MAX_RECENT_TASKS = 50;
const MAX_LEARNINGS = 100;
const MAX_FILE_INTERACTIONS = 200;
const MAX_DECISIONS = 100;
const MAX_ERRORS = 50;

/**
 * Default context structure for a new agent
 */
function createDefaultContext(role) {
  return {
    version: CONTEXT_VERSION,
    role,
    created: new Date().toISOString(),
    lastActive: new Date().toISOString(),

    // Session info
    currentSessionId: null,
    sessionCount: 0,
    totalActiveTime: 0, // milliseconds

    // Current state
    currentTask: null,
    currentFile: null,
    currentState: 'idle',

    // Task history
    recentTasks: [], // { task, status, startedAt, completedAt, outcome }
    taskStats: {
      completed: 0,
      failed: 0,
      abandoned: 0
    },

    // File interactions
    recentFiles: [], // { path, action, timestamp }
    fileExpertise: {}, // { path: { readCount, writeCount, lastAccess } }

    // Learnings and knowledge
    learnings: [], // { topic, content, confidence, source, timestamp }
    knownPatterns: [], // { pattern, description, frequency }

    // Decision history
    recentDecisions: [], // { action, rationale, outcome, timestamp }

    // Error tracking
    recentErrors: [], // { message, context, resolution, timestamp }

    // Collaboration
    lastInteractions: {}, // { role: { lastMessage, direction, timestamp } }

    // Custom metadata
    metadata: {}
  };
}

/**
 * Initialize or load context for a role
 * @param {string} role
 * @returns {Object}
 */
function initContext(role) {
  let context = memoryStore.loadContext(role);

  if (!context) {
    context = createDefaultContext(role);
    memoryStore.saveContext(role, context);
  }

  // Migrate if needed
  if (context.version !== CONTEXT_VERSION) {
    context = migrateContext(context);
    memoryStore.saveContext(role, context);
  }

  return context;
}

/**
 * Migrate context from older versions
 * @param {Object} context
 * @returns {Object}
 */
function migrateContext(context) {
  // Future migrations go here
  context.version = CONTEXT_VERSION;
  return context;
}

/**
 * Get context for a pane ID
 * @param {string} paneId
 * @returns {Object}
 */
function getContextForPane(paneId) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  return initContext(role);
}

/**
 * Get context for a role
 * @param {string} role
 * @returns {Object}
 */
function getContext(role) {
  return initContext(role);
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

/**
 * Start a new session for an agent
 * @param {string} role
 * @param {string} [sessionId]
 * @returns {Object} Updated context
 */
function startSession(role, sessionId = null) {
  const context = initContext(role);

  context.currentSessionId = sessionId || `session-${Date.now()}`;
  context.sessionCount += 1;
  context.lastActive = new Date().toISOString();
  context.sessionStartTime = Date.now();

  memoryStore.saveContext(role, context);
  return context;
}

/**
 * End current session for an agent
 * @param {string} role
 * @returns {Object} Updated context
 */
function endSession(role) {
  const context = initContext(role);

  if (context.sessionStartTime) {
    context.totalActiveTime += Date.now() - context.sessionStartTime;
  }

  context.currentSessionId = null;
  context.sessionStartTime = null;
  context.lastActive = new Date().toISOString();

  memoryStore.saveContext(role, context);
  return context;
}

/**
 * Update last active timestamp
 * @param {string} role
 */
function touch(role) {
  const context = initContext(role);
  context.lastActive = new Date().toISOString();
  memoryStore.saveContext(role, context);
}

// ============================================================
// TASK MANAGEMENT
// ============================================================

/**
 * Set current task for an agent
 * @param {string} role
 * @param {Object} task - { id, description, assignedBy, priority }
 * @returns {Object} Updated context
 */
function setCurrentTask(role, task) {
  const context = initContext(role);

  context.currentTask = {
    ...task,
    startedAt: new Date().toISOString()
  };
  context.currentState = 'working';
  context.lastActive = new Date().toISOString();

  memoryStore.saveContext(role, context);
  return context;
}

/**
 * Complete current task
 * @param {string} role
 * @param {string} outcome - 'completed' | 'failed' | 'abandoned' | 'handed_off'
 * @param {Object} [details]
 * @returns {Object} Updated context
 */
function completeTask(role, outcome, details = {}) {
  const context = initContext(role);

  if (context.currentTask) {
    const taskRecord = {
      ...context.currentTask,
      outcome,
      completedAt: new Date().toISOString(),
      duration: Date.now() - new Date(context.currentTask.startedAt).getTime(),
      details
    };

    context.recentTasks.push(taskRecord);
    if (context.recentTasks.length > MAX_RECENT_TASKS) {
      context.recentTasks.shift();
    }

    // Update stats
    if (outcome === 'completed') {
      context.taskStats.completed += 1;
    } else if (outcome === 'failed') {
      context.taskStats.failed += 1;
    } else if (outcome === 'abandoned') {
      context.taskStats.abandoned += 1;
    }
  }

  context.currentTask = null;
  context.currentState = 'idle';
  context.lastActive = new Date().toISOString();

  memoryStore.saveContext(role, context);
  return context;
}

/**
 * Get task history for an agent
 * @param {string} role
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getTaskHistory(role, limit = 10) {
  const context = initContext(role);
  return context.recentTasks.slice(-limit);
}

// ============================================================
// FILE INTERACTION TRACKING
// ============================================================

/**
 * Record a file interaction
 * @param {string} role
 * @param {string} filePath
 * @param {string} action - 'read' | 'write' | 'create' | 'delete'
 */
function recordFileInteraction(role, filePath, action) {
  const context = initContext(role);

  // Add to recent files
  context.recentFiles.push({
    path: filePath,
    action,
    timestamp: new Date().toISOString()
  });
  if (context.recentFiles.length > MAX_FILE_INTERACTIONS) {
    context.recentFiles.shift();
  }

  // Update expertise tracking
  if (!context.fileExpertise[filePath]) {
    context.fileExpertise[filePath] = {
      readCount: 0,
      writeCount: 0,
      firstAccess: new Date().toISOString(),
      lastAccess: new Date().toISOString()
    };
  }

  const expertise = context.fileExpertise[filePath];
  expertise.lastAccess = new Date().toISOString();

  if (action === 'read') {
    expertise.readCount += 1;
  } else if (action === 'write' || action === 'create') {
    expertise.writeCount += 1;
  }

  context.currentFile = filePath;
  context.lastActive = new Date().toISOString();

  memoryStore.saveContext(role, context);
}

/**
 * Get files an agent has expertise in (frequently accessed)
 * @param {string} role
 * @param {number} [minInteractions=3]
 * @returns {Array}
 */
function getExpertFiles(role, minInteractions = 3) {
  const context = initContext(role);
  const expertFiles = [];

  for (const [path, stats] of Object.entries(context.fileExpertise)) {
    const totalInteractions = stats.readCount + stats.writeCount;
    if (totalInteractions >= minInteractions) {
      expertFiles.push({
        path,
        ...stats,
        totalInteractions
      });
    }
  }

  return expertFiles.sort((a, b) => b.totalInteractions - a.totalInteractions);
}

/**
 * Get recent file activity
 * @param {string} role
 * @param {number} [limit=20]
 * @returns {Array}
 */
function getRecentFiles(role, limit = 20) {
  const context = initContext(role);
  return context.recentFiles.slice(-limit);
}

// ============================================================
// LEARNING AND KNOWLEDGE
// ============================================================

/**
 * Record a learning
 * @param {string} role
 * @param {Object} learning - { topic, content, confidence, source }
 */
function addLearning(role, learning) {
  const context = initContext(role);

  const record = {
    id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...learning,
    timestamp: new Date().toISOString()
  };

  context.learnings.push(record);
  if (context.learnings.length > MAX_LEARNINGS) {
    context.learnings.shift();
  }

  context.lastActive = new Date().toISOString();
  memoryStore.saveContext(role, context);

  // Also add to shared memory
  memoryStore.addSharedLearning({
    ...learning,
    agent: role
  });

  return record;
}

/**
 * Get learnings for an agent
 * @param {string} role
 * @param {Object} [filter]
 * @returns {Array}
 */
function getLearnings(role, filter = {}) {
  const context = initContext(role);
  let learnings = context.learnings;

  if (filter.topic) {
    learnings = learnings.filter(l =>
      l.topic && l.topic.toLowerCase().includes(filter.topic.toLowerCase())
    );
  }

  if (filter.minConfidence) {
    learnings = learnings.filter(l => (l.confidence || 0) >= filter.minConfidence);
  }

  if (filter.since) {
    const sinceTime = new Date(filter.since).getTime();
    learnings = learnings.filter(l => new Date(l.timestamp).getTime() > sinceTime);
  }

  return learnings;
}

/**
 * Record a known pattern
 * @param {string} role
 * @param {Object} pattern - { pattern, description, category }
 */
function addPattern(role, pattern) {
  const context = initContext(role);

  // Check if pattern already exists
  const existing = context.knownPatterns.find(p =>
    p.pattern === pattern.pattern
  );

  if (existing) {
    existing.frequency = (existing.frequency || 1) + 1;
    existing.lastSeen = new Date().toISOString();
  } else {
    context.knownPatterns.push({
      ...pattern,
      frequency: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
  }

  memoryStore.saveContext(role, context);
}

// ============================================================
// DECISION TRACKING
// ============================================================

/**
 * Record a decision
 * @param {string} role
 * @param {Object} decision - { action, rationale, alternatives }
 */
function recordDecision(role, decision) {
  const context = initContext(role);

  const record = {
    id: `dec-${Date.now()}`,
    ...decision,
    timestamp: new Date().toISOString()
  };

  context.recentDecisions.push(record);
  if (context.recentDecisions.length > MAX_DECISIONS) {
    context.recentDecisions.shift();
  }

  memoryStore.saveContext(role, context);
  return record;
}

/**
 * Update outcome of a decision
 * @param {string} role
 * @param {string} decisionId
 * @param {string} outcome - 'success' | 'failure' | 'partial'
 * @param {string} [notes]
 */
function updateDecisionOutcome(role, decisionId, outcome, notes = '') {
  const context = initContext(role);

  const decision = context.recentDecisions.find(d => d.id === decisionId);
  if (decision) {
    decision.outcome = outcome;
    decision.outcomeNotes = notes;
    decision.resolvedAt = new Date().toISOString();
    memoryStore.saveContext(role, context);
  }
}

/**
 * Get recent decisions
 * @param {string} role
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getRecentDecisions(role, limit = 10) {
  const context = initContext(role);
  return context.recentDecisions.slice(-limit);
}

// ============================================================
// ERROR TRACKING
// ============================================================

/**
 * Record an error
 * @param {string} role
 * @param {Object} error - { message, context, stack }
 */
function recordError(role, error) {
  const context = initContext(role);

  const record = {
    id: `err-${Date.now()}`,
    ...error,
    timestamp: new Date().toISOString(),
    resolved: false
  };

  context.recentErrors.push(record);
  if (context.recentErrors.length > MAX_ERRORS) {
    context.recentErrors.shift();
  }

  memoryStore.saveContext(role, context);
  return record;
}

/**
 * Mark error as resolved
 * @param {string} role
 * @param {string} errorId
 * @param {string} resolution
 */
function resolveError(role, errorId, resolution) {
  const context = initContext(role);

  const error = context.recentErrors.find(e => e.id === errorId);
  if (error) {
    error.resolved = true;
    error.resolution = resolution;
    error.resolvedAt = new Date().toISOString();
    memoryStore.saveContext(role, context);
  }
}

/**
 * Get unresolved errors
 * @param {string} role
 * @returns {Array}
 */
function getUnresolvedErrors(role) {
  const context = initContext(role);
  return context.recentErrors.filter(e => !e.resolved);
}

// ============================================================
// COLLABORATION TRACKING
// ============================================================

/**
 * Record an interaction with another agent
 * @param {string} role
 * @param {string} otherRole
 * @param {string} direction - 'sent' | 'received'
 * @param {string} [summary]
 */
function recordInteraction(role, otherRole, direction, summary = '') {
  const context = initContext(role);

  if (!context.lastInteractions[otherRole]) {
    context.lastInteractions[otherRole] = {
      sent: 0,
      received: 0,
      firstInteraction: new Date().toISOString()
    };
  }

  const interaction = context.lastInteractions[otherRole];
  interaction[direction] = (interaction[direction] || 0) + 1;
  interaction.lastMessage = summary;
  interaction.lastDirection = direction;
  interaction.lastTimestamp = new Date().toISOString();

  memoryStore.saveContext(role, context);
}

/**
 * Get collaboration stats
 * @param {string} role
 * @returns {Object}
 */
function getCollaborationStats(role) {
  const context = initContext(role);
  return context.lastInteractions;
}

// ============================================================
// CONTEXT SUMMARY
// ============================================================

/**
 * Get a summary of agent context for injection
 * @param {string} role
 * @returns {Object}
 */
function getContextSummary(role) {
  const context = initContext(role);

  return {
    role,
    sessionCount: context.sessionCount,
    lastActive: context.lastActive,
    currentTask: context.currentTask,
    taskStats: context.taskStats,
    recentTaskCount: context.recentTasks.length,
    expertFileCount: Object.keys(context.fileExpertise).length,
    learningCount: context.learnings.length,
    unresolvedErrors: context.recentErrors.filter(e => !e.resolved).length,
    topExpertFiles: getExpertFiles(role, 5).slice(0, 5).map(f => f.path)
  };
}

/**
 * Get full context dump for debugging
 * @param {string} role
 * @returns {Object}
 */
function getFullContext(role) {
  return initContext(role);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Initialization
  initContext,
  getContext,
  getContextForPane,

  // Session
  startSession,
  endSession,
  touch,

  // Tasks
  setCurrentTask,
  completeTask,
  getTaskHistory,

  // Files
  recordFileInteraction,
  getExpertFiles,
  getRecentFiles,

  // Learning
  addLearning,
  getLearnings,
  addPattern,

  // Decisions
  recordDecision,
  updateDecisionOutcome,
  getRecentDecisions,

  // Errors
  recordError,
  resolveError,
  getUnresolvedErrors,

  // Collaboration
  recordInteraction,
  getCollaborationStats,

  // Summary
  getContextSummary,
  getFullContext
};
