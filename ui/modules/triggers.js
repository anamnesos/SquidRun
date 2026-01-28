/**
 * Trigger handling and agent notification functions
 * Extracted from main.js for modularization
 *
 * V2 SDK Integration: When SDK mode is enabled, triggers route
 * through sdk-bridge instead of PTY keyboard injection.
 */

const fs = require('fs');
const path = require('path');
const { TRIGGER_TARGETS, WORKSPACE_PATH, PANE_IDS } = require('../config');
const log = require('./logger');

// Module state (set by init)
let mainWindow = null;
let claudeRunning = null;
let watcher = null; // Reference to watcher module for state checks

// V2 SDK Integration
let sdkBridge = null;
let sdkModeEnabled = false;

// ============================================================
// MESSAGE SEQUENCING - Prevents duplicate/out-of-order messages
// ============================================================

const MESSAGE_STATE_PATH = path.join(WORKSPACE_PATH, 'message-state.json');

// In-memory sequence tracking (loaded from file on init)
let messageState = {
  version: 1,
  sequences: {
    'lead': { outbound: 0, lastSeen: {} },
    'orchestrator': { outbound: 0, lastSeen: {} },
    'worker-a': { outbound: 0, lastSeen: {} },
    'worker-b': { outbound: 0, lastSeen: {} },
    'investigator': { outbound: 0, lastSeen: {} },
    'reviewer': { outbound: 0, lastSeen: {} },
  },
};

/**
 * Load message state from disk
 */
