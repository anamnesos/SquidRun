/**
 * Renderer-scoped IPC listener registry.
 * Ensures repeated init/reload paths replace listeners instead of accumulating them.
 */

const { ipcRenderer } = require('electron');

const ipcListenerRegistry = new Map();

function removeIpcListener(channel, handler) {
  if (!channel || typeof handler !== 'function') return;
  if (typeof ipcRenderer.off === 'function') {
    ipcRenderer.off(channel, handler);
    return;
  }
  if (typeof ipcRenderer.removeListener === 'function') {
    ipcRenderer.removeListener(channel, handler);
  }
}

function registerScopedIpcListener(scope, channel, handler) {
  if (!scope || !channel || typeof handler !== 'function') {
    return () => {};
  }

  const key = `${scope}:${channel}`;
  const existing = ipcListenerRegistry.get(key);
  if (existing) {
    removeIpcListener(existing.channel, existing.handler);
  }

  ipcRenderer.on(channel, handler);
  ipcListenerRegistry.set(key, { channel, handler });

  return () => {
    const current = ipcListenerRegistry.get(key);
    if (current && current.handler === handler) {
      removeIpcListener(channel, handler);
      ipcListenerRegistry.delete(key);
      return;
    }
    removeIpcListener(channel, handler);
  };
}

function clearScopedIpcListeners(scope = null) {
  for (const [key, entry] of ipcListenerRegistry.entries()) {
    if (scope && !key.startsWith(`${scope}:`)) continue;
    removeIpcListener(entry.channel, entry.handler);
    ipcListenerRegistry.delete(key);
  }
}

module.exports = {
  registerScopedIpcListener,
  clearScopedIpcListeners,
};
