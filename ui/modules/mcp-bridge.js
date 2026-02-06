/**
 * V11 MCP Bridge Module
 * Connects MCP server tools to existing Hivemind functionality
 *
 * MC4: Message queue integration
 * MC5: Agent identification/handshake
 * MC6: State machine integration
 *
 * HYBRID APPROACH: MCP is primary, file triggers are fallback
 * - When MCP fails, automatically fall back to file-based triggers
 * - Queue messages in file system when agent disconnects
 * - Deliver when agent reconnects
 */

const path = require('path');
const fs = require('fs');
const watcher = require('./watcher');
const triggers = require('./triggers');
const { WORKSPACE_PATH, PANE_IDS, PANE_ROLES } = require('../config');
const log = require('./logger');

// Track connected MCP agents
const connectedAgents = new Map(); // sessionId -> { paneId, role, connectedAt, lastSeen }

// Track MCP failures for fallback
let mcpFailureCount = 0;
let lastFallbackWarning = null;

// Trigger file paths for fallback
const TRIGGER_DIR = path.join(WORKSPACE_PATH, 'triggers');
const TRIGGER_FILES = {
  '1': 'architect.txt',
  '2': 'devops.txt',
  '5': 'analyst.txt',
};

/**
 * Log MCP fallback event
 * @param {string} operation - What operation failed
 * @param {string} error - Error message
 */
function logFallback(operation, error) {
  mcpFailureCount++;
  lastFallbackWarning = {
    operation,
    error,
    timestamp: new Date().toISOString(),
    fallbackUsed: true,
  };
  log.warn('MCP Bridge', `FALLBACK: ${operation} failed (${error}), using file trigger`);
}

/**
 * Write to fallback trigger file
 * @param {string} paneId - Target pane
 * @param {string} message - Message content
 */
function writeFallbackTrigger(paneId, message) {
  try {
    const triggerFile = path.join(TRIGGER_DIR, TRIGGER_FILES[paneId]);
    if (triggerFile) {
      fs.writeFileSync(triggerFile, message, 'utf-8');
      log.info('MCP Bridge', `Fallback trigger written to ${TRIGGER_FILES[paneId]}`);
      return true;
    }
  } catch (err) {
    log.error('MCP Bridge', 'Fallback trigger failed', err.message);
  }
  return false;
}

/**
 * Get MCP health status
 */
function getMCPHealth() {
  return {
    failureCount: mcpFailureCount,
    lastFallback: lastFallbackWarning,
    connectedAgents: connectedAgents.size,
    healthy: mcpFailureCount === 0 || (Date.now() - new Date(lastFallbackWarning?.timestamp || 0).getTime()) > 60000,
  };
}

// ============================================================
// MC5: AGENT IDENTIFICATION VIA MCP HANDSHAKE
// ============================================================

/**
 * Register an agent connection via MCP handshake
 * @param {string} sessionId - MCP session identifier
 * @param {string} paneId - Agent pane ID (1, 2, 4, or 5)
 * @returns {{ success: boolean, agent: object }}
 */
