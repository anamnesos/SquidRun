/**
 * Recovery Manager Tests
 * Target: Full coverage of recovery-manager.js
 */

'use strict';

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { createRecoveryManager } = require('../modules/recovery-manager');

// performRestart is async — after advancing timers, flush microtasks
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('Recovery Manager', () => {
  let notifyEvent;
  let requestRestart;
  let requestUnstick;
  let resendTask;
  let getSettings;
  let isCodexPane;

  function createManager(overrides = {}) {
    return createRecoveryManager({
      getSettings,
      getAllActivity: () => ({}),
      getDaemonTerminals: () => [],
      isPaneRunning: () => true,
      isCodexPane,
      requestRestart,
      requestUnstick,
      resendTask,
      notifyEvent,
      ...overrides,
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    jest.clearAllMocks();

    notifyEvent = jest.fn();
    requestRestart = jest.fn();
    requestUnstick = jest.fn();
    resendTask = jest.fn().mockResolvedValue(true);
    getSettings = jest.fn().mockReturnValue({});
    isCodexPane = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── handleExit ──

  describe('handleExit', () => {
    test('schedules restart after unexpected exit', async () => {
      const manager = createManager();
      manager.handleExit('1', 1);

      expect(requestRestart).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5000);
      await flush();

      expect(requestRestart).toHaveBeenCalledTimes(1);
      expect(requestRestart).toHaveBeenCalledWith('1', expect.objectContaining({
        reason: 'exit-1',
        attempt: 1,
      }));
    });

    test('does not restart on expected exit', async () => {
      const manager = createManager();
      manager.markExpectedExit('1', 'manual');
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(10000);
      await flush();

      expect(requestRestart).not.toHaveBeenCalled();
    });

    test('emits expected exit event', () => {
      const manager = createManager();
      manager.markExpectedExit('1', 'manual');
      manager.handleExit('1', 1);

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'exit',
        paneId: '1',
        status: 'expected',
      }));
    });

    test('emits unexpected exit event', () => {
      const manager = createManager();
      manager.handleExit('1', 1);

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'exit',
        paneId: '1',
        status: 'unexpected',
      }));
    });

    test('codex exit 0 triggers immediate restart', async () => {
      isCodexPane.mockReturnValue(true);
      const manager = createManager();

      manager.handleExit('2', 0);
      await flush();

      expect(requestRestart).toHaveBeenCalledTimes(1);
      expect(requestRestart).toHaveBeenCalledWith('2', expect.objectContaining({
        reason: 'codex-completion',
      }));
    });

    test('codex exit 0 emits codex_completed event', () => {
      isCodexPane.mockReturnValue(true);
      const manager = createManager();
      manager.handleExit('2', 0);

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'exit',
        status: 'codex_completed',
      }));
    });

    test('codex non-zero exit is treated as failure', () => {
      isCodexPane.mockReturnValue(true);
      const manager = createManager();
      manager.handleExit('2', 1);

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'exit',
        status: 'unexpected',
      }));
    });

    test('opens circuit after repeated failures', async () => {
      const manager = createManager();

      for (let i = 0; i < 3; i++) {
        manager.handleExit('1', 1);
        jest.advanceTimersByTime(200000);
        await flush();
      }

      const status = manager.getStatus();
      expect(status['1'].status).toBe('circuit_open');
    });

    test('emits circuit open event after repeated failures', async () => {
      const manager = createManager();

      for (let i = 0; i < 3; i++) {
        manager.handleExit('1', 1);
        jest.advanceTimersByTime(200000);
        await flush();
      }

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'circuit',
        status: 'open',
      }));
    });
  });

  // ── markExpectedExit ──

  describe('markExpectedExit', () => {
    test('expires after TTL', () => {
      const manager = createManager();
      manager.markExpectedExit('1', 'manual');

      // Advance past expectedExitTtlMs (15s default)
      jest.advanceTimersByTime(16000);
      manager.handleExit('1', 1);

      // Should be treated as unexpected since TTL expired
      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'exit',
        status: 'unexpected',
      }));
    });
  });

  // ── recordActivity ──

  describe('recordActivity', () => {
    test('resets stuck state to healthy', () => {
      const manager = createManager();
      manager.handleStuck('1', 120000);

      const stuck = manager.getStatus();
      expect(stuck['1'].status).toBe('stuck');

      manager.recordActivity('1');
      const healthy = manager.getStatus();
      expect(healthy['1'].status).toBe('healthy');
    });

    test('emits recovery healthy event when leaving non-healthy state', () => {
      const manager = createManager();
      manager.handleStuck('1', 120000);
      notifyEvent.mockClear();

      manager.recordActivity('1');

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'recovery',
        status: 'healthy',
      }));
    });

    test('does not emit recovery event when already healthy', () => {
      const manager = createManager();
      notifyEvent.mockClear();

      manager.recordActivity('1');

      const recoveryEvents = notifyEvent.mock.calls.filter(
        c => c[0].type === 'recovery'
      );
      expect(recoveryEvents).toHaveLength(0);
    });

    test('triggers pending resend after restart', async () => {
      const manager = createManager();
      manager.recordTask('1', 'do something');
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();

      // After restart, pane shows activity
      manager.recordActivity('1');

      // resyncDelayMs is 15s by default
      jest.advanceTimersByTime(15000);
      await flush();

      expect(resendTask).toHaveBeenCalled();
    });
  });

  // ── recordTask ──

  describe('recordTask', () => {
    test('stores task message and metadata', () => {
      const manager = createManager();
      manager.recordTask('1', 'fix the bug', { priority: 'high' });

      const status = manager.getStatus();
      expect(status['1'].lastTask).toBe('fix the bug');
      expect(status['1'].lastTaskMeta).toEqual({ priority: 'high' });
    });

    test('truncates long messages to MAX_TASK_CHARS', () => {
      const manager = createManager();
      const longMsg = 'x'.repeat(5000);
      manager.recordTask('1', longMsg);

      const status = manager.getStatus();
      expect(status['1'].lastTask.length).toBe(4000);
    });

    test('resets retry state', () => {
      const manager = createManager();
      manager.recordTask('1', 'old task');
      manager.recordTask('1', 'new task');
      const status = manager.getStatus();
      expect(status['1'].taskRetryAttempts).toBe(0);
      expect(status['1'].pendingResend).toBe(false);
    });

    test('handles null message', () => {
      const manager = createManager();
      manager.recordTask('1', null);
      const status = manager.getStatus();
      expect(status['1'].lastTask).toBe('');
    });
  });

  // ── handleStuck ──

  describe('handleStuck', () => {
    test('marks pane as stuck', () => {
      const manager = createManager();
      manager.handleStuck('1', 120000);

      const status = manager.getStatus();
      expect(status['1'].status).toBe('stuck');
    });

    test('emits stuck detected event', () => {
      const manager = createManager();
      manager.handleStuck('1', 120000, 'idle');

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stuck',
        status: 'detected',
      }));
    });

    test('schedules restart after stuckConfirmCount', async () => {
      const manager = createManager();
      manager.handleStuck('1', 120000); // count 1
      manager.handleStuck('1', 120000); // count 2 = threshold

      jest.advanceTimersByTime(10000);
      await flush();
      expect(requestRestart).toHaveBeenCalled();
    });

    test('does not schedule restart before confirm count', async () => {
      const manager = createManager();
      manager.handleStuck('1', 120000); // count 1 only

      jest.advanceTimersByTime(200000);
      await flush();
      // Not enough stuck confirmations
      expect(requestRestart).not.toHaveBeenCalled();
    });
  });

  // ── resetCircuit ──

  describe('resetCircuit', () => {
    test('resets circuit breaker to healthy', async () => {
      const manager = createManager();

      for (let i = 0; i < 3; i++) {
        manager.handleExit('1', 1);
        jest.advanceTimersByTime(200000);
        await flush();
      }
      expect(manager.getStatus()['1'].status).toBe('circuit_open');

      manager.resetCircuit('1');
      expect(manager.getStatus()['1'].status).toBe('healthy');
    });

    test('emits circuit reset event', () => {
      const manager = createManager();
      manager.resetCircuit('1');

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'circuit',
        status: 'reset',
      }));
    });

    test('clears failure timestamps', async () => {
      const manager = createManager();
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(10000);
      await flush();

      manager.resetCircuit('1');
      const status = manager.getStatus();
      expect(status['1'].failureTimestamps).toEqual([]);
    });
  });

  // ── scheduleRestart ──

  describe('scheduleRestart', () => {
    test('emits scheduled restart event', () => {
      const manager = createManager();
      manager.scheduleRestart('1', 'test-reason');

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'restart',
        status: 'scheduled',
      }));
    });

    test('does not restart when circuit is open', () => {
      const manager = createManager();

      // 3 rapid failures trip the circuit breaker
      manager.handleExit('1', 1);
      manager.handleExit('1', 1);
      manager.handleExit('1', 1);

      expect(manager.getStatus()['1'].status).toBe('circuit_open');
      requestRestart.mockClear();

      const result = manager.scheduleRestart('1', 'test');
      expect(result).toBe(false);
    });

    test('does not schedule duplicate restarts', async () => {
      const manager = createManager();
      manager.scheduleRestart('1', 'reason1');
      const result = manager.scheduleRestart('1', 'reason2');
      expect(result).toBe(true);

      jest.advanceTimersByTime(10000);
      await flush();
      expect(requestRestart).toHaveBeenCalledTimes(1);
    });
  });

  // ── scheduleTaskRetry ──

  describe('scheduleTaskRetry', () => {
    test('returns false when no task recorded', () => {
      const manager = createManager();
      const result = manager.scheduleTaskRetry('1');
      expect(result).toBe(false);
    });

    test('returns false when no resendTask function', () => {
      const manager = createManager({ resendTask: undefined });
      manager.recordTask('1', 'some task');
      const result = manager.scheduleTaskRetry('1');
      expect(result).toBe(false);
    });

    test('schedules retry with backoff', () => {
      const manager = createManager();
      manager.recordTask('1', 'some task');
      const result = manager.scheduleTaskRetry('1');
      expect(result).toBe(true);

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'resend',
        status: 'scheduled',
      }));
    });

    test('opens circuit after max retry attempts', async () => {
      const failResend = jest.fn().mockResolvedValue(false);
      const manager = createManager({ resendTask: failResend });
      manager.recordTask('1', 'some task');

      // Exhaust all attempts (default 5)
      for (let i = 0; i < 5; i++) {
        manager.scheduleTaskRetry('1');
        jest.advanceTimersByTime(120000);
        await flush();
      }

      // After 5 attempts, next should open circuit
      manager.scheduleTaskRetry('1');
      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'circuit',
        status: 'open',
      }));
    });
  });

  // ── recordPtyOutput ──

  describe('recordPtyOutput', () => {
    test('ignores null data', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', null);
      // No error thrown
    });

    test('ignores codex panes', () => {
      isCodexPane.mockReturnValue(true);
      const manager = createManager();
      manager.recordPtyOutput('1', '0 tokens 30s');
      expect(requestUnstick).not.toHaveBeenCalled();
    });

    test('ignores when ptyStuckDetection disabled', () => {
      getSettings.mockReturnValue({ ptyStuckDetection: false });
      const manager = createManager();
      manager.recordPtyOutput('1', '0 tokens 30s');
      expect(requestUnstick).not.toHaveBeenCalled();
    });

    test('ignores data with no token/timer info', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', 'just some text without numbers');
      // No stuck detection triggered
    });

    test('resets stuck state when tokens > 0', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', '500 tokens 10s');
      const status = manager.getStatus();
      expect(status['1'].ptyStuckActive).toBe(false);
    });

    test('detects stuck when 0 tokens and timer stalled', () => {
      const manager = createManager();

      // First: establish token count at 0 and set timer
      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(1000);

      // Timer stays the same (stalled)
      manager.recordPtyOutput('1', '0 tokens 10s');

      // Advance past threshold (15s default)
      jest.advanceTimersByTime(16000);
      manager.recordPtyOutput('1', '0 tokens 10s');

      expect(requestUnstick).toHaveBeenCalledWith('1', expect.objectContaining({
        reason: 'pty-stuck',
      }));
    });

    test('emits pty-stuck event', () => {
      const manager = createManager();

      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(1000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(16000);
      manager.recordPtyOutput('1', '0 tokens 10s');

      expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'pty-stuck',
        status: 'detected',
      }));
    });

    test('respects cooldown between unstick requests', () => {
      const manager = createManager();

      // First stuck detection
      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(1000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(16000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      expect(requestUnstick).toHaveBeenCalledTimes(1);

      // Within cooldown (30s default)
      jest.advanceTimersByTime(1000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      expect(requestUnstick).toHaveBeenCalledTimes(1); // still 1
    });

    test('strips ANSI from input', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', '\x1b[33m500 tokens\x1b[0m 10s');
      const status = manager.getStatus();
      expect(status['1'].ptyTokenCount).toBe(500);
    });

    test('parses K suffix in token count', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', '2.5K tokens 10s');
      const status = manager.getStatus();
      expect(status['1'].ptyTokenCount).toBe(2500);
    });

    test('parses M suffix in token count', () => {
      const manager = createManager();
      manager.recordPtyOutput('1', '1.5M tokens 10s');
      const status = manager.getStatus();
      expect(status['1'].ptyTokenCount).toBe(1500000);
    });

    test('does not trigger stuck when timer advances', () => {
      const manager = createManager();

      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(5000);
      manager.recordPtyOutput('1', '0 tokens 15s'); // timer advanced
      jest.advanceTimersByTime(20000);
      manager.recordPtyOutput('1', '0 tokens 20s'); // timer still advancing

      expect(requestUnstick).not.toHaveBeenCalled();
    });

    test('does not trigger stuck when timer resets', () => {
      const manager = createManager();

      manager.recordPtyOutput('1', '0 tokens 30s');
      jest.advanceTimersByTime(5000);
      manager.recordPtyOutput('1', '0 tokens 5s'); // timer reset (new request)

      expect(requestUnstick).not.toHaveBeenCalled();
    });

    test('skips when no requestUnstick callback', () => {
      const manager = createManager({ requestUnstick: undefined });

      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(1000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      jest.advanceTimersByTime(16000);
      manager.recordPtyOutput('1', '0 tokens 10s');
      // Should not throw
    });
  });

  // ── getStatus ──

  describe('getStatus', () => {
    test('returns empty status for fresh manager', () => {
      const manager = createManager();
      const status = manager.getStatus();
      expect(typeof status).toBe('object');
    });

    test('includes state for active panes', () => {
      const manager = createManager();
      manager.recordActivity('1');
      manager.recordActivity('2');

      const status = manager.getStatus();
      expect(status['1']).toBeDefined();
      expect(status['2']).toBeDefined();
      expect(status['1'].status).toBe('healthy');
    });

    test('includes panes from getAllActivity', () => {
      const manager = createManager({
        getAllActivity: () => ({ '1': Date.now(), '5': Date.now() }),
      });
      const status = manager.getStatus();
      expect(status['1']).toBeDefined();
      expect(status['5']).toBeDefined();
    });
  });

  // ── getHealthSnapshot ──

  describe('getHealthSnapshot', () => {
    test('returns timestamp and playbooks', () => {
      const manager = createManager();
      const snapshot = manager.getHealthSnapshot();

      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.playbooks).toBeDefined();
      expect(snapshot.playbooks.stuck).toBeDefined();
      expect(snapshot.playbooks.crash).toBeDefined();
      expect(snapshot.playbooks.circuit).toBeDefined();
    });

    test('includes terminal list', () => {
      const manager = createManager({
        getDaemonTerminals: () => ['term1', 'term2'],
      });
      const snapshot = manager.getHealthSnapshot();
      expect(snapshot.terminals).toEqual(['term1', 'term2']);
    });

    test('includes running status from isPaneRunning', () => {
      const manager = createManager({
        isPaneRunning: (id) => id === '1',
        getAllActivity: () => ({ '1': Date.now() }),
      });
      const snapshot = manager.getHealthSnapshot();
      expect(snapshot.panes['1'].running).toBe(true);
    });

    test('handles missing optional callbacks', () => {
      const manager = createManager({
        getDaemonTerminals: undefined,
        getAllActivity: undefined,
        isPaneRunning: undefined,
      });
      const snapshot = manager.getHealthSnapshot();
      expect(snapshot.terminals).toEqual([]);
    });
  });

  // ── getPlaybooks ──

  describe('getPlaybooks', () => {
    test('returns all playbooks', () => {
      const manager = createManager();
      const playbooks = manager.getPlaybooks();
      expect(playbooks.stuck.title).toBe('Stuck Agent Recovery');
      expect(playbooks.crash.title).toBe('Unexpected Exit Recovery');
      expect(playbooks.circuit.title).toBe('Circuit Breaker Open');
    });
  });

  // ── stop ──

  describe('stop', () => {
    test('clears all timers', async () => {
      const manager = createManager();
      manager.handleExit('1', 1); // schedules restart
      manager.recordTask('2', 'task');

      manager.stop();

      requestRestart.mockClear();
      jest.advanceTimersByTime(200000);
      await flush();
      // No new restart calls after stop
      expect(requestRestart).not.toHaveBeenCalled();
    });
  });

  // ── performRestart lifecycle ──

  describe('performRestart lifecycle', () => {
    test('calls beforeRestart and afterRestart', async () => {
      const br = jest.fn();
      const ar = jest.fn();
      const manager = createManager({ beforeRestart: br, afterRestart: ar });
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();

      expect(br).toHaveBeenCalledWith('1', 'exit-1');
      expect(ar).toHaveBeenCalledWith('1', 'exit-1');
    });

    test('handles beforeRestart error gracefully', async () => {
      const br = jest.fn().mockRejectedValue(new Error('hook fail'));
      const manager = createManager({ beforeRestart: br });
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();

      // Should still proceed to requestRestart
      expect(requestRestart).toHaveBeenCalled();
    });

    test('handles afterRestart error gracefully', async () => {
      const ar = jest.fn().mockRejectedValue(new Error('hook fail'));
      const manager = createManager({ afterRestart: ar });
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();

      expect(requestRestart).toHaveBeenCalled();
    });

    test('sets pendingResend when task exists', async () => {
      const manager = createManager();
      manager.recordTask('1', 'important task');
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();

      const status = manager.getStatus();
      expect(status['1'].pendingResend).toBe(true);
    });
  });

  // ── getConfig with custom settings ──

  describe('config', () => {
    test('falls back to defaults when getSettings is not a function', async () => {
      const manager = createManager({ getSettings: null });
      manager.handleExit('1', 1);
      jest.advanceTimersByTime(5000);
      await flush();
      expect(requestRestart).toHaveBeenCalled();
    });
  });
});
