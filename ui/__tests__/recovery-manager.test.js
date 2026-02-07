/**
 * Recovery Manager Tests
 * Focus: PTY exit -> auto-restart scheduling
 */

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { createRecoveryManager } = require('../modules/recovery-manager');

describe('Recovery Manager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(0));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('schedules restart after unexpected exit', async () => {
    const requestRestart = jest.fn();

    const manager = createRecoveryManager({
      getSettings: () => ({}),
      getAllActivity: () => ({}),
      requestRestart,
      isCodexPane: () => false,
    });

    manager.handleExit('1', 1);

    expect(requestRestart).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5000);

    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(requestRestart).toHaveBeenCalledWith('1', expect.objectContaining({
      reason: 'exit-1',
      attempt: 1,
    }));
  });

  test('does not restart on expected exit', () => {
    const requestRestart = jest.fn();

    const manager = createRecoveryManager({
      getSettings: () => ({}),
      getAllActivity: () => ({}),
      requestRestart,
      isCodexPane: () => false,
    });

    manager.markExpectedExit('1', 'manual');
    manager.handleExit('1', 1);

    jest.advanceTimersByTime(6000);

    expect(requestRestart).not.toHaveBeenCalled();
  });

  test('codex exit 0 triggers immediate restart', () => {
    const requestRestart = jest.fn();

    const manager = createRecoveryManager({
      getSettings: () => ({}),
      getAllActivity: () => ({}),
      requestRestart,
      isCodexPane: () => true,
    });

    manager.handleExit('2', 0);

    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(requestRestart).toHaveBeenCalledWith('2', expect.objectContaining({
      reason: 'codex-completion',
    }));
  });
});
