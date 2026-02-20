/**
 * Triggers - Message Sequencing
 * Extracted from triggers.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORKSPACE_PATH, resolveGlobalPath } = require('../../config');
const log = require('../logger');

const MESSAGE_STATE_PATH = typeof resolveGlobalPath === 'function'
  ? resolveGlobalPath('message-state.json', { forWrite: true })
  : path.join(WORKSPACE_PATH, 'message-state.json');
// Matches the prefix added by squidrun-app (hivemind-app.js) for WebSocket agent messages
const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js] ';
const DELIVERY_ACK_TIMEOUT_MS = 65000;
const pendingDeliveries = new Map();

// In-memory sequence tracking (loaded from file on init)
let messageState = {
  version: 1,
  sequences: {
    'architect': { outbound: 0, lastSeen: {} },
    'builder': { outbound: 0, lastSeen: {} },
    'oracle': { outbound: 0, lastSeen: {} },
  },
};

// Internal reference to recordTimeout (from metrics.js)
let recordTimeoutFn = null;
let recordDeliveredFn = null;

function setMetricsFunctions(timeout, delivered) {
  recordTimeoutFn = timeout;
  recordDeliveredFn = delivered;
}

/**
 * Load message state from disk
 */
function loadMessageState() {
  try {
    log.info('MessageSeq', 'Resetting message state for fresh session');
    // Mutate in-place to keep module.exports.messageState reference valid
    messageState.version = 1;
    messageState.sequences = {
      'architect': { outbound: 0, lastSeen: {} },
      'builder': { outbound: 0, lastSeen: {} },
      'oracle': { outbound: 0, lastSeen: {} },
    };
    saveMessageState();
    log.info('MessageSeq', 'Fresh state initialized');
  } catch (err) {
    log.error('MessageSeq', 'Error initializing state:', err);
  }
}

/**
 * Save message state to disk (atomic write)
 */
function saveMessageState() {
  try {
    messageState.lastUpdated = new Date().toISOString();
    const tempPath = MESSAGE_STATE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(messageState, null, 2), 'utf-8');
    fs.renameSync(tempPath, MESSAGE_STATE_PATH);
  } catch (err) {
    log.error('MessageSeq', 'Error saving state:', err);
  }
}

/**
 * Parse sequence info from message
 * Format: "(ROLE #SEQ): message" per Reviewer spec
 */
function parseMessageSequence(message) {
  // Strip WebSocket agent prefix before parsing (see hivemind-app.js)
  let cleanMessage = message;
  if (message.startsWith(AGENT_MESSAGE_PREFIX)) {
    cleanMessage = message.substring(AGENT_MESSAGE_PREFIX.length);
  }

  const seqMatch = cleanMessage.match(/^\((\w+(?:-\w+)?)\s*#(\d+)\):\s*(.*)$/s);
  if (seqMatch) {
    return {
      seq: parseInt(seqMatch[2], 10),
      sender: seqMatch[1].toLowerCase(),
      content: `(${seqMatch[1]}): ${seqMatch[3]}`, // Strip seq for display
    };
  }

  const roleMatch = cleanMessage.match(/^\((\w+(?:-\w+)?)\):\s*(.*)$/s);
  if (roleMatch) {
    return {
      seq: null,
      sender: roleMatch[1].toLowerCase(),
      content: cleanMessage,
    };
  }

  return { seq: null, sender: null, content: message };
}

/**
 * Check if message is a duplicate
 */
function isDuplicateMessage(sender, seq, recipient) {
  if (seq === null || !sender) return false;

  const recipientState = messageState.sequences[recipient];
  if (!recipientState) return false;

  const lastSeen = recipientState.lastSeen[sender] || 0;
  return seq <= lastSeen;
}

/**
 * Record that we've seen a message sequence
 */
function recordMessageSeen(sender, seq, recipient) {
  if (seq === null || !sender) return;

  if (!messageState.sequences[recipient]) {
    messageState.sequences[recipient] = { outbound: 0, lastSeen: {} };
  }

  const currentLast = messageState.sequences[recipient].lastSeen[sender] || 0;
  if (seq > currentLast) {
    messageState.sequences[recipient].lastSeen[sender] = seq;
    saveMessageState();
  }
}

function createDeliveryId(sender, seq, recipient) {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const safeSender = sender || 'unknown';
  const safeSeq = Number.isInteger(seq) ? String(seq) : 'na';
  const safeRecipient = recipient || 'unknown';
  return `${safeSender}-${safeSeq}-${safeRecipient}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function startDeliveryTracking(deliveryId, sender, seq, recipient, targets, msgType = 'trigger', mode = 'pty') {
  if (!deliveryId) return;
  const expected = new Set((targets || []).map(paneId => String(paneId)));
  const sentAt = Date.now();
  const pending = {
    sender,
    seq,
    recipient,
    expected,
    received: new Set(),
    failed: new Map(),
    timeoutId: null,
    sentAt,
    msgType,
    mode,
  };

  pending.timeoutId = setTimeout(() => {
    pendingDeliveries.delete(deliveryId);
    log.warn('Trigger', `Delivery timeout for ${sender} #${seq} -> ${recipient} (received ${pending.received.size}/${pending.expected.size})`);
    if (recordTimeoutFn) recordTimeoutFn(mode, msgType, Array.from(expected));
  }, DELIVERY_ACK_TIMEOUT_MS);

  pendingDeliveries.set(deliveryId, pending);
}

