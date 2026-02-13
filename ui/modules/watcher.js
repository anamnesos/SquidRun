/**
 * File watcher and state machine
 * Extracted from main.js for modularization
 */

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { WORKSPACE_PATH, TRIGGER_TARGETS, PANE_IDS, PANE_ROLES } = require('../config');
const log = require('./logger');
const { TRIGGER_READ_RETRY_MS, WATCHER_DEBOUNCE_MS } = require('./constants');
const organicUI = require('./ipc/organic-ui-handlers');

const STATE_FILE_PATH = path.join(WORKSPACE_PATH, 'state.json');
const SHARED_CONTEXT_PATH = path.join(WORKSPACE_PATH, 'shared_context.md');

// Message queue directory
const MESSAGE_QUEUE_DIR = path.join(WORKSPACE_PATH, 'messages');

// Module state (set by init)
let mainWindow = null;
let workspaceWatcher = null;
let triggerWatcher = null; // UX-9: Fast watcher for trigger files (sub-50ms)
let messageWatcher = null; // Separate watcher for message queues
let triggers = null; // Reference to triggers module
let getSettings = null; // Settings getter for auto-sync control
let notifyExternal = null; // External notification hook
const customWatches = new Map(); // File-specific callbacks

const SYNC_FILES = new Set([
  'shared_context.md',
  'session-handoff.json',
  'blockers.md',
  'errors.md'
]);

// UX-9: Trigger file path for fast watching
const TRIGGER_PATH = path.join(WORKSPACE_PATH, 'triggers');
// TRIGGER_READ_RETRY_MS imported from constants.js
const TRIGGER_READ_MAX_ATTEMPTS = 3;
const triggerRetryTimers = new Map();
const WORKSPACE_WATCH_POLL_INTERVAL_MS = 5000;
const WATCHER_WORKER_PATH = path.join(__dirname, 'watcher-worker.js');
const WATCHER_WORKER_RESTART_DELAY_MS = 1000;
const watcherRestartTimers = new Map();
const MESSAGE_DELIVERY_ACK_TIMEOUT_MS = 4000;
const MESSAGE_DELIVERY_RETRY_BASE_MS = 500;
const MESSAGE_DELIVERY_RETRY_MAX_MS = 10000;
const MESSAGE_MARK_DELIVERED_RETRY_BASE_MS = 250;
const MESSAGE_MARK_DELIVERED_RETRY_MAX_MS = 5000;
const pendingMessageDeliveries = new Map(); // key -> delivery state
const pendingMessageDeliveryById = new Map(); // deliveryId -> key
let unsubscribeTriggerDeliveryAck = null;

// ============================================================
// STATE MACHINE
// ============================================================

const States = {
  IDLE: 'idle',
  PROJECT_SELECTED: 'project_selected',
  PLANNING: 'planning',
  PLAN_REVIEW: 'plan_review',
  PLAN_REVISION: 'plan_revision',
  EXECUTING: 'executing',
  CHECKPOINT: 'checkpoint',
  CHECKPOINT_REVIEW: 'checkpoint_review',
  CHECKPOINT_FIX: 'checkpoint_fix',
  FRICTION_LOGGED: 'friction_logged',
  FRICTION_SYNC: 'friction_sync',
  FRICTION_RESOLUTION: 'friction_resolution',
  COMPLETE: 'complete',
  ERROR: 'error',
  PAUSED: 'paused',
};

// Active agents per state (pane IDs: 1=Architect, 2=DevOps, 5=Analyst)
// Frontend and Reviewer are internal teammates of Architect (pane 1)
const ACTIVE_AGENTS = {
  [States.IDLE]: [],
  [States.PROJECT_SELECTED]: ['1', '2'],
  [States.PLANNING]: ['1', '2'],
  [States.PLAN_REVIEW]: ['1'],
  [States.PLAN_REVISION]: ['1', '2'],
  [States.EXECUTING]: ['2', '5'],
  [States.CHECKPOINT]: [],
  [States.CHECKPOINT_REVIEW]: ['1'],
  [States.CHECKPOINT_FIX]: ['1', '2', '5'],
  [States.FRICTION_LOGGED]: [],
  [States.FRICTION_SYNC]: [],
  [States.FRICTION_RESOLUTION]: ['1', '2'],
  [States.COMPLETE]: [],
  [States.ERROR]: [],
  [States.PAUSED]: [],
};

// Context messages for agents when state changes
const CONTEXT_MESSAGES = {
  [States.PLAN_REVIEW]: '[HIVEMIND] Plan submitted. Please review workspace/plan.md and write either plan-approved.md or plan-feedback.md',
  [States.PLAN_REVISION]: '[HIVEMIND] Revision requested. Please read workspace/plan-feedback.md and update plan.md accordingly.',
  [States.EXECUTING]: '[HIVEMIND] Plan approved. Begin implementation. Write to checkpoint.md when you reach a checkpoint.',
  [States.CHECKPOINT_REVIEW]: '[HIVEMIND] Checkpoint reached. Please review the work and write checkpoint-approved.md or checkpoint-issues.md',
  [States.CHECKPOINT_FIX]: '[HIVEMIND] Issues found at checkpoint. Please read checkpoint-issues.md and address the problems.',
  [States.FRICTION_RESOLUTION]: '[HIVEMIND] Friction logged. Please read workspace/friction/ and propose fixes in friction-resolution.md',
  [States.COMPLETE]: '[HIVEMIND] Task complete! All work has been reviewed and approved.',
};

