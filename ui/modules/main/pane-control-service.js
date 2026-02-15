const log = require('../logger');

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeAction(action) {
  const normalized = asNonEmptyString(String(action || '').toLowerCase());
  if (!normalized) return null;
  if (normalized === 'enter-pane') return 'enter';
  if (normalized === 'interrupt-pane') return 'interrupt';
  if (normalized === 'restart-pane') return 'restart';
  if (normalized === 'nudge-pane' || normalized === 'nudge-agent') return 'nudge';
  return normalized;
}

function detectPaneModel(paneId, currentSettings = {}) {
  const paneCommands = currentSettings?.paneCommands || {};
  const command = String(paneCommands[String(paneId)] || '').toLowerCase();
  if (command.includes('gemini')) return 'gemini';
  if (command.includes('codex')) return 'codex';
  return 'claude';
}

function isWindowAvailable(mainWindow) {
  return Boolean(mainWindow && typeof mainWindow.isDestroyed === 'function' && !mainWindow.isDestroyed());
}

function isDaemonAvailable(daemonClient) {
  return Boolean(daemonClient && daemonClient.connected && typeof daemonClient.write === 'function');
}

function executePaneControlAction(ctx = {}, action, payload = {}) {
  const normalizedAction = normalizeAction(action);
  const normalizedPayload = asObject(payload);
  const paneId = asNonEmptyString(String(normalizedPayload.paneId || normalizedPayload.pane || ''));

  if (!normalizedAction) {
    return { success: false, reason: 'unknown_action', action: String(action || '') };
  }

  if (!paneId) {
    return { success: false, reason: 'missing_pane_id' };
  }

  const daemonClient = ctx.daemonClient || null;
  const mainWindow = ctx.mainWindow || null;
  const recoveryManager = ctx.recoveryManager || null;
  const agentRunning = ctx.agentRunning;

  if (normalizedAction === 'enter') {
    const model = detectPaneModel(paneId, ctx.currentSettings || {});
    if (model === 'codex' || model === 'gemini') {
      if (!isDaemonAvailable(daemonClient)) {
        return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
      }
      daemonClient.write(paneId, '\r');
      return {
        success: true,
        paneId,
        action: normalizedAction,
        method: 'pty',
        model,
      };
    }

    if (!isWindowAvailable(mainWindow)) {
      return { success: false, reason: 'window_not_available', paneId, action: normalizedAction };
    }

    mainWindow.webContents.send('pane-enter', {
      paneId,
      model: 'claude',
      method: 'sendTrustedEnter',
    });
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'sendTrustedEnter',
      model: 'claude',
    };
  }

  if (normalizedAction === 'interrupt') {
    if (!isDaemonAvailable(daemonClient)) {
      return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
    }
    daemonClient.write(paneId, '\x03');
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'sigint',
    };
  }

  if (normalizedAction === 'restart') {
    if (!isDaemonAvailable(daemonClient)) {
      return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
    }
    if (!isWindowAvailable(mainWindow)) {
      return { success: false, reason: 'window_not_available', paneId, action: normalizedAction };
    }

    if (recoveryManager && typeof recoveryManager.markExpectedExit === 'function') {
      recoveryManager.markExpectedExit(paneId, 'manual-restart');
    }
    mainWindow.webContents.send('restart-pane', { paneId });
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'restart-pane',
    };
  }

  if (normalizedAction === 'nudge') {
    if (!isWindowAvailable(mainWindow)) {
      return { success: false, reason: 'window_not_available', paneId, action: normalizedAction };
    }

    const message = asNonEmptyString(normalizedPayload.message || '');
    if (message) {
      const isRunning = agentRunning && typeof agentRunning.get === 'function'
        ? agentRunning.get(paneId) === 'running'
        : true;
      if (!isRunning) {
        return { success: false, reason: 'agent_not_running', paneId, action: normalizedAction };
      }

      mainWindow.webContents.send('inject-message', {
        panes: [paneId],
        message: `${message}\r`,
      });
      return {
        success: true,
        paneId,
        action: normalizedAction,
        method: 'nudge-agent',
      };
    }

    if (!isDaemonAvailable(daemonClient)) {
      return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
    }
    mainWindow.webContents.send('nudge-pane', { paneId });
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'nudge-pane',
    };
  }

  log.warn('PaneControl', `Unsupported pane-control action: ${normalizedAction}`);
  return {
    success: false,
    reason: 'unknown_action',
    action: normalizedAction,
    paneId,
  };
}

module.exports = {
  executePaneControlAction,
  detectPaneModel,
  normalizeAction,
};
