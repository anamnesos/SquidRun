// @ts-check

const { CognitiveMemoryApi } = require('../cognitive-memory-api');

/** @typedef {import('../../types/contracts').CognitiveMemoryAction} CognitiveMemoryAction */
/** @typedef {import('../../types/contracts').CognitiveMemoryOperationOptions} CognitiveMemoryOperationOptions */
/** @typedef {import('../../types/contracts').CognitiveMemoryPayload} CognitiveMemoryPayload */

const COGNITIVE_MEMORY_CHANNELS = Object.freeze([
  'cognitive-memory:ingest',
  'cognitive-memory:retrieve',
  'cognitive-memory:patch',
  'cognitive-memory:salience',
]);

/** @type {any} */
let sharedApi = null;

/**
 * @param {unknown} value
 * @returns {any}
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return /** @type {any} */ (value);
}

/**
 * @param {...unknown} values
 * @returns {string}
 */
function asText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/**
 * @param {CognitiveMemoryOperationOptions} [options]
 * @returns {InstanceType<typeof CognitiveMemoryApi> | NonNullable<CognitiveMemoryOperationOptions['api']>}
 */
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

/**
 * @param {CognitiveMemoryAction | string} action
 * @param {CognitiveMemoryPayload} [payload]
 * @param {CognitiveMemoryOperationOptions} [options]
 * @returns {Promise<any>}
 */
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

/**
 * @param {{ ipcMain: { handle(channel: string, handler: Function): void } }} ctx
 * @returns {void}
 */
function registerCognitiveMemoryHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerCognitiveMemoryHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  for (const channel of COGNITIVE_MEMORY_CHANNELS) {
    const action = channel.split(':')[1];
    ipcMain.handle(
      channel,
      /**
       * @param {any} _event
       * @param {CognitiveMemoryPayload} [payload]
       */
      (_event, payload = {}) => executeCognitiveMemoryOperation(action, payload, {
        source: {
          via: 'ipc',
          role: 'system',
        },
      })
    );
  }
}

/**
 * @param {{ ipcMain?: { removeHandler(channel: string): void } } | undefined} ctx
 * @returns {void}
 */
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
