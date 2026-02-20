/**
 * Agent Claims IPC Handler Tests
 * Target: Full coverage of agent-claims-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerAgentClaimsHandlers } = require('../modules/ipc/agent-claims-handlers');

describe('Agent Claims Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Set up watcher mocks
    ctx.watcher.claimAgent = jest.fn(() => ({ success: true, paneId: '1', taskId: 'task-1' }));
    ctx.watcher.releaseAgent = jest.fn(() => ({ success: true }));
    ctx.watcher.getClaims = jest.fn(() => ({ '1': { taskId: 'task-1', description: 'Test task' } }));
    ctx.watcher.clearClaims = jest.fn(() => ({ success: true }));

    registerAgentClaimsHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('claim-agent', () => {
    test('delegates to watcher.claimAgent', async () => {
      const result = await harness.invoke('claim-agent', '1', 'task-123', 'Building feature X');

      expect(ctx.watcher.claimAgent).toHaveBeenCalledWith('1', 'task-123', 'Building feature X');
      expect(result).toEqual({ success: true, paneId: '1', taskId: 'task-1' });
    });

    test('passes all arguments to watcher', async () => {
      await harness.invoke('claim-agent', '3', 'complex-task', 'Multi-line\ndescription');

      expect(ctx.watcher.claimAgent).toHaveBeenCalledWith('3', 'complex-task', 'Multi-line\ndescription');
    });

    test('returns watcher result', async () => {
      ctx.watcher.claimAgent.mockReturnValue({ success: false, error: 'Already claimed' });

      const result = await harness.invoke('claim-agent', '1', 'task-1', 'Test');

      expect(result).toEqual({ success: false, error: 'Already claimed' });
    });
  });

  describe('release-agent', () => {
    test('delegates to watcher.releaseAgent', async () => {
      const result = await harness.invoke('release-agent', '2');

      expect(ctx.watcher.releaseAgent).toHaveBeenCalledWith('2');
      expect(result).toEqual({ success: true });
    });

    test('returns watcher result on failure', async () => {
      ctx.watcher.releaseAgent.mockReturnValue({ success: false, error: 'Not claimed' });

      const result = await harness.invoke('release-agent', '3');

      expect(result).toEqual({ success: false, error: 'Not claimed' });
    });
  });

  describe('get-claims', () => {
    test('delegates to watcher.getClaims', async () => {
      const result = await harness.invoke('get-claims');

      expect(ctx.watcher.getClaims).toHaveBeenCalled();
      expect(result).toEqual({ '1': { taskId: 'task-1', description: 'Test task' } });
    });

    test('returns empty object when no claims', async () => {
      ctx.watcher.getClaims.mockReturnValue({});

      const result = await harness.invoke('get-claims');

      expect(result).toEqual({});
    });

    test('returns multiple claims', async () => {
      ctx.watcher.getClaims.mockReturnValue({
        '1': { taskId: 'task-1', description: 'Task 1' },
        '3': { taskId: 'task-2', description: 'Task 2' },
        '6': { taskId: 'task-3', description: 'Task 3' },
      });

      const result = await harness.invoke('get-claims');

      expect(Object.keys(result).length).toBe(3);
    });
  });

  describe('clear-claims', () => {
    test('delegates to watcher.clearClaims', async () => {
      const result = await harness.invoke('clear-claims');

      expect(ctx.watcher.clearClaims).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('returns watcher result', async () => {
      ctx.watcher.clearClaims.mockReturnValue({ success: true, cleared: 5 });

      const result = await harness.invoke('clear-claims');

      expect(result).toEqual({ success: true, cleared: 5 });
    });
  });
});
