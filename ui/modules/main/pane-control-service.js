const log = require('../logger');
const {
  DEFAULT_PROFILE,
  isMainProfile,
  normalizeProfileName,
} = require('../../profile');

const INSTANCE_ASSERTED_ACTIONS = new Set(['restart', 'switch-model']);

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeWindowKey(value, profileName = DEFAULT_PROFILE) {
  const raw = asNonEmptyString(value);
  if (raw) return normalizeProfileName(raw);
  return isMainProfile(profileName) ? DEFAULT_PROFILE : profileName;
}

function normalizeInstanceScope(input = {}) {
  const profileName = normalizeProfileName(
    input.profileName
    || input.profile
    || input.windowProfile
    || DEFAULT_PROFILE
  );
  return {
    profileName,
    windowKey: normalizeWindowKey(input.windowKey || input.window, profileName),
    sessionScopeId: asNonEmptyString(input.sessionScopeId || input.sessionScope || input.scopeId || ''),
  };
}

function extractInstanceAssertion(payload = {}) {
  const candidate = asObject(
    payload.targetInstance
    || payload.instanceAssertion
    || payload.instance
    || payload.targetScope
    || payload.scope
  );
  const source = Object.keys(candidate).length > 0 ? candidate : payload;
  const hasAssertion = Boolean(
    asNonEmptyString(source.profileName || source.profile || source.windowProfile || source.targetProfileName || '')
    || asNonEmptyString(source.windowKey || source.window || source.targetWindowKey || '')
    || asNonEmptyString(source.sessionScopeId || source.sessionScope || source.scopeId || '')
  );
  if (!hasAssertion) return null;
  return normalizeInstanceScope({
    profileName: source.profileName || source.profile || source.windowProfile || source.targetProfileName,
    windowKey: source.windowKey || source.window || source.targetWindowKey,
    sessionScopeId: source.sessionScopeId || source.sessionScope || source.scopeId,
  });
}

function buildRuntimeInstanceScope(ctx = {}) {
  return normalizeInstanceScope({
    profileName: ctx.instanceScope?.profileName
      || ctx.profileName
      || process.env.SQUIDRUN_PROFILE
      || DEFAULT_PROFILE,
    windowKey: ctx.instanceScope?.windowKey
      || ctx.windowKey
      || (isMainProfile(ctx.instanceScope?.profileName || ctx.profileName || process.env.SQUIDRUN_PROFILE || DEFAULT_PROFILE)
        ? DEFAULT_PROFILE
        : normalizeProfileName(ctx.instanceScope?.profileName || ctx.profileName || process.env.SQUIDRUN_PROFILE || DEFAULT_PROFILE)),
    sessionScopeId: ctx.instanceScope?.sessionScopeId || ctx.sessionScopeId || null,
  });
}

function validateInstanceAssertion(ctx = {}, normalizedAction, payload = {}, paneId = null) {
  if (!INSTANCE_ASSERTED_ACTIONS.has(normalizedAction)) return null;
  const expected = extractInstanceAssertion(payload);
  const actual = buildRuntimeInstanceScope(ctx);
  if (!expected) {
    return {
      success: false,
      reason: 'missing_instance_assertion',
      paneId,
      action: normalizedAction,
      actualInstance: actual,
    };
  }
  const mismatchField = ['profileName', 'windowKey', 'sessionScopeId'].find((field) => (
    expected[field] && actual[field] && expected[field] !== actual[field]
  ));
  if (!mismatchField) return null;
  log.warn(
    'PaneControl',
    `Rejected ${normalizedAction} for pane ${paneId || 'unknown'}: expected ${mismatchField}=${expected[mismatchField]} actual=${actual[mismatchField]}`
  );
  return {
    success: false,
    reason: 'instance_assertion_mismatch',
    paneId,
    action: normalizedAction,
    mismatchField,
    expectedInstance: expected,
    actualInstance: actual,
  };
}

function normalizeAction(action) {
  const normalized = asNonEmptyString(String(action || '').toLowerCase());
  if (!normalized) return null;
  if (normalized === 'enter-pane') return 'enter';
  if (normalized === 'interrupt-pane') return 'interrupt';
  if (normalized === 'restart-pane') return 'restart';
  if (normalized === 'nudge-pane' || normalized === 'nudge-agent') return 'nudge';
  if (normalized === 'switch-pane-model' || normalized === 'model-switch') return 'switch-model';
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
      try {
        const writeAccepted = daemonClient.write(paneId, '\r');
        if (writeAccepted === false) {
          return { success: false, reason: 'daemon_write_failed', paneId, action: normalizedAction };
        }
      } catch (_err) {
        return { success: false, reason: 'daemon_write_failed', paneId, action: normalizedAction };
      }
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
      model,
      method: 'sendTrustedEnter',
    });
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'sendTrustedEnter',
      model,
    };
  }

  if (normalizedAction === 'interrupt') {
    if (!isDaemonAvailable(daemonClient)) {
      return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
    }
    try {
      const writeAccepted = daemonClient.write(paneId, '\x03');
      if (writeAccepted === false) {
        return { success: false, reason: 'daemon_write_failed', paneId, action: normalizedAction };
      }
    } catch (_err) {
      return { success: false, reason: 'daemon_write_failed', paneId, action: normalizedAction };
    }
    return {
      success: true,
      paneId,
      action: normalizedAction,
      method: 'sigint',
    };
  }

  if (normalizedAction === 'restart') {
    const assertionError = validateInstanceAssertion(ctx, normalizedAction, normalizedPayload, paneId);
    if (assertionError) return assertionError;

    if (!isDaemonAvailable(daemonClient)) {
      return { success: false, reason: 'daemon_not_connected', paneId, action: normalizedAction };
    }
    if (!isWindowAvailable(mainWindow)) {
      return { success: false, reason: 'window_not_available', paneId, action: normalizedAction };
    }

    const restartResult = typeof ctx.requestPaneRestart === 'function'
      ? ctx.requestPaneRestart(paneId, {
        source: 'pane-control-service',
        reason: 'manual-restart',
      })
      : null;
    if (restartResult) {
      return {
        success: restartResult.ok !== false,
        paneId,
        action: normalizedAction,
        method: 'restart-pane',
        coalesced: restartResult.coalesced === true,
        reason: restartResult.reason || null,
      };
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

  if (normalizedAction === 'switch-model') {
    const model = asNonEmptyString(String(normalizedPayload.model || '').toLowerCase());
    if (!model) {
      return { success: false, reason: 'missing_model', paneId, action: normalizedAction };
    }
    const assertionError = validateInstanceAssertion(ctx, normalizedAction, normalizedPayload, paneId);
    if (assertionError) return assertionError;

    if (typeof ctx.switchPaneModel !== 'function') {
      return { success: false, reason: 'model_switch_unavailable', paneId, action: normalizedAction };
    }
    // Shares the renderer dropdown's main-side flow (executePaneModelSwitch);
    // the respawn it signals acquires a restart-arbiter lease in the renderer.
    return Promise.resolve(ctx.switchPaneModel(paneId, model)).then((result) => {
      const succeeded = result?.success === true;
      return {
        success: succeeded,
        paneId,
        action: normalizedAction,
        method: 'switch-pane-model',
        model,
        reason: succeeded ? null : (result?.reason || result?.error || 'model_switch_failed'),
        activeClaimId: result?.activeClaimId || null,
      };
    });
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
  extractInstanceAssertion,
  normalizeInstanceScope,
  normalizeAction,
  validateInstanceAssertion,
};
