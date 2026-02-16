/**
 * Terminal Recovery Tests
 * Target: Full coverage of modules/terminal/recovery.js
 */

// Mock electron
jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { ipcRenderer } = require('electron');
const log = require('../modules/logger');
const { createRecoveryController } = require('../modules/terminal/recovery');

// Mock KeyboardEvent for Node.js environment
class MockKeyboardEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.key = options.key || '';
    this.code = options.code || '';
    this.keyCode = options.keyCode || 0;
    this.which = options.which || 0;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }
}
global.KeyboardEvent = MockKeyboardEvent;

describe('Terminal Recovery Controller', () => {
  let controller;
  let mockOptions;
  let terminals;
  let lastOutputTime;
  let lastTypedTime;
  let mockPty;
  let mockTextarea;
  let mockPaneEl;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    terminals = new Map();
    lastOutputTime = {};
    lastTypedTime = {};

    mockPty = {
      write: jest.fn().mockResolvedValue(undefined),
      kill: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
    };

    mockTextarea = {
      focus: jest.fn(),
      dispatchEvent: jest.fn(),
    };

    mockPaneEl = {
      querySelector: jest.fn().mockReturnValue(mockTextarea),
    };

    global.window = { hivemind: { pty: mockPty } };
    global.document = {
      querySelector: jest.fn().mockReturnValue(mockPaneEl),
    };

    mockOptions = {
      PANE_IDS: ['1', '2', '5'],
      terminals,
      lastOutputTime,
      lastTypedTime,
      isCodexPane: jest.fn().mockReturnValue(false),
      isGeminiPane: jest.fn().mockReturnValue(false),
      updatePaneStatus: jest.fn(),
      updateConnectionStatus: jest.fn(),
      getInjectionInFlight: jest.fn().mockReturnValue(false),
      userIsTyping: jest.fn().mockReturnValue(false),
      getInjectionHelpers: jest.fn().mockReturnValue({
        focusWithRetry: jest.fn().mockResolvedValue(true),
        sendEnterToPane: jest.fn().mockResolvedValue({ success: true, method: 'keyboard' }),
      }),
      spawnAgent: jest.fn().mockResolvedValue(undefined),
      syncTerminalInputBridge: jest.fn(),
    };

    controller = createRecoveryController(mockOptions);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.window;
    delete global.document;
  });

  describe('createRecoveryController', () => {
    test('creates controller with all methods', () => {
      expect(controller.markPotentiallyStuck).toBeDefined();
      expect(controller.clearStuckStatus).toBeDefined();
      expect(controller.sweepStuckMessages).toBeDefined();
      expect(controller.startStuckMessageSweeper).toBeDefined();
      expect(controller.stopStuckMessageSweeper).toBeDefined();
      expect(controller.interruptPane).toBeDefined();
      expect(controller.restartPane).toBeDefined();
      expect(controller.unstickEscalation).toBeDefined();
      expect(controller.nudgePane).toBeDefined();
      expect(controller.nudgeAllPanes).toBeDefined();
      expect(controller.sendUnstick).toBeDefined();
      expect(controller.aggressiveNudge).toBeDefined();
      expect(controller.aggressiveNudgeAll).toBeDefined();
    });

    test('exposes potentiallyStuckPanes map', () => {
      expect(controller.potentiallyStuckPanes).toBeInstanceOf(Map);
    });

    test('handles missing options gracefully', () => {
      const minimalController = createRecoveryController({});
      expect(minimalController.markPotentiallyStuck).toBeDefined();
    });
  });

  describe('markPotentiallyStuck', () => {
    test('marks a pane as stuck', () => {
      controller.markPotentiallyStuck('1');

      expect(controller.potentiallyStuckPanes.has('1')).toBe(true);
      expect(log.info).toHaveBeenCalledWith('StuckSweeper 1', 'Marked as potentially stuck');
    });

    test('increments retry count for already stuck pane', () => {
      controller.markPotentiallyStuck('1');
      controller.markPotentiallyStuck('1');

      const info = controller.potentiallyStuckPanes.get('1');
      expect(info.retryCount).toBe(1);
      expect(log.info).toHaveBeenCalledWith('StuckSweeper 1', 'Re-marked as stuck (retry #1)');
    });

    test('skips Gemini panes', () => {
      mockOptions.isGeminiPane.mockReturnValue(true);
      controller = createRecoveryController(mockOptions);

      controller.markPotentiallyStuck('5');

      expect(controller.potentiallyStuckPanes.has('5')).toBe(false);
    });
  });

  describe('clearStuckStatus', () => {
    test('clears stuck status for a pane', () => {
      controller.markPotentiallyStuck('1');
      controller.clearStuckStatus('1');

      expect(controller.potentiallyStuckPanes.has('1')).toBe(false);
      expect(log.info).toHaveBeenCalledWith('StuckSweeper 1', 'Cleared stuck status (pane active)');
    });

    test('does nothing for non-stuck pane', () => {
      controller.clearStuckStatus('1');

      // Should not log anything for non-stuck pane
      expect(log.info).not.toHaveBeenCalledWith('StuckSweeper 1', expect.any(String));
    });
  });

  describe('sweepStuckMessages', () => {
    test('skips if injection in flight', async () => {
      mockOptions.getInjectionInFlight.mockReturnValue(true);
      controller = createRecoveryController(mockOptions);
      controller.markPotentiallyStuck('1');

      await controller.sweepStuckMessages();

      expect(mockOptions.getInjectionHelpers().focusWithRetry).not.toHaveBeenCalled();
    });

    test('skips if user is typing', async () => {
      mockOptions.userIsTyping.mockReturnValue(true);
      controller = createRecoveryController(mockOptions);
      controller.markPotentiallyStuck('1');

      await controller.sweepStuckMessages();

      expect(mockOptions.getInjectionHelpers().focusWithRetry).not.toHaveBeenCalled();
    });

    test('skips if helpers not available', async () => {
      mockOptions.getInjectionHelpers.mockReturnValue(null);
      controller = createRecoveryController(mockOptions);
      controller.markPotentiallyStuck('1');

      await controller.sweepStuckMessages();

      // Should return early without error
      expect(document.querySelector).not.toHaveBeenCalled();
    });

    test('removes entries older than max age', async () => {
      controller.markPotentiallyStuck('1');

      // Advance past SWEEPER_MAX_AGE_MS (300000ms = 5 minutes)
      jest.advanceTimersByTime(310000);

      await controller.sweepStuckMessages();

      expect(controller.potentiallyStuckPanes.has('1')).toBe(false);
      expect(log.warn).toHaveBeenCalledWith('StuckSweeper 1', expect.stringContaining('Giving up'));
    });

    test('skips active panes (recent output)', async () => {
      controller.markPotentiallyStuck('1');
      lastOutputTime['1'] = Date.now();

      await controller.sweepStuckMessages();

      // Should not attempt recovery on active pane
      expect(mockOptions.getInjectionHelpers().focusWithRetry).not.toHaveBeenCalled();
    });

    test('attempts recovery on idle stuck pane', async () => {
      controller.markPotentiallyStuck('1');
      lastOutputTime['1'] = Date.now() - 15000; // Idle for 15 seconds

      await controller.sweepStuckMessages();

      expect(mockOptions.getInjectionHelpers().focusWithRetry).toHaveBeenCalled();
      expect(mockOptions.getInjectionHelpers().sendEnterToPane).toHaveBeenCalledWith('1');
      expect(log.info).toHaveBeenCalledWith('StuckSweeper 1', expect.stringContaining('Recovery Enter sent'));
    });

    test('logs warning if focus fails', async () => {
      mockOptions.getInjectionHelpers.mockReturnValue({
        focusWithRetry: jest.fn().mockResolvedValue(false),
        sendEnterToPane: jest.fn(),
      });
      controller = createRecoveryController(mockOptions);
      controller.markPotentiallyStuck('1');
      lastOutputTime['1'] = Date.now() - 15000;

      await controller.sweepStuckMessages();

      expect(log.warn).toHaveBeenCalledWith('StuckSweeper 1', 'Focus failed for recovery');
    });

    test('logs error if Enter fails', async () => {
      mockOptions.getInjectionHelpers.mockReturnValue({
        focusWithRetry: jest.fn().mockResolvedValue(true),
        sendEnterToPane: jest.fn().mockResolvedValue({ success: false }),
      });
      controller = createRecoveryController(mockOptions);
      controller.markPotentiallyStuck('1');
      lastOutputTime['1'] = Date.now() - 15000;

      await controller.sweepStuckMessages();

      expect(log.error).toHaveBeenCalledWith('StuckSweeper 1', 'Recovery Enter failed');
    });

    test('handles missing textarea gracefully', async () => {
      document.querySelector.mockReturnValue({ querySelector: () => null });
      controller.markPotentiallyStuck('1');
      lastOutputTime['1'] = Date.now() - 15000;

      await controller.sweepStuckMessages();

      // Should not throw
      expect(mockOptions.getInjectionHelpers().focusWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('startStuckMessageSweeper', () => {
    test('starts interval for sweeping', () => {
      controller.startStuckMessageSweeper();

      expect(log.info).toHaveBeenCalledWith('Terminal', expect.stringContaining('sweeper started'));
    });

    test('does not start multiple intervals', () => {
      controller.startStuckMessageSweeper();
      controller.startStuckMessageSweeper();

      // Should only log once
      const calls = log.info.mock.calls.filter(
        call => call[0] === 'Terminal' && call[1].includes('sweeper started')
      );
      expect(calls.length).toBe(1);
    });
  });

  describe('stopStuckMessageSweeper', () => {
    test('stops the sweeper interval', () => {
      controller.startStuckMessageSweeper();
      controller.stopStuckMessageSweeper();

      expect(log.info).toHaveBeenCalledWith('Terminal', 'Stuck message sweeper stopped');
    });

    test('does nothing if not running', () => {
      controller.stopStuckMessageSweeper();

      expect(log.info).not.toHaveBeenCalledWith('Terminal', 'Stuck message sweeper stopped');
    });
  });

  describe('interruptPane', () => {
    test('uses IPC invoke for PTY interrupt', async () => {
      const result = await controller.interruptPane('1');

      expect(result).toBe(true);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('interrupt-pane', '1');
      expect(log.info).toHaveBeenCalledWith('Terminal', 'Interrupt sent to pane 1');
    });

    test('falls back to PTY write if no ipcRenderer', async () => {
      const originalInvoke = ipcRenderer.invoke;
      ipcRenderer.invoke = undefined;

      const result = await controller.interruptPane('1');

      expect(result).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith('1', '\x03');

      ipcRenderer.invoke = originalInvoke;
    });

    test('handles PTY interrupt failure', async () => {
      ipcRenderer.invoke.mockRejectedValueOnce(new Error('IPC error'));

      const result = await controller.interruptPane('1');

      expect(result).toBe(false);
      expect(log.error).toHaveBeenCalledWith('Terminal', expect.stringContaining('Interrupt failed'), expect.any(Error));
    });
  });

  describe('restartPane', () => {
    test('kills pane and respawns', async () => {
      const promise = controller.restartPane('1');
      await jest.advanceTimersByTimeAsync(300); // Past the 250ms delay
      const result = await promise;

      expect(result).toBe(true);
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Restarting...');
      expect(mockPty.kill).toHaveBeenCalledWith('1');
      expect(mockOptions.spawnAgent).toHaveBeenCalledWith('1', null);
    });

    test('passes model parameter to spawnAgent when provided', async () => {
      const promise = controller.restartPane('1', 'gemini');
      await jest.advanceTimersByTimeAsync(300);
      const result = await promise;

      expect(result).toBe(true);
      expect(mockOptions.spawnAgent).toHaveBeenCalledWith('1', 'gemini');
      expect(mockOptions.syncTerminalInputBridge).toHaveBeenCalledWith('1', { modelHint: 'gemini' });
    });

    test('handles kill failure gracefully', async () => {
      mockPty.kill.mockRejectedValueOnce(new Error('Kill error'));

      const promise = controller.restartPane('1');
      await jest.advanceTimersByTimeAsync(300);
      const result = await promise;

      expect(result).toBe(true); // Still tries to spawn
      expect(log.error).toHaveBeenCalledWith('Terminal', expect.stringContaining('Failed to kill'), expect.any(Error));
    });

    test('recreates PTY for Codex panes', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      controller = createRecoveryController(mockOptions);

      const promise = controller.restartPane('2');
      await jest.advanceTimersByTimeAsync(300);
      const result = await promise;

      expect(result).toBe(true);
      expect(mockPty.create).toHaveBeenCalledWith('2');
      expect(log.info).toHaveBeenCalledWith('Terminal', 'Recreated PTY for pane 2');
    });

    test('handles Codex PTY creation failure', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      mockPty.create.mockRejectedValueOnce(new Error('Create error'));
      controller = createRecoveryController(mockOptions);

      const promise = controller.restartPane('2');
      await jest.advanceTimersByTimeAsync(300);
      const result = await promise;

      expect(result).toBe(false);
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('2', 'Restart failed');
      expect(log.error).toHaveBeenCalledWith('Terminal', expect.stringContaining('Failed to recreate PTY'), expect.any(Error));
    });
  });

  describe('unstickEscalation', () => {
    test('first call nudges', async () => {
      await controller.unstickEscalation('1');
      // Advance timer for aggressiveNudge's internal setTimeout (150ms)
      await jest.advanceTimersByTimeAsync(200);

      expect(log.info).toHaveBeenCalledWith('Unstick', 'Pane 1: nudge');
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Nudged');
    });

    test('second call interrupts', async () => {
      await controller.unstickEscalation('1');
      await jest.advanceTimersByTimeAsync(200);
      await controller.unstickEscalation('1');

      expect(log.info).toHaveBeenCalledWith('Unstick', 'Pane 1: interrupt');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('interrupt-pane', '1');
    });

    test('third call restarts', async () => {
      await controller.unstickEscalation('1');
      await jest.advanceTimersByTimeAsync(200);
      await controller.unstickEscalation('1');
      const promise = controller.unstickEscalation('1');
      await jest.advanceTimersByTimeAsync(300); // For restartPane's 250ms delay
      await promise;

      expect(log.info).toHaveBeenCalledWith('Unstick', 'Pane 1: restart');
      expect(mockPty.kill).toHaveBeenCalledWith('1');
    });

    test('resets escalation state after timeout', async () => {
      await controller.unstickEscalation('1'); // step 0 -> 1
      await jest.advanceTimersByTimeAsync(200);

      // Advance past UNSTICK_RESET_MS (30000ms)
      await jest.advanceTimersByTimeAsync(35000);

      await controller.unstickEscalation('1'); // Should reset to step 0
      await jest.advanceTimersByTimeAsync(200);

      // Should nudge again, not interrupt
      const nudgeCalls = log.info.mock.calls.filter(
        call => call[0] === 'Unstick' && call[1] === 'Pane 1: nudge'
      );
      expect(nudgeCalls.length).toBe(2);
    });
  });

  describe('nudgePane', () => {
    test('sends Enter to pane', () => {
      controller.nudgePane('1');

      expect(lastTypedTime['1']).toBeDefined();
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Nudged');
    });

    test('handles PTY write failure', () => {
      mockPty.write.mockRejectedValueOnce(new Error('Write error'));

      controller.nudgePane('1');

      // Verify write was called (error handling is async)
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
    });

    test('resets status after timeout', () => {
      controller.nudgePane('1');
      jest.advanceTimersByTime(1000);

      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Running');
    });
  });

  describe('sendUnstick', () => {
    test('sends ESC keyboard events to pane', () => {
      controller.sendUnstick('1');

      expect(mockTextarea.focus).toHaveBeenCalled();
      expect(mockTextarea.dispatchEvent).toHaveBeenCalledTimes(2); // keydown + keyup

      const dispatchCalls = mockTextarea.dispatchEvent.mock.calls;
      expect(dispatchCalls[0][0]).toBeInstanceOf(MockKeyboardEvent);
      expect(dispatchCalls[0][0].key).toBe('Escape');
      expect(dispatchCalls[1][0]).toBeInstanceOf(MockKeyboardEvent);
      expect(dispatchCalls[1][0].key).toBe('Escape');
    });

    test('updates pane status', () => {
      controller.sendUnstick('1');

      expect(mockOptions.updatePaneStatus).toHaveBeenCalledWith('1', 'Unstick sent');
    });

    test('handles missing textarea', () => {
      document.querySelector.mockReturnValue({ querySelector: () => null });

      controller.sendUnstick('1');

      expect(log.warn).toHaveBeenCalledWith('Terminal 1', 'Could not find xterm textarea for unstick');
    });

    test('handles missing pane element', () => {
      document.querySelector.mockReturnValue(null);

      controller.sendUnstick('1');

      expect(log.warn).toHaveBeenCalledWith('Terminal 1', 'Could not find xterm textarea for unstick');
    });
  });

  describe('aggressiveNudge', () => {
    test('sends ESC followed by Enter', async () => {
      controller.aggressiveNudge('1');

      // ESC should be sent immediately
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();

      // Advance past the 150ms delay
      await jest.advanceTimersByTimeAsync(200);

      // Enter should now be sent
      expect(mockTextarea.dispatchEvent.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    test('uses PTY carriage return for Codex panes', async () => {
      mockOptions.isCodexPane.mockReturnValue(true);
      controller = createRecoveryController(mockOptions);

      controller.aggressiveNudge('2');
      await jest.advanceTimersByTimeAsync(200);

      // Codex uses PTY \r like Gemini (not sendTrustedEnter)
      expect(mockPty.write).toHaveBeenCalledWith('2', '\r');
    });

    test('sets bypass flag on terminal for Claude', async () => {
      const terminal = { _hivemindBypass: false };
      terminals.set('1', terminal);

      controller.aggressiveNudge('1');
      await jest.advanceTimersByTimeAsync(200);

      // The bypass flag is set before DOM Enter dispatch and cleared later by timer
      expect(terminal._hivemindBypass).toBe(true);
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
    });

    test('handles missing textarea with fallback', async () => {
      document.querySelector.mockReturnValue(null);

      controller.aggressiveNudge('1');
      await jest.advanceTimersByTimeAsync(200);

      expect(log.warn).toHaveBeenCalledWith('Terminal 1', 'Aggressive nudge: no textarea, PTY fallback');
      expect(mockPty.write).toHaveBeenCalledWith('1', '\r');
    });

    test('handles DOM Enter dispatch failure', async () => {
      mockTextarea.dispatchEvent.mockImplementation((evt) => {
        if (evt?.key === 'Enter') {
          throw new Error('Enter error');
        }
        return true;
      });

      controller.aggressiveNudge('1');
      await jest.advanceTimersByTimeAsync(200);

      expect(log.error).toHaveBeenCalledWith('aggressiveNudge 1', 'DOM Enter dispatch failed:', expect.any(Error));
    });
  });

  describe('aggressiveNudgeAll', () => {
    test('nudges all panes with staggering', async () => {
      controller.aggressiveNudgeAll();

      expect(log.info).toHaveBeenCalledWith('Terminal', 'Aggressive nudge all panes');

      // First pane should be nudged after 200ms (paneId * 200)
      await jest.advanceTimersByTimeAsync(250);
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();

      // Clear and advance for more panes
      mockTextarea.dispatchEvent.mockClear();
      await jest.advanceTimersByTimeAsync(400);
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
    });
  });

  describe('nudgeAllPanes', () => {
    test('nudges all configured panes', () => {
      controller.nudgeAllPanes();

      expect(mockOptions.updateConnectionStatus).toHaveBeenCalledWith('Nudging all agents...');

      // Should write to each pane
      for (const paneId of mockOptions.PANE_IDS) {
        expect(mockPty.write).toHaveBeenCalledWith(paneId, '\r');
      }
    });

    test('updates connection status after delay', () => {
      controller.nudgeAllPanes();
      jest.advanceTimersByTime(200);

      expect(mockOptions.updateConnectionStatus).toHaveBeenCalledWith('All agents nudged');
    });
  });

  describe('edge cases', () => {
    test('handles undefined callbacks gracefully', () => {
      const minimalController = createRecoveryController({
        terminals: new Map(),
        lastOutputTime: {},
        lastTypedTime: {},
        PANE_IDS: [],
      });

      // nudgePane should not throw (updatePaneStatus is optional)
      expect(() => minimalController.nudgePane('1')).not.toThrow();
      // sendUnstick dispatches KeyboardEvent - should work with our mock
      expect(() => minimalController.sendUnstick('1')).not.toThrow();
    });

    test('converts pane ID to string consistently', async () => {
      await controller.interruptPane(1); // numeric

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('interrupt-pane', '1');
    });

    test('handles concurrent stuck panes', async () => {
      controller.markPotentiallyStuck('1');
      controller.markPotentiallyStuck('3');
      controller.markPotentiallyStuck('6');

      expect(controller.potentiallyStuckPanes.size).toBe(3);
    });
  });
});
