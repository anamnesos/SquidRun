const {
  DEFAULT_RECALL_BLOCK_MAX_CHARS,
  RECALL_START,
  MEMORY_RECALL_MIN_MESSAGE_LENGTH,
  createMemoryBroker,
  createCognitiveMemoryProvider,
  formatRecallForPaneMessage,
  prependRecallToMessage,
  messageReferencesPastWork,
} = require('../modules/memory-broker');

describe('memory-broker', () => {
  test('cognitive provider drops archival session-summary rollups from recall', async () => {
    const provider = createCognitiveMemoryProvider({
      execute: async () => ({
        ok: true,
        results: [
          {
            nodeId: 'node-session-412',
            title: 'Session 412 Summary',
            content: '# Session 412 Summary - Generated: 2026-06-08 - Total messages: 45 - Participants: architect (21)',
            sourcePath: 'session:412',
            score: 0.9,
          },
          {
            nodeId: 'node-real-memory',
            title: 'Lemonade claim state',
            content: 'Claim LPP98-462-798 cleared pre-existing review.',
            sourcePath: 'memory/claims.md',
            score: 0.5,
          },
          {
            nodeId: 'node-session-typed',
            title: 'Rollup',
            content: 'archival rollup by source type',
            sourceType: 'session_summary',
            score: 0.8,
          },
          {
            nodeId: 'node-corpus-transcript',
            title: 'Switchboard MS98 sw2060 Interleaved Transcript',
            content: '68.494-79.217 B: [silence] 71.005-76.635 A: a discussion about that',
            sourcePath: 'knowledge/emotion/spoken/switchboard-ms98/sw2060-interleaved.md',
            score: 0.85,
          },
        ],
      }),
    });
    const result = await provider.recall('claim status', {}, {});
    expect(result.ok).toBe(true);
    const ids = result.items.map((item) => item.id);
    expect(ids).toEqual(['node-real-memory']);
  });

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

  test('suppresses sideprofile and Korean case recall in a non-case main lane', async () => {
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
                  id: 'case-sideprofile',
                  title: 'sideprofile Korean case',
                  excerpt: 'Old Korean fraud case context for sideprofile should not leak into this lane.',
                  ref: 'context-snapshots-sideprofile/1.md',
                  score: 10,
                  metadata: {
                    profileName: 'sideprofile',
                    sessionScopeId: 'app-test:sideprofile',
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

    const result = await broker.recall('sideprofile top tabs confused James', {
      windowKey: 'main',
      profileName: 'main',
      sessionScopeId: 'app-session-384',
      laneKind: 'ui_tabs_profile_isolation',
    }, { limit: 5 });

    expect(result.ok).toBe(true);
    expect(result.results.map((item) => item.id)).toEqual(['main-tabs']);
    expect(formatRecallForPaneMessage(result)).not.toMatch(/sideprofile|Korean fraud|context-snapshots-sideprofile/i);
  });

  test('allows sideprofile profile recall when the context explicitly targets sideprofile', async () => {
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
                  id: 'case-sideprofile',
                  title: 'sideprofile Korean case',
                  excerpt: 'Scoped case context for the sideprofile profile.',
                  ref: 'context-snapshots-sideprofile/1.md',
                  metadata: {
                    scopes: ['profile:sideprofile'],
                  },
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('sideprofile case status', {
      windowKey: 'sideprofile',
      profileName: 'sideprofile',
      sessionScopeId: 'app-test:sideprofile',
    }, { limit: 5 });

    expect(result.results).toEqual([
      expect.objectContaining({ id: 'case-sideprofile' }),
    ]);
    expect(formatRecallForPaneMessage(result)).toContain('Scoped case context for the sideprofile profile.');
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

  test('keeps non-case product recall about sideprofile profile routing visible to main', async () => {
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
                  title: 'sideprofile profile routing bug',
                  excerpt: 'Product work: side-profile windows should not inherit main workspace tabs.',
                  ref: 'ui/modules/workspace-pane-shell.js',
                },
              ],
            };
          },
        },
      ],
    });

    const result = await broker.recall('sideprofile top tabs profile routing', {
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
