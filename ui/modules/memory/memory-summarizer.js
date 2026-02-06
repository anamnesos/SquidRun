/**
 * Memory Summarizer - Intelligent summarization for long histories
 *
 * Compresses conversation transcripts while preserving key information.
 * Uses extractive summarization and importance scoring.
 */

const memoryStore = require('./memory-store');
const memorySearch = require('./memory-search');
const { formatPrecise } = require('../formatters');

// Summarization settings
const MAX_SUMMARY_ENTRIES = 100;
const MIN_ENTRIES_FOR_SUMMARY = 20;
const IMPORTANCE_THRESHOLD = 3;
const MAX_CONTENT_LENGTH = 500;

// Entry type importance weights
const TYPE_WEIGHTS = {
  decision: 10,
  error: 8,
  tool_use: 5,
  tool_result: 4,
  state: 3,
  system: 2,
  input: 3,
  output: 4
};

// Keywords that indicate important content
const IMPORTANT_KEYWORDS = [
  'error', 'bug', 'fix', 'fixed', 'broken', 'failed', 'success',
  'important', 'critical', 'urgent', 'warning', 'note',
  'decision', 'decided', 'chose', 'selected', 'approach',
  'learned', 'discovered', 'found', 'realized', 'insight',
  'blocked', 'blocker', 'waiting', 'dependency',
  'completed', 'done', 'finished', 'implemented', 'shipped',
  'refactor', 'redesign', 'architecture', 'pattern',
  'test', 'tested', 'verified', 'validated', 'confirmed'
];

// Token estimation
const DEFAULT_TOKENS_PER_WORD = 1.3;
const DEFAULT_CHARS_PER_TOKEN = 4;

function estimateTokens(text, options = {}) {
  if (!text) return 0;
  const tokensPerWord = options.tokensPerWord || DEFAULT_TOKENS_PER_WORD;
  const charsPerToken = options.charsPerToken || DEFAULT_CHARS_PER_TOKEN;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const byWords = Math.ceil(wordCount * tokensPerWord);
  const byChars = Math.ceil(text.length / charsPerToken);
  return Math.max(byWords, byChars);
}

function truncateToTokenBudget(text, budget, options = {}) {
  if (!text || budget <= 0) return '';
  const estimate = estimateTokens(text, options);
  if (estimate <= budget) return text;
  const charsPerToken = options.charsPerToken || DEFAULT_CHARS_PER_TOKEN;
  const maxChars = Math.max(20, Math.floor(budget * charsPerToken));
  return truncateContent(text, maxChars);
}

/**
 * Summary entry structure
 */
class SummaryEntry {
  constructor(entry, importance, reason) {
    this.timestamp = entry.timestamp;
    this.type = entry.type;
    this.content = truncateContent(entry.content);
    this.importance = importance;
    this.reason = reason;
    this.metadata = extractKeyMetadata(entry.metadata);
  }
}

/**
 * Calculate importance score for an entry
 * @param {Object} entry
 * @returns {Object} { score, reasons }
 */
function calculateImportance(entry) {
  let score = 0;
  const reasons = [];

  // Base score from entry type
  const typeWeight = TYPE_WEIGHTS[entry.type] || 1;
  score += typeWeight;
  if (typeWeight >= 5) {
    reasons.push(`${entry.type} entry`);
  }

  // Content analysis
  const contentLower = (entry.content || '').toLowerCase();

  // Check for important keywords
  for (const keyword of IMPORTANT_KEYWORDS) {
    if (contentLower.includes(keyword)) {
      score += 2;
      if (!reasons.includes('important keyword')) {
        reasons.push('important keyword');
      }
    }
  }

  // File references are important
  if (contentLower.includes('.js') || contentLower.includes('.ts') ||
      contentLower.includes('.py') || contentLower.includes('.md')) {
    score += 2;
    reasons.push('file reference');
  }

  // Tool usage details
  if (entry.metadata?.toolName) {
    score += 2;
    reasons.push(`tool: ${entry.metadata.toolName}`);
  }

  // Decision rationale
  if (entry.metadata?.rationale) {
    score += 3;
    reasons.push('has rationale');
  }

  // Error with context
  if (entry.type === 'error' && entry.metadata?.errorMessage) {
    score += 3;
    reasons.push('error with details');
  }

  // State transitions
  if (entry.type === 'state') {
    score += 2;
    reasons.push('state change');
  }

  // Long content often contains details worth preserving
  if ((entry.content || '').length > 500) {
    score += 1;
  }

  return { score, reasons };
}

