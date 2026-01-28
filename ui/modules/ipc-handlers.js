/**
 * IPC handlers for Electron main process
 * Extracted from main.js for modularization
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { WORKSPACE_PATH, INSTANCE_DIRS, PANE_IDS, PANE_ROLES } = require('../config');
const log = require('./logger');
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
const { registerPtyHandlers } = require('./ipc/pty-handlers');

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
registry.register(registerPtyHandlers);

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
  registry.setup(ctx, deps);
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
      log.error('Cleanup', `Error killing process ${id}`, err.message);
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

