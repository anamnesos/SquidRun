'use strict';

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseList(value) {
  if (Array.isArray(value)) return value.slice();
  const raw = toText(value, '');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return raw.split('|').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeWindowContext(payload = {}) {
  return {
    loaded: true,
    windowKey: toText(payload.windowKey, 'main'),
    windowTeam: toText(payload.windowTeam, toText(payload.windowKey, 'main')),
    profileName: toText(payload.profileName, 'main'),
    profileLabel: toText(payload.profileLabel, 'Main'),
    roleLayout: toText(payload.roleLayout, 'standard'),
    sessionScopeId: toText(payload.sessionScopeId, ''),
    startupBundlePath: toText(payload.startupBundlePath, ''),
    startupSourceFiles: Array.isArray(payload.startupSourceFiles) ? payload.startupSourceFiles.slice() : [],
    autoBootAgents: payload.autoBootAgents === true,
    standaloneWindow: payload.standaloneWindow === true,
    lifecycleMode: toText(payload.lifecycleMode, ''),
  };
}

function readInitialWindowContextFromLocation(search = '') {
  try {
    const params = new URLSearchParams(String(search || ''));
    const windowKey = toText(params.get('windowKey'), 'main');
    const windowTeam = toText(params.get('windowTeam'), windowKey);
    const hasReadyContext = toBoolean(params.get('contextReady'), false)
      || params.has('autoBootAgents')
      || params.has('standaloneWindow')
      || params.has('lifecycleMode')
      || params.has('startupBundlePath');
    return {
      loaded: hasReadyContext,
      windowKey,
      windowTeam,
      profileName: toText(params.get('profileName'), 'main'),
      profileLabel: toText(params.get('profileLabel'), 'Main'),
      roleLayout: 'standard',
      sessionScopeId: toText(params.get('sessionScopeId'), ''),
      startupBundlePath: toText(params.get('startupBundlePath'), ''),
      startupSourceFiles: parseList(params.get('startupSourceFiles')),
      autoBootAgents: toBoolean(params.get('autoBootAgents'), false),
      standaloneWindow: toBoolean(params.get('standaloneWindow'), false),
      lifecycleMode: toText(params.get('lifecycleMode'), ''),
    };
  } catch {
    return {
      loaded: false,
      windowKey: 'main',
      windowTeam: 'main',
      profileName: 'main',
      profileLabel: 'Main',
      roleLayout: 'standard',
      sessionScopeId: '',
      startupBundlePath: '',
      startupSourceFiles: [],
      autoBootAgents: false,
      standaloneWindow: false,
      lifecycleMode: '',
    };
  }
}

function createWindowTeamBootstrap({ settings, terminal, log, initialContext } = {}) {
  const state = {
    ...readInitialWindowContextFromLocation(''),
    ...(initialContext && typeof initialContext === 'object' ? initialContext : {}),
  };

  function getState() {
    return { ...state, startupSourceFiles: state.startupSourceFiles.slice() };
  }

  function shouldDeferAutoSpawn() {
    return state.windowKey !== 'main' && state.loaded !== true;
  }

  function handleWindowContext(payload = {}) {
    Object.assign(state, normalizeWindowContext(payload));
    if (log?.info) {
      log.info('WindowTeam', `Loaded window context for ${state.windowKey} (autoBoot=${state.autoBootAgents})`);
    }
    return getState();
  }

  async function maybeRunSecondaryAutoBoot({ reconnectedToExisting = false } = {}) {
    if (state.loaded !== true) {
      return { ok: false, skipped: true, reason: 'window_context_pending' };
    }
    if (state.windowKey === 'main') {
      return { ok: false, skipped: true, reason: 'main_window' };
    }
    if (state.autoBootAgents !== true) {
      return { ok: false, skipped: true, reason: 'auto_boot_disabled' };
    }
    await settings.checkAutoSpawn(
      terminal.spawnAllAgents,
      reconnectedToExisting
    );
    return { ok: true, ran: true, windowKey: state.windowKey };
  }

  return {
    getState,
    shouldDeferAutoSpawn,
    handleWindowContext,
    maybeRunSecondaryAutoBoot,
  };
}

module.exports = {
  createWindowTeamBootstrap,
  normalizeWindowContext,
  readInitialWindowContextFromLocation,
};
