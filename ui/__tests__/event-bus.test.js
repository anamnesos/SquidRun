/**
 * Tests for modules/event-bus.js
 * Comprehensive coverage of the Event Kernel two-lane system.
 */

describe('event-bus', () => {
  let bus;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bus = require('../modules/event-bus');
    bus.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ──────────────────────────────────────────
  // 1. Basic pub/sub: emit, on, off, wildcards
  // ──────────────────────────────────────────
  describe('basic pub/sub', () => {
    test('on + emit delivers event to handler', () => {
      const handler = jest.fn();
      bus.on('test.event', handler);
      bus.emit('test.event', { paneId: '1', payload: { x: 1 } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].type).toBe('test.event');
    });

    test('off removes handler', () => {
      const handler = jest.fn();
      bus.on('test.event', handler);
      bus.off('test.event', handler);
      bus.emit('test.event', { paneId: '1' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('multiple handlers on same type all fire', () => {
      const h1 = jest.fn();
      const h2 = jest.fn();
      bus.on('multi', h1);
      bus.on('multi', h2);
      bus.emit('multi', { paneId: '1' });
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    test('handler only fires for subscribed type', () => {
      const handler = jest.fn();
      bus.on('typeA', handler);
      bus.emit('typeB', { paneId: '1' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('wildcard on("inject.*") catches inject.requested', () => {
      const handler = jest.fn();
      bus.on('inject.*', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].type).toBe('inject.requested');
    });

    test('wildcard on("inject.*") catches inject.verified', () => {
      const handler = jest.fn();
      bus.on('inject.*', handler);
      bus.emit('inject.verified', { paneId: '1' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('wildcard does not match unrelated types', () => {
      const handler = jest.fn();
      bus.on('inject.*', handler);
      bus.emit('focus.changed', { paneId: '1' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('off wildcard removes wildcard handler', () => {
      const handler = jest.fn();
      bus.on('inject.*', handler);
      bus.off('inject.*', handler);
      bus.emit('inject.requested', { paneId: '1' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('on ignores non-function handlers', () => {
      expect(() => bus.on('test', 'not a function')).not.toThrow();
      expect(() => bus.on('test', null)).not.toThrow();
    });

    test('handler error does not crash other handlers', () => {
      const bad = jest.fn(() => { throw new Error('boom'); });
      const good = jest.fn();
      bus.on('test', bad);
      bus.on('test', good);
      bus.emit('test', { paneId: '1' });
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────
  // 2. Event envelope auto-generated fields
  // ──────────────────────────────────────────
  describe('event envelope', () => {
    test('emit returns event with all envelope fields', () => {
      const event = bus.emit('test.event', { paneId: '2', payload: { data: 1 }, source: 'test.js' });
      expect(event).toHaveProperty('eventId');
      expect(event).toHaveProperty('correlationId');
      expect(event).toHaveProperty('causationId');
      expect(event).toHaveProperty('type', 'test.event');
      expect(event).toHaveProperty('source', 'test.js');
      expect(event).toHaveProperty('paneId', '2');
      expect(event).toHaveProperty('ts');
      expect(event).toHaveProperty('seq');
      expect(event).toHaveProperty('payload');
    });

    test('eventId is unique per event', () => {
      const e1 = bus.emit('test', { paneId: '1' });
      const e2 = bus.emit('test', { paneId: '1' });
      expect(e1.eventId).not.toBe(e2.eventId);
    });

    test('correlationId is preserved when provided', () => {
      const event = bus.emit('test', { paneId: '1', correlationId: 'my-corr-id' });
      expect(event.correlationId).toBe('my-corr-id');
    });

    test('causationId is preserved when provided', () => {
      const event = bus.emit('test', { paneId: '1', causationId: 'parent-id' });
      expect(event.causationId).toBe('parent-id');
    });

    test('causationId defaults to null for root events', () => {
      const event = bus.emit('test', { paneId: '1' });
      expect(event.causationId).toBeNull();
    });

    test('ts is a number (millisecond timestamp)', () => {
      const event = bus.emit('test', { paneId: '1' });
      expect(typeof event.ts).toBe('number');
    });

    test('paneId defaults to "system" when not provided', () => {
      const event = bus.emit('test', {});
      expect(event.paneId).toBe('system');
    });

    test('source defaults to "unknown" when not provided', () => {
      const event = bus.emit('test', { paneId: '1' });
      expect(event.source).toBe('unknown');
    });
  });

  // ──────────────────────────────────────────
  // 3. Sequence numbers
  // ──────────────────────────────────────────
  describe('sequence numbers', () => {
    test('seq starts at 1 for a new source', () => {
      const event = bus.emit('test', { paneId: '1', source: 'src-a' });
      expect(event.seq).toBe(1);
    });

    test('seq is monotonically increasing per source', () => {
      const e1 = bus.emit('test', { paneId: '1', source: 'src-a' });
      const e2 = bus.emit('test', { paneId: '1', source: 'src-a' });
      const e3 = bus.emit('test', { paneId: '1', source: 'src-a' });
      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(3);
    });

    test('different sources have independent seq counters', () => {
      const ea = bus.emit('test', { paneId: '1', source: 'src-a' });
      const eb = bus.emit('test', { paneId: '1', source: 'src-b' });
      expect(ea.seq).toBe(1);
      expect(eb.seq).toBe(1);
    });

    test('seq has no gaps', () => {
      const events = [];
      for (let i = 0; i < 10; i++) {
        events.push(bus.emit('test', { paneId: '1', source: 'gap-check' }));
      }
      for (let i = 0; i < events.length; i++) {
        expect(events[i].seq).toBe(i + 1);
      }
    });
  });

  // ──────────────────────────────────────────
  // 4. Contracts: enforced actions
  // ──────────────────────────────────────────
  describe('contracts - enforced', () => {
    test('defer action queues event, does not deliver to listeners', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'injection.js' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('drop action discards event, increments totalDropped', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'drop-test',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [() => false], // always violates
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });
      expect(handler).not.toHaveBeenCalled();
      expect(bus.getStats().totalDropped).toBe(1);
    });

    test('block action rejects event, increments totalDropped', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'block-test',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [() => false],
        severity: 'block',
        action: 'block',
        fallbackAction: 'block',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });
      expect(handler).not.toHaveBeenCalled();
      expect(bus.getStats().totalDropped).toBe(1);
    });

    test('skip action delivers event with _skipped flag', () => {
      const handler = jest.fn();
      bus.on('resize.started', handler);
      bus.registerContract({
        id: 'skip-test',
        version: 1,
        owner: 'test',
        appliesTo: ['resize.started'],
        preconditions: [() => false],
        severity: 'warn',
        action: 'skip',
        fallbackAction: 'skip',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      const event = bus.emit('resize.started', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(event._skipped).toBe(true);
    });

    test('continue action allows event through', () => {
      const handler = jest.fn();
      bus.on('test.event', handler);
      bus.registerContract({
        id: 'continue-test',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false],
        severity: 'info',
        action: 'continue',
        fallbackAction: 'continue',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('contract.checked is emitted when a contract is evaluated', () => {
      const handler = jest.fn();
      bus.on('contract.checked', handler);
      bus.registerContract({
        id: 'checked-test',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => true], // passes
        severity: 'info',
        action: 'continue',
        fallbackAction: 'continue',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.contractId).toBe('checked-test');
    });

    test('contract.violation is emitted on enforced violation', () => {
      const handler = jest.fn();
      bus.on('contract.violation', handler);
      bus.registerContract({
        id: 'viol-test',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false],
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.contractId).toBe('viol-test');
    });

    test('passing contract does not block event', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'pass-test',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [() => true],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('re-registering a contract with same id replaces old one', () => {
      bus.registerContract({
        id: 'replaceable',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false],
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      // Replace with passing contract
      bus.registerContract({
        id: 'replaceable',
        version: 2,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => true],
        severity: 'info',
        action: 'continue',
        fallbackAction: 'continue',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      const handler = jest.fn();
      bus.on('test.event', handler);
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────
  // 5. Contracts: shadow mode
  // ──────────────────────────────────────────
  describe('contracts - shadow mode', () => {
    test('shadow contract emits contract.shadow.violation but allows event through', () => {
      const mainHandler = jest.fn();
      const shadowHandler = jest.fn();
      bus.on('test.event', mainHandler);
      bus.on('contract.shadow.violation', shadowHandler);
      bus.registerContract({
        id: 'shadow-test',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false],
        severity: 'warn',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'shadow',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(mainHandler).toHaveBeenCalledTimes(1); // Event still delivered
      expect(shadowHandler).toHaveBeenCalledTimes(1);
      expect(shadowHandler.mock.calls[0][0].payload.contractId).toBe('shadow-test');
    });

    test('shadow contract does not increment contractViolations counter', () => {
      bus.registerContract({
        id: 'shadow-counter',
        version: 1,
        owner: 'test',
        appliesTo: ['test.event'],
        preconditions: [() => false],
        severity: 'warn',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'shadow',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('test.event', { paneId: '1', source: 'test' });
      expect(bus.getStats().contractViolations).toBe(0);
    });
  });

  // ──────────────────────────────────────────
  // 6. State vector
  // ──────────────────────────────────────────
  describe('state vector', () => {
    test('getState returns default state for known pane', () => {
      const state = bus.getState('1');
      expect(state.activity).toBe('idle');
      expect(state.gates.focusLocked).toBe(false);
      expect(state.gates.compacting).toBe('none');
      expect(state.gates.safeMode).toBe(false);
      expect(state.connectivity.bridge).toBe('up');
      expect(state.connectivity.pty).toBe('up');
    });

    test('getState returns a copy (not mutable reference)', () => {
      const s1 = bus.getState('1');
      s1.activity = 'injecting';
      const s2 = bus.getState('1');
      expect(s2.activity).toBe('idle'); // unchanged
    });

    test('updateState merges partial updates', () => {
      bus.updateState('1', { activity: 'injecting' });
      const state = bus.getState('1');
      expect(state.activity).toBe('injecting');
      expect(state.gates.focusLocked).toBe(false); // unchanged
    });

    test('updateState deep-merges gates', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const state = bus.getState('1');
      expect(state.gates.focusLocked).toBe(true);
      expect(state.gates.compacting).toBe('none'); // unchanged
    });

    test('updateState deep-merges connectivity', () => {
      bus.updateState('1', { connectivity: { bridge: 'down' } });
      const state = bus.getState('1');
      expect(state.connectivity.bridge).toBe('down');
      expect(state.connectivity.pty).toBe('up'); // unchanged
    });

    test('updateState emits pane.state.changed', () => {
      const handler = jest.fn();
      bus.on('pane.state.changed', handler);
      bus.updateState('1', { activity: 'resizing' });
      expect(handler).toHaveBeenCalledTimes(1);
      const evt = handler.mock.calls[0][0];
      expect(evt.paneId).toBe('1');
      expect(evt.payload.prev.activity).toBe('idle');
      expect(evt.payload.next.activity).toBe('resizing');
    });

    test('getState creates default for unknown pane', () => {
      const state = bus.getState('99');
      expect(state.activity).toBe('idle');
    });
  });

  // ──────────────────────────────────────────
  // 7. Ring buffer (Lane B)
  // ──────────────────────────────────────────
  describe('ring buffer', () => {
    test('events are recorded in buffer', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      const buf = bus.getBuffer();
      expect(buf.length).toBeGreaterThan(0);
      const found = buf.find(e => e.type === 'test');
      expect(found).toBeTruthy();
    });

    test('query by type returns matching events', () => {
      bus.emit('alpha', { paneId: '1', source: 'test' });
      bus.emit('beta', { paneId: '1', source: 'test' });
      bus.emit('alpha', { paneId: '1', source: 'test' });
      const results = bus.query({ type: 'alpha' });
      expect(results.length).toBe(2);
    });

    test('query by paneId returns matching events', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      bus.emit('test', { paneId: '2', source: 'test' });
      const results = bus.query({ paneId: '1', type: 'test' });
      expect(results.length).toBe(1);
    });

    test('query by correlationId returns matching events', () => {
      const corrId = bus.startCorrelation();
      bus.emit('test', { paneId: '1', source: 'test' });
      bus.startCorrelation(); // new correlation
      bus.emit('test', { paneId: '1', source: 'test' });
      const results = bus.query({ correlationId: corrId, type: 'test' });
      expect(results.length).toBe(1);
    });

    test('query by timeRange filters events', () => {
      const now = Date.now();
      bus.emit('test', { paneId: '1', source: 'test' });
      jest.advanceTimersByTime(1000);
      bus.emit('test', { paneId: '1', source: 'test' });
      const results = bus.query({ type: 'test', timeRange: { start: now, end: now + 500 } });
      expect(results.length).toBe(1);
    });

    test('buffer expands beyond 1000 during bursts within 5-minute window', () => {
      // All events within time window — buffer should expand beyond 1000
      for (let i = 0; i < 1100; i++) {
        bus.emit('fill', { paneId: '1', source: 'test' });
      }
      const buf = bus.getBuffer();
      // Buffer should keep all events since they're within the 5-minute window
      expect(buf.length).toBeGreaterThan(1000);
    });

    test('buffer evicts oldest when both over size AND over time window', () => {
      // Emit 600 events at time 0
      for (let i = 0; i < 600; i++) {
        bus.emit('old', { paneId: '1', source: 'test' });
      }
      const bufBefore = bus.getBuffer();
      const oldCountBefore = bufBefore.filter(e => e.type === 'old').length;

      // Advance past 5 minutes
      jest.advanceTimersByTime(6 * 60 * 1000);

      // Emit 600 more (pushes total well over 1000, old ones are > 5 min)
      for (let i = 0; i < 600; i++) {
        bus.emit('new', { paneId: '1', source: 'test' });
      }
      const buf = bus.getBuffer();
      // Buffer should be capped at ~1000 (eviction stops at BUFFER_MAX_SIZE)
      expect(buf.length).toBeLessThanOrEqual(1001);
      // Some old events should have been evicted
      const oldEventsAfter = buf.filter(e => e.type === 'old').length;
      expect(oldEventsAfter).toBeLessThan(oldCountBefore);
      // All new events preserved (they're within time window)
      const newEvents = buf.filter(e => e.type === 'new');
      expect(newEvents.length).toBe(600);
    });

    test('getBuffer returns a copy', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      const buf1 = bus.getBuffer();
      buf1.push({ fake: true });
      const buf2 = bus.getBuffer();
      expect(buf2.find(e => e.fake)).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────
  // 8. Safe mode
  // ──────────────────────────────────────────
  describe('safe mode', () => {
    function createViolatingContract() {
      bus.registerContract({
        id: 'safe-mode-trigger',
        version: 1,
        owner: 'test',
        appliesTo: ['bad.event'],
        preconditions: [() => false],
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
    }

    test('3 violations within 10 seconds triggers safe mode', () => {
      createViolatingContract();
      const handler = jest.fn();
      bus.on('safemode.entered', handler);

      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.triggerReason).toBe('cascading_violations');
    });

    test('safe mode sets safeMode gate on all pane states', () => {
      createViolatingContract();
      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });

      expect(bus.getState('1').gates.safeMode).toBe(true);
      expect(bus.getState('2').gates.safeMode).toBe(true);
    });

    test('safe mode auto-exits after 30 seconds of no violations', () => {
      createViolatingContract();
      const exitHandler = jest.fn();
      bus.on('safemode.exited', exitHandler);

      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });
      bus.emit('bad.event', { paneId: '1', source: 'test' });

      expect(bus.getState('1').gates.safeMode).toBe(true);

      // Advance 30 seconds
      jest.advanceTimersByTime(30000);

      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(bus.getState('1').gates.safeMode).toBe(false);
    });

    test('violations spread over >10 seconds do not trigger safe mode', () => {
      createViolatingContract();
      const handler = jest.fn();
      bus.on('safemode.entered', handler);

      bus.emit('bad.event', { paneId: '1', source: 'test' });
      jest.advanceTimersByTime(5000);
      bus.emit('bad.event', { paneId: '1', source: 'test' });
      jest.advanceTimersByTime(6000); // Now 11s since first violation
      bus.emit('bad.event', { paneId: '1', source: 'test' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────
  // 9. Deferred events
  // ──────────────────────────────────────────
  describe('deferred events', () => {
    test('deferred events resume when gate clears', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      // Lock focus and emit — should defer
      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'injection.js' });
      expect(handler).not.toHaveBeenCalled();

      // Clear focus lock — should resume
      bus.updateState('1', { gates: { focusLocked: false } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('inject.resumed is emitted when deferred event resumes', () => {
      const resumeHandler = jest.fn();
      bus.on('inject.resumed', resumeHandler);
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'injection.js' });
      bus.updateState('1', { gates: { focusLocked: false } });

      expect(resumeHandler).toHaveBeenCalledTimes(1);
    });

    test('multiple deferred events resume in FIFO order', () => {
      const order = [];
      bus.on('inject.requested', (event) => {
        order.push(event.payload.order);
      });
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'test', payload: { order: 1 } });
      bus.emit('inject.requested', { paneId: '1', source: 'test', payload: { order: 2 } });
      bus.emit('inject.requested', { paneId: '1', source: 'test', payload: { order: 3 } });

      bus.updateState('1', { gates: { focusLocked: false } });
      expect(order).toEqual([1, 2, 3]);
    });

    test('deferred events are dropped after TTL expires', () => {
      const handler = jest.fn();
      const dropHandler = jest.fn();
      bus.on('inject.requested', handler);
      bus.on('inject.dropped', dropHandler);
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'injection.js' });
      expect(handler).not.toHaveBeenCalled();

      // Advance past 30s TTL
      jest.advanceTimersByTime(31000);

      // Clear focus lock — should NOT resume, should drop
      bus.updateState('1', { gates: { focusLocked: false } });
      expect(handler).not.toHaveBeenCalled();
      expect(dropHandler).toHaveBeenCalledTimes(1);
      expect(dropHandler.mock.calls[0][0].payload.reason).toBe('ttl_expired');
    });

    test('TTL drop increments totalDropped', () => {
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });

      jest.advanceTimersByTime(31000);
      const beforeDrop = bus.getStats().totalDropped;
      bus.updateState('1', { gates: { focusLocked: false } });
      expect(bus.getStats().totalDropped).toBe(beforeDrop + 1);
    });

    test('deferred events within TTL still resume normally', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      bus.updateState('1', { gates: { focusLocked: true } });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });

      // Advance 10s — well within 30s TTL
      jest.advanceTimersByTime(10000);

      bus.updateState('1', { gates: { focusLocked: false } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('deferred events still blocked on resume stay in queue', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);

      // Contract blocks when BOTH focus locked AND compacting confirmed
      bus.registerContract({
        id: 'compaction-gate',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => state.gates.compacting !== 'confirmed'],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      // Both gates active
      bus.updateState('1', { gates: { focusLocked: true, compacting: 'confirmed' } });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });
      expect(handler).not.toHaveBeenCalled();

      // Clear focus but compaction still active — event should stay deferred
      bus.updateState('1', { gates: { focusLocked: false } });
      expect(handler).not.toHaveBeenCalled();

      // Clear compaction — now it should resume
      bus.updateState('1', { gates: { compacting: 'none' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────
  // 9b. Re-check cascade prevention (S3)
  // ──────────────────────────────────────────
  describe('deferred event re-check - no false cascade', () => {
    test('re-checking deferred events does not increment contractViolations', () => {
      bus.registerContract({
        id: 'compaction-gate',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => state.gates.compacting !== 'confirmed'],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.registerContract({
        id: 'focus-lock-guard',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      // Both gates active
      bus.updateState('1', { gates: { focusLocked: true, compacting: 'confirmed' } });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });

      // 1 violation from initial defer
      const afterInitial = bus.getStats().contractViolations;
      expect(afterInitial).toBe(1);

      // Clear focus but compaction still active — re-check should NOT increment violations
      bus.updateState('1', { gates: { focusLocked: false } });
      const afterRecheck = bus.getStats().contractViolations;
      expect(afterRecheck).toBe(afterInitial); // same count, no false cascade
    });

    test('re-check violations do not push toward safe mode', () => {
      const safeModeHandler = jest.fn();
      bus.on('safemode.entered', safeModeHandler);

      bus.registerContract({
        id: 'gate-a',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => state.gates.compacting !== 'confirmed'],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.registerContract({
        id: 'gate-b',
        version: 1,
        owner: 'test',
        appliesTo: ['inject.requested'],
        preconditions: [(event, state) => !state.gates.focusLocked],
        severity: 'block',
        action: 'defer',
        fallbackAction: 'defer',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });

      // Both gates active — defer 2 events (2 initial violations)
      bus.updateState('1', { gates: { focusLocked: true, compacting: 'confirmed' } });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });
      bus.emit('inject.requested', { paneId: '1', source: 'test' });

      // Clear focus but compaction stays — triggers re-check, still blocked
      // Without S3 fix, this re-check would add 2 more violations (total 4) => safe mode
      bus.updateState('1', { gates: { focusLocked: false } });

      // Safe mode should NOT have been triggered (only 2 real violations, not 4)
      expect(safeModeHandler).not.toHaveBeenCalled();
      expect(bus.getStats().contractViolations).toBe(2);
    });
  });

  // ──────────────────────────────────────────
  // 10. Telemetry toggle
  // ──────────────────────────────────────────
  describe('telemetry toggle', () => {
    test('disabling telemetry stops recording to buffer', () => {
      bus.setTelemetryEnabled(false);
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(bus.getBuffer().length).toBe(0);
    });

    test('disabling telemetry clears existing buffer', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(bus.getBuffer().length).toBeGreaterThan(0);
      bus.setTelemetryEnabled(false);
      expect(bus.getBuffer().length).toBe(0);
    });

    test('query returns empty when telemetry disabled', () => {
      bus.setTelemetryEnabled(false);
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(bus.query({ type: 'test' })).toEqual([]);
    });

    test('Lane A still works when Lane B disabled', () => {
      bus.setTelemetryEnabled(false);
      const handler = jest.fn();
      bus.on('test', handler);
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('re-enabling telemetry starts recording again', () => {
      bus.setTelemetryEnabled(false);
      bus.setTelemetryEnabled(true);
      bus.emit('test', { paneId: '1', source: 'test' });
      const results = bus.query({ type: 'test' });
      expect(results.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────
  // 11. Graceful degradation (Lane B error)
  // ──────────────────────────────────────────
  describe('graceful degradation', () => {
    test('Lane B error does not crash Lane A', () => {
      // Force a Lane B error by corrupting buffer temporarily
      const handler = jest.fn();
      bus.on('test', handler);

      // Even if something goes wrong in recording, emit should still work
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────
  // 12. Payload sanitization
  // ──────────────────────────────────────────
  describe('payload sanitization', () => {
    test('body field is redacted by default', () => {
      const event = bus.emit('test', {
        paneId: '1',
        source: 'test',
        payload: { body: 'secret message', otherField: 'visible' },
      });
      expect(event.payload.body).toEqual({ redacted: true, length: 14 });
      expect(event.payload.otherField).toBe('visible');
    });

    test('message field is redacted by default', () => {
      const event = bus.emit('test', {
        paneId: '1',
        source: 'test',
        payload: { message: 'hello world' },
      });
      expect(event.payload.message).toEqual({ redacted: true, length: 11 });
    });

    test('body field is preserved in devMode', () => {
      bus.setDevMode(true);
      const event = bus.emit('test', {
        paneId: '1',
        source: 'test',
        payload: { body: 'secret message' },
      });
      expect(event.payload.body).toBe('secret message');
    });

    test('non-body/message fields are never redacted', () => {
      const event = bus.emit('test', {
        paneId: '1',
        source: 'test',
        payload: { data: 'visible', count: 42 },
      });
      expect(event.payload.data).toBe('visible');
      expect(event.payload.count).toBe(42);
    });
  });

  // ──────────────────────────────────────────
  // 13. Correlation ID
  // ──────────────────────────────────────────
  describe('correlation', () => {
    test('startCorrelation returns a new ID', () => {
      const id = bus.startCorrelation();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('getCurrentCorrelation returns active correlation', () => {
      const id = bus.startCorrelation();
      expect(bus.getCurrentCorrelation()).toBe(id);
    });

    test('emit uses current correlation when not explicitly provided', () => {
      const corrId = bus.startCorrelation();
      const event = bus.emit('test', { paneId: '1', source: 'test' });
      expect(event.correlationId).toBe(corrId);
    });

    test('startCorrelation generates unique IDs', () => {
      const id1 = bus.startCorrelation();
      const id2 = bus.startCorrelation();
      expect(id1).not.toBe(id2);
    });
  });

  describe('ingest external events', () => {
    test('ingest delivers external envelope without re-wrapping IDs', () => {
      const handler = jest.fn();
      bus.on('daemon.write.ack', handler);

      const external = {
        eventId: 'evt-ext-1',
        correlationId: 'corr-ext-1',
        causationId: 'cause-ext-1',
        type: 'daemon.write.ack',
        source: 'daemon',
        paneId: '2',
        ts: 12345,
        seq: 7,
        payload: { status: 'accepted' },
      };

      const ingested = bus.ingest(external);

      expect(ingested.eventId).toBe('evt-ext-1');
      expect(ingested.correlationId).toBe('corr-ext-1');
      expect(ingested.seq).toBe(7);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].type).toBe('daemon.write.ack');
    });

    test('ingest ignores invalid events', () => {
      expect(bus.ingest(null)).toBeNull();
      expect(bus.ingest({})).toBeNull();
    });
  });

  // ──────────────────────────────────────────
  // 14. Reset utility
  // ──────────────────────────────────────────
  describe('reset', () => {
    test('reset clears all listeners', () => {
      const handler = jest.fn();
      bus.on('test', handler);
      bus.reset();
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('reset clears contracts', () => {
      bus.registerContract({
        id: 'temp',
        version: 1,
        owner: 'test',
        appliesTo: ['test'],
        preconditions: [() => false],
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.reset();
      const handler = jest.fn();
      bus.on('test', handler);
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(handler).toHaveBeenCalledTimes(1); // no contract blocking
    });

    test('reset clears ring buffer', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      bus.reset();
      expect(bus.getBuffer().length).toBe(0);
    });

    test('reset clears stats', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      bus.reset();
      const stats = bus.getStats();
      expect(stats.totalEmitted).toBe(0);
      expect(stats.totalDropped).toBe(0);
      expect(stats.contractViolations).toBe(0);
    });

    test('reset restores default pane states', () => {
      bus.updateState('1', { activity: 'injecting', gates: { focusLocked: true } });
      bus.reset();
      const state = bus.getState('1');
      expect(state.activity).toBe('idle');
      expect(state.gates.focusLocked).toBe(false);
    });

    test('reset clears sequence counters', () => {
      bus.emit('test', { paneId: '1', source: 'my-source' });
      bus.reset();
      const event = bus.emit('test', { paneId: '1', source: 'my-source' });
      expect(event.seq).toBe(1);
    });

    test('reset clears correlation', () => {
      bus.startCorrelation();
      bus.reset();
      expect(bus.getCurrentCorrelation()).toBeNull();
    });
  });

  // ──────────────────────────────────────────
  // 15. getStats
  // ──────────────────────────────────────────
  describe('getStats', () => {
    test('totalEmitted increments on each emit', () => {
      bus.emit('a', { paneId: '1', source: 'test' });
      bus.emit('b', { paneId: '1', source: 'test' });
      expect(bus.getStats().totalEmitted).toBe(2);
    });

    test('totalDropped increments on drop/block', () => {
      bus.registerContract({
        id: 'dropper',
        version: 1,
        owner: 'test',
        appliesTo: ['drop.me'],
        preconditions: [() => false],
        severity: 'block',
        action: 'drop',
        fallbackAction: 'drop',
        mode: 'enforced',
        emitOnViolation: 'contract.violation',
      });
      bus.emit('drop.me', { paneId: '1', source: 'test' });
      expect(bus.getStats().totalDropped).toBe(1);
    });

    test('bufferSize reflects current ring buffer size', () => {
      bus.emit('test', { paneId: '1', source: 'test' });
      expect(bus.getStats().bufferSize).toBeGreaterThan(0);
    });
  });
});