function registerAgent(sessionId, paneId) {
  if (!PANE_IDS.includes(paneId)) {
    return { success: false, error: `Invalid paneId. Must be one of: ${PANE_IDS.join(', ')}` };
  }

  const agent = {
    sessionId,
    paneId,
    role: PANE_ROLES[paneId],
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  connectedAgents.set(sessionId, agent);
  log.info('MCP Bridge', `Agent registered: ${agent.role} (pane ${paneId})`);

  return { success: true, agent };
}

/**
 * Unregister an agent connection
 * @param {string} sessionId - MCP session identifier
 */
function unregisterAgent(sessionId) {
  const agent = connectedAgents.get(sessionId);
  if (agent) {
    log.info('MCP Bridge', `Agent disconnected: ${agent.role}`);
    connectedAgents.delete(sessionId);
    return { success: true };
  }
  return { success: false, error: 'Session not found' };
}

/**
 * Update agent last seen timestamp
 * @param {string} sessionId - MCP session identifier
 */
function heartbeat(sessionId) {
  const agent = connectedAgents.get(sessionId);
  if (agent) {
    agent.lastSeen = new Date().toISOString();
    return { success: true };
  }
  return { success: false, error: 'Session not found' };
}

/**
 * Get agent info from session
 * @param {string} sessionId - MCP session identifier
 * @returns {object|null} Agent info or null
 */
function getAgentBySession(sessionId) {
  return connectedAgents.get(sessionId) || null;
}

/**
 * Get all connected agents
 * @returns {Array} List of connected agents
 */
function getConnectedAgents() {
  return Array.from(connectedAgents.values());
}

/**
 * Validate agent session and return paneId
 * @param {string} sessionId - MCP session identifier
 * @returns {{ valid: boolean, paneId?: string, error?: string }}
 */
function validateSession(sessionId) {
  const agent = connectedAgents.get(sessionId);
  if (!agent) {
    return { valid: false, error: 'Invalid or expired session' };
  }
  return { valid: true, paneId: agent.paneId, role: agent.role };
}

// ============================================================
// MC4: MESSAGE QUEUE INTEGRATION
// ============================================================

/**
 * MCP Tool: send_message
 * Send a message from one agent to another
 * HYBRID: Falls back to file trigger if MCP/queue fails
 * @param {string} sessionId - Sender's MCP session
 * @param {string} toPaneId - Recipient pane ID
 * @param {string} content - Message content
 * @param {string} type - Message type (direct, broadcast)
 * @returns {object} Result
 */
function mcpSendMessage(sessionId, toPaneId, content, type = 'direct') {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fromPaneId = validation.paneId;

  try {
    // Primary: Use message queue
    const result = watcher.sendMessage(fromPaneId, toPaneId, content, type);
    if (result.success) {
      return result;
    }
    throw new Error(result.error || 'Message queue failed');
  } catch (err) {
    // Fallback: Use file trigger
    logFallback('send_message', err.message);
    const fromRole = PANE_ROLES[fromPaneId] || `Pane ${fromPaneId}`;
    const fallbackMsg = `[MSG from ${fromRole}]: ${content}`;
    const fallbackSuccess = writeFallbackTrigger(toPaneId, fallbackMsg);

    return {
      success: fallbackSuccess,
      fallback: true,
      warning: 'MCP queue failed, used file trigger',
      error: fallbackSuccess ? null : 'Both MCP and fallback failed',
    };
  }
}

/**
 * MCP Tool: broadcast_message
 * Broadcast a message to all other agents
 * @param {string} sessionId - Sender's MCP session
 * @param {string} content - Message content
 * @returns {object} Result
 */
function mcpBroadcastMessage(sessionId, content) {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fromPaneId = validation.paneId;
  const results = [];

  for (const toPaneId of PANE_IDS) {
    if (toPaneId !== fromPaneId) {
      const result = watcher.sendMessage(fromPaneId, toPaneId, content, 'broadcast');
      results.push({ toPaneId, ...result });
    }
  }

  return { success: true, results };
}

/**
 * MCP Tool: get_messages
 * Get messages for the calling agent
 * @param {string} sessionId - Agent's MCP session
 * @param {boolean} undeliveredOnly - Only return undelivered messages
 * @returns {object} Result with messages
 */
function mcpGetMessages(sessionId, undeliveredOnly = false) {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const messages = watcher.getMessages(validation.paneId, undeliveredOnly);
  return { success: true, messages, count: messages.length };
}

/**
 * MCP Tool: mark_delivered
 * Mark a message as delivered
 * @param {string} sessionId - Agent's MCP session
 * @param {string} messageId - Message ID to mark
 * @returns {object} Result
 */
function mcpMarkDelivered(sessionId, messageId) {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return watcher.markMessageDelivered(validation.paneId, messageId);
}

// ============================================================
// MC6: STATE MACHINE INTEGRATION
// ============================================================

/**
 * MCP Tool: get_state
 * Get current workflow state
 * @param {string} sessionId - Agent's MCP session (optional for read)
 * @returns {object} Current state
 */
function mcpGetState(sessionId = null) {
  // State read is allowed without session validation
  const state = watcher.readState();
  return { success: true, state };
}

/**
 * MCP Tool: get_active_agents
 * Get which agents are active for current state
 * @returns {object} Active agents list
 */
function mcpGetActiveAgents() {
  const state = watcher.readState();
  return {
    success: true,
    state: state.state,
    activeAgents: state.active_agents,
    claims: state.claims || {},
  };
}

/**
 * MCP Tool: claim_task
 * Claim a task for an agent
 * @param {string} sessionId - Agent's MCP session
 * @param {string} taskId - Task identifier
 * @param {string} description - Task description
 * @returns {object} Result
 */
function mcpClaimTask(sessionId, taskId, description = '') {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return watcher.claimAgent(validation.paneId, taskId, description);
}

/**
 * MCP Tool: complete_task
 * Release task claim (mark as complete)
 * @param {string} sessionId - Agent's MCP session
 * @returns {object} Result
 */
function mcpCompleteTask(sessionId) {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return watcher.releaseAgent(validation.paneId);
}

/**
 * MCP Tool: get_claims
 * Get all current task claims
 * @returns {object} Claims map
 */
function mcpGetClaims() {
  const claims = watcher.getClaims();
  return { success: true, claims };
}

/**
 * MCP Tool: trigger_agent
 * Send a direct message/trigger to an agent (bypasses workflow gate)
 * HYBRID: Falls back to file trigger if direct message fails
 * @param {string} sessionId - Sender's MCP session
 * @param {string} targetPaneId - Target agent pane ID
 * @param {string} message - Message to send
 * @returns {object} Result
 */
function mcpTriggerAgent(sessionId, targetPaneId, message) {
  const validation = validateSession(sessionId);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  try {
    // Primary: Use direct message (terminal injection)
    const result = triggers.sendDirectMessage([targetPaneId], message, validation.role);
    if (result.success && result.notified.length > 0) {
      return result;
    }
    // If no running Claude, fall back to file trigger
    throw new Error('No running agent in target pane');
  } catch (err) {
    // Fallback: Use file trigger
    logFallback('trigger_agent', err.message);
    const fallbackMsg = `[MSG from ${validation.role}]: ${message}`;
    const fallbackSuccess = writeFallbackTrigger(targetPaneId, fallbackMsg);

    return {
      success: fallbackSuccess,
      fallback: true,
      warning: 'Direct trigger failed, used file trigger',
      error: fallbackSuccess ? null : 'Both direct and fallback failed',
    };
  }
}

/**
 * MCP Tool: get_queue_status
 * Get message queue status for all agents
 * @returns {object} Queue status
 */
function mcpGetQueueStatus() {
  return watcher.getMessageQueueStatus();
}

// ============================================================
// MCP TOOL DEFINITIONS (for Lead's MCP server)
// ============================================================

/**
 * Get MCP tool definitions for the server
 * These follow the MCP tool schema format
 */
function getMCPToolDefinitions() {
  return [
    {
      name: 'register_agent',
      description: 'Register this agent with the Hivemind system. Call this first.',
      inputSchema: {
        type: 'object',
        properties: {
          paneId: { type: 'string', description: 'Agent pane ID (1=Architect, 2=DevOps, 5=Analyst)' },
        },
        required: ['paneId'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to another agent',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient pane ID (1, 2, 4, 5)' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'broadcast_message',
      description: 'Send a message to all other agents',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
        },
        required: ['content'],
      },
    },
    {
      name: 'get_messages',
      description: 'Get messages sent to this agent',
      inputSchema: {
        type: 'object',
        properties: {
          undeliveredOnly: { type: 'boolean', description: 'Only return undelivered messages', default: false },
        },
      },
    },
    {
      name: 'get_state',
      description: 'Get current Hivemind workflow state',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'claim_task',
      description: 'Claim a task to work on',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task identifier' },
          description: { type: 'string', description: 'Task description' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark your current task as complete',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_claims',
      description: 'Get all current task claims',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'trigger_agent',
      description: 'Send a direct trigger/notification to another agent',
      inputSchema: {
        type: 'object',
        properties: {
          targetPaneId: { type: 'string', description: 'Target agent pane ID' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['targetPaneId', 'message'],
      },
    },
  ];
}

/**
 * Handle an MCP tool call
 * This is called by the MCP server when a tool is invoked
 * @param {string} sessionId - MCP session ID
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments
 * @returns {object} Tool result
 */
function handleToolCall(sessionId, toolName, args = {}) {
  log.info('MCP Bridge', `Tool call: ${toolName}`, args);

  switch (toolName) {
    case 'register_agent':
      return registerAgent(sessionId, args.paneId);

    case 'send_message':
      return mcpSendMessage(sessionId, args.to, args.content, 'direct');

    case 'broadcast_message':
      return mcpBroadcastMessage(sessionId, args.content);

    case 'get_messages':
      return mcpGetMessages(sessionId, args.undeliveredOnly || false);

    case 'mark_delivered':
      return mcpMarkDelivered(sessionId, args.messageId);

    case 'get_state':
      return mcpGetState(sessionId);

    case 'get_active_agents':
      return mcpGetActiveAgents();

    case 'claim_task':
      return mcpClaimTask(sessionId, args.taskId, args.description || '');

    case 'complete_task':
      return mcpCompleteTask(sessionId);

    case 'get_claims':
      return mcpGetClaims();

    case 'trigger_agent':
      return mcpTriggerAgent(sessionId, args.targetPaneId, args.message);

    case 'get_queue_status':
      return mcpGetQueueStatus();

    case 'heartbeat':
      return heartbeat(sessionId);

    case 'unregister':
      return unregisterAgent(sessionId);

    case 'get_mcp_health':
      return getMCPHealth();

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

module.exports = {
  // MC5: Agent identification
  registerAgent,
  unregisterAgent,
  heartbeat,
  getAgentBySession,
  getConnectedAgents,
  validateSession,

  // MC4: Message queue
  mcpSendMessage,
  mcpBroadcastMessage,
  mcpGetMessages,
  mcpMarkDelivered,

  // MC6: State machine
  mcpGetState,
  mcpGetActiveAgents,
  mcpClaimTask,
  mcpCompleteTask,
  mcpGetClaims,
  mcpTriggerAgent,
  mcpGetQueueStatus,

  // MCP server helpers
  getMCPToolDefinitions,
  handleToolCall,

  // Hybrid fallback system
  getMCPHealth,
  logFallback,
  writeFallbackTrigger,
};
