/**
 * Memory Store - Core persistence layer for agent memory system
 *
 * Handles reading/writing conversation transcripts, context, and indices.
 * Provides atomic file operations with proper error handling.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

// Base paths for memory storage
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../workspace');
const MEMORY_ROOT = path.join(WORKSPACE_ROOT, 'memory');
const TRANSCRIPTS_DIR = path.join(MEMORY_ROOT, 'transcripts');
const CONTEXT_DIR = path.join(MEMORY_ROOT, 'context');
const SUMMARIES_DIR = path.join(MEMORY_ROOT, 'summaries');
const INDEX_DIR = path.join(MEMORY_ROOT, 'index');

// Pane ID to role mapping - initialized from canonical source
const PANE_ROLES = { ...config.PANE_ROLES };

// Role to pane ID reverse mapping
const ROLE_PANES = Object.fromEntries(
  Object.entries(PANE_ROLES).map(([k, v]) => [v.toLowerCase(), k])
);

/**
 * Ensure all memory directories exist
 */
function ensureDirectories() {
  const dirs = [MEMORY_ROOT, TRANSCRIPTS_DIR, CONTEXT_DIR, SUMMARIES_DIR, INDEX_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  // Create per-role context directories
  for (const roleId of config.ROLE_NAMES) {
    const roleDir = path.join(CONTEXT_DIR, roleId);
    if (!fs.existsSync(roleDir)) {
      fs.mkdirSync(roleDir, { recursive: true });
    }
  }
}

/**
 * Get role name from pane ID
 * @param {string} paneId
 * @returns {string}
 */
function getRoleFromPaneId(paneId) {
  return PANE_ROLES[String(paneId)] || `pane-${paneId}`;
}

/**
 * Get pane ID from role name
 * @param {string} role
 * @returns {string|null}
 */
function getPaneIdFromRole(role) {
  return ROLE_PANES[role.toLowerCase()] || null;
}

/**
 * Get today's date string for file naming
 * @returns {string} YYYY-MM-DD
 */
function getDateString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get transcript file path for a role and date
 * @param {string} role
 * @param {string} [date] - Optional date string, defaults to today
 * @returns {string}
 */
function getTranscriptPath(role, date = null) {
  const dateStr = date || getDateString();
  return path.join(TRANSCRIPTS_DIR, `${role}-${dateStr}.jsonl`);
}

/**
 * Get context file path for a role
 * @param {string} role
 * @param {string} [type='current'] - 'current' or 'history'
 * @returns {string}
 */
function getContextPath(role, type = 'current') {
  return path.join(CONTEXT_DIR, role, `${type}.json`);
}

/**
 * Get summary file path for a role
 * @param {string} role
 * @returns {string}
 */
function getSummaryPath(role) {
  return path.join(SUMMARIES_DIR, `${role}-summary.json`);
}

/**
 * Get keyword index path
 * @returns {string}
 */
function getKeywordIndexPath() {
  return path.join(INDEX_DIR, 'keywords.json');
}

// ============================================================
// TRANSCRIPT OPERATIONS
// ============================================================

/**
 * Append a transcript entry (JSONL format)
 * @param {string} role
 * @param {Object} entry - Transcript entry object
 */
function appendTranscript(role, entry) {
  ensureDirectories();
  const filePath = getTranscriptPath(role);
  const line = JSON.stringify({
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString()
  }) + '\n';

  try {
    fs.appendFileSync(filePath, line, 'utf8');
    return true;
  } catch (err) {
    console.error(`[MemoryStore] Error appending transcript for ${role}:`, err.message);
    return false;
  }
}

/**
 * Read transcript entries for a role
 * @param {string} role
 * @param {Object} [options]
 * @param {string} [options.date] - Specific date, defaults to today
 * @param {number} [options.limit] - Max entries to return (from end)
 * @param {string} [options.since] - ISO timestamp to filter entries after
 * @returns {Array<Object>}
 */
function readTranscript(role, options = {}) {
  const { date, limit, since } = options;
  const filePath = getTranscriptPath(role, date);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let entries = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Filter by timestamp if specified
    if (since) {
      const sinceTime = new Date(since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() > sinceTime);
    }

    // Apply limit (from end)
    if (limit && entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return entries;
  } catch (err) {
    console.error(`[MemoryStore] Error reading transcript for ${role}:`, err.message);
    return [];
  }
}

/**
 * List available transcript dates for a role
 * @param {string} role
 * @returns {Array<string>} Array of date strings
 */
function listTranscriptDates(role) {
  ensureDirectories();
  try {
    const files = fs.readdirSync(TRANSCRIPTS_DIR);
    const prefix = `${role}-`;
    return files
      .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .map(f => f.slice(prefix.length, -6)) // Remove prefix and .jsonl
      .sort()
      .reverse(); // Most recent first
  } catch (err) {
    console.error(`[MemoryStore] Error listing transcripts for ${role}:`, err.message);
    return [];
  }
}

/**
 * Get transcript stats for a role
 * @param {string} role
 * @param {string} [date]
 * @returns {Object}
 */
function getTranscriptStats(role, date = null) {
  const entries = readTranscript(role, { date });
  const inputCount = entries.filter(e => e.type === 'input').length;
  const outputCount = entries.filter(e => e.type === 'output').length;
  const totalTokens = entries.reduce((sum, e) => sum + (e.metadata?.tokens || 0), 0);

  return {
    role,
    date: date || getDateString(),
    totalEntries: entries.length,
    inputCount,
    outputCount,
    totalTokens,
    firstEntry: entries[0]?.timestamp || null,
    lastEntry: entries[entries.length - 1]?.timestamp || null
  };
}

// ============================================================
// CONTEXT OPERATIONS
// ============================================================

/**
 * Save agent context
 * @param {string} role
 * @param {Object} context
 * @param {string} [type='current']
 */
function saveContext(role, context, type = 'current') {
  ensureDirectories();
  const filePath = getContextPath(role, type);

  try {
    const data = {
      ...context,
      role,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[MemoryStore] Error saving context for ${role}:`, err.message);
    return false;
  }
}

/**
 * Load agent context
 * @param {string} role
 * @param {string} [type='current']
 * @returns {Object|null}
 */
function loadContext(role, type = 'current') {
  const filePath = getContextPath(role, type);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[MemoryStore] Error loading context for ${role}:`, err.message);
    return null;
  }
}

/**
 * Merge new data into existing context
 * @param {string} role
 * @param {Object} updates
 * @param {string} [type='current']
 */
function mergeContext(role, updates, type = 'current') {
  const existing = loadContext(role, type) || {};
  const merged = { ...existing, ...updates };
  return saveContext(role, merged, type);
}

/**
 * Add to context history array (with dedup and limit)
 * @param {string} role
 * @param {string} key - Array key in context
 * @param {*} item - Item to add
 * @param {number} [maxItems=100]
 */
function pushToContextArray(role, key, item, maxItems = 100) {
  const context = loadContext(role) || {};
  const arr = context[key] || [];

  // Add item with timestamp
  const entry = typeof item === 'object'
    ? { ...item, addedAt: new Date().toISOString() }
    : { value: item, addedAt: new Date().toISOString() };

  arr.push(entry);

  // Trim to max size
  if (arr.length > maxItems) {
    arr.splice(0, arr.length - maxItems);
  }

  context[key] = arr;
  return saveContext(role, context);
}

// ============================================================
// SUMMARY OPERATIONS
// ============================================================

/**
 * Save summary for a role
 * @param {string} role
 * @param {Object} summary
 */
function saveSummary(role, summary) {
  ensureDirectories();
  const filePath = getSummaryPath(role);

  try {
    const data = {
      ...summary,
      role,
      generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[MemoryStore] Error saving summary for ${role}:`, err.message);
    return false;
  }
}

/**
 * Load summary for a role
 * @param {string} role
 * @returns {Object|null}
 */
function loadSummary(role) {
  const filePath = getSummaryPath(role);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[MemoryStore] Error loading summary for ${role}:`, err.message);
    return null;
  }
}

// ============================================================
// INDEX OPERATIONS
// ============================================================

/**
 * Load keyword index
 * @returns {Object}
 */
function loadKeywordIndex() {
  const filePath = getKeywordIndexPath();

  if (!fs.existsSync(filePath)) {
    return { keywords: {}, lastUpdated: null };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[MemoryStore] Error loading keyword index:`, err.message);
    return { keywords: {}, lastUpdated: null };
  }
}

/**
 * Save keyword index
 * @param {Object} index
 */
function saveKeywordIndex(index) {
  ensureDirectories();
  const filePath = getKeywordIndexPath();

  try {
    const data = {
      ...index,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[MemoryStore] Error saving keyword index:`, err.message);
    return false;
  }
}

