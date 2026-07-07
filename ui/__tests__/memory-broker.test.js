const {
  DEFAULT_RECALL_BLOCK_MAX_CHARS,
  RECALL_START,
  MEMORY_RECALL_MIN_MESSAGE_LENGTH,
  createMemoryBroker,
  formatRecallForPaneMessage,
  prependRecallToMessage,
  messageReferencesPastWork,
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

  test('suppresses Eunbyeol and Korean case recall in a non-case main lane', async () => {
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
                  id: 'case-eunbyeol',
                  title: 'Eunbyeol Korean case',
                  excerpt: 'Old Korean fraud case context for Eunbyeol should not leak into this lane.',
                  ref: 'context-snapshots-eunbyeol/1.md',
                  score: 10,
                  metadata: {
                    profileName: 'eunbyeol',
                    sessionScopeId: 'app-test:eunbyeol',
                  },
                },
                {
                  id: 'main-tabs',
                  title: 'Main workspace tabs UI',
                  excerpt: 'Main SquidRun tab semantics and profile scoping investigation.',
                  ref: 'squidrun/workspace-tabs',
                  score: 1,
                  metadata: {
                    profileName: 'main',
                  },
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('Eunbyeol top tabs confused James', {
      windowKey: 'main',
      profileName: 'main',
      sessionScopeId: 'app-session-384',
      laneKind: 'ui_tabs_profile_isolation',
    }, { limit: 5 });

    expect(result.ok).toBe(true);
    expect(result.results.map((item) => item.id)).toEqual(['main-tabs']);
    expect(formatRecallForPaneMessage(result)).not.toMatch(/Eunbyeol|Korean fraud|context-snapshots-eunbyeol/i);
  });

  test('allows Eunbyeol profile recall when the context explicitly targets Eunbyeol', async () => {
    const broker = createMemoryBroker({
      providers: [
        {
          id: 'team',
          sourceKind: 'graph_team',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  id: 'case-eunbyeol',
                  title: 'Eunbyeol Korean case',
                  excerpt: 'Scoped case context for the Eunbyeol profile.',
                  ref: 'context-snapshots-eunbyeol/1.md',
                  metadata: {
                    scopes: ['profile:eunbyeol'],
                  },
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('Eunbyeol case status', {
      windowKey: 'eunbyeol',
      profileName: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    }, { limit: 5 });

    expect(result.results).toEqual([
      expect.objectContaining({ id: 'case-eunbyeol' }),
    ]);
    expect(formatRecallForPaneMessage(result)).toContain('Scoped case context for the Eunbyeol profile.');
  });

  test('suppresses bare case-scoped recall unless case recall is explicitly allowed', async () => {
    const broker = createMemoryBroker({
      providers: [
        {
          id: 'team',
          sourceKind: 'graph_team',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  id: 'generic-case-note',
                  title: 'Case note',
                  excerpt: 'A private case-scoped note.',
                  metadata: {
                    scopes: ['case'],
                  },
                },
              ],
            };
          },
        },
      ],
    });

    const mainResult = await broker.recall('case note', {
      windowKey: 'main',
      profileName: 'main',
    }, { limit: 5 });
    const allowedResult = await broker.recall('case note', {
      windowKey: 'main',
      profileName: 'main',
      allowCaseRecall: true,
    }, { limit: 5 });

    expect(mainResult.results).toEqual([]);
    expect(allowedResult.results).toEqual([
      expect.objectContaining({ id: 'generic-case-note' }),
    ]);
  });

  test('keeps non-case product recall about Eunbyeol profile routing visible to main', async () => {
    const broker = createMemoryBroker({
      providers: [
        {
          id: 'ledger',
          sourceKind: 'episodic_ledger',
          async recall() {
            return {
              ok: true,
              items: [
                {
                  id: 'profile-routing-product',
                  title: 'Eunbyeol profile routing bug',
                  excerpt: 'Product work: side-profile windows should not inherit main workspace tabs.',
                  ref: 'ui/modules/workspace-pane-shell.js',
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('Eunbyeol top tabs profile routing', {
      windowKey: 'main',
      profileName: 'main',
      sessionScopeId: 'app-session-384',
    }, { limit: 5 });

    expect(result.results).toEqual([
      expect.objectContaining({ id: 'profile-routing-product' }),
    ]);
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
    expect(prependRecallToMessage('Update me.', recall)).toMatch(/^Update me\.\n\n\[SQUIDRUN MEMORY RECALL\]/);
    expect(prependRecallToMessage(`${RECALL_START}\nold`, recall)).toBe(`${RECALL_START}\nold`);
  });

  test('keeps inbound message before capped recall context', () => {
    const inbound = '[Telegram from james]: this is the actual body that must not disappear behind memory recall';
    const recall = {
      ok: true,
      results: Array.from({ length: 8 }, (_, index) => ({
        rank: index + 1,
        sourceKind: 'vector_cognitive',
        title: `Very long memory title ${index} ${'x'.repeat(200)}`,
        excerpt: `Long recalled text ${index} ${'y'.repeat(800)}`,
        ref: `memory:${index}:${'z'.repeat(400)}`,
      })),
    };

    const injected = prependRecallToMessage(inbound, recall, {
      limit: 8,
      maxChars: 700,
    });

    expect(injected.startsWith(`${inbound}\n\n${RECALL_START}`)).toBe(true);
    expect(injected).toContain('memory recall capped');
    expect(injected).toContain('[/SQUIDRUN MEMORY RECALL]');
    const recallBlock = injected.slice(inbound.length + 2);
    expect(recallBlock.length).toBeLessThanOrEqual(700);
    expect(DEFAULT_RECALL_BLOCK_MAX_CHARS).toBeGreaterThan(700);
  });

  describe('recall gating (messageReferencesPastWork)', () => {
    test('trivial greetings/acks do NOT reference past work', () => {
      for (const msg of ['yo', 'what up bro', 'thanks', 'ok', 'lol', 'hey', '👍']) {
        expect(messageReferencesPastWork(msg)).toBe(false);
      }
    });

    test('short messages with a work-referencing token DO', () => {
      for (const msg of ['btc?', 'restart?', 'status', 'any update?', 'where are we']) {
        expect(messageReferencesPastWork(msg)).toBe(true);
      }
    });

    test('substantive messages (>= threshold) always qualify even without a keyword', () => {
      const longCasual = 'a'.repeat(MEMORY_RECALL_MIN_MESSAGE_LENGTH);
      expect(messageReferencesPastWork(longCasual)).toBe(true);
      expect(messageReferencesPastWork('x')).toBe(false);
    });

    test('prependRecallToMessage injects nothing for a trivial one-liner', () => {
      const recall = {
        ok: true,
        results: [{ rank: 1, sourceKind: 'vector_cognitive', title: 'Old', excerpt: 'stale session summary', ref: 'm:1' }],
      };
      // trivial -> returned unchanged, no recall block
      expect(prependRecallToMessage('what up bro', recall)).toBe('what up bro');
      expect(prependRecallToMessage('what up bro', recall)).not.toContain(RECALL_START);
      // work-referencing -> recall block injected
      expect(prependRecallToMessage('what is the trade status?', recall)).toContain(RECALL_START);
    });
  });
});
