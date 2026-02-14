/**
 * Pipeline - Conversation-aware pipeline state machine
 * Watches agent messages and auto-drives work through stages:
 *   proposed -> accepted -> assigned -> implementing -> review_pending -> approved -> committed
 *
 * Observes cross-pane messages and drives state transitions.
 * Uses hybrid detection: structured tags (preferred) + keyword fallback.
 * Persists state to workspace/pipeline.json (atomic writes).
 * Emits IPC events for UI observability.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');
const log = require('./logger');

function getPipelinePath(options = {}) {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath('pipeline.json', options);
  }
  return path.join(WORKSPACE_PATH, 'pipeline.json');
}
const PIPELINE_MAX_ITEMS = 50;
const MIN_MESSAGE_LENGTH = 10;

// Ordered stages - transitions can only move forward
const STAGES = ['proposed', 'accepted', 'assigned', 'implementing', 'review_pending', 'approved', 'committed'];

// Structured tag detection (explicit, preferred - always wins over keywords)
const STRUCTURED_TAGS = {
  proposed: /\[PROPOSAL\]/i,
  accepted: /\[ACCEPT\]/i,
  assigned: /\[ASSIGNED\]/i,
  review_pending: /\[DONE\]|\[REVIEW\]/i,
  approved: /\[APPROVED\]/i,
};

// Keyword fallback detection (natural language, requires sender context + min length)
const KEYWORD_PATTERNS = {
  proposed: /\b(?:we should|i'll|let me|plan to|suggest we)\b/i,
  accepted: /\b(?:agreed|go ahead|sounds good|yes let'?s|approved)\b/i,
  assigned: /\b(?:i'll take this|assigning to|assigned to)\b/i,
  implementing: /\b(?:working on|starting|implementing)\b/i,
  review_pending: /\b(?:done|finished|completed|ready for review)\b/i,
};

// System/non-agent labels that should not trigger keyword detection
const SYSTEM_LABELS = new Set(['SYSTEM', 'UNKNOWN', 'YOU']);

// Shared state
let pipelineItems = [];
let mainWindow = null;
let sendDirectMessageFn = null;
let processing = false;

/**
 * Generate a unique pipeline item ID
 */
function generateId() {
  const ts = Math.floor(Date.now() / 1000);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `pipe-${ts}-${suffix}`;
}

/**
 * Get the index of a stage in the ordered STAGES array
 */
function stageIndex(stage) {
  return STAGES.indexOf(stage);
}

/**
 * Check if a transition from currentStage to newStage is valid (forward only)
 */
function isValidTransition(currentStage, newStage) {
  const currentIdx = stageIndex(currentStage);
  const newIdx = stageIndex(newStage);
  if (currentIdx === -1 || newIdx === -1) return false;
  return newIdx > currentIdx;
}

/**
 * Extract a short excerpt from a message (max 120 chars)
 */
function excerpt(msg) {
  if (!msg) return '';
  const clean = String(msg).replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.substring(0, 117) + '...' : clean;
}

/**
 * Extract a title from a proposal message.
 * Tries to find meaningful content after the tag or uses first sentence.
 */
function extractTitle(msg) {
  if (!msg) return 'Untitled';
  // Remove AGENT_MESSAGE_PREFIX (handles both with and without trailing space)
  let clean = String(msg).replace(/^\[AGENT MSG - reply via hm-send\.js\]\s*/i, '').trim();
  // Remove structured tags
  clean = clean.replace(/\[(?:PROPOSAL|ACCEPT|DONE|REVIEW|APPROVED|ASSIGNED)\]/gi, '').trim();
  // Remove role prefix like (ARCH #1): or (ANA -> DEVOPS #2):
  // Optimized regex to handle sequence and arrow indicators
  clean = clean.replace(/^\([^)]*#\d+\):\s*/, '').trim();
  clean = clean.replace(/^\([^)]*\):\s*/, '').trim();
  // Take first sentence or first 80 chars
  const firstSentence = clean.split(/[.!?\n]/)[0].trim();
  if (firstSentence.length > 80) return firstSentence.substring(0, 77) + '...';
  return firstSentence || 'Untitled';
}

/**
 * Detect stage from a message entry using hybrid detection.
 * Returns { stage, method } or null if no stage detected.
 */