/**
 * Add keywords to index
 * @param {Array<string>} keywords
 * @param {Object} reference - { role, date, entryIndex }
 */
function indexKeywords(keywords, reference) {
  const index = loadKeywordIndex();

  for (const keyword of keywords) {
    const key = keyword.toLowerCase();
    if (!index.keywords[key]) {
      index.keywords[key] = [];
    }
    index.keywords[key].push({
      ...reference,
      indexedAt: new Date().toISOString()
    });

    // Limit references per keyword
    if (index.keywords[key].length > 1000) {
      index.keywords[key] = index.keywords[key].slice(-1000);
    }
  }

  return saveKeywordIndex(index);
}

// ============================================================
// SHARED MEMORY OPERATIONS
// ============================================================

const SHARED_MEMORY_PATH = path.join(MEMORY_ROOT, 'shared.json');

/**
 * Load shared cross-agent memory
 * @returns {Object}
 */
function loadSharedMemory() {
  if (!fs.existsSync(SHARED_MEMORY_PATH)) {
    return { learnings: [], decisions: [], lastUpdated: null };
  }

  try {
    const content = fs.readFileSync(SHARED_MEMORY_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[MemoryStore] Error loading shared memory:`, err.message);
    return { learnings: [], decisions: [], lastUpdated: null };
  }
}

/**
 * Save shared cross-agent memory
 * @param {Object} memory
 */
function saveSharedMemory(memory) {
  ensureDirectories();

  try {
    const data = {
      ...memory,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(SHARED_MEMORY_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[MemoryStore] Error saving shared memory:`, err.message);
    return false;
  }
}

