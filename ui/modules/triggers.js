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

  // Send to all target panes - don't filter by running state
  // Terminals can always receive input, Claude state doesn't matter for direct messages
  console.log(`[Trigger] ${filename} → panes ${targets.join(', ')}: ${message.substring(0, 50)}...`);

  // Send to renderer which uses terminal.paste() for proper execution
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inject-message', { panes: targets, message: message + '\r' });
  }

  // Clear the trigger file after sending
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
  } catch (err) {
    console.log(`[Trigger] Could not clear ${filename}: ${err.message}`);
  }

  return { success: true, notified: targets };
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

// ============================================================
// V6 SR1: SMART ROUTING
// ============================================================

// Role definitions for routing
const AGENT_ROLES = {
  '1': { name: 'Lead', type: 'coordinator', skills: ['planning', 'coordination', 'architecture'] },
  '2': { name: 'Worker A', type: 'worker', skills: ['ui', 'frontend', 'renderer'] },
  '3': { name: 'Worker B', type: 'worker', skills: ['backend', 'daemon', 'ipc'] },
  '4': { name: 'Reviewer', type: 'reviewer', skills: ['review', 'testing', 'verification'] },
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
    candidates.push('2', '3'); // Workers
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
    console.log(`[SmartRoute] No agent available for ${taskType}`);
    return { success: false, reason: 'no_agent_available' };
  }

  console.log(`[SmartRoute] Routing ${taskType} task to pane ${paneId} (${reason})`);

  const routeMessage = `[ROUTED: ${taskType}] ${message}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inject-message', {
      panes: [paneId],
      message: routeMessage + '\r'
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
  '1': ['2', '3'],     // Lead → Workers
  '2': ['4'],          // Worker A → Reviewer
  '3': ['4'],          // Worker B → Reviewer
  '4': ['1'],          // Reviewer → Lead
};

/**
 * V6 AH1: Trigger auto-handoff when agent completes
 * @param {string} completedPaneId - Pane that just completed
 * @param {string} completionMessage - What was completed
 */
function triggerAutoHandoff(completedPaneId, completionMessage) {
  const nextPanes = HANDOFF_CHAIN[completedPaneId];

  if (!nextPanes || nextPanes.length === 0) {
    console.log(`[AutoHandoff] No handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_chain' };
  }

  // Find first running agent in chain
  const runningNext = nextPanes.find(paneId =>
    claudeRunning && claudeRunning.get(paneId) === 'running'
  );

  if (!runningNext) {
    console.log(`[AutoHandoff] No running agents in handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_running_next' };
  }

  const fromRole = AGENT_ROLES[completedPaneId]?.name || `Pane ${completedPaneId}`;
  const toRole = AGENT_ROLES[runningNext]?.name || `Pane ${runningNext}`;

  const handoffMessage = `[HANDOFF from ${fromRole}] ${completionMessage}`;

  console.log(`[AutoHandoff] ${fromRole} → ${toRole}: ${completionMessage.substring(0, 50)}...`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inject-message', {
      panes: [runningNext],
      message: handoffMessage + '\r'
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
 * @param {string[]} targetPanes - Target pane IDs
 * @param {string} message - Message to send
 * @param {string} fromRole - Sender role name (optional)
 * @returns {{ success: boolean, notified: string[] }}
 */
function sendDirectMessage(targetPanes, message, fromRole = null) {
  if (!message) return { success: false, error: 'No message' };

  // No workflow gate check - direct messages always allowed
  const notified = [];

  for (const paneId of targetPanes) {
    if (claudeRunning && claudeRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    const prefix = fromRole ? `[MSG from ${fromRole}]: ` : '';
    const fullMessage = prefix + message;

    console.log(`[DirectMessage] Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', {
        panes: notified,
        message: fullMessage + '\r'
      });
      mainWindow.webContents.send('direct-message-sent', {
        to: notified,
        from: fromRole,
        message: message.substring(0, 100)
      });
    }

    return { success: true, notified };
  }

  console.log(`[DirectMessage] No running Claude in target panes: ${targetPanes.join(', ')}`);
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
};
