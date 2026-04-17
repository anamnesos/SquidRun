const {
  buildAnthropicExtractionCommand,
  buildOllamaExtractionCommand,
  buildSystemCapabilitiesSnapshot,
  detectOllamaRuntime,
  pickPreferredModel,
  resolveSleepExtractionCommandFromSnapshot,
} = require('../modules/local-model-capabilities');

describe('local-model-capabilities', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalAnthropicKey == null) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  test('picks the highest-priority pulled model', () => {
    const model = pickPreferredModel(
      [
        { name: 'phi3:mini' },
        { name: 'llama3.1:8b' },
      ],
      ['llama3:8b', 'llama3.1:8b', 'phi3:mini']
    );

    expect(model).toBe('llama3.1:8b');
  });

  test('detects running Ollama with a suitable model', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'phi3:mini', size: 1 },
          { name: 'llama3:8b', size: 2 },
        ],
      }),
    });

    const result = await detectOllamaRuntime({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:11434',
      preferredModels: ['llama3:8b', 'phi3:mini'],
      nowMs: Date.parse('2026-03-17T10:15:00.000Z'),
    });

    expect(result.running).toBe(true);
    expect(result.suitableModelAvailable).toBe(true);
    expect(result.selectedModel).toBe('llama3:8b');
    expect(result.checkedAt).toBe('2026-03-17T10:15:00.000Z');
  });

  test('marks Ollama unavailable when the probe fails', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await detectOllamaRuntime({
      fetchImpl,
      timeoutMs: 1234,
    });

    expect(result.running).toBe(false);
    expect(result.suitableModelAvailable).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  test('builds a Claude extraction command when Anthropic is configured', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-do-not-use';
    const snapshot = buildSystemCapabilitiesSnapshot({
      projectRoot: 'D:\\projects\\squidrun',
      settings: { localModelEnabled: true },
      ollama: {
        running: true,
        reachable: true,
        selectedModel: 'llama3:8b',
        suitableModelAvailable: true,
        baseUrl: 'http://127.0.0.1:11434',
        pulledModels: [{ name: 'llama3:8b' }],
      },
      extractionTimeoutMs: 30000,
      nowMs: Date.parse('2026-03-17T10:15:00.000Z'),
    });

    expect(snapshot.localModels.enabled).toBe(true);
    expect(snapshot.localModels.sleepExtraction.enabled).toBe(true);
    expect(snapshot.localModels.sleepExtraction.path).toBe('anthropic-api');
    expect(snapshot.localModels.sleepExtraction.command).toContain('claude-extract.js');
    expect(resolveSleepExtractionCommandFromSnapshot(snapshot)).toContain('--model');
    expect(buildAnthropicExtractionCommand({
      projectRoot: 'D:\\projects\\squidrun',
      model: 'claude-opus-4-6',
    })).toContain('claude-extract.js');
    expect(buildOllamaExtractionCommand({
      projectRoot: 'D:\\projects\\squidrun',
      model: 'llama3:8b',
    })).toContain('ollama-extract.js');
  });
});
