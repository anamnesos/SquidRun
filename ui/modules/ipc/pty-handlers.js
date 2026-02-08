/**
 * PTY IPC Handlers (via Daemon)
 * Channels: pty-create, pty-write, codex-exec, send-trusted-enter,
 *           clipboard-paste-text, pty-resize, pty-kill, spawn-claude,
 *           get-claude-state, get-daemon-terminals
 */

const log = require('../logger');

function registerPtyHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPtyHandlers requires ctx.ipcMain');
  }
  const { ipcMain, INSTANCE_DIRS } = ctx;
  const { broadcastClaudeState, recordSessionStart } = deps;
  const getRecoveryManager = () => deps?.recoveryManager || ctx.recoveryManager;

  ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      log.error('PTY', 'pty-create: Daemon not connected');
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

  ipcMain.handle('pty-pause', (event, paneId) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.pause(paneId);
    }
  });

  ipcMain.handle('pty-resume', (event, paneId) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      ctx.daemonClient.resume(paneId);
    }
  });

  ipcMain.handle('interrupt-pane', (event, paneId) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }
    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }
    ctx.daemonClient.write(paneId, '\x03');
    log.info('PTY', `Interrupt sent to pane ${paneId}`);
    return { success: true };
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
  ipcMain.handle('send-trusted-enter', (event) => {
    if (ctx.mainWindow && ctx.mainWindow.webContents) {
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
  });

  // Clipboard paste approach for Codex panes
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
      const recoveryManager = getRecoveryManager();
      if (paneId && recoveryManager?.markExpectedExit) {
        recoveryManager.markExpectedExit(paneId, 'manual-kill');
      }
      ctx.daemonClient.kill(paneId);
    }
  });

  ipcMain.handle('spawn-claude', (event, paneId, workingDir) => {
    // SDK Mode Guard: Block CLI spawn when SDK mode is active
    if (ctx.currentSettings.sdkMode) {
      log.info('PTY', 'spawn-claude: SDK mode - blocking CLI spawn');
      return { success: false, error: 'SDK mode active' };
    }

    // Dry-run mode - simulate without spawning real agents
    if (ctx.currentSettings.dryRun) {
      ctx.agentRunning.set(paneId, 'running');
      broadcastClaudeState();
      return { success: true, command: null, dryRun: true };
    }

    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    ctx.agentRunning.set(paneId, 'starting');
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
      if (!agentCmd.includes('--dangerously-bypass-approvals-and-sandbox') && !agentCmd.includes('--yolo')) {
        agentCmd = `${agentCmd} --yolo`;
      }
    }

    return { success: true, command: agentCmd };
  });

  // Context injection for agent panes (AGENTS.md, CLAUDE.md, GEMINI.md)
  ipcMain.handle('inject-context', async (event, paneId, model, delay = 5000) => {
    const contextInjection = ctx.contextInjection;
    if (!contextInjection) {
      log.warn('PTY', 'inject-context: contextInjection manager not available');
      return { success: false, error: 'Context injection not available' };
    }
    try {
      await contextInjection.injectContext(paneId, model, delay);
      log.info('PTY', `inject-context: scheduled for pane ${paneId} (model=${model}, delay=${delay}ms)`);
      return { success: true };
    } catch (err) {
      log.error('PTY', `inject-context failed for pane ${paneId}:`, err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-claude-state', () => {
    return Object.fromEntries(ctx.agentRunning);
  });

  ipcMain.handle('get-daemon-terminals', () => {
    if (ctx.daemonClient) {
      return ctx.daemonClient.getTerminals();
    }
    return [];
  });
}

function unregisterPtyHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('pty-create');
    ipcMain.removeHandler('pty-write');
    ipcMain.removeHandler('pty-pause');
    ipcMain.removeHandler('pty-resume');
    ipcMain.removeHandler('interrupt-pane');
    ipcMain.removeHandler('codex-exec');
    ipcMain.removeHandler('send-trusted-enter');
    ipcMain.removeHandler('clipboard-paste-text');
    ipcMain.removeHandler('pty-resize');
    ipcMain.removeHandler('pty-kill');
    ipcMain.removeHandler('spawn-claude');
    ipcMain.removeHandler('inject-context');
    ipcMain.removeHandler('get-claude-state');
    ipcMain.removeHandler('get-daemon-terminals');
  }
}

registerPtyHandlers.unregister = unregisterPtyHandlers;

module.exports = { registerPtyHandlers };
