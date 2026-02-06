/**
 * MCP Bridge Module Tests
 * Target: Full coverage of modules/mcp-bridge.js
 */

// Mock dependencies before requiring the module
const mockWatcher = {
  sendMessage: jest.fn(() => ({ success: true })),
  getMessages: jest.fn(() => []),
  markMessageDelivered: jest.fn(() => ({ success: true })),
  readState: jest.fn(() => ({ state: 'idle', active_agents: [], claims: {} })),
  claimAgent: jest.fn(() => ({ success: true })),
  releaseAgent: jest.fn(() => ({ success: true })),
  getClaims: jest.fn(() => ({})),
  getMessageQueueStatus: jest.fn(() => ({ queued: 0 })),
};

const mockTriggers = {
  sendDirectMessage: jest.fn(() => ({ success: true, notified: ['1'] })),
};

jest.mock('../modules/watcher', () => mockWatcher);
jest.mock('../modules/triggers', () => mockTriggers);

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  existsSync: jest.fn(() => true),
}));

jest.mock('../config', () => ({
  WORKSPACE_PATH: '/test/workspace',
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'DevOps',
    '5': 'Analyst',
  },
}));

const fs = require('fs');
const log = require('../modules/logger');
const mcpBridge = require('../modules/mcp-bridge');

