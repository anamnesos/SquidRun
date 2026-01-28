/**
 * IPC handlers for Electron main process
 * Extracted from main.js for modularization
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORKSPACE_PATH, INSTANCE_DIRS, PANE_IDS, PANE_ROLES } = require('../config');
const { createIpcContext, createIpcRegistry } = require('./ipc');
const ipcState = require('./ipc/ipc-state');
const { registerSdkHandlers } = require('./ipc/sdk-handlers');
const { registerSdkV2Handlers } = require('./ipc/sdk-v2-handlers');
const { registerMcpHandlers } = require('./ipc/mcp-handlers');
const { registerMcpAutoconfigHandlers } = require('./ipc/mcp-autoconfig-handlers');
const { registerTestExecutionHandlers } = require('./ipc/test-execution-handlers');
const { registerPrecommitHandlers } = require('./ipc/precommit-handlers');
const { registerTestNotificationHandlers } = require('./ipc/test-notification-handlers');
const { registerMessageQueueHandlers } = require('./ipc/message-queue-handlers');
const { registerApiDocsHandlers } = require('./ipc/api-docs-handlers');
const { registerPerfAuditHandlers } = require('./ipc/perf-audit-handlers');
const { registerErrorHandlers } = require('./ipc/error-handlers');
const { registerStateHandlers } = require('./ipc/state-handlers');
const { registerSharedContextHandlers } = require('./ipc/shared-context-handlers');
const { registerFrictionHandlers } = require('./ipc/friction-handlers');
const { registerScreenshotHandlers } = require('./ipc/screenshot-handlers');
const { registerProjectHandlers } = require('./ipc/project-handlers');
const { registerSmartRoutingHandlers } = require('./ipc/smart-routing-handlers');
const { registerAutoHandoffHandlers } = require('./ipc/auto-handoff-handlers');
const { registerConflictQueueHandlers } = require('./ipc/conflict-queue-handlers');
const { registerLearningDataHandlers } = require('./ipc/learning-data-handlers');
const { registerOutputValidationHandlers } = require('./ipc/output-validation-handlers');
const { registerCompletionQualityHandlers } = require('./ipc/completion-quality-handlers');
const { registerCheckpointHandlers } = require('./ipc/checkpoint-handlers');
const { registerActivityLogHandlers } = require('./ipc/activity-log-handlers');
const { registerAutoNudgeHandlers } = require('./ipc/auto-nudge-handlers');
const { registerCompletionDetectionHandlers } = require('./ipc/completion-detection-handlers');
const { registerAgentClaimsHandlers } = require('./ipc/agent-claims-handlers');
const { registerSessionSummaryHandlers } = require('./ipc/session-summary-handlers');
const { registerPerformanceTrackingHandlers } = require('./ipc/performance-tracking-handlers');
const { registerTemplateHandlers } = require('./ipc/template-handlers');
const { registerProcessHandlers } = require('./ipc/process-handlers');
const { registerUsageStatsHandlers } = require('./ipc/usage-stats-handlers');
const { registerSessionHistoryHandlers } = require('./ipc/session-history-handlers');
const { registerConflictDetectionHandlers } = require('./ipc/conflict-detection-handlers');
const { registerSettingsHandlers } = require('./ipc/settings-handlers');

const SHARED_CONTEXT_PATH = path.join(WORKSPACE_PATH, 'shared_context.md');
const FRICTION_DIR = path.join(WORKSPACE_PATH, 'friction');
const SCREENSHOTS_DIR = path.join(WORKSPACE_PATH, 'screenshots');

const ctx = createIpcContext(ipcState.state, {
  ipcMain,
  dialog,
  WORKSPACE_PATH,
  INSTANCE_DIRS,
  PANE_IDS,
  PANE_ROLES,
  SHARED_CONTEXT_PATH,
  FRICTION_DIR,
  SCREENSHOTS_DIR,
});

const registry = createIpcRegistry();
registry.register(registerSdkHandlers);
registry.register(registerSdkV2Handlers);
registry.register(registerMcpHandlers);
registry.register(registerMcpAutoconfigHandlers);
registry.register(registerTestExecutionHandlers);
registry.register(registerPrecommitHandlers);
registry.register(registerTestNotificationHandlers);
registry.register(registerMessageQueueHandlers);
registry.register(registerApiDocsHandlers);
registry.register(registerPerfAuditHandlers);
registry.register(registerErrorHandlers);
registry.register(registerStateHandlers);
registry.register(registerSharedContextHandlers);
registry.register(registerFrictionHandlers);
registry.register(registerScreenshotHandlers);
registry.register(registerProjectHandlers);
registry.register(registerSmartRoutingHandlers);
registry.register(registerAutoHandoffHandlers);
registry.register(registerConflictQueueHandlers);
registry.register(registerLearningDataHandlers);
registry.register(registerOutputValidationHandlers);
registry.register(registerCompletionQualityHandlers);
registry.register(registerCheckpointHandlers);
registry.register(registerActivityLogHandlers);
registry.register(registerAutoNudgeHandlers);
registry.register(registerCompletionDetectionHandlers);
registry.register(registerAgentClaimsHandlers);
registry.register(registerSessionSummaryHandlers);
registry.register(registerPerformanceTrackingHandlers);
registry.register(registerTemplateHandlers);
registry.register(registerProcessHandlers);
registry.register(registerUsageStatsHandlers);
registry.register(registerSessionHistoryHandlers);
registry.register(registerConflictDetectionHandlers);
registry.register(registerSettingsHandlers);

/**
 * Initialize the IPC handlers module
 */
function init(deps) {
  ipcState.initState(deps);
}

/**
 * Update daemon client reference (after connection)
 */
