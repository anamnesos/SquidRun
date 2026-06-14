const timeline = require('../modules/main/human-timeline');

describe('human-timeline snapshot', () => {
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
        ],
      })),
      queryGitCommits: jest.fn(() => []),
      appStatusPath: 'missing-app-status.json',
    });

    expect(snapshot.needsYou.items).toHaveLength(5);
    expect(snapshot.needsYou.overflowCount).toBe(1);
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
