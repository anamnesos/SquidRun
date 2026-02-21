/**
 * IPC handlers for Electron main process
 * Extracted from main.js for modularization
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const log = require('./logger');
const {
  WORKSPACE_PATH,
  PANE_IDS,
  PANE_ROLES,
  resolveCoordPath,
} = require('../config');
const { createIpcContext, createIpcRegistry } = require('./ipc');
const ipcState = require('./ipc/ipc-state');
const { registerAllHandlers, setupAllHandlers } = require('./ipc/handler-registry');
const { createBackgroundProcessController } = require('./ipc/background-processes');

const SHARED_CONTEXT_PATH = typeof resolveCoordPath === 'function'
  ? resolveCoordPath('shared_context.md')
  : path.join(WORKSPACE_PATH, 'shared_context.md');
const FRICTION_DIR = path.join(WORKSPACE_PATH, 'friction');
const SCREENSHOTS_DIR = path.join(WORKSPACE_PATH, 'screenshots');

const ctx = createIpcContext(ipcState.state, {
  ipcMain,
  dialog,
  WORKSPACE_PATH,
  PANE_IDS,
  PANE_ROLES,
  SHARED_CONTEXT_PATH,
  FRICTION_DIR,
  SCREENSHOTS_DIR,
});

const registry = createIpcRegistry();
registerAllHandlers(registry);

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

function setExternalNotifier(notifier) {
  ctx.externalNotifier = notifier;
}

/**
 * Setup all IPC handlers
 */
function setupIPCHandlers(deps) {
  if (ctx.ipcMain && !ctx._perfWrapped) {
    const originalHandle = ctx.ipcMain.handle.bind(ctx.ipcMain);
    ctx.ipcMain.handle = (channel, handler) => {
      if (typeof handler !== 'function') {
        return originalHandle(channel, handler);
      }
      return originalHandle(channel, async (event, ...args) => {
        const start = Date.now();
        try {
          return await handler(event, ...args);
        } catch (err) {
          log.error(`[IPC] Handler "${channel}" threw:`, err?.message || err);
          return { success: false, error: err?.message || 'Unknown error' };
        } finally {
          const duration = Date.now() - start;
          if (typeof ctx.recordHandlerPerf === 'function') {
            ctx.recordHandlerPerf(channel, duration);
          }
        }
      });
    };
    ctx._perfWrapped = true;
  }

  setupAllHandlers(registry, ctx, deps);
}

/**
 * Cleanup all IPC handlers and their resources
 */
function cleanup() {
  registry.unsetup(ctx);
}

const backgroundController = createBackgroundProcessController(ctx);
const getBackgroundProcesses = backgroundController.getBackgroundProcesses;
const cleanupProcesses = backgroundController.cleanupProcesses;

module.exports = {
  init,
  setDaemonClient,
  setExternalNotifier,
  setupIPCHandlers,
  getBackgroundProcesses,
  cleanupProcesses,
  cleanup,
};

