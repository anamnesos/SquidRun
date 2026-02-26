#!/usr/bin/env node
/**
 * SquidRun MCP Server
 * V11: Model Context Protocol integration for agent-to-agent communication
 *
 * Usage: node mcp-server.js --agent <architect|builder|oracle>
 *
 * This server exposes tools for:
 * - Messaging: send_message, get_messages
 * - Workflow: get_workflow_state, trigger_agent, claim_task, complete_task
 * - Context: get_shared_context, update_status
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const log = require('./modules/logger');
const {
  PANE_IDS,
  PANE_ROLES,
  WORKSPACE_PATH,
  resolveCoordPath,
  ROLE_ID_MAP,
  BACKWARD_COMPAT_ROLE_ALIASES,
} = require('./config');

// ============================================================
// CONFIGURATION
// ============================================================

const MESSAGE_QUEUE_DIR = path.join(WORKSPACE_PATH, 'messages');
const queueMutationChains = new Map();

function coordPath(relPath, options = {}) {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(relPath, options);
  }
  return path.join(process.cwd(), '.squidrun', relPath);
}

function getStateFilePath(options = {}) {
  return coordPath('state.json', options);
}

function getSharedContextPath(options = {}) {
  return coordPath('shared_context.md', options);
}

function getStatusFilePath(options = {}) {
  return coordPath(path.join('build', 'status.md'), options);
}

function getTriggersPath(options = {}) {
  return coordPath('triggers', options);
}

const CANONICAL_AGENT_NAMES = Object.freeze(['architect', 'builder', 'oracle']);
const AGENT_TO_PANE = Object.freeze({
  architect: String(ROLE_ID_MAP?.architect || '1'),
  builder: String(ROLE_ID_MAP?.builder || '2'),
  oracle: String(ROLE_ID_MAP?.oracle || '3'),
});
const TARGET_COMPAT_ALIASES = Object.freeze({
  ...(BACKWARD_COMPAT_ROLE_ALIASES || {}),
  'implementer-a': 'architect',
  'worker-a': 'architect',
  reviewer: 'architect',
});
const MESSAGE_TARGET_ENUM = Object.freeze(
  Array.from(new Set([
    ...CANONICAL_AGENT_NAMES,
    ...Object.keys(TARGET_COMPAT_ALIASES),
    'workers',
    'all',
  ]))
);
const COMPLETE_TASK_TRIGGER_ENUM = Object.freeze(
  Array.from(new Set([
    ...CANONICAL_AGENT_NAMES,
    ...Object.keys(TARGET_COMPAT_ALIASES),
    'none',
  ]))
);

const PANE_TO_AGENT = {
  [AGENT_TO_PANE.architect]: 'architect',
  [AGENT_TO_PANE.builder]: 'builder',
  [AGENT_TO_PANE.oracle]: 'oracle',
};

function normalizeAgentRole(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (AGENT_TO_PANE[normalized]) return normalized;
  return TARGET_COMPAT_ALIASES[normalized] || null;
}

// PANE_ROLES imported from config.js (canonical source)

// ============================================================
// PARSE COMMAND LINE ARGS
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  let rawAgentName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      rawAgentName = args[i + 1];
      break;
    }
  }

  const agentName = normalizeAgentRole(rawAgentName);
  if (!agentName || !AGENT_TO_PANE[agentName]) {
    log.error('MCP', 'Usage: node mcp-server.js --agent <architect|builder|oracle>');
    process.exit(1);
  }

  return {
    agentName,
    paneId: AGENT_TO_PANE[agentName],
  };
}

const { agentName, paneId } = parseArgs();

// ============================================================
// MC1: MCP SERVER SKELETON
// ============================================================

const server = new Server(
  {
    name: 'squidrun',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================================
// TOOL DEFINITIONS
// ============================================================

const TOOLS = [
  // MC2: Messaging Tools
  {
    name: 'send_message',
    description: 'Send a message to another SquidRun agent. Messages are delivered to their message queue.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: MESSAGE_TARGET_ENUM,
          description: 'Target agent(s). Use "workers" for implementers/investigator, "all" for everyone.',
        },
        content: {
          type: 'string',
          description: 'Message content to send.',
        },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'get_messages',
    description: 'Get pending messages for this agent from the message queue.',
    inputSchema: {
      type: 'object',
      properties: {
        undelivered_only: {
          type: 'boolean',
          description: 'If true, only return undelivered messages. Default: true.',
          default: true,
        },
      },
    },
  },

  // MC3: Workflow Tools
  {
    name: 'get_workflow_state',
    description: 'Get the current SquidRun workflow state including active agents and claims.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'trigger_agent',
    description: 'Trigger another agent with a context message. This writes to their trigger file.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: MESSAGE_TARGET_ENUM,
          description: 'Agent(s) to trigger.',
        },
        context: {
          type: 'string',
          description: 'Context message to include in the trigger.',
        },
      },
      required: ['agent', 'context'],
    },
  },
  {
    name: 'claim_task',
    description: 'Claim a task for this agent. Prevents other agents from working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier (e.g., "MC1", "MC2").',
        },
        description: {
          type: 'string',
          description: 'Brief description of what you\'re working on.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as complete and optionally trigger the next agent.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier to mark complete.',
        },
        result: {
          type: 'string',
          description: 'Summary of what was accomplished.',
        },
        trigger_next: {
          type: 'string',
          enum: COMPLETE_TASK_TRIGGER_ENUM,
          description: 'Which agent to trigger next. Default: none.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_shared_context',
    description: 'Read the shared_context.md file containing current sprint info and task assignments.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_status',
    description: 'Update the build/status.md file with task progress.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier.',
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'done', 'blocked'],
          description: 'New status for the task.',
        },
        note: {
          type: 'string',
          description: 'Optional note about the status update.',
        },
      },
      required: ['task_id', 'status'],
    },
  },
];

// ============================================================
// LIST TOOLS HANDLER
// ============================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// ============================================================
// MC2: MESSAGING TOOL IMPLEMENTATIONS
// ============================================================

function ensureMessageQueueDir() {
  try {
    if (!fs.existsSync(MESSAGE_QUEUE_DIR)) {
      fs.mkdirSync(MESSAGE_QUEUE_DIR, { recursive: true });
    }
    return true;
  } catch (err) {
    log.error('MCP', 'Failed to ensure message queue directory', err);
    return false;
  }
}

function getQueueFilePath(targetPaneId) {
  return path.join(MESSAGE_QUEUE_DIR, `queue-${targetPaneId}.json`);
}

function buildQueueTempPath(queueFile) {
  return `${queueFile}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function writeQueueMessagesAtomic(queueFile, messages) {
  const tempPath = buildQueueTempPath(queueFile);
  fs.writeFileSync(tempPath, JSON.stringify(messages, null, 2), 'utf-8');
  fs.renameSync(tempPath, queueFile);
}

function serializeQueueMutation(queueFile, operation) {
  const previous = queueMutationChains.get(queueFile) || Promise.resolve();
  const next = previous.then(() => operation(), () => operation());
  const serialized = next.finally(() => {
    if (queueMutationChains.get(queueFile) === serialized) {
      queueMutationChains.delete(queueFile);
    }
  });
  queueMutationChains.set(queueFile, serialized);
  return serialized;
}

function recoverCorruptedQueueFile(queueFile, rawContent, err) {
  log.error('MCP', `Corrupted queue file ${queueFile}: ${err.message}`);
  const corruptPath = `${queueFile}.corrupt-${Date.now()}`;
  try {
    fs.writeFileSync(corruptPath, rawContent, 'utf-8');
  } catch (saveErr) {
    log.warn('MCP', `Failed to preserve corrupted queue file ${queueFile}: ${saveErr.message}`);
  }
  try {
    writeQueueMessagesAtomic(queueFile, []);
    log.warn('MCP', `Reset corrupted queue file ${queueFile}`);
    return true;
  } catch (resetErr) {
    log.error('MCP', `Failed to reset corrupted queue file ${queueFile}: ${resetErr.message}`);
    return false;
  }
}

function readQueueMessagesWithRecovery(queueFile) {
  if (!fs.existsSync(queueFile)) {
    return [];
  }
  const rawContent = fs.readFileSync(queueFile, 'utf-8');
  try {
    const parsed = JSON.parse(rawContent);
    if (!Array.isArray(parsed)) {
      throw new Error('queue_payload_not_array');
    }
    return parsed;
  } catch (err) {
    recoverCorruptedQueueFile(queueFile, rawContent, err);
    return [];
  }
}

async function sendMessageToQueue(fromPaneId, toPaneId, content) {
  if (!ensureMessageQueueDir()) {
    return {
      success: false,
      error: 'Message queue directory unavailable',
      to: PANE_ROLES[toPaneId],
    };
  }
  const queueFile = getQueueFilePath(toPaneId);
  let messageId = null;
  try {
    await serializeQueueMutation(queueFile, async () => {
      let messages = readQueueMessagesWithRecovery(queueFile);
      messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      const message = {
        id: messageId,
        from: fromPaneId,
        fromRole: PANE_ROLES[fromPaneId],
        to: toPaneId,
        toRole: PANE_ROLES[toPaneId],
        content,
        type: 'mcp',
        timestamp: new Date().toISOString(),
        delivered: false,
        deliveredAt: null,
      };

      messages.push(message);

      // Keep only last 100 messages
      if (messages.length > 100) {
        messages = messages.slice(-100);
      }

      writeQueueMessagesAtomic(queueFile, messages);
    });
  } catch (err) {
    log.error('MCP', 'Failed to write message queue', err);
    return {
      success: false,
      error: err.message,
      to: PANE_ROLES[toPaneId],
    };
  }

  // HYBRID: File trigger backup DISABLED to prevent duplicate messages
  // The queue-based delivery is the primary mechanism now
  // Uncomment below to re-enable file trigger fallback:
  /*
  try {
    const targetAgent = PANE_TO_AGENT[toPaneId];
    const triggerFile = path.join(TRIGGERS_PATH, `${targetAgent}.txt`);
    const triggerContent = `(${PANE_ROLES[fromPaneId].toUpperCase().replace(' ', '-')}): ${content}`;
    fs.writeFileSync(triggerFile, triggerContent, 'utf-8');
  } catch (triggerErr) {
    log.error('MCP', 'Trigger fallback write failed', triggerErr.message);
  }
  */

  return { success: true, messageId, to: PANE_ROLES[toPaneId] };
}

