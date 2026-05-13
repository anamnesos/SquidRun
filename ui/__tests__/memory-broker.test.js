const {
  RECALL_START,
  createMemoryBroker,
  formatRecallForPaneMessage,
  prependRecallToMessage,
} = require('../modules/memory-broker');

describe('memory-broker', () => {
  test('merges fragmented stores with reciprocal rank fusion', async () => {
    const broker = createMemoryBroker({
      providers: [
        {
          id: 'cognitive',
          sourceKind: 'vector_cognitive',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  canonicalKey: 'auth-endpoint',
                  id: 'mem-auth',
                  title: 'Service auth',
                  excerpt: 'Service auth now uses /v2/token.',
                  score: 0.7,
                },
              ],
            };
          },
        },
        {
          id: 'team',
          sourceKind: 'graph_team',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  canonicalKey: 'auth-endpoint',
                  id: 'claim-auth',
                  title: 'Builder claim',
                  excerpt: 'Builder agreed /v2/token is canonical.',
                  score: 0.6,
                },
              ],
            };
          },
        },
        {
          id: 'ledger',
          sourceKind: 'episodic_ledger',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  id: 'decision-other',
                  title: 'Unrelated decision',
                  excerpt: 'A single-source memory should rank below a cross-store match.',
                  score: 99,
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('which auth endpoint is canonical?', {}, { limit: 3 });

    expect(result.ok).toBe(true);
    expect(result.results[0]).toEqual(expect.objectContaining({
      id: 'mem-auth',
      sourceKind: 'vector_cognitive',
    }));
    expect(result.results[0].contributors.map((entry) => entry.source)).toEqual(['cognitive', 'team']);
    expect(result.results[1]).toEqual(expect.objectContaining({
      id: 'decision-other',
    }));
  });

  test('keeps slow providers from blocking recall', async () => {
    const broker = createMemoryBroker({
      providerTimeoutMs: 25,
      providers: [
        {
          id: 'slow',
          sourceKind: 'episodic_ledger',
          recall: () => new Promise(() => {}),
        },
        {
          id: 'fast',
          sourceKind: 'graph_team',
          async recall() {
            return {
              ok: true,
              items: [{ id: 'claim-1', excerpt: 'Fast memory result.' }],
            };
          },
        },
      ],
    });

    const result = await broker.recall('fast result', {}, { timeoutMs: 25 });

    expect(result.results).toEqual([
      expect.objectContaining({ id: 'claim-1' }),
    ]);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'slow', ok: false, reason: 'provider_timeout' }),
    ]));
  });

  test('formats a compact pane recall block', async () => {
    const recall = {
      ok: true,
      results: [
        {
          rank: 1,
          sourceKind: 'vector_cognitive',
          title: 'Preference',
          excerpt: 'James wants non-jargon plain English updates.',
          ref: 'memory:pref',
        },
      ],
    };

    const block = formatRecallForPaneMessage(recall);
    expect(block).toContain(RECALL_START);
    expect(block).toContain('vector_cognitive - Preference: James wants non-jargon plain English updates.');
    expect(prependRecallToMessage('Update me.', recall)).toContain('\n\nUpdate me.');
    expect(prependRecallToMessage(`${RECALL_START}\nold`, recall)).toBe(`${RECALL_START}\nold`);
  });
});
