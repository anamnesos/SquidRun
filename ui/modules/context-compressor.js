/**
 * Context Compressor - Smart context restoration after Claude Code compaction
 *
 * Generates token-budget-constrained markdown snapshots from multiple data sources
 * (handoff files, app-status.json, shared state changelog, build status).
 * Snapshots are written to workspace/context-snapshots/{paneId}.md for lifecycle
 * hooks to read after compaction events.
 *
 * IMPORTANT: Agent handoff files (workspace/handoffs/{paneId}.md) are READ but
 * never overwritten by this module. Agents write handoff content there before
 * session end; this module incorporates that content into auto-generated snapshots.
 *
 * Auto-refreshes on watched file changes (via watcher.addWatch) and a 300s timer.
 */

const fs = require('fs');
const path = require('path');
const {
  PANE_IDS,
  PANE_ROLES,
  WORKSPACE_PATH,
  resolveCoordPath,
  getCoordRoots,
} = require('../config');
const log = require('./logger');
const { estimateTokens, truncateToTokenBudget } = require('./token-utils');

const SNAPSHOTS_DIR = path.join(WORKSPACE_PATH, 'context-snapshots');
const HANDOFFS_DIR = path.join(WORKSPACE_PATH, 'handoffs');
const APP_STATUS_PATH = path.join(WORKSPACE_PATH, 'app-status.json');
const DEFAULT_MAX_TOKENS = 3000;
const REFRESH_INTERVAL_MS = 300000; // 300 seconds

// Priority sections for token budget allocation
const SECTION_PRIORITIES = {
  handoff: 110,        // Agent-written handoff content — highest priority
  appStatus: 105,      // Session number + note from app-status.json
  teamStatus: 100,
  recentChanges: 90,
  activeIssues: 75,
  sessionProgress: 70,
};

// Files to watch for auto-refresh (relative to workspace/coord roots).
// Handoff files and app-status trigger immediate refresh when agents update them.
const WATCHED_FILES = [
  'app-status.json',
  ...PANE_IDS.map(id => path.join('handoffs', `${id}.md`)),
];

// Module state
let sharedStateRef = null;
let mainWindowRef = null;
let watcherRef = null;
let isIdleRef = null;
let refreshTimer = null;
let lastSnapshots = {};
let initialized = false;

function resolveCoordFile(relPath, options = {}) {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(relPath, options);
  }
  return path.join(WORKSPACE_PATH, relPath);
}

function getCoordWatchPaths(relPath) {
  if (typeof getCoordRoots === 'function') {
    return getCoordRoots({ includeLegacy: true, includeMissing: false })
      .map((root) => path.join(root, relPath));
  }
  return [path.join(WORKSPACE_PATH, relPath)];
}

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

