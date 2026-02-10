/**
 * Tests for modules/compaction-detector.js
 * Covers the 4-state compaction detection machine, multi-signal scoring,
 * timing thresholds, false positive mitigations, and per-pane isolation.
 */

describe('compaction-detector', () => {
  let bus;
  let detector;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bus = require('../modules/event-bus');
    bus.reset();
    detector = require('../modules/compaction-detector');
    detector.reset();
    detector.init(bus);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Helper: generate output that triggers lexical signal
  function lexicalChunk() {
    return 'The system is compacting the conversation to save space.';
  }

  // Helper: generate output that triggers structured block signal
  function structuredChunk() {
    return '## Summary\n- First important point about the project\n- Second important point about architecture\n- Third important detail about implementation';
  }

  // Helper: generic output that does not trigger any signal
  function neutralChunk() {
    return 'Hello, how can I help you today?';
  }

  // Helper: prompt-ready output
  function promptChunk() {
    return 'Done processing.\n$ ';
  }

  // Helper: advance time and feed chunks to build up burst_no_prompt signal
  function buildBurstSignal(paneId, count = 6) {
    for (let i = 0; i < count; i++) {
      detector.processChunk(paneId, 'some output without prompt\n');
    }
  }

  describe('module exports', () => {
    test('exports init, processChunk, getState, reset', () => {
      expect(typeof detector.init).toBe('function');
      expect(typeof detector.processChunk).toBe('function');
      expect(typeof detector.getState).toBe('function');
      expect(typeof detector.reset).toBe('function');
    });

    test('exports detection constants', () => {
      expect(detector.T_SUSPECT).toBe(0.3);
      expect(detector.T_CONFIRM).toBe(0.6);
      expect(detector.DETECTOR_VERSION).toBe(1);
    });
  });

  describe('initial state', () => {
    test('starts in none state', () => {
      const state = detector.getState('1');
      expect(state.state).toBe('none');
      expect(state.confidence).toBe(0);
    });

    test('each pane has independent state', () => {
      const s1 = detector.getState('1');
      const s2 = detector.getState('2');
      expect(s1).not.toBe(s2);
    });
  });

  describe('signal scoring', () => {
    test('lexical signal produces weight 0.3', () => {
      // Feed a single lexical chunk — not enough to transition immediately
      // (needs sustained for 300ms) but should register
      detector.processChunk('1', lexicalChunk());
      const state = detector.getState('1');
      expect(state.confidence).toBeGreaterThanOrEqual(0.3);
      expect(state.activeSignals.has('lexical')).toBe(true);
    });

    test('structured block signal produces weight 0.5', () => {
      detector.processChunk('1', structuredChunk());
      const state = detector.getState('1');
      expect(state.confidence).toBeGreaterThanOrEqual(0.5);
      expect(state.activeSignals.has('structured')).toBe(true);
    });

    test('burst without prompt signal activates after multiple chunks', () => {
      buildBurstSignal('1', 6);
      const state = detector.getState('1');
      expect(state.activeSignals.has('burst_no_prompt')).toBe(true);
    });

    test('no-causation signal activates when no recent inject', () => {
      // No inject.requested has been emitted — so any output should trigger no_causation
      detector.processChunk('1', lexicalChunk());
      const state = detector.getState('1');
      expect(state.activeSignals.has('no_causation')).toBe(true);
    });

    test('no-causation signal suppressed by recent inject', () => {
      // Emit inject.requested for pane 1
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', lexicalChunk());
      const state = detector.getState('1');
      expect(state.activeSignals.has('no_causation')).toBe(false);
    });

    test('neutral chunk produces only no_causation confidence (0.2)', () => {
      // With no recent inject.requested, no_causation signal fires (weight 0.2)
      detector.processChunk('1', neutralChunk());
      const state = detector.getState('1');
      expect(state.confidence).toBe(0.2);
      expect(state.activeSignals.has('no_causation')).toBe(true);
      expect(state.activeSignals.has('lexical')).toBe(false);
      expect(state.activeSignals.has('structured')).toBe(false);
    });

    test('neutral chunk produces zero confidence with recent inject', () => {
      // Suppress no_causation by emitting a recent inject
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', neutralChunk());
      const state = detector.getState('1');
      expect(state.confidence).toBe(0);
    });

    test('confidence capped at 1.0', () => {
      // Build up all signals
      buildBurstSignal('1', 6);
      // Now send structured + lexical chunk (0.5 + 0.3 + 0.3 burst + 0.2 no_causation = 1.3)
      detector.processChunk('1', structuredChunk() + '\ncompacting the conversation\n');
      const state = detector.getState('1');
      expect(state.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('none -> suspected transition', () => {
    test('requires confidence >= T_SUSPECT sustained for 300ms', () => {
      // First chunk sets confidence but not sustained yet
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('none');

      // Advance 300ms and send another chunk
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');
    });

    test('does not transition if confidence drops before sustain period', () => {
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('none');

      // Advance less than 300ms and send neutral chunk (confidence drops)
      jest.advanceTimersByTime(100);
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('none');
    });

    test('emits cli.compaction.suspected event', () => {
      const handler = jest.fn();
      bus.on('cli.compaction.suspected', handler);

      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.detectorVersion).toBe(1);
      expect(handler.mock.calls[0][0].payload.signals).toContain('lexical');
    });

    test('updates compacting gate to suspected', () => {
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());

      const state = bus.getState('1');
      expect(state.gates.compacting).toBe('suspected');
    });
  });

  describe('suspected -> confirmed transition', () => {
    // Helper to get into suspected state
    function enterSuspected(paneId = '1') {
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk(paneId, lexicalChunk());
      expect(detector.getState(paneId).state).toBe('suspected');
    }

    test('requires confidence >= T_CONFIRM sustained for 800ms', () => {
      // Build suspected state and reach confirmed only via sustained confidence, not rapid hits
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Enter suspected
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');

      // Expire all suspect hits (2s window)
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Reset sustainedSince with a mid-range chunk (suspectHit #1)
      detector.processChunk('1', lexicalChunk());

      // Expire that suspect hit too
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Now start clean: send T_CONFIRM chunk (suspectHit #1 at fresh window)
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n');
      expect(detector.getState('1').state).toBe('suspected');

      // Sustain for 800ms (suspectHit #2 — still only 2, not rapid)
      jest.advanceTimersByTime(800);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n');
      expect(detector.getState('1').state).toBe('confirmed');
    });

    test('rapid suspect hits (3 in 2s) promote to confirmed', () => {
      enterSuspected();

      // The enterSuspected already pushed one suspect hit
      // Push 2 more quickly
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());

      expect(detector.getState('1').state).toBe('confirmed');
    });

    test('does not confirm from burst_no_prompt + no_causation alone', () => {
      // Build suspected state without lexical/structured evidence.
      buildBurstSignal('1', 6);
      jest.advanceTimersByTime(300);
      detector.processChunk('1', 'streaming output without lexical markers\n');
      expect(detector.getState('1').state).toBe('suspected');
      expect(detector.getState('1').activeSignals.has('lexical')).toBe(false);

      // Rapid suspect hits should NOT promote without lexical evidence.
      jest.advanceTimersByTime(100);
      detector.processChunk('1', 'streaming output without lexical markers\n');
      jest.advanceTimersByTime(100);
      detector.processChunk('1', 'streaming output without lexical markers\n');

      expect(detector.getState('1').state).toBe('suspected');
      expect(bus.getState('1').gates.compacting).toBe('suspected');
    });

    test('emits cli.compaction.started event', () => {
      const handler = jest.fn();
      bus.on('cli.compaction.started', handler);

      // Build suspected state with controlled timing
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');

      // Expire all old suspect hits (2s window)
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Reset sustainedSince with a mid-range chunk
      detector.processChunk('1', lexicalChunk()); // suspectHit #1 at t=2400

      // Wait for this suspect hit to expire too
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Now start the sustained high confidence measurement with clean suspect history
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n'); // suspectHit #1 at t=4500
      jest.advanceTimersByTime(800);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n'); // suspectHit #2 at t=5300

      // Only 2 suspect hits in 2s window — not rapid fire
      // But 800ms sustained >= T_CONFIRM — should promote via sustained_confidence
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.transitionReason).toBe('sustained_confidence');
    });

    test('updates compacting gate to confirmed', () => {
      // Build suspected state and promote via sustained confidence
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');

      // Expire suspect hits + reset sustainedSince
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', lexicalChunk()); // mid-range, resets sustainedSince
      jest.advanceTimersByTime(2100);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Sustained T_CONFIRM for 800ms
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n');
      jest.advanceTimersByTime(800);
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      detector.processChunk('1', structuredChunk() + '\ncompacting conversation\n');

      expect(bus.getState('1').gates.compacting).toBe('confirmed');
    });
  });

  describe('suspected -> none decay', () => {
    function enterSuspected(paneId = '1') {
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk(paneId, lexicalChunk());
      expect(detector.getState(paneId).state).toBe('suspected');
    }

    test('decays back to none when confidence drops below T_SUSPECT for 500ms', () => {
      enterSuspected();

      // Send neutral chunks (confidence = 0)
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('suspected');

      jest.advanceTimersByTime(500);
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('none');
    });

    test('does not decay if confidence is sustained above T_SUSPECT', () => {
      enterSuspected();

      jest.advanceTimersByTime(500);
      detector.processChunk('1', lexicalChunk()); // keep confidence up
      expect(detector.getState('1').state).toBe('suspected');
    });
  });

  describe('confirmed -> cooldown transition', () => {
    function enterConfirmed(paneId = '1') {
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk(paneId, lexicalChunk());
      // Now in suspected — push rapid hits
      jest.advanceTimersByTime(100);
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk(paneId, lexicalChunk());
      expect(detector.getState(paneId).state).toBe('confirmed');
    }

    test('prompt-ready triggers cooldown', () => {
      enterConfirmed();

      detector.processChunk('1', promptChunk());
      expect(detector.getState('1').state).toBe('cooldown');
    });

    test('confidence decay below 0.2 for 500ms triggers cooldown', () => {
      enterConfirmed();

      // Suppress no_causation so neutral chunks don't get 0.2 weight
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Send a prompt-containing neutral chunk to reset chunksSincePrompt
      // (enterConfirmed accumulates chunks, so burst_no_prompt could fire)
      // Use a chunk with just a prompt to reset, but since state is confirmed,
      // this would trigger cooldown. Instead, directly manipulate the state.
      // Actually, just use chunks with prompt character to prevent burst_no_prompt
      // but that would trigger cooldown. So: use multiple neutral chunks and
      // accept that chunksSincePrompt will build. The key is to keep it below 5.
      // enterConfirmed processes 4 chunks. With no_causation suppressed and
      // chunksSincePrompt at 4, the next chunk makes it 5, triggering burst_no_prompt (0.3).
      // But 0.3 > 0.2, so decay doesn't trigger. We need chunksSincePrompt < 4 going in.

      // Reset chunksSincePrompt by accessing internal state directly (test-only)
      detector.getState('1').chunksSincePrompt = 0;

      // Send neutral chunks (with no_causation suppressed, burst under threshold: confidence = 0)
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('confirmed');

      jest.advanceTimersByTime(500);
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('cooldown');
    });

    test('emits cli.compaction.ended event', () => {
      const handler = jest.fn();
      bus.on('cli.compaction.ended', handler);

      enterConfirmed();
      detector.processChunk('1', promptChunk());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.endReason).toBe('prompt_ready');
      expect(handler.mock.calls[0][0].payload.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('updates compacting gate to cooldown', () => {
      enterConfirmed();
      detector.processChunk('1', promptChunk());

      expect(bus.getState('1').gates.compacting).toBe('cooldown');
    });
  });

  describe('cooldown -> none transition', () => {
    function enterCooldown(paneId = '1') {
      // Reach confirmed
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk(paneId, lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk(paneId, lexicalChunk());
      expect(detector.getState(paneId).state).toBe('confirmed');
      // Trigger cooldown via prompt
      detector.processChunk(paneId, promptChunk());
      expect(detector.getState(paneId).state).toBe('cooldown');
    }

    test('returns to none after 1500ms with no renewed evidence', () => {
      enterCooldown();

      jest.advanceTimersByTime(1500);
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('none');
    });

    test('renewed evidence during cooldown goes back to confirmed', () => {
      enterCooldown();

      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('confirmed');
    });

    test('updates compacting gate to none on cooldown exit', () => {
      enterCooldown();

      jest.advanceTimersByTime(1500);
      detector.processChunk('1', neutralChunk());
      expect(bus.getState('1').gates.compacting).toBe('none');
    });
  });

  describe('per-pane isolation', () => {
    test('compaction on pane 1 does not affect pane 2', () => {
      // Get pane 1 to suspected
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');

      // Pane 2 should be clean
      expect(detector.getState('2').state).toBe('none');
    });

    test('inject.requested tracks per pane', () => {
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });

      // Pane 1 has recent inject
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').activeSignals.has('no_causation')).toBe(false);

      // Pane 2 does NOT have recent inject
      detector.processChunk('2', lexicalChunk());
      expect(detector.getState('2').activeSignals.has('no_causation')).toBe(true);
    });
  });

  describe('false positive mitigations', () => {
    test('single lexical match alone needs sustained 300ms', () => {
      // Single lexical chunk should NOT immediately transition
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('none');
    });

    test('prompt in output resets chunksSincePrompt', () => {
      buildBurstSignal('1', 6);
      expect(detector.getState('1').activeSignals.has('burst_no_prompt')).toBe(true);

      // Now send prompt
      detector.processChunk('1', promptChunk());
      // Reset burst counter
      const state = detector.getState('1');
      expect(state.chunksSincePrompt).toBe(0);
    });

    test('recent inject suppresses no_causation signal', () => {
      bus.emit('inject.requested', { paneId: '1', payload: {}, source: 'test' });
      buildBurstSignal('1', 6);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').activeSignals.has('no_causation')).toBe(false);
    });

    test('cooldown prevents immediate re-trigger (hysteresis)', () => {
      // Get to confirmed
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('confirmed');

      // End compaction
      detector.processChunk('1', promptChunk());
      expect(detector.getState('1').state).toBe('cooldown');

      // Before cooldown expires, neutral output should stay in cooldown
      jest.advanceTimersByTime(500);
      detector.processChunk('1', neutralChunk());
      expect(detector.getState('1').state).toBe('cooldown');
    });

    test('ongoing chunks keep confirmed state active past inactivity window', () => {
      // Reach confirmed
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('confirmed');

      // Continue receiving non-lexical output; should NOT decay while stream is active.
      for (let i = 0; i < 7; i++) {
        jest.advanceTimersByTime(1000);
        detector.processChunk('1', 'streaming output still in progress\n');
        expect(detector.getState('1').state).toBe('confirmed');
      }

      expect(bus.getState('1').gates.compacting).toBe('confirmed');
    });

    test('inactivity timer resets confirmed state to none', () => {
      const ended = jest.fn();
      bus.on('cli.compaction.ended', ended);

      // Reach confirmed
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(100);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('confirmed');
      expect(bus.getState('1').gates.compacting).toBe('confirmed');

      // No new chunks: inactivity timer should force reset.
      jest.advanceTimersByTime(detector.EVIDENCE_DECAY_RESET_MS + 10);

      expect(detector.getState('1').state).toBe('none');
      expect(bus.getState('1').gates.compacting).toBe('none');
      expect(ended).toHaveBeenCalled();
      const lastCall = ended.mock.calls[ended.mock.calls.length - 1][0];
      expect(lastCall.payload.endReason).toBe('chunk_inactivity_timeout');
    });
  });

  describe('edge cases', () => {
    test('processChunk ignores null/undefined data', () => {
      expect(() => detector.processChunk('1', null)).not.toThrow();
      expect(() => detector.processChunk('1', undefined)).not.toThrow();
      expect(() => detector.processChunk('1', '')).not.toThrow();
    });

    test('processChunk ignores non-string data', () => {
      expect(() => detector.processChunk('1', 123)).not.toThrow();
      expect(() => detector.processChunk('1', {})).not.toThrow();
    });

    test('reset clears all pane states', () => {
      detector.processChunk('1', lexicalChunk());
      jest.advanceTimersByTime(300);
      detector.processChunk('1', lexicalChunk());
      expect(detector.getState('1').state).toBe('suspected');

      detector.reset();
      detector.init(bus);
      expect(detector.getState('1').state).toBe('none');
    });

    test('works without bus initialized', () => {
      detector.reset();
      // No init — bus is null
      expect(() => detector.processChunk('1', lexicalChunk())).not.toThrow();
    });
  });
});