function loadMessageState() {
  try {
    // FIX: Reset lastSeen on app startup to prevent stale sequence blocking
    // New Claude instances start from #1, so old "lastSeen" values would block all messages
    // We keep the structure but clear lastSeen so fresh sessions work immediately
    log.info('MessageSeq', 'Resetting message state for fresh session');
    messageState = {
      version: 1,
      sequences: {
        'lead': { outbound: 0, lastSeen: {} },
        'orchestrator': { outbound: 0, lastSeen: {} },
        'worker-a': { outbound: 0, lastSeen: {} },
        'worker-b': { outbound: 0, lastSeen: {} },
        'investigator': { outbound: 0, lastSeen: {} },
        'reviewer': { outbound: 0, lastSeen: {} },
      }
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
 * @param {string} message - Raw message content
 * @returns {{ seq: number|null, sender: string|null, content: string }}
 */
function parseMessageSequence(message) {
  // Primary format: "(ROLE #N): message" - per Reviewer spec
  // Regex: /^\((\w+(?:-\w+)?)\s*#(\d+)\):\s*(.*)$/s
  const seqMatch = message.match(/^\((\w+(?:-\w+)?)\s*#(\d+)\):\s*(.*)$/s);
  if (seqMatch) {
    return {
      seq: parseInt(seqMatch[2], 10),
      sender: seqMatch[1].toLowerCase(),
      content: `(${seqMatch[1]}): ${seqMatch[3]}`, // Strip seq for display
    };
  }

  // Backwards compat: "(ROLE): message" - no sequence (treated as seq=0)
  const roleMatch = message.match(/^\((\w+(?:-\w+)?)\):\s*(.*)$/s);
  if (roleMatch) {
    return {
      seq: null, // null = seq 0, always process for backwards compat
      sender: roleMatch[1].toLowerCase(),
      content: message,
    };
  }

  // No recognizable format
  return { seq: null, sender: null, content: message };
}

/**
 * Check if message is a duplicate (already seen this seq from this sender)
 * @param {string} sender - Sender role (lowercase, hyphenated)
 * @param {number} seq - Sequence number
 * @param {string} recipient - Recipient role
 * @returns {boolean} true if duplicate
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
 * @param {string} sender - Sender role
 * @param {number} seq - Sequence number
 * @param {string} recipient - Recipient role
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

/**
 * Get next outbound sequence number for a sender
 * @param {string} sender - Sender role
 * @returns {number}
 */
function getNextSequence(sender) {
  if (!messageState.sequences[sender]) {
    messageState.sequences[sender] = { outbound: 0, lastSeen: {} };
  }
  messageState.sequences[sender].outbound++;
  saveMessageState();
  return messageState.sequences[sender].outbound;
}

/**
 * Get current sequence state (for debugging/UI)
 */
function getSequenceState() {
  return { ...messageState };
}

// Worker pane IDs that require reviewer approval before triggering
const WORKER_PANES = ['3', '4', '5'];

// BUG1 FIX: Track last sync time per pane to prevent self-sync
const lastSyncTime = new Map(); // paneId -> timestamp
const SYNC_DEBOUNCE_MS = 3000; // Skip sync if pane was synced within 3 seconds

// FIX: Stagger delays to avoid thundering herd when multiple panes receive messages
const STAGGER_BASE_DELAY_MS = 150; // Base delay between panes
const STAGGER_RANDOM_MS = 100; // Random jitter added to base delay

/**
 * Initialize the triggers module with shared state
 * @param {BrowserWindow} window - The main Electron window
 * @param {Map} claudeState - Map tracking Claude running state per pane
 */
function init(window, claudeState) {
  mainWindow = window;
  claudeRunning = claudeState;
  // Load message sequence state from disk
  loadMessageState();
}

/**
 * V2 SDK: Set SDK bridge reference for direct message delivery
 * @param {SDKBridge} bridge - The SDK bridge instance
 */
function setSDKBridge(bridge) {
  sdkBridge = bridge;
  log.info('Triggers', 'SDK bridge set');
}

/**
 * V2 SDK: Enable/disable SDK mode for message delivery
 * @param {boolean} enabled - Whether SDK mode is active
 */
function setSDKMode(enabled) {
  sdkModeEnabled = enabled;
  log.info('Triggers', `SDK mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * V2 SDK: Check if SDK mode is active
 * @returns {boolean}
 */
function isSDKModeEnabled() {
  return sdkModeEnabled && sdkBridge !== null;
}

const TRIGGER_PREFIX = '\x1b[1;33m[TRIGGER]\x1b[0m ';

function formatTriggerMessage(message) {
  if (!message) return message;
  if (message.startsWith(TRIGGER_PREFIX)) return message;
  return `${TRIGGER_PREFIX}${message}`;
}

/**
 * Set watcher reference for state checks (called after watcher.init)
 * @param {Object} watcherModule - The watcher module
 */
function setWatcher(watcherModule) {
  watcher = watcherModule;
}

/**
 * Check if workflow gate allows triggering workers
 * Workers can only be triggered when state is EXECUTING
 * @param {string[]} targets - Pane IDs being triggered
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkWorkflowGate(targets) {
  // Check if any targets are workers
  const hasWorkerTargets = targets.some(t => WORKER_PANES.includes(t));
  if (!hasWorkerTargets) {
    return { allowed: true }; // Not targeting workers, allow
  }

  // Workers targeted - check state
  if (!watcher) {
    log.warn('Workflow Gate', 'Watcher not initialized, allowing trigger');
    return { allowed: true };
  }

  const state = watcher.readState();
  const currentState = state.state;

  // Workers can be triggered in these states
  // V12 FX3: Added planning states so team can coordinate anytime
  const allowedStates = [
    'executing',
    'checkpoint_fix',
    'idle',
    'project_selected',
    'planning',
    'friction_sync',
    'friction_logged'
  ];
  if (allowedStates.includes(currentState)) {
    return { allowed: true };
  }

  // BLOCKED: Only during review/verification phases
  return {
    allowed: false,
    reason: `Workers blocked during '${currentState}' - wait for review phase to complete`
  };
}

/**
 * Send context message to active agents
 * NOTE: Only works when Claude is running in terminal, not raw shell
 * V2 SDK: Routes through SDK when SDK mode is enabled
 * @param {string[]} agents - Array of pane IDs to notify
 * @param {string} message - Message to send
 */
function notifyAgents(agents, message) {
  if (!message) return;

  // V2 SDK MODE: Route through SDK bridge (no running check needed - SDK manages sessions)
  if (isSDKModeEnabled()) {
    log.info('notifyAgents SDK', `Sending to ${agents.length} pane(s) via SDK: ${message.substring(0, 50)}...`);
    let successCount = 0;
    for (const paneId of agents) {
      // FIX: Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: message }
        });
      }
      const sent = sdkBridge.sendMessage(paneId, message);
      if (sent) successCount++;
    }
    log.info('notifyAgents SDK', `Delivered to ${successCount}/${agents.length} panes`);
    return agents; // SDK mode doesn't filter by running state
  }

  // PTY MODE (legacy): Only send to panes where Claude is confirmed running
  const notified = [];
  for (const paneId of agents) {
    if (claudeRunning && claudeRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    const triggerMessage = formatTriggerMessage(message);
    log.info('notifyAgents', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: triggerMessage + '\r' });
    }
  } else {
    log.info('notifyAgents', `Skipped (no Claude running): ${agents.join(', ')}`);
  }

  return notified;
}

/**
 * AUTO-SYNC: Notify ALL agents when trigger files change
 * This enables the autonomous improvement loop
 * V2 SDK: Routes through SDK when SDK mode is enabled
 * @param {string} triggerFile - Name of the file that changed
 */
function notifyAllAgentsSync(triggerFile) {
  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. Read workspace/${triggerFile} and respond.`;
  const now = Date.now();

  // V2 SDK MODE: Broadcast through SDK bridge (no running check - SDK manages sessions)
  if (isSDKModeEnabled()) {
    // Still apply debounce to prevent sync storms
    const eligiblePanes = [];
    for (const paneId of PANE_IDS) {
      const lastSync = lastSyncTime.get(paneId) || 0;
      if (now - lastSync > SYNC_DEBOUNCE_MS) {
        eligiblePanes.push(paneId);
        lastSyncTime.set(paneId, now);
      }
    }

    if (eligiblePanes.length > 0) {
      log.info('AUTO-SYNC SDK', `Notifying panes ${eligiblePanes.join(', ')}: ${triggerFile} changed`);
      for (const paneId of eligiblePanes) {
        // FIX: Display incoming message in pane UI so user can see agent-to-agent messages
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sdk-message', {
            paneId: paneId,
            message: { type: 'user', content: message }
          });
        }
        sdkBridge.sendMessage(paneId, message);
      }
    } else {
      log.info('AUTO-SYNC SDK', 'All panes recently synced, skipping');
    }

    // Notify renderer for UI update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: eligiblePanes, mode: 'sdk' });
    }

    return eligiblePanes;
  }

  // PTY MODE (legacy): Get list of running Claude panes, excluding recently synced (BUG1 FIX)
  const runningPanes = [];
  const skippedPanes = [];
  if (claudeRunning) {
    for (const [paneId, status] of claudeRunning) {
      if (status === 'running') {
        const lastSync = lastSyncTime.get(paneId) || 0;
        if (now - lastSync > SYNC_DEBOUNCE_MS) {
          runningPanes.push(paneId);
          lastSyncTime.set(paneId, now);
        } else {
          skippedPanes.push(paneId);
        }
      }
    }
  }

  if (skippedPanes.length > 0) {
    log.info('AUTO-SYNC', `Skipped panes (recently synced): ${skippedPanes.join(', ')}`);
  }

  if (runningPanes.length > 0) {
    const triggerMessage = formatTriggerMessage(message);
    log.info('AUTO-SYNC', `Notifying panes ${runningPanes.join(', ')}: ${triggerFile} changed`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningPanes, message: triggerMessage + '\r' });
    }
  } else {
    log.info('AUTO-SYNC', `No Claude instances to notify about ${triggerFile}`);
  }

  // Also notify renderer for UI update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  }

  return runningPanes;
}

