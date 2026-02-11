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

  test('external verification signals are not blocked by owner invariant', () => {
    const invalidHandler = jest.fn();
    bus.on('transition.invalid', invalidHandler);

    emitRequested('corr-owner-terminal');
    bus.emit('inject.submit.sent', {
      paneId: '1',
      correlationId: 'corr-owner-terminal',
      source: 'injection.js',
    });
    bus.emit('verify.pass', {
      paneId: '1',
      correlationId: 'corr-owner-terminal',
      source: 'verification.js',
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const transition = transitions.find((item) => item.correlationId === 'corr-owner-terminal');
    expect(transition).toBeTruthy();
    expect(transition.phase).toBe('verified');
    expect(transition.closed).toBe(true);
    expect(invalidHandler.mock.calls.some((call) => call[0].payload.reasonCode === 'ownership_conflict')).toBe(false);
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

  test('submit.requested synthetic apply captures preconditions and defers when focus lock is active', () => {
    const invalidHandler = jest.fn();
    bus.on('transition.invalid', invalidHandler);

    emitRequested('corr-submit-requested-pre');
    bus.updateState('1', { gates: { focusLocked: true } });
    bus.emit('inject.submit.requested', {
      paneId: '1',
      correlationId: 'corr-submit-requested-pre',
      source: 'injection.js',
    });

    const transition = ledger.getByCorrelation('corr-submit-requested-pre', '1');
    expect(transition).toBeTruthy();
    expect(transition.phase).toBe('deferred');
    expect(transition.phaseHistory.some((item) => item.phase === 'applied')).toBe(false);
    expect(transition.preconditions.some((item) => item.id === 'focus-lock-guard' && item.result === 'fail')).toBe(true);
    expect(invalidHandler).toHaveBeenCalled();
  });

  test('submit.sent synthetic apply captures preconditions and defers when focus lock is active', () => {
    const invalidHandler = jest.fn();
    bus.on('transition.invalid', invalidHandler);

    emitRequested('corr-submit-sent-pre');
    bus.updateState('1', { gates: { focusLocked: true } });
    bus.emit('inject.submit.sent', {
      paneId: '1',
      correlationId: 'corr-submit-sent-pre',
      source: 'injection.js',
    });

    const transition = ledger.getByCorrelation('corr-submit-sent-pre', '1');
    expect(transition).toBeTruthy();
    expect(transition.phase).toBe('deferred');
    expect(transition.phaseHistory.some((item) => item.phase === 'applied')).toBe(false);
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

  test('evidenceSpec is enforced at finalize for manual_only requirement', () => {
    bus.emit('inject.requested', {
      paneId: '1',
      correlationId: 'corr-manual-only',
      source: 'injection.js',
      payload: {
        evidenceSpec: {
          requiredClass: 'manual_only',
        },
      },
    });

    bus.emit('inject.submit.sent', {
      paneId: '1',
      correlationId: 'corr-manual-only',
      source: 'injection.js',
    });
    bus.emit('verify.pass', {
      paneId: '1',
      correlationId: 'corr-manual-only',
      source: 'verification.js',
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-manual-only');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('failed');
    expect(found.outcome.reasonCode).toBe('manual_verification_required');
  });

  test('disallowedSignals overrides static strong mapping in classifyEvidence', () => {
    bus.emit('inject.requested', {
      paneId: '1',
      correlationId: 'corr-disallowed-override',
      source: 'injection.js',
      payload: {
        evidenceSpec: {
          requiredClass: 'strong',
          acceptedSignals: ['verify.pass'],
          disallowedSignals: ['verify.pass'],
        },
      },
    });

    bus.emit('inject.submit.sent', {
      paneId: '1',
      correlationId: 'corr-disallowed-override',
      source: 'injection.js',
    });
    bus.emit('verify.pass', {
      paneId: '1',
      correlationId: 'corr-disallowed-override',
      source: 'verification.js',
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-disallowed-override');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('failed');
    expect(found.outcome.reasonCode).toBe('disallowed_evidence');
    expect(found.verification.evidenceClassObserved).toBe('disallowed');
  });

  test('acceptedSignals disallows non-listed signals at classify time', () => {
    bus.emit('inject.requested', {
      paneId: '1',
      correlationId: 'corr-accepted-list',
      source: 'injection.js',
      payload: {
        evidenceSpec: {
          requiredClass: 'strong',
          acceptedSignals: ['verify.pass'],
          disallowedSignals: [],
        },
      },
    });

    bus.emit('inject.submit.sent', {
      paneId: '1',
      correlationId: 'corr-accepted-list',
      source: 'injection.js',
    });
    bus.emit('daemon.write.ack', {
      paneId: '1',
      correlationId: 'corr-accepted-list',
      source: 'terminal-daemon.js',
      payload: { status: 'accepted', bytesAccepted: 12 },
    });

    jest.advanceTimersByTime(5001);

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-accepted-list');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('failed');
    expect(found.outcome.reasonCode).toBe('disallowed_evidence');
    expect(found.verification.evidenceClassObserved).toBe('disallowed');
  });

  test('timeout is armed at submit.requested (before submit.sent)', () => {
    emitRequested('corr-timeout-early');
    bus.emit('inject.submit.requested', {
      paneId: '1',
      correlationId: 'corr-timeout-early',
      source: 'injection.js',
    });

    jest.advanceTimersByTime(5001);

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-timeout-early');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('timed_out');
    expect(found.outcome.reasonCode).toBe('timeout_without_evidence');
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

  test('inject.dropped settles transition with dropped terminal phase', () => {
    emitRequested('corr-dropped');
    bus.emit('inject.dropped', {
      paneId: '1',
      correlationId: 'corr-dropped',
      source: 'injection.js',
      payload: { reason: 'overlay_fit_exclusion' },
    });

    const transitions = ledger.listTransitions({ includeClosed: true, limit: 10 });
    const found = transitions.find((item) => item.correlationId === 'corr-dropped');
    expect(found.closed).toBe(true);
    expect(found.phase).toBe('dropped');
    expect(found.lifecycle).toBe('dropped');
    expect(found.verification.outcome).toBe('fail');
    expect(found.outcome.reasonCode).toBe('overlay_fit_exclusion');
  });

  test('prunes oldest closed transitions once storage exceeds max retention', () => {
    const total = 505;
    for (let i = 0; i < total; i++) {
      const corr = `corr-prune-${i}`;
      emitRequested(corr);
      bus.emit('inject.dropped', {
        paneId: '1',
        correlationId: corr,
        source: 'injection.js',
        payload: { reason: 'prune_test' },
      });
    }

    const all = ledger.listTransitions({ includeClosed: true, limit: 1000 });
    expect(all.length).toBe(500);
    expect(all.some((item) => item.correlationId === 'corr-prune-0')).toBe(false);
    expect(all.some((item) => item.correlationId === 'corr-prune-4')).toBe(false);
    expect(all.some((item) => item.correlationId === 'corr-prune-5')).toBe(true);
    expect(all.some((item) => item.correlationId === 'corr-prune-504')).toBe(true);
  });

  test('getByCorrelation scans all panes when paneId is omitted', () => {
    emitRequested('corr-scan-all', '2');
    const transition = ledger.getByCorrelation('corr-scan-all');

    expect(transition).toBeTruthy();
    expect(transition.paneId).toBe('2');
    expect(transition.correlationId).toBe('corr-scan-all');
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
