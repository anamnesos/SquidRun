/**
 * Context Compressor - Smart context restoration after Claude Code compaction
 *
 * Generates token-budget-constrained markdown snapshots from multiple data sources
 * (intent files, shared state changelog, memory system, session handoff, build status).
 * Snapshots are written to workspace/context-snapshots/{paneId}.md for lifecycle
 * hooks to read after compaction events.
 *
 * Auto-refreshes on watched file changes (via watcher.addWatch) and a 120s timer.
 */

const fs = require('fs');
const path = require('path');
const { PANE_IDS, PANE_ROLES, WORKSPACE_PATH } = require('../config');
const log = require('./logger');
const { estimateTokens, truncateToTokenBudget } = require('./memory/memory-summarizer');

const SNAPSHOTS_DIR = path.join(WORKSPACE_PATH, 'context-snapshots');
const DEFAULT_MAX_TOKENS = 1500;
const REFRESH_INTERVAL_MS = 120000; // 120 seconds

// Priority sections for token budget allocation
const SECTION_PRIORITIES = {
  teamStatus: 100,
  recentChanges: 90,
  activeLearnings: 80,
  activeIssues: 75,
  sessionProgress: 70,
  keyDecisions: 60,
};

// Files to watch for auto-refresh (same set as shared-state.js)
const WATCHED_FILES = [
  'intent/1.json',
  'intent/2.json',
  'intent/5.json',
  'pipeline.json',
  'review.json',
];

// Module state
let sharedStateRef = null;
let memoryRef = null;
let mainWindowRef = null;
let watcherRef = null;
let refreshTimer = null;
let lastSnapshots = {};
let initialized = false;

/**
 * Ensure the snapshots directory exists
 */
function ensureSnapshotsDir() {
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  } catch (err) {
    log.warn('ContextCompressor', `Failed to create snapshots dir: ${err.message}`);
  }
}

/**
 * Read and parse a JSON file, returning null on error
 */
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read a text file, returning empty string on error
 */
function readTextFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Build the Team Status section from intent files
 */
function buildTeamStatusSection() {
  const lines = ['### Team Status'];
  for (const paneId of PANE_IDS) {
    const intentPath = path.join(WORKSPACE_PATH, 'intent', `${paneId}.json`);
    const intent = readJsonFile(intentPath);
    const role = PANE_ROLES[paneId] || `Pane ${paneId}`;

    if (intent) {
      const stale = intent.session < getSessionNumber() ? ' [STALE]' : '';
      lines.push(`- ${role}${stale}: ${intent.intent || 'unknown'}`);
      if (intent.blockers && intent.blockers !== 'none') {
        lines.push(`  Blockers: ${intent.blockers}`);
      }
      if (intent.teammates) {
        lines.push(`  Teammates: ${intent.teammates}`);
      }
    } else {
      lines.push(`- ${role}: No intent data`);
    }
  }
  return {
    id: 'teamStatus',
    priority: SECTION_PRIORITIES.teamStatus,
    content: lines.join('\n'),
    required: true,
  };
}

/**
 * Build the Recent Changes section from shared state changelog
 */