/**
 * FIX: Send message to panes with staggered timing to avoid thundering herd
 * V2 SDK: Routes through SDK when SDK mode is enabled
 * @param {string[]} panes - Target pane IDs
 * @param {string} message - Message to send
 */
function sendStaggered(panes, message) {
  // V2 SDK: Route through SDK if enabled
  if (isSDKModeEnabled()) {
    log.info('Stagger', `Sending to ${panes.length} panes via SDK`);
    panes.forEach((paneId, index) => {
      // Still stagger SDK calls to avoid overwhelming API
      const delay = index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS;
      setTimeout(() => {
        // Remove trailing \r - SDK doesn't need it
        const cleanMessage = message.endsWith('\r') ? message.slice(0, -1) : message;

        // FIX: Display incoming message in pane UI so user can see agent-to-agent messages
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sdk-message', {
            paneId: paneId,
            message: { type: 'user', content: cleanMessage }
          });
        }

        sdkBridge.sendMessage(paneId, cleanMessage);
      }, delay);
    });
    return;
  }

  // Legacy PTY mode
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Single pane - no stagger needed
  if (panes.length === 1) {
    mainWindow.webContents.send('inject-message', { panes, message });
    return;
  }

  // Multiple panes - stagger to avoid thundering herd
  log.info('Stagger', `Sending to ${panes.length} panes with staggered timing`);
  panes.forEach((paneId, index) => {
    const delay = index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('inject-message', { panes: [paneId], message });
      }
    }, delay);
  });
}

