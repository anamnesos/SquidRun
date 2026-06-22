const log = require('../logger');

function normalizeAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'reload-renderer' || normalized === 'reload-renderers' || normalized === 'hot-reload-renderers') {
    return 'reload-renderers';
  }
  if (
    normalized === 'restart-telegram-poller'
    || normalized === 'reload-telegram-poller'
    || normalized === 'restart-telegram'
  ) {
    return 'restart-telegram-poller';
  }
  if (
    normalized === 'open-mira-lab'
    || normalized === 'mira-lab'
    || normalized === 'mira-lab-open'
    || normalized === 'open-mira'
  ) {
    return 'open-mira-lab';
  }
  if (
    normalized === 'open-live-task-audit-sidecar'
    || normalized === 'live-task-audit-sidecar'
    || normalized === 'task-audit-sidecar'
    || normalized === 'task-audit'
    || normalized === 'open-task-audit'
  ) {
    return 'open-live-task-audit-sidecar';
  }
  if (
    normalized === 'open-human-timeline-sidecar'
    || normalized === 'human-timeline-sidecar'
    || normalized === 'human-timeline'
    || normalized === 'timeline'
    || normalized === 'today-feed'
    || normalized === 'open-today-feed'
  ) {
    return 'open-human-timeline-sidecar';
  }
  if (
    normalized === 'open-spine-overlay'
    || normalized === 'spine-overlay'
    || normalized === 'spine'
    || normalized === 'alive-os'
  ) {
    return 'open-spine-overlay';
  }
  if (
    normalized === 'open-squid-room'
    || normalized === 'squid-room'
    || normalized === 'squid-room-open'
  ) {
    return 'open-squid-room';
  }
  if (
    normalized === 'open-trustquote-workspace'
    || normalized === 'trustquote-workspace'
    || normalized === 'open-trustquote'
    || normalized === 'trustquote'
  ) {
    return 'open-trustquote-workspace';
  }
  if (
    normalized === 'close-trustquote-workspace'
    || normalized === 'close-trustquote'
    || normalized === 'trustquote-close'
    || normalized === 'close-trustquote-window'
  ) {
    return 'close-trustquote-workspace';
  }
  if (
    normalized === 'close-app-window'
    || normalized === 'close-window'
    || normalized === 'window-close'
  ) {
    return 'close-app-window';
  }
  if (
    normalized === 'mira-lab-renderer-prompt'
    || normalized === 'mira-lab-drive'
    || normalized === 'drive-mira-lab'
  ) {
    return 'mira-lab-renderer-prompt';
  }
  if (
    normalized === 'terminal-scroll-probe'
    || normalized === 'scroll-probe'
    || normalized === 'probe-terminal-scroll'
  ) {
    return 'terminal-scroll-probe';
  }
  return normalized;
}

function canReload(windowRef) {
  return Boolean(
    windowRef
    && typeof windowRef.isDestroyed === 'function'
    && !windowRef.isDestroyed()
    && windowRef.webContents
    && typeof windowRef.webContents.reloadIgnoringCache === 'function'
  );
}

function canExecuteJavaScript(windowRef) {
  return Boolean(
    windowRef
    && typeof windowRef.isDestroyed === 'function'
    && !windowRef.isDestroyed()
    && windowRef.webContents
    && typeof windowRef.webContents.executeJavaScript === 'function'
  );
}

function getCloseWindowKey(action, payload = {}) {
  if (action === 'close-trustquote-workspace') return 'trustquote';
  if (typeof payload === 'string') return payload.trim() || 'main';
  if (!payload || typeof payload !== 'object') return 'main';
  return String(payload.windowKey || payload.key || payload.window || 'main').trim() || 'main';
}

function isPackagedOrProduction(ctx = {}) {
  return ctx.isPackaged === true || process.env.NODE_ENV === 'production';
}

