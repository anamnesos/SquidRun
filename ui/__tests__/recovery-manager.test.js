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
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
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
    await Promise.resolve();

    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(requestRestart).toHaveBeenCalledWith('1', expect.objectContaining({
      reason: 'exit-1',
      attempt: 1,
    }));
  });
});
