/**
 * Memory Search - Search and query across agent memory
 *
 * Provides keyword search, filtered queries, and cross-agent search
 * capabilities across transcripts, context, and shared memory.
 */

const memoryStore = require('./memory-store');
const path = require('path');
const fs = require('fs');

// Search result limits
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Keyword extraction settings
const MIN_KEYWORD_LENGTH = 3;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'can', 'will', 'just', 'should', 'now', 'also', 'like', 'well', 'back',
  'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did',
  'doing', 'would', 'could', 'might', 'must', 'shall', 'may', 'this',
  'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'your',
  'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'you', 'yours', 'yourself', 'yourselves', 'was', 'were', 'are', 'is',
  'be', 'am', 'yes', 'yeah', 'let', 'get', 'got', 'use', 'using', 'used'
]);

/**
 * Search result structure
 */
class SearchResult {
  constructor(type, data, score, source) {
    this.type = type; // 'transcript', 'context', 'learning', 'decision', 'shared'
    this.data = data;
    this.score = score;
    this.source = source; // { role, date, entryIndex }
    this.timestamp = data.timestamp || data.addedAt || null;
  }
}

// ============================================================
// KEYWORD EXTRACTION
// ============================================================

/**
 * Extract keywords from text
 * @param {string} text
 * @returns {Array<string>}
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];

  // Normalize and split
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= MIN_KEYWORD_LENGTH)
    .filter(w => !STOP_WORDS.has(w));

  // Count frequency
  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  // Return unique keywords sorted by frequency
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

/**
 * Extract keywords from transcript entry
 * @param {Object} entry
 * @returns {Array<string>}
 */
function extractEntryKeywords(entry) {
  const keywords = [];

  if (entry.content) {
    keywords.push(...extractKeywords(entry.content));
  }

  if (entry.metadata) {
    if (entry.metadata.toolName) {
      keywords.push(entry.metadata.toolName.toLowerCase());
    }
    if (entry.metadata.rationale) {
      keywords.push(...extractKeywords(entry.metadata.rationale));
    }
  }

  return [...new Set(keywords)];
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Search transcripts for a role
 * @param {string} role
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function searchRoleTranscripts(role, query, options = {}) {
  const {
    limit = DEFAULT_LIMIT,
    types = null, // Filter by entry types
    date = null, // Specific date or null for all
    since = null, // ISO timestamp
    caseSensitive = false
  } = options;

  const results = [];
  const queryLower = caseSensitive ? query : query.toLowerCase();
  const queryWords = extractKeywords(query);

  // Get dates to search
  let dates;
  if (date) {
    dates = [date];
  } else {
    dates = memoryStore.listTranscriptDates(role);
  }

  for (const d of dates) {
    const entries = memoryStore.readTranscript(role, { date: d, since });
    let entryIndex = 0;

    for (const entry of entries) {
      // Type filter
      if (types && !types.includes(entry.type)) {
        entryIndex++;
        continue;
      }

      // Calculate relevance score
      const score = calculateRelevance(entry, queryLower, queryWords, caseSensitive);

      if (score > 0) {
        results.push(new SearchResult(
          'transcript',
          entry,
          score,
          { role, date: d, entryIndex }
        ));
      }

      entryIndex++;
    }
  }

  // Sort by score (descending) then by timestamp (descending)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.timestamp && b.timestamp) {
      return new Date(b.timestamp) - new Date(a.timestamp);
    }
    return 0;
  });

  return results.slice(0, Math.min(limit, MAX_LIMIT));
}

/**
 * Search transcripts across all agents
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function searchAllTranscripts(query, options = {}) {
  const { limit = DEFAULT_LIMIT, roles = null } = options;
  const allResults = [];

  const rolesToSearch = roles || Object.values(memoryStore.PANE_ROLES);

  for (const role of rolesToSearch) {
    const roleResults = searchRoleTranscripts(role, query, {
      ...options,
      limit: MAX_LIMIT // Get more from each role, then combine
    });
    allResults.push(...roleResults);
  }

  // Re-sort combined results
  allResults.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.timestamp && b.timestamp) {
      return new Date(b.timestamp) - new Date(a.timestamp);
    }
    return 0;
  });

  return allResults.slice(0, Math.min(limit, MAX_LIMIT));
}

/**
 * Calculate relevance score for an entry
 * @param {Object} entry
 * @param {string} queryLower
 * @param {Array<string>} queryWords
 * @param {boolean} caseSensitive
 * @returns {number}
 */
function calculateRelevance(entry, queryLower, queryWords, caseSensitive) {
  let score = 0;
  const content = caseSensitive ? entry.content : (entry.content || '').toLowerCase();

  // Exact phrase match (highest score)
  if (content.includes(queryLower)) {
    score += 10;

    // Bonus for exact match at start
    if (content.startsWith(queryLower)) {
      score += 5;
    }
  }

  // Individual word matches
  for (const word of queryWords) {
    if (content.includes(word)) {
      score += 2;
    }
  }

  // Metadata matches
  if (entry.metadata) {
    const metaStr = JSON.stringify(entry.metadata).toLowerCase();
    if (metaStr.includes(queryLower)) {
      score += 3;
    }
  }

  // Type bonus for certain queries
  if (queryLower.includes('error') && entry.type === 'error') {
    score += 5;
  }
  if (queryLower.includes('tool') && entry.type === 'tool_use') {
    score += 5;
  }
  if (queryLower.includes('decision') && entry.type === 'decision') {
    score += 5;
  }

  return score;
}

