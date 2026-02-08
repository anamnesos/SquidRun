/**
 * Agent Memory System - Main Entry Point
 *
 * Comprehensive memory system for Hivemind agents.
 * Provides conversation persistence, context management,
 * search capabilities, and intelligent summarization.
 *
 * Usage:
 *   const memory = require('./modules/memory');
 *   memory.logInput('1', 'User message');
 *   memory.getRecentTranscript('1', 50);
 */

const path = require('path');
const memoryStore = require('./memory-store');
const transcriptLogger = require('./transcript-logger');
const contextManager = require('./context-manager');
const memorySearch = require('./memory-search');
const memorySummarizer = require('./memory-summarizer');
const knowledgeGraph = require('./knowledge-graph');
const { extractLearnings } = require('./learning-extractor');
const KnowledgeBase = require('../knowledge-base');
const { createLocalEmbedder } = require('../local-embedder');

// ============================================================
// INITIALIZATION
// ============================================================

let initialized = false;
let knowledgeBase = null;
let knowledgeEmbedder = null;

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../workspace');
const KNOWLEDGE_ROOT = path.join(WORKSPACE_ROOT, 'knowledge');

function getKnowledgeBase() {
  if (!knowledgeEmbedder) {
    knowledgeEmbedder = createLocalEmbedder();
  }
  if (!knowledgeBase) {
    knowledgeBase = new KnowledgeBase(KNOWLEDGE_ROOT, { embedder: knowledgeEmbedder });
  }
  return knowledgeBase;
}

/**
 * Initialize the memory system
 * Creates directories, loads indices, ensures clean state
 */
function initialize() {
  if (initialized) return;

  try {
    // Ensure all directories exist
    memoryStore.ensureDirectories();

    // Initialize knowledge graph with workspace root
    const path = require('path');
    const workspaceRoot = path.resolve(__dirname, '../../../workspace');
    knowledgeGraph.initialize(workspaceRoot);

    // Log initialization
    console.log('[Memory] Agent memory system initialized');
    console.log(`[Memory] Storage root: ${memoryStore.MEMORY_ROOT}`);

    initialized = true;
  } catch (err) {
    console.error('[Memory] Initialization failed:', err.message);
  }
}

/**
 * Shutdown the memory system
 * Flushes buffers, saves state
 */
function shutdown() {
  try {
    // Shutdown logger and clear timers
    transcriptLogger.shutdown();

    // End all active sessions
    for (const role of Object.values(memoryStore.PANE_ROLES)) {
      contextManager.endSession(role);
    }

    console.log('[Memory] Memory system shutdown complete');
  } catch (err) {
    console.error('[Memory] Shutdown error:', err.message);
  }
}

// ============================================================
// CONVENIENCE API
// ============================================================

/**
 * Log an input message for a pane
 * @param {string} paneId
 * @param {string} content
 * @param {Object} [metadata]
 */
function logInput(paneId, content, metadata = {}) {
  initialize();
  transcriptLogger.logInput(paneId, content, metadata);
  autoExtractLearnings(paneId, content, metadata, 'input');
}

/**
 * Log an output message for a pane
 * @param {string} paneId
 * @param {string} content
 * @param {Object} [metadata]
 */
function logOutput(paneId, content, metadata = {}) {
  initialize();
  transcriptLogger.logOutput(paneId, content, metadata);
  autoExtractLearnings(paneId, content, metadata, 'output');
}

/**
 * Auto-extract learnings from conversation text
 * @param {string} paneId
 * @param {string} content
 * @param {Object} metadata
 * @param {string} direction - input/output
 */
function autoExtractLearnings(paneId, content, metadata = {}, direction = 'output') {
  if (!content || typeof content !== 'string') return;

  const role = memoryStore.getRoleFromPaneId(paneId);
  const source = {
    paneId: String(paneId),
    role,
    direction,
    origin: 'auto-extract',
    messageId: metadata?.messageId || metadata?.id || null,
    timestamp: new Date().toISOString()
  };

  const learnings = extractLearnings(content, { sourceHint: direction });
  if (!learnings.length) return;

  for (const learning of learnings) {
    recordLearning(
      paneId,
      learning.topic || learning.category,
      learning.content,
      learning.confidence,
      {
        category: learning.category,
        pattern: learning.pattern,
        source
      }
    );
  }
}

