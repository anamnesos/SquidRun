function registerDevicePairingHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerDevicePairingHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;

  const getBridgeDevices = typeof deps.getBridgeDevices === 'function'
    ? deps.getBridgeDevices
    : null;
  const getBridgePairingState = typeof deps.getBridgePairingState === 'function'
    ? deps.getBridgePairingState
    : null;
  const initiateBridgePairing = typeof deps.initiateBridgePairing === 'function'
    ? deps.initiateBridgePairing
    : null;
  const joinBridgePairing = typeof deps.joinBridgePairing === 'function'
    ? deps.joinBridgePairing
    : null;

  ipcMain.handle('bridge:get-devices', async (_event, payload = {}) => {
    if (!getBridgeDevices) {
      return { ok: false, status: 'unsupported', error: 'Bridge device API unavailable', devices: [] };
    }
    const timeoutMs = Number.parseInt(String(payload?.timeoutMs || ''), 10);
    const refresh = payload?.refresh !== false;
    return getBridgeDevices({
      refresh,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    });
  });

  ipcMain.handle('bridge:get-pairing-state', async () => {
    if (!getBridgePairingState) {
      return { ok: false, status: 'unsupported', error: 'Bridge pairing state unavailable' };
    }
    return { ok: true, state: getBridgePairingState() };
  });

  ipcMain.handle('bridge:pairing-init', async (_event, payload = {}) => {
    if (!initiateBridgePairing) {
      return { ok: false, status: 'unsupported', error: 'Bridge pairing init unavailable' };
    }
    const timeoutMs = Number.parseInt(String(payload?.timeoutMs || ''), 10);
    return initiateBridgePairing({
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    });
  });

  ipcMain.handle('bridge:pairing-join', async (_event, payload = {}) => {
    if (!joinBridgePairing) {
      return { ok: false, status: 'unsupported', error: 'Bridge pairing join unavailable' };
    }
    const timeoutMs = Number.parseInt(String(payload?.timeoutMs || ''), 10);
    return joinBridgePairing({
      code: payload?.code,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    });
  });
}

function unregisterDevicePairingHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) return;
  try { ctx.ipcMain.removeHandler('bridge:get-devices'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:get-pairing-state'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:pairing-init'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:pairing-join'); } catch (_) {}
}

registerDevicePairingHandlers.unregister = unregisterDevicePairingHandlers;

module.exports = {
  registerDevicePairingHandlers,
  unregisterDevicePairingHandlers,
};
