const {
  extractJsonPayload,
  extractTextFromAnthropicResponse,
  runClaudeExtraction,
} = require('../scripts/claude-extract');

describe('claude-extract', () => {
  test('extracts text from Anthropic content blocks', () => {
    expect(extractTextFromAnthropicResponse({
      content: [
        { type: 'text', text: '[{"fact":"Use hm-send.","category":"workflow","confidence":0.9}]' },
      ],
    })).toContain('Use hm-send.');
  });

  test('parses fenced JSON payloads', () => {
    const parsed = extractJsonPayload('```json\n[{"fact":"Use hm-send.","category":"workflow","confidence":0.9}]\n```');
    expect(parsed).toEqual([
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.9 },
    ]);
  });

  test('runs extraction against Anthropic and returns validated facts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
              { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.7 },
            ]),
          },
        ],
      }),
    });

    const result = await runClaudeExtraction({
      episodes: [{ rawBody: 'Use hm-send for agent messaging.' }],
    }, {
      fetchImpl,
      apiKey: 'sk-ant-test-fake-key-do-not-use',
      model: 'claude-opus-4-6',
      baseUrl: 'https://api.anthropic.com',
      timeoutMs: 30000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toEqual([
      { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
    ]);
  });
});
