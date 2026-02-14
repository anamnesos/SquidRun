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
    CLAUDE_CHUNK_THRESHOLD_BYTES: 8 * 1024,
    CLAUDE_CHUNK_YIELD_MS: 0,
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

    // Mock window.hivemind.pty
    mockPty = {
      sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
      writeChunked: jest.fn().mockResolvedValue({ success: true, chunks: 1, chunkSize: 2048 }),
      codexExec: jest.fn().mockResolvedValue(undefined),
    };
    global.window = {
      hivemind: { pty: mockPty },
    };

    // Mock DOM elements
    mockTextarea = {
      focus: jest.fn(),
      value: '',
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
    test('sets bypass flag and sends trusted Enter', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);

      const result = await controller.sendEnterToPane('1');

      expect(result.success).toBe(true);
      expect(result.method).toBe('sendTrustedEnter');
      expect(mockPty.sendTrustedEnter).toHaveBeenCalled();
      expect(mockTerminal._hivemindBypass).toBe(true);
    });

    test('clears bypass flag after Enter', async () => {
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);

      await controller.sendEnterToPane('1');

      // Advance past bypass clear delay
      jest.advanceTimersByTime(DEFAULT_CONSTANTS.BYPASS_CLEAR_DELAY_MS + 5);

      expect(mockTerminal._hivemindBypass).toBe(false);
    });

    test('handles sendTrustedEnter failure', async () => {
      mockPty.sendTrustedEnter.mockRejectedValue(new Error('Enter failed'));

      const result = await controller.sendEnterToPane('1');

      expect(result.success).toBe(false);
      expect(result.method).toBe('sendTrustedEnter');
      expect(mockLog.error).toHaveBeenCalled();
    });

    test('falls back to DOM dispatch when sendTrustedEnter fails', async () => {
      mockPty.sendTrustedEnter.mockRejectedValue(new Error('Enter failed'));
      const mockTerminal = { _hivemindBypass: false };
      terminals.set('1', mockTerminal);

      mockTextarea.dispatchEvent = jest.fn();
      const originalKeyboardEvent = global.KeyboardEvent;
      if (!originalKeyboardEvent) {
        global.KeyboardEvent = function KeyboardEvent(type, options) {
          return { type, ...options };
        };
      }

      const result = await controller.sendEnterToPane('1');

      if (!originalKeyboardEvent) {
        delete global.KeyboardEvent;
      }

      expect(result.success).toBe(true);
      expect(result.method).toBe('domFallback');
      expect(mockTextarea.dispatchEvent).toHaveBeenCalledTimes(3);
      const dispatchedEvents = mockTextarea.dispatchEvent.mock.calls.map(call => call[0]);
      dispatchedEvents.forEach((evt) => {
        expect(evt._hivemindBypass).toBe(true);
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

    test('includes onComplete callback in queue', () => {
      // Block immediate processing
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      const callback = jest.fn();
      controller.sendToPane('1', 'test\r', { onComplete: callback });

      expect(messageQueue['1'][0].onComplete).toBe(callback);
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

      expect(mockPty.write).toHaveBeenCalledWith('7', 'hello runtime', expect.any(Object));
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
      expect(mockPty.write).toHaveBeenCalledWith('7', '\r', expect.any(Object));
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'prompt_probe_unavailable',
      });
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

      expect(mockPty.write).toHaveBeenCalledWith('8', 'custom message', expect.any(Object));
      expect(mockPty.write).toHaveBeenCalledWith('8', '\r', expect.any(Object));
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('handles Codex pane differently', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      const mockTerminal = { write: jest.fn() };
      terminals.set('1', mockTerminal);

      const onComplete = jest.fn();
      await controller.doSendToPane('1', 'test command\r', onComplete);

      expect(mockPty.codexExec).toHaveBeenCalled();
      expect(mockTerminal.write).toHaveBeenCalled();
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Working');
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('handles Codex exec failure', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      terminals.set('1', { write: jest.fn() });
      mockPty.codexExec.mockRejectedValue(new Error('Exec failed'));

      await controller.doSendToPane('1', 'test\r', jest.fn());

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('doSendToPane'),
        expect.stringContaining('Codex exec failed'),
        expect.any(Error)
      );
    });

    // Gemini PTY path: sanitize text, then send Enter via PTY \r
    test('handles Gemini pane with PTY Enter', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test command\r', onComplete);
      // Advance past GEMINI_ENTER_DELAY_MS (75ms delay between text and Enter)
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // Gemini uses PTY: clear, sanitized text, then Enter via \r
      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15', expect.any(Object)); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'test command', expect.any(Object)); // Sanitized text (trailing \r stripped)
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object)); // Enter sent via PTY
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled(); // No DOM events for Gemini
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Working');
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('handles Gemini PTY write failure', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      mockPty.write.mockResolvedValueOnce(undefined) // Clear-line succeeds
        .mockRejectedValueOnce(new Error('Write failed')); // Text write fails
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
      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15', expect.any(Object)); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'partial text', expect.any(Object)); // Text
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r', expect.any(Object)); // Enter always sent
      expect(mockPty.write).toHaveBeenCalledTimes(3); // Clear + text + Enter
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('writes text to PTY', async () => {
      await controller.doSendToPane('1', 'test message\r', jest.fn());

      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15', expect.any(Object)); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'test message', expect.any(Object));
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
    });

    test('handles PTY write failure', async () => {
      mockPty.write
        .mockResolvedValueOnce(undefined) // Clear-line succeeds
        .mockRejectedValueOnce(new Error('Write failed')); // Message write fails
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
    });

    test('treats writeChunked success=false as PTY write failure', async () => {
      const longText = `${'A'.repeat(9000)}\r`;
      mockPty.write
        .mockResolvedValueOnce(undefined) // Clear-line succeeds
        .mockResolvedValueOnce(undefined); // Home reset succeeds
      mockPty.writeChunked.mockResolvedValueOnce({ success: false, error: 'write ack timeout after 2500ms' });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', longText, onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled();
    });

    test('handles PTY clear-line failure gracefully', async () => {
      mockPty.write.mockRejectedValueOnce(new Error('Clear failed'))
        .mockResolvedValueOnce(undefined);

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Should continue with text write
      expect(mockPty.write).toHaveBeenCalledTimes(2);
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('PTY clear-line failed'),
        expect.any(Error)
      );
    });

    test('chunks long Claude writes and logs pre-write fingerprint', async () => {
      const longText = `${'A'.repeat(9000)}\r`; // trailing \r removed before writes
      mockPty.writeChunked.mockResolvedValueOnce({ success: true, chunks: 5, chunkSize: 2048 });
      await controller.doSendToPane('1', longText, jest.fn());

      const ptyWrites = mockPty.write.mock.calls.map(call => call[1]);
      expect(ptyWrites).toEqual(['\x15', '\x1b[H']); // Ctrl+U + Home reset
      expect(mockPty.writeChunked).toHaveBeenCalledWith(
        '1',
        'A'.repeat(9000),
        { chunkSize: 2048, yieldEveryChunks: 0 },
        expect.any(Object)
      );

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('doSendToPane'),
        expect.stringContaining('pre-PTY fingerprint textLen=9000')
      );
    });

    test('writes normal long [MSG from] payload atomically with no chunk artifacts', async () => {
      const text = `[MSG from architect]: ${'B'.repeat(3000)}\r`; // < 8KB threshold
      await controller.doSendToPane('1', text, jest.fn());

      const payloadWrites = mockPty.write.mock.calls
        .map(call => call[1])
        .filter(value => typeof value === 'string' && value.startsWith('[MSG from'));
      expect(payloadWrites).toEqual([text.slice(0, -1)]);
      expect(mockPty.writeChunked).not.toHaveBeenCalled();
    });

    test('defers before programmatic write when pane is actively outputting', async () => {
      lastOutputTime['1'] = Date.now();

      const promise = controller.doSendToPane('1', 'test\r', jest.fn());
      expect(mockPty.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);
      expect(mockPty.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(500);
      await promise;
      expect(mockPty.write).toHaveBeenCalled();
    });

    test('focuses textarea before Enter', async () => {
      await controller.doSendToPane('1', 'test\r', jest.fn());
      expect(mockTextarea.focus).toHaveBeenCalled();
    });

    test('sends Enter after base delay for short messages', async () => {
      document.activeElement = mockTextarea; // Focus succeeds

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance past base 50ms delay
      await jest.advanceTimersByTimeAsync(100);

      expect(mockPty.sendTrustedEnter).toHaveBeenCalled();
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

      await jest.advanceTimersByTimeAsync(2500);
      expect(mockPty.write).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(3500);
      await promise;
      expect(mockPty.write).toHaveBeenCalled();
    });

    test('Claude pane always sends Enter even without trailing \\r', async () => {
      document.activeElement = mockTextarea; // Focus succeeds

      const onComplete = jest.fn();
      await controller.doSendToPane('1', 'test', onComplete);

      // Advance past fixed delay
      await jest.advanceTimersByTimeAsync(100);

      // Claude panes always send Enter (via sendTrustedEnter)
      expect(mockPty.sendTrustedEnter).toHaveBeenCalled();
    });

    test('times out and returns unverified success', async () => {
      // Simulate Enter taking too long by making sendTrustedEnter hang
      mockPty.sendTrustedEnter.mockReturnValue(new Promise(() => {})); // Never resolves
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

      expect(savedElement.focus).toHaveBeenCalled();
    });

    test('aborts if textarea disappears during delay', async () => {
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      // Textarea disappears during delay
      mockPaneEl.querySelector.mockReturnValue(null);
      document.querySelector.mockReturnValue(mockPaneEl);

      await jest.advanceTimersByTimeAsync(100);

      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'textarea_disappeared',
      });
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

      // Should log focus warning but proceed anyway
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('focus failed, proceeding with Enter anyway')
      );
      // Enter should still be sent (not abandoned)
      expect(mockPty.sendTrustedEnter).toHaveBeenCalled();
    });

    test('handles Enter send failure', async () => {
      document.activeElement = mockTextarea;
      mockPty.sendTrustedEnter.mockRejectedValue(new Error('Enter failed'));
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockOptions.markPotentiallyStuck).toHaveBeenCalledWith('1');
      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'enter_failed',
      });
    });

    test('retries submit once and succeeds when prompt transitions on retry', async () => {
      let promptText = 'codex> ';
      let enterCalls = 0;
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
      document.activeElement = mockTextarea;
      mockPty.sendTrustedEnter.mockImplementation(async () => {
        enterCalls += 1;
        if (enterCalls === 2) {
          promptText = 'running...';
        }
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      expect(mockPty.sendTrustedEnter).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledWith({
        success: true,
        verified: true,
        signal: 'prompt_transition',
      });
    });

    test('does not treat output transition alone as accepted submit signal', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _hivemindBypass: false,
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
      mockPty.sendTrustedEnter.mockImplementation(async () => {
        enterCalls += 1;
        lastOutputTime['1'] = Date.now();
      });
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(2);
      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'submit_not_accepted',
      });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('doSendToPane 1'),
        expect.stringContaining('signal=output_transition_only')
      );
    });

    test('allows per-message verification override for safe startup injections', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _hivemindBypass: false,
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
      mockPty.sendTrustedEnter.mockImplementation(async () => {
        enterCalls += 1;
        lastOutputTime['1'] = Date.now();
      });
      const onComplete = jest.fn();

      controller.sendToPane('1', '# HIVEMIND SESSION: Architect - Started 2026-02-13', {
        verifySubmitAccepted: false,
        onComplete,
      });
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(1);
      expect(mockOptions.markPotentiallyStuck).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('accepts output transition for lightweight startup verification mode', async () => {
      let enterCalls = 0;
      terminals.set('1', {
        _hivemindBypass: false,
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
      mockPty.sendTrustedEnter.mockImplementation(async () => {
        enterCalls += 1;
        lastOutputTime['1'] = Date.now();
      });
      const onComplete = jest.fn();

      controller.sendToPane('1', '# HIVEMIND SESSION: Architect - Started 2026-02-14', {
        verifySubmitAccepted: true,
        startupInjection: true,
        acceptOutputTransitionOnly: true,
        onComplete,
      });
      await jest.advanceTimersByTimeAsync(4000);

      expect(enterCalls).toBe(1);
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

      mockPty.sendTrustedEnter.mockImplementation(async () => {
        enterCalls += 1;
        if (enterCalls === 2) {
          promptText = 'running...';
        }
      });

      const onComplete = jest.fn();
      const resultPromise = forceExpireController.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(3000);
      await resultPromise;

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
    });

    test('fails submit when acceptance signal is never observed after retry', async () => {
      terminals.set('1', {
        _hivemindBypass: false,
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
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);
      await jest.advanceTimersByTimeAsync(4000);

      expect(mockPty.sendTrustedEnter).toHaveBeenCalledTimes(2);
      expect(mockOptions.markPotentiallyStuck).toHaveBeenCalledWith('1');
      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'submit_not_accepted',
      });
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
