/**
 * Model Switch IPC Handlers
 * Channels: switch-pane-model, get-pane-commands
 *
 * Allows per-pane switching between Claude/Codex/Gemini models.
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { INSTANCE_DIRS } = require('../../config');

const VALID_PANE_IDS = ['1', '2', '3', '4', '5', '6'];

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

    // Kill existing process
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.kill(paneId);
    }

    // Wait for kill confirmation (event-based with fallback timeout)
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        log.warn('ModelSwitch', `Kill timeout for pane ${paneId}, proceeding anyway`);
        if (ctx.daemonClient) {
          ctx.daemonClient.off('exit', handler);
        }
        resolve();
      }, 2000);

      const handler = (data) => {
        if (data && String(data.paneId) === id) {
          clearTimeout(timeout);
          ctx.daemonClient.off('exit', handler);
          resolve();
        }
      };

      if (ctx.daemonClient) {
        ctx.daemonClient.on('exit', handler);
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

    // Signal renderer to respawn
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('pane-model-changed', { paneId, model });

      // Auto-inject context after a delay to allow CLI to start
      // This solves the cold-start problem after model switch
      // Selects context file based on model: CLAUDE.md, AGENTS.md (codex), or GEMINI.md
      const instanceDir = INSTANCE_DIRS[id];
      if (instanceDir && fs.existsSync(instanceDir)) {
        setTimeout(async () => {
          try {
            const claudePath = path.join(instanceDir, 'CLAUDE.md');
            const agentsPath = path.join(instanceDir, 'AGENTS.md');
            const geminiPath = path.join(instanceDir, 'GEMINI.md');
            let injectionText = '';

            // Select primary context file based on model type
            if (model === 'gemini' && fs.existsSync(geminiPath)) {
              injectionText = fs.readFileSync(geminiPath, 'utf-8') + '\n';
            } else if (model === 'codex' && fs.existsSync(agentsPath)) {
              injectionText = fs.readFileSync(agentsPath, 'utf-8') + '\n';
            } else if (fs.existsSync(claudePath)) {
              injectionText = fs.readFileSync(claudePath, 'utf-8') + '\n';
            }

            if (injectionText && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
              const role = ctx.currentSettings.paneRoles?.[id] || `Pane ${id}`;
              const header = `\r\n# HIVEMIND CONTEXT INJECTION: ${role} configuration\r\n`;
              
              log.info('ModelSwitch', `Injecting ${injectionText.length} bytes of context to pane ${id}`);
              
              ctx.mainWindow.webContents.send('inject-message', {
                panes: [id],
                message: header + injectionText + '\r',
                meta: { source: 'model-switch-context' }
              });
            }
          } catch (err) {
            log.error('ModelSwitch', `Context injection failed for pane ${id}:`, err.message);
          }
        }, model === 'codex' ? 6000 : 5000); // Wait longer for Codex
      }
    }

    return { success: true, paneId, model };
  });
}

module.exports = { registerModelSwitchHandlers };
