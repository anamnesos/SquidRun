const log = require('../logger');

function normalizeAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'reload-renderer' || normalized === 'reload-renderers' || normalized === 'hot-reload-renderers') {
    return 'reload-renderers';
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