/**
 * Log a tool invocation
 * @param {string} paneId
 * @param {string} toolName
 * @param {Object} [params]
 */
function logToolUse(paneId, toolName, params = {}) {
  initialize();
  transcriptLogger.logToolUse(paneId, toolName, params);
}

/**
 * Log a decision
 * @param {string} paneId
 * @param {string} action
 * @param {string} [rationale]
 */
function logDecision(paneId, action, rationale = '') {
  initialize();
  transcriptLogger.logDecision(paneId, action, rationale);
  contextManager.recordDecision(memoryStore.getRoleFromPaneId(paneId), { action, rationale });

  // Record in knowledge graph
  const role = memoryStore.getRoleFromPaneId(paneId);
  knowledgeGraph.recordDecision(role, action, { rationale });
}

/**
 * Log an error
 * @param {string} paneId
 * @param {string} message
 * @param {Error} [error]
 */
function logError(paneId, message, error = null) {
  initialize();
  transcriptLogger.logError(paneId, message, error);
  contextManager.recordError(memoryStore.getRoleFromPaneId(paneId), {
    message,
    stack: error?.stack
  });

  // Record in knowledge graph
  const role = memoryStore.getRoleFromPaneId(paneId);
  knowledgeGraph.recordError(role, message, { stack: error?.stack });
}

/**
 * Record a learning
 * @param {string} paneId
 * @param {string} topic
 * @param {string} content
 * @param {number} [confidence=0.8]
 */
function recordLearning(paneId, topic, content, confidence = 0.8, metadata = {}) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  const learning = {
    topic,
    content,
    confidence,
    category: metadata?.category,
    pattern: metadata?.pattern,
    source: metadata?.source
  };
  const record = contextManager.addLearning(role, learning);

  try {
    const kb = getKnowledgeBase();
    const docId = `learning:${record.id}`;
    const text = [
      `Category: ${learning.category || topic || 'learning'}`,
      `Agent: ${role}`,
      `Content: ${content}`
    ].join('\n');
    kb.ingestDocument(docId, text, {
      type: 'learning',
      topic: topic || 'learning',
      category: learning.category,
      agent: role,
      paneId: String(paneId),
      learningId: record.id,
      timestamp: record.timestamp,
      source: learning.source || null
    }).catch(() => {});
  } catch {
    // Ignore KB ingestion failures
  }

  return record;
}

/**
 * Record a file interaction
 * @param {string} paneId
 * @param {string} filePath
 * @param {string} action - 'read' | 'write' | 'create' | 'delete'
 */
function recordFileAccess(paneId, filePath, action) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  contextManager.recordFileInteraction(role, filePath, action);

  // Record in knowledge graph
  knowledgeGraph.recordFileAccess(role, filePath, action);
}

/**
 * Get recent transcript entries for a pane
 * @param {string} paneId
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getRecentTranscript(paneId, limit = 50) {
  initialize();
  return transcriptLogger.getRecentTranscript(paneId, limit);
}

/**
 * Get context summary for a pane
 * @param {string} paneId
 * @returns {Object}
 */
function getContextSummary(paneId) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return contextManager.getContextSummary(role);
}

/**
 * Search memory for a query
 * @param {string} query
 * @param {Object} [options]
 * @returns {Object}
 */
function search(query, options = {}) {
  initialize();
  return memorySearch.searchAll(query, options);
}

/**
 * Get summary for a pane
 * @param {string} paneId
 * @returns {Object}
 */
function getSummary(paneId) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return memorySummarizer.generateSessionSummary(role);
}

/**
 * Get context injection string for prompts
 * @param {string} paneId
 * @param {Object} [options]
 * @returns {string}
 */
function getContextInjection(paneId, options = {}) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  if (options?.optimize || options?.maxTokens) {
    return memorySummarizer.generateOptimizedContextInjection(role, options);
  }
  return memorySummarizer.generateContextInjection(role, options);
}

/**
 * Analyze context window usage and pruning recommendations
 * @param {string} paneId
 * @param {Object} [options]
 * @returns {Object}
 */
