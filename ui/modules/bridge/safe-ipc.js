'use strict';

const {
  isAllowedInvokeChannel,
  isAllowedSendChannel,
  isAllowedOnChannel,
} = require('./channel-policy');

function createBlockedChannelError(kind, channel) {
  return new Error(`[preload bridge] Blocked ${kind} channel: ${String(channel)}`);
}

function assertAllowed(channel, kind, validator) {
  if (!validator(channel)) {
    throw createBlockedChannelError(kind, channel);
  }
}

function removeNativeListener(ipcRenderer, channel, listener) {
  if (typeof ipcRenderer.off === 'function') {
    ipcRenderer.off(channel, listener);
    return;
  }
  if (typeof ipcRenderer.removeListener === 'function') {
    ipcRenderer.removeListener(channel, listener);
  }
}

function rememberListener(registry, channel, listener, wrappedListener) {
  let channelMap = registry.get(channel);
  if (!channelMap) {
    channelMap = new Map();
    registry.set(channel, channelMap);
  }

  let wrappedSet = channelMap.get(listener);
  if (!wrappedSet) {
    wrappedSet = new Set();
    channelMap.set(listener, wrappedSet);
  }

  wrappedSet.add(wrappedListener);
}

function takeWrappedListener(registry, channel, listener) {
  const channelMap = registry.get(channel);
  if (!channelMap) return null;

  const wrappedSet = channelMap.get(listener);
  if (!wrappedSet || wrappedSet.size === 0) return null;

  const wrappedListener = wrappedSet.values().next().value || null;
  if (!wrappedListener) return null;

  wrappedSet.delete(wrappedListener);
  if (wrappedSet.size === 0) {
    channelMap.delete(listener);
  }
  if (channelMap.size === 0) {
    registry.delete(channel);
  }

  return wrappedListener;
}

function clearChannelRegistry(registry, channel) {
  registry.delete(channel);
}

function createSafeIpc(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer !== 'object') {
    throw new Error('[preload bridge] Missing ipcRenderer');
  }

  const listenerRegistry = new Map();

  function invoke(channel, ...args) {
    assertAllowed(channel, 'invoke', isAllowedInvokeChannel);
    return ipcRenderer.invoke(channel, ...args);
  }

  function send(channel, ...args) {
    assertAllowed(channel, 'send', isAllowedSendChannel);
    ipcRenderer.send(channel, ...args);
  }

  function on(channel, listener) {
    assertAllowed(channel, 'on', isAllowedOnChannel);
    if (typeof listener !== 'function') {
      throw new TypeError('[preload bridge] on() requires a function listener');
    }

    const wrappedListener = (_event, ...eventArgs) => {
      listener(...eventArgs);
    };

    rememberListener(listenerRegistry, channel, listener, wrappedListener);
    ipcRenderer.on(channel, wrappedListener);

    return () => removeListener(channel, listener);
  }

  function removeListener(channel, listener) {
    assertAllowed(channel, 'removeListener', isAllowedOnChannel);
    if (typeof listener !== 'function') return;

    const wrappedListener = takeWrappedListener(listenerRegistry, channel, listener);
    if (!wrappedListener) return;
    removeNativeListener(ipcRenderer, channel, wrappedListener);
  }

  function removeAllListeners(channel) {
    assertAllowed(channel, 'removeAllListeners', isAllowedOnChannel);
    if (typeof ipcRenderer.removeAllListeners === 'function') {
      ipcRenderer.removeAllListeners(channel);
    } else {
      const channelMap = listenerRegistry.get(channel);
      if (channelMap) {
        for (const wrappedSet of channelMap.values()) {
          for (const wrappedListener of wrappedSet.values()) {
            removeNativeListener(ipcRenderer, channel, wrappedListener);
          }
        }
      }
    }
    clearChannelRegistry(listenerRegistry, channel);
  }

  return {
    invoke,
    send,
    on,
    removeListener,
    removeAllListeners,
    isInvokeChannelAllowed: isAllowedInvokeChannel,
    isSendChannelAllowed: isAllowedSendChannel,
    isOnChannelAllowed: isAllowedOnChannel,
  };
}

module.exports = {
  createSafeIpc,
};
