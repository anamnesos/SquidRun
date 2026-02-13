/**
 * Tests for event-bus emissions in modules/terminal/injection.js
 * Verifies that injection lifecycle events are emitted correctly.
 */

// Mock logger before requiring module
const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('../modules/logger', () => mockLog);

// Mock event-bus
const mockBus = {
  emit: jest.fn(),
  startCorrelation: jest.fn().mockReturnValue('test-corr-id'),
  getCurrentCorrelation: jest.fn().mockReturnValue('test-corr-id'),
  updateState: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
  getState: jest.fn(),
  reset: jest.fn(),
};
jest.mock('../modules/event-bus', () => mockBus);

const { createInjectionController } = require('../modules/terminal/injection');

describe('Injection Events', () => {
  const DEFAULT_CONSTANTS = {
    FOCUS_RETRY_DELAY_MS: 50,
    MAX_FOCUS_RETRIES: 3,
    QUEUE_RETRY_MS: 100,
    INJECTION_LOCK_TIMEOUT_MS: 1000,
    BYPASS_CLEAR_DELAY_MS: 250,
    TYPING_GUARD_MS: 300,
    GEMINI_ENTER_DELAY_MS: 75,
  };

  let terminals;
  let lastOutputTime;
  let lastTypedTime;
  let messageQueue;
  let mockPty;
  let controller;
  let mockTextarea;
  let mockPaneEl;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    terminals = new Map();
    lastOutputTime = {};
    lastTypedTime = {};
    messageQueue = {};

    mockPty = {
      sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
      writeChunked: jest.fn().mockResolvedValue({ success: true, chunks: 1, chunkSize: 2048 }),
      codexExec: jest.fn().mockResolvedValue(undefined),
    };
    global.window = {
      hivemind: { pty: mockPty },
    };

    mockTextarea = {
      focus: jest.fn(),
      value: '',
      dispatchEvent: jest.fn(),
    };
    mockPaneEl = {
      querySelector: jest.fn().mockReturnValue(mockTextarea),
    };

    global.document = {
      activeElement: null,
      querySelector: jest.fn((selector) => {
        if (selector.includes('data-pane-id')) return mockPaneEl;
        return null;
      }),
      body: {
        contains: jest.fn().mockReturnValue(true),
      },
    };
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    mockBus.emit.mockClear();
    mockBus.startCorrelation.mockClear();
    mockBus.startCorrelation.mockReturnValue('test-corr-id');
    mockBus.getCurrentCorrelation.mockClear();
    mockBus.getCurrentCorrelation.mockReturnValue('test-corr-id');
    mockBus.updateState.mockClear();

    controller = createInjectionController({
      terminals,
      lastOutputTime,
      lastTypedTime,
      messageQueue,
      isCodexPane: (id) => id === 'codex',
      isGeminiPane: (id) => id === 'gemini',
      buildCodexExecPrompt: (id, text) => text,
      userIsTyping: () => false,
      userInputFocused: () => false,
      updatePaneStatus: jest.fn(),
      markPotentiallyStuck: jest.fn(),
      getInjectionInFlight: () => false,
      setInjectionInFlight: jest.fn(),
      constants: DEFAULT_CONSTANTS,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
  });

  // ──────────────────────────────────────────
  // sendToPane: inject.requested, inject.queued, queue.depth.changed
  // ──────────────────────────────────────────
  describe('sendToPane events', () => {
    test('emits inject.requested with correct source and paneId', () => {
      const mockTerminal = { buffer: { active: {} } };
      terminals.set('1', mockTerminal);
      controller.sendToPane('1', 'test message');

      const requested = mockBus.emit.mock.calls.find(c => c[0] === 'inject.requested');
      expect(requested).toBeDefined();
      expect(requested[1].paneId).toBe('1');
      expect(requested[1].source).toBe('injection.js');
      expect(requested[1].correlationId).toBe('test-corr-id');
      expect(requested[1].payload.messageLen).toBe(12);
    });

    test('emits inject.queued after adding to queue', () => {
      const mockTerminal = { buffer: { active: {} } };
      terminals.set('1', mockTerminal);
      controller.sendToPane('1', 'test');

      const queued = mockBus.emit.mock.calls.find(c => c[0] === 'inject.queued');
      expect(queued).toBeDefined();
      expect(queued[1].paneId).toBe('1');
      expect(queued[1].source).toBe('injection.js');
      expect(queued[1].payload.depth).toBe(1);
    });

    test('emits queue.depth.changed on enqueue', () => {
      const mockTerminal = { buffer: { active: {} } };
      terminals.set('1', mockTerminal);
      controller.sendToPane('1', 'test');

      const depthChanged = mockBus.emit.mock.calls.find(c => c[0] === 'queue.depth.changed');
      expect(depthChanged).toBeDefined();
      expect(depthChanged[1].payload.depth).toBe(1);
    });

    test('starts a new correlation on each sendToPane call', () => {
      const mockTerminal = { buffer: { active: {} } };
      terminals.set('1', mockTerminal);
      controller.sendToPane('1', 'test');
      expect(mockBus.startCorrelation).toHaveBeenCalledTimes(1);
    });

    test('reuses incoming trace context instead of starting new correlation', () => {
      const mockTerminal = { buffer: { active: {} } };
      terminals.set('1', mockTerminal);
      controller.sendToPane('1', 'test', {
        traceContext: {
          traceId: 'trace-incoming-1',
          parentEventId: 'evt-parent-1',
        },
      });

      expect(mockBus.startCorrelation).not.toHaveBeenCalled();
      const requested = mockBus.emit.mock.calls.find(c => c[0] === 'inject.requested');
      expect(requested[1].correlationId).toBe('trace-incoming-1');
      expect(requested[1].causationId).toBe('evt-parent-1');
    });
  });

  // ──────────────────────────────────────────
  // processIdleQueue: inject.mode.selected, state updates
  // ──────────────────────────────────────────
  describe('processIdleQueue events', () => {
    test('emits inject.mode.selected for Claude panes', () => {
      const mockTerminal = {
        _hivemindBypass: false,
        buffer: { active: {} },
      };
      terminals.set('1', mockTerminal);
      messageQueue['1'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      controller.processIdleQueue('1');

      const modeSelected = mockBus.emit.mock.calls.find(c => c[0] === 'inject.mode.selected');
      expect(modeSelected).toBeDefined();
      expect(modeSelected[1].payload.mode).toBe('claude-pty');
    });

    test('emits inject.mode.selected for Codex panes', () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      messageQueue['codex'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      controller.processIdleQueue('codex');

      const modeSelected = mockBus.emit.mock.calls.find(c => c[0] === 'inject.mode.selected');
      expect(modeSelected).toBeDefined();
      expect(modeSelected[1].payload.mode).toBe('codex-exec');
    });

    test('emits inject.mode.selected for Gemini panes', () => {
      terminals.set('gemini', {});
      messageQueue['gemini'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      controller.processIdleQueue('gemini');

      const modeSelected = mockBus.emit.mock.calls.find(c => c[0] === 'inject.mode.selected');
      expect(modeSelected).toBeDefined();
      expect(modeSelected[1].payload.mode).toBe('gemini-pty');
    });

    test('updates state to injecting on dequeue', () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      messageQueue['codex'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      controller.processIdleQueue('codex');

      expect(mockBus.updateState).toHaveBeenCalledWith('codex', { activity: 'injecting' });
    });

    test('emits queue.depth.changed on dequeue', () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      messageQueue['codex'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      controller.processIdleQueue('codex');

      const depthCalls = mockBus.emit.mock.calls.filter(c => c[0] === 'queue.depth.changed');
      const dequeueCall = depthCalls.find(c => c[1].payload.depth === 0);
      expect(dequeueCall).toBeDefined();
    });
  });

  // ──────────────────────────────────────────
  // doSendToPane (Codex path): inject.applied, inject.submit.sent, inject.transform.applied
  // ──────────────────────────────────────────
  describe('doSendToPane Codex events', () => {
    test('emits inject.transform.applied, inject.applied, inject.submit.sent for Codex', (done) => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);

      controller.doSendToPane('codex', 'codex test', (result) => {
        expect(result.success).toBe(true);

        const transform = mockBus.emit.mock.calls.find(c => c[0] === 'inject.transform.applied');
        expect(transform).toBeDefined();
        expect(transform[1].payload.transform).toBe('codex-exec-prompt');

        const applied = mockBus.emit.mock.calls.find(c => c[0] === 'inject.applied');
        expect(applied).toBeDefined();
        expect(applied[1].payload.method).toBe('codex-exec');

        const submitSent = mockBus.emit.mock.calls.find(c => c[0] === 'inject.submit.sent');
        expect(submitSent).toBeDefined();
        expect(submitSent[1].payload.method).toBe('codex-exec');

        done();
      });

      // Flush timers for safety timer
      jest.advanceTimersByTime(100);
    });

    test('emits inject.failed on Codex exec error', async () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      mockPty.codexExec.mockRejectedValue(new Error('exec failed'));

      await new Promise((resolve) => {
        controller.doSendToPane('codex', 'test', resolve);
        jest.advanceTimersByTime(100);
      });

      // Allow promise rejection to propagate
      await jest.advanceTimersByTimeAsync(0);

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('codex_exec_error');
    });

    test('emits inject.failed when Codex exec is rejected by daemon', async () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      mockPty.codexExec.mockResolvedValue({
        success: false,
        status: 'rejected',
        error: 'busy',
      });

      const result = await new Promise((resolve) => {
        controller.doSendToPane('codex', 'test', resolve);
        jest.advanceTimersByTime(100);
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('codex_exec_rejected');

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('codex_exec_rejected');
      expect(failed[1].payload.status).toBe('rejected');
    });
  });

  // ──────────────────────────────────────────
  // doSendToPane (Gemini path): inject.applied, inject.submit.requested, inject.submit.sent
  // ──────────────────────────────────────────
  describe('doSendToPane Gemini events', () => {
    test('emits inject.applied and submit events for Gemini', async () => {
      terminals.set('gemini', {});

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('gemini', 'gemini test', resolve);
      });

      // Advance past Gemini Enter delay
      await jest.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(true);

      const applied = mockBus.emit.mock.calls.find(c => c[0] === 'inject.applied');
      expect(applied).toBeDefined();
      expect(applied[1].payload.method).toBe('gemini-pty');

      const submitRequested = mockBus.emit.mock.calls.find(c => c[0] === 'inject.submit.requested');
      expect(submitRequested).toBeDefined();
      expect(submitRequested[1].payload.method).toBe('gemini-pty-enter');

      const submitSent = mockBus.emit.mock.calls.find(c => c[0] === 'inject.submit.sent');
      expect(submitSent).toBeDefined();
    });

    test('emits inject.transform.applied when text contains newlines', async () => {
      terminals.set('gemini', {});

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('gemini', 'line1\nline2', resolve);
      });
      await jest.advanceTimersByTimeAsync(100);
      await resultPromise;

      const transform = mockBus.emit.mock.calls.find(c => c[0] === 'inject.transform.applied');
      expect(transform).toBeDefined();
      expect(transform[1].payload.transform).toBe('gemini-sanitize');
    });

    test('emits inject.failed on Gemini PTY write failure', async () => {
      terminals.set('gemini', {});
      // First write (Ctrl+U) succeeds, second (text) fails
      mockPty.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write failed'));

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('gemini', 'test', resolve);
      });
      await jest.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(false);

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('pty_write_failed');
    });

    test('emits inject.failed on Gemini Enter failure', async () => {
      terminals.set('gemini', {});
      // First write (Ctrl+U) succeeds, second (text) succeeds, third (Enter) fails
      mockPty.write
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('enter failed'));

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('gemini', 'test', resolve);
      });
      await jest.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.success).toBe(false);

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('pty_enter_failed');
    });
  });

  // ──────────────────────────────────────────
  // doSendToPane (Claude path): inject.applied, inject.submit, inject.failed
  // ──────────────────────────────────────────
  describe('doSendToPane Claude events', () => {
    test('emits inject.failed when textarea not found', (done) => {
      terminals.set('1', {});
      global.document.querySelector.mockReturnValue(null);

      controller.doSendToPane('1', 'test', (result) => {
        expect(result.success).toBe(false);

        const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
        expect(failed).toBeDefined();
        expect(failed[1].payload.reason).toBe('missing_textarea');
        done();
      });

      jest.advanceTimersByTime(100);
    });

    test('emits inject.applied after successful PTY write', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);
      global.document.activeElement = mockTextarea;

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('1', 'claude test', resolve);
      });

      // Advance past Ctrl+U write and text write (async), then Enter delay
      await jest.advanceTimersByTimeAsync(200);
      await resultPromise;

      const applied = mockBus.emit.mock.calls.find(c => c[0] === 'inject.applied');
      expect(applied).toBeDefined();
      expect(applied[1].payload.method).toBe('claude-pty');
      expect(applied[1].payload.textLen).toBe(11);
      expect(applied[1].source).toBe('injection.js');
    });

    test('emits inject.submit.requested and inject.submit.sent for Claude Enter', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);
      global.document.activeElement = mockTextarea;

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('1', 'test', resolve);
      });

      await jest.advanceTimersByTimeAsync(500);
      await resultPromise;

      const submitRequested = mockBus.emit.mock.calls.find(c => c[0] === 'inject.submit.requested');
      expect(submitRequested).toBeDefined();
      expect(submitRequested[1].payload.method).toBe('sendTrustedEnter');

      const submitSent = mockBus.emit.mock.calls.find(c => c[0] === 'inject.submit.sent');
      expect(submitSent).toBeDefined();
    });

    test('emits inject.failed on PTY write failure', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);
      global.document.activeElement = mockTextarea;
      // First write (Ctrl+U) succeeds, second (Home reset) succeeds, payload write fails
      mockPty.write
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write error'));

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('1', 'test', resolve);
      });

      await jest.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      expect(result.success).toBe(false);

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('pty_write_failed');
    });

    test('emits inject.failed on Enter send failure', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);
      global.document.activeElement = mockTextarea;
      mockPty.sendTrustedEnter.mockResolvedValue({ success: false, error: 'enter failed' });

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('1', 'test', resolve);
      });

      await jest.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      const failed = mockBus.emit.mock.calls.find(c => c[0] === 'inject.failed');
      expect(failed).toBeDefined();
      expect(failed[1].payload.reason).toBe('enter_failed');
    });

    test('emits inject.failed with submit_not_accepted after retry exhaustion', async () => {
      let promptText = 'ready> ';
      terminals.set('1', {
        _hivemindBypass: false,
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => ({
              translateToString: () => promptText,
            })),
          },
        },
      });
      global.document.activeElement = mockTextarea;
      mockPty.sendTrustedEnter.mockResolvedValue(undefined);

      const resultPromise = new Promise((resolve) => {
        controller.doSendToPane('1', 'test', resolve);
      });

      await jest.advanceTimersByTimeAsync(4000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      const submitSentCalls = mockBus.emit.mock.calls.filter(c => c[0] === 'inject.submit.sent');
      expect(submitSentCalls.length).toBe(2);

      const failed = mockBus.emit.mock.calls.find(
        c => c[0] === 'inject.failed' && c[1]?.payload?.reason === 'submit_not_accepted'
      );
      expect(failed).toBeDefined();
    });
  });

  // ──────────────────────────────────────────
  // Timeout events
  // ──────────────────────────────────────────
  describe('timeout events', () => {
    test('emits inject.timeout when safety timer fires', () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);
      global.document.activeElement = mockTextarea;
      // Make PTY write hang forever
      mockPty.write.mockReturnValue(new Promise(() => {}));

      controller.doSendToPane('1', 'test', jest.fn());

      // Advance past the INJECTION_LOCK_TIMEOUT_MS (1000ms)
      jest.advanceTimersByTime(1100);

      const timeout = mockBus.emit.mock.calls.find(c => c[0] === 'inject.timeout');
      expect(timeout).toBeDefined();
      expect(timeout[1].payload.timeoutMs).toBe(1000);
    });
  });

  // ──────────────────────────────────────────
  // State vector updates
  // ──────────────────────────────────────────
  describe('state vector updates', () => {
    test('updates state to idle after Codex injection completes', (done) => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      messageQueue['codex'] = [{ message: 'test', timestamp: Date.now(), correlationId: 'test-corr-id' }];

      // Override onComplete to check state
      const origProcessIdleQueue = controller.processIdleQueue;

      // Manually set up queue item with onComplete
      messageQueue['codex'] = [{
        message: 'test',
        timestamp: Date.now(),
        correlationId: 'test-corr-id',
        onComplete: () => {
          // After completion, state should have been set to idle
          const idleCalls = mockBus.updateState.mock.calls.filter(
            c => c[0] === 'codex' && c[1].activity === 'idle'
          );
          expect(idleCalls.length).toBeGreaterThan(0);
          done();
        },
      }];

      controller.processIdleQueue('codex');
      jest.advanceTimersByTime(100);
    });
  });

  // ──────────────────────────────────────────
  // All emit calls use correct source
  // ──────────────────────────────────────────
  describe('source consistency', () => {
    test('all injection events use source: injection.js', () => {
      const mockTerminal = { write: jest.fn() };
      terminals.set('codex', mockTerminal);
      controller.sendToPane('codex', 'test');

      const allEmitCalls = mockBus.emit.mock.calls;
      for (const call of allEmitCalls) {
        if (call[1] && call[1].source) {
          expect(call[1].source).toBe('injection.js');
        }
      }
    });
  });
});