function handleDeliveryOutcome(deliveryId, paneId, outcome = {}) {
  if (!deliveryId) return;
  const pending = pendingDeliveries.get(deliveryId);
  if (!pending) return;

  const paneKey = String(paneId);
  if (!pending.expected.has(paneKey)) return;

  const accepted = outcome?.accepted !== false;
  if (accepted) {
    pending.received.add(paneKey);
    pending.failed.delete(paneKey);
    if (recordDeliveredFn) recordDeliveredFn(pending.mode, pending.msgType, paneKey, pending.sentAt);
  } else {
    pending.received.delete(paneKey);
    pending.failed.set(paneKey, {
      accepted: false,
      verified: false,
      status: outcome?.status || outcome?.reason || 'delivery_failed',
      reason: outcome?.reason || null,
    });
  }

  const resolvedCount = pending.received.size + pending.failed.size;
  if (resolvedCount < pending.expected.size) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingDeliveries.delete(deliveryId);

  if (pending.failed.size === 0) {
    recordMessageSeen(pending.sender, pending.seq, pending.recipient);
    log.info('Trigger', `Recorded delivery: ${pending.sender} #${pending.seq} -> ${pending.recipient}`);
    return;
  }

  const failedPanes = Array.from(pending.failed.keys());
  const firstFailure = pending.failed.get(failedPanes[0]) || {};
  log.warn(
    'Trigger',
    `Delivery failed for ${pending.sender} #${pending.seq} -> ${pending.recipient} `
    + `(acked ${pending.received.size}/${pending.expected.size}, failed=${failedPanes.join(',') || 'none'}, `
    + `status=${firstFailure.status || 'delivery_failed'})`
  );
}

function handleDeliveryAck(deliveryId, paneId) {
  handleDeliveryOutcome(deliveryId, paneId, {
    accepted: true,
    verified: true,
    status: 'delivered.verified',
  });
}

function getNextSequence(sender) {
  if (!messageState.sequences[sender]) {
    messageState.sequences[sender] = { outbound: 0, lastSeen: {} };
  }
  messageState.sequences[sender].outbound++;
  saveMessageState();
  return messageState.sequences[sender].outbound;
}

function getSequenceState() {
  return { ...messageState };
}

module.exports = {
  loadMessageState,
  saveMessageState,
  parseMessageSequence,
  isDuplicateMessage,
  recordMessageSeen,
  createDeliveryId,
  startDeliveryTracking,
  handleDeliveryAck,
  handleDeliveryOutcome,
  getNextSequence,
  getSequenceState,
  setMetricsFunctions,
  messageState, // Exposed for triggers.js access
};
