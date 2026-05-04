'use strict';

const SERVICE_DEFINITIONS = Object.freeze([
  {
    id: 'renderer',
    label: 'Renderer UI',
    owner: 'electron-renderer',
    restartAction: 'reload-renderers',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'renderer-heartbeat',
  },
  {
    id: 'main-ipc',
    label: 'Main IPC',
    owner: 'electron-main',
    restartAction: 'restart-app',
    requiresMainRestart: true,
    affectsTerminals: false,
    statusSource: 'app-status',
  },
  {
    id: 'telegram-poller',
    label: 'Telegram Poller',
    owner: 'telegram-service',
    restartAction: 'restart-telegram-poller',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'telegram-runtime',
  },
  {
    id: 'voice-broker',
    label: 'Voice Broker',
    owner: 'voice-broker',
    restartAction: 'hm-voice-broker restart',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'voice-broker-status',
  },
  {
    id: 'bridge',
    label: 'Device Bridge',
    owner: 'bridge-service',
    restartAction: 'restart-bridge',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'bridge-runtime',
  },
  {
    id: 'pane-host',
    label: 'Pane Host Windows',
    owner: 'pane-host-manager',
    restartAction: 'restart-pane-hosts',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'pane-host-status',
  },
  {
    id: 'terminal-daemon',
    label: 'Terminal Daemon',
    owner: 'terminal-daemon',
    restartAction: 'restart-terminal-daemon',
    requiresMainRestart: false,
    affectsTerminals: true,
    statusSource: 'daemon-snapshot',
  },
  {
    id: 'memory-workers',
    label: 'Memory Workers',
    owner: 'memory-runtime',
    restartAction: 'restart-memory-workers',
    requiresMainRestart: false,
    affectsTerminals: false,
    statusSource: 'memory-health',
  },
]);

const VALID_SERVICE_STATES = new Set(['unknown', 'healthy', 'degraded', 'down', 'not_configured']);

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeServiceState(value) {
  const normalized = toNonEmptyString(value).toLowerCase();
  return VALID_SERVICE_STATES.has(normalized) ? normalized : 'unknown';
}

function normalizeServiceDefinition(definition = {}, status = {}) {
  const id = toNonEmptyString(definition.id);
  return {
    id,
    label: toNonEmptyString(definition.label) || id,
    owner: toNonEmptyString(definition.owner) || 'unknown',
    restartAction: toNonEmptyString(definition.restartAction) || '',
    requiresMainRestart: Boolean(definition.requiresMainRestart),
    affectsTerminals: Boolean(definition.affectsTerminals),
    statusSource: toNonEmptyString(definition.statusSource) || '',
    state: normalizeServiceState(status.state),
    detail: toNonEmptyString(status.detail),
    lastCheckedAtMs: Number.isFinite(Number(status.lastCheckedAtMs)) ? Number(status.lastCheckedAtMs) : 0,
  };
}

function buildServiceLifecycleRegistry(options = {}) {
  const statuses = options.statuses && typeof options.statuses === 'object' ? options.statuses : {};
  const definitions = Array.isArray(options.definitions) ? options.definitions : SERVICE_DEFINITIONS;
  return definitions.map((definition) => normalizeServiceDefinition(definition, statuses[definition.id]));
}

function summarizeServiceLifecycle(registry = []) {
  const services = Array.isArray(registry) ? registry : buildServiceLifecycleRegistry();
  const counts = services.reduce((acc, service) => {
    const state = normalizeServiceState(service.state);
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});
  const terminalSensitive = services.filter((service) => service.affectsTerminals).map((service) => service.id);
  const mainRestartRequired = services.filter((service) => service.requiresMainRestart).map((service) => service.id);
  return {
    total: services.length,
    counts,
    terminalSensitive,
    mainRestartRequired,
    degraded: services.filter((service) => ['degraded', 'down'].includes(normalizeServiceState(service.state))),
  };
}

function chooseMinimalRestartAction(serviceId, options = {}) {
  const registry = buildServiceLifecycleRegistry(options);
  const service = registry.find((entry) => entry.id === serviceId);
  if (!service) {
    return {
      ok: false,
      reason: 'unknown_service',
      serviceId,
    };
  }
  return {
    ok: true,
    serviceId: service.id,
    restartAction: service.restartAction,
    requiresMainRestart: service.requiresMainRestart,
    affectsTerminals: service.affectsTerminals,
  };
}

module.exports = {
  SERVICE_DEFINITIONS,
  VALID_SERVICE_STATES,
  buildServiceLifecycleRegistry,
  chooseMinimalRestartAction,
  normalizeServiceDefinition,
  normalizeServiceState,
  summarizeServiceLifecycle,
};
