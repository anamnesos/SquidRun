const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore } = require('../modules/team-memory/store');
const {
  RecallFeedbackService,
  HARD_SUPPRESSION_IGNORED_COUNT,
} = require('../modules/team-memory/recall-feedback');
const { buildRecallIdentityKey } = require('../modules/memory-recall');

describe('recall feedback service', () => {
  let tempDir = null;
  let store = null;
  let service = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-recall-feedback-'));
    store = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
    const initResult = store.init();
    expect(initResult.ok).toBe(true);
    service = new RecallFeedbackService({
      db: store.db,
    });
  });

  afterEach(() => {
    try { store?.close?.(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('promotes recall items that are actually used in the next outbound message', () => {
    const usedIdentity = buildRecallIdentityKey({
      store: 'memory_search',
      sourcePath: 'workspace/knowledge/trading.md',
      citation: 'doc-1',
      title: 'Hyperliquid stop plan',
      excerpt: 'Tighten stop loss on the BTC position after giveback.',
    });
    const unusedIdentity = buildRecallIdentityKey({
      store: 'memory_search',
      sourcePath: 'workspace/knowledge/customs.md',
      citation: 'doc-2',
      title: 'Customs packet',
      excerpt: 'Korean customs invoice trail and shipping label chain.',
    });

    expect(service.recordRecallSet({
      resultSetId: 'set-used',
      paneId: '1',
      agentRole: 'architect',
      channel: 'user',
      query: 'manage btc position',
      items: [
        {
          resultItemId: 'item-used',
          identityKey: usedIdentity,
          rankIndex: 0,
          store: 'memory_search',
          sourceRole: 'corpus',
          sourcePath: 'workspace/knowledge/trading.md',
          citation: 'doc-1',
          title: 'Hyperliquid stop plan',
          excerpt: 'Tighten stop loss on the BTC position after giveback.',
          score: 5,
          rankScore: 5,
        },
        {
          resultItemId: 'item-unused',
          identityKey: unusedIdentity,
          rankIndex: 1,
          store: 'memory_search',
          sourceRole: 'corpus',
          sourcePath: 'workspace/knowledge/customs.md',
          citation: 'doc-2',
          title: 'Customs packet',
          excerpt: 'Korean customs invoice trail and shipping label chain.',
          score: 3,
          rankScore: 3,
        },
      ],
    }).ok).toBe(true);

    const feedback = service.recordRecallFeedback({
      feedbackType: 'used',
      paneId: '1',
      agentRole: 'architect',
      messageText: 'We should tighten the Hyperliquid stop loss on the BTC position now.',
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.resultSetId).toBe('set-used');
    expect(feedback.matchedCount).toBe(1);

    const adjustments = service.getRankAdjustments({
      identityKeys: [usedIdentity, unusedIdentity],
    });
    expect(adjustments.ok).toBe(true);
    expect(adjustments.adjustments[usedIdentity]).toBeGreaterThan(0);
    expect(adjustments.adjustments[unusedIdentity] || 0).toBe(0);
  });

  test('suppresses unresolved recall sets when a newer set supersedes them', () => {
    const oldIdentity = buildRecallIdentityKey({
      store: 'team_memory',
      sourcePath: 'team-memory/claims',
      citation: 'claim-old',
      title: 'Old recall',
      excerpt: 'This stale recall should be ignored after the next set arrives.',
    });

    expect(service.recordRecallSet({
      resultSetId: 'set-old',
      paneId: '1',
      agentRole: 'architect',
      channel: 'telegram',
      query: 'old recall',
      items: [{
        resultItemId: 'item-old',
        identityKey: oldIdentity,
        rankIndex: 0,
        store: 'team_memory',
        sourceRole: 'structured',
        sourcePath: 'team-memory/claims',
        citation: 'claim-old',
        title: 'Old recall',
        excerpt: 'This stale recall should be ignored after the next set arrives.',
        score: 2,
        rankScore: 2,
      }],
    }).ok).toBe(true);

    expect(service.recordRecallSet({
      resultSetId: 'set-new',
      paneId: '1',
      agentRole: 'architect',
      channel: 'telegram',
      query: 'new recall',
      items: [{
        resultItemId: 'item-new',
        identityKey: buildRecallIdentityKey({
          store: 'team_memory',
          sourcePath: 'team-memory/claims',
          citation: 'claim-new',
          title: 'New recall',
          excerpt: 'Fresher recall context.',
        }),
        rankIndex: 0,
        store: 'team_memory',
        sourceRole: 'structured',
        sourcePath: 'team-memory/claims',
        citation: 'claim-new',
        title: 'New recall',
        excerpt: 'Fresher recall context.',
        score: 4,
        rankScore: 4,
      }],
    }).ok).toBe(true);

    const oldSet = store.db.prepare(`
      SELECT status, outcome_reason
      FROM memory_recall_sets
      WHERE result_set_id = ?
    `).get('set-old');
    expect(oldSet.status).toBe('ignored');
    expect(oldSet.outcome_reason).toBe('superseded_by_next_recall');

    const adjustments = service.getRankAdjustments({
      identityKeys: [oldIdentity],
    });
    expect(adjustments.adjustments[oldIdentity]).toBeLessThan(0);
  });

  test('applies strong negative feedback when a user correction signal arrives', () => {
    const firstIdentity = buildRecallIdentityKey({
      store: 'evidence_ledger',
      sourcePath: 'evidence-ledger/comms_journal',
      citation: 'msg-1',
      title: 'Telegram note',
      excerpt: 'Hillstate customs packet summary.',
    });
    const secondIdentity = buildRecallIdentityKey({
      store: 'memory_search',
      sourcePath: 'workspace/cases/korean-fraud/statement.txt',
      citation: 'doc-3',
      title: 'Statement draft',
      excerpt: 'Shipping label and invoice trail.',
    });

    expect(service.recordRecallSet({
      resultSetId: 'set-missing',
      paneId: '1',
      agentRole: 'architect',
      channel: 'user_prompt',
      query: 'customs statement',
      items: [
        {
          resultItemId: 'item-a',
          identityKey: firstIdentity,
          rankIndex: 0,
          store: 'evidence_ledger',
          sourceRole: 'episodic',
          sourcePath: 'evidence-ledger/comms_journal',
          citation: 'msg-1',
          title: 'Telegram note',
          excerpt: 'Hillstate customs packet summary.',
          score: 2,
          rankScore: 2,
        },
        {
          resultItemId: 'item-b',
          identityKey: secondIdentity,
          rankIndex: 1,
          store: 'memory_search',
          sourceRole: 'corpus',
          sourcePath: 'workspace/cases/korean-fraud/statement.txt',
          citation: 'doc-3',
          title: 'Statement draft',
          excerpt: 'Shipping label and invoice trail.',
          score: 2,
          rankScore: 2,
        },
      ],
    }).ok).toBe(true);

    const feedback = service.recordRecallFeedback({
      feedbackType: 'missing',
      paneId: '1',
      agentRole: 'architect',
      channel: 'user_prompt',
      messageText: 'I already told you this about the shipping label and invoice trail.',
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.resultSetId).toBe('set-missing');
    expect(feedback.matchedCount).toBe(2);

    const setRow = store.db.prepare(`
      SELECT status
      FROM memory_recall_sets
      WHERE result_set_id = ?
    `).get('set-missing');
    expect(setRow.status).toBe('missing');

    const adjustments = service.getRankAdjustments({
      identityKeys: [firstIdentity, secondIdentity],
    });
    expect(adjustments.adjustments[firstIdentity]).toBeLessThan(0);
    expect(adjustments.adjustments[secondIdentity]).toBeLessThan(0);
  });

  test('hard-suppresses recall identities ignored 50 or more times', () => {
    const ignoredIdentity = buildRecallIdentityKey({
      store: 'evidence_ledger',
      sourcePath: 'evidence-ledger/comms_journal',
      citation: 'ignored-1',
      title: 'Chronically ignored recall',
      excerpt: 'This should never surface again.',
    });

    store.db.prepare(`
      INSERT INTO memory_recall_profiles (
        identity_key,
        used_count,
        ignored_count,
        missing_count,
        last_used_at,
        last_ignored_at,
        last_missing_at,
        updated_at
      ) VALUES (?, 0, ?, 0, NULL, ?, NULL, ?)
    `).run(
      ignoredIdentity,
      HARD_SUPPRESSION_IGNORED_COUNT,
      Date.now(),
      Date.now()
    );

    const adjustments = service.getRankAdjustments({
      identityKeys: [ignoredIdentity],
    });

    expect(adjustments.ok).toBe(true);
    expect(adjustments.suppressedIdentityKeys).toContain(ignoredIdentity);
  });
});
