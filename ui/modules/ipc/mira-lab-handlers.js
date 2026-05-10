'use strict';

const crypto = require('crypto');

const { getProjectRoot } = require('../../config');
const {
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabPromptReply,
  buildMiraLabTurn,
  exportMiraLabTranscript,
} = require('../mira-lab-surface');

const MIRA_LAB_OPEN_CHANNEL = 'mira:lab-open';
const MIRA_LAB_RENDERER_DRIVE_CHANNEL = 'mira:lab-renderer-drive';
const MIRA_LAB_RENDERER_DRIVE_RESULT_CHANNEL = 'mira:lab-renderer-drive-result';
const DEFAULT_RENDERER_DRIVE_TIMEOUT_MS = 10000;

const pendingRendererDrives = new Map();
let resultListenerInstalled = false;
let resultListenerDispose = null;

async function buildMiraLabTurnResponse(payload = {}, options = {}) {
  return buildMiraLabTurn(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

async function buildMiraLabPromptReplyResponse(payload = {}, options = {}) {
  return buildMiraLabPromptReply(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function exportMiraLabTranscriptResponse(payload = {}, options = {}) {
  return exportMiraLabTranscript(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function openMiraLabWindowResponse(payload = {}, options = {}) {
  const factory = options.createMiraLabWindow || options.openWindow;
  if (typeof factory !== 'function') {
    return {
      ok: false,
      reason: 'mira_lab_window_factory_missing',
      channel: MIRA_LAB_OPEN_CHANNEL,
    };
  }
  try {
    const result = factory({
      ...options,
      requestedAt: new Date().toISOString(),
      payload,
    }) || {};
    return {
      ok: true,
      channel: MIRA_LAB_OPEN_CHANNEL,
      htmlPath: result.htmlPath || null,
      preloadPath: result.preloadPath || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || 'mira_lab_window_open_failed',
      channel: MIRA_LAB_OPEN_CHANNEL,
    };
  }
}

function generateCorrelationId() {
  return `mira-lab-drive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function installResultListener(ipcMain) {
  if (resultListenerInstalled) return;
  const listener = (_event, payload = {}) => {
    const correlationId = payload && typeof payload.correlationId === 'string' ? payload.correlationId : null;
    if (!correlationId) return;
    const pending = pendingRendererDrives.get(correlationId);
    if (!pending) return;
    pendingRendererDrives.delete(correlationId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(payload);
  };
  ipcMain.on(MIRA_LAB_RENDERER_DRIVE_RESULT_CHANNEL, listener);
  resultListenerInstalled = true;
  resultListenerDispose = () => {
    if (typeof ipcMain.removeListener === 'function') {
      ipcMain.removeListener(MIRA_LAB_RENDERER_DRIVE_RESULT_CHANNEL, listener);
    } else if (typeof ipcMain.off === 'function') {
      ipcMain.off(MIRA_LAB_RENDERER_DRIVE_RESULT_CHANNEL, listener);
    }
    resultListenerInstalled = false;
    resultListenerDispose = null;
  };
}

function uninstallResultListener() {
  if (resultListenerDispose) resultListenerDispose();
  for (const [correlationId, pending] of pendingRendererDrives.entries()) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingRendererDrives.delete(correlationId);
    try {
      pending.resolve({
        ok: false,
        error: 'result_listener_uninstalled',
        correlationId,
      });
    } catch (_) { /* best-effort */ }
  }
}

function getOpenMiraLabWebContents(deps) {
  if (typeof deps.getMiraLabWindow !== 'function') return { error: 'window_lookup_unavailable' };
  let win;
  try { win = deps.getMiraLabWindow(); } catch (err) {
    return { error: 'window_lookup_failed', message: err && err.message ? err.message : String(err) };
  }
  if (!win) return { error: 'window_not_open' };
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return { error: 'window_destroyed' };
  const wc = win.webContents;
  if (!wc) return { error: 'web_contents_unavailable' };
  if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return { error: 'window_crashed' };
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return { error: 'web_contents_destroyed' };
  return { window: win, webContents: wc };
}

async function driveMiraLabRenderer(payload = {}, deps = {}) {
  const ipcMain = deps.ipcMain;
  if (!ipcMain) return { ok: false, error: 'ipc_main_unavailable' };
  installResultListener(ipcMain);

  const lookup = getOpenMiraLabWebContents(deps);
  if (lookup.error) return { ok: false, error: lookup.error, message: lookup.message || null };

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'empty_prompt' };
  const requesterPane = payload.requesterPane || payload.requester_pane || null;
  const speakerRole = payload.speakerRole || payload.speaker_role || 'james';
  const sessionIdValue = payload.sessionId || payload.session_id || null;
  const timeoutMs = Number.isFinite(Number(payload.timeoutMs))
    ? Math.max(500, Math.min(60000, Number(payload.timeoutMs)))
    : DEFAULT_RENDERER_DRIVE_TIMEOUT_MS;
  const correlationId = generateCorrelationId();

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRendererDrives.delete(correlationId);
      resolve({ ok: false, error: 'renderer_timeout', timeout_ms: timeoutMs });
    }, timeoutMs);
    pendingRendererDrives.set(correlationId, { resolve, timer });
  });

  try {
    lookup.webContents.send(MIRA_LAB_RENDERER_DRIVE_CHANNEL, {
      correlationId,
      prompt,
      requesterPane,
      speakerRole,
      sessionId: sessionIdValue,
    });
  } catch (err) {
    const pending = pendingRendererDrives.get(correlationId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pendingRendererDrives.delete(correlationId);
    }
    return {
      ok: false,
      error: 'webcontents_send_failed',
      message: err && err.message ? err.message : String(err),
    };
  }

  const result = await promise;
  return { ...result, correlation_id: correlationId, channel: MIRA_LAB_RENDERER_DRIVE_CHANNEL };
}

function registerMiraLabHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraLabHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(MIRA_LAB_TURN_CHANNEL, (_event, payload = {}) =>
    buildMiraLabTurnResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_EXPORT_CHANNEL, (_event, payload = {}) =>
    exportMiraLabTranscriptResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_OPEN_CHANNEL, (_event, payload = {}) =>
    openMiraLabWindowResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_PROMPT_REPLY_CHANNEL, (_event, payload = {}) =>
    buildMiraLabPromptReplyResponse(payload, deps));
  installResultListener(ipcMain);
}

function unregisterMiraLabHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(MIRA_LAB_TURN_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_EXPORT_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_OPEN_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_PROMPT_REPLY_CHANNEL);
  uninstallResultListener();
}

registerMiraLabHandlers.unregister = unregisterMiraLabHandlers;

module.exports = {
  DEFAULT_RENDERER_DRIVE_TIMEOUT_MS,
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_OPEN_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_RENDERER_DRIVE_CHANNEL,
  MIRA_LAB_RENDERER_DRIVE_RESULT_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabPromptReplyResponse,
  buildMiraLabTurnResponse,
  driveMiraLabRenderer,
  exportMiraLabTranscriptResponse,
  openMiraLabWindowResponse,
  // Test seam — clears pending state and uninstalls listener.
  __resetForTests: () => uninstallResultListener(),
  registerMiraLabHandlers,
  unregisterMiraLabHandlers,
};