// ============================================================
// CONFLICT DETECTION
// ============================================================

let lastConflicts = [];

function extractFilePaths(text) {
  const files = new Set();
  const patterns = [/`([^`]+\.(js|ts|html|css|json|md))`/gi, /(ui\/\S+\.(js|html|css))/gi];
  for (const p of patterns) { let m; while ((m = p.exec(text))) files.add(m[1].toLowerCase()); }
  return [...files];
}

function parseWorkerAssignments() {
  try {
    if (!fs.existsSync(SHARED_CONTEXT_PATH)) return {};
    const c = fs.readFileSync(SHARED_CONTEXT_PATH, 'utf-8');
    const a = {};
    const frontend = c.match(/### (Frontend)[\s\S]*?(?=###|$)/i);
    const backend = c.match(/### (Backend)[\s\S]*?(?=###|$)/i);
    const analyst = c.match(/### (Analyst)[\s\S]*?(?=###|$)/i);
    if (frontend) a['Frontend'] = extractFilePaths(frontend[0]);
    if (backend) a['Backend'] = extractFilePaths(backend[0]);
    if (analyst) a['Analyst'] = extractFilePaths(analyst[0]);
    return a;
  } catch (e) { return {}; }
}

function checkFileConflicts() {
  const a = parseWorkerAssignments();
  const conflicts = [];
  const roles = Object.keys(a);
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const roleA = roles[i];
      const roleB = roles[j];
      const filesA = a[roleA] || [];
      const filesB = a[roleB] || [];
      for (const f of filesA) {
        if (filesB.includes(f)) {
          conflicts.push({ file: f, workers: [roleA, roleB] });
        }
      }
    }
  }
  lastConflicts = conflicts;
  if (conflicts.length && mainWindow && !mainWindow.isDestroyed()) {
    log.warn('Conflict', 'File conflicts detected', conflicts.map(c => c.file));
    mainWindow.webContents.send('file-conflicts-detected', conflicts);
  }
  return conflicts;
}

function getLastConflicts() {
  return lastConflicts;
}

// ============================================================
// STATE FUNCTIONS
// ============================================================

function readState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const content = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log.error('State', 'Error reading state', err);
  }
  // Return default state
  return {
    state: States.IDLE,
    previous_state: null,
    active_agents: [],
    timestamp: new Date().toISOString(),
    project: null,
    current_checkpoint: 0,
    total_checkpoints: 0,
    friction_count: 0,
    error: null,
    claims: {},
  };
}

// ============================================================
// AGENT CLAIM/RELEASE PROTOCOL
// ============================================================

/**
 * Claim an agent role for a task
 * @param {string} paneId - The pane/agent ID (1, 2, or 5)
 * @param {string} taskId - The task being claimed
 * @param {string} [description] - Optional description
 * @returns {{ success: boolean, error?: string }}
 */
function claimAgent(paneId, taskId, description = '') {
  const state = readState();
  if (!state.claims) state.claims = {};

  // Check if already claimed by someone else
  for (const [existingPane, claim] of Object.entries(state.claims)) {
    if (claim.taskId === taskId && existingPane !== paneId) {
      return {
        success: false,
        error: `Task "${taskId}" already claimed by ${PANE_ROLES[existingPane] || existingPane}`,
      };
    }
  }

  // Claim the task
  state.claims[paneId] = {
    taskId,
    description,
    claimedAt: new Date().toISOString(),
    role: PANE_ROLES[paneId] || `Pane ${paneId}`,
  };

  writeState(state);
  log.info('Claims', `${PANE_ROLES[paneId]} claimed task: ${taskId}`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claims-changed', state.claims);
  }

  return { success: true, claim: state.claims[paneId] };
}

/**
 * Release an agent's claim
 * @param {string} paneId - The pane/agent ID
 * @returns {{ success: boolean }}
 */
function releaseAgent(paneId) {
  const state = readState();
  if (!state.claims) state.claims = {};

  const hadClaim = !!state.claims[paneId];
  delete state.claims[paneId];

  writeState(state);
  if (hadClaim) {
    log.info('Claims', `${PANE_ROLES[paneId]} released claim`);
  }

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claims-changed', state.claims);
  }

  return { success: true };
}

/**
 * Get all current claims
 * @returns {Object} paneId -> claim info
 */
function getClaims() {
  const state = readState();
  return state.claims || {};
}

/**
 * Clear all claims (for fresh start)
 * @returns {{ success: boolean }}
 */
function clearClaims() {
  const state = readState();
  state.claims = {};
  writeState(state);

  log.info('Claims', 'All claims cleared');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claims-changed', {});
  }

  return { success: true };
}

function writeState(state) {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write: write to temp file, then rename
    const tempPath = STATE_FILE_PATH + '.tmp';
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, STATE_FILE_PATH);
  } catch (err) {
    log.error('State', 'Error writing state', err);
    const tempPath = STATE_FILE_PATH + '.tmp';
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
  }
}

function transition(newState) {
  const state = readState();
  const oldState = state.state;

  // Don't transition to same state
  if (oldState === newState) return;

  state.previous_state = oldState;
  state.state = newState;
  state.active_agents = ACTIVE_AGENTS[newState] || [];
  state.timestamp = new Date().toISOString();

  writeState(state);
  log.info('State Machine', `${oldState} → ${newState}`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', state);
  }

  // Notify active agents
  const message = CONTEXT_MESSAGES[newState];
  if (message && triggers) {
    triggers.notifyAgents(state.active_agents, message);
  }

  if (notifyExternal) {
    if (newState === States.COMPLETE) {
      notifyExternal({
        category: 'completion',
        title: 'Workflow complete',
        message: `State transitioned to ${newState}`,
        meta: { state: newState },
      });
    } else if (newState === States.ERROR) {
      notifyExternal({
        category: 'alert',
        title: 'Workflow error',
        message: `State transitioned to ${newState}`,
        meta: { state: newState },
      });
    }
  }
}

// ============================================================
// FILE CHANGE HANDLER (with debounce for batch operations)
// ============================================================

// Debounce state for handleFileChange
// WATCHER_DEBOUNCE_MS imported from constants.js
let debounceTimer = null;
let pendingFileChanges = new Set();

function notifySyncFileChanged(filename) {
  if (!SYNC_FILES.has(filename)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-file-changed', {
      file: filename,
      changedAt: Date.now()
    });
  }
}

/**
 * Debounced file change handler
 * Batches rapid file changes (git checkout, npm install) to prevent event floods
 * @param {string} filePath - Path to changed file
 */
function handleFileChangeDebounced(filePath) {
  // Add to pending set (dedupes multiple changes to same file)
  pendingFileChanges.add(filePath);

  // Clear existing timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set new timer - process all pending after debounce window
  debounceTimer = setTimeout(() => {
    const files = [...pendingFileChanges];
    pendingFileChanges.clear();
    debounceTimer = null;

    log.info('Watcher', `Processing ${files.length} batched file change(s)`);

    // Process each unique file
    for (const file of files) {
      handleFileChangeCore(file);
    }
  }, WATCHER_DEBOUNCE_MS);
}

/**
 * Core file change handler (called after debounce)
 * @param {string} filePath - Path to changed file
 */
function handleFileChangeCore(filePath) {
  const filename = path.basename(filePath);
  const state = readState();
  const currentState = state.state;

  log.info('Watcher', `File changed: ${filename} (current state: ${currentState})`);

  const normalizedPath = path.resolve(filePath);
  const customHandler = customWatches.get(normalizedPath);
  if (customHandler) {
    try {
      customHandler(filePath);
    } catch (err) {
      log.error('Watcher', `Custom watch failed for ${normalizedPath}`, err);
    }
  }

  if (SYNC_FILES.has(filename)) {
    notifySyncFileChanged(filename);
  }

  // Transition logic based on file + current state
  if (filename === 'plan.md' && currentState === States.PLANNING) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename === 'plan-approved.md' && currentState === States.PLAN_REVIEW) {
    const conflicts = checkFileConflicts();
    if (conflicts.length > 0) {
      log.warn('Transition', 'Proceeding to EXECUTING with file conflicts');
    }
    transition(States.EXECUTING);
  }
  else if (filename === 'plan-feedback.md' && currentState === States.PLAN_REVIEW) {
    transition(States.PLAN_REVISION);
  }
  else if (filename === 'plan.md' && currentState === States.PLAN_REVISION) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename === 'checkpoint.md' && currentState === States.EXECUTING) {
    transition(States.CHECKPOINT);
    setTimeout(() => transition(States.CHECKPOINT_REVIEW), 500);
  }
  else if (filename === 'checkpoint-approved.md' && currentState === States.CHECKPOINT_REVIEW) {
    if (!fs.existsSync(filePath)) {
      log.warn('Watcher', `Checkpoint approval file missing: ${filePath}`);
      return;
    }
    let checkpointContent = '';
    try {
      checkpointContent = fs.readFileSync(filePath, 'utf-8').toLowerCase();
    } catch (err) {
      log.error('Watcher', 'Failed to read checkpoint-approved.md', err);
      return;
    }
    if (checkpointContent.includes('complete') || checkpointContent.includes('done')) {
      transition(States.COMPLETE);
    } else {
      transition(States.EXECUTING);
    }
  }
  else if (filename === 'checkpoint-issues.md' && currentState === States.CHECKPOINT_REVIEW) {
    transition(States.CHECKPOINT_FIX);
  }
  else if (filename === 'checkpoint.md' && currentState === States.CHECKPOINT_FIX) {
    transition(States.CHECKPOINT_REVIEW);
  }
  else if (filename === 'friction-resolution.md' && currentState === States.FRICTION_RESOLUTION) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename.endsWith('.md') && filePath.includes('friction')) {
    if (currentState !== States.FRICTION_LOGGED &&
        currentState !== States.FRICTION_SYNC &&
        currentState !== States.FRICTION_RESOLUTION) {
      const updatedState = readState();
      updatedState.friction_count = (updatedState.friction_count || 0) + 1;
      writeState(updatedState);
      transition(States.FRICTION_LOGGED);
      setTimeout(() => transition(States.FRICTION_SYNC), 500);
    }
  }

  // AUTO-SYNC TRIGGERS (controlled by autoSync setting)
  else if (filename === 'improvements.md' && triggers) {
    const settings = getSettings ? getSettings() : {};
    if (settings.autoSync) {
      log.info('Watcher', 'Improvements file changed - triggering auto-sync to all agents');
      triggers.notifyAllAgentsSync('improvements.md');
    } else {
      log.info('Watcher', 'Improvements file changed - auto-sync disabled, skipping');
    }
  }
  else if (SYNC_FILES.has(filename) && triggers) {
    const settings = getSettings ? getSettings() : {};
    if (settings.autoSync) {
      log.info('Watcher', `${filename} changed - triggering auto-sync to all agents`);
      triggers.notifyAllAgentsSync(filename);
    } else {
      log.info('Watcher', `${filename} changed - auto-sync disabled, skipping`);
    }
  }

  // TARGETED TRIGGERS: workspace/triggers/{target}.txt
  else if (filePath.includes('triggers') && filename.endsWith('.txt') && triggers) {
    handleTriggerFileWithRetry(filePath, filename);
  }
}

// ============================================================
// WATCHER CONTROL
// ============================================================

function clearWatcherRestartTimer(watcherName) {
  const timer = watcherRestartTimers.get(watcherName);
  if (timer) {
    clearTimeout(timer);
    watcherRestartTimers.delete(watcherName);
  }
}

function scheduleWatcherWorkerRestart(watcherName, startFn) {
  clearWatcherRestartTimer(watcherName);
  const timer = setTimeout(() => {
    watcherRestartTimers.delete(watcherName);
    try {
      startFn();
    } catch (err) {
      log.error('Watcher', `Failed restarting ${watcherName} worker`, err);
    }
  }, WATCHER_WORKER_RESTART_DELAY_MS);
  watcherRestartTimers.set(watcherName, timer);
}

function stopWatcherWorker(watcherName, workerRefName, { reason = 'stop', clearRestart = true } = {}) {
  if (clearRestart) {
    clearWatcherRestartTimer(watcherName);
  }
  const worker = workerRefName === 'workspace' ? workspaceWatcher
    : workerRefName === 'trigger' ? triggerWatcher
      : messageWatcher;
  if (!worker) return false;

  worker.__hivemindIntentionalStop = true;
  try {
    worker.kill();
  } catch (err) {
    log.warn('Watcher', `Failed killing ${watcherName} worker (${reason}): ${err.message}`);
  }

  if (workerRefName === 'workspace') workspaceWatcher = null;
  if (workerRefName === 'trigger') triggerWatcher = null;
  if (workerRefName === 'message') messageWatcher = null;
  return true;
}

function startWatcherWorker(watcherName, onEvent, restartFn) {
  const worker = fork(WATCHER_WORKER_PATH, [], {
    env: {
      ...process.env,
      HIVEMIND_WATCHER_NAME: watcherName,
    },
  });

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.watcherName !== watcherName) return;

    if (msg.type === 'error') {
      log.error('Watcher', `${watcherName} worker reported error: ${msg.error || 'unknown error'}`);
      return;
    }

    if ((msg.type === 'add' || msg.type === 'change' || msg.type === 'unlink') && msg.path) {
      onEvent(msg.path, msg.type);
    }
  });

  worker.on('error', (err) => {
    log.error('Watcher', `${watcherName} worker process error`, err);
  });

  worker.on('exit', (code, signal) => {
    const intentional = worker.__hivemindIntentionalStop === true;
    if (watcherName === 'workspace' && workspaceWatcher === worker) workspaceWatcher = null;
    if (watcherName === 'trigger' && triggerWatcher === worker) triggerWatcher = null;
    if (watcherName === 'message' && messageWatcher === worker) messageWatcher = null;

    if (intentional) {
      log.info('Watcher', `${watcherName} worker stopped (${signal || code || 'exit'})`);
      return;
    }

    log.error('Watcher', `${watcherName} worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
    scheduleWatcherWorkerRestart(watcherName, restartFn);
  });

  return worker;
}