function setDaemonClient(client) {
  ipcState.setDaemonClient(client);
}

/**
 * Setup all IPC handlers
 */
function setupIPCHandlers(deps) {
  const {
    loadSettings,
    saveSettings,
    recordSessionStart,
    recordSessionEnd,
    saveUsageStats,
    broadcastClaudeState,
    // V7 OB1: Activity log functions
    logActivity,
    getActivityLog,
    clearActivityLog,
    saveActivityLog,
  } = deps;

  registry.setup(ctx, deps);

  // ============================================================
  // PTY IPC HANDLERS (via Daemon)
  // ============================================================

  ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      console.error('[pty-create] Daemon not connected');
      return { error: 'Daemon not connected' };
    }

    const instanceDir = INSTANCE_DIRS[paneId];
    const cwd = instanceDir || workingDir || process.cwd();

    const paneCommands = ctx.currentSettings.paneCommands || {};
    const cmd = (paneCommands[paneId] || '').trim().toLowerCase();
    const mode = cmd.includes('codex') ? 'codex-exec' : null;

    ctx.daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, mode);
    return { paneId, cwd, dryRun: ctx.currentSettings.dryRun };
  });

  ipcMain.handle('pty-write', (event, paneId, data) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.write(paneId, data);
    }
  });

  // Codex exec (non-interactive) - run a single prompt through codex exec --json
  ipcMain.handle('codex-exec', (event, paneId, prompt) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }
    ctx.daemonClient.codexExec(paneId, prompt || '');
    return { success: true };
  });

  // Send trusted keyboard Enter via Electron's native input API
  // Codex CLI ignores synthetic KeyboardEvents (isTrusted=false)
  // webContents.sendInputEvent generates trusted events that Codex accepts
  ipcMain.handle('send-trusted-enter', (event) => {
    if (ctx.mainWindow && ctx.mainWindow.webContents) {
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
  });

  // Clipboard paste approach for Codex panes
  // Codex CLI accepts pasted input but ignores synthetic Enter events.
  // Writes text (with trailing newline) to clipboard, then simulates Ctrl+V.
  ipcMain.handle('clipboard-paste-text', async (event, text) => {
    const { clipboard } = require('electron');
    if (ctx.mainWindow && ctx.mainWindow.webContents) {
      const savedClipboard = clipboard.readText();
      clipboard.writeText(text);
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
      setTimeout(() => {
        clipboard.writeText(savedClipboard);
      }, 200);
    }
  });

  ipcMain.handle('pty-resize', (event, paneId, cols, rows) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.resize(paneId, cols, rows);
    }
  });

  ipcMain.handle('pty-kill', (event, paneId) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.kill(paneId);
    }
  });

  ipcMain.handle('spawn-claude', (event, paneId, workingDir) => {
    // SDK Mode Guard (defense in depth): Block CLI spawn when SDK mode is active
    if (ctx.currentSettings.sdkMode) {
      console.log('[spawn-claude] SDK mode - blocking CLI spawn');
      return { success: false, error: 'SDK mode active' };
    }

    // V3: Dry-run mode - simulate without spawning real agents
    if (ctx.currentSettings.dryRun) {
      ctx.claudeRunning.set(paneId, 'running');
      broadcastClaudeState();
      return { success: true, command: null, dryRun: true };
    }

    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    ctx.claudeRunning.set(paneId, 'starting');
    broadcastClaudeState();
    recordSessionStart(paneId);

    const paneCommands = ctx.currentSettings.paneCommands || {};
    let agentCmd = (paneCommands[paneId] || 'claude').trim();
    if (!agentCmd) agentCmd = 'claude';

    // Always add autonomy flags - no permission prompts in Hivemind
    if (agentCmd.startsWith('claude') && !agentCmd.includes('--dangerously-skip-permissions')) {
      agentCmd = `${agentCmd} --dangerously-skip-permissions`;
    }
    if (agentCmd.startsWith('codex')) {
      // Use strongest bypass only
      if (!agentCmd.includes('--dangerously-bypass-approvals-and-sandbox') && !agentCmd.includes('--yolo')) {
        agentCmd = `${agentCmd} --yolo`;
      }
    }

    // ID-1: Identity injection moved to renderer (terminal.js:spawnClaude)
    // Daemon PTY writes don't submit to CLI - need keyboard events from renderer

    return { success: true, command: agentCmd };
  });

  ipcMain.handle('get-claude-state', () => {
    return Object.fromEntries(ctx.claudeRunning);
  });

  ipcMain.handle('get-daemon-terminals', () => {
    if (ctx.daemonClient) {
      return ctx.daemonClient.getTerminals();
    }
    return [];
  });

}

function broadcastProcessList() {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    const processes = [];
    for (const [id, { info }] of ctx.backgroundProcesses) {
      processes.push({
        id: info.id,
        command: info.command,
        args: info.args,
        pid: info.pid,
        status: info.status,
      });
    }
    ctx.mainWindow.webContents.send('processes-changed', processes);
  }
}

function getBackgroundProcesses() {
  return ctx.backgroundProcesses;
}

function cleanupProcesses() {
  for (const [id, { process: proc, info }] of ctx.backgroundProcesses) {
    try {
      if (proc && info && info.status === 'running' && proc.pid) {
        if (os.platform() === 'win32') {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { shell: true });
        } else {
          proc.kill('SIGTERM');
        }
      }
    } catch (err) {
      console.log(`[Cleanup] Error killing process ${id}:`, err.message);
    }
  }
  ctx.backgroundProcesses.clear();
}

module.exports = {
  init,
  setDaemonClient,
  setupIPCHandlers,
  getBackgroundProcesses,
  cleanupProcesses,
};

