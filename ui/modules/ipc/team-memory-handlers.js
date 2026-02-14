const { executeTeamMemoryOperation } = require('../team-memory');

const TEAM_MEMORY_CHANNELS = Object.freeze([
  'team-memory:create',
  'team-memory:query',
  'team-memory:update',
  'team-memory:deprecate',
  'team-memory:run-experiment',
  'team-memory:get-experiment',
  'team-memory:list-experiments',
]);

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function resolveCreateAction(payload) {
  const entity = String(payload.entity || payload.kind || '').trim().toLowerCase();
  if (entity === 'decision') return 'create-decision';
  if (entity === 'evidence') return 'add-evidence';
  if (entity === 'consensus') return 'record-consensus';
  if (entity === 'belief-snapshot' || entity === 'snapshot') return 'create-belief-snapshot';
  if (entity === 'pattern') return 'create-pattern';
  if (entity === 'guard') return 'create-guard';
  return 'create-claim';
}

function resolveUpdateAction(payload) {
  const entity = String(payload.entity || payload.kind || '').trim().toLowerCase();
  const operation = String(payload.operation || payload.op || '').trim().toLowerCase();
  if (entity === 'pattern') {
    if (operation === 'activate') return 'activate-pattern';
    if (operation === 'deactivate') return 'deactivate-pattern';
    return null;
  }
  if (entity === 'guard') {
    if (operation === 'activate') return 'activate-guard';
    if (operation === 'deactivate') return 'deactivate-guard';
    return null;
  }
  if (entity === 'decision' || operation === 'record-outcome') {
    return 'record-outcome';
  }
  return 'update-claim-status';
}

function resolveAction(channel, payload) {
  switch (channel) {
    case 'team-memory:create':
      return resolveCreateAction(payload);
    case 'team-memory:query': {
      const entity = String(payload.entity || payload.kind || '').trim().toLowerCase();
      if (entity === 'consensus') return 'get-consensus';
      if (entity === 'beliefs' || entity === 'belief') return 'get-agent-beliefs';
      if (entity === 'contradictions' || entity === 'contradiction') return 'get-contradictions';
      if (entity === 'pattern' || entity === 'patterns') return 'query-patterns';
      if (entity === 'guard' || entity === 'guards') return 'query-guards';
      return 'query-claims';
    }
    case 'team-memory:update':
      return resolveUpdateAction(payload);
    case 'team-memory:deprecate':
      return 'deprecate-claim';
    case 'team-memory:run-experiment':
      return 'run-experiment';
    case 'team-memory:get-experiment':
      return 'get-experiment';
    case 'team-memory:list-experiments':
      return 'list-experiments';
    default:
      return null;
  }
}

function registerTeamMemoryHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTeamMemoryHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  for (const channel of TEAM_MEMORY_CHANNELS) {
    ipcMain.handle(channel, (event, payload = {}) => {
      const normalizedPayload = asObject(payload);
      const action = resolveAction(channel, normalizedPayload);
      if (!action) {
        return {
          ok: false,
          reason: 'unknown_action',
          channel,
        };
      }
      return executeTeamMemoryOperation(action, normalizedPayload, {
        deps,
        source: {
          via: 'ipc',
          role: 'system',
        },
      });
    });
  }
}

function unregisterTeamMemoryHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  for (const channel of TEAM_MEMORY_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

registerTeamMemoryHandlers.unregister = unregisterTeamMemoryHandlers;

module.exports = {
  TEAM_MEMORY_CHANNELS,
  registerTeamMemoryHandlers,
  unregisterTeamMemoryHandlers,
};
