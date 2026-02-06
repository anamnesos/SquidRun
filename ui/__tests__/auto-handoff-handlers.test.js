/**
 * Auto-Handoff IPC Handler Tests
 * Target: Full coverage of auto-handoff-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerAutoHandoffHandlers } = require('../modules/ipc/auto-handoff-handlers');

describe('Auto-Handoff Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing triggers mocks
    ctx.triggers = {
      ...ctx.triggers,
      triggerAutoHandoff: jest.fn(() => ({ success: true, handedOff: true })),
      HANDOFF_CHAIN: ['1', '2', '5'],
    };

    registerAutoHandoffHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerAutoHandoffHandlers(null)).toThrow('registerAutoHandoffHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerAutoHandoffHandlers({})).toThrow('registerAutoHandoffHandlers requires ctx.ipcMain');
    });
  });

  describe('trigger-handoff', () => {
    test('triggers handoff from pane with message', async () => {
      const result = await harness.invoke('trigger-handoff', '1', 'Task complete, handing off');

      expect(ctx.triggers.triggerAutoHandoff).toHaveBeenCalledWith('1', 'Task complete, handing off');
      expect(result).toEqual({ success: true, handedOff: true });
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('trigger-handoff', '1', 'message');

      expect(result).toEqual({ success: false, error: 'triggers not available' });
    });

    test('returns error when triggerAutoHandoff is not a function', async () => {
      ctx.triggers.triggerAutoHandoff = undefined;

      const result = await harness.invoke('trigger-handoff', '1', 'message');

      expect(result).toEqual({ success: false, error: 'triggers.triggerAutoHandoff not available' });
    });

    test('returns error when triggerAutoHandoff is string', async () => {
      ctx.triggers.triggerAutoHandoff = 'not a function';

      const result = await harness.invoke('trigger-handoff', '1', 'message');

      expect(result).toEqual({ success: false, error: 'triggers.triggerAutoHandoff not available' });
    });
  });

  describe('get-handoff-chain', () => {
    test('returns handoff chain', async () => {
      const result = await harness.invoke('get-handoff-chain');

      expect(result).toEqual(['1', '2', '5']);
    });

    test('returns empty array when HANDOFF_CHAIN not defined', async () => {
      delete ctx.triggers.HANDOFF_CHAIN;

      const result = await harness.invoke('get-handoff-chain');

      expect(result).toEqual([]);
    });

    test('returns error when triggers is null', async () => {
      ctx.triggers = null;

      const result = await harness.invoke('get-handoff-chain');

      expect(result).toEqual({ success: false, error: 'triggers not available' });
    });
  });
});
