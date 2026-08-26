/**
 * MCP IPC Handler Tests
 * Target: Full coverage of mcp-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock the mcp-bridge module
jest.mock('../modules/mcp-bridge', () => ({
  registerAgent: jest.fn(() => ({ success: true, sessionId: 'sess-123' })),
  unregisterAgent: jest.fn(() => ({ success: true })),
  getConnectedAgents: jest.fn(() => []),
  handleToolCall: jest.fn(() => ({ success: true, result: 'test' })),
  getMCPToolDefinitions: jest.fn(() => []),
  validateSession: jest.fn(() => ({ valid: true })),
  getMCPHealth: jest.fn(() => ({ healthy: true, uptime: 1000 })),
}));

const mcpBridge = require('../modules/mcp-bridge');
const { registerMcpHandlers } = require('../modules/ipc/mcp-handlers');

describe('MCP Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    registerMcpHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerMcpHandlers(null)).toThrow('registerMcpHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerMcpHandlers({})).toThrow('registerMcpHandlers requires ctx.ipcMain');
    });
  });

  describe('mcp-register-agent', () => {
    test('registers agent with sessionId and paneId', async () => {
      const result = await harness.invoke('mcp-register-agent', 'sess-123', '1');

      expect(mcpBridge.registerAgent).toHaveBeenCalledWith('sess-123', '1');
      expect(result).toEqual({ success: true, sessionId: 'sess-123' });
    });
  });

  describe('mcp-unregister-agent', () => {
    test('unregisters agent by sessionId', async () => {
      const result = await harness.invoke('mcp-unregister-agent', 'sess-123');

      expect(mcpBridge.unregisterAgent).toHaveBeenCalledWith('sess-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('mcp-get-connected-agents', () => {
    test('returns connected agents', async () => {
      mcpBridge.getConnectedAgents.mockReturnValue([
        { sessionId: 'sess-1', paneId: '1' },
        { sessionId: 'sess-2', paneId: '2' },
      ]);

      const result = await harness.invoke('mcp-get-connected-agents');

      expect(mcpBridge.getConnectedAgents).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        agents: [
          { sessionId: 'sess-1', paneId: '1' },
          { sessionId: 'sess-2', paneId: '2' },
        ],
      });
    });

    test('returns empty array when no agents connected', async () => {
      mcpBridge.getConnectedAgents.mockReturnValue([]);

      const result = await harness.invoke('mcp-get-connected-agents');

      expect(result.agents).toEqual([]);
    });
  });

  describe('mcp-tool-call', () => {
    test('handles tool call with args', async () => {
      const result = await harness.invoke('mcp-tool-call', 'sess-123', 'read-file', { path: '/test' });

      expect(mcpBridge.handleToolCall).toHaveBeenCalledWith('sess-123', 'read-file', { path: '/test' });
      expect(result).toEqual({ success: true, result: 'test' });
    });
  });

  describe('mcp-get-tool-definitions', () => {
    test('returns tool definitions', async () => {
      const tools = [
        { name: 'read-file', description: 'Read a file' },
        { name: 'write-file', description: 'Write a file' },
      ];
      mcpBridge.getMCPToolDefinitions.mockReturnValue(tools);

      const result = await harness.invoke('mcp-get-tool-definitions');

      expect(mcpBridge.getMCPToolDefinitions).toHaveBeenCalled();
      expect(result).toEqual({ success: true, tools });
    });
  });

  describe('mcp-validate-session', () => {
    test('validates session by sessionId', async () => {
      mcpBridge.validateSession.mockReturnValue({ valid: true, paneId: '1' });

      const result = await harness.invoke('mcp-validate-session', 'sess-123');

      expect(mcpBridge.validateSession).toHaveBeenCalledWith('sess-123');
      expect(result).toEqual({ valid: true, paneId: '1' });
    });

    test('returns invalid for unknown session', async () => {
      mcpBridge.validateSession.mockReturnValue({ valid: false });

      const result = await harness.invoke('mcp-validate-session', 'unknown');

      expect(result).toEqual({ valid: false });
    });
  });

  describe('get-mcp-health', () => {
    test('returns MCP health status', async () => {
      mcpBridge.getMCPHealth.mockReturnValue({ healthy: true, uptime: 5000 });

      const result = await harness.invoke('get-mcp-health');

      expect(mcpBridge.getMCPHealth).toHaveBeenCalled();
      expect(result).toEqual({ healthy: true, uptime: 5000 });
    });
  });

  describe('get-mcp-status', () => {
    test('returns full MCP status with all panes', async () => {
      mcpBridge.getMCPHealth.mockReturnValue({ healthy: true });
      mcpBridge.getConnectedAgents.mockReturnValue([
        { paneId: '1', lastSeen: 1000, connectedAt: 500 },
      ]);

      const result = await harness.invoke('get-mcp-status');

      expect(result.success).toBe(true);
      expect(result.health).toEqual({ healthy: true });
      expect(result.connectedCount).toBe(1);
      expect(result.status['1'].connected).toBe(true);
      expect(result.status['1'].lastSeen).toBe(1000);
    });

    test('marks unconnected panes as disconnected', async () => {
      mcpBridge.getMCPHealth.mockReturnValue({ healthy: true });
      mcpBridge.getConnectedAgents.mockReturnValue([]);

      const result = await harness.invoke('get-mcp-status');

      expect(result.connectedCount).toBe(0);
      // All panes should be marked as not connected
      for (const paneId of ctx.PANE_IDS) {
        expect(result.status[paneId].connected).toBe(false);
        expect(result.status[paneId].lastSeen).toBeNull();
        expect(result.status[paneId].connectedAt).toBeNull();
      }
    });

    test('includes role for each pane', async () => {
      mcpBridge.getMCPHealth.mockReturnValue({ healthy: true });
      mcpBridge.getConnectedAgents.mockReturnValue([]);

      const result = await harness.invoke('get-mcp-status');

      for (const paneId of ctx.PANE_IDS) {
        expect(result.status[paneId].role).toBe(ctx.PANE_ROLES[paneId]);
      }
    });
  });
});
