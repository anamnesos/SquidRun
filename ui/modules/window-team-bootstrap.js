'use strict';

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
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
  };
}

function readInitialWindowContextFromLocation(search = '') {
  try {
    const params = new URLSearchParams(String(search || ''));
    return {
      loaded: false,
      windowKey: toText(params.get('windowKey'), 'main'),
      windowTeam: toText(params.get('windowTeam'), toText(params.get('windowKey'), 'main')),
      profileName: toText(params.get('profileName'), 'main'),
      profileLabel: toText(params.get('profileLabel'), 'Main'),
      roleLayout: 'standard',
      sessionScopeId: '',
      startupBundlePath: '',
      startupSourceFiles: [],
      autoBootAgents: false,
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
