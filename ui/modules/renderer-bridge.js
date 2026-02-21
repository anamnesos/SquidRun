'use strict';

function getHost() {
  if (typeof window !== 'undefined') return window;
  if (typeof globalThis !== 'undefined') return globalThis;
  return null;
}

function resolveBridgeApi() {
  const host = getHost();
  if (!host || typeof host !== 'object') return null;

  const candidates = [
    host.squidrunAPI,
    host.squidrun,
    host.hivemind,
    host.api,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
  }
  return null;
}

function resolveIpc() {
  const api = resolveBridgeApi();
  if (!api || typeof api !== 'object') return null;

  if (
    typeof api.invoke === 'function'
    && typeof api.send === 'function'
    && typeof api.on === 'function'
  ) {
    return {
      mode: 'bridge',
      invoke: api.invoke.bind(api),
      send: api.send.bind(api),
      on: api.on.bind(api),
      off: typeof api.off === 'function' ? api.off.bind(api) : null,
      removeListener: typeof api.removeListener === 'function' ? api.removeListener.bind(api) : null,
      once: typeof api.once === 'function' ? api.once.bind(api) : null,
    };
  }

  const nested = api.ipc;
  if (
    nested
    && typeof nested === 'object'
    && typeof nested.invoke === 'function'
    && typeof nested.send === 'function'
    && typeof nested.on === 'function'
  ) {
    return {
      mode: 'bridge',
      invoke: nested.invoke.bind(nested),
      send: nested.send.bind(nested),
      on: nested.on.bind(nested),
      off: typeof nested.off === 'function' ? nested.off.bind(nested) : null,
      removeListener: typeof nested.removeListener === 'function' ? nested.removeListener.bind(nested) : null,
      once: typeof nested.once === 'function' ? nested.once.bind(nested) : null,
    };
  }

  return null;
}

function makeMissingBridgeError(method) {
  return new Error(`[renderer bridge] Missing preload bridge for ${method}()`);
}

function invokeBridge(channel, ...args) {
  const ipc = resolveIpc();
  if (!ipc || typeof ipc.invoke !== 'function') {
    return Promise.reject(makeMissingBridgeError('invoke'));
  }
  return ipc.invoke(channel, ...args);
}

function sendBridge(channel, ...args) {
  const ipc = resolveIpc();
  if (!ipc || typeof ipc.send !== 'function') {
    throw makeMissingBridgeError('send');
  }
  ipc.send(channel, ...args);
}

function onBridge(channel, listener) {
  if (typeof listener !== 'function') return () => {};
  const ipc = resolveIpc();
  if (!ipc || typeof ipc.on !== 'function') return () => {};

  const wrapped = (...payloadArgs) => listener(undefined, ...payloadArgs);
  const disposer = ipc.on(channel, wrapped);

  if (typeof disposer === 'function') {
    return disposer;
  }

  if (typeof ipc.removeListener === 'function') {
    return () => ipc.removeListener(channel, wrapped);
  }

  return () => {};
}

function onceBridge(channel, listener) {
  if (typeof listener !== 'function') return () => {};
  const ipc = resolveIpc();
  if (!ipc) return () => {};

  let disposed = false;
  let off = () => {};
  off = onBridge(channel, (...args) => {
    if (disposed) return;
    disposed = true;
    off();
    listener(...args);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    off();
  };
}

module.exports = {
  resolveBridgeApi,
  invokeBridge,
  sendBridge,
  onBridge,
  onceBridge,
};