function startWatcher() {
  if (workspaceWatcher) {
    stopWatcherWorker('workspace', 'workspace', { reason: 'restart', clearRestart: false });
  }

  workspaceWatcher = startWatcherWorker(
    'workspace',
    (filePath, eventType) => {
      if (eventType === 'add' || eventType === 'change') {
        handleFileChangeDebounced(filePath);
      }
    },
    () => startWatcher()
  );

  log.info('Watcher', `Watching ${WORKSPACE_PATH} with ${WORKSPACE_WATCH_POLL_INTERVAL_MS}ms polling`);
}

function stopWatcher() {
  stopWatcherWorker('workspace', 'workspace');
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingFileChanges.clear();
}

// ============================================================
// UX-9: FAST TRIGGER WATCHER (sub-50ms delivery)
// ============================================================

/**
 * Handle trigger file changes with priority processing
 * @param {string} filePath - Path to changed trigger file
 */
function handleTriggerChange(filePath) {
  const filename = path.basename(filePath);
  if (!filename.endsWith('.txt')) return;

  log.info('FastTrigger', `Detected: ${filename} (fast path)`);

  // Route directly to triggers module for immediate processing
  if (triggers) {
    handleTriggerFileWithRetry(filePath, filename);
  }
}

/**
 * Retry reading trigger files if write hasn't flushed yet.
 * Avoids partial reads when file change fires before content is fully written.
 * @param {string} filePath - Path to trigger file
 * @param {string} filename - Trigger filename
 * @param {number} attempt - Current retry attempt
 * @param {?number} lastKnownSize - Previous observed file size
 */
