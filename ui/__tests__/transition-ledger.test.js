/**
 * Tests for modules/transition-ledger.js
 */

describe('transition-ledger', () => {
  let bus;
  let ledger;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bus = require('../modules/event-bus');
    ledger = require('../modules/transition-ledger');
    bus.reset();
    ledger.reset();
    ledger.init(bus);
  });

  afterEach(() => {
    ledger.reset();
    bus.reset();
    jest.useRealTimers();
  });

  function emitRequested(correlationId = 'corr-1', paneId = '1') {
    return bus.emit('inject.requested', {
      paneId,
      correlationId,
      source: 'injection.js',
      payload: { messageLen: 12 },
    });
  }

  test('creates canonical transition object with owner lease and defaults', () => {
    const evt = emitRequested('corr-create');
    const transition = ledger.getByCorrelation('corr-create', '1');

    expect(transition).toBeTruthy();
    expect(transition.transitionType).toBe('message.submit');
    expect(transition.phase).toBe('requested');
    expect(transition.lifecycle).toBe('requested');
    expect(transition.owner.module).toBe('injection.js');
    expect(transition.owner.leaseId).toMatch(/^lease-/);
    expect(transition.sourceEventId).toBe(evt.eventId);
    expect(transition.preconditions).toEqual([]);
    expect(transition.verification.outcome).toBe('unknown');
  });

  test('tracks canonical phase progression to verifying', () => {
    emitRequested('corr-life');
    bus.emit('inject.queued', { paneId: '1', correlationId: 'corr-life', source: 'injection.js' });
    bus.emit('inject.applied', { paneId: '1', correlationId: 'corr-life', source: 'injection.js' });
    bus.emit('inject.submit.requested', { paneId: '1', correlationId: 'corr-life', source: 'injection.js' });
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-life', source: 'injection.js' });

    const transition = ledger.getByCorrelation('corr-life', '1');
    expect(transition.phase).toBe('verifying');
    expect(transition.phaseHistory.map((item) => item.phase)).toEqual([
      'requested',
      'deferred',
      'accepted',
      'applied',
      'verifying',
    ]);
  });

  test('records weak evidence from daemon.write.ack accepted', () => {
    emitRequested('corr-ack');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-ack', source: 'injection.js' });
    bus.emit('daemon.write.ack', {
      paneId: '1',
      correlationId: 'corr-ack',
      source: 'terminal-daemon.js',
      payload: { status: 'accepted', bytesAccepted: 12 },
    });

    const transition = ledger.getByCorrelation('corr-ack', '1');
    expect(transition.evidence.some((item) => item.type === 'daemon.write.ack' && item.class === 'weak')).toBe(true);
  });

  test('compaction-aware classification marks pty data evidence as disallowed', () => {
    emitRequested('corr-disallowed');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-disallowed', source: 'injection.js' });
    bus.updateState('1', { gates: { compacting: 'confirmed' } });
    bus.emit('pty.data.received', {
      paneId: '1',
      correlationId: 'corr-disallowed',
      source: 'terminal-daemon.js',
      payload: { meaningful: true, chunkType: 'mixed' },
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-disallowed');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('failed');
    expect(found.verification.outcome).toBe('fail');
    expect(found.verification.evidenceClassObserved).toBe('disallowed');
  });

  test('owner lease invariant emits transition.invalid on source mismatch', () => {
    const invalidHandler = jest.fn();
    bus.on('transition.invalid', invalidHandler);

    emitRequested('corr-owner');
    bus.emit('inject.applied', {
      paneId: '1',
      correlationId: 'corr-owner',
      source: 'other-module.js',
    });

    expect(invalidHandler).toHaveBeenCalled();
    const invalidPayload = invalidHandler.mock.calls[0][0].payload;
    expect(invalidPayload.reasonCode).toBe('ownership_conflict');
  });

  test('precondition gate blocks applied phase when focus lock is active', () => {
    const invalidHandler = jest.fn();
    bus.on('transition.invalid', invalidHandler);

    emitRequested('corr-pre');
    bus.updateState('1', { gates: { focusLocked: true } });
    bus.emit('inject.applied', {
      paneId: '1',
      correlationId: 'corr-pre',
      source: 'injection.js',
    });

    const transition = ledger.getByCorrelation('corr-pre', '1');
    expect(transition.phase).not.toBe('applied');
    expect(transition.preconditions.length).toBeGreaterThan(0);
    expect(transition.preconditions.some((item) => item.id === 'focus-lock-guard' && item.result === 'fail')).toBe(true);
    expect(invalidHandler).toHaveBeenCalled();
  });

  test('strong evidence settles verified with pass outcome', () => {
    emitRequested('corr-strong');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-strong', source: 'injection.js' });
    bus.emit('verify.pass', { paneId: '1', correlationId: 'corr-strong', source: 'verification.js' });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-strong');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('verified');
    expect(found.lifecycle).toBe('delivered_verified');
    expect(found.verification.outcome).toBe('pass');
  });

  test('timeout with weak evidence settles as risked_pass', () => {
    emitRequested('corr-timeout');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-timeout', source: 'injection.js' });
    bus.emit('pty.data.received', {
      paneId: '1',
      correlationId: 'corr-timeout',
      source: 'terminal-daemon.js',
      payload: { meaningful: true, chunkType: 'mixed' },
    });

    jest.advanceTimersByTime(5001);

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-timeout');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('timed_out');
    expect(found.lifecycle).toBe('delivered_unverified');
    expect(found.verification.outcome).toBe('risked_pass');
  });

  test('inject.failed settles transition with fail verification outcome', () => {
    emitRequested('corr-failed');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-failed', source: 'injection.js' });
    bus.emit('inject.failed', {
      paneId: '1',
      correlationId: 'corr-failed',
      source: 'injection.js',
      payload: { reason: 'enter_failed' },
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-failed');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('failed');
    expect(found.verification.outcome).toBe('fail');
    expect(found.outcome.reasonCode).toBe('enter_failed');
  });

  test('supports query by phase and reasonCode', () => {
    emitRequested('corr-q1');
    bus.emit('inject.submit.sent', { paneId: '1', correlationId: 'corr-q1', source: 'injection.js' });
    bus.emit('inject.failed', {
      paneId: '1',
      correlationId: 'corr-q1',
      source: 'injection.js',
      payload: { reason: 'enter_failed' },
    });

    const byPhase = ledger.query({ phase: 'failed' });
    const byReason = ledger.query({ reasonCode: 'enter_failed' });
    expect(byPhase.length).toBeGreaterThan(0);
    expect(byReason.length).toBeGreaterThan(0);
  });

  test('stop unsubscribes ledger listeners', () => {
    ledger.stop();
    emitRequested('corr-stop');
    const transition = ledger.getByCorrelation('corr-stop', '1');
    expect(transition).toBeNull();
  });
});