// ============================================================
// CONTEXT SEARCH
// ============================================================

/**
 * Search agent context (learnings, decisions, files)
 * @param {string} role
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function searchContext(role, query, options = {}) {
  const { limit = DEFAULT_LIMIT, sections = null } = options;
  const results = [];
  const queryLower = query.toLowerCase();
  const context = memoryStore.loadContext(role);

  if (!context) return results;

  // Search learnings
  if (!sections || sections.includes('learnings')) {
    for (const learning of (context.learnings || [])) {
      const score = scoreContextItem(learning, queryLower, ['topic', 'content']);
      if (score > 0) {
        results.push(new SearchResult(
          'learning',
          learning,
          score,
          { role, section: 'learnings' }
        ));
      }
    }
  }

  // Search decisions
  if (!sections || sections.includes('decisions')) {
    for (const decision of (context.recentDecisions || [])) {
      const score = scoreContextItem(decision, queryLower, ['action', 'rationale', 'outcome']);
      if (score > 0) {
        results.push(new SearchResult(
          'decision',
          decision,
          score,
          { role, section: 'decisions' }
        ));
      }
    }
  }

  // Search tasks
  if (!sections || sections.includes('tasks')) {
    for (const task of (context.recentTasks || [])) {
      const score = scoreContextItem(task, queryLower, ['task', 'description', 'outcome']);
      if (score > 0) {
        results.push(new SearchResult(
          'task',
          task,
          score,
          { role, section: 'tasks' }
        ));
      }
    }
  }

  // Search file expertise
  if (!sections || sections.includes('files')) {
    for (const [filePath, stats] of Object.entries(context.fileExpertise || {})) {
      if (filePath.toLowerCase().includes(queryLower)) {
        results.push(new SearchResult(
          'file',
          { path: filePath, ...stats },
          5,
          { role, section: 'files' }
        ));
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.min(limit, MAX_LIMIT));
}

/**
 * Score a context item against query
 * @param {Object} item
 * @param {string} queryLower
 * @param {Array<string>} fields
 * @returns {number}
 */
function scoreContextItem(item, queryLower, fields) {
  let score = 0;

  for (const field of fields) {
    const value = item[field];
    if (!value) continue;

    const valueLower = String(value).toLowerCase();
    if (valueLower.includes(queryLower)) {
      score += 5;
    }
  }

  return score;
}

// ============================================================
// SHARED MEMORY SEARCH
// ============================================================

/**
 * Search shared cross-agent memory
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function searchSharedMemory(query, options = {}) {
  const { limit = DEFAULT_LIMIT, types = null } = options;
  const results = [];
  const queryLower = query.toLowerCase();
  const memory = memoryStore.loadSharedMemory();

  // Search learnings
  if (!types || types.includes('learnings')) {
    for (const learning of (memory.learnings || [])) {
      const score = scoreContextItem(learning, queryLower, ['topic', 'content', 'source']);
      if (score > 0) {
        results.push(new SearchResult(
          'shared_learning',
          learning,
          score,
          { section: 'shared_learnings' }
        ));
      }
    }
  }

  // Search decisions
  if (!types || types.includes('decisions')) {
    for (const decision of (memory.decisions || [])) {
      const score = scoreContextItem(decision, queryLower, ['action', 'rationale', 'outcome', 'agent']);
      if (score > 0) {
        results.push(new SearchResult(
          'shared_decision',
          decision,
          score,
          { section: 'shared_decisions' }
        ));
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.min(limit, MAX_LIMIT));
}

// ============================================================
// UNIFIED SEARCH
// ============================================================

/**
 * Search across all memory types
 * @param {string} query
 * @param {Object} [options]
 * @returns {Object} Categorized results
 */
function searchAll(query, options = {}) {
  const { limit = DEFAULT_LIMIT, roles = null } = options;

  const transcriptResults = searchAllTranscripts(query, { ...options, limit });
  const sharedResults = searchSharedMemory(query, { ...options, limit });

  const contextResults = [];
  const rolesToSearch = roles || Object.values(memoryStore.PANE_ROLES);
  for (const role of rolesToSearch) {
    contextResults.push(...searchContext(role, query, { ...options, limit }));
  }

  return {
    query,
    timestamp: new Date().toISOString(),
    totals: {
      transcripts: transcriptResults.length,
      context: contextResults.length,
      shared: sharedResults.length,
      total: transcriptResults.length + contextResults.length + sharedResults.length
    },
    results: {
      transcripts: transcriptResults.slice(0, limit),
      context: contextResults.slice(0, limit),
      shared: sharedResults.slice(0, limit)
    }
  };
}

// ============================================================
// SPECIALIZED QUERIES
// ============================================================

