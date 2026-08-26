const { runPrecompress } = require('../scripts/hm-hook-precompress');

describe('hm-hook-precompress', () => {
  test('stages memory internally but returns only a valid empty PreCompact response', () => {
    const writes = [];
    const store = {
      stageMemoryPRs: jest.fn(() => ({
        staged: ['one'],
        merged: [],
        pendingCount: 1,
      })),
      close: jest.fn(),
    };
    const result = runPrecompress(JSON.stringify({
      session_id: 'session-test',
      transcript: 'Remember this durable preference: verify before claiming success.',
    }), {
      cwd: 'D:\\fixture',
      now: new Date('2026-08-24T17:55:00.000Z'),
      createStore: () => store,
      fsImpl: {
        existsSync: () => false,
        mkdirSync: jest.fn(),
        writeFileSync: (...args) => writes.push(args),
      },
    });

    expect(result.response).toEqual({});
    expect(result.error).toBeUndefined();
    expect(store.stageMemoryPRs).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  test('fails open for compaction with valid JSON when memory extraction throws', () => {
    const result = runPrecompress('{not-json', {
      createStore: () => {
        throw new Error('store must not be reached');
      },
    });

    expect(result.response).toEqual({});
    expect(result.error).toMatch(/JSON/);
  });
});