function getContextOptimization(paneId, options = {}) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return memorySummarizer.analyzeContextWindow(role, options);
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

/**
 * Start a new session for a pane
 * @param {string} paneId
 * @param {string} [sessionId]
 */
function startSession(paneId, sessionId = null) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  transcriptLogger.startSession(paneId);
  contextManager.startSession(role, sessionId);
}

/**
 * End session for a pane
 * @param {string} paneId
 */
function endSession(paneId) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  transcriptLogger.endSession(paneId);
  contextManager.endSession(role);
}

/**
 * Set current task for a pane
 * @param {string} paneId
 * @param {Object} task
 */
function setCurrentTask(paneId, task) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  contextManager.setCurrentTask(role, task);

  // Record task in knowledge graph
  if (task && task.name) {
    knowledgeGraph.recordTask(task.name, role, task.description || '');
  }
}

/**
 * Complete current task for a pane
 * @param {string} paneId
 * @param {string} outcome
 * @param {Object} [details]
 */
function completeTask(paneId, outcome, details = {}) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  contextManager.completeTask(role, outcome, details);
}

// ============================================================
// TRIGGER INTEGRATION
// ============================================================

/**
 * Log a trigger message between agents
 * @param {string} sourcePaneId
 * @param {string} targetPaneId
 * @param {string} content
 */
function logTriggerMessage(sourcePaneId, targetPaneId, content) {
  initialize();
  transcriptLogger.logTriggerMessage(sourcePaneId, targetPaneId, content);

  // Record interaction in context
  const sourceRole = memoryStore.getRoleFromPaneId(sourcePaneId);
  const targetRole = memoryStore.getRoleFromPaneId(targetPaneId);

  if (sourceRole && targetRole) {
    contextManager.recordInteraction(sourceRole, targetRole, 'sent', content.slice(0, 100));
    contextManager.recordInteraction(targetRole, sourceRole, 'received', content.slice(0, 100));

    // Record message in knowledge graph with agent relationship
    const msgNodeId = knowledgeGraph.addNode(knowledgeGraph.NODE_TYPES.MESSAGE, content.slice(0, 100), {
      from: sourceRole,
      to: targetRole,
      fullContent: content.length > 100 ? content : undefined
    });
    knowledgeGraph.addEdge(msgNodeId, knowledgeGraph.getAgentNodeId(sourceRole), knowledgeGraph.EDGE_TYPES.INVOLVES);
    knowledgeGraph.addEdge(msgNodeId, knowledgeGraph.getAgentNodeId(targetRole), knowledgeGraph.EDGE_TYPES.INVOLVES);
  }
}

// ============================================================
// CODEX INTEGRATION
// ============================================================

/**
 * Log a Codex exec event
 * @param {string} paneId
 * @param {Object} event
 */
function logCodexEvent(paneId, event) {
  initialize();
  transcriptLogger.logCodexEvent(paneId, event);
}

// ============================================================
// TEAM-LEVEL OPERATIONS
// ============================================================

/**
 * Get team-wide summary
 * @returns {Object}
 */
function getTeamSummary() {
  initialize();
  return memorySummarizer.generateTeamSummary();
}

/**
 * Get shared learnings across all agents
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getSharedLearnings(limit = 50) {
  initialize();
  const memory = memoryStore.loadSharedMemory();
  return (memory.learnings || []).slice(-limit);
}

/**
 * Get shared decisions across all agents
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getSharedDecisions(limit = 50) {
  initialize();
  const memory = memoryStore.loadSharedMemory();
  return (memory.decisions || []).slice(-limit);
}

/**
 * Search across all agents
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array}
 */
function searchAllAgents(query, options = {}) {
  initialize();
  return memorySearch.searchAllTranscripts(query, options);
}

// ============================================================
// ANALYTICS
// ============================================================

/**
 * Get transcript stats for a pane
 * @param {string} paneId
 * @returns {Object}
 */
function getTranscriptStats(paneId) {
  initialize();
  return transcriptLogger.getTranscriptStats(paneId);
}

/**
 * Get task history for a pane
 * @param {string} paneId
 * @param {number} [limit=10]
 * @returns {Array}
 */
