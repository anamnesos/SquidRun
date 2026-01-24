/**
 * Trigger handling and agent notification functions
 * Extracted from main.js for modularization
 */

const fs = require('fs');
const { TRIGGER_TARGETS } = require('../config');

// Module state (set by init)
let mainWindow = null;
let claudeRunning = null;
let watcher = null; // Reference to watcher module for state checks

// Worker pane IDs that require reviewer approval before triggering
const WORKER_PANES = ['2', '3'];

/**
 * Initialize the triggers module with shared state
 * @param {BrowserWindow} window - The main Electron window
 * @param {Map} claudeState - Map tracking Claude running state per pane
 */
function init(window, claudeState) {
  mainWindow = window;
  claudeRunning = claudeState;
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
    console.warn('[Workflow Gate] Watcher not initialized, allowing trigger');
    return { allowed: true };
  }

  const state = watcher.readState();
  const currentState = state.state;

  // Workers can be triggered in EXECUTING or CHECKPOINT_FIX states
  const allowedStates = ['executing', 'checkpoint_fix'];
  if (allowedStates.includes(currentState)) {
    return { allowed: true };
  }

  // BLOCKED: Reviewer hasn't approved yet
  return {
    allowed: false,
    reason: `Workers blocked: state is '${currentState}', needs Reviewer approval first (plan-approved.md)`
  };
}

/**
 * Send context message to active agents
 * NOTE: Only works when Claude is running in terminal, not raw shell
 * @param {string[]} agents - Array of pane IDs to notify
 * @param {string} message - Message to send
 */
function notifyAgents(agents, message) {
  if (!message) return;

  // Only send to panes where Claude is confirmed running
  const notified = [];
  for (const paneId of agents) {
    if (claudeRunning && claudeRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    console.log(`[notifyAgents] Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: message + '\r' });
    }
  } else {
    console.log(`[notifyAgents] Skipped (no Claude running): ${agents.join(', ')}`);
  }

  return notified;
}

/**
 * AUTO-SYNC: Notify ALL agents when trigger files change
 * This enables the autonomous improvement loop
 * @param {string} triggerFile - Name of the file that changed
 */
function notifyAllAgentsSync(triggerFile) {
  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. Read workspace/${triggerFile} and respond.`;

  // Get list of running Claude panes
  const runningPanes = [];
  if (claudeRunning) {
    for (const [paneId, status] of claudeRunning) {
      if (status === 'running') {
        runningPanes.push(paneId);
      }
    }
  }

  if (runningPanes.length > 0) {
    console.log(`[AUTO-SYNC] Notifying panes ${runningPanes.join(', ')}: ${triggerFile} changed`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningPanes, message: message + '\r' });
    }
  } else {
    console.log(`[AUTO-SYNC] No Claude instances running to notify about ${triggerFile}`);
  }

  // Also notify renderer for UI update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  }

  return runningPanes;
}

/**
 * Handle trigger file changes - sends content to target pane(s)
 * @param {string} filePath - Full path to the trigger file
 * @param {string} filename - Just the filename (e.g., 'worker-b.txt')
 */
function handleTriggerFile(filePath, filename) {
  const targets = TRIGGER_TARGETS[filename];
  if (!targets) {
    console.log(`[Trigger] Unknown trigger file: ${filename}`);
    return { success: false, reason: 'unknown' };
  }

  // WORKFLOW GATE: Check if workers can be triggered
  const gateCheck = checkWorkflowGate(targets);
  if (!gateCheck.allowed) {
    console.warn(`[Trigger] BLOCKED by workflow gate: ${gateCheck.reason}`);
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

  // Read trigger file content
  let message;
  try {
    message = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    console.log(`[Trigger] Could not read ${filename}: ${err.message}`);
    return { success: false, reason: 'read_error' };
  }

  if (!message) {
    console.log(`[Trigger] Empty trigger file: ${filename}`);
    return { success: false, reason: 'empty' };
  }

  // Filter to only running Claude instances
  const runningTargets = claudeRunning
    ? targets.filter(paneId => claudeRunning.get(paneId) === 'running')
    : [];

  if (runningTargets.length > 0) {
    console.log(`[Trigger] ${filename} → panes ${runningTargets.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningTargets, message: message + '\r' });
    }

    // Clear the trigger file after sending
    try {
      fs.writeFileSync(filePath, '', 'utf-8');
    } catch (err) {
      console.log(`[Trigger] Could not clear ${filename}: ${err.message}`);
    }

    return { success: true, notified: runningTargets };
  } else {
    console.log(`[Trigger] No running Claude in target panes for ${filename}`);
    return { success: false, reason: 'no_running_targets' };
  }
}

/**
 * BROADCAST: Send message to ALL panes with clear broadcast indicator
 * Use this for user broadcasts so agents know it's going to everyone
 * @param {string} message - Message to broadcast (will be prefixed)
 */
function broadcastToAllAgents(message) {
  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;

  // Get list of running Claude panes
  const notified = [];
  if (claudeRunning) {
    for (const [paneId, status] of claudeRunning) {
      if (status === 'running') {
        notified.push(paneId);
      }
    }
  }

  if (notified.length > 0) {
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: broadcastMessage + '\r' });
    }
  }

  console.log(`[BROADCAST] Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('broadcast-sent', { message, notified });
  }

  return { success: true, notified };
}

module.exports = {
  init,
  setWatcher,
  notifyAgents,
  notifyAllAgentsSync,
  handleTriggerFile,
  broadcastToAllAgents,
  checkWorkflowGate,
};