/**
 * Truncate content for summary
 * @param {string} content
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateContent(content, maxLength = MAX_CONTENT_LENGTH) {
  if (!content) return '';
  if (content.length <= maxLength) return content;

  // Try to truncate at a sentence boundary
  const truncated = content.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastNewline = truncated.lastIndexOf('\n');
  const breakPoint = Math.max(lastPeriod, lastNewline);

  if (breakPoint > maxLength * 0.5) {
    return truncated.slice(0, breakPoint + 1) + '...';
  }

  return truncated + '...';
}

/**
 * Extract key metadata fields
 * @param {Object} metadata
 * @returns {Object}
 */
function extractKeyMetadata(metadata) {
  if (!metadata) return {};

  const keys = ['toolName', 'rationale', 'outcome', 'errorMessage', 'fromState', 'toState'];
  const extracted = {};

  for (const key of keys) {
    if (metadata[key] !== undefined) {
      extracted[key] = metadata[key];
    }
  }

  return extracted;
}

// ============================================================
// TRANSCRIPT SUMMARIZATION
// ============================================================

/**
 * Generate summary for a role's transcript
 * @param {string} role
 * @param {Object} [options]
 * @returns {Object}
 */
function summarizeTranscript(role, options = {}) {
  const {
    date = null,
    maxEntries = MAX_SUMMARY_ENTRIES,
    threshold = IMPORTANCE_THRESHOLD
  } = options;

  const entries = memoryStore.readTranscript(role, { date });

  if (entries.length < MIN_ENTRIES_FOR_SUMMARY) {
    return {
      role,
      date: date || memoryStore.getDateString(),
      needsSummary: false,
      totalEntries: entries.length,
      message: 'Not enough entries for summarization'
    };
  }

  // Score all entries
  const scoredEntries = entries.map((entry, index) => {
    const { score, reasons } = calculateImportance(entry);
    return { entry, score, reasons, index };
  });

  // Filter by threshold and sort by importance
  const importantEntries = scoredEntries
    .filter(e => e.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries);

  // Re-sort by timestamp for chronological summary
  importantEntries.sort((a, b) => a.index - b.index);

  // Create summary entries
  const summaryEntries = importantEntries.map(({ entry, score, reasons }) =>
    new SummaryEntry(entry, score, reasons.join(', '))
  );

  // Generate statistics
  const stats = generateTranscriptStats(entries, scoredEntries);

  const summary = {
    role,
    date: date || memoryStore.getDateString(),
    generatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    summaryEntries: summaryEntries.length,
    compressionRatio: (1 - summaryEntries.length / entries.length).toFixed(2),
    stats,
    entries: summaryEntries
  };

  // Save summary
  memoryStore.saveSummary(role, summary);

  return summary;
}

/**
 * Generate transcript statistics
 * @param {Array} entries
 * @param {Array} scoredEntries
 * @returns {Object}
 */