function scheduleTriggerReadRetry(filePath, filename, attempt, lastKnownSize = null) {
  const existing = triggerRetryTimers.get(filePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    triggerRetryTimers.delete(filePath);
    handleTriggerFileWithRetry(filePath, filename, attempt + 1, lastKnownSize);
  }, TRIGGER_READ_RETRY_MS);
  triggerRetryTimers.set(filePath, timer);
}

function handleTriggerFileWithRetry(filePath, filename, attempt = 0, lastKnownSize = null) {
  if (!triggers) return;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (err) {
    log.info('Trigger', `Could not stat ${filename}: ${err.message}`);
    return;
  }

  const size = stats.size;
  if (size === 0) {
    if (attempt < TRIGGER_READ_MAX_ATTEMPTS) {
      scheduleTriggerReadRetry(filePath, filename, attempt, null);
      return;
    }

    // Expected post-clear noise: trigger was delivered then cleared, watcher sees empty file
    log.debug('Trigger', `Empty trigger file after ${TRIGGER_READ_MAX_ATTEMPTS} retries: ${filename}`);
    return;
  }

  // Require one stable-size observation before processing to avoid split/mangled reads.
  if (lastKnownSize === null || size !== lastKnownSize) {
    if (attempt < TRIGGER_READ_MAX_ATTEMPTS) {
      scheduleTriggerReadRetry(filePath, filename, attempt, size);
      return;
    }
    log.warn('Trigger', `Size not stable after ${TRIGGER_READ_MAX_ATTEMPTS} retries, processing anyway: ${filename} (${size} bytes)`);
  }

  triggers.handleTriggerFile(filePath, filename);
}

