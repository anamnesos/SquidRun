'use strict';

const path = require('node:path');
const log = require('../logger');
const { getProjectRoot, resolveCoordPath } = require('../../config');
const { createTeamRoomPaneDelivery, createTeamRoomRouteScopeResolver } = require('./team-room-pane-delivery');
const { createTeamRoomCliBindingResolver } = require('./team-room-cli-binding');
const { TeamRoomRuntime, resolveTeamRoomNetworkOptions } = require('./team-room-runtime');
const { TeamRoomTailscaleAccess } = require('./team-room-tailscale-access');
const { createTeamRoomWindow } = require('./team-room-window');

const CLI_LAUNCH_BINDING_UNAVAILABLE = 'team_room_cli_launch_binding_unavailable';
const START_RETRY_DELAY_MS = 500;
const MAX_START_RETRY_ATTEMPTS = 120;

function createTeamRoomAppController(options = {}) {
  const appHost = options.appHost || null;
  const dependencies = appHost ? {
    ...options,
    canSendToWindow: (windowRef) => appHost.canSendToWindow(windowRef),
    focusAppWindow: (windowKey) => appHost.focusAppWindow(windowKey),
    getAppWindow: (windowKey) => appHost.getAppWindow(windowKey),
    getSessionScopeId: (windowKey) => appHost.getWindowSessionScopeId(windowKey),
    getWindowScope: (windowKey) => appHost.getAppWindowInstanceScope(windowKey),
    registerAppWindow: (windowKey, windowRef, registration) => appHost.registerAppWindow(windowKey, windowRef, registration),
    setupWindowListeners: (windowRef, listenerOptions) => appHost.setupWindowListeners(windowRef, listenerOptions),
    suppressMenu: (windowRef) => appHost.enforceMenuSuppression(windowRef),
  } : options;
  const required = [
    'BrowserWindow', 'canSendToWindow', 'focusAppWindow', 'getAppWindow', 'getWindowScope',
    'registerAppWindow', 'sendDirectMessage', 'setupWindowListeners', 'suppressMenu',
  ];
  for (const key of required) {
    if (typeof dependencies[key] !== 'function') throw new Error(`team_room_app_controller_${key}_required`);
  }
  const network = resolveTeamRoomNetworkOptions(dependencies.env || process.env);
  if (!network.ok) {
    const addressDetail = network.host
      ? `; configured host=${network.host}; local addresses=${(network.localAddresses || []).join(',') || 'none'}`
      : '';
    log.warn(
      'TeamRoom',
      `LAN configuration rejected (${network.reason}${addressDetail}); update .env and restart SquidRun`
    );
  }
  const resolveRouteScope = createTeamRoomRouteScopeResolver({
    getAppWindow: dependencies.getAppWindow,
    getWindowScope: dependencies.getWindowScope,
  });
  const resolveCliBindings = dependencies.resolveTeamRoomCliBindings || createTeamRoomCliBindingResolver({
    getProfileName: () => dependencies.getWindowScope('main')?.profileName || '',
  });
  let runtime;
  const remoteAccess = dependencies.remoteAccess || new TeamRoomTailscaleAccess({
    getTargetOrigin: () => runtime ? runtime.remoteTargetOrigin : 'http://127.0.0.1:9911',
    applyRemoteOrigin: (origin) => runtime?.setRemoteOrigin(origin)
      || { ok: false, reason: 'team_room_runtime_not_ready' },
  });
  runtime = new TeamRoomRuntime({
    projectRoot: getProjectRoot(),
    ...(network.ok ? network : { host: '127.0.0.1', port: 0, lanEnabled: false, allowedOrigins: [] }),
    deliverToPane: createTeamRoomPaneDelivery({
      sendDirectMessage: dependencies.sendDirectMessage,
      resolveRouteScope,
    }),
    resolveCliBindings,
    getRemoteAccessStatus: () => remoteAccess.getStatus(),
    setRemoteAccessEnabled: (enabled) => remoteAccess.setEnabled(enabled),
  });

  const setTimeoutFn = typeof dependencies.setTimeoutFn === 'function'
    ? dependencies.setTimeoutFn
    : setTimeout;
  const clearTimeoutFn = typeof dependencies.clearTimeoutFn === 'function'
    ? dependencies.clearTimeoutFn
    : clearTimeout;
  let startRetryTimer = null;
  let startRetryAttempts = 0;
  let startRetryEnabled = false;
  let remoteReconcilePromise = null;

  function reconcileRemoteAccess() {
    if (remoteReconcilePromise) return remoteReconcilePromise;
    remoteReconcilePromise = Promise.resolve(remoteAccess.reconcile())
      .then((result) => {
        if (!result?.ok && !['tailscale_executable_not_found', 'tailscale_not_connected'].includes(result?.reason)) {
          log.warn('TeamRoom', `Remote access reconciliation unavailable (${result?.reason || 'unknown'})`);
        }
        return result;
      })
      .catch((error) => {
        log.warn('TeamRoom', `Remote access reconciliation failed (${error.message})`);
        return { ok: false, reason: error.message };
      })
      .finally(() => { remoteReconcilePromise = null; });
    return remoteReconcilePromise;
  }

  function clearStartRetry({ resetAttempts = true } = {}) {
    if (startRetryTimer) clearTimeoutFn(startRetryTimer);
    startRetryTimer = null;
    if (resetAttempts) startRetryAttempts = 0;
  }

  function scheduleStartRetry() {
    if (!startRetryEnabled || startRetryTimer) return false;
    if (startRetryAttempts >= MAX_START_RETRY_ATTEMPTS) {
      startRetryEnabled = false;
      log.warn(
        'TeamRoom',
        `Runtime startup retry exhausted after ${startRetryAttempts} attempts (${CLI_LAUNCH_BINDING_UNAVAILABLE})`
      );
      return false;
    }

    startRetryTimer = setTimeoutFn(async () => {
      startRetryTimer = null;
      if (!startRetryEnabled) return;
      startRetryAttempts += 1;
      const result = await runtime.start();
      if (!startRetryEnabled) {
        if (result.ok) await runtime.stop();
        return;
      }
      if (result.ok) {
        void reconcileRemoteAccess();
        log.info(
          'TeamRoom',
          `Runtime recovered after CLI launch bindings became available (attempt ${startRetryAttempts})`
        );
        clearStartRetry();
        return;
      }
      if (result.reason !== CLI_LAUNCH_BINDING_UNAVAILABLE) {
        startRetryEnabled = false;
        log.warn('TeamRoom', `Runtime startup retry stopped (${result.reason || 'unknown'})`);
        return;
      }
      scheduleStartRetry();
    }, START_RETRY_DELAY_MS);
    startRetryTimer?.unref?.();
    return true;
  }

  async function start() {
    startRetryEnabled = true;
    const result = await runtime.start();
    if (result.ok) {
      void reconcileRemoteAccess();
      clearStartRetry();
      return result;
    }
    log.warn('TeamRoom', `Runtime unavailable (${result.reason || 'unknown'})`);
    if (result.reason === CLI_LAUNCH_BINDING_UNAVAILABLE) {
      const retryScheduled = scheduleStartRetry();
      return {
        ...result,
        retryScheduled,
        ...(retryScheduled ? { retryDelayMs: START_RETRY_DELAY_MS } : {}),
      };
    }
    startRetryEnabled = false;
    clearStartRetry();
    return result;
  }

  async function stop() {
    startRetryEnabled = false;
    clearStartRetry();
    return runtime.stop();
  }

  async function stopQuietly(context = 'shutdown') {
    try {
      return await stop();
    } catch (error) {
      log.warn('TeamRoom', `Failed stopping runtime after ${context}: ${error.message}`);
      return { ok: false, reason: error.message };
    }
  }

  async function openWindow() {
    const windowKey = 'team-room';
    if (!network.ok) {
      return {
        ok: false,
        windowKey,
        reason: network.reason || 'team_room_network_configuration_invalid',
        configuredHost: network.host || null,
        localAddresses: network.localAddresses || [],
      };
    }
    const existing = dependencies.getAppWindow(windowKey);
    if (dependencies.canSendToWindow(existing)) {
      dependencies.focusAppWindow(windowKey);
      return { ok: true, windowKey, title: 'SquidRun Team Room', status: 'reused_existing' };
    }
    const started = await start();
    if (!started.ok) return { ok: false, windowKey, reason: started.reason || 'team_room_runtime_start_failed' };
    const issued = runtime.issueElectronCredential();
    if (!issued.ok) return { ok: false, windowKey, reason: issued.reason || 'team_room_window_credential_failed' };
    try {
      const result = await createTeamRoomWindow({
        BrowserWindow: dependencies.BrowserWindow,
        origin: started.origin,
        credentialToken: issued.token,
        statePath: resolveCoordPath(path.join('runtime', 'team-room-window.json'), { forWrite: true }),
      });
      const windowRef = result.window || null;
      if (!windowRef) return { ok: false, windowKey, reason: 'team_room_window_factory_returned_no_window' };
      dependencies.registerAppWindow(windowKey, windowRef, {
        lifecycleRoot: false,
        profileName: 'main',
        sessionScopeId: dependencies.getSessionScopeId?.(windowKey),
      });
      dependencies.suppressMenu(windowRef);
      dependencies.setupWindowListeners(windowRef, { windowKey, lifecycleRoot: false });
      dependencies.focusAppWindow(windowKey);
      return { ok: true, windowKey, title: 'SquidRun Team Room', origin: started.origin };
    } catch (error) {
      return { ok: false, windowKey, reason: error?.message || 'team_room_window_open_failed' };
    }
  }

  return { openWindow, reconcileRemoteAccess, remoteAccess, runtime, start, stop, stopQuietly };
}

module.exports = { createTeamRoomAppController };
