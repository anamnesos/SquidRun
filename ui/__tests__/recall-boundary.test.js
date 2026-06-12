const { stripRecallBlocks } = require('../modules/memory-recall');
const { extractCandidates } = require('../scripts/hm-memory-extract');

describe('recall anti-loop boundary', () => {
  test('memory recall stripping removes delivery-only recall blocks', () => {
    const text = stripRecallBlocks(
      'Check the latest evidence note.\n\n[SQUIDRUN RECALL START]\nRECALL resultSetId=recall-1\n1. [memory_search/corpus] Some old memory\n[SQUIDRUN RECALL END]'
    ).trim();

    expect(text).toBe('Check the latest evidence note.');
    expect(text).not.toContain('Some old memory');
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
