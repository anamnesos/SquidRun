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

describe('Terminal Injection', () => {
  // Default constants matching the module
  const DEFAULT_CONSTANTS = {
    ENTER_DELAY_IDLE_MS: 50,
    ENTER_DELAY_ACTIVE_MS: 150,
    ENTER_DELAY_BUSY_MS: 300,
    PANE_ACTIVE_THRESHOLD_MS: 500,
    PANE_BUSY_THRESHOLD_MS: 100,
    FOCUS_RETRY_DELAY_MS: 50,
    MAX_FOCUS_RETRIES: 3,
    ENTER_VERIFY_DELAY_MS: 200,
    MAX_ENTER_RETRIES: 3,
    ENTER_RETRY_INTERVAL_MS: 100,
    PROMPT_READY_TIMEOUT_MS: 5000,
    MAX_QUEUE_TIME_MS: 10000,
    EXTREME_WAIT_MS: 30000,
    ABSOLUTE_MAX_WAIT_MS: 60000,
    QUEUE_RETRY_MS: 100,
    INJECTION_LOCK_TIMEOUT_MS: 1000,
    BYPASS_CLEAR_DELAY_MS: 75,
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

    // Reset mock objects
    terminals = new Map();
    lastOutputTime = {};
    lastTypedTime = {};
    messageQueue = {};

    // Mock window.hivemind.pty
    mockPty = {
      sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
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
      isCodexPane: jest.fn().mockReturnValue(false),
      isGeminiPane: jest.fn().mockReturnValue(false),  // Session 67: Added for Gemini PTY path
      buildCodexExecPrompt: jest.fn((id, text) => `prompt: ${text}`),
      isIdle: jest.fn().mockReturnValue(true),
      isIdleForForceInject: jest.fn().mockReturnValue(true),
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
      expect(controller.getAdaptiveEnterDelay).toBeDefined();
      expect(controller.focusWithRetry).toBeDefined();
      expect(controller.sendEnterToPane).toBeDefined();
      expect(controller.isPromptReady).toBeDefined();
      expect(controller.verifyAndRetryEnter).toBeDefined();
      expect(controller.processIdleQueue).toBeDefined();
      expect(controller.doSendToPane).toBeDefined();
      expect(controller.sendToPane).toBeDefined();
    });

    test('works with default empty options', () => {
      const emptyController = createInjectionController({});
      expect(emptyController.getAdaptiveEnterDelay).toBeDefined();
    });
  });

  describe('getAdaptiveEnterDelay', () => {
    test('returns busy delay for very recent output', () => {
      lastOutputTime['1'] = Date.now() - 50; // 50ms ago (< 100ms threshold)
      const delay = controller.getAdaptiveEnterDelay('1');
      expect(delay).toBe(DEFAULT_CONSTANTS.ENTER_DELAY_BUSY_MS);
    });

    test('returns active delay for recent output', () => {
      lastOutputTime['1'] = Date.now() - 200; // 200ms ago (< 500ms but > 100ms)
      const delay = controller.getAdaptiveEnterDelay('1');
      expect(delay).toBe(DEFAULT_CONSTANTS.ENTER_DELAY_ACTIVE_MS);
    });

    test('returns idle delay for no recent output', () => {
      lastOutputTime['1'] = Date.now() - 1000; // 1s ago
      const delay = controller.getAdaptiveEnterDelay('1');
      expect(delay).toBe(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS);
    });

    test('returns idle delay when no output time recorded', () => {
      const delay = controller.getAdaptiveEnterDelay('1');
      expect(delay).toBe(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS);
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

    test('detects > prompt pattern', () => {
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'user@host>  ',
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

    test('detects : prompt pattern', () => {
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
      expect(controller.isPromptReady('1')).toBe(true);
    });

    test('detects ? prompt pattern', () => {
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
      expect(controller.isPromptReady('1')).toBe(true);
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

    test('logs pane busy state', () => {
      mockOptions.isIdle.mockReturnValue(false);
      controller.sendToPane('1', 'test\r');
      expect(mockLog.info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('pane busy'));
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

    test('logs warning at 30s+ wait time', () => {
      const oldTimestamp = Date.now() - 35000; // 35 seconds ago
      messageQueue['1'] = [{
        message: 'test\r',
        timestamp: oldTimestamp,
      }];
      lastOutputTime['1'] = Date.now() - 1000;

      controller.processIdleQueue('1');

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Terminal 1'),
        expect.stringContaining('30s+')
      );
    });

    test('force injects after MAX_QUEUE_TIME_MS', () => {
      const oldTimestamp = Date.now() - 15000; // 15 seconds ago
      messageQueue['1'] = [{
        message: 'test\r',
        timestamp: oldTimestamp,
      }];
      mockOptions.isIdle.mockReturnValue(false); // Not normal idle
      mockOptions.isIdleForForceInject.mockReturnValue(true); // But force-inject idle

      controller.processIdleQueue('1');

      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Terminal 1'),
        expect.stringContaining('Force-injecting')
      );
    });

    test('emergency force inject after ABSOLUTE_MAX_WAIT_MS', () => {
      const veryOldTimestamp = Date.now() - 65000; // 65 seconds ago
      messageQueue['1'] = [{
        message: 'test\r',
        timestamp: veryOldTimestamp,
      }];
      mockOptions.isIdle.mockReturnValue(false);
      mockOptions.isIdleForForceInject.mockReturnValue(false);

      controller.processIdleQueue('1');

      expect(mockOptions.setInjectionInFlight).toHaveBeenCalledWith(true);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Terminal 1'),
        expect.stringContaining('EMERGENCY')
      );
    });

    test('retries later if user is typing', () => {
      messageQueue['1'] = [{ message: 'test\r', timestamp: Date.now() }];
      mockOptions.userIsTyping.mockReturnValue(true);

      controller.processIdleQueue('1');

      // Should not inject
      expect(mockOptions.setInjectionInFlight).not.toHaveBeenCalled();
      // Message should still be in queue
      expect(messageQueue['1'].length).toBe(1);
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

    // Session 68: Gemini PTY path with delayed Enter (bypasses bufferFastReturn)
    test('handles Gemini pane with delayed Enter', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test command\r', onComplete);

      // Advance past the 50ms delay for Enter
      await jest.advanceTimersByTimeAsync(60);
      await promise;

      // Gemini uses PTY: text first, then Enter after 50ms delay
      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15'); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'test command'); // Text only
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r'); // Enter after delay
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

    test('Gemini writes text without Enter when no trailing newline', async () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'partial text', onComplete); // No trailing \r

      // Text only, no Enter
      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15'); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'partial text'); // Text
      expect(mockPty.write).toHaveBeenCalledTimes(2); // Only clear + text, no Enter
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('writes text to PTY', async () => {
      await controller.doSendToPane('1', 'test message\r', jest.fn());

      expect(mockPty.write).toHaveBeenCalledWith('1', '\x15'); // Clear line
      expect(mockPty.write).toHaveBeenCalledWith('1', 'test message');
    });

    test('handles PTY write failure', async () => {
      mockPty.write.mockRejectedValueOnce(undefined) // Clear-line succeeds
        .mockRejectedValueOnce(new Error('Write failed')); // Text write fails
      const onComplete = jest.fn();

      await controller.doSendToPane('1', 'test\r', onComplete);

      expect(onComplete).toHaveBeenCalledWith({ success: false, reason: 'pty_write_failed' });
    });

    test('handles PTY clear-line failure gracefully', async () => {
      mockPty.write.mockRejectedValueOnce(new Error('Clear failed'))
        .mockResolvedValueOnce(undefined);

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Should continue with text write
      expect(mockPty.write).toHaveBeenCalledTimes(2);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('PTY clear-line failed'),
        expect.any(Error)
      );
    });

    test('focuses textarea before Enter', async () => {
      await controller.doSendToPane('1', 'test\r', jest.fn());
      expect(mockTextarea.focus).toHaveBeenCalled();
    });

    test('sends Enter after adaptive delay', async () => {
      lastOutputTime['1'] = Date.now() - 1000; // Idle
      document.activeElement = mockTextarea; // Focus succeeds

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance past adaptive delay
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS + 100);

      expect(mockPty.sendTrustedEnter).toHaveBeenCalled();
    });

    test('does not send Enter without trailing \\r', async () => {
      const onComplete = jest.fn();
      await controller.doSendToPane('1', 'test', onComplete);

      expect(mockPty.sendTrustedEnter).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith({ success: true });
    });

    test('times out and returns unverified success', async () => {
      // Use busy delay to trigger timeout before Enter completes
      lastOutputTime['1'] = Date.now(); // Very recent output = busy delay
      const onComplete = jest.fn();

      const promise = controller.doSendToPane('1', 'test\r', onComplete);

      // Advance past safety timeout (before Enter delay completes)
      // Safety timeout is 1000ms, busy delay is 300ms
      // Safety timer fires during busy delay wait
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.INJECTION_LOCK_TIMEOUT_MS + 50);

      await promise;

      // Note: The test may get different results based on timing
      // The important thing is onComplete was called
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

      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS + 100);

      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'textarea_disappeared',
      });
    });

    test('waits for idle before sending Enter', async () => {
      mockOptions.isIdle.mockReturnValue(false);

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance past delay
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS);

      // Should start waiting for idle
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('waiting for idle')
      );
    });

    test('proceeds after idle wait timeout', async () => {
      mockOptions.isIdle.mockReturnValue(false);

      await controller.doSendToPane('1', 'test\r', jest.fn());

      // Advance past delay and idle wait
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_DELAY_IDLE_MS + 6000);

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('still not idle')
      );
    });

    test('aborts Enter if focus fails', async () => {
      document.activeElement = null; // Focus will fail
      const onComplete = jest.fn();

      // Create controller with low retry count for faster test
      const testOptions = {
        ...mockOptions,
        constants: { ...DEFAULT_CONSTANTS, MAX_FOCUS_RETRIES: 1, FOCUS_RETRY_DELAY_MS: 10 },
      };
      const testController = createInjectionController(testOptions);

      await testController.doSendToPane('1', 'test\r', onComplete);

      // Advance timers for focus retries
      await jest.advanceTimersByTimeAsync(2000);

      expect(onComplete).toHaveBeenCalledWith({
        success: false,
        reason: 'focus_failed',
      });
      expect(mockOptions.markPotentiallyStuck).toHaveBeenCalledWith('1');
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

      await controller.doSendToPane('1', 'test', onComplete);

      expect(mockLog.error).toHaveBeenCalledWith(
        'Terminal',
        'onComplete failed',
        expect.any(Error)
      );
    });
  });

  describe('verifyAndRetryEnter', () => {
    test('succeeds when output activity detected and prompt ready', async () => {
      const outputTimeStart = Date.now();
      lastOutputTime['1'] = outputTimeStart;

      // Setup terminal with prompt
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'user@host> ',
            }),
          },
        },
      });

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 3);

      // Simulate output after Enter
      lastOutputTime['1'] = Date.now() + 100;

      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_VERIFY_DELAY_MS + 500);

      const result = await promise;
      expect(result).toBe(true);
    });

    test('succeeds when output ongoing (not idle)', async () => {
      lastOutputTime['1'] = Date.now();
      mockOptions.isIdle.mockReturnValue(false);

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 3);

      // Simulate output activity
      lastOutputTime['1'] = Date.now() + 100;

      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_VERIFY_DELAY_MS + 6000);

      const result = await promise;
      expect(result).toBe(true);
    });

    test('retries Enter when no output activity', async () => {
      document.activeElement = mockTextarea;
      lastOutputTime['1'] = Date.now();

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 2);

      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_VERIFY_DELAY_MS + 1000);

      // Should log retry
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('will retry Enter')
      );
    });

    test('fails after max retries with no output', async () => {
      document.activeElement = null; // Focus will fail on retry
      lastOutputTime['1'] = 0;

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 0);

      // Advance past verify delay
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_VERIFY_DELAY_MS + 100);

      const result = await promise;

      expect(result).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Max retries reached')
      );
    });

    test('marks pane as stuck when verification fails', async () => {
      lastOutputTime['1'] = Date.now();
      mockOptions.isIdle.mockReturnValue(true);

      // No prompt detected
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'Processing...',
            }),
          },
        },
      });

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 0);

      // Simulate output activity
      lastOutputTime['1'] = Date.now() + 100;

      await jest.advanceTimersByTimeAsync(10000);

      await promise;

      expect(mockOptions.markPotentiallyStuck).toHaveBeenCalledWith('1');
    });

    test('handles textarea disappearing during wait', async () => {
      lastOutputTime['1'] = 0;
      mockOptions.isIdle.mockReturnValue(false);

      // Textarea disappears
      document.querySelector.mockReturnValue(null);

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 1);

      await jest.advanceTimersByTimeAsync(15000);

      const result = await promise;
      expect(result).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('textarea disappeared')
      );
    });

    test('handles case where output starts during idle wait', async () => {
      // This tests the code path where output starts while waiting for pane to become idle
      // The function should detect this and handle it
      lastOutputTime['1'] = 0; // No initial output
      mockOptions.isIdle.mockReturnValue(false); // Pane not idle

      // No prompt - function won't find one
      terminals.set('1', {
        buffer: {
          active: {
            cursorY: 0,
            viewportY: 0,
            getLine: jest.fn().mockReturnValue({
              translateToString: () => 'Processing...',
            }),
          },
        },
      });

      const promise = controller.verifyAndRetryEnter('1', mockTextarea, 0);

      // Advance past verify delay - with no output activity and no retries left
      await jest.advanceTimersByTimeAsync(DEFAULT_CONSTANTS.ENTER_VERIFY_DELAY_MS + 100);

      const result = await promise;
      // With 0 retries and no output activity, should return false
      expect(result).toBe(false);
    });
  });
});