/**
 * Start the fast trigger watcher (UX-9)
 * Uses aggressive polling for sub-50ms message delivery
 */
function startTriggerWatcher() {
  // Ensure trigger directory exists
  try {
    if (!fs.existsSync(TRIGGER_PATH)) {
      fs.mkdirSync(TRIGGER_PATH, { recursive: true });
      log.info('FastTrigger', 'Created trigger directory');
    }
  } catch (err) {
    log.error('FastTrigger', 'Failed to initialize trigger directory', err);
    return;
  }

  if (triggerWatcher) {
    stopWatcherWorker('trigger', 'trigger', { reason: 'restart', clearRestart: false });
  }

  triggerWatcher = startWatcherWorker(
    'trigger',
    (filePath, eventType) => {
      if (eventType === 'add' || eventType === 'change') {
        handleTriggerChange(filePath);
      }
    },
    () => startTriggerWatcher()
  );

  log.info('FastTrigger', `Watching ${TRIGGER_PATH} with 300ms polling`);
}

/**
 * Stop the fast trigger watcher
 */
function stopTriggerWatcher() {
  if (stopWatcherWorker('trigger', 'trigger')) {
    log.info('FastTrigger', 'Stopped');
  }
  // Clear any pending retry timers
  for (const timer of triggerRetryTimers.values()) {
    clearTimeout(timer);
  }
  triggerRetryTimers.clear();
}

/**
 * Initialize the watcher module with shared state
 * @param {BrowserWindow} window - The main Electron window
 * @param {Object} triggersModule - The triggers module reference
 * @param {Function} settingsGetter - Function to get current settings (for auto-sync control)
 */
function init(window, triggersModule, settingsGetter = null) {
  mainWindow = window;
  triggers = triggersModule;
  getSettings = settingsGetter;
  registerTriggerDeliveryAckListener();
}

function setExternalNotifier(fn) {
  notifyExternal = typeof fn === 'function' ? fn : null;
}

function addWatch(filePath, onChange) {
  if (!filePath || typeof onChange !== 'function') {
    return false;
  }
  customWatches.set(path.resolve(filePath), onChange);
  return true;
}

function removeWatch(filePath) {
  if (!filePath) {
    return false;
  }
  return customWatches.delete(path.resolve(filePath));
}

// ============================================================
// MESSAGE QUEUE FILE WATCHER
// ============================================================

/**
 * Initialize message queue directory
 */
