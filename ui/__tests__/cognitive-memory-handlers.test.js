const mockApi = {
  ingest: jest.fn(async () => ({ ok: true, node: { nodeId: 'node_1' } })),
  retrieve: jest.fn(async () => ({ ok: true, results: [{ nodeId: 'node_1' }] })),
  patch: jest.fn(async () => ({ ok: true, node: { nodeId: 'node_1', currentVersion: 2 } })),
  applySalienceField: jest.fn(() => ({ ok: true, updates: [{ nodeId: 'node_1' }] })),
  close: jest.fn(),
};

jest.mock('../modules/cognitive-memory-api', () => ({
  CognitiveMemoryApi: jest.fn(() => mockApi),
}));

const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');
const {
  COGNITIVE_MEMORY_CHANNELS,
  executeCognitiveMemoryOperation,
  registerCognitiveMemoryHandlers,
  unregisterCognitiveMemoryHandlers,
  closeSharedCognitiveMemoryRuntime,
} = require('../modules/ipc/cognitive-memory-handlers');

describe('cognitive-memory IPC handlers', () => {
  let ipcMain;
  let ctx;

  beforeEach(() => {
    closeSharedCognitiveMemoryRuntime();
    CognitiveMemoryApi.mockClear();
    mockApi.ingest.mockClear();
    mockApi.retrieve.mockClear();
    mockApi.patch.mockClear();
    mockApi.applySalienceField.mockClear();
    mockApi.close.mockClear();

    ipcMain = {
      handle: jest.fn(),
      removeHandler: jest.fn(),
    };
    ctx = { ipcMain };
  });

  test('registers all cognitive-memory channels', () => {
    registerCognitiveMemoryHandlers(ctx);
    expect(ipcMain.handle).toHaveBeenCalledTimes(COGNITIVE_MEMORY_CHANNELS.length);
    for (const channel of COGNITIVE_MEMORY_CHANNELS) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  test('routes ingest/retrieve/patch/salience payloads to runtime API methods', async () => {
    registerCognitiveMemoryHandlers(ctx);

    const getHandler = (channel) => {
      const call = ipcMain.handle.mock.calls.find(([name]) => name === channel);
      return call?.[1];
    };

    await getHandler('cognitive-memory:ingest')({}, {
      content: 'ServiceTitan auth endpoint is now /v2/token.',
      category: 'fact',
      agent: 'builder',
    });
    expect(mockApi.ingest).toHaveBeenCalledWith(expect.objectContaining({
      content: 'ServiceTitan auth endpoint is now /v2/token.',
      category: 'fact',
      agentId: 'builder',
      ingestedVia: 'ipc',
    }));

    await getHandler('cognitive-memory:retrieve')({}, {
      query: 'ServiceTitan auth endpoint',
      limit: 2,
      agent: 'builder',
    });
    expect(mockApi.retrieve).toHaveBeenCalledWith(
      'ServiceTitan auth endpoint',
      expect.objectContaining({
        agentId: 'builder',
        limit: 2,
      })
    );

    await getHandler('cognitive-memory:patch')({}, {
      lease: 'lease_1',
      content: 'ServiceTitan auth endpoint is /v3/token.',
      reason: 'validated in runtime',
      agent: 'builder',
    });
    expect(mockApi.patch).toHaveBeenCalledWith(
      'lease_1',
      'ServiceTitan auth endpoint is /v3/token.',
      expect.objectContaining({
        agentId: 'builder',
        reason: 'validated in runtime',
      })
    );

    await getHandler('cognitive-memory:salience')({}, {
      node: 'node_1',
      delta: 0.5,
      max_depth: 1,
    });
    expect(mockApi.applySalienceField).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'node_1',
      delta: 0.5,
      maxDepth: 1,
    }));
  });

  test('executeCognitiveMemoryOperation returns unknown_action for invalid action', async () => {
    const result = await executeCognitiveMemoryOperation('unknown', {});
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'unknown_action',
      action: 'unknown',
    }));
  });

  test('closeSharedCognitiveMemoryRuntime closes the shared API instance', async () => {
    await executeCognitiveMemoryOperation('retrieve', { query: 'auth endpoint' });
    expect(CognitiveMemoryApi).toHaveBeenCalledTimes(1);

    closeSharedCognitiveMemoryRuntime();

    expect(mockApi.close).toHaveBeenCalledTimes(1);
  });

  test('unregister removes registered channels', () => {
    unregisterCognitiveMemoryHandlers(ctx);
    for (const channel of COGNITIVE_MEMORY_CHANNELS) {
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