function buildRecentChangesSection(paneId) {
  if (!sharedStateRef) return null;

  try {
    const formatted = sharedStateRef.getFormattedChangelog(paneId);
    if (!formatted || formatted.includes('Nothing new')) return null;

    // Replace the heading with our own
    const content = formatted.replace(/^## What changed since your last update/, '### Recent Changes');
    return {
      id: 'recentChanges',
      priority: SECTION_PRIORITIES.recentChanges,
      content,
    };
  } catch {
    return null;
  }
}

/**
 * Build the Active Learnings section from the memory system
 */
function buildActiveLearningsSection(paneId) {
  if (!memoryRef) return null;

  try {
    const injection = memoryRef.getContextInjection(paneId, { maxTokens: 400, optimize: true });
    if (!injection || injection.trim().length === 0) return null;

    // Extract just the learnings portion if present
    const learningsMatch = injection.match(/## Recent Learnings\n([\s\S]*?)(?=\n## |$)/);
    if (learningsMatch) {
      return {
        id: 'activeLearnings',
        priority: SECTION_PRIORITIES.activeLearnings,
        content: `### Active Learnings\n${learningsMatch[1].trim()}`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build the Active Issues section from blockers.md and errors.md
 */
function buildActiveIssuesSection() {
  const blockersPath = path.join(WORKSPACE_PATH, 'build', 'blockers.md');
  const errorsPath = path.join(WORKSPACE_PATH, 'build', 'errors.md');

  const blockers = readTextFile(blockersPath);
  const errors = readTextFile(errorsPath);

  const lines = [];
  if (blockers && !blockers.includes('(none)') && blockers.length > 10) {
    lines.push('**Blockers:**');
    // Take first few lines
    const blockerLines = blockers.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 5);
    lines.push(...blockerLines);
  }
  if (errors && !errors.includes('(none)') && errors.length > 10) {
    lines.push('**Errors:**');
    const errorLines = errors.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 5);
    lines.push(...errorLines);
  }

  if (lines.length === 0) return null;

  return {
    id: 'activeIssues',
    priority: SECTION_PRIORITIES.activeIssues,
    content: `### Active Issues\n${lines.join('\n')}`,
  };
}

/**
 * Build the Session Progress section from session-handoff.json
 */
function buildSessionProgressSection() {
  const handoffPath = path.join(WORKSPACE_PATH, 'session-handoff.json');
  const handoff = readJsonFile(handoffPath);
  if (!handoff) return null;

  const lines = ['### Session Progress'];

  if (handoff.session) {
    lines.push(`Session: ${handoff.session}`);
  }

  if (handoff.completedTasks && Array.isArray(handoff.completedTasks)) {
    const recent = handoff.completedTasks.slice(-5);
    if (recent.length > 0) {
      lines.push(`Completed: ${recent.join(', ')}`);
    }
  }

  if (handoff.roadmap && Array.isArray(handoff.roadmap)) {
    const next = handoff.roadmap.filter(r => r && !r.done).slice(0, 3);
    if (next.length > 0) {
      lines.push(`Next: ${next.map(r => typeof r === 'string' ? r : r.task || r.name || JSON.stringify(r)).join(', ')}`);
    }
  }

  if (handoff.testStats) {
    const stats = handoff.testStats;
    if (stats.suites || stats.tests) {
      lines.push(`Tests: ${stats.suites || '?'} suites, ${stats.tests || '?'} tests`);
    }
  }

  if (lines.length <= 1) return null;

  return {
    id: 'sessionProgress',
    priority: SECTION_PRIORITIES.sessionProgress,
    content: lines.join('\n'),
  };
}

/**
 * Build the Key Decisions section from memory context manager
 */
function buildKeyDecisionsSection(paneId) {
  if (!memoryRef) return null;

  try {
    const summary = memoryRef.getContextSummary(paneId);
    if (!summary || !summary.recentDecisions || summary.recentDecisions.length === 0) return null;

    const lines = ['### Key Decisions'];
    const decisions = summary.recentDecisions.slice(-5);
    for (const d of decisions) {
      const action = d.action || d.description || 'unknown';
      lines.push(`- ${action}`);
    }

    return {
      id: 'keyDecisions',
      priority: SECTION_PRIORITIES.keyDecisions,
      content: lines.join('\n'),
    };
  } catch {
    return null;
  }
}

/**
 * Get current session number from handoff file
 */
function getSessionNumber() {
  const handoff = readJsonFile(path.join(WORKSPACE_PATH, 'session-handoff.json'));
  return handoff?.session || 0;
}

/**
 * Generate a context snapshot for a specific pane
 * @param {string} paneId
 * @param {Object} [options]
 * @param {number} [options.maxTokens=1500]
 * @returns {string} Markdown snapshot
 */
function generateSnapshot(paneId, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

  // Collect all sections
  const sections = [
    buildTeamStatusSection(),
    buildRecentChangesSection(paneId),
    buildActiveLearningsSection(paneId),
    buildActiveIssuesSection(),
    buildSessionProgressSection(),
    buildKeyDecisionsSection(paneId),
  ].filter(Boolean);

  // Sort by priority (highest first)
  sections.sort((a, b) => b.priority - a.priority);

  // Build header
  const sessionNum = getSessionNumber();
  const header = `## Context Restoration (auto-generated)\nGenerated: ${new Date().toISOString()} | Session ${sessionNum} | Budget: ${maxTokens} tokens\n`;
  let usedTokens = estimateTokens(header);

  // Fit sections within token budget
  const included = [];

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.content);

    if (section.required || usedTokens + sectionTokens <= maxTokens) {
      included.push(section);
      usedTokens += sectionTokens;
    } else {
      // Try to fit a truncated version
      const remaining = maxTokens - usedTokens;
      if (remaining > 50) {
        const truncated = truncateToTokenBudget(section.content, remaining);
        if (truncated && truncated.trim().length > 0) {
          included.push({ ...section, content: truncated });
          usedTokens += estimateTokens(truncated);
        }
      }
      // Stop adding sections once we're over budget
      break;
    }
  }

  // Re-sort by priority for output ordering (highest first)
  included.sort((a, b) => b.priority - a.priority);

  const snapshot = [header, ...included.map(s => s.content)].join('\n\n');

  // Cache and persist
  lastSnapshots[paneId] = snapshot;
  writeSnapshot(paneId, snapshot);

  return snapshot;
}

/**
 * Write a snapshot to disk
 */
function writeSnapshot(paneId, content) {
  ensureSnapshotsDir();
  try {
    const filePath = path.join(SNAPSHOTS_DIR, `${paneId}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    log.warn('ContextCompressor', `Failed to write snapshot for pane ${paneId}: ${err.message}`);
  }
}

/**
 * Force refresh all pane snapshots
 */
function refreshAll() {
  for (const paneId of PANE_IDS) {
    try {
      generateSnapshot(paneId);
    } catch (err) {
      log.warn('ContextCompressor', `Failed to refresh snapshot for pane ${paneId}: ${err.message}`);
    }
  }
}

/**
 * Force refresh a single pane's snapshot
 */
function refresh(paneId) {
  try {
    generateSnapshot(paneId);
  } catch (err) {
    log.warn('ContextCompressor', `Failed to refresh snapshot for pane ${paneId}: ${err.message}`);
  }
}

/**
 * Get the last generated snapshot without regenerating
 * @param {string} paneId
 * @returns {string|null}
 */
function getLastSnapshot(paneId) {
  return lastSnapshots[paneId] || null;
}

/**
 * Initialize the context compressor
 * @param {Object} options
 * @param {Object} options.sharedState - Reference to shared-state module
 * @param {Object} options.memory - Reference to memory module
 * @param {Object} options.mainWindow - Electron BrowserWindow
 * @param {Object} options.watcher - File watcher with addWatch(path, callback)
 */
function init(options = {}) {
  if (options.sharedState) sharedStateRef = options.sharedState;
  if (options.memory) memoryRef = options.memory;
  if (options.mainWindow) mainWindowRef = options.mainWindow;
  if (options.watcher) watcherRef = options.watcher;

  ensureSnapshotsDir();

  // Register file watches for auto-refresh (same pattern as shared-state.js)
  if (watcherRef) {
    for (const relPath of WATCHED_FILES) {
      const absPath = path.join(WORKSPACE_PATH, relPath);
      watcherRef.addWatch(absPath, () => {
        try {
          refreshAll();
        } catch (err) {
          log.warn('ContextCompressor', `Watch-triggered refresh failed: ${err.message}`);
        }
      });
    }
  }

  // Start periodic refresh timer
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    try {
      refreshAll();
    } catch (err) {
      log.warn('ContextCompressor', `Timer refresh failed: ${err.message}`);
    }
  }, REFRESH_INTERVAL_MS);

  // Generate initial snapshots
  refreshAll();

  initialized = true;
  log.info('ContextCompressor', `Initialized — snapshots dir: ${SNAPSHOTS_DIR}, refresh interval: ${REFRESH_INTERVAL_MS / 1000}s`);
}

/**
 * Shutdown - clear timers and listeners
 */
function shutdown() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  initialized = false;
  log.info('ContextCompressor', 'Shutdown complete');
}

module.exports = {
  init,
  generateSnapshot,
  refreshAll,
  refresh,
  getLastSnapshot,
  shutdown,
  // Exported for testing
  _internals: {
    buildTeamStatusSection,
    buildRecentChangesSection,
    buildActiveLearningsSection,
    buildActiveIssuesSection,
    buildSessionProgressSection,
    buildKeyDecisionsSection,
    getSessionNumber,
    readJsonFile,
    readTextFile,
    writeSnapshot,
    ensureSnapshotsDir,
    get sharedStateRef() { return sharedStateRef; },
    set sharedStateRef(v) { sharedStateRef = v; },
    get memoryRef() { return memoryRef; },
    set memoryRef(v) { memoryRef = v; },
    get mainWindowRef() { return mainWindowRef; },
    set mainWindowRef(v) { mainWindowRef = v; },
    get watcherRef() { return watcherRef; },
    set watcherRef(v) { watcherRef = v; },
    get refreshTimer() { return refreshTimer; },
    set refreshTimer(v) { refreshTimer = v; },
    get lastSnapshots() { return lastSnapshots; },
    set lastSnapshots(v) { lastSnapshots = v; },
    get initialized() { return initialized; },
    set initialized(v) { initialized = v; },
    WATCHED_FILES,
    SNAPSHOTS_DIR,
    DEFAULT_MAX_TOKENS,
    REFRESH_INTERVAL_MS,
    SECTION_PRIORITIES,
  },
};
