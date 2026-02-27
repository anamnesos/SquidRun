/**
 * PTY IPC Handlers (via Daemon)
 * Channels: pty-create, pty-write, pty-write-chunked, send-trusted-enter,
 *           clipboard-paste-text, clipboard-write, input-edit-action, pty-resize, pty-kill, intent-update, spawn-claude,
 *           get-claude-state, get-daemon-terminals
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { resolvePaneCwd } = require('../../config');
const {
  hasCodexDangerouslyBypassFlag,
  hasCodexAskForApprovalFlag,
} = require('../codex-utils');
const DEFAULT_CHUNK_SIZE = 2048;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 8192;
const DEFAULT_AUTO_CHUNK_THRESHOLD_BYTES = 1024;
const WRITE_ACK_TIMEOUT_MS = 2500;
const INPUT_EDIT_ACTIONS = Object.freeze({
  undo: 'undo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
});

function sendReturnInputEvent(webContents) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}

function injectTextViaInputEvents(webContents, text) {
  const safeText = typeof text === 'string' ? text : String(text ?? '');
  for (let i = 0; i < safeText.length; i += 1) {
    const ch = safeText[i];
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && safeText[i + 1] === '\n') {
        i += 1;
      }
      sendReturnInputEvent(webContents);
      continue;
    }
    webContents.sendInputEvent({ type: 'char', keyCode: ch });
  }
}

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

function resolveAutoChunkThresholdBytes() {
  const raw = Number(process.env.SQUIDRUN_PTY_WRITE_AUTO_CHUNK_THRESHOLD_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AUTO_CHUNK_THRESHOLD_BYTES;
  }
  return Math.floor(raw);
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function detectCliFromCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return 'claude';
  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('codex')) return 'codex';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('codex')) return 'codex';
  return 'claude';
}

function resolveWindowsClaudeTempDir(cwd, env = process.env) {
  if (process.platform !== 'win32') return null;

  const winPath = path.win32;
  const seen = new Set();
  const candidates = [];
  const explicitTempRoot = toNonEmptyString(env.SQUIDRUN_WINDOWS_TMP)
    || toNonEmptyString(env.SQUIDRUN_TEMP_DIR);
  if (explicitTempRoot) {
    candidates.push(explicitTempRoot);
  }

  const cwdValue = toNonEmptyString(cwd);
  if (cwdValue) {
    candidates.push(winPath.join(cwdValue, '.squidrun', 'tmp'));
  }

  const parsedRoot = cwdValue ? toNonEmptyString(winPath.parse(cwdValue).root) : null;
  const systemDrive = toNonEmptyString(env.SystemDrive) || 'C:';
  const driveRoot = parsedRoot || `${systemDrive}\\`;
  candidates.push(winPath.join(driveRoot, 'squidrun-tmp'));
  candidates.push('C:\\squidrun-tmp');

  for (const candidateRaw of candidates) {
    const candidate = toNonEmptyString(candidateRaw);
    if (!candidate) continue;

    const normalized = winPath.normalize(candidate);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (/\s/.test(normalized)) continue;

    try {
      fs.mkdirSync(normalized, { recursive: true });
      return normalized;
    } catch (_) {
      // Try next fallback candidate.
    }
  }

  return null;
}

function hasClaudeSystemPromptFlag(command) {
  return /--system-prompt-file(?:\s|=)/i.test(String(command || ''));
}

function getPaneCommandForRuntime(ctx, paneId) {
  const id = String(paneId);
  const paneCommands = ctx?.currentSettings?.paneCommands || {};
  const command = paneCommands[id];
  return typeof command === 'string' ? command : '';
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

function isPaneHostSender(event) {
  const frameUrl = String(
    event?.senderFrame?.url
    || (typeof event?.sender?.getURL === 'function' ? event.sender.getURL() : '')
    || ''
  ).toLowerCase();
  return frameUrl.includes('/pane-host.html') || frameUrl.includes('\\pane-host.html');
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

async function writeChunkedText(daemonClient, paneId, fullText, options = {}, kernelMeta = null) {
  const text = String(fullText ?? '');
  const chunkSize = clampChunkSize(options?.chunkSize);
  const yieldEveryChunks = normalizeYieldEveryChunks(options?.yieldEveryChunks);

  let chunkCount = 0;
  if (text.length === 0) {
    const ack = await writeWithAckIfAvailable(
      daemonClient,
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
    const ack = await writeWithAckIfAvailable(daemonClient, paneId, chunk, chunkKernelMeta);
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
      await Promise.resolve();
    }
  }

  return { success: true, chunks: chunkCount, chunkSize };
}

function registerPtyHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPtyHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  const { broadcastClaudeState, recordSessionStart, recordSessionLifecycle, updateIntentState } = deps;
  const getRecoveryManager = () => deps?.recoveryManager || ctx.recoveryManager;
  const getFirmwareManager = () => deps?.firmwareManager || ctx.firmwareManager;
  const isDeveloperMode = () => String(ctx?.currentSettings?.operatingMode || '').toLowerCase() === 'developer';
  const getPaneProjects = () => {
    const paneProjects = ctx?.currentSettings?.paneProjects;
    return paneProjects && typeof paneProjects === 'object' ? paneProjects : {};
  };
  const getActiveProjectRoot = () => {
    if (isDeveloperMode()) {
      return null;
    }
    try {
      const state = ctx?.watcher?.readState?.();
      const project = typeof state?.project === 'string' ? state.project.trim() : '';
      return project || null;
    } catch (_) {
      return null;
    }
  };
  const isFirmwareEnabled = () => ctx?.currentSettings?.firmwareInjectionEnabled === true;

  function resolveFirmwarePathForPane(paneId) {
    if (!isFirmwareEnabled()) return null;
    const firmwareManager = getFirmwareManager();
    if (!firmwareManager || typeof firmwareManager.ensureFirmwareForPane !== 'function') {
      return null;
    }
    const result = firmwareManager.ensureFirmwareForPane(paneId);
    if (!result?.ok || !result.firmwarePath) {
      return null;
    }
    return result.firmwarePath;
  }

  ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      log.error('PTY', 'pty-create: Daemon not connected');
      return { error: 'Daemon not connected' };
    }

    const paneRoot = resolvePaneCwd(paneId, {
      paneProjects: getPaneProjects(),
      projectRoot: getActiveProjectRoot(),
    });
    const cwd = paneRoot || workingDir || process.cwd();
    const paneCommand = getPaneCommandForRuntime(ctx, paneId);
    const runtime = detectCliFromCommand(paneCommand);

    let spawnEnv = null;

    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE || '';
      if (userProfile && !userProfile.includes('~')) {
        const longTemp = path.join(userProfile, 'AppData', 'Local', 'Temp');
        spawnEnv = { TEMP: longTemp, TMP: longTemp };
      }

      if (runtime === 'claude') {
        const compatTemp = resolveWindowsClaudeTempDir(cwd);
        if (compatTemp) {
          spawnEnv = {
            ...(spawnEnv || {}),
            TEMP: compatTemp,
            TMP: compatTemp,
            TMPDIR: compatTemp,
          };
        }
      }
    }

    if (runtime === 'gemini') {
      try {
        const firmwarePath = resolveFirmwarePathForPane(paneId);
        if (firmwarePath) {
          spawnEnv = spawnEnv || {};
          spawnEnv.GEMINI_SYSTEM_MD = firmwarePath;
        }
      } catch (err) {
        log.warn('Firmware', `Failed to resolve Gemini firmware for pane ${paneId}: ${err.message}`);
      }
    }

    const spawnOptions = { paneCommand };
    if (spawnEnv) {
      ctx.daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, null, spawnEnv, spawnOptions);
    } else {
      ctx.daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, null, null, spawnOptions);
    }
    return { paneId, cwd, dryRun: ctx.currentSettings.dryRun };
  });

  ipcMain.handle('pty-write', async (event, paneId, data, kernelMeta = null) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'daemon_not_connected' };
    }
    try {
      const text = String(data ?? '');
      const autoChunkThresholdBytes = resolveAutoChunkThresholdBytes();
      const payloadBytes = Buffer.byteLength(text, 'utf8');
      if (payloadBytes >= autoChunkThresholdBytes && payloadBytes > 0) {
        const chunkedResult = await writeChunkedText(
          ctx.daemonClient,
          paneId,
          text,
          { chunkSize: DEFAULT_CHUNK_SIZE, yieldEveryChunks: 1 },
          kernelMeta
        );
        if (!chunkedResult?.success) {
          return {
            success: false,
            error: chunkedResult?.error || 'daemon_write_failed',
          };
        }
        return {
          success: true,
          chunked: true,
          chunks: chunkedResult.chunks,
          chunkSize: chunkedResult.chunkSize,
        };
      }

      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      const accepted = kernelMeta
        ? ctx.daemonClient.write(paneId, text, normalizedKernelMeta || kernelMeta)
        : ctx.daemonClient.write(paneId, text);
      if (!accepted) {
        return { success: false, error: 'daemon_write_failed' };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || 'daemon_write_failed' };
    }
  });

  ipcMain.handle('pty-write-chunked', async (event, paneId, fullText, options = {}, kernelMeta = null) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return;
    }

    return writeChunkedText(ctx.daemonClient, paneId, fullText, options, kernelMeta);
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
    try {
      const writeAccepted = ctx.daemonClient.write(paneId, '\x03');
      if (writeAccepted === false) {
        return { success: false, error: 'daemon_write_failed' };
      }
    } catch (err) {
      return { success: false, error: err?.message || 'daemon_write_failed' };
    }
    log.info('PTY', `Interrupt sent to pane ${paneId}`);
    return { success: true };
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
      sendReturnInputEvent(ctx.mainWindow.webContents);
      return { success: true };
    } catch (err) {
      log.error('PTY', 'send-trusted-enter failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Compatibility path for legacy callers.
  // Uses direct input insertion to avoid mutating global clipboard state.
  ipcMain.handle('clipboard-paste-text', async (_event, text) => {
    const webContents = ctx.mainWindow?.webContents;
    if (!webContents) {
      return { success: false, method: null, insertedLength: 0, error: 'mainWindow not available' };
    }

    const safeText = typeof text === 'string' ? text : String(text ?? '');
    if (safeText.length === 0) {
      return { success: true, method: 'noop', insertedLength: 0 };
    }

    try {
      if (typeof ctx.mainWindow.focus === 'function') {
        ctx.mainWindow.focus();
      }
      if (typeof webContents.focus === 'function') {
        webContents.focus();
      }
    } catch (_) {}

    try {
      if (typeof webContents.insertText === 'function') {
        await Promise.resolve(webContents.insertText(safeText));
        return { success: true, method: 'insertText', insertedLength: safeText.length };
      }

      if (typeof webContents.sendInputEvent === 'function') {
        injectTextViaInputEvents(webContents, safeText);
        return { success: true, method: 'sendInputEvent', insertedLength: safeText.length, fallback: true };
      }

      return { success: false, method: null, insertedLength: 0, error: 'No text injection method available' };
    } catch (err) {
      log.error('PTY', 'clipboard-paste-text failed:', err);
      return { success: false, method: null, insertedLength: 0, error: err.message };
    }
  });

  ipcMain.handle('clipboard-write', async (event, text) => {
    const { clipboard } = require('electron');
    try {
      const safeText = typeof text === 'string' ? text : String(text ?? '');
      clipboard.writeText(safeText);
      return { success: true };
    } catch (err) {
      log.error('PTY', 'clipboard-write failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('input-edit-action', async (event, action) => {
    const webContents = ctx.mainWindow?.webContents;
    if (!webContents) {
      return { success: false, error: 'mainWindow not available' };
    }

    const normalizedAction = String(action || '').trim();
    const method = INPUT_EDIT_ACTIONS[normalizedAction];
    if (!method || typeof webContents[method] !== 'function') {
      return { success: false, error: 'unsupported_action' };
    }

    try {
      webContents[method]();
      return { success: true };
    } catch (err) {
      log.error('PTY', `input-edit-action failed (${normalizedAction}):`, err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('pty-resize', (event, paneId, cols, rows, kernelMeta = null) => {
    // Hidden pane hosts are mirror windows and must not own PTY geometry.
    // Only the visible renderer should drive resize to avoid cursor/wrap drift.
    if (isPaneHostSender(event)) {
      log.warn('PTY', `Ignored pane-host resize for pane ${paneId} (${cols}x${rows})`);
      return { ignored: true, reason: 'pane_host_resize_blocked' };
    }

    if (ctx.daemonClient && ctx.daemonClient.connected) {
      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      if (kernelMeta) {
        ctx.daemonClient.resize(paneId, cols, rows, normalizedKernelMeta || kernelMeta);
      } else {
        ctx.daemonClient.resize(paneId, cols, rows);
      }
    }
    return { ignored: false };
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

  ipcMain.handle('spawn-claude', async (event, paneId, _workingDir) => {
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
    const runtime = detectCliFromCommand(agentCmd);

    if (isFirmwareEnabled()) {
      const firmwareManager = getFirmwareManager();
      if (firmwareManager) {
        try {
          if (runtime === 'claude') {
            const firmwarePath = resolveFirmwarePathForPane(paneId);
            if (firmwarePath && !hasClaudeSystemPromptFlag(agentCmd)) {
              agentCmd = `${agentCmd} --system-prompt-file "${firmwarePath}"`;
            }
          } else if (runtime === 'codex' && typeof firmwareManager.applyCodexOverrideForPane === 'function') {
            firmwareManager.applyCodexOverrideForPane(paneId);
          }
        } catch (err) {
          log.warn('Firmware', `Failed firmware preparation for pane ${paneId}: ${err.message}`);
        }
      }
    }

    const autonomyConsentGiven = ctx?.currentSettings?.autonomyConsentGiven === true;
    const autonomyEnabled = autonomyConsentGiven && ctx?.currentSettings?.allowAllPermissions === true;

    if (autonomyEnabled) {
      if (agentCmd.startsWith('claude') && !agentCmd.includes('--dangerously-skip-permissions')) {
        agentCmd = `${agentCmd} --dangerously-skip-permissions`;
      }
      if (agentCmd.startsWith('codex')) {
        const hasDangerouslyBypass = hasCodexDangerouslyBypassFlag(agentCmd);
        const hasAskForApproval = hasCodexAskForApprovalFlag(agentCmd);
        const hasYolo = agentCmd.includes('--yolo');
        // --yolo (alias for --dangerously-bypass-approvals-and-sandbox) conflicts
        // with -a / --ask-for-approval.  Prefer --yolo when autonomy is enabled.
        if (!hasDangerouslyBypass && !hasYolo) {
          agentCmd = `${agentCmd} --yolo`;
        }
        // Only add -a if --yolo / --dangerously-bypass wasn't added (they conflict)
        if (!agentCmd.includes('--yolo') && !hasCodexDangerouslyBypassFlag(agentCmd)
            && !hasDangerouslyBypass && !hasAskForApproval) {
          agentCmd = `${agentCmd} -a never`;
        }
      }
    }

    return { success: true, command: agentCmd };
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
    ipcMain.removeHandler('send-trusted-enter');
    ipcMain.removeHandler('clipboard-paste-text');
    ipcMain.removeHandler('clipboard-write');
    ipcMain.removeHandler('input-edit-action');
    ipcMain.removeHandler('pty-resize');
    ipcMain.removeHandler('pty-kill');
    ipcMain.removeHandler('intent-update');
    ipcMain.removeHandler('spawn-claude');
    ipcMain.removeHandler('get-claude-state');
    ipcMain.removeHandler('get-daemon-terminals');
  }
}

registerPtyHandlers.unregister = unregisterPtyHandlers;

module.exports = {
  registerPtyHandlers,
  _internals: {
    resolveWindowsClaudeTempDir,
  },
};