function initMessageQueue() {
  try {
    if (!fs.existsSync(MESSAGE_QUEUE_DIR)) {
      fs.mkdirSync(MESSAGE_QUEUE_DIR, { recursive: true });
      log.info('MessageQueue', 'Created message directory');
    }

    // Create queue files for each pane if they don't exist
    for (const paneId of PANE_IDS) {
      const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${paneId}.json`);
      if (!fs.existsSync(queueFile)) {
        fs.writeFileSync(queueFile, '[]', 'utf-8');
      }
    }

    return { success: true, path: MESSAGE_QUEUE_DIR };
  } catch (err) {
    log.error('MessageQueue', 'Failed to initialize message queue directory', err);
    return { success: false, error: err.message };
  }
}

/**
 * Read messages for a pane
 * @param {string} paneId - Target pane ID
 * @param {boolean} undeliveredOnly - Only return undelivered messages
 * @returns {Array} Messages
 */
function getMessages(paneId, undeliveredOnly = false) {
  const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${paneId}.json`);

  try {
    if (!fs.existsSync(queueFile)) {
      return [];
    }
    const content = fs.readFileSync(queueFile, 'utf-8');
    const messages = JSON.parse(content);

    if (undeliveredOnly) {
      return messages.filter(m => !m.delivered);
    }
    return messages;
  } catch (err) {
    log.error('MessageQueue', `Error reading queue for pane ${paneId}: ${err.message}`);
    return [];
  }
}

/**
 * Send a message to a pane (append to queue)
 * Direct messages bypass workflow gate
 * @param {string} fromPaneId - Sender pane ID
 * @param {string} toPaneId - Recipient pane ID
 * @param {string} content - Message content
 * @param {string} type - Message type: 'direct' | 'broadcast' | 'system'
 * @returns {{ success: boolean, messageId?: string }}
 */
function sendMessage(fromPaneId, toPaneId, content, type = 'direct') {
  const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${toPaneId}.json`);

  try {
    // Ensure directory exists
    if (!fs.existsSync(MESSAGE_QUEUE_DIR)) {
      const initResult = initMessageQueue();
      if (!initResult.success) {
        return { success: false, error: initResult.error || 'Message queue init failed' };
      }
    }

    // Read existing messages
    let messages = [];
    if (fs.existsSync(queueFile)) {
      const existing = fs.readFileSync(queueFile, 'utf-8');
      messages = JSON.parse(existing);
    }

    // Create new message
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const message = {
      id: messageId,
      from: fromPaneId,
      fromRole: PANE_ROLES[fromPaneId] || `Pane ${fromPaneId}`,
      to: toPaneId,
      toRole: PANE_ROLES[toPaneId] || `Pane ${toPaneId}`,
      content,
      type,
      timestamp: new Date().toISOString(),
      delivered: false,
      deliveredAt: null,
    };

    // Append message
    messages.push(message);

    // Keep only last 100 messages per queue
    if (messages.length > 100) {
      messages = messages.slice(-100);
    }

    // Atomic write
    const tempPath = queueFile + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tempPath, queueFile);

    log.info('MessageQueue', `${PANE_ROLES[fromPaneId]} → ${PANE_ROLES[toPaneId]}: ${content.substring(0, 50)}...`);

    // Notify renderer of new message
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('message-queued', message);
    }

    // Organic UI: Track message routing
    organicUI.messageQueued(messageId, fromPaneId, toPaneId);

    return { success: true, messageId, message };
  } catch (err) {
    log.error('MessageQueue', `Error sending message: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Mark a message as delivered
 * @param {string} paneId - Pane ID
 * @param {string} messageId - Message ID to mark
 * @returns {{ success: boolean }}
 */
function markMessageDelivered(paneId, messageId) {
  const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${paneId}.json`);

  try {
    if (!fs.existsSync(queueFile)) {
      return { success: false, error: 'Queue not found' };
    }

    const content = fs.readFileSync(queueFile, 'utf-8');
    const messages = JSON.parse(content);

    const message = messages.find(m => m.id === messageId);
    if (!message) {
      return { success: false, error: 'Message not found' };
    }

    message.delivered = true;
    message.deliveredAt = new Date().toISOString();

    // Atomic write
    const tempPath = queueFile + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tempPath, queueFile);

    log.info('MessageQueue', `Marked delivered: ${messageId}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('message-delivered', { paneId, messageId });
    }

    // Organic UI: Track message delivery
    organicUI.messageDelivered(messageId);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Clear messages for a pane
 * @param {string} paneId - Pane ID (or 'all' for all panes)
 * @param {boolean} deliveredOnly - Only clear delivered messages
 */
function clearMessages(paneId, deliveredOnly = false) {
  try {
    const panes = paneId === 'all' ? PANE_IDS : [paneId];

    for (const p of panes) {
      const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${p}.json`);
      if (!fs.existsSync(queueFile)) continue;

      if (deliveredOnly) {
        const content = fs.readFileSync(queueFile, 'utf-8');
        const messages = JSON.parse(content).filter(m => !m.delivered);
        fs.writeFileSync(queueFile, JSON.stringify(messages, null, 2), 'utf-8');
      } else {
        fs.writeFileSync(queueFile, '[]', 'utf-8');
      }
    }

    log.info('MessageQueue', `Cleared messages for ${paneId}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('messages-cleared', { paneId, deliveredOnly });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get message queue status
 * @returns {{ queues: Object, totalMessages: number, undelivered: number }}
 */
function getMessageQueueStatus() {
  const status = {
    queues: {},
    totalMessages: 0,
    undelivered: 0,
  };

  for (const paneId of PANE_IDS) {
    const messages = getMessages(paneId);
    const undelivered = messages.filter(m => !m.delivered);

    status.queues[paneId] = {
      role: PANE_ROLES[paneId],
      total: messages.length,
      undelivered: undelivered.length,
      latest: messages.length > 0 ? messages[messages.length - 1] : null,
    };

    status.totalMessages += messages.length;
    status.undelivered += undelivered.length;
  }

  return status;
}

function buildPendingMessageKey(paneId, messageId) {
  return `${String(paneId)}:${String(messageId)}`;
}

function createMessageDeliveryId(paneId, messageId, attempt) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `queue-${paneId}-${messageId}-${Date.now()}-a${attempt}-${suffix}`;
}

function clearPendingMessageDeliveryTimers(entry) {
  if (!entry) return;
  if (entry.ackTimer) {
    clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
  }
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  if (entry.markRetryTimer) {
    clearTimeout(entry.markRetryTimer);
    entry.markRetryTimer = null;
  }
}

function clearPendingMessageDelivery(entry) {
  if (!entry) return;
  clearPendingMessageDeliveryTimers(entry);
  if (entry.deliveryId) {
    pendingMessageDeliveryById.delete(entry.deliveryId);
    entry.deliveryId = null;
  }
  pendingMessageDeliveries.delete(entry.key);
}

function scheduleMessageDeliveryRetry(entry, reason) {
  if (!entry || !pendingMessageDeliveries.has(entry.key)) return;

  if (entry.ackTimer) {
    clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
  }
  if (entry.deliveryId) {
    pendingMessageDeliveryById.delete(entry.deliveryId);
    entry.deliveryId = null;
  }

  const previousDelay = Number(entry.retryDelayMs) || 0;
  const nextDelay = previousDelay > 0
    ? Math.min(MESSAGE_DELIVERY_RETRY_MAX_MS, previousDelay * 2)
    : MESSAGE_DELIVERY_RETRY_BASE_MS;
  entry.retryDelayMs = nextDelay;
  entry.lastError = reason || 'retry';

  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
  }
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    attemptQueueMessageDelivery(entry);
  }, nextDelay);

  log.warn(
    'MessageQueue',
    `Delivery retry scheduled for ${entry.messageId} (pane ${entry.paneId}) in ${nextDelay}ms: ${entry.lastError}`
  );
}

function attemptMarkQueueMessageDelivered(entry) {
  if (!entry || !pendingMessageDeliveries.has(entry.key)) return;

  const result = markMessageDelivered(entry.paneId, entry.messageId);
  if (result.success) {
    clearPendingMessageDelivery(entry);
    return;
  }

  // Queue was modified externally; treat "not found" as already handled.
  const queueMessages = getMessages(entry.paneId, false);
  const stillExists = queueMessages.some((msg) => msg.id === entry.messageId);
  if (!stillExists) {
    clearPendingMessageDelivery(entry);
    return;
  }

  const previousDelay = Number(entry.markRetryDelayMs) || 0;
  const nextDelay = previousDelay > 0
    ? Math.min(MESSAGE_MARK_DELIVERED_RETRY_MAX_MS, previousDelay * 2)
    : MESSAGE_MARK_DELIVERED_RETRY_BASE_MS;
  entry.markRetryDelayMs = nextDelay;

  if (entry.markRetryTimer) {
    clearTimeout(entry.markRetryTimer);
  }
  entry.markRetryTimer = setTimeout(() => {
    entry.markRetryTimer = null;
    attemptMarkQueueMessageDelivered(entry);
  }, nextDelay);

  log.warn(
    'MessageQueue',
    `Failed to mark delivered for ${entry.messageId} (pane ${entry.paneId}); retrying in ${nextDelay}ms: ${result.error || 'unknown'}`
  );
}

function handleTriggerDeliveryAck(deliveryId, paneId) {
  if (typeof deliveryId !== 'string' || !deliveryId) return;
  const key = pendingMessageDeliveryById.get(deliveryId);
  if (!key) return;

  const entry = pendingMessageDeliveries.get(key);
  pendingMessageDeliveryById.delete(deliveryId);
  if (!entry) return;

  if (entry.deliveryId !== deliveryId) return;

  if (paneId && String(paneId) !== String(entry.paneId)) {
    log.warn(
      'MessageQueue',
      `Delivery ACK pane mismatch for ${entry.messageId}: expected ${entry.paneId}, got ${paneId}`
    );
  }

  if (entry.ackTimer) {
    clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
  }
  entry.deliveryId = null;
  entry.retryDelayMs = 0;
  attemptMarkQueueMessageDelivered(entry);
}

function attemptQueueMessageDelivery(entry) {
  if (!entry || !pendingMessageDeliveries.has(entry.key)) return;
  if (!triggers || typeof triggers.notifyAgents !== 'function') {
    scheduleMessageDeliveryRetry(entry, 'triggers_unavailable');
    return;
  }

  entry.attempt += 1;
  const deliveryId = createMessageDeliveryId(entry.paneId, entry.messageId, entry.attempt);
  entry.deliveryId = deliveryId;
  pendingMessageDeliveryById.set(deliveryId, entry.key);

  let notified = [];
  try {
    notified = triggers.notifyAgents([entry.paneId], entry.formattedMessage, { deliveryId });
  } catch (err) {
    pendingMessageDeliveryById.delete(deliveryId);
    entry.deliveryId = null;
    scheduleMessageDeliveryRetry(entry, err.message || 'notify_failed');
    return;
  }

  const deliveredToTarget = Array.isArray(notified)
    && notified.some((pane) => String(pane) === String(entry.paneId));
  if (!deliveredToTarget) {
    pendingMessageDeliveryById.delete(deliveryId);
    entry.deliveryId = null;
    scheduleMessageDeliveryRetry(entry, 'target_not_available');
    return;
  }

  if (entry.ackTimer) {
    clearTimeout(entry.ackTimer);
  }
  entry.ackTimer = setTimeout(() => {
    entry.ackTimer = null;
    if (!pendingMessageDeliveries.has(entry.key)) return;
    if (entry.deliveryId !== deliveryId) return;
    pendingMessageDeliveryById.delete(deliveryId);
    entry.deliveryId = null;
    scheduleMessageDeliveryRetry(entry, 'ack_timeout');
  }, MESSAGE_DELIVERY_ACK_TIMEOUT_MS);

  log.info(
    'MessageQueue',
    `Queued delivery ${entry.messageId} to pane ${entry.paneId} (attempt ${entry.attempt})`
  );
}

function queueMessageForTrackedDelivery(paneId, message) {
  const key = buildPendingMessageKey(paneId, message.id);
  if (pendingMessageDeliveries.has(key)) {
    return;
  }

  const fromRole = message.fromRole || (PANE_ROLES[message.from] || `Pane ${message.from}`);
  const entry = {
    key,
    paneId: String(paneId),
    messageId: String(message.id),
    formattedMessage: `[MSG from ${fromRole}]: ${message.content}`,
    deliveryId: null,
    attempt: 0,
    retryDelayMs: 0,
    markRetryDelayMs: 0,
    lastError: null,
    ackTimer: null,
    retryTimer: null,
    markRetryTimer: null,
  };

  pendingMessageDeliveries.set(key, entry);
  attemptQueueMessageDelivery(entry);
}

function clearPendingMessageDeliveries() {
  for (const entry of pendingMessageDeliveries.values()) {
    clearPendingMessageDeliveryTimers(entry);
  }
  pendingMessageDeliveries.clear();
  pendingMessageDeliveryById.clear();
}

function registerTriggerDeliveryAckListener() {
  if (unsubscribeTriggerDeliveryAck) {
    unsubscribeTriggerDeliveryAck();
    unsubscribeTriggerDeliveryAck = null;
  }

  if (triggers && typeof triggers.onDeliveryAck === 'function') {
    unsubscribeTriggerDeliveryAck = triggers.onDeliveryAck(handleTriggerDeliveryAck);
  }
}

/**
 * Handle message queue file changes
 * @param {string} filePath - Path to changed queue file
 */
function handleMessageQueueChange(filePath) {
  const filename = path.basename(filePath);
  const match = filename.match(/queue-(\d+)\.json/);

  if (!match) return;

  const paneId = match[1];
  const undelivered = getMessages(paneId, true);

  if (undelivered.length > 0) {
    log.info('MessageQueue', `${undelivered.length} undelivered message(s) for pane ${paneId}`);

    // Notify renderer to process messages
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('messages-pending', {
        paneId,
        count: undelivered.length,
        messages: undelivered,
      });
    }

    // Direct messages bypass workflow gate
    // Inject messages directly to running Claude instances
    if (triggers) {
      for (const msg of undelivered) {
        if (msg.type === 'direct' || msg.type === 'broadcast') {
          queueMessageForTrackedDelivery(paneId, msg);
        }
      }
    }
  }
}