function getWindowByKey(ctx = {}, rawWindowKey = '') {
  const windowKey = String(rawWindowKey || '').trim();
  if (!windowKey) return null;
  if (typeof ctx.getAppWindow === 'function') {
    const direct = ctx.getAppWindow(windowKey);
    if (direct) return direct;
  }
  if (windowKey === 'main' && ctx.mainWindow) return ctx.mainWindow;
  const windows = typeof ctx.getAppWindows === 'function' ? ctx.getAppWindows() : [];
  for (const [key, windowRef] of Array.isArray(windows) ? windows : []) {
    if (String(key || '') === windowKey) return windowRef;
  }
  return null;
}

function normalizeTerminalScrollProbePayload(payload = {}) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const windowKey = String(input.windowKey || '').trim();
  const containerId = String(input.containerId || '').trim();
  const op = String(input.op || input.operation || '').trim();
  const normalizedOp = op.toLowerCase();
  const errors = [];

  const selector = String(input.selector || '').trim();

  let operation = null;
  if (normalizedOp === 'scrolllines' || normalizedOp === 'scroll-lines') operation = 'scrollLines';
  if (normalizedOp === 'dispatchwheel' || normalizedOp === 'dispatch-wheel' || normalizedOp === 'wheel') operation = 'dispatchWheel';
  if (normalizedOp === 'dispatchkey' || normalizedOp === 'dispatch-key' || normalizedOp === 'key') operation = 'dispatchKey';
  if (normalizedOp === 'dispatchclick' || normalizedOp === 'dispatch-click' || normalizedOp === 'click') operation = 'dispatchClick';
  if (normalizedOp === 'dispatchhover' || normalizedOp === 'dispatch-hover' || normalizedOp === 'hover') operation = 'dispatchHover';
  if (normalizedOp === 'dispatchselect' || normalizedOp === 'dispatch-select' || normalizedOp === 'select') operation = 'dispatchSelect';
  if (normalizedOp === 'clearhover' || normalizedOp === 'clear-hover') operation = 'clearHover';
  if (!operation) errors.push('op_unsupported');

  // Selector-based UI interaction ops (S426 UX audit tooling) target
  // arbitrary elements; terminal-scroll ops keep requiring the container id.
  const isSelectorOp = operation === 'dispatchClick'
    || operation === 'dispatchHover'
    || operation === 'dispatchSelect'
    || operation === 'clearHover';

  if (!windowKey) errors.push('windowKey_required');
  if (isSelectorOp) {
    if (!selector) errors.push('selector_required');
    if (selector && selector.length > 300) errors.push('selector_too_long');
  } else {
    if (!containerId) errors.push('containerId_required');
    if (containerId && !/^[A-Za-z0-9_-]+$/.test(containerId)) errors.push('containerId_invalid');
  }

  const lines = Number(input.lines);
  const deltaY = Number(input.deltaY);
  const key = String(input.key || '').trim();
  const value = String(input.value || '').trim();
  const waitMs = Math.max(0, Math.min(1000, Number(input.waitMs ?? input.delayMs ?? 120) || 120));

  if (operation === 'scrollLines' && (!Number.isFinite(lines) || lines === 0)) {
    errors.push('lines_required');
  }
  if (operation === 'dispatchWheel' && (!Number.isFinite(deltaY) || deltaY === 0)) {
    errors.push('deltaY_required');
  }
  if (operation === 'dispatchKey' && !['PageUp', 'PageDown'].includes(key)) {
    errors.push('key_unsupported');
  }
  if (operation === 'dispatchSelect' && !value) {
    errors.push('value_required');
  }

  return {
    ok: errors.length === 0,
    errors,
    probe: {
      windowKey,
      containerId,
      selector,
      op: operation,
      lines,
      deltaY,
      key,
      value,
      waitMs,
    },
  };
}

