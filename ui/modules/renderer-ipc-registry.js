/**
 * Renderer-scoped IPC listener registry.
 * Ensures repeated init/reload paths replace listeners instead of accumulating them.
 */

const { onBridge } = require('./renderer-bridge');

const ipcListenerRegistry = new Map();

function removeIpcListener(entry) {
  if (!entry || typeof entry.dispose !== 'function') return;
  entry.dispose();
}

function registerScopedIpcListener(scope, channel, handler) {
  if (!scope || !channel || typeof handler !== 'function') {
    return () => {};
  }

  const key = `${scope}:${channel}`;
  const existing = ipcListenerRegistry.get(key);
  if (existing) {
    removeIpcListener(existing);
  }

  const dispose = onBridge(channel, handler);
  ipcListenerRegistry.set(key, { channel, handler, dispose });

  return () => {
    const current = ipcListenerRegistry.get(key);
    if (current && current.handler === handler) {
      removeIpcListener(current);
      ipcListenerRegistry.delete(key);
      return;
    }
    if (current && current.channel === channel) {
      removeIpcListener(current);
    }
  };
}

function clearScopedIpcListeners(scope = null) {
  for (const [key, entry] of ipcListenerRegistry.entries()) {
    if (scope && !key.startsWith(`${scope}:`)) continue;
    removeIpcListener(entry);
    ipcListenerRegistry.delete(key);
  }
}

module.exports = {
  registerScopedIpcListener,
  clearScopedIpcListeners,
};