/**
 * Add a learning to shared memory
 * @param {Object} learning - { topic, content, source, confidence }
 */
function addSharedLearning(learning) {
  const memory = loadSharedMemory();
  memory.learnings = memory.learnings || [];

  memory.learnings.push({
    ...learning,
    id: `learn-${Date.now()}`,
    addedAt: new Date().toISOString()
  });

  // Keep max 500 learnings
  if (memory.learnings.length > 500) {
    memory.learnings = memory.learnings.slice(-500);
  }

  return saveSharedMemory(memory);
}

/**
 * Add a decision record to shared memory
 * @param {Object} decision - { action, rationale, outcome, agent }
 */
function addSharedDecision(decision) {
  const memory = loadSharedMemory();
  memory.decisions = memory.decisions || [];

  memory.decisions.push({
    ...decision,
    id: `dec-${Date.now()}`,
    recordedAt: new Date().toISOString()
  });

  // Keep max 500 decisions
  if (memory.decisions.length > 500) {
    memory.decisions = memory.decisions.slice(-500);
  }

  return saveSharedMemory(memory);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Constants
  MEMORY_ROOT,
  TRANSCRIPTS_DIR,
  CONTEXT_DIR,
  SUMMARIES_DIR,
  INDEX_DIR,
  PANE_ROLES,
  ROLE_PANES,

  // Utilities
  ensureDirectories,
  getRoleFromPaneId,
  getPaneIdFromRole,
  getDateString,

  // Transcript operations
  appendTranscript,
  readTranscript,
  listTranscriptDates,
  getTranscriptStats,

  // Context operations
  saveContext,
  loadContext,
  mergeContext,
  pushToContextArray,

  // Summary operations
  saveSummary,
  loadSummary,

  // Index operations
  loadKeywordIndex,
  saveKeywordIndex,
  indexKeywords,

  // Shared memory
  loadSharedMemory,
  saveSharedMemory,
  addSharedLearning,
  addSharedDecision
};
