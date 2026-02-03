/**
 * Model Switch IPC Handlers
 * Channels: switch-pane-model, get-pane-commands
 *
 * Allows per-pane switching between Claude/Codex/Gemini models.
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { PANE_ROLES } = require('../../config');
const { getSDKBridge } = require('../sdk-bridge');

const VALID_PANE_IDS = ['1', '2', '3', '4', '5', '6'];
const TRIGGERS_PATH = path.join(__dirname, '..', '..', '..', 'workspace', 'triggers');

function registerModelSwitchHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerModelSwitchHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  const { saveSettings } = deps;
  const getContextInjection = () => deps?.contextInjection || ctx.contextInjection;

  // Get pane commands for UI initialization
  ipcMain.handle('get-pane-commands', () => {
    return ctx.currentSettings.paneCommands || {};
  });

  // Switch model for a specific pane
  ipcMain.handle('switch-pane-model', async (event, { paneId, model }) => {
    // Validate paneId
    const id = String(paneId);
    if (!VALID_PANE_IDS.includes(id)) {
      log.warn('ModelSwitch', `Invalid paneId: ${paneId}`);
      return { success: false, error: 'Invalid paneId' };
    }

    // Build command based on model - use dynamic workspace path
    const workspacePath = path.join(__dirname, '..', '..', '..', 'workspace');
    const commands = {
      'claude': 'claude',
      'codex': 'codex',
      'gemini': `gemini --yolo --include-directories "${workspacePath}"`
    };

    if (!commands[model]) {
      log.warn('ModelSwitch', `Unknown model: ${model}`);
      return { success: false, error: 'Unknown model' };
    }

    log.info('ModelSwitch', `Switching pane ${paneId} to ${model}`);

    // Mark exit as expected BEFORE killing - prevents recovery manager from auto-restarting
    // with the old paneCommand before we update settings
    if (ctx.recoveryManager && typeof ctx.recoveryManager.markExpectedExit === 'function') {
      ctx.recoveryManager.markExpectedExit(id, 'model-switch');
    }

    // Kill existing process
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.kill(paneId);
    }

    // Wait for kill confirmation (event-based with fallback timeout)
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        log.warn('ModelSwitch', `Kill timeout for pane ${paneId}, proceeding anyway`);
        if (ctx.daemonClient) {
          ctx.daemonClient.off('killed', handler);
        }
        resolve();
      }, 2000);

      const handler = (killedPaneId) => {
        if (String(killedPaneId) === id) {
          clearTimeout(timeout);
          ctx.daemonClient.off('killed', handler);
          resolve();
        }
      };

      if (ctx.daemonClient) {
        ctx.daemonClient.on('killed', handler);
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    // Update settings AFTER kill confirmed (per design review)
    ctx.currentSettings.paneCommands[id] = commands[model];

    // Persist to settings.json
    if (typeof saveSettings === 'function') {
      saveSettings({ paneCommands: ctx.currentSettings.paneCommands });
    }

    log.info('ModelSwitch', `Pane ${paneId} now set to ${model}`);

    // Update SDK bridge's internal model tracking (for SDK mode consistency)
    try {
      const sdkBridge = getSDKBridge();
      if (sdkBridge && typeof sdkBridge.setModelForPane === 'function') {
        sdkBridge.setModelForPane(id, model);
      }
    } catch (err) {
      log.warn('ModelSwitch', `Failed to update SDK bridge: ${err.message}`);
    }

    // Broadcast model switch to all agents
    const role = (PANE_ROLES && PANE_ROLES[id]) || `Pane ${id}`;
    const modelName = model.charAt(0).toUpperCase() + model.slice(1);
    try {
      const allTriggerPath = path.join(TRIGGERS_PATH, 'all.txt');
      fs.writeFileSync(allTriggerPath, `(SYSTEM): ${role} switched to ${modelName}\n`);
    } catch (err) {
      log.warn('ModelSwitch', `Failed to broadcast model switch: ${err.message}`);
    }

    // Signal renderer to respawn
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('pane-model-changed', { paneId, model });

      // Finding #14: Auto-inject context via manager
      const contextInjection = getContextInjection();
      if (contextInjection) {
        await contextInjection.injectContext(id, model, model === 'codex' ? 6000 : 5000);
      }
    }

    return { success: true, paneId, model };
  });
}

module.exports = { registerModelSwitchHandlers };
