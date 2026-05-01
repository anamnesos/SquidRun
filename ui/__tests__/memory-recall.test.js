const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SCOPED_PROFILE_BOOST_TERMS,
  closeSharedRecallRuntime,
  persistRecallAudit,
  buildTimeAwareness,
  buildMessageWithRecall,
  buildRecallQueryFromMessage,
  formatRecallForInjection,
  recall,
  stripRecallBlocks,
} = require('../modules/memory-recall');

describe('memory recall broker', () => {
  afterEach(() => {
    closeSharedRecallRuntime();
  });

  test('boosts the user direct terminal input with trading and architecture memory terms', () => {
    const query = buildRecallQueryFromMessage('Should we manage the open [private-live-ops] position now?', {
      channel: 'user_prompt',
      userIdentity: 'james',
      assumethe userDirectInput: true,
    });

    expect(query.toLowerCase()).toContain('[private-live-ops]');
    expect(query.toLowerCase()).toContain('positions');
    expect(query.toLowerCase()).toContain('pnl');
    expect(query.toLowerCase()).toContain('squidrun');
    expect(query.toLowerCase()).toContain('feedback history');
    expect(query.toLowerCase()).toContain('agent conversations');
  });

  test('boosts scoped profile entities for Scoped Telegram chat', () => {
    const query = buildRecallQueryFromMessage('Can you check the evidence statement and ExampleProperty docs?', {
      channel: 'telegram',
      chatId: '2222222222',
      sender: 'Scoped',
    });

    expect(query).toContain('evidence');
    expect(query).toContain('ExampleProperty');
    for (const term of SCOPED_PROFILE_BOOST_TERMS) {
      expect(query.toLowerCase()).toContain(term.toLowerCase());
    }
  });

  test('persists audit and merges stubbed backends', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-recall-'));
    const auditPath = path.join(tempDir, 'memory-recall-audit.jsonl');
    const result = await recall({
      query: 'LINK short Scoped evidence',
      auditPath,
      feedbackOps: {
        getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
        recordRecallSet: jest.fn(() => ({ ok: true })),
        recordRecallFeedback: jest.fn(() => ({ ok: true })),
      },
      backends: {
        queryEvidenceLedger: () => [{
          id: 'ledger-1',
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          title: 'Telegram message',
          excerpt: 'Scoped asked about evidence evidence and LINK.',
          sourcePath: 'evidence-ledger/comms_journal',
          score: 5,
        }],
        queryTeamMemoryClaims: () => [{
          id: 'claim-1',
          store: 'team_memory',
          sourceRole: 'structured',
          title: 'Claim',
          excerpt: 'the user wants real runtime proof, not theory.',
          sourcePath: 'team-memory/claims',
          score: 3,
        }],
        queryTeamMemorySurfaced: () => [],
        queryTeamMemoryHandoffs: () => [],
        queryMemorySearch: async () => [{
          id: 'search-1',
          store: 'memory_search',
          sourceRole: 'corpus',
          title: 'Case evidence',
          excerpt: 'ExampleProperty evidence packet references evidence filing.',
          sourcePath: 'Example Case/evidence/statement.txt',
          score: 2,
        }],
        queryCognitiveMemory: async () => [{
          id: 'cog-1',
          store: 'cognitive_memory',
          sourceRole: 'derived_semantic',
          title: 'Cognitive',
          excerpt: 'Derived summary of evidence packet and payment trail.',
          sourcePath: 'workspace/memory/cognitive-memory.db',
          score: 1,
        }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(result.items[0].store).toBe('evidence_ledger');
    expect(result.items[0].resultItemId).toMatch(/^recall-item-/);
    expect(result.items[0].identityKey).toHaveLength(40);
    const auditLine = fs.readFileSync(auditPath, 'utf8').trim();
    expect(auditLine).toContain(result.resultSetId);
    expect(auditLine).toContain('evidence_ledger');
    expect(auditLine).toContain('resultItemId');
  });

  test('builds delivery-only recall block and can strip it back out', async () => {
    const delivery = await buildMessageWithRecall('Original human message', {
      query: 'Original human message',
      auditPath: path.join(os.tmpdir(), `squidrun-recall-${Date.now()}.jsonl`),
      feedbackOps: {
        getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
        recordRecallSet: jest.fn(() => ({ ok: true })),
        recordRecallFeedback: jest.fn(() => ({ ok: true, skipped: true })),
      },
      backends: {
        queryEvidenceLedger: () => [{
          id: 'ledger-1',
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          title: 'Telegram message',
          excerpt: 'Original note from the evidence ledger.',
          sourcePath: 'evidence-ledger/comms_journal',
          score: 2,
        }],
        queryTeamMemoryClaims: () => [],
        queryTeamMemorySurfaced: () => [],
        queryTeamMemoryHandoffs: () => [],
        queryMemorySearch: async () => [],
        queryCognitiveMemory: async () => [],
      },
    });

    expect(delivery.message).toContain('Original human message');
    expect(delivery.message).toContain('[SQUIDRUN RECALL START]');
    expect(formatRecallForInjection(delivery.result)).toContain(delivery.result.resultSetId);
    expect(formatRecallForInjection(delivery.result)).toContain('resultId=');
    expect(stripRecallBlocks(delivery.message)).toBe('Original human message');
  });

  test('extends recall with existing time-awareness context for session, consultation, and monitor', async () => {
    const nowMs = Date.parse('2026-04-03T23:40:00.000Z');
    const result = await recall({
      query: 'check runtime freshness',
      nowMs,
      appStatus: {
        started: '2026-03-31T05:49:46.608Z',
      },
      supervisorStatus: {
        cryptoTradingAutomation: {
          lastProcessedAt: '2026-04-03T23:00:00.000Z',
        },
        [private-live-ops]PositionMonitor: {
          lastSummary: {
            checkedAt: '2026-04-03T23:31:43.646Z',
          },
        },
      },
      commsRows: [],
      feedbackOps: {
        getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
        recordRecallSet: jest.fn(() => ({ ok: true })),
        recordRecallFeedback: jest.fn(() => ({ ok: true })),
      },
      backends: {
        queryEvidenceLedger: () => [],
        queryTeamMemoryClaims: () => [],
        queryTeamMemorySurfaced: () => [],
        queryTeamMemoryHandoffs: () => [],
        queryMemorySearch: async () => [],
        queryCognitiveMemory: async () => [],
      },
    });

    const block = formatRecallForInjection(result);
    expect(block).toContain('TIME AWARENESS');
    expect(block).toContain('Session duration:');
    expect(block).toContain('Last consultation: 40m 0s ago');
    expect(block).toContain('Last [private-live-ops] check: 8m 16s ago');
  });

  test('can render a compact injection block with time awareness and only 3 short recall items', () => {
    const compact = formatRecallForInjection({
      resultSetId: 'recall-compact-1',
      query: 'ignored in compact mode',
      timeAwareness: {
        lines: [
          'Last consultation: 3h 42m ago',
          'Session duration: 16h 0m',
        ],
      },
      items: [
        { store: 'team_memory', excerpt: 'This is a very long excerpt that should be trimmed well below its original length for compact display.' },
        { store: 'memory_search', excerpt: 'Second long excerpt that should also be shortened in compact mode for the user.' },
        { store: 'evidence_ledger', excerpt: 'Third long excerpt that should still fit in the compact block output cleanly.' },
        { store: 'cognitive_memory', excerpt: 'Fourth item should be omitted because compact mode only keeps three results.' },
      ],
    }, {
      header: 'DIRECT PROMPT RECALL',
      compact: true,
      maxItems: 3,
      excerptLimit: 50,
    });

    expect(compact).toContain('DIRECT PROMPT RECALL');
    expect(compact).toContain('TIME AWARENESS');
    expect(compact).toContain('1. [team_memory]');
    expect(compact).toContain('2. [memory_search]');
    expect(compact).toContain('3. [evidence_ledger]');
    expect(compact).not.toContain('4. [cognitive_memory]');
    expect(compact).not.toContain('query=');
    expect(compact).not.toContain('resultSetId=');
  });

  test('adds Scoped-specific elapsed-time context when scoped-profile recall is active', () => {
    const nowMs = Date.parse('2026-04-03T23:40:00.000Z');
    const timeAwareness = buildTimeAwareness({
      nowMs,
      message: 'Please review Scoped evidence evidence.',
      channel: 'telegram',
      chatId: '2222222222',
      commsRows: [{
        rawBody: 'Scoped sent updated evidence files',
        sentAtMs: Date.parse('2026-04-03T16:29:00.000Z'),
        metadata: {
          chatId: '2222222222',
          from: 'Scoped',
        },
      }],
      appStatus: {},
      supervisorStatus: {},
    });

    expect(timeAwareness.lines.join('\n')).toContain('Last Scoped message: 7h 11m ago (KST 01:29)');
  });

  test('returns partial results when a backend times out instead of freezing recall', async () => {
    const result = await recall({
      query: 'LINK runtime status',
      recallTimeoutMs: 25,
      feedbackOps: {
        getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
        recordRecallSet: jest.fn(() => ({ ok: true })),
        recordRecallFeedback: jest.fn(() => ({ ok: true })),
      },
      backends: {
        queryEvidenceLedger: () => [{
          id: 'ledger-timeout-1',
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          title: 'Fast ledger hit',
          excerpt: 'LINK runtime message',
          sourcePath: 'evidence-ledger/comms_journal',
          score: 4,
        }],
        queryTeamMemoryClaims: () => [],
        queryTeamMemorySurfaced: () => [],
        queryTeamMemoryHandoffs: () => [],
        queryMemorySearch: () => new Promise(() => {}),
        queryCognitiveMemory: async () => [],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.items).toEqual([
      expect.objectContaining({
        store: 'evidence_ledger',
        title: 'Fast ledger hit',
      }),
    ]);
    expect(result.backendStatus).toEqual(expect.objectContaining({
      evidenceLedger: expect.objectContaining({
        ok: true,
        timedOut: false,
        count: 1,
      }),
      memorySearch: expect.objectContaining({
        ok: false,
        timedOut: true,
        error: 'memorySearch_timeout',
      }),
    }));
  });

  test('hard-filters recall identities that have been ignored 50 or more times', async () => {
    const suppressedIdentityKey = 'identity-suppressed-1';
    const visibleIdentityKey = 'identity-visible-1';
    const result = await recall({
      query: 'filter ignored recall noise',
      feedbackOps: {
        getRankAdjustments: jest.fn(() => ({
          ok: true,
          adjustments: {
            [suppressedIdentityKey]: -2,
            [visibleIdentityKey]: 0,
          },
          suppressedIdentityKeys: [suppressedIdentityKey],
        })),
        recordRecallSet: jest.fn(() => ({ ok: true })),
        recordRecallFeedback: jest.fn(() => ({ ok: true })),
      },
      backends: {
        queryEvidenceLedger: () => [{
          id: 'suppressed-ledger-hit',
          identityKey: suppressedIdentityKey,
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          title: 'Suppressed recall',
          excerpt: 'This item should be removed before delivery.',
          sourcePath: 'evidence-ledger/comms_journal',
          score: 5,
        }],
        queryTeamMemoryClaims: () => [{
          id: 'visible-claim-hit',
          identityKey: visibleIdentityKey,
          store: 'team_memory',
          sourceRole: 'structured',
          title: 'Visible recall',
          excerpt: 'This item is still allowed to surface.',
          sourcePath: 'team-memory/claims',
          score: 4,
        }],
        queryTeamMemorySurfaced: () => [],
        queryTeamMemoryHandoffs: () => [],
        queryMemorySearch: async () => [],
        queryCognitiveMemory: async () => [],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([
      expect.objectContaining({
        identityKey: visibleIdentityKey,
        title: 'Visible recall',
      }),
    ]);
  });

  test('rotates recall audit jsonl when it exceeds the configured size cap', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-recall-rotate-'));
    const auditPath = path.join(tempDir, 'memory-recall-audit.jsonl');

    await persistRecallAudit({
      resultSetId: 'recall-first',
      items: Array.from({ length: 8 }, (_, index) => ({ id: `item-${index}`, text: 'x'.repeat(400) })),
    }, {
      auditPath,
      auditMaxBytes: 1024,
    });

    await persistRecallAudit({
      resultSetId: 'recall-second',
      items: [{ id: 'item-second', text: 'y'.repeat(12) }],
    }, {
      auditPath,
      auditMaxBytes: 1024,
    });

    const currentAudit = fs.readFileSync(auditPath, 'utf8');
    const rotatedAudit = fs.readFileSync(`${auditPath}.old`, 'utf8');

    expect(rotatedAudit).toContain('recall-first');
    expect(currentAudit).toContain('recall-second');
    expect(currentAudit).not.toContain('recall-first');
  });

  test('serializes recall for the same pane so overlapping requests do not race each other', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const delayedLedgerQuery = () => new Promise((resolve) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        resolve([{
          id: `ledger-lock-${Date.now()}`,
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          title: 'Serialized ledger hit',
          excerpt: 'Pane lock check',
          sourcePath: 'evidence-ledger/comms_journal',
          score: 3,
        }]);
      }, 30);
    });

    await Promise.all([
      recall({
        paneId: '2',
        query: 'first overlapping recall',
        recallTimeoutMs: 200,
        feedbackOps: {
          getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
          recordRecallSet: jest.fn(() => ({ ok: true })),
          recordRecallFeedback: jest.fn(() => ({ ok: true })),
        },
        backends: {
          queryEvidenceLedger: delayedLedgerQuery,
          queryTeamMemoryClaims: () => [],
          queryTeamMemorySurfaced: () => [],
          queryTeamMemoryHandoffs: () => [],
          queryMemorySearch: async () => [],
          queryCognitiveMemory: async () => [],
        },
      }),
      recall({
        paneId: '2',
        query: 'second overlapping recall',
        recallTimeoutMs: 200,
        feedbackOps: {
          getRankAdjustments: jest.fn(() => ({ ok: true, adjustments: {} })),
          recordRecallSet: jest.fn(() => ({ ok: true })),
          recordRecallFeedback: jest.fn(() => ({ ok: true })),
        },
        backends: {
          queryEvidenceLedger: delayedLedgerQuery,
          queryTeamMemoryClaims: () => [],
          queryTeamMemorySurfaced: () => [],
          queryTeamMemoryHandoffs: () => [],
          queryMemorySearch: async () => [],
          queryCognitiveMemory: async () => [],
        },
      }),
    ]);

    expect(maxInFlight).toBe(1);
  });
});
