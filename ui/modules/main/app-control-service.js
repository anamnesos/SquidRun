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

function getCloseWindowKey(action, payload = {}) {
  if (action === 'close-trustquote-workspace') return 'trustquote';
  if (typeof payload === 'string') return payload.trim() || 'main';
  if (!payload || typeof payload !== 'object') return 'main';
  return String(payload.windowKey || payload.key || payload.window || 'main').trim() || 'main';
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
          note: 'Squid Room opened as a display-only main-profile window.',
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
