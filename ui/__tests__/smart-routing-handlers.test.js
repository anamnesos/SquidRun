/**
 * Smart Routing IPC Handler Tests
 * Target: Full coverage of smart-routing-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerSmartRoutingHandlers } = require('../modules/ipc/smart-routing-handlers');

describe('Smart Routing Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing triggers mocks
    ctx.triggers = {
      ...ctx.triggers,
      routeTask: jest.fn(() => ({ success: true, routed: '2' })),
      getBestAgent: jest.fn(() => ({ paneId: '1', score: 0.95 })),
      AGENT_ROLES: {
        '1': 'Lead',
        '2': 'Worker A',
        '3': 'Worker B',
        '4': 'Reviewer',
        '5': 'Investigator',
        '6': 'Orchestrator',
      },
    };

    registerSmartRoutingHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerSmartRoutingHandlers(null)).toThrow('registerSmartRoutingHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerSmartRoutingHandlers({})).toThrow('registerSmartRoutingHandlers requires ctx.ipcMain');
    });
  });

  describe('route-task', () => {
    test('routes task to appropriate agent', async () => {
      const result = await harness.invoke('route-task', 'implementation', 'Build feature X');

      expect(ctx.triggers.routeTask).toHaveBeenCalledWith(
        'implementation',
        'Build feature X',
        expect.any(Object)
      );
      expect(result).toEqual({ success: true, routed: '2' });
    });

    test('loads performance data when available', async () => {
      const perfData = {
        agents: { '1': { completions: 10, errors: 1 } },
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(perfData));

      await harness.invoke('route-task', 'review', 'Review PR');

      expect(fs.existsSync).toHaveBeenCalled();
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('uses default performance when file not found', async () => {
      fs.existsSync.mockReturnValue(false);

      await harness.invoke('route-task', 'review', 'Review PR');

      expect(ctx.triggers.routeTask).toHaveBeenCalledWith(
        'review',
        'Review PR',
        expect.objectContaining({
          agents: expect.any(Object),
        })
      );
    });

    test('handles performance file read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('route-task', 'debug', 'Fix bug');

      expect(result).toEqual({ success: true, routed: '2' });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('route-task', 'test', 'Task');

      expect(result).toEqual({ success: false, error: 'triggers not available' });
    });

    test('returns error when routeTask is not a function', async () => {
      ctx.triggers.routeTask = undefined;

      const result = await harness.invoke('route-task', 'test', 'Task');

      expect(result).toEqual({ success: false, error: 'triggers.routeTask not available' });
    });
  });

  describe('get-best-agent', () => {
    test('returns best agent for task type', async () => {
      const result = await harness.invoke('get-best-agent', 'code-review');

      expect(ctx.triggers.getBestAgent).toHaveBeenCalledWith(
        'code-review',
        expect.any(Object)
      );
      expect(result).toEqual({ paneId: '1', score: 0.95 });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('get-best-agent', 'test');

      expect(result).toEqual({ success: false, error: 'triggers not available' });
    });

    test('returns error when getBestAgent is not a function', async () => {
      ctx.triggers.getBestAgent = undefined;

      const result = await harness.invoke('get-best-agent', 'test');

      expect(result).toEqual({ success: false, error: 'triggers.getBestAgent not available' });
    });
  });

  describe('get-agent-roles', () => {
    test('returns agent roles', async () => {
      const result = await harness.invoke('get-agent-roles');

      expect(result).toEqual({
        '1': 'Lead',
        '2': 'Worker A',
        '3': 'Worker B',
        '4': 'Reviewer',
        '5': 'Investigator',
        '6': 'Orchestrator',
      });
    });

    test('returns empty object when AGENT_ROLES not defined', async () => {
      delete ctx.triggers.AGENT_ROLES;

      const result = await harness.invoke('get-agent-roles');

      expect(result).toEqual({});
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('get-agent-roles');

      expect(result).toEqual({ success: false, error: 'triggers not available' });
    });
  });

  describe('null workspace path', () => {
    test('handles null WORKSPACE_PATH gracefully', () => {
      // Re-register with null workspace path
      jest.resetModules();
      jest.clearAllMocks();

      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      newCtx.WORKSPACE_PATH = null;
      newCtx.triggers = {
        routeTask: jest.fn(() => ({ success: true, routed: '2' })),
        getBestAgent: jest.fn(() => ({ paneId: '1', score: 0.95 })),
        AGENT_ROLES: {},
      };

      // Should not throw
      expect(() => registerSmartRoutingHandlers(newCtx)).not.toThrow();
    });
  });
});