/**
 * Handle trigger file changes - sends content to target pane(s)
 * V2: When SDK mode enabled, routes through SDK bridge instead of PTY
 * @param {string} filePath - Full path to the trigger file
 * @param {string} filename - Just the filename (e.g., 'worker-b.txt')
 */
function handleTriggerFile(filePath, filename) {
  const targets = TRIGGER_TARGETS[filename];
  if (!targets) {
    log.info('Trigger', `Unknown trigger file: ${filename}`);
    return { success: false, reason: 'unknown' };
  }
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Detected change at ${filePath}`);
  }

  // WORKFLOW GATE: Check if workers can be triggered
  const gateCheck = checkWorkflowGate(targets);
  if (!gateCheck.allowed) {
    log.warn('Trigger', `BLOCKED by workflow gate: ${gateCheck.reason}`);
    // Notify UI about blocked trigger
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-blocked', {
        file: filename,
        targets,
        reason: gateCheck.reason
      });
    }
    return { success: false, reason: 'workflow_gate', message: gateCheck.reason };
  }

  // Read trigger file content with encoding normalization
  // Windows agents may write UTF-16LE (PowerShell default), UTF-8 with BOM,
  // or OEM codepage (cmd.exe echo). Normalize to clean UTF-8.
  let message;
  try {
    const raw = fs.readFileSync(filePath);

    // Detect UTF-16LE BOM (FF FE)
    if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
      message = raw.slice(2).toString('utf16le').trim();
      log.info('Trigger', `Decoded UTF-16LE BOM file: ${filename}`);
    }
    // Detect UTF-8 BOM (EF BB BF)
    else if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
      message = raw.slice(3).toString('utf-8').trim();
      log.info('Trigger', `Stripped UTF-8 BOM from: ${filename}`);
    }
    // Default: UTF-8
    else {
      message = raw.toString('utf-8').trim();
    }

    // Strip null bytes and other control chars that slip through encoding issues
    message = message.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
  } catch (err) {
    log.info('Trigger', `Could not read ${filename}: ${err.message}`);
    return { success: false, reason: 'read_error' };
  }

  if (!message) {
    log.info('Trigger', `Empty trigger file: ${filename}`);
    return { success: false, reason: 'empty' };
  }
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Read ${message.length} chars`);
  }

  // MESSAGE SEQUENCING: Parse and check for duplicates
  const parsed = parseMessageSequence(message);
  const recipientRole = filename.replace('.txt', '').toLowerCase();
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Parsed sender=${parsed.sender || 'n/a'} seq=${parsed.seq ?? 'n/a'}`);
  }

  if (parsed.seq !== null && parsed.sender) {
    // Check for duplicate
    if (isDuplicateMessage(parsed.sender, parsed.seq, recipientRole)) {
      log.info('Trigger', `SKIPPED duplicate: ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
      // Clear the file but don't deliver
      try {
        fs.writeFileSync(filePath, '', 'utf-8');
      } catch (e) { /* ignore */ }
      return { success: false, reason: 'duplicate', seq: parsed.seq, sender: parsed.sender };
    }

    // Record that we've seen this sequence
    recordMessageSeen(parsed.sender, parsed.seq, recipientRole);
    log.info('Trigger', `Accepted: ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
  }

  log.info('Trigger', `${filename} → panes ${targets.join(', ')}: ${message.substring(0, 50)}...`);

  // V2 SDK MODE: Route through SDK bridge (no keyboard events needed)
  if (isSDKModeEnabled()) {
    log.info('Trigger SDK', `Using SDK mode for ${targets.length} target(s)`);
    let allSuccess = true;

    for (const paneId of targets) {
      // FIX: Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: message }
        });
      }
      const sent = sdkBridge.sendMessage(paneId, message);
      if (!sent) {
        log.warn('Trigger SDK', `Failed to send to pane ${paneId}`);
        allSuccess = false;
      }
    }

    // Clear trigger file after SDK calls (even partial success)
    try {
      fs.writeFileSync(filePath, '', 'utf-8');
      log.info('Trigger SDK', `Cleared trigger file: ${filename}`);
    } catch (err) {
      log.info('Trigger SDK', `Could not clear ${filename}: ${err.message}`);
    }

    // Notify UI about trigger sent
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-sent-sdk', {
        file: filename,
        targets,
        success: allSuccess
      });
    }

    return { success: allSuccess, notified: targets, mode: 'sdk' };
  }

  // PTY MODE (legacy): Use staggered send via inject-message IPC
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Targets: ${targets.join(', ')}, SDK mode: ${isSDKModeEnabled()}`);
  }
  const triggerMessage = formatTriggerMessage(message);
  sendStaggered(targets, triggerMessage + '\r');
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', '[lead.txt] Sent via inject-message (PTY mode)');
  }

  // Clear the trigger file after sending
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
  } catch (err) {
    log.info('Trigger', `Could not clear ${filename}: ${err.message}`);
  }

  return { success: true, notified: targets, mode: 'pty' };
}

