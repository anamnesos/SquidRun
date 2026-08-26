describe('renderer-ipc-registry', () => {
  function loadRegistry(onBridgeImpl = null) {
    jest.resetModules();
    const disposers = [];
    const onBridge = jest.fn((channel, handler) => {
      if (typeof onBridgeImpl === 'function') {
        return onBridgeImpl(channel, handler);
      }
      const dispose = jest.fn();
      disposers.push({ channel, handler, dispose });
      return dispose;
    });
    jest.doMock('../modules/renderer-bridge', () => ({ onBridge }));
    const registry = require('../modules/renderer-ipc-registry');
    return { onBridge, registry, disposers };
  }

  test('replaces existing listener for same scope and channel', () => {
    const { onBridge, registry, disposers } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerB);

    expect(onBridge).toHaveBeenCalledTimes(2);
    expect(disposers[0].dispose).toHaveBeenCalledTimes(1);
    expect(disposers[1].dispose).not.toHaveBeenCalled();
  });

  test('clears only listeners in the requested scope', () => {
    const { registry, disposers } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-b', 'channel-b', handlerB);
    registry.clearScopedIpcListeners('scope-a');

    expect(disposers[0].dispose).toHaveBeenCalledTimes(1);
    expect(disposers[1].dispose).not.toHaveBeenCalled();
  });

  test('clears all listeners when no scope is provided', () => {
    const { registry, disposers } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-b', 'channel-b', handlerB);
    registry.clearScopedIpcListeners();

    expect(disposers[0].dispose).toHaveBeenCalledTimes(1);
    expect(disposers[1].dispose).toHaveBeenCalledTimes(1);
  });

  test('is resilient when bridge returns non-function disposer', () => {
    const { registry } = loadRegistry(() => null);
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    expect(() => registry.registerScopedIpcListener('scope-a', 'channel-a', handlerB)).not.toThrow();
    expect(() => registry.clearScopedIpcListeners()).not.toThrow();
  });
});
