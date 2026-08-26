'use strict';

function readWindowFlag(windowRef, methodName, fallback) {
  try {
    return typeof windowRef?.[methodName] === 'function'
      ? windowRef[methodName]() === true
      : fallback;
  } catch (_) {
    return fallback;
  }
}

function emitWindowVisibilityState(windowRef, options = {}) {
  if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) return false;
  const windowKey = String(options.windowKey || 'main').trim() || 'main';
  const reason = String(options.reason || 'state-change').trim() || 'state-change';
  const minimized = readWindowFlag(windowRef, 'isMinimized', false);
  const visible = readWindowFlag(windowRef, 'isVisible', true);
  try {
    windowRef.webContents?.send?.('window-visibility-changed', {
      windowKey,
      reason,
      hidden: minimized || !visible,
      minimized,
      visible,
      at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    options.log?.warn?.('Window', `Failed to emit visibility state for ${windowKey}: ${err.message}`);
    return false;
  }
}

module.exports = {
  emitWindowVisibilityState,
  readWindowFlag,
};