/**
 * BROADCAST: Send message to ALL panes with clear broadcast indicator
 * Use this for user broadcasts so agents know it's going to everyone
 * V2: When SDK mode enabled, uses SDK bridge for delivery
 * @param {string} message - Message to broadcast (will be prefixed)
 */
function broadcastToAllAgents(message) {
  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;

  // V2 SDK MODE: Broadcast through SDK bridge to all panes
  if (isSDKModeEnabled()) {
    log.info('BROADCAST SDK', `Broadcasting to all ${PANE_IDS.length} panes`);
    sdkBridge.broadcast(broadcastMessage);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('broadcast-sent', {
        message,
        notified: PANE_IDS,
        mode: 'sdk'
      });
    }

    return { success: true, notified: PANE_IDS, mode: 'sdk' };
  }

  // PTY MODE (legacy): Get list of running Claude panes
  const notified = [];
  if (claudeRunning) {
    for (const [paneId, status] of claudeRunning) {
      if (status === 'running') {
        notified.push(paneId);
      }
    }
  }

  if (notified.length > 0) {
    // FIX: Use staggered send to avoid thundering herd
    sendStaggered(notified, broadcastMessage + '\r');
  }

  log.info('BROADCAST', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('broadcast-sent', { message, notified, mode: 'pty' });
  }

  return { success: true, notified, mode: 'pty' };
}

// ============================================================
// V6 SR1: SMART ROUTING
// ============================================================

// Role definitions for routing
const AGENT_ROLES = {
  '1': { name: 'Architect', type: 'coordinator', skills: ['planning', 'coordination', 'architecture'] },
  '2': { name: 'Orchestrator', type: 'coordinator', skills: ['routing', 'coordination', 'planning'] },
  '3': { name: 'Implementer A', type: 'worker', skills: ['ui', 'frontend', 'renderer', 'implementation'] },
  '4': { name: 'Implementer B', type: 'worker', skills: ['backend', 'daemon', 'ipc', 'refactor'] },
  '5': { name: 'Investigator', type: 'investigator', skills: ['debugging', 'testing', 'analysis'] },
  '6': { name: 'Reviewer', type: 'reviewer', skills: ['review', 'testing', 'verification'] },
};

