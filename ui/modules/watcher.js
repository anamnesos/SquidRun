/**
 * File watcher and state machine
 * Extracted from main.js for modularization
 */

const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { WORKSPACE_PATH, TRIGGER_TARGETS } = require('../config');

const STATE_FILE_PATH = path.join(WORKSPACE_PATH, 'state.json');
const SHARED_CONTEXT_PATH = path.join(WORKSPACE_PATH, 'shared_context.md');

// V10 MQ4: Message queue directory
const MESSAGE_QUEUE_DIR = path.join(WORKSPACE_PATH, 'messages');

// Module state (set by init)
let mainWindow = null;
let workspaceWatcher = null;
let messageWatcher = null; // V10 MQ4: Separate watcher for message queues
let triggers = null; // Reference to triggers module

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

// Active agents per state (pane IDs: 1=Lead, 2=WorkerA, 3=WorkerB, 4=Reviewer)
const ACTIVE_AGENTS = {
  [States.IDLE]: [],
  [States.PROJECT_SELECTED]: ['1'],
  [States.PLANNING]: ['1'],
  [States.PLAN_REVIEW]: ['4'],
  [States.PLAN_REVISION]: ['1'],
  [States.EXECUTING]: ['2', '3'],
  [States.CHECKPOINT]: [],
  [States.CHECKPOINT_REVIEW]: ['4'],
  [States.CHECKPOINT_FIX]: ['1', '2', '3'],
  [States.FRICTION_LOGGED]: [],
  [States.FRICTION_SYNC]: [],
  [States.FRICTION_RESOLUTION]: ['1'],
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
    const wA = c.match(/### Worker A[\s\S]*?(?=###|$)/i);
    const wB = c.match(/### Worker B[\s\S]*?(?=###|$)/i);
    if (wA) a['Worker A'] = extractFilePaths(wA[0]);
    if (wB) a['Worker B'] = extractFilePaths(wB[0]);
    return a;
  } catch (e) { return {}; }
}

function checkFileConflicts() {
  const a = parseWorkerAssignments();
  const conflicts = [];
  const fA = a['Worker A'] || [], fB = a['Worker B'] || [];
  for (const f of fA) if (fB.includes(f)) conflicts.push({ file: f, workers: ['A', 'B'] });
  lastConflicts = conflicts;
  if (conflicts.length && mainWindow && !mainWindow.isDestroyed()) {
    console.warn('[Conflict]', conflicts.map(c => c.file));
    mainWindow.webContents.send('file-conflicts-detected', conflicts);
  }
  return conflicts;
}

function getLastConflicts() {
  return lastConflicts;
}

// ============================================================
// V6 CR1: CONFLICT QUEUE SYSTEM
// ============================================================

// Queue of pending file operations during conflicts
const conflictQueue = new Map(); // file -> [{ paneId, operation, timestamp, callback }]
const activeFileLocks = new Map(); // file -> paneId (who currently has lock)

/**
 * Request access to a file for an operation
 * @param {string} filePath - File being accessed
 * @param {string} paneId - Agent requesting access
 * @param {string} operation - 'read' | 'write' | 'edit'
 * @returns {{ granted: boolean, position?: number, lockHolder?: string }}
 */
function requestFileAccess(filePath, paneId, operation) {
  const normalizedPath = filePath.toLowerCase();

  // If no lock exists, grant immediately
  if (!activeFileLocks.has(normalizedPath)) {
    if (operation === 'write' || operation === 'edit') {
      activeFileLocks.set(normalizedPath, paneId);
      console.log(`[ConflictQueue] Lock granted: ${paneId} -> ${filePath}`);
    }
    return { granted: true };
  }

  const lockHolder = activeFileLocks.get(normalizedPath);

  // If same agent holds lock, allow
  if (lockHolder === paneId) {
    return { granted: true };
  }

  // Read operations can proceed even with write lock (eventual consistency)
  if (operation === 'read') {
    return { granted: true, warning: `File locked by pane ${lockHolder}` };
  }

  // Queue the write/edit operation
  if (!conflictQueue.has(normalizedPath)) {
    conflictQueue.set(normalizedPath, []);
  }

  const queue = conflictQueue.get(normalizedPath);
  const position = queue.length + 1;

  queue.push({
    paneId,
    operation,
    timestamp: new Date().toISOString(),
    filePath,
  });

  console.log(`[ConflictQueue] Queued: ${paneId} waiting for ${filePath} (position ${position})`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conflict-queued', {
      filePath,
      paneId,
      position,
      lockHolder,
    });
  }

  return { granted: false, position, lockHolder };
}

