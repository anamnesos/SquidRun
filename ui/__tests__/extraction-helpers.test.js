const {
  VALID_CATEGORIES,
  buildExtractionPrompt,
  buildTranscriptFromPayload,
  dedupeFacts,
  validateExtractionArray,
} = require('../scripts/extraction-helpers');

describe('extraction-helpers', () => {
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

  test('validates an extraction array into the canonical shape', () => {
    expect(validateExtractionArray([
      { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
    ])).toEqual([
      { fact: 'Use hm-send for agent messaging.', category: 'workflow', confidence: 0.92 },
    ]);
  });

  test('rejects items missing required fields', () => {
    expect(() => validateExtractionArray([
      { fact: '', category: 'workflow', confidence: 1 },
    ])).toThrow('extraction_item_missing_fact');
    expect(() => validateExtractionArray([
      { fact: 'x', category: 'nope', confidence: 1 },
    ])).toThrow('extraction_item_invalid_category:nope');
    expect(() => validateExtractionArray('not an array')).toThrow('extraction_output_not_array');
  });

  test('dedupes repeated facts by category and text', () => {
    expect(dedupeFacts([
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.9 },
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.7 },
      { fact: 'Use hm-send.', category: 'preference', confidence: 0.8 },
    ])).toEqual([
      { fact: 'Use hm-send.', category: 'workflow', confidence: 0.9 },
      { fact: 'Use hm-send.', category: 'preference', confidence: 0.8 },
    ]);
  });

  test('exports the expected category set', () => {
    expect([...VALID_CATEGORIES].sort()).toEqual(
      ['fact', 'observation', 'preference', 'system_state', 'workflow']
    );
  });
});