// The injected script runs in the renderer MAIN world. The terminal instances
// and the __squidrunTerminalScrollProbeTarget expando live in the preload
// ISOLATED world (terminal.js is reached through the contextBridge), so a
// main-world read of the expando is always undefined — every probe returned
// terminal_probe_target_unavailable. Instead of reading the target directly,
// delegate to terminal.runTerminalScrollProbe over the bridge so the probe runs
// in the same world as the terminal it measures.
function buildTerminalScrollProbeScript(probe) {
  const serializedProbe = JSON.stringify(probe).replace(/</g, '\\u003c');
  return `(() => {
    const probe = ${serializedProbe};
    const bridge = (typeof window !== 'undefined' && (window.squidrun || window.squidrunAPI)) || null;
    const terminalApi = bridge && bridge.rendererModules ? bridge.rendererModules.terminal : null;
    if (!terminalApi || typeof terminalApi.runTerminalScrollProbe !== 'function') {
      return { success: false, reason: 'terminal_probe_bridge_unavailable', ...probe };
    }
    return Promise.resolve(terminalApi.runTerminalScrollProbe(probe));
  })();`;
}

function executeAppControlAction(ctx = {}, action, payload = {}) {
  const normalizedAction = normalizeAction(action);
  if (!normalizedAction) {
    return { success: false, reason: 'unknown_action', action: String(action || '') };
  }

  if (normalizedAction === 'reload-renderers') {
    const appWindows = typeof ctx.getAppWindows === 'function'
      ? ctx.getAppWindows()
      : [['main', ctx.mainWindow].filter(Boolean)];
    const paneHostWindows = typeof ctx.getPaneHostWindows === 'function'
      ? ctx.getPaneHostWindows()
      : [];
    const windows = [
      ...(Array.isArray(appWindows) ? appWindows : []),
      ...(Array.isArray(paneHostWindows) ? paneHostWindows : []),
    ];
    const reloaded = [];
    const seen = new Set();

    for (const [windowKey, windowRef] of Array.isArray(windows) ? windows : []) {
      if (!canReload(windowRef)) continue;
      if (seen.has(windowRef)) continue;
      seen.add(windowRef);
      try {
        windowRef.webContents.reloadIgnoringCache();
        reloaded.push(String(windowKey || 'main'));
      } catch (error) {
        log.warn('AppControl', `Renderer reload failed for ${windowKey}: ${error.message}`);
      }
    }

    if (reloaded.length === 0) {
      return {
        success: false,
        reason: 'no_reloadable_windows',
        action: normalizedAction,
      };
    }

    return {
      success: true,
      action: normalizedAction,
      reloadedWindowKeys: reloaded,
      windowCount: reloaded.length,
      note: 'Renderer windows reloaded without restarting the Electron main process.',
    };
  }

  if (normalizedAction === 'terminal-scroll-probe') {
    if (isPackagedOrProduction(ctx)) {
      return {
        success: false,
        reason: 'terminal_scroll_probe_dev_only',
        action: normalizedAction,
      };
    }

    const normalized = normalizeTerminalScrollProbePayload(payload);
    if (!normalized.ok) {
      return {
        success: false,
        reason: 'terminal_scroll_probe_invalid_payload',
        action: normalizedAction,
        errors: normalized.errors,
      };
    }

    const windowRef = getWindowByKey(ctx, normalized.probe.windowKey);
    if (!canExecuteJavaScript(windowRef)) {
      return {
        success: false,
        reason: 'terminal_scroll_probe_window_unavailable',
        action: normalizedAction,
        windowKey: normalized.probe.windowKey,
      };
    }

    return Promise.resolve()
      .then(() => windowRef.webContents.executeJavaScript(buildTerminalScrollProbeScript(normalized.probe), true))
      .then((result) => ({
        success: Boolean(result?.success),
        action: normalizedAction,
        ...result,
        reason: result?.success === false ? (result.reason || 'terminal_scroll_probe_failed') : undefined,
      }))
      .catch((error) => {
        log.warn('AppControl', `Terminal scroll probe failed: ${error.message}`);
        return {
          success: false,
          reason: 'terminal_scroll_probe_execute_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-mira-lab') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.openAppWindow('mira-lab', payload))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'mira-lab',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'Mira Lab window opened/focused without restarting the Electron main process.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Mira Lab open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-live-task-audit-sidecar') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.openAppWindow('live-task-audit-sidecar', payload))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'live-task-audit-sidecar',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'Live task/audit sidecar opened/focused without restarting the Electron main process.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Live task/audit sidecar open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-human-timeline-sidecar') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.openAppWindow('human-timeline-sidecar', payload))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'human-timeline-sidecar',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'Human timeline sidecar opened/focused without restarting the Electron main process.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Human timeline sidecar open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-spine-overlay') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.openAppWindow('spine-overlay', payload))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'spine-overlay',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'Spine overlay opened/focused as an isolated read-only surface.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Spine overlay open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-squid-room') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    const squidRoomOptions = {
      autoBootAgents: false,
      profileName: 'main',
      windowTeam: 'squid-room',
      displayOnly: true,
      skipStartupBundle: true,
    };
    return Promise.resolve()
      .then(() => ctx.openAppWindow('squid-room', squidRoomOptions))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'squid-room',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'Squid Room opened as a main-profile surface window.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Squid Room open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'open-trustquote-workspace') {
    if (typeof ctx.openAppWindow !== 'function') {
      return {
        success: false,
        reason: 'open_window_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.openAppWindow('trustquote', { autoBootAgents: false, profileName: 'trustquote' }))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || 'trustquote',
          status: settled.status || (settled.ok ? 'opened' : 'open_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'open_window_failed'),
          note: 'TrustQuote workspace opened/focused without starting duplicate agents.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `TrustQuote workspace open failed: ${error.message}`);
        return {
          success: false,
          reason: 'open_window_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'close-app-window' || normalizedAction === 'close-trustquote-workspace') {
    const windowKey = getCloseWindowKey(normalizedAction, payload);
    if (windowKey === 'main') {
      return {
        success: false,
        reason: 'main_window_requires_quit',
        action: normalizedAction,
        windowKey,
      };
    }
    if (typeof ctx.closeAppWindow !== 'function') {
      return {
        success: false,
        reason: 'close_window_unavailable',
        action: normalizedAction,
        windowKey,
      };
    }
    return Promise.resolve()
      .then(() => ctx.closeAppWindow(windowKey))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          windowKey: settled.windowKey || windowKey,
          status: settled.status || (settled.ok ? 'closed' : 'close_failed'),
          reason: settled.ok ? undefined : (settled.reason || 'close_window_failed'),
          note: 'Non-main app window close requested without stopping the Electron main process.',
        };
      })
      .catch((error) => {
        log.warn('AppControl', `App window close failed for ${windowKey}: ${error.message}`);
        return {
          success: false,
          reason: 'close_window_failed',
          action: normalizedAction,
          windowKey,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'mira-lab-renderer-prompt') {
    if (typeof ctx.driveMiraLabRenderer !== 'function') {
      return {
        success: false,
        reason: 'drive_unavailable',
        action: normalizedAction,
      };
    }
    return Promise.resolve()
      .then(() => ctx.driveMiraLabRenderer(payload || {}))
      .then((result) => {
        const settled = result && typeof result === 'object' ? result : {};
        return {
          success: Boolean(settled.ok),
          action: normalizedAction,
          ...settled,
        };
      })
      .catch((error) => {
        log.warn('AppControl', `Mira Lab renderer drive failed: ${error.message}`);
        return {
          success: false,
          reason: 'drive_failed',
          action: normalizedAction,
          error: error.message,
        };
      });
  }

  if (normalizedAction === 'restart-telegram-poller') {
    if (typeof ctx.restartTelegramPoller !== 'function') {
      return {
        success: false,
        reason: 'restart_unavailable',
        action: normalizedAction,
      };
    }

    try {
      const result = ctx.restartTelegramPoller(payload);
      return {
        success: Boolean(result?.success),
        action: normalizedAction,
        ...result,
      };
    } catch (error) {
      log.warn('AppControl', `Telegram poller restart failed: ${error.message}`);
      return {
        success: false,
        reason: 'restart_failed',
        action: normalizedAction,
        error: error.message,
      };
    }
  }

  return {
    success: false,
    reason: 'unknown_action',
    action: normalizedAction,
    payload,
  };
}

module.exports = {
  normalizeAction,
  executeAppControlAction,
};