function detectStage(entry) {
  if (!entry || !entry.msg) return null;
  const msg = String(entry.msg);

  // 1. Structured tags always win (explicit, preferred)
  for (const [stage, regex] of Object.entries(STRUCTURED_TAGS)) {
    if (regex.test(msg)) {
      return { stage, method: 'structured' };
    }
  }

  // 2. Keyword fallback: requires non-system sender and minimum message length
  if (SYSTEM_LABELS.has(entry.from)) return null;
  if (msg.length < MIN_MESSAGE_LENGTH) return null;

  for (const [stage, regex] of Object.entries(KEYWORD_PATTERNS)) {
    if (regex.test(msg)) {
      return { stage, method: 'keyword' };
    }
  }

  return null;
}

/**
 * Find an active (non-committed) pipeline item that matches context.
 * Uses sender and recent activity to find the best match.
 */
function findActivePipelineItem(entry) {
  // Find most recent non-committed item (LIFO - latest item is most relevant)
  for (let i = pipelineItems.length - 1; i >= 0; i--) {
    const item = pipelineItems[i];
    if (item.stage !== 'committed') {
      return item;
    }
  }
  return null;
}

/**
 * Create a new pipeline item from a proposal
 */
function createPipelineItem(entry) {
  const item = {
    id: generateId(),
    title: extractTitle(entry.msg),
    proposedBy: entry.from || 'unknown',
    assignedTo: null,
    stage: 'proposed',
    messages: [{
      ts: entry.ts || Math.floor(Date.now() / 1000),
      from: entry.from || 'unknown',
      stage: 'proposed',
      excerpt: excerpt(entry.msg),
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  pipelineItems.push(item);
  if (pipelineItems.length > PIPELINE_MAX_ITEMS) {
    pipelineItems = pipelineItems.slice(-PIPELINE_MAX_ITEMS);
  }

  log.info('Pipeline', `New item created: ${item.id} - "${item.title}" by ${item.proposedBy}`);
  emitUpdate(item, 'proposed', null);
  savePipeline();
  return item;
}

/**
 * Advance a pipeline item to a new stage
 */
function advanceStage(item, newStage, entry) {
  const oldStage = item.stage;
  if (!isValidTransition(oldStage, newStage)) {
    log.debug('Pipeline', `Ignoring invalid transition ${oldStage} -> ${newStage} for ${item.id}`);
    return false;
  }

  item.stage = newStage;
  item.updatedAt = new Date().toISOString();
  item.messages.push({
    ts: entry.ts || Math.floor(Date.now() / 1000),
    from: entry.from || 'unknown',
    stage: newStage,
    excerpt: excerpt(entry.msg),
  });

  log.info('Pipeline', `${item.id} stage: ${oldStage} -> ${newStage}`);
  emitUpdate(item, newStage, oldStage);
  handleAutoNotifications(item, newStage, oldStage);
  savePipeline();
  return true;
}

/**
 * Handle automatic notifications on stage transitions
 */
function handleAutoNotifications(item, newStage, oldStage) {
  if (typeof sendDirectMessageFn !== 'function') return;

  // implementing -> review_pending: auto-send review request to Architect (pane 1)
  if (newStage === 'review_pending') {
    const msg = `[PIPELINE] "${item.title}" is ready for review (from ${item.assignedTo || item.proposedBy}). Pipeline ID: ${item.id}`;
    try {
      sendDirectMessageFn(['1'], msg, 'Pipeline');
      log.info('Pipeline', `Auto-notified Architect for review: ${item.id}`);
    } catch (err) {
      log.warn('Pipeline', `Failed to notify Architect: ${err.message}`);
    }
  }

  // review_pending -> approved: auto-notify Architect to commit
  if (newStage === 'approved') {
    const msg = `[PIPELINE] "${item.title}" has been APPROVED. Ready to commit. Pipeline ID: ${item.id}`;
    try {
      sendDirectMessageFn(['1'], msg, 'Pipeline');
      log.info('Pipeline', `Auto-notified Architect to commit: ${item.id}`);
    } catch (err) {
      log.warn('Pipeline', `Failed to notify for commit: ${err.message}`);
    }
  }
}

/**
 * Emit IPC events for UI observability
 */
function emitUpdate(item, newStage, oldStage) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    mainWindow.webContents.send('pipeline-update', {
      item: { ...item },
      timestamp: new Date().toISOString(),
    });

    if (oldStage !== null) {
      mainWindow.webContents.send('pipeline-stage-change', {
        itemId: item.id,
        from: oldStage,
        to: newStage,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.warn('Pipeline', `Failed to emit IPC event: ${err.message}`);
  }
}

/**
 * Main entry point: called after recording each message.
 * Observes the message and drives pipeline state transitions.
 */
function onMessage(entry) {
  if (!entry || !entry.msg) return;
  if (processing) return;

  processing = true;
  try {
    const detection = detectStage(entry);
    if (!detection) return;

    const { stage: detectedStage } = detection;

    // If it's a proposal, create a new pipeline item
    if (detectedStage === 'proposed') {
      createPipelineItem(entry);
      return;
    }

    // For all other stages, find an active item to advance
    const item = findActivePipelineItem(entry);
    if (!item) {
      log.debug('Pipeline', `No active pipeline item for detected stage "${detectedStage}"`);
      return;
    }

    // Handle assigned: also set assignedTo from context
    if (detectedStage === 'assigned' || detectedStage === 'implementing') {
      if (!item.assignedTo && entry.to && entry.to !== 'ALL') {
        item.assignedTo = entry.to;
      }
    }

    advanceStage(item, detectedStage, entry);
  } finally {
    processing = false;
  }
}

/**
 * Mark a pipeline item as committed (called by Architect after git commit)
 */
function markCommitted(itemId) {
  const item = pipelineItems.find(i => i.id === itemId);
  if (!item) {
    log.warn('Pipeline', `Cannot mark committed: item ${itemId} not found`);
    return false;
  }

  const entry = {
    ts: Math.floor(Date.now() / 1000),
    from: 'ARCH',
    msg: 'Committed',
  };

  return advanceStage(item, 'committed', entry);
}

/**
 * Get all pipeline items (optionally filtered by stage)
 */
function getItems(stageFilter) {
  if (stageFilter) {
    return pipelineItems.filter(i => i.stage === stageFilter);
  }
  return [...pipelineItems];
}

/**
 * Get a single pipeline item by ID
 */
function getItem(itemId) {
  return pipelineItems.find(i => i.id === itemId) || null;
}

/**
 * Get active (non-committed) pipeline items
 */
function getActiveItems() {
  return pipelineItems.filter(i => i.stage !== 'committed');
}

/**
 * Load pipeline state from disk
 */
function loadPipeline() {
  try {
    const pipelinePath = getPipelinePath();
    if (!fs.existsSync(pipelinePath)) {
      pipelineItems = [];
      return;
    }
    const raw = fs.readFileSync(pipelinePath, 'utf-8');
    const data = JSON.parse(raw);
    pipelineItems = Array.isArray(data.items) ? data.items : [];
    log.info('Pipeline', `Loaded ${pipelineItems.length} pipeline items`);
  } catch (err) {
    log.warn('Pipeline', `Failed to load pipeline state: ${err.message}`);
    pipelineItems = [];
  }
}

/**
 * Save pipeline state to disk (atomic write: write to .tmp then rename)
 */
function savePipeline() {
  try {
    const pipelinePath = getPipelinePath({ forWrite: true });
    const data = {
      version: 1,
      items: pipelineItems,
      lastUpdated: new Date().toISOString(),
    };
    const tempPath = pipelinePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, pipelinePath);
  } catch (err) {
    log.warn('Pipeline', `Failed to save pipeline state: ${err.message}`);
  }
}

/**
 * Initialize the pipeline module
 */
function init(options = {}) {
  if (options.mainWindow) mainWindow = options.mainWindow;
  if (options.sendDirectMessage) sendDirectMessageFn = options.sendDirectMessage;
  loadPipeline();
  log.info('Pipeline', 'Pipeline module initialized');
}

/**
 * Update mainWindow reference (e.g., after window recreation)
 */
function setMainWindow(win) {
  mainWindow = win;
}

module.exports = {
  init,
  setMainWindow,
  onMessage,
  markCommitted,
  getItems,
  getItem,
  getActiveItems,
  detectStage,
  isValidTransition,
  extractTitle,
  // Exported for testing
  STAGES,
  STRUCTURED_TAGS,
  KEYWORD_PATTERNS,
};
