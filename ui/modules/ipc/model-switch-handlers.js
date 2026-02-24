/**
 * Model Switch IPC Handlers
 * Channels: switch-pane-model, get-pane-commands
 *
 * Allows per-pane switching between Claude/Codex/Gemini models.
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { PANE_IDS, PANE_ROLES, resolveCoordPath } = require('../../config');
const {
  buildGeminiCommand,
  hasGeminiCommand,
  resolveGeminiModelId,
} = require('../gemini-command');
const TRIGGERS_PATH = typeof resolveCoordPath === 'function'
  ? resolveCoordPath('triggers', { forWrite: true })
  : path.join(__dirname, '..', '..', '..', 'workspace', 'triggers');

function registerModelSwitchHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerModelSwitchHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  const { saveSettings } = deps;

  // Get pane commands for UI initialization
  ipcMain.handle('get-pane-commands', () => {
    return ctx.currentSettings.paneCommands || {};
  });

  // Switch model for a specific pane
  ipcMain.handle('switch-pane-model', async (event, { paneId, model }) => {
    // Validate paneId
    const id = String(paneId);
    if (!PANE_IDS.includes(id)) {
      log.warn('ModelSwitch', `Invalid paneId: ${paneId}`);
      return { success: false, error: 'Invalid paneId' };
    }

    // Build command based on model.
    if (!ctx.currentSettings || typeof ctx.currentSettings !== 'object') {
      ctx.currentSettings = {};
    }
    if (!ctx.currentSettings.paneCommands || typeof ctx.currentSettings.paneCommands !== 'object') {
      ctx.currentSettings.paneCommands = {};
    }
    const paneCommands = ctx.currentSettings.paneCommands;
    const existingGeminiCommand = paneCommands[id]
      || Object.values(paneCommands).find(hasGeminiCommand)
      || '';
    const geminiModel = resolveGeminiModelId({
      preferredModel: ctx.currentSettings.geminiModel,
      existingCommand: existingGeminiCommand,
    });
    const commands = {
      'claude': 'claude',
      'codex': 'codex',
      'gemini': buildGeminiCommand({
        preferredModel: geminiModel,
        existingCommand: existingGeminiCommand,
      }),
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
        log.warn('ModelSwitch', `Kill timeout for Pane ${paneId}, proceeding anyway`);
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
    if (model === 'gemini') {
      ctx.currentSettings.geminiModel = geminiModel;
    }

    // Persist to settings.json
    if (typeof saveSettings === 'function') {
      const settingsPatch = { paneCommands: ctx.currentSettings.paneCommands };
      if (model === 'gemini') {
        settingsPatch.geminiModel = geminiModel;
      }
      saveSettings(settingsPatch);
    }

    log.info('ModelSwitch', `Pane ${paneId} now set to ${model}`);

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
    }

    return { success: true, paneId, model };
  });
}


function unregisterModelSwitchHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('get-pane-commands');
    ipcMain.removeHandler('switch-pane-model');
}

registerModelSwitchHandlers.unregister = unregisterModelSwitchHandlers;
module.exports = { registerModelSwitchHandlers };