function generateTranscriptStats(entries, scoredEntries) {
  const typeCounts = {};
  let totalTokens = 0;
  const toolUsage = {};
  const errorCount = entries.filter(e => e.type === 'error').length;
  const decisionCount = entries.filter(e => e.type === 'decision').length;

  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
    totalTokens += entry.metadata?.tokens || 0;

    if (entry.metadata?.toolName) {
      const tool = entry.metadata.toolName;
      toolUsage[tool] = (toolUsage[tool] || 0) + 1;
    }
  }

  const avgImportance = scoredEntries.length > 0
    ? scoredEntries.reduce((sum, e) => sum + e.score, 0) / scoredEntries.length
    : 0;

  return {
    typeCounts,
    totalTokens,
    toolUsage,
    errorCount,
    decisionCount,
    avgImportance: avgImportance.toFixed(2),
    timespan: {
      first: entries[0]?.timestamp || null,
      last: entries[entries.length - 1]?.timestamp || null
    }
  };
}

// ============================================================
// CONTEXT SUMMARIZATION
// ============================================================

/**
 * Generate summary of agent context
 * @param {string} role
 * @returns {Object}
 */
function summarizeContext(role) {
  const context = memoryStore.loadContext(role);

  if (!context) {
    return {
      role,
      exists: false,
      message: 'No context found for role'
    };
  }

  // Summarize learnings by topic
  const learningsByTopic = {};
  for (const learning of (context.learnings || [])) {
    const topic = learning.topic || 'general';
    if (!learningsByTopic[topic]) {
      learningsByTopic[topic] = [];
    }
    learningsByTopic[topic].push({
      content: truncateContent(learning.content, 200),
      confidence: learning.confidence,
      timestamp: learning.timestamp
    });
  }

  // Get top files by expertise
  const topFiles = Object.entries(context.fileExpertise || {})
    .map(([path, stats]) => ({
      path,
      interactions: stats.readCount + stats.writeCount,
      lastAccess: stats.lastAccess
    }))
    .sort((a, b) => b.interactions - a.interactions)
    .slice(0, 10);

  // Recent decision outcomes
  const recentDecisions = (context.recentDecisions || [])
    .slice(-10)
    .map(d => ({
      action: truncateContent(d.action, 100),
      outcome: d.outcome,
      timestamp: d.timestamp
    }));

  // Task performance
  const taskStats = context.taskStats || { completed: 0, failed: 0, abandoned: 0 };
  const successRate = taskStats.completed + taskStats.failed > 0
    ? (taskStats.completed / (taskStats.completed + taskStats.failed) * 100).toFixed(1)
    : 'N/A';

  return {
    role,
    generatedAt: new Date().toISOString(),
    sessionCount: context.sessionCount || 0,
    totalActiveTime: formatPrecise(context.totalActiveTime || 0),
    currentState: context.currentState || 'unknown',
    currentTask: context.currentTask ? truncateContent(context.currentTask.description || context.currentTask.task, 100) : null,
    taskPerformance: {
      ...taskStats,
      successRate: successRate + '%'
    },
    learningsByTopic,
    topFiles,
    recentDecisions,
    unresolvedErrors: (context.recentErrors || []).filter(e => !e.resolved).length
  };
}

// formatDuration now imported as formatPrecise from ../formatters

// ============================================================
// SESSION SUMMARY
// ============================================================

/**
 * Generate end-of-session summary for an agent
 * @param {string} role
 * @returns {Object}
 */
function generateSessionSummary(role) {
  const today = memoryStore.getDateString();
  const transcriptSummary = summarizeTranscript(role, { date: today });
  const contextSummary = summarizeContext(role);

  // Extract key accomplishments
  const accomplishments = extractAccomplishments(role, today);

  // Extract key learnings from today
  const todayLearnings = extractTodayLearnings(role, today);

  // Get error summary
  const errorSummary = extractErrorSummary(role, today);

  return {
    role,
    date: today,
    generatedAt: new Date().toISOString(),
    overview: {
      totalEntries: transcriptSummary.totalEntries,
      importantEntries: transcriptSummary.summaryEntries,
      compressionRatio: transcriptSummary.compressionRatio
    },
    accomplishments,
    learnings: todayLearnings,
    errors: errorSummary,
    context: contextSummary,
    transcript: transcriptSummary
  };
}

