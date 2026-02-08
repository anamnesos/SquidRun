/**
 * Shared State - Live state aggregator with rolling changelog
 * Watches intent files, pipeline.json, review.json and broadcasts changes.
 *
 * Provides:
 * - Real-time WebSocket broadcasts on state changes
 * - IPC events for renderer integration
 * - Rolling changelog (max 100 entries) with human-readable diffs
 * - Per-pane "last seen" tracking for targeted changelog queries
 * - Atomic persistence to workspace/state-changelog.json
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, PANE_IDS, PANE_ROLES } = require('../config');
const log = require('./logger');
const websocketServer = require('./websocket-server');

const CHANGELOG_PATH = path.join(WORKSPACE_PATH, 'state-changelog.json');
const MAX_CHANGELOG_ENTRIES = 100;

// Files to watch, keyed by state key
const WATCHED_FILES = {
  'intent/1.json': { stateKey: 'intent', subKey: '1', source: () => PANE_ROLES['1'] || 'Pane 1' },
  'intent/2.json': { stateKey: 'intent', subKey: '2', source: () => PANE_ROLES['2'] || 'Pane 2' },
  'intent/5.json': { stateKey: 'intent', subKey: '5', source: () => PANE_ROLES['5'] || 'Pane 5' },
  'pipeline.json':  { stateKey: 'pipeline', subKey: null, source: () => 'Pipeline' },
  'review.json':    { stateKey: 'review', subKey: null, source: () => 'Review' },
};

// Fields to diff per file type
const DIFF_FIELDS = {
  intent: ['intent', 'status', 'blockers', 'active_files', 'teammates', 'last_findings'],
  pipeline: ['items'],
  review: ['result', 'change_type', 'reviewer', 'author'],
};

// Module state
let state = { intent: {}, pipeline: {}, review: {} };
let changelog = [];
let lastSeenAt = {};
let mainWindow = null;
let initialized = false;

/**
 * Read and parse a JSON file, returning null on any error
 */
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log.warn('SharedState', `Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Compare two values for equality (JSON.stringify for objects/arrays, direct for primitives)
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Format a value for human-readable display
 */
function formatValue(val) {
  if (val == null) return 'none';
  if (typeof val === 'string') return `'${val}'`;
  if (Array.isArray(val)) return `${val.length} items`;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Compute field-level diffs between old and new state for a given file type
 */
function computeDiffs(oldState, newState, fileType) {
  const fields = DIFF_FIELDS[fileType] || Object.keys(newState || {});
  const changes = [];

  for (const field of fields) {
    const oldVal = oldState ? oldState[field] : undefined;
    const newVal = newState ? newState[field] : undefined;
    if (!valuesEqual(oldVal, newVal)) {
      changes.push({ field, old: oldVal, new: newVal });
    }
  }

  return changes;
}

/**
 * Build a human-readable summary from a list of changes
 */
function buildSummary(source, changes, fileType) {
  if (changes.length === 0) return `${source}: updated (no field changes detected)`;

  const parts = changes.map(c => {
    // Special handling for pipeline items array
    if (fileType === 'pipeline' && c.field === 'items') {
      const oldCount = Array.isArray(c.old) ? c.old.length : 0;
      const newCount = Array.isArray(c.new) ? c.new.length : 0;
      return `Pipeline: ${newCount} active items (was ${oldCount})`;
    }
    const fieldName = c.field.charAt(0).toUpperCase() + c.field.slice(1);
    return `${fieldName}: ${formatValue(c.old)} → ${formatValue(c.new)}`;
  });

  return `${source}: ${parts.join(', ')}`;
}

/**
 * Handle a watched file change
 */
function onFileChange(relPath, config) {
  const absPath = path.join(WORKSPACE_PATH, relPath);
  const newData = readJsonFile(absPath);
  if (newData === null) return; // Skip corrupted/missing files

  const { stateKey, subKey, source: getSource } = config;
  const source = getSource();

  // Get previous state for this file
  let oldData;
  if (subKey) {
    oldData = state[stateKey][subKey] || null;
  } else {
    oldData = Object.keys(state[stateKey]).length > 0 ? state[stateKey] : null;
  }

  // Compute diffs
  const changes = computeDiffs(oldData, newData, stateKey);
  if (changes.length === 0) return; // No actual changes

  // Update in-memory state
  if (subKey) {
    state[stateKey][subKey] = newData;
  } else {
    state[stateKey] = newData;
  }

  const timestamp = Date.now();
  const summary = buildSummary(source, changes, stateKey);

  // Record changelog entry
  const entry = { ts: timestamp, file: relPath, source, summary, changes };
  changelog.push(entry);
  if (changelog.length > MAX_CHANGELOG_ENTRIES) {
    changelog = changelog.slice(-MAX_CHANGELOG_ENTRIES);
  }

  // Broadcast via WebSocket
  try {
    const broadcastPayload = JSON.stringify({
      type: 'state-update',
      file: relPath,
      source,
      changes,
      state: newData,
      timestamp,
    });
    websocketServer.broadcast(broadcastPayload, { from: 'shared-state' });
  } catch (err) {
    log.warn('SharedState', `WebSocket broadcast failed: ${err.message}`);
  }

  // Emit IPC event to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('shared-state-update', {
        file: relPath,
        source,
        changes,
        state: newData,
        timestamp,
      });
    } catch (err) {
      log.warn('SharedState', `IPC emit failed: ${err.message}`);
    }
  }

  // Persist changelog
  saveChangelog();

  log.info('SharedState', `${relPath} changed: ${summary}`);
}

/**
 * Save changelog to disk (atomic write)
 */
function saveChangelog() {
  try {
    const data = { version: 1, entries: changelog, lastUpdated: new Date().toISOString() };
    const tempPath = CHANGELOG_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, CHANGELOG_PATH);
  } catch (err) {
    log.warn('SharedState', `Failed to save changelog: ${err.message}`);
  }
}

/**
 * Load changelog from disk
 */
function loadChangelog() {
  try {
    if (!fs.existsSync(CHANGELOG_PATH)) return;
    const raw = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.entries)) {
      changelog = data.entries.slice(-MAX_CHANGELOG_ENTRIES);
      log.info('SharedState', `Loaded ${changelog.length} changelog entries`);
    }
  } catch (err) {
    log.warn('SharedState', `Failed to load changelog: ${err.message}`);
    changelog = [];
  }
}

/**
 * Read initial state for all watched files
 */
function loadInitialState() {
  for (const [relPath, config] of Object.entries(WATCHED_FILES)) {
    const absPath = path.join(WORKSPACE_PATH, relPath);
    const data = readJsonFile(absPath);
    if (data === null) continue;

    if (config.subKey) {
      state[config.stateKey][config.subKey] = data;
    } else {
      state[config.stateKey] = data;
    }
  }
}

/**
 * Initialize the shared state module
 * @param {object} options - { watcher, mainWindow }
 */
function init(options = {}) {
  if (options.mainWindow) mainWindow = options.mainWindow;

  // Load persisted changelog
  loadChangelog();

  // Load initial state from files
  loadInitialState();

  // Initialize per-pane lastSeenAt
  for (const paneId of PANE_IDS) {
    if (!(paneId in lastSeenAt)) {
      lastSeenAt[paneId] = 0;
    }
  }

  // Register file watches
  if (options.watcher) {
    for (const [relPath, config] of Object.entries(WATCHED_FILES)) {
      const absPath = path.join(WORKSPACE_PATH, relPath);
      options.watcher.addWatch(absPath, () => onFileChange(relPath, config));
    }
  }

  initialized = true;
  log.info('SharedState', `Initialized — watching ${Object.keys(WATCHED_FILES).length} files, ${changelog.length} changelog entries loaded`);
}

/**
 * Get the full aggregated state
 */
function getState() {
  return { intent: { ...state.intent }, pipeline: { ...state.pipeline }, review: { ...state.review } };
}

/**
 * Get changelog entries since a given timestamp
 */
function getChangesSince(sinceTimestamp) {
  return changelog.filter(entry => entry.ts > sinceTimestamp);
}

/**
 * Get changelog entries for a specific pane (since its lastSeenAt)
 */
function getChangelogForPane(paneId) {
  const since = lastSeenAt[paneId] || 0;
  const changes = changelog.filter(entry => entry.ts > since);
  const formatted = getFormattedChangelog(paneId);
  return { changes, formatted };
}

/**
 * Mark a pane as having seen the latest state
 */
function markPaneSeen(paneId) {
  lastSeenAt[paneId] = Date.now();
}

/**
 * Get a formatted changelog string suitable for context injection
 */
function getFormattedChangelog(paneId) {
  const since = lastSeenAt[paneId] || 0;
  const unseen = changelog.filter(entry => entry.ts > since);

  if (unseen.length === 0) {
    return '## What changed since your last update\nNothing new.';
  }

  const lines = unseen.map(entry => {
    const ago = Math.round((Date.now() - entry.ts) / 1000);
    const timeStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    return `- [${timeStr}] ${entry.summary}`;
  });

  return `## What changed since your last update\n${lines.join('\n')}`;
}

module.exports = {
  init,
  getState,
  getChangesSince,
  getChangelogForPane,
  markPaneSeen,
  getFormattedChangelog,
  // Exported for testing
  _internals: {
    computeDiffs,
    buildSummary,
    formatValue,
    valuesEqual,
    onFileChange,
    loadChangelog,
    saveChangelog,
    loadInitialState,
    get state() { return state; },
    set state(s) { state = s; },
    get changelog() { return changelog; },
    set changelog(c) { changelog = c; },
    get lastSeenAt() { return lastSeenAt; },
    set lastSeenAt(l) { lastSeenAt = l; },
    get mainWindow() { return mainWindow; },
    set mainWindow(w) { mainWindow = w; },
    get initialized() { return initialized; },
    WATCHED_FILES,
    DIFF_FIELDS,
    MAX_CHANGELOG_ENTRIES,
    CHANGELOG_PATH,
  },
};
