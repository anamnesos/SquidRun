const {
  buildExtractionPrompt,
  buildTranscriptFromPayload,
  dedupeFacts,
  parseOllamaResponse,
  runOllamaExtraction,
  validateExtractionArray,
} = require('../scripts/ollama-extract');

describe('ollama-extract', () => {
  test('builds transcript text from sleep-cycle episodes', () => {
    const transcript = buildTranscriptFromPayload({
      episodes: [
        { senderRole: 'builder', targetRole: 'architect', rawBody: 'First fact' },
        { senderRole: 'oracle', targetRole: 'architect', rawBody: 'Second fact' },
      ],
    });

    expect(transcript).toContain('1. builder -> architect: First fact');
    expect(transcript).toContain('2. oracle -> architect: Second fact');
    expect(buildExtractionPrompt({ episodes: [{ rawBody: 'A durable fact' }] })).toContain('Transcript:');
  });

  test('parses and validates Ollama JSON output', () => {
    const parsed = parseOllamaResponse({
      response: JSON.stringify([
        { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
      ]),
    });

    expect(validateExtractionArray(parsed)).toEqual([
      { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
    ]);
  });

  test('dedupes repeated facts by category and text', () => {
    expect(dedupeFacts([
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.9 },
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.7 },
      { fact: 'Local models are mechanical only.', category: 'fact', confidence: 0.8 },
    ])).toEqual([
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.9 },
      { fact: 'Local models are mechanical only.', category: 'fact', confidence: 0.8 },
    ]);
  });

  test('runs extraction against Ollama and returns validated facts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify([
          { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
          { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.70 },
        ]),
      }),
    });

    const result = await runOllamaExtraction({
      episodes: [{ rawBody: 'Use hm-send for agent messaging.' }],
    }, {
      fetchImpl,
      model: 'llama3:8b',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 30000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/generate',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toEqual([
      { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
    ]);
  });

  test('parses wrapped object response from Llama models', () => {
    const parsed = parseOllamaResponse({
      response: JSON.stringify({
        facts: [
          { fact: 'Ollama runs on RTX 5090.', category: 'system_state', confidence: 0.85 },
        ],
      }),
    });

    expect(validateExtractionArray(parsed)).toEqual([
      { fact: 'Ollama runs on RTX 5090.', category: 'system_state', confidence: 0.85 },
    ]);
  });

  test('rejects malformed extraction items', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify([
          { fact: '', category: 'workflow', confidence: 1 },
        ]),
      }),
    });

    await expect(runOllamaExtraction({}, { fetchImpl })).rejects.toThrow('extraction_item_missing_fact');
  });
});
