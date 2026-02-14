/**
 * PTY IPC Handlers (via Daemon)
 * Channels: pty-create, pty-write, pty-write-chunked, codex-exec, send-trusted-enter,
 *           clipboard-paste-text, pty-resize, pty-kill, intent-update, spawn-claude,
 *           get-claude-state, get-daemon-terminals
 */

const log = require('../logger');
const { resolvePaneCwd } = require('../../config');
const DEFAULT_CHUNK_SIZE = 2048;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 8192;
const WRITE_ACK_TIMEOUT_MS = 2500;

function clampChunkSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, Math.floor(numeric)));
}

function normalizeYieldEveryChunks(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeKernelMetaForTrace(kernelMeta) {
  if (!kernelMeta || typeof kernelMeta !== 'object') {
    return null;
  }
  const traceId = toNonEmptyString(kernelMeta.traceId)
    || toNonEmptyString(kernelMeta.correlationId)
    || null;
  const parentEventId = toNonEmptyString(kernelMeta.parentEventId)
    || toNonEmptyString(kernelMeta.causationId)
    || null;
  return {
    ...kernelMeta,
    traceId: traceId || undefined,
    correlationId: traceId || undefined,
    parentEventId: parentEventId || undefined,
    causationId: parentEventId || undefined,
  };
}

function buildChunkKernelMeta(kernelMeta, chunkIndex) {
  const normalized = normalizeKernelMetaForTrace(kernelMeta);
  if (!normalized) {
    return null;
  }
  const baseEventId = normalized.eventId || `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parentEventId = normalized.parentEventId || normalized.eventId || null;
  return {
    ...normalized,
    eventId: `${baseEventId}-c${chunkIndex + 1}`,
    parentEventId: parentEventId || undefined,
    causationId: parentEventId || undefined,
  };
}

async function writeWithAckIfAvailable(daemonClient, paneId, data, kernelMeta = null) {
  if (!daemonClient) {
    return { success: false, status: 'daemon_missing', error: 'daemonClient not available' };
  }

  if (typeof daemonClient.writeAndWaitAck === 'function') {
    return daemonClient.writeAndWaitAck(paneId, data, kernelMeta, { timeoutMs: WRITE_ACK_TIMEOUT_MS });
  }

  const sent = kernelMeta
    ? daemonClient.write(paneId, data, kernelMeta)
    : daemonClient.write(paneId, data);
  return sent === false
    ? { success: false, status: 'send_failed', error: 'Failed to send write to daemon' }
    : { success: true, status: 'sent_without_ack' };
}

function registerPtyHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPtyHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  const { broadcastClaudeState, recordSessionStart, recordSessionLifecycle, updateIntentState } = deps;
  const getRecoveryManager = () => deps?.recoveryManager || ctx.recoveryManager;

  ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      log.error('PTY', 'pty-create: Daemon not connected');
      return { error: 'Daemon not connected' };
    }

    const paneRoot = resolvePaneCwd(paneId);
    const cwd = paneRoot || workingDir || process.cwd();

    const paneCommands = ctx.currentSettings.paneCommands || {};
    const cmd = (paneCommands[paneId] || '').trim().toLowerCase();
    const mode = cmd.includes('codex') ? 'codex-exec' : null;

    ctx.daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, mode);
    return { paneId, cwd, dryRun: ctx.currentSettings.dryRun };
  });

  ipcMain.handle('pty-write', (event, paneId, data, kernelMeta = null) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      if (kernelMeta) {
        ctx.daemonClient.write(paneId, data, normalizedKernelMeta || kernelMeta);
      } else {
        ctx.daemonClient.write(paneId, data);
      }
    }
  });

  ipcMain.handle('pty-write-chunked', async (event, paneId, fullText, options = {}, kernelMeta = null) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return;
    }

    const text = String(fullText ?? '');
    const chunkSize = clampChunkSize(options?.chunkSize);
    const yieldEveryChunks = normalizeYieldEveryChunks(options?.yieldEveryChunks);

    let chunkCount = 0;
    if (text.length === 0) {
      const ack = await writeWithAckIfAvailable(
        ctx.daemonClient,
        paneId,
        '',
        normalizeKernelMetaForTrace(kernelMeta)
      );
      if (!ack?.success) {
        return {
          success: false,
          chunks: 0,
          chunkSize,
          error: ack?.error || ack?.status || 'chunk write failed',
        };
      }
      return { success: true, chunks: 1, chunkSize };
    }

    for (let offset = 0; offset < text.length; offset += chunkSize) {
      const chunk = text.slice(offset, offset + chunkSize);
      const chunkKernelMeta = buildChunkKernelMeta(kernelMeta, chunkCount);
      const ack = await writeWithAckIfAvailable(ctx.daemonClient, paneId, chunk, chunkKernelMeta);
      if (!ack?.success) {
        return {
          success: false,
          chunks: chunkCount,
          chunkSize,
          error: ack?.error || ack?.status || 'chunk write failed',
        };
      }
      chunkCount += 1;

      const hasMore = (offset + chunkSize) < text.length;
      if (hasMore && yieldEveryChunks > 0 && (chunkCount % yieldEveryChunks) === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return { success: true, chunks: chunkCount, chunkSize };
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
  ipcMain.handle('codex-exec', async (event, paneId, prompt) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }
    let result;
    if (typeof ctx.daemonClient.codexExecAndWait === 'function') {
      result = await ctx.daemonClient.codexExecAndWait(paneId, prompt || '');
    } else {
      const sent = ctx.daemonClient.codexExec(paneId, prompt || '');
      result = sent === false
        ? { success: false, status: 'send_failed', error: 'Failed to send codex-exec request to daemon' }
        : { success: true, status: 'sent_without_ack' };
    }

    if (!result || result.success === false) {
      return {
        success: false,
        error: result?.error || result?.status || 'Codex exec request failed',
        status: result?.status || 'rejected',
      };
    }

    return {
      success: true,
      status: result.status || 'accepted',
      requestId: result.requestId || null,
    };
  });

  // Send trusted keyboard Enter via Electron's native input API
  ipcMain.handle('send-trusted-enter', async () => {
    if (!ctx.mainWindow || !ctx.mainWindow.webContents) {
      return { success: false, error: 'mainWindow not available' };
    }
    try {
      if (typeof ctx.mainWindow.focus === 'function') {
        ctx.mainWindow.focus();
      }
      if (typeof ctx.mainWindow.webContents.focus === 'function') {
        ctx.mainWindow.webContents.focus();
      }
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
      ctx.mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      return { success: true };
    } catch (err) {
      log.error('PTY', 'send-trusted-enter failed:', err);
      return { success: false, error: err.message };
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

  ipcMain.handle('pty-resize', (event, paneId, cols, rows, kernelMeta = null) => {
    if (ctx.daemonClient && ctx.daemonClient.connected) {
      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      if (kernelMeta) {
        ctx.daemonClient.resize(paneId, cols, rows, normalizedKernelMeta || kernelMeta);
      } else {
        ctx.daemonClient.resize(paneId, cols, rows);
      }
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

  ipcMain.handle('intent-update', async (event, payload = {}) => {
    if (typeof updateIntentState !== 'function') {
      return { ok: false, reason: 'intent_update_unavailable' };
    }
    return updateIntentState(payload);
  });

  ipcMain.handle('spawn-claude', async (event, paneId, workingDir) => {
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
    if (typeof recordSessionLifecycle === 'function') {
      await Promise.resolve(recordSessionLifecycle({
        paneId,
        status: 'started',
        reason: 'spawn_requested',
      }));
    }

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

  // Context injection for agent panes (ROLES.md + model notes)
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
    ipcMain.removeHandler('pty-write-chunked');
    ipcMain.removeHandler('pty-pause');
    ipcMain.removeHandler('pty-resume');
    ipcMain.removeHandler('interrupt-pane');
    ipcMain.removeHandler('codex-exec');
    ipcMain.removeHandler('send-trusted-enter');
    ipcMain.removeHandler('clipboard-paste-text');
    ipcMain.removeHandler('pty-resize');
    ipcMain.removeHandler('pty-kill');
    ipcMain.removeHandler('intent-update');
    ipcMain.removeHandler('spawn-claude');
    ipcMain.removeHandler('inject-context');
    ipcMain.removeHandler('get-claude-state');
    ipcMain.removeHandler('get-daemon-terminals');
  }
}

registerPtyHandlers.unregister = unregisterPtyHandlers;

module.exports = { registerPtyHandlers };