/**
 * Find entries related to a specific file
 * @param {string} filePath
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function findByFile(filePath, options = {}) {
  const { limit = DEFAULT_LIMIT, roles = null } = options;
  const results = [];
  const filePathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();

  const rolesToSearch = roles || Object.values(memoryStore.PANE_ROLES);

  for (const role of rolesToSearch) {
    const dates = memoryStore.listTranscriptDates(role);

    for (const date of dates) {
      const entries = memoryStore.readTranscript(role, { date });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const content = (entry.content || '').toLowerCase();
        const metaStr = JSON.stringify(entry.metadata || {}).toLowerCase();

        let score = 0;
        if (content.includes(filePathLower) || metaStr.includes(filePathLower)) {
          score += 10;
        } else if (content.includes(fileName) || metaStr.includes(fileName)) {
          score += 5;
        }

        if (score > 0) {
          results.push(new SearchResult(
            'transcript',
            entry,
            score,
            { role, date, entryIndex: i }
          ));
        }
      }
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  });

  return results.slice(0, Math.min(limit, MAX_LIMIT));
}

/**
 * Find entries by entry type
 * @param {string} entryType
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function findByType(entryType, options = {}) {
  const { limit = DEFAULT_LIMIT, roles = null, since = null } = options;
  const results = [];

  const rolesToSearch = roles || Object.values(memoryStore.PANE_ROLES);

  for (const role of rolesToSearch) {
    const dates = memoryStore.listTranscriptDates(role);

    for (const date of dates) {
      const entries = memoryStore.readTranscript(role, { date, since });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === entryType) {
          results.push(new SearchResult(
            'transcript',
            entry,
            1,
            { role, date, entryIndex: i }
          ));
        }
      }
    }
  }

  // Sort by timestamp descending
  results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  return results.slice(0, Math.min(limit, MAX_LIMIT));
}

/**
 * Find recent errors across agents
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function findRecentErrors(options = {}) {
  return findByType('error', {
    ...options,
    since: options.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Last 24h
  });
}

/**
 * Find tool usage patterns
 * @param {string} [toolName] - Optional filter by tool name
 * @param {Object} [options]
 * @returns {Object}
 */
function analyzeToolUsage(toolName = null, options = {}) {
  const toolResults = findByType('tool_use', options);

  const toolStats = {};

  for (const result of toolResults) {
    const name = result.data.metadata?.toolName || 'unknown';

    if (toolName && name.toLowerCase() !== toolName.toLowerCase()) {
      continue;
    }

    if (!toolStats[name]) {
      toolStats[name] = {
        count: 0,
        agents: new Set(),
        firstUsed: null,
        lastUsed: null
      };
    }

    toolStats[name].count += 1;
    toolStats[name].agents.add(result.source.role);

    const timestamp = result.timestamp;
    if (!toolStats[name].firstUsed || timestamp < toolStats[name].firstUsed) {
      toolStats[name].firstUsed = timestamp;
    }
    if (!toolStats[name].lastUsed || timestamp > toolStats[name].lastUsed) {
      toolStats[name].lastUsed = timestamp;
    }
  }

  // Convert Sets to arrays
  for (const [name, stats] of Object.entries(toolStats)) {
    toolStats[name].agents = Array.from(stats.agents);
  }

  return {
    query: toolName || 'all',
    timestamp: new Date().toISOString(),
    totalUsages: toolResults.length,
    tools: toolStats
  };
}

// ============================================================
// INDEX MANAGEMENT
// ============================================================

/**
 * Index a transcript for faster searching
 * @param {string} role
 * @param {string} [date]
 */
function indexTranscript(role, date = null) {
  const entries = memoryStore.readTranscript(role, { date });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const keywords = extractEntryKeywords(entry);

    if (keywords.length > 0) {
      memoryStore.indexKeywords(keywords, {
        role,
        date: date || memoryStore.getDateString(),
        entryIndex: i
      });
    }
  }
}

/**
 * Search using keyword index
 * @param {string} keyword
 * @param {Object} [options]
 * @returns {Array<SearchResult>}
 */
function searchByKeyword(keyword, options = {}) {
  const { limit = DEFAULT_LIMIT } = options;
  const index = memoryStore.loadKeywordIndex();
  const keywordLower = keyword.toLowerCase();

  const refs = index.keywords[keywordLower] || [];
  const results = [];

  for (const ref of refs.slice(-limit * 2)) { // Get more refs to account for missing entries
    const entries = memoryStore.readTranscript(ref.role, { date: ref.date });
    const entry = entries[ref.entryIndex];

    if (entry) {
      results.push(new SearchResult(
        'transcript',
        entry,
        5,
        ref
      ));
    }
  }

  return results.slice(0, limit);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Keyword extraction
  extractKeywords,
  extractEntryKeywords,

  // Transcript search
  searchRoleTranscripts,
  searchAllTranscripts,

  // Context search
  searchContext,

  // Shared memory search
  searchSharedMemory,

  // Unified search
  searchAll,

  // Specialized queries
  findByFile,
  findByType,
  findRecentErrors,
  analyzeToolUsage,

  // Index management
  indexTranscript,
  searchByKeyword,

  // Classes
  SearchResult
};