function parseSessionNumberFromText(content) {
  const text = String(content || '');
  const patterns = [
    /Session:\s*(\d+)/i,
    /\|\s*Session\s+(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function readSnapshotProgress(paneId = '1') {
  const id = String(paneId || '1');
  const relPath = path.join('context-snapshots', `${id}.md`);
  const candidates = [
    resolveCoordFile(relPath),
    path.join(SNAPSHOTS_DIR, `${id}.md`),
  ];

  for (const filePath of candidates) {
    const text = readTextFile(filePath);
    if (!text) continue;

    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const completedLine = lines.find((line) => /^Completed:\s*/i.test(line));
    const nextLine = lines.find((line) => /^Next:\s*/i.test(line));
    const testsLine = lines.find((line) => /^Tests:\s*/i.test(line));
    const session = parseSessionNumberFromText(text);

    const completed = completedLine
      ? completedLine.replace(/^Completed:\s*/i, '').split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    const next = nextLine
      ? nextLine.replace(/^Next:\s*/i, '').split(',').map((item) => item.trim()).filter(Boolean)
      : [];

    return {
      session,
      completed,
      next,
      testsLine: testsLine || '',
    };
  }

  return {
    session: 0,
    completed: [],
    next: [],
    testsLine: '',
  };
}

/**
 * Read a handoff file for a specific pane.
 * Handoff files are at workspace/handoffs/{paneId}.md — written by agents,
 * NEVER overwritten by this module.
 * @param {string} paneId
 * @returns {string} Content or empty string
 */
function readHandoffFile(paneId) {
  const id = String(paneId || '1');
  const filePath = path.join(HANDOFFS_DIR, `${id}.md`);
  return readTextFile(filePath);
}

/**
 * Extract a one-line summary from handoff content for team status display.
 * Looks for the first "Completed" or "Status" line, or falls back to first
 * non-heading, non-empty line.
 * @param {string} content - Handoff file content
 * @returns {string} Summary line or empty string
 */
function extractHandoffSummary(content) {
  if (!content) return '';
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  // Look for a "Completed:" or "Status:" line first
  const statusLine = lines.find(l => /^(Completed|Status|Summary):/i.test(l));
  if (statusLine) return statusLine;

  // Fall back to first non-heading line
  const firstContent = lines.find(l => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('Updated:') && !l.startsWith('Generated:'));
  return firstContent || '';
}

/**
 * Read app-status.json and return parsed data.
 * @returns {{ session: number, note: string, started: string } | null}
 */
function readAppStatus() {
  const data = readJsonFile(APP_STATUS_PATH);
  if (!data) return null;
  return {
    session: typeof data.session === 'number' ? data.session : 0,
    note: typeof data.note === 'string' ? data.note : '',
    started: typeof data.started === 'string' ? data.started : '',
  };
}

/**
 * Build the Handoff section for a specific pane.
 * Reads agent-written handoff content from workspace/handoffs/{paneId}.md.
 * This is the highest-priority section — it carries session-to-session context.
 */
function buildHandoffSection(paneId) {
  const content = readHandoffFile(paneId);
  if (!content || content.length < 10) return null;

  return {
    id: 'handoff',
    priority: SECTION_PRIORITIES.handoff,
    content: `### Handoff\n${content}`,
    required: true, // Always include if present — this is the key memory content
  };
}

/**
 * Build the App Status section from workspace/app-status.json.
 * Provides session number and the session note (human-written summary).
 */
function buildAppStatusSection() {
  const status = readAppStatus();
  if (!status || (!status.session && !status.note)) return null;

  const lines = ['### Session Info'];
  if (status.session > 0) {
    lines.push(`Session: ${status.session}`);
  }
  if (status.note) {
    lines.push(`Note: ${status.note}`);
  }

  return {
    id: 'appStatus',
    priority: SECTION_PRIORITIES.appStatus,
    content: lines.join('\n'),
  };
}

/**
 * Build the Team Status section from handoff files (NOT from own output).
 * Reads workspace/handoffs/{paneId}.md for each pane to get a brief summary.
 */
function buildTeamStatusSection() {
  const lines = ['### Team Status'];
  for (const paneId of PANE_IDS) {
    const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
    const handoffContent = readHandoffFile(paneId);
    const summary = extractHandoffSummary(handoffContent);

    if (!summary) {
      lines.push(`- ${role}: No handoff data`);
    } else {
      // Truncate long summaries to keep team status compact
      const truncated = summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
      lines.push(`- ${role}: ${truncated}`);
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
 * Build the Active Issues section from blockers.md and errors.md
 */
function buildActiveIssuesSection() {
  const blockersPath = resolveCoordFile(path.join('build', 'blockers.md'));
  const errorsPath = resolveCoordFile(path.join('build', 'errors.md'));

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
 * Build the Session Progress section from handoff files (not circular self-read).
 * Falls back to snapshot progress if handoff files are missing (backwards compat).
 */
function buildSessionProgressSection() {
  const sessionNumber = getSessionNumber();
  const lines = ['### Session Progress'];
  let hasProgressData = false;

  if (sessionNumber > 0) {
    lines.push(`Session: ${sessionNumber}`);
  }

  // Try to get progress from pane 1 handoff file first, then fall back to snapshot
  const handoff = readHandoffFile('1');
  if (handoff) {
    const handoffLines = handoff.split('\n').map(l => l.trim()).filter(Boolean);
    const completedLine = handoffLines.find(l => /^Completed:/i.test(l));
    const nextLine = handoffLines.find(l => /^Next:/i.test(l));
    const testsLine = handoffLines.find(l => /^Tests:/i.test(l));
    if (completedLine) { lines.push(completedLine); hasProgressData = true; }
    if (nextLine) { lines.push(nextLine); hasProgressData = true; }
    if (testsLine) { lines.push(testsLine); hasProgressData = true; }
  }

  // Fall back to snapshot progress only if handoff didn't provide progress data
  if (!hasProgressData) {
    const snapshotProgress = readSnapshotProgress('1');
    if (snapshotProgress.completed.length > 0) {
      lines.push(`Completed: ${snapshotProgress.completed.slice(0, 5).join(', ')}`);
      hasProgressData = true;
    }
    if (snapshotProgress.next.length > 0) {
      lines.push(`Next: ${snapshotProgress.next.slice(0, 3).join(', ')}`);
      hasProgressData = true;
    }
    if (snapshotProgress.testsLine) {
      lines.push(snapshotProgress.testsLine);
      hasProgressData = true;
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
 * Get current session number from app-status.json (primary) or context snapshots (fallback).
 * No longer circular-reads from own output.
 */
function getSessionNumber() {
  // Primary: read from app-status.json — this is updated by the daemon
  const appStatus = readAppStatus();
  if (appStatus && appStatus.session > 0) {
    return appStatus.session;
  }

  // Fallback: scan context snapshots (backwards compat)
  let maxSnapshotSession = 0;
  for (const paneId of PANE_IDS) {
    const snapshotSession = readSnapshotProgress(paneId).session || 0;
    if (snapshotSession > maxSnapshotSession) {
      maxSnapshotSession = snapshotSession;
    }
  }
  return Math.max(maxSnapshotSession, 0);
}

/**
 * Generate a context snapshot for a specific pane
 * @param {string} paneId
 * @param {Object} [options]
 * @param {number} [options.maxTokens=3000]
 * @returns {string} Markdown snapshot
 */
function generateSnapshot(paneId, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

  // Collect all sections — handoff + app status are new, high-priority sources
  const sections = [
    buildHandoffSection(paneId),
    buildAppStatusSection(),
    buildTeamStatusSection(),
    buildRecentChangesSection(paneId),
    buildActiveIssuesSection(),
    buildSessionProgressSection(),
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
      // Continue — don't break, later sections may be required
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

function shouldSkipAutoRefresh() {
  if (typeof isIdleRef !== 'function') return false;
  try {
    return isIdleRef() === true;
  } catch (err) {
    log.warn('ContextCompressor', `Idle check failed; proceeding with refresh: ${err.message}`);
    return false;
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
 * @param {Object} options.mainWindow - Electron BrowserWindow
 * @param {Object} options.watcher - File watcher with addWatch(path, callback)
 * @param {Function} options.isIdle - Returns true when app should skip auto-refresh
 */
function init(options = {}) {
  if (options.sharedState) sharedStateRef = options.sharedState;
  if (options.mainWindow) mainWindowRef = options.mainWindow;
  if (options.watcher) watcherRef = options.watcher;
  isIdleRef = typeof options.isIdle === 'function' ? options.isIdle : null;

  ensureSnapshotsDir();

  // Register file watches for auto-refresh (same pattern as shared-state.js)
  if (watcherRef) {
    for (const relPath of WATCHED_FILES) {
      for (const absPath of getCoordWatchPaths(relPath)) {
        watcherRef.addWatch(absPath, () => {
          if (shouldSkipAutoRefresh()) return;
          try {
            refreshAll();
          } catch (err) {
            log.warn('ContextCompressor', `Watch-triggered refresh failed: ${err.message}`);
          }
        });
      }
    }
  }

  // Start periodic refresh timer
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (shouldSkipAutoRefresh()) return;
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
  isIdleRef = null;
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
    buildHandoffSection,
    buildAppStatusSection,
    buildTeamStatusSection,
    buildRecentChangesSection,
    buildActiveIssuesSection,
    buildSessionProgressSection,
    readHandoffFile,
    extractHandoffSummary,
    readAppStatus,
    readSnapshotProgress,
    parseSessionNumberFromText,
    getSessionNumber,
    readJsonFile,
    readTextFile,
    writeSnapshot,
    ensureSnapshotsDir,
    get sharedStateRef() { return sharedStateRef; },
    set sharedStateRef(v) { sharedStateRef = v; },
    get mainWindowRef() { return mainWindowRef; },
    set mainWindowRef(v) { mainWindowRef = v; },
    get watcherRef() { return watcherRef; },
    set watcherRef(v) { watcherRef = v; },
    get isIdleRef() { return isIdleRef; },
    set isIdleRef(v) { isIdleRef = v; },
    get refreshTimer() { return refreshTimer; },
    set refreshTimer(v) { refreshTimer = v; },
    get lastSnapshots() { return lastSnapshots; },
    set lastSnapshots(v) { lastSnapshots = v; },
    get initialized() { return initialized; },
    set initialized(v) { initialized = v; },
    WATCHED_FILES,
    SNAPSHOTS_DIR,
    HANDOFFS_DIR,
    APP_STATUS_PATH,
    DEFAULT_MAX_TOKENS,
    REFRESH_INTERVAL_MS,
    SECTION_PRIORITIES,
  },
};
