/**
 * State IPC Handler Tests
 * Target: Full coverage of state-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerStateHandlers } = require('../modules/ipc/state-handlers');

describe('State Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing watcher mocks needed by state-handlers
    ctx.watcher = {
      ...ctx.watcher,
      readState: jest.fn(() => ({ state: 'idle', agent_claims: {} })),
      writeState: jest.fn(),
      transition: jest.fn(),
      States: { PLANNING: 'planning', BUILDING: 'building' },
    };

    // Add missing triggers mocks
    ctx.triggers = {
      ...ctx.triggers,
      notifyAllAgentsSync: jest.fn(),
      broadcastToAllAgents: jest.fn(() => ({ sent: 6 })),
      getSequenceState: jest.fn(() => ({})),
      getReliabilityStats: jest.fn(() => ({})),
    };

    registerStateHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerStateHandlers(null)).toThrow('registerStateHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerStateHandlers({})).toThrow('registerStateHandlers requires ctx.ipcMain');
    });
  });

  describe('get-state', () => {
    test('returns state from watcher', async () => {
      const mockState = { state: 'building', agent_claims: { '1': 'Architect' } };
      ctx.watcher.readState.mockReturnValue(mockState);

      const result = await harness.invoke('get-state');

      expect(ctx.watcher.readState).toHaveBeenCalled();
      expect(result).toEqual(mockState);
    });

    test('returns default state when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('get-state');

      expect(result).toEqual({
        success: false,
        error: 'state watcher not available',
        state: 'idle',
        agent_claims: {},
      });
    });

    test('returns error when readState is not a function', async () => {
      ctx.watcher = { readState: 'not a function' };

      const result = await harness.invoke('get-state');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('set-state', () => {
    test('transitions and returns new state', async () => {
      const newState = { state: 'reviewing' };
      ctx.watcher.readState.mockReturnValue(newState);

      const result = await harness.invoke('set-state', 'reviewing');

      expect(ctx.watcher.transition).toHaveBeenCalledWith('reviewing');
      expect(ctx.watcher.readState).toHaveBeenCalled();
      expect(result).toEqual(newState);
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('set-state', 'idle');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('returns error when transition is not a function', async () => {
      ctx.watcher.transition = undefined;

      const result = await harness.invoke('set-state', 'idle');

      expect(result.success).toBe(false);
    });
  });

  describe('trigger-sync', () => {
    test('notifies all agents with default file', async () => {
      const result = await harness.invoke('trigger-sync');

      expect(ctx.triggers.notifyAllAgentsSync).toHaveBeenCalledWith('shared_context.md');
      expect(result).toEqual({ success: true, file: 'shared_context.md' });
    });

    test('notifies all agents with custom file', async () => {
      const result = await harness.invoke('trigger-sync', 'status.md');

      expect(ctx.triggers.notifyAllAgentsSync).toHaveBeenCalledWith('status.md');
      expect(result).toEqual({ success: true, file: 'status.md' });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('trigger-sync');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('returns error when notifyAllAgentsSync is not a function', async () => {
      ctx.triggers.notifyAllAgentsSync = undefined;

      const result = await harness.invoke('trigger-sync');

      expect(result.success).toBe(false);
    });
  });

  describe('broadcast-message', () => {
    test('broadcasts message to all agents', async () => {
      ctx.triggers.broadcastToAllAgents.mockReturnValue({ sent: 6 });

      const result = await harness.invoke('broadcast-message', 'Hello agents!');

      expect(ctx.triggers.broadcastToAllAgents).toHaveBeenCalledWith('Hello agents!');
      expect(result).toEqual({ sent: 6 });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('broadcast-message', 'test');

      expect(result.success).toBe(false);
    });

    test('returns error when broadcastToAllAgents is not a function', async () => {
      ctx.triggers.broadcastToAllAgents = undefined;

      const result = await harness.invoke('broadcast-message', 'test');

      expect(result.success).toBe(false);
    });
  });

  describe('start-planning', () => {
    test('sets project and transitions to planning', async () => {
      ctx.watcher.States = { PLANNING: 'planning' };
      ctx.watcher.readState.mockReturnValue({ state: 'idle' });

      const result = await harness.invoke('start-planning', 'my-project');

      expect(ctx.watcher.readState).toHaveBeenCalled();
      expect(ctx.watcher.writeState).toHaveBeenCalledWith({ state: 'idle', project: 'my-project' });
      expect(ctx.watcher.transition).toHaveBeenCalledWith('planning');
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('start-planning', 'project');

      expect(result.success).toBe(false);
    });

    test('returns error when States is not defined', async () => {
      // Need to keep readState and other functions but remove States
      ctx.watcher = {
        readState: jest.fn(() => ({ state: 'idle' })),
        writeState: jest.fn(),
        transition: jest.fn(),
        States: undefined,
      };

      const result = await harness.invoke('start-planning', 'project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('state definitions not available');
    });

    test('returns error when States.PLANNING is not defined', async () => {
      ctx.watcher.States = {};

      const result = await harness.invoke('start-planning', 'project');

      expect(result.success).toBe(false);
    });
  });

  describe('get-message-state', () => {
    test('returns sequence state from triggers', async () => {
      const mockSequenceState = { 'ARCHITECT': 5, 'BUILDER': 3 };
      ctx.triggers.getSequenceState.mockReturnValue(mockSequenceState);

      const result = await harness.invoke('get-message-state');

      expect(ctx.triggers.getSequenceState).toHaveBeenCalled();
      expect(result).toEqual({ success: true, state: mockSequenceState });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('get-message-state');

      expect(result.success).toBe(false);
    });

    test('returns error when getSequenceState is not a function', async () => {
      ctx.triggers.getSequenceState = undefined;

      const result = await harness.invoke('get-message-state');

      expect(result.success).toBe(false);
    });
  });

  describe('get-reliability-stats', () => {
    test('returns reliability stats from triggers', async () => {
      const mockStats = { delivered: 100, failed: 2, successRate: 0.98 };
      ctx.triggers.getReliabilityStats.mockReturnValue(mockStats);

      const result = await harness.invoke('get-reliability-stats');

      expect(ctx.triggers.getReliabilityStats).toHaveBeenCalled();
      expect(result).toEqual({ success: true, stats: mockStats });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('get-reliability-stats');

      expect(result.success).toBe(false);
    });

    test('returns error when getReliabilityStats is not a function', async () => {
      ctx.triggers.getReliabilityStats = undefined;

      const result = await harness.invoke('get-reliability-stats');

      expect(result.success).toBe(false);
    });
  });
});
