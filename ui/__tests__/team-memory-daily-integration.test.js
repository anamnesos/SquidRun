const {
  buildReadBeforeWorkQueryPayloads,
  pickTopClaims,
  formatReadBeforeWorkMessage,
  buildTaskCloseClaimPayload,
  buildTaskStatusPatternEvent,
  isDeliveryFailureResult,
} = require('../modules/team-memory/daily-integration');

describe('team-memory daily integration helpers', () => {
  test('buildReadBeforeWorkQueryPayloads includes role and scope queries', () => {
    const payloads = buildReadBeforeWorkQueryPayloads({
      paneId: '2',
      task: {
        id: 'T-10',
        subject: 'Fix triggers delivery timeout',
        description: 'Investigate ui/modules/triggers.js reliability',
        metadata: { domain: 'backend' },
      },
      domain: 'backend',
      limit: 6,
      sessionsBack: 2,
    });

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads[0]).toEqual(expect.objectContaining({
      owner: 'devops',
      sessionsBack: 2,
    }));
    expect(payloads.some((entry) => entry.scope === 'domain:backend')).toBe(true);
  });

  test('pickTopClaims dedupes and prioritizes higher confidence', () => {
    const picked = pickTopClaims([
      [
        { id: 'a', confidence: 0.7, updatedAt: 10 },
        { id: 'b', confidence: 0.9, updatedAt: 5 },
      ],
      [
        { id: 'a', confidence: 0.7, updatedAt: 10 },
        { id: 'c', confidence: 0.8, updatedAt: 20 },
      ],
    ], 3);

    expect(picked.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  test('formatReadBeforeWorkMessage formats top claim lines', () => {
    const message = formatReadBeforeWorkMessage({
      task: { id: 'T-11' },
      claims: [
        { status: 'confirmed', claimType: 'fact', owner: 'devops', statement: 'First claim statement' },
        { status: 'contested', claimType: 'negative', owner: 'analyst', statement: 'Second claim statement' },
      ],
    });

    expect(message).toContain('[TEAM MEMORY] Prior context for T-11');
    expect(message).toContain('1. (confirmed/fact/devops)');
    expect(message).toContain('2. (contested/negative/analyst)');
  });

  test('buildTaskCloseClaimPayload maps completed and failed states', () => {
    const completed = buildTaskCloseClaimPayload({
      task: {
        id: 'T-20',
        subject: 'Ship fix',
        metadata: { domain: 'backend' },
        owner: '2',
        completedAt: '2026-02-14T12:00:00.000Z',
      },
      status: 'completed',
    });
    expect(completed.claimType).toBe('fact');
    expect(completed.owner).toBe('devops');
    expect(completed.idempotencyKey).toContain('task-close:T-20:completed');

    const failed = buildTaskCloseClaimPayload({
      task: {
        id: 'T-21',
        subject: 'Attempt migration',
        metadata: { domain: 'backend' },
        owner: '2',
        failedAt: '2026-02-14T13:00:00.000Z',
      },
      status: 'failed',
      metadata: { error: { message: 'Migration timed out' } },
    });
    expect(failed.claimType).toBe('negative');
    expect(failed.statement).toContain('Migration timed out');
  });

  test('buildTaskStatusPatternEvent and delivery failure predicate', () => {
    const event = buildTaskStatusPatternEvent({
      task: { id: 'T-30', metadata: { domain: 'backend' }, owner: '2' },
      status: 'failed',
      metadata: { error: { message: 'write failed' } },
    });

    expect(event.eventType).toBe('task.status_changed');
    expect(event.status).toBe('failed');
    expect(event.actor).toBe('devops');
    expect(event.owner).toBe('devops');

    expect(isDeliveryFailureResult({ verified: true, status: 'delivered.verified' })).toBe(false);
    expect(isDeliveryFailureResult({ verified: false, status: 'routed_unverified_timeout' })).toBe(true);
    expect(isDeliveryFailureResult({ accepted: false, status: 'invalid_target' })).toBe(true);
  });
});