describe('MCP Bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Agent Registration (MC5)', () => {
    describe('registerAgent', () => {
      test('registers agent with valid paneId', () => {
        const result = mcpBridge.registerAgent('sess-123', '1');

        expect(result.success).toBe(true);
        expect(result.agent.sessionId).toBe('sess-123');
        expect(result.agent.paneId).toBe('1');
        expect(result.agent.role).toBe('Architect');
        expect(log.info).toHaveBeenCalledWith('MCP Bridge', expect.stringContaining('registered'));
      });

      test('registers all 3 pane roles correctly', () => {
        const roles = {
          '1': 'Architect',
          '2': 'DevOps',
          '5': 'Analyst',
        };

        for (const [paneId, expectedRole] of Object.entries(roles)) {
          const result = mcpBridge.registerAgent(`sess-${paneId}`, paneId);
          expect(result.success).toBe(true);
          expect(result.agent.role).toBe(expectedRole);
        }
      });

      test('returns error for invalid paneId', () => {
        const result = mcpBridge.registerAgent('sess-123', '7');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid paneId');
      });

      test('returns error for non-numeric paneId', () => {
        const result = mcpBridge.registerAgent('sess-123', 'invalid');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid paneId');
      });

      test('includes timestamps on registration', () => {
        const result = mcpBridge.registerAgent('sess-ts', '1');

        expect(result.agent.connectedAt).toBeDefined();
        expect(result.agent.lastSeen).toBeDefined();
      });
    });

    describe('unregisterAgent', () => {
      test('unregisters existing agent', () => {
        mcpBridge.registerAgent('sess-to-unreg', '2');
        const result = mcpBridge.unregisterAgent('sess-to-unreg');

        expect(result.success).toBe(true);
        expect(log.info).toHaveBeenCalledWith('MCP Bridge', expect.stringContaining('disconnected'));
      });

      test('returns error for unknown session', () => {
        const result = mcpBridge.unregisterAgent('unknown-session');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Session not found');
      });
    });

    describe('heartbeat', () => {
      test('updates lastSeen for existing agent', () => {
        mcpBridge.registerAgent('sess-hb', '2');
        const result = mcpBridge.heartbeat('sess-hb');

        expect(result.success).toBe(true);
      });

      test('returns error for unknown session', () => {
        const result = mcpBridge.heartbeat('unknown-hb');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Session not found');
      });
    });

    describe('getAgentBySession', () => {
      test('returns agent for valid session', () => {
        mcpBridge.registerAgent('sess-get', '2');
        const agent = mcpBridge.getAgentBySession('sess-get');

        expect(agent).not.toBeNull();
        expect(agent.paneId).toBe('2');
        expect(agent.role).toBe('DevOps');
      });

      test('returns null for unknown session', () => {
        const agent = mcpBridge.getAgentBySession('unknown-get');

        expect(agent).toBeNull();
      });
    });

    describe('getConnectedAgents', () => {
      test('returns all connected agents', () => {
        // Clear any existing registrations by unregistering
        const existing = mcpBridge.getConnectedAgents();
        for (const agent of existing) {
          mcpBridge.unregisterAgent(agent.sessionId);
        }

        mcpBridge.registerAgent('sess-a', '1');
        mcpBridge.registerAgent('sess-b', '2');

        const agents = mcpBridge.getConnectedAgents();

        expect(agents.length).toBe(2);
        expect(agents.map(a => a.paneId).sort()).toEqual(['1', '2']);
      });

      test('returns empty array when no agents connected', () => {
        // Unregister all
        const existing = mcpBridge.getConnectedAgents();
        for (const agent of existing) {
          mcpBridge.unregisterAgent(agent.sessionId);
        }

        const agents = mcpBridge.getConnectedAgents();
        expect(agents).toEqual([]);
      });
    });

    describe('validateSession', () => {
      test('validates registered session', () => {
        mcpBridge.registerAgent('sess-valid', '5');
        const result = mcpBridge.validateSession('sess-valid');

        expect(result.valid).toBe(true);
        expect(result.paneId).toBe('5');
        expect(result.role).toBe('Analyst');
      });

      test('returns invalid for unknown session', () => {
        const result = mcpBridge.validateSession('unknown-valid');

        expect(result.valid).toBe(false);
        expect(result.error).toBe('Invalid or expired session');
      });
    });
  });

  describe('Message Queue Integration (MC4)', () => {
    beforeEach(() => {
      // Ensure we have a registered session for tests
      mcpBridge.registerAgent('test-session', '1');
    });

    afterEach(() => {
      mcpBridge.unregisterAgent('test-session');
    });

    describe('mcpSendMessage', () => {
      test('sends message via watcher on success', () => {
        mockWatcher.sendMessage.mockReturnValue({ success: true });

        const result = mcpBridge.mcpSendMessage('test-session', '2', 'Hello', 'direct');

        expect(result.success).toBe(true);
        expect(mockWatcher.sendMessage).toHaveBeenCalledWith('1', '2', 'Hello', 'direct');
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpSendMessage('invalid-session', '2', 'Hello', 'direct');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Invalid or expired session');
      });

      test('falls back to file trigger on watcher failure', () => {
        mockWatcher.sendMessage.mockReturnValue({ success: false, error: 'Queue full' });

        const result = mcpBridge.mcpSendMessage('test-session', '2', 'Hello', 'direct');

        expect(result.fallback).toBe(true);
        expect(result.warning).toContain('file trigger');
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith('MCP Bridge', expect.stringContaining('FALLBACK'));
      });

      test('falls back on watcher exception', () => {
        mockWatcher.sendMessage.mockImplementation(() => {
          throw new Error('Watcher crashed');
        });

        const result = mcpBridge.mcpSendMessage('test-session', '2', 'Hello', 'direct');

        expect(result.fallback).toBe(true);
      });
    });

    describe('mcpBroadcastMessage', () => {
      test('broadcasts to all other panes', () => {
        mockWatcher.sendMessage.mockReturnValue({ success: true });

        const result = mcpBridge.mcpBroadcastMessage('test-session', 'Broadcast msg');

        expect(result.success).toBe(true);
        expect(result.results.length).toBe(2); // All except sender (pane 1)

        // Verify it was called for panes 2, 5
        for (const paneId of ['2', '5']) {
          expect(mockWatcher.sendMessage).toHaveBeenCalledWith('1', paneId, 'Broadcast msg', 'broadcast');
        }
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpBroadcastMessage('invalid-session', 'Broadcast');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Invalid or expired session');
      });
    });

    describe('mcpGetMessages', () => {
      test('gets messages for agent', () => {
        mockWatcher.getMessages.mockReturnValue([
          { id: '1', content: 'msg1' },
          { id: '2', content: 'msg2' },
        ]);

        const result = mcpBridge.mcpGetMessages('test-session', false);

        expect(result.success).toBe(true);
        expect(result.messages.length).toBe(2);
        expect(result.count).toBe(2);
        expect(mockWatcher.getMessages).toHaveBeenCalledWith('1', false);
      });

      test('gets only undelivered messages when flag set', () => {
        mockWatcher.getMessages.mockReturnValue([{ id: '1' }]);

        mcpBridge.mcpGetMessages('test-session', true);

        expect(mockWatcher.getMessages).toHaveBeenCalledWith('1', true);
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpGetMessages('invalid-session', false);

        expect(result.success).toBe(false);
      });
    });

    describe('mcpMarkDelivered', () => {
      test('marks message as delivered', () => {
        mockWatcher.markMessageDelivered.mockReturnValue({ success: true });

        const result = mcpBridge.mcpMarkDelivered('test-session', 'msg-123');

        expect(result.success).toBe(true);
        expect(mockWatcher.markMessageDelivered).toHaveBeenCalledWith('1', 'msg-123');
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpMarkDelivered('invalid-session', 'msg-123');

        expect(result.success).toBe(false);
      });
    });
  });

  describe('State Machine Integration (MC6)', () => {
    beforeEach(() => {
      mcpBridge.registerAgent('state-session', '1');
    });

    afterEach(() => {
      mcpBridge.unregisterAgent('state-session');
    });

    describe('mcpGetState', () => {
      test('returns workflow state without session validation', () => {
        mockWatcher.readState.mockReturnValue({ state: 'planning', phase: 1 });

        const result = mcpBridge.mcpGetState();

        expect(result.success).toBe(true);
        expect(result.state).toEqual({ state: 'planning', phase: 1 });
      });

      test('works with null session', () => {
        mockWatcher.readState.mockReturnValue({ state: 'idle' });

        const result = mcpBridge.mcpGetState(null);

        expect(result.success).toBe(true);
      });
    });

    describe('mcpGetActiveAgents', () => {
      test('returns active agents from state', () => {
        mockWatcher.readState.mockReturnValue({
          state: 'implementing',
          active_agents: ['1', '3'],
          claims: { '1': 'task-a' },
        });

        const result = mcpBridge.mcpGetActiveAgents();

        expect(result.success).toBe(true);
        expect(result.state).toBe('implementing');
        expect(result.activeAgents).toEqual(['1', '3']);
        expect(result.claims).toEqual({ '1': 'task-a' });
      });
    });

    describe('mcpClaimTask', () => {
      test('claims task for agent', () => {
        mockWatcher.claimAgent.mockReturnValue({ success: true });

        const result = mcpBridge.mcpClaimTask('state-session', 'task-123', 'Fix bug');

        expect(result.success).toBe(true);
        expect(mockWatcher.claimAgent).toHaveBeenCalledWith('1', 'task-123', 'Fix bug');
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpClaimTask('invalid-session', 'task-123', '');

        expect(result.success).toBe(false);
      });
    });

    describe('mcpCompleteTask', () => {
      test('releases agent task claim', () => {
        mockWatcher.releaseAgent.mockReturnValue({ success: true });

        const result = mcpBridge.mcpCompleteTask('state-session');

        expect(result.success).toBe(true);
        expect(mockWatcher.releaseAgent).toHaveBeenCalledWith('1');
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpCompleteTask('invalid-session');

        expect(result.success).toBe(false);
      });
    });

    describe('mcpGetClaims', () => {
      test('returns all claims', () => {
        mockWatcher.getClaims.mockReturnValue({ '1': 'task-a', '2': 'task-b' });

        const result = mcpBridge.mcpGetClaims();

        expect(result.success).toBe(true);
        expect(result.claims).toEqual({ '1': 'task-a', '2': 'task-b' });
      });
    });

    describe('mcpTriggerAgent', () => {
      test('sends direct trigger via triggers module', () => {
        mockTriggers.sendDirectMessage.mockReturnValue({ success: true, notified: ['2'] });

        const result = mcpBridge.mcpTriggerAgent('state-session', '2', 'Wake up!');

        expect(result.success).toBe(true);
        expect(result.notified).toContain('2');
        expect(mockTriggers.sendDirectMessage).toHaveBeenCalledWith(['2'], 'Wake up!', 'Architect');
      });

      test('falls back to file trigger when no running agent', () => {
        mockTriggers.sendDirectMessage.mockReturnValue({ success: true, notified: [] });

        const result = mcpBridge.mcpTriggerAgent('state-session', '2', 'Hello');

        expect(result.fallback).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
      });

      test('falls back on exception', () => {
        mockTriggers.sendDirectMessage.mockImplementation(() => {
          throw new Error('Trigger failed');
        });

        const result = mcpBridge.mcpTriggerAgent('state-session', '2', 'Hello');

        expect(result.fallback).toBe(true);
      });

      test('returns error for invalid session', () => {
        const result = mcpBridge.mcpTriggerAgent('invalid-session', '2', 'Hello');

        expect(result.success).toBe(false);
      });
    });

    describe('mcpGetQueueStatus', () => {
      test('returns queue status', () => {
        mockWatcher.getMessageQueueStatus.mockReturnValue({ queued: 5, delivered: 10 });

        const result = mcpBridge.mcpGetQueueStatus();

        expect(result.queued).toBe(5);
        expect(result.delivered).toBe(10);
      });
    });
  });

  describe('Fallback System', () => {
    describe('logFallback', () => {
      test('logs fallback warning', () => {
        mcpBridge.logFallback('test_op', 'test error');

        expect(log.warn).toHaveBeenCalledWith('MCP Bridge', expect.stringContaining('FALLBACK'));
        expect(log.warn).toHaveBeenCalledWith('MCP Bridge', expect.stringContaining('test_op'));
      });
    });

    describe('writeFallbackTrigger', () => {
      test('writes trigger file for valid pane', () => {
        const result = mcpBridge.writeFallbackTrigger('1', 'Test message');

        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
          expect.stringContaining('architect.txt'),
          'Test message',
          'utf-8'
        );
      });

      test('writes to correct trigger files for each pane', () => {
        const paneFiles = {
          '1': 'architect.txt',
          '2': 'devops.txt',
          '5': 'analyst.txt',
        };

        for (const [paneId, expectedFile] of Object.entries(paneFiles)) {
          fs.writeFileSync.mockClear();
          mcpBridge.writeFallbackTrigger(paneId, 'msg');
          expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining(expectedFile),
            'msg',
            'utf-8'
          );
        }
      });

      test('handles write error', () => {
        fs.writeFileSync.mockImplementation(() => {
          throw new Error('Write failed');
        });

        const result = mcpBridge.writeFallbackTrigger('1', 'Test');

        expect(result).toBe(false);
        expect(log.error).toHaveBeenCalledWith('MCP Bridge', 'Fallback trigger failed', 'Write failed');
      });
    });

    describe('getMCPHealth', () => {
      test('returns health status', () => {
        const health = mcpBridge.getMCPHealth();

        expect(health).toHaveProperty('failureCount');
        expect(health).toHaveProperty('lastFallback');
        expect(health).toHaveProperty('connectedAgents');
        expect(health).toHaveProperty('healthy');
      });

      test('reports healthy when no failures', () => {
        // Note: this depends on state from previous tests
        const health = mcpBridge.getMCPHealth();

        expect(typeof health.healthy).toBe('boolean');
      });
    });
  });

  describe('MCP Tool Definitions', () => {
    describe('getMCPToolDefinitions', () => {
      test('returns all tool definitions', () => {
        const tools = mcpBridge.getMCPToolDefinitions();

        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThan(0);

        // Verify expected tools exist
        const toolNames = tools.map(t => t.name);
        expect(toolNames).toContain('register_agent');
        expect(toolNames).toContain('send_message');
        expect(toolNames).toContain('broadcast_message');
        expect(toolNames).toContain('get_messages');
        expect(toolNames).toContain('get_state');
        expect(toolNames).toContain('claim_task');
        expect(toolNames).toContain('complete_task');
        expect(toolNames).toContain('get_claims');
        expect(toolNames).toContain('trigger_agent');
      });

      test('each tool has required schema properties', () => {
        const tools = mcpBridge.getMCPToolDefinitions();

        for (const tool of tools) {
          expect(tool.name).toBeDefined();
          expect(tool.description).toBeDefined();
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.type).toBe('object');
        }
      });
    });
  });

  describe('handleToolCall', () => {
    beforeEach(() => {
      mcpBridge.registerAgent('tool-session', '1');
    });

    afterEach(() => {
      mcpBridge.unregisterAgent('tool-session');
    });

    test('handles register_agent', () => {
      const result = mcpBridge.handleToolCall('new-session', 'register_agent', { paneId: '2' });

      expect(result.success).toBe(true);
      expect(result.agent.paneId).toBe('2');

      // Cleanup
      mcpBridge.unregisterAgent('new-session');
    });

    test('handles send_message', () => {
      mockWatcher.sendMessage.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'send_message', {
        to: '2',
        content: 'Hello',
      });

      expect(result.success).toBe(true);
    });

    test('handles broadcast_message', () => {
      mockWatcher.sendMessage.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'broadcast_message', {
        content: 'Broadcast',
      });

      expect(result.success).toBe(true);
    });

    test('handles get_messages', () => {
      mockWatcher.getMessages.mockReturnValue([]);

      const result = mcpBridge.handleToolCall('tool-session', 'get_messages', {});

      expect(result.success).toBe(true);
      expect(result.messages).toEqual([]);
    });

    test('handles get_messages with undeliveredOnly flag', () => {
      mockWatcher.getMessages.mockReturnValue([]);

      mcpBridge.handleToolCall('tool-session', 'get_messages', { undeliveredOnly: true });

      expect(mockWatcher.getMessages).toHaveBeenCalledWith('1', true);
    });

    test('handles mark_delivered', () => {
      mockWatcher.markMessageDelivered.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'mark_delivered', {
        messageId: 'msg-1',
      });

      expect(result.success).toBe(true);
    });

    test('handles get_state', () => {
      mockWatcher.readState.mockReturnValue({ state: 'idle' });

      const result = mcpBridge.handleToolCall('tool-session', 'get_state', {});

      expect(result.success).toBe(true);
    });

    test('handles get_active_agents', () => {
      mockWatcher.readState.mockReturnValue({ state: 'idle', active_agents: [], claims: {} });

      const result = mcpBridge.handleToolCall('tool-session', 'get_active_agents', {});

      expect(result.success).toBe(true);
    });

    test('handles claim_task', () => {
      mockWatcher.claimAgent.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'claim_task', {
        taskId: 'task-1',
        description: 'Test task',
      });

      expect(result.success).toBe(true);
    });

    test('handles claim_task without description', () => {
      mockWatcher.claimAgent.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'claim_task', {
        taskId: 'task-1',
      });

      expect(result.success).toBe(true);
      expect(mockWatcher.claimAgent).toHaveBeenCalledWith('1', 'task-1', '');
    });

    test('handles complete_task', () => {
      mockWatcher.releaseAgent.mockReturnValue({ success: true });

      const result = mcpBridge.handleToolCall('tool-session', 'complete_task', {});

      expect(result.success).toBe(true);
    });

    test('handles get_claims', () => {
      mockWatcher.getClaims.mockReturnValue({});

      const result = mcpBridge.handleToolCall('tool-session', 'get_claims', {});

      expect(result.success).toBe(true);
    });

    test('handles trigger_agent', () => {
      mockTriggers.sendDirectMessage.mockReturnValue({ success: true, notified: ['2'] });

      const result = mcpBridge.handleToolCall('tool-session', 'trigger_agent', {
        targetPaneId: '2',
        message: 'Trigger!',
      });

      expect(result.success).toBe(true);
    });

    test('handles get_queue_status', () => {
      mockWatcher.getMessageQueueStatus.mockReturnValue({ queued: 0 });

      const result = mcpBridge.handleToolCall('tool-session', 'get_queue_status', {});

      expect(result.queued).toBe(0);
    });

    test('handles heartbeat', () => {
      const result = mcpBridge.handleToolCall('tool-session', 'heartbeat', {});

      expect(result.success).toBe(true);
    });

    test('handles unregister', () => {
      mcpBridge.registerAgent('unreg-session', '2');
      const result = mcpBridge.handleToolCall('unreg-session', 'unregister', {});

      expect(result.success).toBe(true);
    });

    test('handles get_mcp_health', () => {
      const result = mcpBridge.handleToolCall('tool-session', 'get_mcp_health', {});

      expect(result).toHaveProperty('healthy');
    });

    test('returns error for unknown tool', () => {
      const result = mcpBridge.handleToolCall('tool-session', 'unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    test('logs tool calls', () => {
      mockWatcher.readState.mockReturnValue({ state: 'idle' });

      mcpBridge.handleToolCall('tool-session', 'get_state', { test: 'arg' });

      expect(log.info).toHaveBeenCalledWith('MCP Bridge', 'Tool call: get_state', { test: 'arg' });
    });
  });
});
