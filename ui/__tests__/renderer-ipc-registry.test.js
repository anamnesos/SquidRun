describe('renderer-ipc-registry', () => {
  function loadRegistry(ipcOverrides = {}) {
    jest.resetModules();
    const ipcRenderer = {
      on: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
      ...ipcOverrides,
    };
    jest.doMock('electron', () => ({ ipcRenderer }));
    const registry = require('../modules/renderer-ipc-registry');
    return { ipcRenderer, registry };
  }

  test('replaces existing listener for same scope and channel', () => {
    const { ipcRenderer, registry } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerB);

    expect(ipcRenderer.on).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.off).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.off).toHaveBeenCalledWith('channel-a', handlerA);
  });

  test('clears only listeners in the requested scope', () => {
    const { ipcRenderer, registry } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-b', 'channel-b', handlerB);
    registry.clearScopedIpcListeners('scope-a');

    expect(ipcRenderer.off).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.off).toHaveBeenCalledWith('channel-a', handlerA);
  });

  test('clears all listeners when no scope is provided', () => {
    const { ipcRenderer, registry } = loadRegistry();
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-b', 'channel-b', handlerB);
    registry.clearScopedIpcListeners();

    expect(ipcRenderer.off).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.off).toHaveBeenCalledWith('channel-a', handlerA);
    expect(ipcRenderer.off).toHaveBeenCalledWith('channel-b', handlerB);
  });

  test('falls back to removeListener when off is unavailable', () => {
    const removeListener = jest.fn();
    const { registry } = loadRegistry({ off: undefined, removeListener });
    const handlerA = jest.fn();
    const handlerB = jest.fn();

    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerA);
    registry.registerScopedIpcListener('scope-a', 'channel-a', handlerB);

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith('channel-a', handlerA);
  });
});