/**
 * Extract accomplishments from today's transcript
 * @param {string} role
 * @param {string} date
 * @returns {Array}
 */
function extractAccomplishments(role, date) {
  const entries = memoryStore.readTranscript(role, { date });
  const accomplishments = [];

  const completionPhrases = ['completed', 'done', 'finished', 'implemented', 'fixed', 'resolved'];

  for (const entry of entries) {
    if (!entry.content) continue;
    const contentLower = entry.content.toLowerCase();

    for (const phrase of completionPhrases) {
      if (contentLower.includes(phrase)) {
        accomplishments.push({
          content: truncateContent(entry.content, 150),
          timestamp: entry.timestamp,
          type: entry.type
        });
        break;
      }
    }
  }

  return accomplishments.slice(-20); // Last 20 accomplishments
}

/**
 * Extract learnings from today
 * @param {string} role
 * @param {string} date
 * @returns {Array}
 */
function extractTodayLearnings(role, date) {
  const context = memoryStore.loadContext(role);
  if (!context?.learnings) return [];

  const todayStart = new Date(date).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  return (context.learnings || [])
    .filter(l => {
      const time = new Date(l.timestamp).getTime();
      return time >= todayStart && time < todayEnd;
    })
    .map(l => ({
      topic: l.topic,
      content: truncateContent(l.content, 200),
      confidence: l.confidence
    }));
}

/**
 * Extract error summary from today
 * @param {string} role
 * @param {string} date
 * @returns {Object}
 */
function extractErrorSummary(role, date) {
  const entries = memoryStore.readTranscript(role, { date });
  const errors = entries.filter(e => e.type === 'error');

  const resolved = errors.filter(e => e.metadata?.resolved).length;
  const unresolved = errors.length - resolved;

  return {
    total: errors.length,
    resolved,
    unresolved,
    recentErrors: errors.slice(-5).map(e => ({
      message: truncateContent(e.content, 100),
      timestamp: e.timestamp,
      resolved: e.metadata?.resolved || false
    }))
  };
}

// ============================================================
// CROSS-AGENT SUMMARY
// ============================================================

/**
 * Generate summary across all agents
 * @param {Object} [options]
 * @returns {Object}
 */
