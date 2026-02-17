const {
  buildStartupBrief,
  collectOpenTasksFromJournal,
  collectFailedDeliveries,
} = require('../modules/main/startup-brief');

describe('startup brief generator', () => {
  test('collectOpenTasksFromJournal keeps TASK/BLOCKER and removes DONE matches', () => {
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        rawBody: '(ARCHITECT #1): TASK: wire startup brief',
        brokeredAtMs: 1000,
        metadata: { traceId: 't1' },
      },
      {
        messageId: 'm2',
        senderRole: 'builder',
        rawBody: '(BUILDER #2): DONE: wire startup brief',
        brokeredAtMs: 1200,
        metadata: { traceId: 't2' },
      },
      {
        messageId: 'm3',
        senderRole: 'oracle',
        rawBody: '(ORACLE #1): BLOCKER: telegram ingress missing',
        brokeredAtMs: 1300,
        metadata: { traceId: 't3' },
      },
    ];

    const open = collectOpenTasksFromJournal(rows);
    expect(open).toHaveLength(1);
    expect(open[0].tag).toBe('BLOCKER');
    expect(open[0].detail).toContain('telegram ingress');
  });

  test('collectFailedDeliveries filters failed states', () => {
    const failed = collectFailedDeliveries([
      { messageId: 'ok-1', status: 'brokered', brokeredAtMs: 1000 },
      { messageId: 'bad-1', status: 'failed', brokeredAtMs: 1100 },
      { messageId: 'bad-2', status: 'acked', ackStatus: 'failed', brokeredAtMs: 1200 },
      { messageId: 'bad-3', status: 'brokered', errorCode: 'timeout', brokeredAtMs: 1300 },
    ]);

    expect(failed.map((row) => row.messageId)).toEqual(['bad-3', 'bad-2', 'bad-1']);
  });

  test('buildStartupBrief renders open tasks, unresolved claims, and failed deliveries', () => {
    const brief = buildStartupBrief({
      sessionId: 'app-session-900',
      nowMs: 2000,
      journalRows: [
        {
          messageId: 'm1',
          senderRole: 'architect',
          rawBody: '(ARCHITECT #1): TASK: implement startup brief',
          brokeredAtMs: 1000,
          metadata: { traceId: 'trace-1' },
        },
        {
          messageId: 'm2',
          senderRole: 'builder',
          rawBody: '(BUILDER #1): BLOCKER: delivery checks failing',
          brokeredAtMs: 1100,
          metadata: { traceId: 'trace-2' },
          status: 'failed',
          ackStatus: 'failed',
          errorCode: 'timeout',
        },
      ],
      unresolvedClaims: {
        proposed: [{ status: 'proposed', statement: 'Claim A proposed' }],
        contested: [{ status: 'contested', statement: 'Claim B contested' }],
        pending_proof: [],
      },
    });

    expect(brief).toContain('[STARTUP BRIEF]');
    expect(brief).toContain('open_tasks=');
    expect(brief).toContain('Unresolved claims: proposed=1, contested=1, pending_proof=0');
    expect(brief).toContain('delivery checks failing');
    expect(brief).toContain('status=failed');
  });
});
