/**
 * Terminal Injection Tests
 * Target: Full coverage of modules/terminal/injection.js
 */

// Mock logger before requiring module
const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('../modules/logger', () => mockLog);

const { createInjectionController } = require('../modules/terminal/injection');
const bus = require('../modules/event-bus');
const IS_DARWIN = process.platform === 'darwin';

function getPtyEnterCallCount(mockPty, paneId = '1') {
  return mockPty.write.mock.calls.filter((call) => call[0] === paneId && call[1] === '\r').length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function timestampedPayloadRegex(value, { prefix = '' } = {}) {
  return new RegExp(`^${escapeRegExp(prefix)}\\[\\d{2}:\\d{2} local\\] ${escapeRegExp(value)}$`);
}

describe('Terminal Injection', () => {
  // Default constants matching the module
  const DEFAULT_CONSTANTS = {
    FOCUS_RETRY_DELAY_MS: 50,
    MAX_FOCUS_RETRIES: 3,
    QUEUE_RETRY_MS: 100,
    INJECTION_LOCK_TIMEOUT_MS: 1000,
    BYPASS_CLEAR_DELAY_MS: 250,
    TYPING_GUARD_MS: 300,
    MAX_COMPACTION_DEFER_MS: 8000,
    CLAUDE_CHUNK_SIZE: 2048,
    CLAUDE_CHUNK_MIN_SIZE: 1024,
    CLAUDE_CHUNK_MAX_SIZE: 8192,
    CLAUDE_CHUNK_THRESHOLD_BYTES: 1024,
    CLAUDE_CHUNK_YIELD_MS: 0,
    HM_SEND_FAST_CHUNK_THRESHOLD_BYTES: 256,
    HM_SEND_FAST_ENTER_DELAY_MS: 500,
  };

  // Mock objects
  let terminals;
  let lastOutputTime;
  let lastTypedTime;
  let messageQueue;
  let mockPty;
  let mockOptions;
  let controller;

  // Mock DOM elements
  let mockTextarea;
  let mockPaneEl;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    bus.reset();

    // Reset mock objects
    terminals = new Map();
    lastOutputTime = {};
    lastTypedTime = {};
    messageQueue = {};

    // Mock window.squidrun.pty
    mockPty = {
      sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
      writeChunked: jest.fn().mockResolvedValue({ success: true, chunks: 1, chunkSize: 2048 }),
      clipboardPasteText: jest.fn().mockResolvedValue({ success: true, method: 'insertText', insertedLength: 0 }),
      codexExec: jest.fn().mockResolvedValue(undefined),
    };
    global.window = {
      squidrun: { pty: mockPty },
    };

    // Mock DOM elements
    mockTextarea = {
      focus: jest.fn(),
      value: '',
      dispatchEvent: jest.fn(),
    };
    mockPaneEl = {
      querySelector: jest.fn().mockReturnValue(mockTextarea),
    };

    // Mock document
    global.document = {
      activeElement: null,
      querySelector: jest.fn((selector) => {
        if (selector.includes('data-pane-id')) {
          return mockPaneEl;
        }
        return null;
      }),
      body: {
        contains: jest.fn().mockReturnValue(true),
      },
    };

    global.KeyboardEvent = class KeyboardEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.key = options.key || '';
        this.code = options.code || '';
        this.keyCode = options.keyCode || 0;
        this.which = options.which || 0;
        this.bubbles = options.bubbles || false;
        this.cancelable = options.cancelable || false;
      }
    };

    // Default mock options
    mockOptions = {
      terminals,
      lastOutputTime,
      lastTypedTime,
      messageQueue,
      getPaneCapabilities: jest.fn().mockReturnValue(null),
      isCodexPane: jest.fn().mockReturnValue(false),
      isGeminiPane: jest.fn().mockReturnValue(false),  // Session 67: Added for Gemini PTY path
      buildCodexExecPrompt: jest.fn((id, text) => `prompt: ${text}`),
      userIsTyping: jest.fn().mockReturnValue(false),
      updatePaneStatus: jest.fn(),
      markPotentiallyStuck: jest.fn(),
      getInjectionInFlight: jest.fn().mockReturnValue(false),
      setInjectionInFlight: jest.fn(),
      constants: DEFAULT_CONSTANTS,
    };

    controller = createInjectionController(mockOptions);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.window;
    delete global.document;
    delete global.KeyboardEvent;
  });

  describe('createInjectionController', () => {
    test('creates controller with all methods', () => {
      expect(controller.focusWithRetry).toBeDefined();
      expect(controller.sendEnterToPane).toBeDefined();
      expect(controller.isPromptReady).toBeDefined();
      expect(controller.processIdleQueue).toBeDefined();
      expect(controller.doSendToPane).toBeDefined();
      expect(controller.sendToPane).toBeDefined();
      expect(controller.clearPaneQueue).toBeDefined();
    });

    test('works with default empty options', () => {
      const emptyController = createInjectionController({});
      expect(emptyController.focusWithRetry).toBeDefined();
    });
  });

  describe('focusWithRetry', () => {
    test('returns false for null textarea', async () => {
      const result = await controller.focusWithRetry(null);
      expect(result).toBe(false);
    });

    test('returns true when focus succeeds immediately', async () => {
      document.activeElement = mockTextarea;
      const result = await controller.focusWithRetry(mockTextarea);
      expect(result).toBe(true);
      expect(mockTextarea.focus).toHaveBeenCalled();
    });

    test('retries focus when first attempt fails', async () => {
      let focusAttempts = 0;
      mockTextarea.focus = jest.fn(() => {
        focusAttempts++;
        if (focusAttempts >= 2) {
          document.activeElement = mockTextarea;
        }
      });

      const promise = controller.focusWithRetry(mockTextarea, 3);

      // First attempt fails
      expect(document.activeElement).not.toBe(mockTextarea);

      // Advance through retry delays
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.FOCUS_RETRY_DELAY_MS);

      const result = await promise;
      expect(result).toBe(true);
      expect(focusAttempts).toBeGreaterThanOrEqual(2);
    });

    test('returns false after max retries exhausted', async () => {
      document.activeElement = null;

      const promise = controller.focusWithRetry(mockTextarea, 2);

      // Advance through all retry delays
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.FOCUS_RETRY_DELAY_MS * 3);

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('sendEnterToPane', () => {
    test('sets bypass flag and dispatches Enter via DOM events', async () => {
      const mockTerminal = { _squidrunBypass: false };
      terminals.set('1', mockTerminal);

      const result = await controller.sendEnterToPane('1');

      expect(result.success).toBe(true);
      expect(result.method).toBe('domFallback');
      expect(mockTextarea.dispatchEvent).toHaveBeenCalledTimes(3);
      expect(mockTerminal._squidrunBypass).toBe(true);
    });

    test('clears bypass flag after Enter', async () => {
      const mockTerminal = { _squidrunBypass: false };
      terminals.set('1', mockTerminal);

      await controller.sendEnterToPane('1');

      // Advance past bypass clear delay
      jest.advanceTimersByTime(DEFAULT_CONSTANTS.BYPASS_CLEAR_DELAY_MS + 5);

      expect(mockTerminal._squidrunBypass).toBe(false);
    });

    test('returns failure when DOM textarea is unavailable', async () => {
      document.querySelector.mockReturnValue(null);

      const result = await controller.sendEnterToPane('1');

      expect(result.success).toBe(false);
      expect(result.method).toBe('domFallback');
    });

    test('dispatches DOM events with bypass marker on each event', async () => {
      const mockTerminal = { _squidrunBypass: false };
      terminals.set('1', mockTerminal);

      mockTextarea.dispatchEvent = jest.fn();
      const result = await controller.sendEnterToPane('1');

      expect(result.success).toBe(true);
      expect(result.method).toBe('domFallback');
      expect(mockTextarea.dispatchEvent).toHaveBeenCalledTimes(3);
      const dispatchedEvents = mockTextarea.dispatchEvent.mock.calls.map(call => call[0]);
      dispatchedEvents.forEach((evt) => {
        expect(evt._squidrunBypass).toBe(true);
      });
    });

    test('works without terminal in map', async () => {
      const result = await controller.sendEnterToPane('1');
      expect(result.success).toBe(true);
    });
  });

  describe('isPromptReady', () => {
    test('returns false when terminal not in map', () => {
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('returns false when buffer not available', () => {
      terminals.set('1', { buffer: null });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('returns false when buffer.active not available', () => {
      terminals.set('1', { buffer: { active: null } });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('returns false when line not found', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue(null),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('detects named cli > prompt pattern', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'codex>  ',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(true);
    });

    test('detects $ prompt pattern', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'bash$ ',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(true);
    });

    test('detects # prompt pattern', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'root# ',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(true);
    });

    test('does not treat trailing : as prompt', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'Enter password: ',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('does not treat trailing ? as prompt', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'Continue? ',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('returns false for non-prompt text', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'Processing output...',
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(false);
    });

    test('handles buffer read error', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => {
              throw new Error('Buffer error');
            }),
          },
        },
      });
      expect(controller.isPromptReady('1')).toBe(false);
      expect(mockLog.warn).toHaveBeenCalled();
    });
  });

  describe('sendToPane', () => {
    test('initializes queue if not present', () => {
      // Block immediate processing
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      controller.sendToPane('1', 'test message\r');
      expect(messageQueue['1']).toBeDefined();
      expect(messageQueue['1'].length).toBe(1);
    });

    test('queues message with timestamp', () => {
      // Block immediate processing
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      const before = Date.now();
      controller.sendToPane('1', 'test message\r');
      const after = Date.now();

      expect(messageQueue['1'][0].message).toBe('test message\r');
      expect(messageQueue['1'][0].timestamp).toBeGreaterThanOrEqual(before);
      expect(messageQueue['1'][0].timestamp).toBeLessThanOrEqual(after);
    });

    test('applies Codex exec prompt builder for Codex panes', () => {
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      mockOptions.isCodexPane.mockReturnValue(true);

      controller.sendToPane('1', 'run checks');

      expect(mockOptions.buildCodexExecPrompt).toHaveBeenCalledWith('1', 'run checks');
      expect(messageQueue['1'][0].message).toBe('prompt: run checks');
    });

    test('skips Codex exec prompt builder for startup injections', () => {
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      mockOptions.isCodexPane.mockReturnValue(true);

      controller.sendToPane('1', '# SQUIDRUN SESSION: Builder - Started 2026-02-17', {
        startupInjection: true,
      });

      expect(mockOptions.buildCodexExecPrompt).not.toHaveBeenCalled();
      expect(messageQueue['1'][0].message).toBe('# SQUIDRUN SESSION: Builder - Started 2026-02-17');
    });

    test('includes onComplete callback in queue', () => {
      // Block immediate processing
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      const callback = jest.fn();
      controller.sendToPane('1', 'test\r', { onComplete: callback });

      expect(messageQueue['1'][0].onComplete).toBe(callback);
    });

    test('stores inject metadata on queued messages', () => {
      mockOptions.getInjectionInFlight.mockReturnValue(true);

      controller.sendToPane('1', 'test\r', {
        meta: { visibility: 'internal', source: 'pane-output-filter' },
      });

      expect(messageQueue['1'][0].meta).toEqual({
        visibility: 'internal',
        source: 'pane-output-filter',
      });
    });

    test('logs user typing state', () => {
      mockOptions.userIsTyping.mockReturnValue(true);
      controller.sendToPane('1', 'test\r');
      expect(mockLog.info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('user typing'));
    });

    test('logs injection in flight state', () => {
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      controller.sendToPane('1', 'test\r');
      expect(mockLog.info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('injection in flight'));
    });

    test('logs ready state when not typing and not in flight', () => {
      controller.sendToPane('1', 'test\r');
      expect(mockLog.info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('ready'));
    });

    test('caps queued messages and drops oldest when max items is reached', () => {
      const cappedController = createInjectionController({
        ...mockOptions,
        getInjectionInFlight: jest.fn().mockReturnValue(true),
        constants: {
          ...DEFAULT_CONSTANTS,
          INJECTION_QUEUE_MAX_ITEMS: 2,
          INJECTION_QUEUE_MAX_BYTES: 4096,
        },
      });

      cappedController.sendToPane('1', 'first');
      cappedController.sendToPane('1', 'second');
      cappedController.sendToPane('1', 'third');

      expect(messageQueue['1']).toHaveLength(2);
      expect(messageQueue['1'][0].message).toBe('second');
      expect(messageQueue['1'][1].message).toBe('third');
    });

    test('preserves FIFO order within priority lane while keeping priority ahead of normal', () => {
      const stalledController = createInjectionController({
        ...mockOptions,
        getInjectionInFlight: jest.fn().mockReturnValue(true),
      });

      stalledController.sendToPane('1', 'normal-1');
      stalledController.sendToPane('1', 'priority-1', { priority: true });
      stalledController.sendToPane('1', 'priority-2', { priority: true });
      stalledController.sendToPane('1', 'normal-2');

      expect(messageQueue['1']).toHaveLength(4);
      expect(messageQueue['1'][0].message).toBe('priority-1');
      expect(messageQueue['1'][1].message).toBe('priority-2');
      expect(messageQueue['1'][2].message).toBe('normal-1');
      expect(messageQueue['1'][3].message).toBe('normal-2');
    });

    test('clearPaneQueue flushes queued messages and notifies callbacks', () => {
      const callbackA = jest.fn();
      const callbackB = jest.fn();
      const stalledController = createInjectionController({
        ...mockOptions,
        getInjectionInFlight: jest.fn().mockReturnValue(true),
      });

      stalledController.sendToPane('1', 'queued-a', { onComplete: callbackA });
      stalledController.sendToPane('1', 'queued-b', { onComplete: callbackB });
      expect(messageQueue['1']).toHaveLength(2);

      const dropped = stalledController.clearPaneQueue('1', 'pane_teardown');
      expect(dropped).toBe(2);
      expect(messageQueue['1']).toBeUndefined();
      expect(callbackA).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        reason: 'pane_teardown',
      }));
      expect(callbackB).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        reason: 'pane_teardown',
      }));
    });
  });

  describe('processIdleQueue', () => {
    test('does nothing with empty queue', () => {
      messageQueue['1'] = [];
      controller.processIdleQueue('1');
      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalled();
    });

    test('does nothing without queue', () => {
      controller.processIdleQueue('1');
      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalled();
    });

    test('retries later if injection in flight', () => {
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.getInjectionInFlight.mockReturnValue(true);

      controller.processIdleQueue('1');

      // Should not start injection
      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalledWith(true);
      // Message should still be in queue
      expect(messageQueue['1'].length).toBe(1);
    });

    test('uses exponential backoff while repeatedly deferred', () => {
      const timeoutSpy = jest.spyOn(global, 'setTimeout');
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.getInjectionInFlight.mockReturnValue(true);

      controller.processIdleQueue('1');
      controller.processIdleQueue('1');
      controller.processIdleQueue('1');
      controller.processIdleQueue('1');

      const delays = timeoutSpy.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'number')
        .slice(0, 4);
      expect(delays).toEqual([100, 200, 400, 800]);
      timeoutSpy.mockRestore();
    });

    test('resets defer backoff after queue resumes', () => {
      const timeoutSpy = jest.spyOn(global, 'setTimeout');
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.getInjectionInFlight.mockReturnValue(true);

      controller.processIdleQueue('1'); // 100ms

      // Resume/clear path should reset backoff state
      messageQueue['1'] = [];
      controller.processIdleQueue('1');

      messageQueue['1'] = [{ message: 'test again\r', timestamp: Date.now() }];
      controller.processIdleQueue('1'); // should restart at 100ms

      const delays = timeoutSpy.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'number')
        .slice(0, 2);
      expect(delays).toEqual([100, 100]);
      timeoutSpy.mockRestore();
    });

    test('throttles defer logs and emits summary when defer reason changes', () => {
      mockOptions.userInputFocused = jest.fn().mockReturnValue(false);
      const ctrl = createInjectionController(mockOptions);
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.getInjectionInFlight.mockReturnValue(true);

      ctrl.processIdleQueue('1');
      ctrl.processIdleQueue('1');
      ctrl.processIdleQueue('1');

      // Change defer reason: injection lock clears, user is now composing.
      mockOptions.getInjectionInFlight.mockReturnValue(false);
      mockOptions.userInputFocused.mockReturnValue(true);
      ctrl.processIdleQueue('1');

      const infoMessages = mockLog.info.mock.calls.map(call => call[1]);
      expect(infoMessages.filter(m => m.includes('Pane deferred - injection in flight')).length).toBe(1);
      expect(infoMessages.some(m => m.includes('Pane defer repeats suppressed: injection in flight'))).toBe(true);
      expect(infoMessages.filter(m => m.includes('Pane deferred - user input focused (composing)')).length).toBe(1);
    });

    // Session 67: Gemini bypasses global lock (like Codex)
    test('Gemini pane bypasses injection lock', () => {
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      mockOptions.isGeminiPane.mockReturnValue(true);

      controller.processIdleQueue('1');

      // Gemini should bypass lock and process message
      expect(messageQueue['1'].length).toBe(0); // Message dequeued
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Gemini pane bypassing global lock')
      );
    });

    test('processes string message in queue', () => {
      messageQueue['1'] = ['test message\r'];

      controller.processIdleQueue('1');

      // Should start injection
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
    });

    test('sends Claude pane message immediately (no idle gating)', () => {
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];

      controller.processIdleQueue('1');

      // Should immediately set injection lock and dequeue
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(messageQueue['1'].length).toBe(0);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('immediate send')
      );
    });

    test('defers Claude pane when userInputFocused', () => {
      mockOptions.userInputFocused = jest.fn().mockReturnValue(true);
      const ctrl = createInjectionController(mockOptions);
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];

      ctrl.processIdleQueue('1');

      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalled();
      expect(messageQueue['1'].length).toBe(1);
    });

    test('does not defer Claude pane when UI focus is stale (no recent typing)', () => {
      const lastUiActivity = Date.now() - 3000;
      mockOptions.userInputFocused = jest.fn(() => (Date.now() - lastUiActivity) <= 2000);
      const ctrl = createInjectionController(mockOptions);
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];

      ctrl.processIdleQueue('1');

      expect(mockOptions.userInputFocused).toHaveBeenCalled();
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(messageQueue['1'].length).toBe(0);
    });

    test('defers queue processing while compaction gate is confirmed', () => {
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      bus.updateState('1', { gates: { compacting: 'confirmed' } });

      controller.processIdleQueue('1');

      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalled();
      expect(mockPty.write).not.toHaveBeenCalled();
      expect(messageQueue['1'].length).toBe(1);

      bus.updateState('1', { gates: { compacting: 'none' } });
      jest.advanceTimersByTime(DEFAULT_CONSTANTS.QUEUE_RETRY_MS + 5);

      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(messageQueue['1'].length).toBe(0);
    });

    test('force-clears stuck compaction gate after max defer timeout', async () => {
      const ctrl = createInjectionController({
        ...mockOptions,
        constants: {
          ...DEFAULT_CONSTANTS,
          MAX_COMPACTION_DEFER_MS: 500,
          QUEUE_RETRY_MS: 100,
        },
      });
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      bus.updateState('1', { gates: { compacting: 'confirmed' } });

      ctrl.processIdleQueue('1');
      expect(messageQueue['1'].length).toBe(1);

      await jest.advanceTimersByTimeAsync(700);

      expect(bus.getState('1').gates.compacting).toBe('none');
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(messageQueue['1'].length).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('processQueue 1'),
        expect.stringContaining('Compaction gate stuck')
      );
    });

    test('calls onComplete callback after injection', async () => {
      const onComplete = jest.fn();
      messageQueue['1'] = [{
        message: 'test\r',
        timestamp: Date.now(),
        onComplete,
      }];

      controller.processIdleQueue('1');

      // Advance timers to complete injection
      await jest.advanceTimersByTimeAsync(2000);

      expect(onComplete).toHaveBeenCalled();
    });

    test('bypasses injection lock for hm-send fast-path trace contexts', async () => {
      const lockedOptions = {
        ...mockOptions,
        getInjectionInFlight: jest.fn().mockReturnValue(true),
        setInjectionInFlight: jest.fn(),
      };
      const lockedController = createInjectionController(lockedOptions);
      messageQueue['1'] = [{
        message: 'hm lock bypass\r',
        timestamp: Date.now(),
        traceContext: { messageId: 'hm-42', traceId: 'hm-42' },
      }];

      lockedController.processIdleQueue('1');
      await Promise.resolve();

      expect(lockedOptions.setInjectionInFlight).not.toHaveBeenCalledWith(true);
    });

    test('serializes hm-send fast-path injections per pane to prevent PTY interleaving', async () => {
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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

      let resolveFirstEnter;
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          return new Promise((resolve) => {
            resolveFirstEnter = () => {
              promptText = 'running...';
              lastOutputTime['1'] = Date.now();
              resolve(undefined);
            };
          });
        }
        return Promise.resolve(undefined);
      });

      messageQueue['1'] = [{
        message: 'first hm payload\r',
        timestamp: Date.now(),
        traceContext: { messageId: 'hm-1', traceId: 'hm-1' },
      }];

      controller.processIdleQueue('1');
      await Promise.resolve();

      messageQueue['1'].push({
        message: 'second hm payload\r',
        timestamp: Date.now(),
        traceContext: { messageId: 'hm-2', traceId: 'hm-2' },
      });
      controller.processIdleQueue('1');
      await Promise.resolve();

      const payloadWritesBeforeRelease = mockPty.write.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'string' && value !== '\r');
      expect(payloadWritesBeforeRelease).toHaveLength(1);
      expect(payloadWritesBeforeRelease[0]).toEqual(
        expect.stringMatching(timestampedPayloadRegex('first hm payload'))
      );
      expect(messageQueue['1']).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(800);
      expect(typeof resolveFirstEnter).toBe('function');

      resolveFirstEnter();
      await jest.advanceTimersByTimeAsync(1200);

      const payloadWritesAfterRelease = mockPty.write.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'string' && value !== '\r');
      expect(payloadWritesAfterRelease).toHaveLength(2);
      expect(payloadWritesAfterRelease[1]).toEqual(
        expect.stringMatching(timestampedPayloadRegex('second hm payload'))
      );
      expect(messageQueue['1']).toHaveLength(0);
    });

    test('handles onComplete error gracefully', async () => {
      const onComplete = jest.fn(() => {
        throw new Error('Callback error');
      });
      messageQueue['1'] = [{
        message: 'test\r',
        timestamp: Date.now(),
        onComplete,
      }];

      controller.processIdleQueue('1');
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockLog.error).toHaveBeenCalledWith(
        'Terminal',
        'queue onComplete failed',
        expect.any(Error)
      );
    });

    test('processes next item in queue after completion', async () => {
      // First item will be processed, second should remain
      messageQueue['1'] = [
        { message: 'first\r', timestamp: Date.now() },
        { message: 'second\r', timestamp: Date.now() },
      ];

      controller.processIdleQueue('1');

      // First message is being processed
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);

      // Advance to complete first message
      await jest.advanceTimersByTimeAsync(2000);

      // setInjectionInFlight should be called twice (once for each message)
      // or at least the queue started processing
      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(false);
    });
  });

  describe('doSendToPane', () => {
    test('uses capability-driven safe default path for unknown runtimes', async () => {
      const capabilityOptions = {
        ...mockOptions,
        getPaneCapabilities: jest.fn().mockImplementation((paneId) => {
          if (paneId === '7') {
            return {
              mode: 'pty',
              modeLabel: 'generic-pty',
              appliedMethod: 'generic-pty',
              submitMethod: 'pty-enter',
              bypassGlobalLock: true,
              applyCompactionGate: false,
              requiresFocusForEnter: false,
              enterMethod: 'pty',
              enterDelayMs: 25,
              sanitizeMultiline: false,
              clearLineBeforeWrite: true,
              useChunkedWrite: true,
              homeResetBeforeWrite: true,
              verifySubmitAccepted: true,
              deferSubmitWhilePaneActive: true,
              typingGuardWhenBypassing: true,
            };
          }
          return null;
        }),
      };
      const capabilityController = createInjectionController(capabilityOptions);

      // No textarea should still succeed because focus is not required.
      document.querySelector.mockReturnValue(null);
      terminals.set('7', { buffer: { active: null } });

      const onComplete = jest.fn();
      await capabilityController.doSendToPane('7', 'hello runtime\r', onComplete);
      await jest.advanceTimersByTimeAsync(200);

      expect(mockPty.write).toHaveBeenCalledWith(
        '7',
        expect.stringMatching(timestampedPayloadRegex('hello runtime')),
        expect.any(Object)
      );
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
      expect(mockPty.write).toHaveBeenCalledWith('7', '\r', expect.any(Object));
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'prompt_probe_unavailable',
      });
    });

    test('threads inject metadata into PTY kernelMeta', async () => {
      const capabilityOptions = {
        ...mockOptions,
        getPaneCapabilities: jest.fn().mockImplementation((paneId) => {
          if (paneId === '7') {
            return {
              mode: 'pty',
              modeLabel: 'generic-pty',
              appliedMethod: 'generic-pty',
              submitMethod: 'pty-enter',
              bypassGlobalLock: true,
              applyCompactionGate: false,
              requiresFocusForEnter: false,
              enterMethod: 'pty',
              enterDelayMs: 25,
              sanitizeMultiline: false,
              clearLineBeforeWrite: true,
              useChunkedWrite: true,
              homeResetBeforeWrite: true,
              verifySubmitAccepted: true,
              deferSubmitWhilePaneActive: true,
              typingGuardWhenBypassing: true,
            };
          }
          return null;
        }),
      };
      const capabilityController = createInjectionController(capabilityOptions);

      document.querySelector.mockReturnValue(null);
      terminals.set('7', { buffer: { active: null } });

      await capabilityController.doSendToPane(
        '7',
        'internal runtime',
        jest.fn(),
        null,
        { meta: { visibility: 'internal', source: 'pane-output-filter' } }
      );
      await jest.advanceTimersByTimeAsync(200);

      const payloadWrite = mockPty.write.mock.calls.find(
        ([paneId, data]) => paneId === '7' && data !== '\r'
      );
      expect(payloadWrite).toBeDefined();
      expect(payloadWrite[2]).toEqual(expect.objectContaining({
        meta: expect.objectContaining({
          visibility: 'internal',
          source: 'pane-output-filter',
        }),
      }));
    });

    test('respects capability override for submit verification on focus-free path', async () => {
      const capabilityOptions = {
        ...mockOptions,
        getPaneCapabilities: jest.fn().mockImplementation((paneId) => {
          if (paneId === '8') {
            return {
              mode: 'pty',
              modeLabel: 'custom-pty',
              appliedMethod: 'custom-pty',
              submitMethod: 'custom-pty-enter',
              bypassGlobalLock: true,
              applyCompactionGate: false,
              requiresFocusForEnter: false,
              enterMethod: 'pty',
              enterDelayMs: 0,
              sanitizeMultiline: false,
              clearLineBeforeWrite: true,
              useChunkedWrite: false,
              homeResetBeforeWrite: false,
              verifySubmitAccepted: false,
              deferSubmitWhilePaneActive: false,
              typingGuardWhenBypassing: true,
            };
          }
          return null;
        }),
      };
      const capabilityController = createInjectionController(capabilityOptions);
      terminals.set('8', {});

      const onComplete = jest.fn();
      await capabilityController.doSendToPane('8', 'custom message', onComplete);
      await jest.advanceTimersByTimeAsync(50);

      expect(mockPty.write).toHaveBeenCalledWith(
        '8',
        expect.stringMatching(timestampedPayloadRegex('custom message')),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('8', '\r', expect.any(Object));
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('hm-send fast path submits Enter after delay via plain PTY write', async () => {
      const onComplete = jest.fn();
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          // Prevent Darwin's guarded fast-path retry by simulating output transition.
          promptText = 'running hm-send...';
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });

      const promise = controller.doSendToPane(
        '1',
        'hm payload\r',
        onComplete,
        { messageId: 'hm-123', traceId: 'hm-123' },
        { hmSendFastEnter: true }
      );

      // Fast path now waits for CLI to process paste before sending Enter
      await jest.advanceTimersByTimeAsync(800);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('hm payload')),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(mockTextarea.dispatchEvent).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
    });

    test('hm-send fast path comment-wraps payload when pane is at a PowerShell prompt', async () => {
      let promptText = 'PS D:\\projects\\squidrun> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      const onComplete = jest.fn();
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          promptText = 'running hm-send...';
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });

      const promise = controller.doSendToPane(
        '1',
        '(BUILDER #1): Builder online. Standing by.\n[CURRENT PROJECT] name=squidrun\r',
        onComplete,
        { messageId: 'hm-ps', traceId: 'hm-ps' },
        { hmSendFastEnter: true }
      );

      await jest.advanceTimersByTimeAsync(1200);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(
          timestampedPayloadRegex('(BUILDER #1): Builder online. Standing by.\n# [CURRENT PROJECT] name=squidrun', { prefix: '# ' })
        ),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
    });

    test('hm-send long payloads use chunked PTY write and Enter waits for chunk completion', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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

      let resolveChunkWrite;
      mockPty.writeChunked.mockImplementationOnce(() => new Promise((resolve) => {
        resolveChunkWrite = resolve;
      }));
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          promptText = 'running...';
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });
      const onComplete = jest.fn();
      const longPayload = `${'L'.repeat(1050)}\nline-two\r`;

      const promise = controller.doSendToPane(
        '1',
        longPayload,
        onComplete,
        { messageId: 'hm-456', traceId: 'hm-456' },
        { hmSendFastEnter: true }
      );
      await Promise.resolve();

      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex(`${'L'.repeat(1050)}\nline-two`)),
        expect.objectContaining({ waitForWriteAck: true }),
        expect.any(Object)
      );
      expect(mockPty.write).not.toHaveBeenCalledWith('1', '\r');

      resolveChunkWrite({ success: true, chunks: 2, chunkSize: 1024 });
      // Fast path now waits for CLI to process paste before sending Enter
      await jest.advanceTimersByTimeAsync(1200);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
    });

    test('hm-send medium payloads force chunked PTY writes before Enter on fallback path', async () => {
      const capabilityOptions = {
        ...mockOptions,
        getPaneCapabilities: jest.fn().mockReturnValue({
          mode: 'pty',
          modeLabel: 'custom-pty',
          appliedMethod: 'custom-pty',
          submitMethod: 'custom-pty-enter',
          bypassGlobalLock: true,
          applyCompactionGate: false,
          requiresFocusForEnter: false,
          enterMethod: 'pty',
          enterDelayMs: 0,
          sanitizeMultiline: false,
          clearLineBeforeWrite: true,
          useChunkedWrite: false,
          homeResetBeforeWrite: false,
          verifySubmitAccepted: false,
          deferSubmitWhilePaneActive: false,
          typingGuardWhenBypassing: true,
          displayName: 'Custom',
        }),
      };
      const fallbackController = createInjectionController(capabilityOptions);
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          promptText = 'running custom...';
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });
      const onComplete = jest.fn();
      const mediumPayload = `${'M'.repeat(300)}\r`;

      const promise = fallbackController.doSendToPane(
        '1',
        mediumPayload,
        onComplete,
        { messageId: 'hm-medium', traceId: 'hm-medium' },
        { hmSendFastEnter: true }
      );

      await jest.advanceTimersByTimeAsync(1200);
      await promise;

      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('M'.repeat(300))),
        expect.objectContaining({ waitForWriteAck: true }),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
    });

    test('hm-send fast path enforces a minimum pre-Enter delay on fallback path', async () => {
      const capabilityOptions = {
        ...mockOptions,
        getPaneCapabilities: jest.fn().mockReturnValue({
          mode: 'pty',
          modeLabel: 'custom-pty',
          appliedMethod: 'custom-pty',
          submitMethod: 'custom-pty-enter',
          bypassGlobalLock: true,
          applyCompactionGate: false,
          requiresFocusForEnter: false,
          enterMethod: 'pty',
          enterDelayMs: 0,
          sanitizeMultiline: false,
          clearLineBeforeWrite: true,
          useChunkedWrite: false,
          homeResetBeforeWrite: false,
          verifySubmitAccepted: false,
          deferSubmitWhilePaneActive: false,
          typingGuardWhenBypassing: true,
          displayName: 'Custom',
        }),
      };
      const fallbackController = createInjectionController(capabilityOptions);
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          promptText = 'running custom...';
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });
      const onComplete = jest.fn();

      const promise = fallbackController.doSendToPane(
        '1',
        `${'D'.repeat(300)}\r`,
        onComplete,
        { messageId: 'hm-delay', traceId: 'hm-delay' },
        { hmSendFastEnter: true }
      );

      await jest.advanceTimersByTimeAsync(499);
      expect(getPtyEnterCallCount(mockPty)).toBe(0);

      await jest.advanceTimersByTimeAsync(1);
      await promise;

      expect(getPtyEnterCallCount(mockPty)).toBe(1);
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
    });

    test('hm-send fast path downgrades to accepted.unverified when no acceptance signal is observed', async () => {
      const strictController = createInjectionController({
        ...mockOptions,
        constants: {
          ...DEFAULT_CONSTANTS,
          INJECTION_LOCK_TIMEOUT_MS: 3000,
        },
      });
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      const onComplete = jest.fn();

      const promise = strictController.doSendToPane(
        '1',
        'hm payload\r',
        onComplete,
        { messageId: 'hm-missed', traceId: 'hm-missed' },
        { hmSendFastEnter: true }
      );

      await jest.advanceTimersByTimeAsync(2500);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('hm payload')),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(promptText).toBe('codex> ');
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: false,
        signal: 'accepted_unverified',
        status: 'accepted.unverified',
        reason: 'submit_not_accepted',
      });
    });

    test('hm-send fast path does not treat bare output transitions as verified acceptance', async () => {
      let promptText = 'codex> ';
      terminals.set('1', {
        _squidrunBypass: false,
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
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });
      const onComplete = jest.fn();

      const strictController = createInjectionController({
        ...mockOptions,
        constants: {
          ...DEFAULT_CONSTANTS,
          INJECTION_LOCK_TIMEOUT_MS: 3000,
        },
      });

      const promise = strictController.doSendToPane(
        '1',
        'hm payload\r',
        onComplete,
        { messageId: 'hm-output-only', traceId: 'hm-output-only' },
        { hmSendFastEnter: true }
      );

      await jest.advanceTimersByTimeAsync(2500);
      await promise;

      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: false,
        signal: 'accepted_unverified',
        status: 'accepted.unverified',
        reason: 'submit_not_accepted',
      });
    });

    test('prepends a visible local timestamp to injected pane messages', async () => {
      jest.setSystemTime(new Date('2026-03-28T12:34:00'));
      terminals.set('1', { _squidrunBypass: false });
      const onComplete = jest.fn();

      const promise = controller.doSendToPane(
        '1',
        'status update\r',
        onComplete,
        null,
        { verifySubmitAccepted: false }
      );

      await jest.advanceTimersByTimeAsync(500);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        '[12:34 local] status update',
        expect.any(Object)
      );
    });

    test('preserves multiline content for long Codex injections', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      terminals.set('1', { _squidrunBypass: false });
      const onComplete = jest.fn();
      const codexLongMessage = `${'C'.repeat(1030)}\nnext-line\r`;

      const promise = controller.doSendToPane('1', codexLongMessage, onComplete);
      await jest.advanceTimersByTimeAsync(500);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex(`${'C'.repeat(1030)}\nnext-line`)),
        expect.any(Object)
      );
      if (IS_DARWIN) {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
      } else {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\u001b[201~', expect.any(Object));
      }
    });

    test('preserves multiline content for long Gemini injections', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();
      const geminiLongMessage = `${'G'.repeat(1030)}\nnext-line\r`;

      const promise = controller.doSendToPane('1', geminiLongMessage, onComplete);
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex(`${'G'.repeat(1030)}\nnext-line`)),
        expect.any(Object)
      );
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
    });

    test('handles Codex pane with runtime-appropriate submit path', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      const mockTerminal = { _squidrunBypass: false };
      terminals.set('1', mockTerminal);

      const onComplete = jest.fn();
      const promise = controller.doSendToPane('1', 'test command\r', onComplete);
      // Advance past enterDelayMs + verification
      await jest.advanceTimersByTimeAsync(500);
      await promise;

      // Codex uses PTY write for text and PTY \r for Enter submission
      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('test command')),
        expect.any(Object)
      );
      if (IS_DARWIN) {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
      } else {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\u001b[201~', expect.any(Object));
      }
      expect(mockPty.codexExec).not.toHaveBeenCalled();
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Working');
      if (IS_DARWIN) {
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: true,
          signal: 'prompt_probe_unavailable',
        });
      }
    });

    test('scales Enter delay by payload size for long Codex messages', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      const timeoutSpy = jest.spyOn(global, 'setTimeout');
      const longCodexText = `${'C'.repeat(1401)}\r`;
      const payloadBytes = Buffer.byteLength('[12:34 local] ' + 'C'.repeat(1401), 'utf8');
      const expectedScaledDelay = 200 + Math.min(250, Math.ceil(Math.max(0, payloadBytes - 256) / 64));

      await controller.doSendToPane('1', longCodexText, jest.fn());

      const delays = timeoutSpy.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'number');
      expect(delays).toContain(expectedScaledDelay);
      timeoutSpy.mockRestore();
    });

    test('handles Codex PTY write failure', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      terminals.set('1', { _squidrunBypass: false });
      mockPty.write.mockRejectedValueOnce(new Error('Write failed'));
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
    });

    test('handles Codex PTY Enter failure', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      terminals.set('1', { _squidrunBypass: false });
      // First write succeeds (text), second write fails (Enter \r)
      mockPty.write.mockResolvedValueOnce(undefined);
      mockPty.write.mockRejectedValueOnce(new Error('Enter failed'));
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(500);
      await promise;

      if (IS_DARWIN) {
        expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'enter_failed' });
      } else {
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: true,
          signal: 'prompt_probe_unavailable',
        });
      }
    });

    // Gemini PTY path: sanitize text, then send Enter via PTY \r
    test('handles Gemini pane with PTY Enter', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test command\r', onComplete);
      // Advance past GEMINI_ENTER_DELAY_MS (75ms delay between text and Enter)
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // Gemini uses PTY: sanitized text, then Enter via \r
      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('test command')),
        expect.any(Object)
      ); // Sanitized text (trailing \r stripped)
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object)); // Enter sent via PTY
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled(); // No DOM events for Gemini
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Working');
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('handles Gemini PTY write failure', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      mockPty.write.mockRejectedValueOnce(new Error('Write failed')); // Text write fails
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('doSendToPane'),
        expect.stringContaining('Gemini PTY write failed'),
        expect.any(Error)
      );
    });

    test('Gemini always sends Enter even without trailing newline', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'partial text', onComplete); // No trailing \r
      // Advance past GEMINI_ENTER_DELAY_MS (75ms delay between text and Enter)
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // Gemini always sends Enter unconditionally (same as Claude's shouldSendEnter)
      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('partial text')),
        expect.any(Object)
      ); // Text
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object)); // Enter always sent
      expect(mockPty.write).toHaveBeenCalledTimes(2); // Text + Enter
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('writes text to PTY', async () => {
      await controller.doSendToPane('1', 'test message\r', jest.fn());

      expect(mockPty.write).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('test message')),
        expect.any(Object)
      );
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
    });

    test('uses clipboard paste for long flagged payloads before submit', async () => {
      document.activeElement = mockTextarea;
      const onComplete = jest.fn();
      const longText = `${'P'.repeat(1500)}\r`;

      const promise = controller.doSendToPane('1', longText, onComplete, null, {
        preferClipboardPasteForLongMessage: true,
        clipboardPasteThresholdBytes: 1024,
      });
      await jest.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockPty.clipboardPasteText).toHaveBeenCalledWith(
        expect.stringMatching(timestampedPayloadRegex('P'.repeat(1500)))
      );
      const textWrites = mockPty.write.mock.calls.filter((call) => call[1] !== '\r' && call[1] !== '\u001b[201~');
      expect(textWrites).toEqual([]);
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
    });

    test('falls back to PTY write when clipboard paste path fails', async () => {
      document.activeElement = mockTextarea;
      mockPty.clipboardPasteText.mockResolvedValueOnce({ success: false, error: 'clipboard unavailable' });
      const onComplete = jest.fn();
      const longText = `${'Q'.repeat(1500)}\r`;

      const promise = controller.doSendToPane('1', longText, onComplete, null, {
        preferClipboardPasteForLongMessage: true,
        clipboardPasteThresholdBytes: 1024,
      });
      await jest.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockPty.clipboardPasteText).toHaveBeenCalled();
      // Long payload (1500 bytes >= longMessageBytes=1024) skips the \x1b[H
      // prefix because cursor-home overwrites the visible buffer in Claude
      // Code CLI's input area, swallowing the head of the message. See the
      // matching unconditional disable in pane-host-renderer.js:588-593.
      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('Q'.repeat(1500))),
        { chunkSize: 2048, yieldEveryChunks: 0 },
        expect.any(Object)
      );
    });

    test('handles PTY write failure', async () => {
      mockPty.write.mockRejectedValueOnce(new Error('Write failed')); // Message write fails
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
    });

    test('treats writeChunked success=false as PTY write failure', async () => {
      const longText = `${'A'.repeat(9000)}\r`;
      // Home reset is now merged into writeChunked payload, no separate write
      mockPty.writeChunked.mockResolvedValueOnce({ success: false, error: 'write ack timeout after 2500ms' });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', longText, onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled();
    });

    test('does not send Ctrl+U clear-line before PTY writes', async () => {
      await controller.doSendToPane('1', 'test\r', jest.fn());

      const ptyWrites = mockPty.write.mock.calls.map(call => call[1]);
      expect(ptyWrites).not.toContain('\x15');
    });

    test('chunks long Claude writes and logs pre-write fingerprint', async () => {
      const longText = `${'A'.repeat(9000)}\r`; // trailing \r removed before writes
      mockPty.writeChunked.mockResolvedValueOnce({ success: true, chunks: 5, chunkSize: 2048 });
      await controller.doSendToPane('1', longText, jest.fn());

      // Long-payload home-reset suppression: \x1b[H is NOT prepended for
      // payloads >= longMessageBytes because cursor-home overwrites the
      // visible buffer in Claude Code CLI and the head of the message gets
      // swallowed (see pane-host-renderer.js:588-593 for the same fix on
      // the parallel path).
      const ptyWrites = mockPty.write.mock.calls.map(call => call[1]);
      expect(ptyWrites).toEqual([]);
      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('A'.repeat(9000))),
        { chunkSize: 2048, yieldEveryChunks: 0 },
        expect.any(Object)
      );

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('doSendToPane'),
        expect.stringContaining('pre-PTY fingerprint branch=chunked-or-forced textLen=9014')
      );
    });

    test('REGRESSION: long payload PRESERVES head bytes (no \\x1b[H prefix)', async () => {
      // Repro for the multi-session truncation bug. Source-of-truth:
      //   sent: 1892 bytes (e.g. Architect message)
      //   received: ~877 bytes (TAIL only, head swallowed by \x1b[H buffer overwrite)
      // Fix asserts the long payload is delivered WITHOUT a leading cursor-home
      // escape so the head reaches Claude Code CLI intact.
      const headMarker = 'HEAD-SENTINEL-MUST-SURVIVE';
      const tailMarker = 'TAIL-SENTINEL';
      // 1500 bytes total > longMessageBytes (1024 default)
      const longText = `${headMarker} ${'X'.repeat(1400)} ${tailMarker}\r`;
      mockPty.writeChunked.mockResolvedValueOnce({ success: true, chunks: 1, chunkSize: 2048 });

      await controller.doSendToPane('1', longText, jest.fn());

      const writeChunkedArgs = mockPty.writeChunked.mock.calls[0];
      expect(writeChunkedArgs).toBeDefined();
      const writeText = writeChunkedArgs[1];
      expect(writeText).not.toMatch(/^\x1b\[H/); // home-reset must NOT prefix
      expect(writeText).toContain(headMarker);   // head bytes intact
      expect(writeText).toContain(tailMarker);   // tail bytes intact
    });

    test('short Claude payload uses non-chunked PTY write with NO Home prefix', async () => {
      // SYSTEM INVARIANT: no payload — short or long — gets a Home prefix.
      // Short messages still bypass chunking (under chunkThreshold), but the
      // bytes written are exactly the payload, never \x1b[H + payload.
      const shortText = 'short message\r';
      mockPty.writeChunked.mockResolvedValueOnce({ success: true, chunks: 1, chunkSize: 2048 });

      await controller.doSendToPane('1', shortText, jest.fn());

      expect(mockPty.writeChunked).not.toHaveBeenCalled();
      const writeCalls = mockPty.write.mock.calls.filter(([, payload]) => typeof payload === 'string');
      for (const [, payload] of writeCalls) {
        expect(payload).not.toMatch(/^\x1b\[H/);
      }
    });

    test('chunks normal long [MSG from] payloads at the 1KB Claude threshold', async () => {
      const text = `[MSG from architect]: ${'B'.repeat(3000)}\r`;
      await controller.doSendToPane('1', text, jest.fn());

      // Long payload (~3022 bytes >= longMessageBytes=1024) skips the
      // \x1b[H prefix; see the head-bytes-preserved regression test below.
      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex(text.slice(0, -1))),
        { chunkSize: 2048, yieldEveryChunks: 0 },
        expect.any(Object)
      );
    });

    test('chunks exact-threshold Claude payloads before Enter dispatch with NO Home prefix', async () => {
      const text = `${'C'.repeat(1024)}\r`;
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', text, onComplete);
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // SYSTEM INVARIANT: chunked write delivers the raw payload, no \x1b[H
      // prepended. The historic gate at the threshold has been removed.
      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        expect.stringMatching(timestampedPayloadRegex('C'.repeat(1024))),
        { chunkSize: 2048, yieldEveryChunks: 0 },
        expect.any(Object)
      );
      const [, chunkPayload] = mockPty.writeChunked.mock.calls[0];
      expect(chunkPayload).not.toMatch(/^\x1b\[H/);
    });

    test('defers before programmatic write when pane is actively outputting', async () => {
      lastOutputTime['1'] = Date.now();

      const promise = controller.doSendToPane('1', 'test\r', jest.fn());
      if (IS_DARWIN) {
        // Darwin Claude path does not defer submit while pane is active.
        expect(mockPty.write).toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(500);
        await promise;
      } else {
        expect(mockPty.write).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(200);
        expect(mockPty.write).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(500);
        await promise;
        expect(mockPty.write).toHaveBeenCalled();
      }
    });

    test('focuses textarea before Enter', async () => {
      await controller.doSendToPane('1', 'test\r', jest.fn());
      if (IS_DARWIN) {
        expect(mockTextarea.focus).not.toHaveBeenCalled();
      } else {
        expect(mockTextarea.focus).toHaveBeenCalled();
      }
    });

    test('sends Enter after base delay for short messages', async () => {
      document.activeElement = mockTextarea; // Focus succeeds

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance past base 50ms delay
      await jest.advanceTimersByTimeAsync(100);

      if (IS_DARWIN) {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
      } else {
        expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
      }
    });

    test('scales Enter delay by payload size for long Claude messages', async () => {
      document.activeElement = mockTextarea; // Focus succeeds
      const timeoutSpy = jest.spyOn(global, 'setTimeout');
      const longText = `${'X'.repeat(9000)}\r`;
      const payloadBytes = Buffer.byteLength('X'.repeat(9000), 'utf8');
      const expectedScaledDelay = 200 + Math.min(250, Math.ceil(Math.max(0, payloadBytes - 256) / 64));

      await controller.doSendToPane('1', longText, jest.fn());

      const delays = timeoutSpy.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'number');

      expect(delays).toContain(expectedScaledDelay);
      timeoutSpy.mockRestore();
    });

    test('uses longer defer timeout for long Claude messages', async () => {
      const longActiveController = createInjectionController({
        ...mockOptions,
        constants: {
          ...DEFAULT_CONSTANTS,
          SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS: 10000,
          SUBMIT_DEFER_MAX_WAIT_MS: 2000,
          SUBMIT_DEFER_MAX_WAIT_LONG_MS: 5000,
          SUBMIT_DEFER_POLL_MS: 100,
          CLAUDE_LONG_MESSAGE_BYTES: 1024,
          CLAUDE_LONG_MESSAGE_BASE_ENTER_DELAY_MS: 200,
          CLAUDE_ENTER_DELAY_SCALE_START_BYTES: 256,
          CLAUDE_ENTER_DELAY_BYTES_PER_MS: 64,
          CLAUDE_ENTER_DELAY_MAX_EXTRA_MS: 250,
        },
      });

      document.activeElement = mockTextarea; // Focus succeeds
      lastOutputTime['1'] = Date.now();
      const longText = `${'Y'.repeat(1500)}\r`;
      const promise = longActiveController.doSendToPane('1', longText, jest.fn());

      if (IS_DARWIN) {
        await jest.advanceTimersByTimeAsync(500);
        await promise;
        expect(mockPty.writeChunked).toHaveBeenCalled();
      } else {
        await jest.advanceTimersByTimeAsync(2500);
        expect(mockPty.write).not.toHaveBeenCalled();
        expect(mockPty.writeChunked).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(3500);
        await promise;
        expect(mockPty.writeChunked).toHaveBeenCalled();
      }
    });

    test('Claude pane always sends Enter even without trailing \\r', async () => {
      document.activeElement = mockTextarea; // Focus succeeds

      const onComplete = jest.fn();
      await controller.doSendToPane('1', 'test', onComplete);

      // Advance past fixed delay
      await jest.advanceTimersByTimeAsync(100);

      if (IS_DARWIN) {
        expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
      } else {
        // Claude panes always send Enter via DOM key events
        expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
      }
    });

    test('returns completion after submit flow settles', async () => {
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test\r', onComplete);

      // Advance past fixed delay + extended Claude submit safety timeout
      await jest.advanceTimersByTimeAsync(10000);

      await promise;

      // Safety timer should have fired with unverified success
      expect(onComplete).toHaveBeenCalled();
    });

    test('restores saved focus after injection', async () => {
      const savedElement = { focus: jest.fn() };
      document.activeElement = savedElement;
      document.body.contains.mockReturnValue(true);

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance timers to complete
      await jest.advanceTimersByTimeAsync(2000);

      if (IS_DARWIN) {
        expect(savedElement.focus).not.toHaveBeenCalled();
      } else {
        expect(savedElement.focus).toHaveBeenCalled();
      }
    });

    test('aborts if textarea disappears during delay', async () => {
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      // Textarea disappears during delay
      mockPaneEl.querySelector.mockReturnValue(null);
      document.querySelector.mockReturnValue(mockPaneEl);

      await jest.advanceTimersByTimeAsync(100);

      if (IS_DARWIN) {
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(onComplete).toHaveBeenCalledWith({
          success: false,
          reason: 'textarea_disappeared',
        });
      }
    });

    test('proceeds with Enter after focus fails', async () => {
      document.activeElement = null; // Focus will fail
      const onComplete = jest.fn();

      // Create controller with low retry count for faster test
      const testOptions = {
        ...mockOptions,
        constants: { ...DEFAULT_CONSTANTS, MAX_FOCUS_RETRIES: 1, FOCUS_RETRY_DELAY_MS: 10 },
      };
      const testController = createInjectionController(testOptions);

      await testController.doSendToPane('1', 'test\r', onComplete);

      // Advance timers for fixed delay + focus retries
      await jest.advanceTimersByTimeAsync(2000);

      if (IS_DARWIN) {
        expect(mockLog.warn).not.toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('focus failed, proceeding with Enter anyway')
        );
        expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object));
      } else {
        // Should log focus warning but proceed anyway
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('focus failed, proceeding with Enter anyway')
        );
        // Enter should still be sent (not abandoned)
        expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
      }
    });

    test('handles Enter send failure', async () => {
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation(() => {
        throw new Error('Enter failed');
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(2000);

      if (IS_DARWIN) {
        expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalledWith('1');
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(mockOptions.markPotentiallyStuck).toHaveBeenCalledWith('1');
        expect(onComplete).toHaveBeenCalledWith({
          success: false,
          reason: 'enter_failed',
        });
      }
    });

    test('retries submit once and succeeds when prompt transitions on retry', async () => {
      let promptText = 'codex> ';
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
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
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
          if (enterCalls === 2) {
            promptText = 'running...';
          }
        }
        return true;
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      if (IS_DARWIN) {
        expect(enterCalls).toBe(0);
        expect(getPtyEnterCallCount(mockPty)).toBe(1);
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(enterCalls).toBe(2);
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: true,
          signal: 'prompt_transition',
        });
      }
    });

    test('treats output-only submit verification as accepted but unverified', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => ({
              translateToString: () => 'codex> ',
            })),
          },
        },
      });
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
          lastOutputTime['1'] = Date.now();
        }
        return true;
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      if (IS_DARWIN) {
        expect(enterCalls).toBe(0);
        expect(getPtyEnterCallCount(mockPty)).toBe(1);
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(enterCalls).toBe(2);
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: false,
          signal: 'accepted_unverified',
          status: 'accepted.unverified',
          reason: 'submit_not_accepted',
        });
      }
      expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalled();
      if (!IS_DARWIN) {
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.stringContaining('doSendToPane 1'),
          expect.stringContaining('signal=output_transition_only')
        );
      }
    });

    test('allows per-message verification override for safe startup injections', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => ({
              translateToString: () => 'codex> ',
            })),
          },
        },
      });
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
          lastOutputTime['1'] = Date.now();
        }
        return true;
      });
      const onComplete = jest.fn();

      controller.sendToPane('1', '# SQUIDRUN SESSION: Architect - Started 2026-02-13', {
        verifySubmitAccepted: false,
        onComplete,
      });
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(IS_DARWIN ? 0 : 1);
      expect(getPtyEnterCallCount(mockPty)).toBe(IS_DARWIN ? 1 : 0);
      expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('accepts output transition for lightweight startup verification mode', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => ({
              translateToString: () => 'codex> ',
            })),
          },
        },
      });
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
          lastOutputTime['1'] = Date.now();
        }
        return true;
      });
      mockPty.write.mockImplementation((paneId, data) => {
        if (paneId === '1' && data === '\r') {
          lastOutputTime['1'] = Date.now();
        }
        return Promise.resolve(undefined);
      });
      const onComplete = jest.fn();

      controller.sendToPane('1', '# SQUIDRUN SESSION: Architect - Started 2026-02-14', {
        verifySubmitAccepted: true,
        startupInjection: true,
        acceptOutputTransitionOnly: true,
        onComplete,
      });
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(IS_DARWIN ? 0 : 1);
      expect(getPtyEnterCallCount(mockPty)).toBe(IS_DARWIN ? 1 : 0);
      expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'output_transition_allowed',
      });
    });

    test('force-expired defer path auto-retries Enter with refocus', async () => {
      let promptText = 'codex> ';
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
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
      document.activeElement = mockTextarea;
      lastOutputTime['1'] = Date.now();

      const forceExpireController = createInjectionController({
        ...mockOptions,
        constants: {
          ...DEFAULT_CONSTANTS,
          SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS: 10000,
          SUBMIT_DEFER_MAX_WAIT_MS: 200,
          SUBMIT_DEFER_POLL_MS: 50,
          SUBMIT_ACCEPT_VERIFY_WINDOW_MS: 300,
          SUBMIT_ACCEPT_POLL_MS: 50,
          SUBMIT_ACCEPT_RETRY_BACKOFF_MS: 100,
          SUBMIT_ACCEPT_MAX_ATTEMPTS: 2,
        },
      });

      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
          if (enterCalls === 2) {
            promptText = 'running...';
          }
        }
        return true;
      });

      const onComplete = jest.fn();
      const resultPromise = forceExpireController.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(3000);
      await resultPromise;

      if (IS_DARWIN) {
        expect(enterCalls).toBe(0);
        expect(getPtyEnterCallCount(mockPty)).toBe(1);
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(enterCalls).toBe(2);
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: true,
          signal: 'prompt_transition',
        });
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.stringContaining('doSendToPane 1'),
          expect.stringContaining('Force-expired defer path active - auto-retrying Enter with refocus')
        );
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.stringContaining('doSendToPane 1'),
          expect.stringContaining('Force-expired defer: refocus succeeded before retry Enter')
        );
      }
    });

    test('returns accepted.unverified when acceptance signal is never observed after retry', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _squidrunBypass: false,
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn(() => ({
              translateToString: () => 'codex> ',
            })),
          },
        },
      });
      document.activeElement = mockTextarea;
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt.type === 'keydown') {
          enterCalls += 1;
        }
        return true;
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(IS_DARWIN ? 0 : 2);
      expect(getPtyEnterCallCount(mockPty)).toBe(IS_DARWIN ? 1 : 0);
      expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalled();
      if (IS_DARWIN) {
        expect(onComplete).toHaveBeenCalledWith({ success: true });
      } else {
        expect(onComplete).toHaveBeenCalledWith({
          success: true,
          verified: false,
          signal: 'accepted_unverified',
          status: 'accepted.unverified',
          reason: 'submit_not_accepted',
        });
      }
    });

    test('does not call onComplete multiple times', async () => {
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(5000);

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    test('handles onComplete error gracefully', async () => {
      const onComplete = jest.fn(() => {
        throw new Error('Callback error');
      });

      // Use Gemini path which has simpler flow for testing onComplete errors
      mockOptions.isGeminiPane.mockReturnValue(true);
      const promise = controller.doSendToPane('1', 'test', onComplete);
      // Advance past GEMINI_ENTER_DELAY_MS (75ms delay between text and Enter)
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockLog.error).toHaveBeenCalledWith(
        'Terminal',
        'onComplete failed',
        expect.any(Error)
      );
    });
  });

});