async function getMessagesFromQueue(targetPaneId, undeliveredOnly = true) {
  if (!ensureMessageQueueDir()) {
    return [];
  }
  const queueFile = getQueueFilePath(targetPaneId);

  const messages = await serializeQueueMutation(queueFile, async () => readQueueMessagesWithRecovery(queueFile));
  if (undeliveredOnly) {
    return messages.filter(m => !m.delivered);
  }
  return messages;
}

function resolvePaneIds(target) {
  const normalizedTarget = typeof target === 'string' ? target.trim().toLowerCase() : '';
  if (!normalizedTarget) return [];
  if (normalizedTarget === 'workers') {
    return [AGENT_TO_PANE.builder, AGENT_TO_PANE.oracle];
  }
  if (normalizedTarget === 'all') {
    return PANE_IDS.filter(id => id !== paneId);
  }
  const role = normalizeAgentRole(normalizedTarget);
  if (!role) return [];
  return [AGENT_TO_PANE[role]];
}

// ============================================================
// MC3: WORKFLOW TOOL IMPLEMENTATIONS
// ============================================================

function readState() {
  try {
    const statePath = getStateFilePath();
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch (_e) {
    // Ignore parse errors
  }
  return { state: 'idle', active_agents: [], claims: {} };
}

function writeState(state) {
  try {
    state.timestamp = new Date().toISOString();
    const statePath = getStateFilePath({ forWrite: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tempPath = statePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, statePath);
    return { success: true };
  } catch (err) {
    log.error('MCP', 'Failed to write state file', err);
    return { success: false, error: err.message };
  }
}

function triggerAgentFile(targetAgent, context) {
  const normalizedAgent = normalizeAgentRole(targetAgent)
    || String(targetAgent || '').trim().toLowerCase();
  const triggerFile = path.join(getTriggersPath({ forWrite: true }), `${normalizedAgent}.txt`);
  const content = `(${agentName.toUpperCase()}): ${context}`;
  try {
    fs.mkdirSync(path.dirname(triggerFile), { recursive: true });
    fs.writeFileSync(triggerFile, content, 'utf-8');
    return { success: true, triggered: normalizedAgent };
  } catch (err) {
    log.error('MCP', `Failed to trigger agent ${normalizedAgent}`, err);
    return { success: false, error: err.message, triggered: normalizedAgent };
  }
}

function readSharedContext() {
  try {
    const sharedContextPath = getSharedContextPath();
    if (fs.existsSync(sharedContextPath)) {
      return fs.readFileSync(sharedContextPath, 'utf-8');
    }
  } catch (_e) {
    // Ignore
  }
  return 'No shared context available.';
}

function updateStatusFile(taskId, status, note) {
  let content = '';
  const statusReadPath = getStatusFilePath();
  const statusWritePath = getStatusFilePath({ forWrite: true });
  try {
    if (fs.existsSync(statusReadPath)) {
      content = fs.readFileSync(statusReadPath, 'utf-8');
    }
  } catch (err) {
    log.error('MCP', 'Failed to read status file', err);
    return { success: false, error: err.message, taskId, status };
  }

  const timestamp = new Date().toISOString();
  const entry = `\n- **${taskId}**: ${status.toUpperCase()} (${agentName}) - ${timestamp}${note ? ` - ${note}` : ''}`;

  content += entry;
  try {
    fs.mkdirSync(path.dirname(statusWritePath), { recursive: true });
    fs.writeFileSync(statusWritePath, content, 'utf-8');
    return { success: true, taskId, status };
  } catch (err) {
    log.error('MCP', 'Failed to write status file', err);
    return { success: false, error: err.message, taskId, status };
  }
}

// ============================================================
// CALL TOOL HANDLER
// ============================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // MC2: Messaging Tools
      case 'send_message': {
        const targetPaneIds = resolvePaneIds(args.to).filter(id => id !== paneId);
        if (targetPaneIds.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'no_valid_targets',
                sent_to: [],
                message_ids: [],
              }),
            }],
          };
        }
        const results = [];

        for (const targetPaneId of targetPaneIds) {
          const result = await sendMessageToQueue(paneId, targetPaneId, args.content);
          results.push(result);
        }
        const failed = results.filter(result => !result.success);
        const sentTo = results.filter(result => result.success).map(result => result.to);
        const messageIds = results.filter(result => result.success).map(result => result.messageId);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: failed.length === 0 && sentTo.length > 0,
              sent_to: sentTo,
              message_ids: messageIds,
              failed: failed.map(result => ({ to: result.to, error: result.error })),
            }),
          }],
        };
      }

      case 'get_messages': {
        const undeliveredOnly = args.undelivered_only !== false;
        const messages = await getMessagesFromQueue(paneId, undeliveredOnly);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: messages.length,
              messages: messages.map(m => ({
                id: m.id,
                from: m.fromRole,
                content: m.content,
                timestamp: m.timestamp,
              })),
            }),
          }],
        };
      }

      // MC3: Workflow Tools
      case 'get_workflow_state': {
        const state = readState();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              state: state.state,
              active_agents: (state.active_agents || []).map(id => PANE_TO_AGENT[id] || id),
              claims: state.claims || {},
              note: state.note,
              timestamp: state.timestamp,
            }),
          }],
        };
      }

      case 'trigger_agent': {
        const targetPaneIds = resolvePaneIds(args.agent);
        const targets = targetPaneIds
          .filter(id => id !== paneId)
          .map(id => PANE_TO_AGENT[id])
          .filter(Boolean);

        const results = [];
        for (const target of targets) {
          const result = triggerAgentFile(target, args.context);
          results.push(result);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              triggered: targets,
            }),
          }],
        };
      }

      case 'claim_task': {
        const state = readState();
        state.claims = state.claims || {};
        state.claims[args.task_id] = {
          agent: agentName,
          paneId,
          description: args.description || '',
          claimed_at: new Date().toISOString(),
        };
        writeState(state);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task_id: args.task_id,
              claimed_by: agentName,
            }),
          }],
        };
      }

      case 'complete_task': {
        const state = readState();

        // Remove claim
        if (state.claims && state.claims[args.task_id]) {
          delete state.claims[args.task_id];
          writeState(state);
        }

        // Update status file
        updateStatusFile(args.task_id, 'done', args.result);

        // Trigger next agent if specified
        if (args.trigger_next && args.trigger_next !== 'none') {
          triggerAgentFile(args.trigger_next, `Task ${args.task_id} complete. ${args.result || ''}`);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              task_id: args.task_id,
              completed_by: agentName,
              triggered_next: args.trigger_next || 'none',
            }),
          }],
        };
      }

      case 'get_shared_context': {
        const content = readSharedContext();

        return {
          content: [{
            type: 'text',
            text: content,
          }],
        };
      }

      case 'update_status': {
        const result = updateStatusFile(args.task_id, args.status, args.note);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result),
          }],
        };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
          }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          fallback: 'Use file-based triggers as fallback: write to .squidrun/triggers/<agent>.txt.',
        }),
      }],
      isError: true,
    };
  }
});

// ============================================================
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio transport
  log.warn('MCP', `Server started for agent: ${agentName} (pane ${paneId})`);
}

main().catch((error) => {
  log.error('MCP', 'Fatal error', error);
  process.exit(1);
});