/**
 * Release a file lock
 * @param {string} filePath - File to release
 * @param {string} paneId - Agent releasing lock
 * @returns {{ released: boolean, nextInQueue?: object }}
 */
function releaseFileAccess(filePath, paneId) {
  const normalizedPath = filePath.toLowerCase();

  // Only lock holder can release
  if (activeFileLocks.get(normalizedPath) !== paneId) {
    return { released: false, error: 'Not lock holder' };
  }

  activeFileLocks.delete(normalizedPath);
  console.log(`[ConflictQueue] Lock released: ${paneId} -> ${filePath}`);

  // Check if anyone is waiting
  const queue = conflictQueue.get(normalizedPath);
  if (queue && queue.length > 0) {
    const next = queue.shift();

    // Grant lock to next in queue
    activeFileLocks.set(normalizedPath, next.paneId);
    console.log(`[ConflictQueue] Lock granted to queued: ${next.paneId} -> ${filePath}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conflict-resolved', {
        filePath,
        paneId: next.paneId,
        operation: next.operation,
      });
    }

    // Clean up empty queue
    if (queue.length === 0) {
      conflictQueue.delete(normalizedPath);
    }

    return { released: true, nextInQueue: next };
  }

  return { released: true };
}

/**
 * Get current queue status
 * @returns {{ locks: Object, queues: Object }}
 */
function getConflictQueueStatus() {
  const locks = {};
  for (const [file, paneId] of activeFileLocks) {
    locks[file] = paneId;
  }

  const queues = {};
  for (const [file, queue] of conflictQueue) {
    queues[file] = queue.map((item, idx) => ({
      ...item,
      position: idx + 1,
    }));
  }

  return { locks, queues, lockCount: activeFileLocks.size, queuedCount: conflictQueue.size };
}

/**
 * Force release all locks (for Fresh Start)
 */
function clearAllLocks() {
  const count = activeFileLocks.size + conflictQueue.size;
  activeFileLocks.clear();
  conflictQueue.clear();
  console.log(`[ConflictQueue] Cleared all locks and queues (${count} items)`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('conflicts-cleared');
  }

  return { success: true, cleared: count };
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
    console.error('Error reading state:', err);
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
    // V4 CB2: Agent claims
    claims: {},
  };
}

// ============================================================
// V4 CB2: AGENT CLAIM/RELEASE PROTOCOL
// ============================================================

const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };

/**
 * Claim an agent role for a task
 * @param {string} paneId - The pane/agent ID (1-4)
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
  console.log(`[Claims] ${PANE_ROLES[paneId]} claimed task: ${taskId}`);

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
    console.log(`[Claims] ${PANE_ROLES[paneId]} released claim`);
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

  console.log('[Claims] All claims cleared');

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
    console.error('Error writing state:', err);
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
  console.log(`[State Machine] ${oldState} → ${newState}`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', state);
  }

  // Notify active agents
  const message = CONTEXT_MESSAGES[newState];
  if (message && triggers) {
    triggers.notifyAgents(state.active_agents, message);
  }
}

// ============================================================
// FILE CHANGE HANDLER
// ============================================================

function handleFileChange(filePath) {
  const filename = path.basename(filePath);
  const state = readState();
  const currentState = state.state;

  console.log(`[Watcher] File changed: ${filename} (current state: ${currentState})`);

  // Transition logic based on file + current state
  if (filename === 'plan.md' && currentState === States.PLANNING) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename === 'plan-approved.md' && currentState === States.PLAN_REVIEW) {
    const conflicts = checkFileConflicts();
    if (conflicts.length > 0) {
      console.warn('[Transition] Proceeding to EXECUTING with file conflicts');
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
    const checkpointContent = fs.readFileSync(filePath, 'utf-8').toLowerCase();
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
  else if (filename === 'friction-resolution.md' && currentState === States.FRICTION_RESOLUTION) {
    transition(States.PLAN_REVIEW);
  }

  // AUTO-SYNC TRIGGERS
  else if (filename === 'improvements.md' && triggers) {
    console.log('[Watcher] Improvements file changed - triggering auto-sync to all agents');
    triggers.notifyAllAgentsSync('improvements.md');
  }
  else if (filename === 'shared_context.md' && triggers) {
    console.log('[Watcher] Shared context changed - triggering auto-sync to all agents');
    triggers.notifyAllAgentsSync('shared_context.md');
  }

  // TARGETED TRIGGERS: workspace/triggers/{target}.txt
  else if (filePath.includes('triggers') && filename.endsWith('.txt') && triggers) {
    triggers.handleTriggerFile(filePath, filename);
  }
}

// ============================================================
// WATCHER CONTROL
// ============================================================

function startWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close();
  }

  workspaceWatcher = chokidar.watch(WORKSPACE_PATH, {
    ignoreInitial: true,
    persistent: true,
    ignored: [
      /node_modules/,
      /\.git/,
      /instances\//,
      /state\.json$/,
    ],
  });

  workspaceWatcher.on('add', handleFileChange);
  workspaceWatcher.on('change', handleFileChange);

  console.log(`[Watcher] Watching ${WORKSPACE_PATH}`);
}

function stopWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
}

/**
 * Initialize the watcher module with shared state
 * @param {BrowserWindow} window - The main Electron window
 * @param {Object} triggersModule - The triggers module reference
 */
function init(window, triggersModule) {
  mainWindow = window;
  triggers = triggersModule;
}

// ============================================================
// V10 MQ4: MESSAGE QUEUE FILE WATCHER
// ============================================================

/**
 * Initialize message queue directory
 */
function initMessageQueue() {
  if (!fs.existsSync(MESSAGE_QUEUE_DIR)) {
    fs.mkdirSync(MESSAGE_QUEUE_DIR, { recursive: true });
    console.log('[MessageQueue] Created message directory');
  }

  // Create queue files for each pane if they don't exist
  for (const paneId of ['1', '2', '3', '4']) {
    const queueFile = path.join(MESSAGE_QUEUE_DIR, `queue-${paneId}.json`);
    if (!fs.existsSync(queueFile)) {
      fs.writeFileSync(queueFile, '[]', 'utf-8');
    }
  }

  return { success: true, path: MESSAGE_QUEUE_DIR };
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
    console.error(`[MessageQueue] Error reading queue for pane ${paneId}:`, err.message);
    return [];
  }
}

/**
 * Send a message to a pane (append to queue)
 * V10 MQ5: Direct messages bypass workflow gate
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
      initMessageQueue();
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

    console.log(`[MessageQueue] ${PANE_ROLES[fromPaneId]} → ${PANE_ROLES[toPaneId]}: ${content.substring(0, 50)}...`);

    // Notify renderer of new message
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('message-queued', message);
    }

    return { success: true, messageId, message };
  } catch (err) {
    console.error(`[MessageQueue] Error sending message:`, err.message);
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

    console.log(`[MessageQueue] Marked delivered: ${messageId}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('message-delivered', { paneId, messageId });
    }

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
    const panes = paneId === 'all' ? ['1', '2', '3', '4'] : [paneId];

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

    console.log(`[MessageQueue] Cleared messages for ${paneId}`);

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

  for (const paneId of ['1', '2', '3', '4']) {
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

/**
 * Handle message queue file changes
 * @param {string} filePath - Path to changed queue file
 */
function handleMessageQueueChange(filePath) {
  const filename = path.basename(filePath);
  const match = filename.match(/queue-(\d)\.json/);

  if (!match) return;

  const paneId = match[1];
  const undelivered = getMessages(paneId, true);

  if (undelivered.length > 0) {
    console.log(`[MessageQueue] ${undelivered.length} undelivered message(s) for pane ${paneId}`);

    // Notify renderer to process messages
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('messages-pending', {
        paneId,
        count: undelivered.length,
        messages: undelivered,
      });
    }

    // V10 MQ5: Direct messages bypass workflow gate
    // Inject messages directly to running Claude instances
    if (triggers) {
      for (const msg of undelivered) {
        if (msg.type === 'direct' || msg.type === 'broadcast') {
          // Format message for terminal injection
          const formattedMsg = `[MSG from ${msg.fromRole}]: ${msg.content}`;

          // Use triggers to inject (bypass gate for direct messages)
          triggers.notifyAgents([paneId], formattedMsg);

          // Mark as delivered
          markMessageDelivered(paneId, msg.id);
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
  initMessageQueue();

  if (messageWatcher) {
    messageWatcher.close();
  }

  messageWatcher = chokidar.watch(MESSAGE_QUEUE_DIR, {
    ignoreInitial: true,
    persistent: true,
  });

  messageWatcher.on('change', handleMessageQueueChange);
  messageWatcher.on('add', handleMessageQueueChange);

  console.log(`[MessageQueue] Watching ${MESSAGE_QUEUE_DIR}`);
}

/**
 * Stop message queue watcher
 */
function stopMessageWatcher() {
  if (messageWatcher) {
    messageWatcher.close();
    messageWatcher = null;
  }
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

  // V4 CB2: Agent claims
  claimAgent,
  releaseAgent,
  getClaims,
  clearClaims,

  // V6 CR1: Conflict queue
  requestFileAccess,
  releaseFileAccess,
  getConflictQueueStatus,
  clearAllLocks,

  // V10 MQ4+MQ5: Message queue
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
  handleFileChange,
};
