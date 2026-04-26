const {
  buildAnthropicExtractionCommand,
  buildSystemCapabilitiesSnapshot,
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

  test('builds a Claude extraction command when Anthropic is configured', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-do-not-use';
    const snapshot = buildSystemCapabilitiesSnapshot({
      projectRoot: 'D:\\projects\\squidrun',
      settings: { localModelEnabled: false },
      extractionTimeoutMs: 30000,
      nowMs: Date.parse('2026-03-17T10:15:00.000Z'),
    });

    expect(snapshot.localModels.enabled).toBe(false);
    expect(snapshot.localModels.sleepExtraction.enabled).toBe(true);
    expect(snapshot.localModels.sleepExtraction.path).toBe('anthropic-api');
    expect(snapshot.localModels.sleepExtraction.command).toContain('claude-extract.js');
    expect(resolveSleepExtractionCommandFromSnapshot(snapshot)).toContain('--model');
    expect(buildAnthropicExtractionCommand({
      projectRoot: 'D:\\projects\\squidrun',
      model: 'claude-opus-4-6',
    })).toContain('claude-extract.js');
  });

  test('falls back to unavailable extraction when no Anthropic key is present', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const snapshot = buildSystemCapabilitiesSnapshot({
      projectRoot: 'D:\\projects\\squidrun',
      settings: { localModelEnabled: false },
    });
    expect(snapshot.localModels.sleepExtraction.enabled).toBe(false);
    expect(snapshot.localModels.sleepExtraction.path).toBe('fallback');
    expect(snapshot.localModels.sleepExtraction.reason).toBe('anthropic_api_key_missing');
    expect(resolveSleepExtractionCommandFromSnapshot(snapshot)).toBe('');
  });

  test('does not emit any ollama branch in the capability snapshot', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake-key-do-not-use';
    const snapshot = buildSystemCapabilitiesSnapshot({
      projectRoot: 'D:\\projects\\squidrun',
      settings: { localModelEnabled: true },
    });
    expect(snapshot.localModels).not.toHaveProperty('ollama');
    expect(snapshot.localModels).not.toHaveProperty('provider');
  });
});