/**
 * V6 SR1: Get best agent for a task based on performance and type
 * @param {string} taskType - Type of task (ui, backend, review, etc.)
 * @param {Object} performance - Performance data from get-performance
 * @returns {{ paneId: string, reason: string }}
 */
function getBestAgent(taskType, performance) {
  // Find agents with matching skills
  const candidates = [];
  for (const [paneId, role] of Object.entries(AGENT_ROLES)) {
    if (role.skills.includes(taskType) || role.type === taskType) {
      candidates.push(paneId);
    }
  }

  // If no skill match, use workers for general tasks
  if (candidates.length === 0) {
    candidates.push('3', '4', '5'); // Workers
  }

  // Filter to running agents
  const runningCandidates = candidates.filter(paneId =>
    claudeRunning && claudeRunning.get(paneId) === 'running'
  );

  if (runningCandidates.length === 0) {
    return { paneId: null, reason: 'no_running_candidates' };
  }

  // If we have performance data, pick best performer
  if (performance && performance.agents) {
    let bestPaneId = runningCandidates[0];
    let bestScore = -1;

    for (const paneId of runningCandidates) {
      const stats = performance.agents[paneId];
      if (stats) {
        // Score = completions * 2 - errors + (1000 / avgResponseTime)
        const avgTime = stats.responseCount > 0
          ? stats.totalResponseTime / stats.responseCount
          : 10000;
        const score = (stats.completions * 2) - stats.errors + (1000 / Math.max(avgTime, 1));

        if (score > bestScore) {
          bestScore = score;
          bestPaneId = paneId;
        }
      }
    }

    return {
      paneId: bestPaneId,
      reason: bestScore > 0 ? 'performance_based' : 'first_available'
    };
  }

  // No performance data, return first running candidate
  return { paneId: runningCandidates[0], reason: 'first_available' };
}

/**
 * V6 SR1: Route a task to the best agent
 * @param {string} taskType - Type of task
 * @param {string} message - Message to send
 * @param {Object} performance - Performance data
 */