function generateTeamSummary(options = {}) {
  const { date = memoryStore.getDateString() } = options;
  const roles = Object.values(memoryStore.PANE_ROLES);

  const agentSummaries = {};
  let totalEntries = 0;
  let totalErrors = 0;
  let totalDecisions = 0;
  const allTools = {};

  for (const role of roles) {
    const summary = summarizeTranscript(role, { date });
    agentSummaries[role] = {
      entries: summary.totalEntries,
      important: summary.summaryEntries,
      stats: summary.stats || {}
    };

    totalEntries += summary.totalEntries || 0;
    totalErrors += summary.stats?.errorCount || 0;
    totalDecisions += summary.stats?.decisionCount || 0;

    for (const [tool, count] of Object.entries(summary.stats?.toolUsage || {})) {
      allTools[tool] = (allTools[tool] || 0) + count;
    }
  }

  // Get shared learnings
  const sharedMemory = memoryStore.loadSharedMemory();
  const todayStart = new Date(date).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const todayLearnings = (sharedMemory.learnings || []).filter(l => {
    const time = new Date(l.addedAt).getTime();
    return time >= todayStart && time < todayEnd;
  });

  const todayDecisions = (sharedMemory.decisions || []).filter(d => {
    const time = new Date(d.recordedAt).getTime();
    return time >= todayStart && time < todayEnd;
  });

  return {
    date,
    generatedAt: new Date().toISOString(),
    overview: {
      totalEntries,
      totalErrors,
      totalDecisions,
      activeAgents: roles.filter(r => (agentSummaries[r]?.entries || 0) > 0).length
    },
    toolUsage: Object.entries(allTools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
    sharedLearnings: todayLearnings.slice(-10),
    sharedDecisions: todayDecisions.slice(-10),
    agentSummaries
  };
}

// ============================================================
// CONTEXT INJECTION
// ============================================================

/**
 * Generate context injection string for an agent
 * This creates a summary suitable for injecting into agent prompts
 * @param {string} role
 * @param {Object} [options]
 * @returns {string}
 */
function generateContextInjection(role, options = {}) {
  const { maxLength = 2000, includeHistory = true } = options;

  const context = memoryStore.loadContext(role);
  const lines = [];

  // Current state
  lines.push(`# Agent Context: ${role}`);
  lines.push(`Last active: ${context?.lastActive || 'unknown'}`);

  if (context?.currentTask) {
    lines.push(`\nCurrent task: ${context.currentTask.description || context.currentTask.task}`);
  }

  // Recent learnings
  if (context?.learnings?.length > 0) {
    lines.push('\n## Recent Learnings');
    for (const learning of context.learnings.slice(-5)) {
      lines.push(`- ${learning.topic}: ${truncateContent(learning.content, 100)}`);
    }
  }

  // Expert files
  const expertFiles = Object.entries(context?.fileExpertise || {})
    .map(([path, stats]) => ({ path, total: stats.readCount + stats.writeCount }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  if (expertFiles.length > 0) {
    lines.push('\n## Files you know well');
    for (const file of expertFiles) {
      lines.push(`- ${file.path} (${file.total} interactions)`);
    }
  }

  // Unresolved errors
  const unresolvedErrors = (context?.recentErrors || []).filter(e => !e.resolved);
  if (unresolvedErrors.length > 0) {
    lines.push('\n## Unresolved Errors');
    for (const error of unresolvedErrors.slice(-3)) {
      lines.push(`- ${truncateContent(error.message, 80)}`);
    }
  }

  // Recent history summary
  if (includeHistory) {
    const summary = memoryStore.loadSummary(role);
    if (summary?.entries?.length > 0) {
      lines.push('\n## Recent Activity Highlights');
      for (const entry of summary.entries.slice(-5)) {
        lines.push(`- [${entry.type}] ${truncateContent(entry.content, 100)}`);
      }
    }
  }

  let result = lines.join('\n');

  // Truncate if too long
  if (result.length > maxLength) {
    result = result.slice(0, maxLength - 50) + '\n\n[Context truncated...]';
  }

  return result;
}

// ============================================================
// CONTEXT WINDOW OPTIMIZER
// ============================================================

function buildContextSections(role, options = {}) {
  const context = memoryStore.loadContext(role) || {};
  const includeHistory = options.includeHistory !== false;
  const maxLearnings = options.maxLearnings || 5;
  const maxFiles = options.maxFiles || 5;
  const maxErrors = options.maxErrors || 3;
  const maxHighlights = options.maxHighlights || 5;

  const sections = [];
  const headerLines = [
    `# Agent Context: ${role}`,
    `Last active: ${context?.lastActive || 'unknown'}`
  ];

  if (context?.currentTask) {
    headerLines.push(`Current task: ${context.currentTask.description || context.currentTask.task}`);
  }

  sections.push({
    id: 'header',
    title: 'Header',
    content: headerLines.join('\n'),
    priority: 100,
    required: true
  });

  if (context?.learnings?.length > 0) {
    const lines = ['## Recent Learnings'];
    for (const learning of context.learnings.slice(-maxLearnings)) {
      lines.push(`- ${learning.topic}: ${truncateContent(learning.content, 100)}`);
    }
    sections.push({
      id: 'learnings',
      title: 'Learnings',
      content: lines.join('\n'),
      priority: 80
    });
  }

  const expertFiles = Object.entries(context?.fileExpertise || {})
    .map(([path, stats]) => ({ path, total: stats.readCount + stats.writeCount }))
    .sort((a, b) => b.total - a.total)
    .slice(0, maxFiles);

  if (expertFiles.length > 0) {
    const lines = ['## Files you know well'];
    for (const file of expertFiles) {
      lines.push(`- ${file.path} (${file.total} interactions)`);
    }
    sections.push({
      id: 'files',
      title: 'Expert Files',
      content: lines.join('\n'),
      priority: 60
    });
  }

  const unresolvedErrors = (context?.recentErrors || []).filter(e => !e.resolved);
  if (unresolvedErrors.length > 0) {
    const lines = ['## Unresolved Errors'];
    for (const error of unresolvedErrors.slice(-maxErrors)) {
      lines.push(`- ${truncateContent(error.message, 80)}`);
    }
    sections.push({
      id: 'errors',
      title: 'Unresolved Errors',
      content: lines.join('\n'),
      priority: 75
    });
  }

  if (includeHistory) {
    let summary = memoryStore.loadSummary(role);
    if (!summary?.entries?.length) {
      summary = summarizeTranscript(role, { maxEntries: 30, threshold: IMPORTANCE_THRESHOLD + 1 });
    }

    if (summary?.entries?.length) {
      const lines = ['## Recent Activity Highlights'];
      for (const entry of summary.entries.slice(-maxHighlights)) {
        lines.push(`- [${entry.type}] ${truncateContent(entry.content, 100)}`);
      }
      sections.push({
        id: 'history',
        title: 'History Highlights',
        content: lines.join('\n'),
        priority: 50
      });
    }
  }

  return sections;
}

function generateOptimizedContextInjection(role, options = {}) {
  const maxTokens = options.maxTokens || 1500;
  const sections = buildContextSections(role, options);
  const sorted = [...sections].sort((a, b) => b.priority - a.priority);
  const included = [];
  let usedTokens = 0;

  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.content, options);
    if (section.required || usedTokens + sectionTokens <= maxTokens) {
      included.push(section);
      usedTokens += sectionTokens;
    } else {
      const remaining = maxTokens - usedTokens;
      if (remaining > 50) {
        const truncated = truncateToTokenBudget(section.content, remaining, options);
        if (truncated) {
          included.push({ ...section, content: truncated, truncated: true });
          usedTokens = maxTokens;
        }
      }
      break;
    }
  }

  const result = included.map(s => s.content).join('\n\n');
  return result;
}

function analyzeContextWindow(role, options = {}) {
  const maxTokens = options.maxTokens || 1500;
  const sections = buildContextSections(role, options);
  const totals = sections.map(section => ({
    id: section.id,
    title: section.title,
    priority: section.priority,
    tokens: estimateTokens(section.content, options)
  }));

  const totalTokens = totals.reduce((sum, s) => sum + s.tokens, 0);
  const overBudget = totalTokens > maxTokens;
  const recommendations = [];

  if (overBudget) {
    const history = totals.find(s => s.id === 'history');
    const learnings = totals.find(s => s.id === 'learnings');
    const files = totals.find(s => s.id === 'files');

    if (history?.tokens) {
      recommendations.push('Reduce history highlights or raise summarization threshold.');
    }
    if (learnings?.tokens) {
      recommendations.push('Reduce recent learnings included or increase truncation.');
    }
    if (files?.tokens) {
      recommendations.push('Limit expert files list to the most relevant.');
    }
  }

  return {
    role,
    maxTokens,
    totalTokens,
    overBudget,
    sections: totals,
    recommendations
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Entry analysis
  calculateImportance,
  truncateContent,
  estimateTokens,

  // Transcript summarization
  summarizeTranscript,
  generateTranscriptStats,

  // Context summarization
  summarizeContext,

  // Session summary
  generateSessionSummary,
  extractAccomplishments,
  extractTodayLearnings,
  extractErrorSummary,

  // Team summary
  generateTeamSummary,

  // Context injection
  generateContextInjection,
  generateOptimizedContextInjection,
  analyzeContextWindow,

  // Classes
  SummaryEntry
};