function getTaskHistory(paneId, limit = 10) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return contextManager.getTaskHistory(role, limit);
}

/**
 * Get collaboration stats for a pane
 * @param {string} paneId
 * @returns {Object}
 */
function getCollaborationStats(paneId) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return contextManager.getCollaborationStats(role);
}

/**
 * Get expert files for a pane
 * @param {string} paneId
 * @param {number} [minInteractions=3]
 * @returns {Array}
 */
function getExpertFiles(paneId, minInteractions = 3) {
  initialize();
  const role = memoryStore.getRoleFromPaneId(paneId);
  return contextManager.getExpertFiles(role, minInteractions);
}

/**
 * Analyze tool usage patterns
 * @param {string} [toolName]
 * @param {Object} [options]
 * @returns {Object}
 */
function analyzeToolUsage(toolName = null, options = {}) {
  initialize();
  return memorySearch.analyzeToolUsage(toolName, options);
}

// ============================================================
// KNOWLEDGE GRAPH API
// ============================================================

/**
 * Query the knowledge graph
 * @param {string} queryStr - Natural language or structured query
 * @param {Object} [options]
 * @returns {Object} - Query results with nodes, edges, visualization data
 */
function queryGraph(queryStr, options = {}) {
  initialize();
  return knowledgeGraph.query(queryStr, options);
}

/**
 * Get knowledge graph data for visualization
 * @param {Object} [filter] - Optional filter criteria
 * @returns {Object} - Nodes and edges formatted for visualization
 */
function getGraphVisualization(filter = {}) {
  initialize();
  return knowledgeGraph.exportForVisualization(filter);
}

/**
 * Record a concept in the knowledge graph
 * @param {string} name - Concept name
 * @param {string} description - Description
 * @param {Array} [relatedTo] - Related concept names
 */
function recordConcept(name, description = '', relatedTo = []) {
  initialize();

  // Create the concept node
  const conceptId = knowledgeGraph.recordConcept(name, null, { description });

  // Link to related concepts
  if (relatedTo && relatedTo.length > 0) {
    for (const relatedName of relatedTo) {
      const relatedId = knowledgeGraph.recordConcept(relatedName, null, {});
      knowledgeGraph.addEdge(conceptId, relatedId, knowledgeGraph.EDGE_TYPES.RELATES_TO);
    }
  }

  return conceptId;
}

/**
 * Get related nodes from the knowledge graph
 * @param {string} nodeId - Starting node ID
 * @param {number} [depth=2] - How many hops to traverse
 * @returns {Object} - Related nodes and edges
 */
function getRelatedNodes(nodeId, depth = 2) {
  initialize();
  return knowledgeGraph.getRelated(nodeId, depth);
}

/**
 * Get knowledge graph statistics
 * @returns {Object} - Stats about nodes, edges, types
 */
function getGraphStats() {
  initialize();
  return knowledgeGraph.getStats();
}

/**
 * Save knowledge graph to disk
 */
function saveGraph() {
  initialize();
  return knowledgeGraph.save();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Initialization
  initialize,
  shutdown,

  // Logging
  logInput,
  logOutput,
  logToolUse,
  logDecision,
  logError,
  logTriggerMessage,
  logCodexEvent,

  // Context
  recordLearning,
  recordFileAccess,
  getContextSummary,
  getContextInjection,
  getContextOptimization,

  // Session
  startSession,
  endSession,
  setCurrentTask,
  completeTask,

  // Query
  getRecentTranscript,
  getSummary,
  search,
  searchAllAgents,

  // Team
  getTeamSummary,
  getSharedLearnings,
  getSharedDecisions,

  // Analytics
  getTranscriptStats,
  getTaskHistory,
  getCollaborationStats,
  getExpertFiles,
  analyzeToolUsage,

  // Knowledge Graph
  queryGraph,
  getGraphVisualization,
  recordConcept,
  getRelatedNodes,
  getGraphStats,
  saveGraph,

  // Sub-modules (for advanced use)
  store: memoryStore,
  transcript: transcriptLogger,
  context: contextManager,
  searchModule: memorySearch,
  summarizer: memorySummarizer,
  graph: knowledgeGraph
};
