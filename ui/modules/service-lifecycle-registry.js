'use strict';

const SERVICE_DEFINITIONS = Object.freeze([
  {
    id: 'renderer',
    label: 'Renderer UI',
    owner: 'main-process',
    statusMethod: 'BrowserWindow webContents',
    restartAction: 'reload-renderers',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: true,
    userImpact: 'Refreshes visible UI only; terminal agents should remain attached.',
  },
  {
    id: 'main-ipc',
    label: 'Main IPC handlers',
    owner: 'electron-main',
    statusMethod: 'handler-registry',
    restartAction: 'restart-electron-main',
    requiresMainRestart: true,
    affectsTerminals: false,
    safeRestart: false,
    userImpact: 'Needed for newly registered main-process handlers.',
  },
  {
    id: 'telegram-poller',
    label: 'Telegram poller',
    owner: 'transport',
    statusMethod: 'telegram-poller status',
    restartAction: 'restart-telegram-poller',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: true,
    userImpact: 'Restarts remote message intake without touching panes.',
  },
  {
    id: 'voice-broker',
    label: 'Voice broker',
    owner: 'transport',
    statusMethod: 'voice-broker:status',
    restartAction: 'voice-broker:restart',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: true,
    userImpact: 'Restarts voice session service without touching panes.',
  },
  {
    id: 'bridge',
    label: 'Cross-device bridge',
    owner: 'transport',
    statusMethod: 'bridge status',
    restartAction: 'restart-bridge',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: true,
    userImpact: 'Reconnects remote relay/device presence only.',
  },
  {
    id: 'pane-host',
    label: 'Hidden pane-host windows',
    owner: 'electron-main',
    statusMethod: 'paneHost.readyPanes',
    restartAction: 'restart-pane-hosts',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: false,
    userImpact: 'Can interrupt injection/ack flow but should not kill terminal PTYs.',
  },
  {
    id: 'terminal-daemon',
    label: 'Terminal daemon',
    owner: 'pty-runtime',
    statusMethod: 'daemon terminal snapshot',
    restartAction: 'restart-terminal-daemon',
    requiresMainRestart: false,
    affectsTerminals: true,
    safeRestart: false,
    userImpact: 'High impact; affects all live agent terminal sessions.',
  },
  {
    id: 'memory-workers',
    label: 'Memory workers',
    owner: 'memory-runtime',
    statusMethod: 'memory consistency / worker heartbeat',
    restartAction: 'restart-memory-workers',
    requiresMainRestart: false,
    affectsTerminals: false,
    safeRestart: true,
    userImpact: 'Rebuilds memory/background processing without touching panes.',
  },
]);

function cloneDefinition(definition, status = null) {
  return {
    ...definition,
    status,
  };
}

function buildServiceLifecycleSummary(options = {}) {
  const statusById = options.statusById && typeof options.statusById === 'object'
    ? options.statusById
    : {};
  const services = SERVICE_DEFINITIONS.map((definition) => cloneDefinition(
    definition,
    statusById[definition.id] || null
  ));
  const totals = {
    services: services.length,
    safeRestartCount: services.filter((service) => service.safeRestart).length,
    mainRestartCount: services.filter((service) => service.requiresMainRestart).length,
    terminalImpactCount: services.filter((service) => service.affectsTerminals).length,
  };
  return {
    ok: true,
    generatedAtMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
    services,
    totals,
  };
}

function buildServiceLifecycleRegistry(options = {}) {
  const statuses = options.statuses && typeof options.statuses === 'object'
    ? options.statuses
    : (options.statusById && typeof options.statusById === 'object' ? options.statusById : {});
  return buildServiceLifecycleSummary({
    ...options,
    statusById: statuses,
  }).services;
}

function serviceIsDegraded(service = {}) {
  const state = String(service.status?.state || service.status?.status || '').trim().toLowerCase();
  if (!state) return false;
  return ['blocked', 'degraded', 'error', 'failed', 'fail', 'missing', 'unavailable'].includes(state);
}

function summarizeServiceLifecycle(registry = {}) {
  const services = Array.isArray(registry)
    ? registry
    : (Array.isArray(registry.services) ? registry.services : []);
  const degraded = services.filter(serviceIsDegraded);
  return {
    ok: degraded.length === 0,
    services,
    degraded,
    totals: {
      services: services.length,
      degraded: degraded.length,
    },
  };
}

function findServiceLifecycle(id) {
  const target = String(id || '').trim();
  if (!target) return null;
  return SERVICE_DEFINITIONS.find((service) => service.id === target) || null;
}

module.exports = {
  SERVICE_DEFINITIONS,
  buildServiceLifecycleRegistry,
  buildServiceLifecycleSummary,
  findServiceLifecycle,
  summarizeServiceLifecycle,
};
