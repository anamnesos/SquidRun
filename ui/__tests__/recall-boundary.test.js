const { parseClaudeTranscriptRecord } = require('../modules/transcript-index');
const { extractCandidates } = require('../scripts/hm-memory-extract');

describe('recall anti-loop boundary', () => {
  test('transcript parsing strips delivery-only recall blocks', () => {
    const record = parseClaudeTranscriptRecord({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Check the latest customs note.\n\n[SQUIDRUN RECALL START]\nRECALL resultSetId=recall-1\n1. [memory_search/corpus] Some old memory\n[SQUIDRUN RECALL END]',
        }],
      },
      sessionId: 'sess-1',
      timestamp: '2026-04-03T12:00:00.000Z',
    }, {
      sourceFile: 'D:/projects/squidrun/tmp.jsonl',
      lineNumber: 1,
    });

    expect(record.text).toBe('Check the latest customs note.');
    expect(record.text).not.toContain('Some old memory');
  });

  test('memory extraction ignores recall-only fragments', () => {
    const result = extractCandidates({
      session_id: 'sess-2',
      messages: [{
        text: '[SQUIDRUN RECALL START]\nRECALL resultSetId=recall-2\n1. [team_memory/structured] Some stale memory\n[SQUIDRUN RECALL END]',
      }],
    });

    expect(result).toEqual([]);
  });
});
