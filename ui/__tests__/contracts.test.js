/**
 * Tests for modules/contracts.js
 * Covers all 4 day-1 enforced contracts and their integration with the event bus.
 */

describe('contracts', () => {
  let bus;
  let contracts;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bus = require('../modules/event-bus');
    bus.reset();
    contracts = require('../modules/contracts');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('module exports', () => {
    test('exports init function', () => {
      expect(typeof contracts.init).toBe('function');
    });

    test('exports CONTRACTS array with 4 contracts', () => {
      expect(Array.isArray(contracts.CONTRACTS)).toBe(true);
      expect(contracts.CONTRACTS.length).toBe(4);
    });

    test('exports individual contract definitions', () => {
      expect(contracts.FOCUS_LOCK_GUARD).toBeDefined();
      expect(contracts.COMPACTION_GATE).toBeDefined();
      expect(contracts.OWNERSHIP_EXCLUSIVE).toBeDefined();
      expect(contracts.OVERLAY_FIT_EXCLUSION).toBeDefined();
    });

    test('all contracts have required fields', () => {
      for (const c of contracts.CONTRACTS) {
        expect(c.id).toBeDefined();
        expect(c.version).toBe(1);
        expect(c.owner).toBe('contracts.js');
        expect(Array.isArray(c.appliesTo)).toBe(true);
        expect(Array.isArray(c.preconditions)).toBe(true);
        expect(c.preconditions.length).toBeGreaterThan(0);
        expect(c.severity).toBeDefined();
        expect(c.action).toBeDefined();
        expect(c.mode).toBe('enforced');
      }
    });
  });

  describe('init', () => {
    test('registers all contracts on the bus', () => {
      contracts.init(bus);
      // Verify contracts are active by testing they affect events
      bus.updateState('1', { gates: { focusLocked: true } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      // Handler should NOT be called because focus-lock-guard defers
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('focus-lock-guard', () => {
    beforeEach(() => {
      contracts.init(bus);
    });

    test('allows inject.requested when focusLocked is false', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: { text: 'hello' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('defers inject.requested when focusLocked is true', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: { text: 'hello' } });
      // Deferred — handler NOT called
      expect(handler).not.toHaveBeenCalled();
    });

    test('emits contract.violation on focus lock deferral', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const violHandler = jest.fn();
      bus.on('contract.violation', violHandler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(violHandler).toHaveBeenCalledTimes(1);
      expect(violHandler.mock.calls[0][0].payload.contractId).toBe('focus-lock-guard');
      expect(violHandler.mock.calls[0][0].payload.action).toBe('defer');
    });

    test('resumes deferred event when focus lock clears', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: { text: 'queued' } });
      expect(handler).not.toHaveBeenCalled();

      // Clear the focus lock — deferred events should resume
      bus.updateState('1', { gates: { focusLocked: false } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('does not affect non-inject events', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const handler = jest.fn();
      bus.on('resize.started', handler);
      bus.emit('resize.started', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('precondition function returns correct boolean', () => {
      const precond = contracts.FOCUS_LOCK_GUARD.preconditions[0];
      const event = {};
      expect(precond(event, { gates: { focusLocked: false } })).toBe(true);
      expect(precond(event, { gates: { focusLocked: true } })).toBe(false);
    });
  });

  describe('compaction-gate', () => {
    beforeEach(() => {
      contracts.init(bus);
    });

    test('allows inject.requested when compacting is none', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('allows inject.requested when compacting is suspected', () => {
      bus.updateState('1', { gates: { compacting: 'suspected' } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('defers inject.requested when compacting is confirmed', () => {
      bus.updateState('1', { gates: { compacting: 'confirmed' } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    test('allows inject.requested when compacting is cooldown', () => {
      bus.updateState('1', { gates: { compacting: 'cooldown' } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('resumes deferred event when compaction ends', () => {
      bus.updateState('1', { gates: { compacting: 'confirmed' } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).not.toHaveBeenCalled();

      // Compaction ends
      bus.updateState('1', { gates: { compacting: 'cooldown' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('precondition function checks for confirmed state only', () => {
      const precond = contracts.COMPACTION_GATE.preconditions[0];
      const event = {};
      expect(precond(event, { gates: { compacting: 'none' } })).toBe(true);
      expect(precond(event, { gates: { compacting: 'suspected' } })).toBe(true);
      expect(precond(event, { gates: { compacting: 'confirmed' } })).toBe(false);
      expect(precond(event, { gates: { compacting: 'cooldown' } })).toBe(true);
    });
  });

  describe('ownership-exclusive', () => {
    beforeEach(() => {
      contracts.init(bus);
    });

    test('allows inject.requested when activity is idle', () => {
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('blocks inject.requested when activity is injecting', () => {
      bus.updateState('1', { activity: 'injecting' });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      // Blocked — handler NOT called
      expect(handler).not.toHaveBeenCalled();
    });

    test('blocks resize.requested when activity is not idle', () => {
      bus.updateState('1', { activity: 'resizing' });
      const handler = jest.fn();
      bus.on('resize.requested', handler);
      bus.emit('resize.requested', { paneId: '1', payload: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    test('allows resize.requested when activity is idle', () => {
      const handler = jest.fn();
      bus.on('resize.requested', handler);
      bus.emit('resize.requested', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('emits contract.violation with block action', () => {
      bus.updateState('1', { activity: 'injecting' });
      const violHandler = jest.fn();
      bus.on('contract.violation', violHandler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(violHandler).toHaveBeenCalledTimes(1);
      expect(violHandler.mock.calls[0][0].payload.contractId).toBe('ownership-exclusive');
      expect(violHandler.mock.calls[0][0].payload.action).toBe('block');
    });

    test('precondition function returns correct boolean', () => {
      const precond = contracts.OWNERSHIP_EXCLUSIVE.preconditions[0];
      const event = {};
      expect(precond(event, { activity: 'idle' })).toBe(true);
      expect(precond(event, { activity: 'injecting' })).toBe(false);
      expect(precond(event, { activity: 'resizing' })).toBe(false);
      expect(precond(event, { activity: 'recovering' })).toBe(false);
      expect(precond(event, { activity: 'error' })).toBe(false);
    });
  });

  describe('overlay-fit-exclusion', () => {
    beforeEach(() => {
      contracts.init(bus);
    });

    test('allows resize.started when overlay is closed', () => {
      const handler = jest.fn();
      bus.on('resize.started', handler);
      bus.emit('resize.started', { paneId: '1', payload: {} });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]._skipped).toBeFalsy();
    });

    test('skips resize.started when overlay is open', () => {
      bus.updateState('system', { overlay: { open: true } });
      const handler = jest.fn();
      bus.on('resize.started', handler);
      const event = bus.emit('resize.started', { paneId: 'system', payload: {} });
      // Skip action: event still fires but _skipped is set
      expect(handler).toHaveBeenCalledTimes(1);
      expect(event._skipped).toBe(true);
    });

    test('emits contract.violation with skip action on overlay open', () => {
      bus.updateState('system', { overlay: { open: true } });
      const violHandler = jest.fn();
      bus.on('contract.violation', violHandler);
      bus.emit('resize.started', { paneId: 'system', payload: {} });
      expect(violHandler).toHaveBeenCalledTimes(1);
      expect(violHandler.mock.calls[0][0].payload.contractId).toBe('overlay-fit-exclusion');
      expect(violHandler.mock.calls[0][0].payload.action).toBe('skip');
    });

    test('does not affect inject.requested', () => {
      bus.updateState('system', { overlay: { open: true } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: 'system', payload: {} });
      // overlay-fit-exclusion does NOT apply to inject events
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('precondition function returns correct boolean', () => {
      const precond = contracts.OVERLAY_FIT_EXCLUSION.preconditions[0];
      const event = {};
      expect(precond(event, { overlay: { open: false } })).toBe(true);
      expect(precond(event, { overlay: { open: true } })).toBe(false);
    });
  });

  describe('contract interactions', () => {
    beforeEach(() => {
      contracts.init(bus);
    });

    test('focus-lock-guard takes priority over compaction-gate (both defer)', () => {
      bus.updateState('1', { gates: { focusLocked: true, compacting: 'confirmed' } });
      const violHandler = jest.fn();
      bus.on('contract.violation', violHandler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      // First matching contract wins (focus-lock-guard)
      expect(violHandler).toHaveBeenCalledTimes(1);
      expect(violHandler.mock.calls[0][0].payload.contractId).toBe('focus-lock-guard');
    });

    test('ownership-exclusive blocks even when focus is not locked', () => {
      bus.updateState('1', { activity: 'injecting' });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '1', payload: {} });
      expect(handler).not.toHaveBeenCalled();
    });

    test('pane isolation — lock on pane 1 does not affect pane 2', () => {
      bus.updateState('1', { gates: { focusLocked: true } });
      const handler = jest.fn();
      bus.on('inject.requested', handler);
      bus.emit('inject.requested', { paneId: '2', payload: {} });
      // Pane 2 is not locked — should pass
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('state vector overlay extension', () => {
    test('default state vector includes overlay: { open: false }', () => {
      const state = bus.getState('1');
      expect(state.overlay).toBeDefined();
      expect(state.overlay.open).toBe(false);
    });

    test('updateState merges overlay patch', () => {
      bus.updateState('1', { overlay: { open: true } });
      const state = bus.getState('1');
      expect(state.overlay.open).toBe(true);
    });

    test('updateState for overlay does not affect other state', () => {
      bus.updateState('1', { overlay: { open: true } });
      const state = bus.getState('1');
      expect(state.activity).toBe('idle');
      expect(state.gates.focusLocked).toBe(false);
    });
  });
});