function routeTask(taskType, message, performance) {
  const { paneId, reason } = getBestAgent(taskType, performance);

  if (!paneId) {
    log.info('SmartRoute', `No agent available for ${taskType}`);
    return { success: false, reason: 'no_agent_available' };
  }

  log.info('SmartRoute', `Routing ${taskType} task to pane ${paneId} (${reason})`);

  const routeMessage = `[ROUTED: ${taskType}] ${message}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const triggerMessage = formatTriggerMessage(routeMessage);
    mainWindow.webContents.send('inject-message', {
      panes: [paneId],
      message: triggerMessage + '\r'
    });
    mainWindow.webContents.send('task-routed', {
      taskType, paneId, reason, message: message.substring(0, 50)
    });
  }

  return { success: true, paneId, reason };
}

// ============================================================
// V6 AH1: AUTO-HANDOFF
// ============================================================

// Handoff chain: who triggers who after completion
const HANDOFF_CHAIN = {
  '1': ['2'],          // Architect → Orchestrator
  '2': ['3', '4', '5'],// Orchestrator → Implementers + Investigator
  '3': ['6'],          // Implementer A → Reviewer
  '4': ['6'],          // Implementer B → Reviewer
  '5': ['6'],          // Investigator → Reviewer
  '6': ['1'],          // Reviewer → Architect
};

/**
 * V6 AH1: Trigger auto-handoff when agent completes
 * @param {string} completedPaneId - Pane that just completed
 * @param {string} completionMessage - What was completed
 */
function triggerAutoHandoff(completedPaneId, completionMessage) {
  const nextPanes = HANDOFF_CHAIN[completedPaneId];

  if (!nextPanes || nextPanes.length === 0) {
    log.info('AutoHandoff', `No handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_chain' };
  }

  // Find first running agent in chain
  const runningNext = nextPanes.find(paneId =>
    claudeRunning && claudeRunning.get(paneId) === 'running'
  );

  if (!runningNext) {
    log.info('AutoHandoff', `No running agents in handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_running_next' };
  }

  const fromRole = AGENT_ROLES[completedPaneId]?.name || `Pane ${completedPaneId}`;
  const toRole = AGENT_ROLES[runningNext]?.name || `Pane ${runningNext}`;

  const handoffMessage = `[HANDOFF from ${fromRole}] ${completionMessage}`;

  log.info('AutoHandoff', `${fromRole} → ${toRole}: ${completionMessage.substring(0, 50)}...`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    const triggerMessage = formatTriggerMessage(handoffMessage);
    mainWindow.webContents.send('inject-message', {
      panes: [runningNext],
      message: triggerMessage + '\r'
    });
    mainWindow.webContents.send('auto-handoff', {
      from: completedPaneId,
      to: runningNext,
      fromRole,
      toRole,
      message: completionMessage.substring(0, 100)
    });
  }

  return { success: true, from: completedPaneId, to: runningNext, fromRole, toRole };
}

// ============================================================
// V10 MQ5: DIRECT MESSAGE (GATE BYPASS)
// ============================================================

/**
 * V10 MQ5: Send direct message to agent(s) - BYPASSES WORKFLOW GATE
 * Use this for inter-agent chat that should always be delivered
 * V2: When SDK mode enabled, uses SDK bridge for direct delivery
 * @param {string[]} targetPanes - Target pane IDs
 * @param {string} message - Message to send
 * @param {string} fromRole - Sender role name (optional)
 * @returns {{ success: boolean, notified: string[] }}
 */
function sendDirectMessage(targetPanes, message, fromRole = null) {
  if (!message) return { success: false, error: 'No message' };

  const prefix = fromRole ? `[MSG from ${fromRole}]: ` : '';
  const fullMessage = prefix + message;

  // V2 SDK MODE: Direct delivery through SDK bridge (no running check needed)
  if (isSDKModeEnabled()) {
    log.info('DirectMessage SDK', `Sending to panes ${targetPanes.join(', ')}: ${message.substring(0, 50)}...`);

    let allSuccess = true;
    for (const paneId of targetPanes) {
      // FIX: Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: fullMessage }
        });
      }
      const sent = sdkBridge.sendMessage(paneId, fullMessage);
      if (!sent) {
        log.warn('DirectMessage SDK', `Failed to send to pane ${paneId}`);
        allSuccess = false;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('direct-message-sent', {
        to: targetPanes,
        from: fromRole,
        message: message.substring(0, 100),
        mode: 'sdk'
      });
    }

    return { success: allSuccess, notified: targetPanes, mode: 'sdk' };
  }

  // PTY MODE (legacy): No workflow gate check - direct messages always allowed
  const notified = [];

  for (const paneId of targetPanes) {
    if (claudeRunning && claudeRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    log.info('DirectMessage', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      const triggerMessage = formatTriggerMessage(fullMessage);
      mainWindow.webContents.send('inject-message', {
        panes: notified,
        message: triggerMessage + '\r'
      });
      mainWindow.webContents.send('direct-message-sent', {
        to: notified,
        from: fromRole,
        message: message.substring(0, 100),
        mode: 'pty'
      });
    }

    return { success: true, notified, mode: 'pty' };
  }

  log.info('DirectMessage', `No running Claude in target panes: ${targetPanes.join(', ')}`);
  return { success: false, notified: [], reason: 'no_running_targets' };
}

/**
 * V10 MQ5: Check if direct messages are allowed (always true)
 * This exists for API consistency with checkWorkflowGate
 */
function checkDirectMessageGate() {
  // Direct messages always bypass workflow gate
  return { allowed: true, reason: 'Direct messages bypass workflow gate' };
}

module.exports = {
  init,
  setWatcher,
  notifyAgents,
  notifyAllAgentsSync,
  handleTriggerFile,
  broadcastToAllAgents,
  checkWorkflowGate,
  // V6
  getBestAgent,
  routeTask,
  triggerAutoHandoff,
  AGENT_ROLES,
  HANDOFF_CHAIN,
  // V10 MQ5
  sendDirectMessage,
  checkDirectMessageGate,
  // V2 SDK Integration
  setSDKBridge,
  setSDKMode,
  isSDKModeEnabled,
  // Message Sequencing
  parseMessageSequence,
  isDuplicateMessage,
  recordMessageSeen,
  getNextSequence,
  getSequenceState,
};
