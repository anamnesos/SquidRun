// @ts-check

/** @typedef {import('../../types/contracts').BridgeGetDevicesPayload} BridgeGetDevicesPayload */
/** @typedef {import('../../types/contracts').BridgePairingJoinPayload} BridgePairingJoinPayload */
/** @typedef {import('../../types/contracts').DevicePairingDeps} DevicePairingDeps */

/**
 * @param {{ ipcMain: { handle(channel: string, handler: Function): void } }} ctx
 * @param {DevicePairingDeps} [deps]
 * @returns {void}
 */
function registerDevicePairingHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerDevicePairingHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;

  const getBridgeDevices = typeof deps.getBridgeDevices === 'function'
    ? deps.getBridgeDevices
    : null;
  const getBridgeStatus = typeof deps.getBridgeStatus === 'function'
    ? deps.getBridgeStatus
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

  ipcMain.handle('bridge:get-devices', async (
    /** @type {any} */ _event,
    payload = /** @type {BridgeGetDevicesPayload} */ ({})
  ) => {
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

  ipcMain.handle('bridge:get-status', async () => {
    if (!getBridgeStatus) {
      return { ok: false, status: 'unsupported', error: 'Bridge status unavailable' };
    }
    return { ok: true, status: getBridgeStatus() };
  });

  ipcMain.handle('bridge:get-pairing-state', async () => {
    if (!getBridgePairingState) {
      return { ok: false, status: 'unsupported', error: 'Bridge pairing state unavailable' };
    }
    return { ok: true, state: getBridgePairingState() };
  });

  ipcMain.handle('bridge:pairing-init', async (
    /** @type {any} */ _event,
    payload = /** @type {BridgeGetDevicesPayload} */ ({})
  ) => {
    if (!initiateBridgePairing) {
      return { ok: false, status: 'unsupported', error: 'Bridge pairing init unavailable' };
    }
    const timeoutMs = Number.parseInt(String(payload?.timeoutMs || ''), 10);
    return initiateBridgePairing({
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    });
  });

  ipcMain.handle('bridge:pairing-join', async (
    /** @type {any} */ _event,
    payload = /** @type {BridgePairingJoinPayload} */ ({})
  ) => {
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

/**
 * @param {{ ipcMain?: { removeHandler(channel: string): void } } | undefined} ctx
 * @returns {void}
 */
function unregisterDevicePairingHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) return;
  try { ctx.ipcMain.removeHandler('bridge:get-devices'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:get-status'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:get-pairing-state'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:pairing-init'); } catch (_) {}
  try { ctx.ipcMain.removeHandler('bridge:pairing-join'); } catch (_) {}
}

registerDevicePairingHandlers.unregister = unregisterDevicePairingHandlers;

module.exports = {
  registerDevicePairingHandlers,
  unregisterDevicePairingHandlers,
};
