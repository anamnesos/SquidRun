const { CognitiveMemoryApi } = require('../cognitive-memory-api');

const COGNITIVE_MEMORY_CHANNELS = Object.freeze([
  'cognitive-memory:ingest',
  'cognitive-memory:retrieve',
  'cognitive-memory:patch',
  'cognitive-memory:salience',
]);

let sharedApi = null;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveSharedApi(options = {}) {
  if (options.api) return options.api;
  if (!sharedApi) {
    sharedApi = new CognitiveMemoryApi(options.apiOptions || {});
  }
  return sharedApi;
}

function closeSharedCognitiveMemoryRuntime() {
  if (!sharedApi) return;
  try {
    sharedApi.close();
  } catch {}
  sharedApi = null;
}

async function executeCognitiveMemoryOperation(action, payload = {}, options = {}) {
  const normalizedPayload = asObject(payload);
  const source = asObject(options.source);
  const api = resolveSharedApi(options);

  switch (String(action || '').trim().toLowerCase()) {
    case 'ingest':
      return api.ingest({
        ...normalizedPayload,
        agentId: asText(normalizedPayload.agentId, normalizedPayload.agent_id, normalizedPayload.agent, source.role, 'system'),
        ingestedVia: asText(normalizedPayload.ingestedVia, normalizedPayload.ingested_via, source.via, 'ipc'),
      });
    case 'retrieve':
      return api.retrieve(
        asText(normalizedPayload.query, normalizedPayload.text),
        {
          agentId: asText(normalizedPayload.agentId, normalizedPayload.agent_id, normalizedPayload.agent, source.role, 'system'),
          limit: normalizedPayload.limit,
          leaseMs: normalizedPayload.leaseMs ?? normalizedPayload.lease_ms,
        }
      );
    case 'patch':
      return api.patch(
        asText(normalizedPayload.leaseId, normalizedPayload.lease_id, normalizedPayload.lease),
        asText(normalizedPayload.content, normalizedPayload.updatedContent, normalizedPayload.updated_content),
        {
          agentId: asText(normalizedPayload.agentId, normalizedPayload.agent_id, normalizedPayload.agent, source.role, 'system'),
          reason: asText(normalizedPayload.reason) || null,
        }
      );
    case 'salience':
      return api.applySalienceField({
        ...normalizedPayload,
        nodeId: asText(normalizedPayload.nodeId, normalizedPayload.node_id, normalizedPayload.node),
        maxDepth: normalizedPayload.maxDepth ?? normalizedPayload.max_depth,
      });
    default:
      return {
        ok: false,
        reason: 'unknown_action',
        action: String(action || ''),
      };
  }
}

function registerCognitiveMemoryHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerCognitiveMemoryHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  for (const channel of COGNITIVE_MEMORY_CHANNELS) {
    const action = channel.split(':')[1];
    ipcMain.handle(channel, (_event, payload = {}) => executeCognitiveMemoryOperation(action, payload, {
      source: {
        via: 'ipc',
        role: 'system',
      },
    }));
  }
}

function unregisterCognitiveMemoryHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  for (const channel of COGNITIVE_MEMORY_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

registerCognitiveMemoryHandlers.unregister = unregisterCognitiveMemoryHandlers;

module.exports = {
  COGNITIVE_MEMORY_CHANNELS,
  executeCognitiveMemoryOperation,
  registerCognitiveMemoryHandlers,
  unregisterCognitiveMemoryHandlers,
  closeSharedCognitiveMemoryRuntime,
};
