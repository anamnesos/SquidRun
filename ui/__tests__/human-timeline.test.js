const timeline = require('../modules/main/human-timeline');

describe('human-timeline snapshot', () => {
  test('renders approved cached human headlines for commits and task-audit needs', () => {
    const nowMs = Date.parse('2026-06-14T08:00:00.000Z');
    const commit = {
      sha: 'abc1234',
      atMs: Date.parse('2026-06-14T07:30:00.000Z'),
      subject: 'Harden split release launchers against Telegram env leaks',
    };
    const taskItem = {
      id: 'surface-claim-guard-state-verb-gap-404',
      title: 'Surface-claim guard: present-tense state verbs pass the claim check',
      status: 'pending_james_go',
      nextAction: 'James decides whether this gap matters now.',
      updatedAt: '2026-06-14T07:40:00.000Z',
      sessionId: 'app-session-444',
    };
    const headlineCache = {
      entries: {
        'git_commit:abc1234': {
          status: 'approved',
          sourceHash: 'wrong-hash',
          headline: 'This stale line must not render.',
        },
      },
    };
    const cacheModule = require('../modules/main/human-timeline-headline-cache');
    const approvedCommit = cacheModule.approveHeadlineCandidate(
      cacheModule.sourceFromCommit(commit),
      'The team made the separate app launches safer.',
      { headlineCache, write: false, nowMs }
    );
    expect(approvedCommit.ok).toBe(true);
    const approvedTask = cacheModule.approveHeadlineCandidate(
      cacheModule.sourceFromTaskAuditItem(taskItem),
      'James needs to decide whether that claim-check gap matters now.',
      { headlineCache: approvedCommit.cache, write: false, nowMs }
    );
    expect(approvedTask.ok).toBe(true);

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs,
      queryCommsJournalEntries: jest.fn(() => []),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [taskItem] })),
      queryGitCommits: jest.fn(() => [commit]),
      headlineCache: approvedTask.cache,
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.feed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'change',
        headline: 'The team made the separate app launches safer.',
        refs: expect.objectContaining({ headlineSourceKey: 'git_commit:abc1234' }),
      }),
    ]));
    expect(snapshot.needsYou.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headline: 'James needs to decide whether that claim-check gap matters now.',
        refs: expect.objectContaining({
          headlineSourceKey: 'task_audit_item:surface-claim-guard-state-verb-gap-404',
        }),
      }),
    ]));
  });

  test('collects raw headline sources for commits and pending task-audit items', () => {
    const sources = timeline.collectHumanTimelineHeadlineSources({
      nowMs: Date.parse('2026-06-14T08:00:00.000Z'),
      queryGitCommits: jest.fn(() => [
        {
          sha: 'abc1234',
          atMs: Date.parse('2026-06-14T07:30:00.000Z'),
          subject: 'Remove hardcoded main Telegram chat fallback',
        },
      ]),
      readTaskAuditItems: jest.fn(() => ({
        ok: true,
        status: 'OK',
        items: [
          {
            id: 'task-needs-james',
            title: 'Phase 3 needs James go-ahead',
            status: 'pending_james_go',
            nextAction: 'James chooses whether to start the next phase.',
          },
          {
            id: 'task-resolved',
            title: 'Resolved item',
            status: 'resolved',
          },
        ],
      })),
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'git_commit',
        id: 'abc1234',
        sourceText: 'Remove hardcoded main Telegram chat fallback',
      }),
      expect.objectContaining({
        kind: 'task_audit_item',
        id: 'task-needs-james',
        sourceText: expect.stringContaining('Phase 3 needs James go-ahead'),
      }),
    ]));
    expect(sources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-resolved' }),
    ]));
  });

  test('defaults to a rolling 24-hour window instead of local midnight', () => {
    const nowMs = Date.parse('2026-06-14T07:01:00.000Z');
    const expectedSinceMs = nowMs - (24 * 60 * 60 * 1000);
    const expectedTelegramSinceMs = nowMs - (12 * 60 * 60 * 1000);
    const queryCommsJournalEntries = jest.fn(() => []);
    const queryTelegramReplyObligations = jest.fn(() => []);
    const queryGitCommits = jest.fn(() => []);

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs,
      queryCommsJournalEntries,
      queryTelegramReplyObligations,
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits,
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.window).toEqual(expect.objectContaining({
      label: 'Today',
      mode: 'rolling_24h',
      since: new Date(expectedSinceMs).toISOString(),
      until: new Date(nowMs).toISOString(),
    }));
    expect(queryCommsJournalEntries).toHaveBeenCalledWith(expect.objectContaining({
      sinceMs: expectedSinceMs,
      untilMs: nowMs,
    }), expect.any(Object));
    expect(queryTelegramReplyObligations).toHaveBeenCalledWith(expect.objectContaining({
      sinceMs: expectedTelegramSinceMs,
      untilMs: nowMs,
    }), expect.any(Object));
    expect(queryGitCommits).toHaveBeenCalledWith(expect.objectContaining({
      sinceMs: expectedSinceMs,
      untilMs: nowMs,
    }));
  });

  test('builds a read-only today feed with collapsed team arcs and no raw agent jargon', () => {
    const rows = [
      {
        rowId: 1,
        messageId: 'telegram-in-1',
        sessionId: 'app-session-444',
        senderRole: 'user',
        targetRole: 'architect',
        channel: 'telegram',
        direction: 'inbound',
        status: 'brokered',
        brokeredAtMs: Date.parse('2026-06-12T16:05:00.000Z'),
        rawBody: 'Can you tell me what happened?',
      },
      {
        rowId: 2,
        messageId: 'hm-arc-1',
        sessionId: 'app-session-444',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        brokeredAtMs: Date.parse('2026-06-12T16:10:00.000Z'),
        rawBody: '(BUILDER #7): I found the timeline issue.',
      },
      {
        rowId: 3,
        messageId: 'hm-arc-2',
        sessionId: 'app-session-444',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        brokeredAtMs: Date.parse('2026-06-12T16:12:00.000Z'),
        rawBody: '(BUILDER #8): Patch is in place.',
      },
      {
        rowId: 4,
        messageId: 'hm-arc-3',
        sessionId: 'app-session-444',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        brokeredAtMs: Date.parse('2026-06-12T16:15:00.000Z'),
        rawBody: '(BUILDER #9): Timeline surface fixed and tests passed green.',
      },
      {
        rowId: 5,
        messageId: 'hm-user-reply',
        sessionId: 'app-session-444',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:20:00.000Z'),
        rawBody: 'Here is what the team did today.',
      },
      {
        rowId: 6,
        messageId: 'hm-ask-james',
        sessionId: 'app-session-444',
        senderRole: 'oracle',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'routed',
        brokeredAtMs: Date.parse('2026-06-12T16:25:00.000Z'),
        rawBody: 'Do you approve deleting the old sidecar?',
      },
      {
        rowId: 7,
        messageId: 'hm-foreign',
        sessionId: 'app-session-446',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        brokeredAtMs: Date.parse('2026-06-12T16:26:00.000Z'),
        rawBody: '(BUILDER #1): Foreign window update passed.',
        metadata: {
          routing: {
            profileName: 'eunbyeol',
            windowKey: 'eunbyeol',
          },
        },
      },
      {
        rowId: 8,
        messageId: 'hm-local-historical-session',
        sessionId: 'app-session-446',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:27:00.000Z'),
        rawBody: 'Local provenance beats a historical session id.',
        metadata: { threadId: 'historical-local-session' },
      },
    ];

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      sessionId: 'app-session-444',
      queryCommsJournalEntries: jest.fn(() => rows),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot).toEqual(expect.objectContaining({
      ok: true,
      schema: timeline.SNAPSHOT_SCHEMA,
      session: { id: 'app-session-444', number: 444 },
      sources: expect.objectContaining({ readOnly: true }),
    }));
    expect(snapshot.feed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'team',
        headline: 'The team finished a check successfully.',
        detail: 'Timeline surface fixed and tests passed green.',
        refs: expect.objectContaining({ kind: 'comms_journal_arc', terminalRowId: 4 }),
      }),
      expect.objectContaining({
        kind: 'you',
        headline: 'Here is what the team did today.',
      }),
      expect.objectContaining({
        kind: 'you',
        headline: 'Local provenance beats a historical session id.',
      }),
    ]));
    expect(snapshot.feed.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ refs: expect.objectContaining({ commsRowId: 2 }) }),
      expect.objectContaining({ refs: expect.objectContaining({ commsRowId: 3 }) }),
      expect.objectContaining({ refs: expect.objectContaining({ commsRowId: 7 }) }),
    ]));
    expect(snapshot.needsYou.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headline: 'Your input is needed.',
        detail: 'Do you approve deleting the old side window?',
        refs: expect.objectContaining({ commsRowId: 6 }),
      }),
    ]));
    expect(snapshot.footer.excludedForeignCount).toBe(1);
    const renderedText = snapshot.feed.items
      .flatMap((item) => [item.headline, item.detail])
      .join(' ');
    expect(renderedText).not.toMatch(/BUILDER #9|senderRole|ackStatus|targetRole|\bpane\b|\bHEAD\b|trigger|verdict|[a-f0-9]{40}/i);
  });

  test('caps needs-you at five and includes Telegram obligations plus task-audit items', () => {
    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      queryCommsJournalEntries: jest.fn(() => []),
      queryTelegramReplyObligations: jest.fn(() => Array.from({ length: 4 }, (_, index) => ({
        obligationId: `obl-${index + 1}`,
        inboundMessageId: `telegram-in-${index + 1}`,
        sessionId: 'app-session-444',
        openedAtMs: Date.parse(`2026-06-12T16:3${index}:00.000Z`),
      }))),
      readTaskAuditItems: jest.fn(() => ({
        ok: true,
        status: 'OK',
        items: [
          {
            id: 'task-1',
            title: 'Phase 3 needs James go-ahead',
            status: 'pending_james_go',
            nextAction: 'James decides when to start Phase 3.',
            updatedAt: '2026-06-12T16:50:00.000Z',
            sessionId: 'app-session-444',
          },
          {
            id: 'task-2',
            title: 'Manual verification required',
            status: 'needs_james_verification',
            nextAction: 'James checks the visible window.',
            updatedAt: '2026-06-12T16:45:00.000Z',
            sessionId: 'app-session-444',
          },
          {
            id: 'task-foreign',
            title: 'Foreign window needs James input',
            status: 'pending_james_go',
            nextAction: 'James checks another install.',
            updatedAt: '2026-06-12T16:55:00.000Z',
            sessionId: 'app-session-446',
            profile: 'eunbyeol',
          },
        ],
      })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toHaveLength(5);
    expect(snapshot.needsYou.overflowCount).toBe(1);
    expect(snapshot.footer.excludedForeignCount).toBe(1);
    expect(snapshot.needsYou.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headline: 'A Telegram reply is waiting.',
        refs: expect.objectContaining({ kind: 'telegram_reply_obligation' }),
      }),
      expect.objectContaining({
        headline: 'Phase 3 needs James go-ahead',
        refs: expect.objectContaining({ kind: 'task_audit_item', itemId: 'task-1' }),
      }),
    ]));
  });

  test('does not surface stale open Telegram reply obligations as current needs', () => {
    const nowMs = Date.parse('2026-06-12T17:00:00.000Z');
    const queryTelegramReplyObligations = jest.fn(() => [
      {
        obligationId: 'fresh-obl',
        inboundMessageId: 'fresh-in',
        sessionId: 'app-session-444',
        openedAtMs: Date.parse('2026-06-12T16:00:00.000Z'),
      },
      {
        obligationId: 'stale-obl',
        inboundMessageId: 'stale-in',
        sessionId: 'app-session-444',
        openedAtMs: Date.parse('2026-06-11T16:00:00.000Z'),
      },
    ]);

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs,
      queryCommsJournalEntries: jest.fn(() => []),
      queryTelegramReplyObligations,
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(queryTelegramReplyObligations).toHaveBeenCalledWith(expect.objectContaining({
      sinceMs: Date.parse('2026-06-12T05:00:00.000Z'),
      untilMs: nowMs,
    }), expect.any(Object));
    expect(snapshot.needsYou.items).toEqual([
      expect.objectContaining({
        refs: expect.objectContaining({
          kind: 'telegram_reply_obligation',
          obligationId: 'fresh-obl',
        }),
      }),
    ]);
    expect(snapshot.sources.telegramReplyObligationsVisibleHours).toBe(12);
    expect(snapshot.sources.telegramReplyObligationsExcludedStaleCount).toBe(1);
  });

  test('does not render implicit needs-you asks from prior sessions', () => {
    const rows = [
      {
        rowId: 10,
        messageId: 'old-ask',
        sessionId: 'app-session-444',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T15:00:00.000Z'),
        rawBody: 'James, do you approve the old session cleanup?',
      },
      {
        rowId: 11,
        messageId: 'current-ask',
        sessionId: 'app-session-445',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:00:00.000Z'),
        rawBody: 'James, do you approve the current session cleanup?',
      },
    ];

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      sessionId: 'app-session-445',
      queryCommsJournalEntries: jest.fn(() => rows),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toEqual([
      expect.objectContaining({
        refs: expect.objectContaining({ commsRowId: 11 }),
        detail: 'James, do you approve the current session cleanup?',
      }),
    ]);
  });

  test('renders persistent task-audit needs across sessions', () => {
    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      sessionId: 'app-session-445',
      queryCommsJournalEntries: jest.fn(() => []),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({
        ok: true,
        status: 'OK',
        items: [
          {
            id: 'trustquote-phase-3',
            title: 'TrustQuote phase 3 needs James go-ahead',
            status: 'pending_james_go',
            nextAction: 'James decides when to start the next TrustQuote product phase.',
            updatedAt: '2026-06-12T15:00:00.000Z',
            sessionId: 'app-session-444',
          },
          {
            id: 'trustquote-business-rules',
            title: 'TrustQuote lead business rules',
            status: 'needs_james_input_over_time',
            nextAction: 'James answers case-triggered business-rule questions as they come up.',
            updatedAt: '2026-06-12T16:00:00.000Z',
            sessionId: 'app-session-445',
          },
          {
            id: 'resolved-old-task',
            title: 'Resolved old task',
            status: 'resolved',
            nextAction: 'No action needed.',
            updatedAt: '2026-06-12T14:00:00.000Z',
            sessionId: 'app-session-444',
          },
        ],
      })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        refs: expect.objectContaining({ kind: 'task_audit_item', itemId: 'trustquote-phase-3' }),
      }),
      expect.objectContaining({
        refs: expect.objectContaining({ kind: 'task_audit_item', itemId: 'trustquote-business-rules' }),
      }),
    ]));
    expect(snapshot.needsYou.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        refs: expect.objectContaining({ kind: 'task_audit_item', itemId: 'resolved-old-task' }),
      }),
    ]));
  });

  test('does not treat status captions about what needs you as asks', () => {
    const rows = [
      {
        rowId: 30,
        messageId: 'status-caption',
        sessionId: 'app-session-445',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:00:00.000Z'),
        rawBody: 'First look: what your team did and what needs you, in sentences instead of scrollback.',
      },
    ];

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      sessionId: 'app-session-445',
      queryCommsJournalEntries: jest.fn(() => rows),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toEqual([]);
  });

  test('does not reflect the team\'s own status/screenshot captions back into needs-you (self-referential feedback loop)', () => {
    const rows = [
      {
        // GAP 1 reproduction: an hm-screenshot --send-telegram caption that landed with no
        // valid timestamp (at=0) and literally contains "Needs You = 3". Caught by BOTH the
        // timestamp gate and the [photo]/"needs you =" self-reference guard.
        rowId: 41,
        messageId: 'photo-caption-no-ts',
        sessionId: 'app-session-447',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        rawBody: '[photo] LIVE. Your front door Today is painting the real thing. Needs You = the 3 that actually need you.',
      },
      {
        // A surface-status row WITH a valid timestamp — must still be excluded by the
        // self-reference guard alone, not just the timestamp gate.
        rowId: 42,
        messageId: 'surface-status-ts',
        sessionId: 'app-session-447',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-14T18:44:00.000Z'),
        rawBody: 'Needs You = 3, Team Feed on the rolling window. The front door is live.',
      },
    ];

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-14T18:50:00.000Z'),
      sessionId: 'app-session-447',
      queryCommsJournalEntries: jest.fn(() => rows),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toEqual([]);
  });

  test('resolves implicit needs-you asks when a later outbound answers the same thread', () => {
    const rows = [
      {
        rowId: 20,
        messageId: 'answered-ask',
        sessionId: 'app-session-445',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:00:00.000Z'),
        rawBody: 'James, do you approve the Today page cleanup?',
        metadata: { chatId: '1234' },
      },
      {
        rowId: 21,
        messageId: 'team-answer',
        sessionId: 'app-session-445',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:05:00.000Z'),
        rawBody: 'Handled now. The Today page cleanup is finished.',
        metadata: { chatId: '1234' },
      },
      {
        rowId: 22,
        messageId: 'unanswered-ask',
        sessionId: 'app-session-445',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        brokeredAtMs: Date.parse('2026-06-12T16:10:00.000Z'),
        rawBody: 'James, do you approve the next current-session step?',
        metadata: { chatId: '5678' },
      },
    ];

    const snapshot = timeline.buildHumanTimelineSnapshot({
      nowMs: Date.parse('2026-06-12T17:00:00.000Z'),
      sessionId: 'app-session-445',
      queryCommsJournalEntries: jest.fn(() => rows),
      queryTelegramReplyObligations: jest.fn(() => []),
      readTaskAuditItems: jest.fn(() => ({ ok: true, status: 'OK', items: [] })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toHaveLength(1);
    expect(snapshot.needsYou.items[0]).toEqual(expect.objectContaining({
      refs: expect.objectContaining({ commsRowId: 22 }),
      detail: 'James, do you approve the next current-session step?',
    }));
  });
});