/**
 * Start watching message queue directory
 */
function startMessageWatcher() {
  // Ensure directory exists
  const initResult = initMessageQueue();
  if (!initResult.success) {
    log.error('MessageQueue', 'Skipping watcher start - init failed', initResult.error);
    return;
  }

  if (messageWatcher) {
    stopWatcherWorker('message', 'message', { reason: 'restart', clearRestart: false });
  }
  registerTriggerDeliveryAckListener();

  messageWatcher = startWatcherWorker(
    'message',
    (filePath, eventType) => {
      if (eventType === 'add' || eventType === 'change') {
        handleMessageQueueChange(filePath);
      }
    },
    () => startMessageWatcher()
  );

  log.info('MessageQueue', `Watching ${MESSAGE_QUEUE_DIR}`);
}

/**
 * Stop message queue watcher
 */
function stopMessageWatcher() {
  stopWatcherWorker('message', 'message');
  if (unsubscribeTriggerDeliveryAck) {
    unsubscribeTriggerDeliveryAck();
    unsubscribeTriggerDeliveryAck = null;
  }
  clearPendingMessageDeliveries();
}

module.exports = {
  // Initialization
  init,

  // State constants
  States,
  ACTIVE_AGENTS,
  CONTEXT_MESSAGES,

  // State functions
  readState,
  writeState,
  transition,

  // Conflict detection
  checkFileConflicts,
  getLastConflicts,

  // Agent claims
  claimAgent,
  releaseAgent,
  getClaims,
  clearClaims,

  // Message queue
  initMessageQueue,
  sendMessage,
  getMessages,
  markMessageDelivered,
  clearMessages,
  getMessageQueueStatus,
  MESSAGE_QUEUE_DIR,

  // Watcher control
  startWatcher,
  stopWatcher,
  startMessageWatcher,
  stopMessageWatcher,
  handleFileChange: handleFileChangeDebounced,  // Export debounced version for external callers
  addWatch,
  removeWatch,

  // UX-9: Fast trigger watcher
  startTriggerWatcher,
  stopTriggerWatcher,
  TRIGGER_PATH,
  setExternalNotifier,
};
