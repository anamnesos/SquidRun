/**
 * Transcript Logger - Captures and logs conversation events
 *
 * Integrates with terminal output, codex exec, and trigger messages
 * to create a comprehensive transcript of agent conversations.
 */

const memoryStore = require('./memory-store');

// Track last logged timestamp per role to avoid duplicates
const lastLoggedTimestamp = new Map();

// Buffer for batching logs (reduces file I/O)
const logBuffer = new Map();
const BUFFER_FLUSH_INTERVAL = 5000; // 5 seconds
let flushTimer = null;

/**
 * Entry types for transcripts
 */
const EntryType = {
  INPUT: 'input',           // User/trigger input to agent
  OUTPUT: 'output',         // Agent response/output
  TOOL_USE: 'tool_use',     // Tool invocation
  TOOL_RESULT: 'tool_result', // Tool response
  SYSTEM: 'system',         // System messages
  DECISION: 'decision',     // Agent decision point
  ERROR: 'error',           // Error occurred
  STATE: 'state'            // State change
};

/**
 * Log an input event (message received by agent)
 * @param {string} paneId
 * @param {string} content - The input content
 * @param {Object} [metadata]
 */
function logInput(paneId, content, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.INPUT,
    paneId: String(paneId),
    content: truncateContent(content),
    metadata: {
      ...metadata,
      contentLength: content.length
    }
  };
  queueLog(role, entry);
}

/**
 * Log an output event (agent response)
 * @param {string} paneId
 * @param {string} content - The output content
 * @param {Object} [metadata]
 */
function logOutput(paneId, content, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.OUTPUT,
    paneId: String(paneId),
    content: truncateContent(content),
    metadata: {
      ...metadata,
      contentLength: content.length
    }
  };
  queueLog(role, entry);
}

/**
 * Log a tool use event
 * @param {string} paneId
 * @param {string} toolName
 * @param {Object} [params]
 * @param {Object} [metadata]
 */
function logToolUse(paneId, toolName, params = {}, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.TOOL_USE,
    paneId: String(paneId),
    content: `Tool: ${toolName}`,
    metadata: {
      ...metadata,
      toolName,
      params: sanitizeParams(params)
    }
  };
  queueLog(role, entry);
}

/**
 * Log a tool result
 * @param {string} paneId
 * @param {string} toolName
 * @param {*} result
 * @param {Object} [metadata]
 */
function logToolResult(paneId, toolName, result, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.TOOL_RESULT,
    paneId: String(paneId),
    content: truncateContent(typeof result === 'string' ? result : JSON.stringify(result)),
    metadata: {
      ...metadata,
      toolName,
      success: !metadata.error
    }
  };
  queueLog(role, entry);
}

/**
 * Log a system event
 * @param {string} paneId
 * @param {string} message
 * @param {Object} [metadata]
 */
function logSystem(paneId, message, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.SYSTEM,
    paneId: String(paneId),
    content: message,
    metadata
  };
  queueLog(role, entry);
}

/**
 * Log a decision point
 * @param {string} paneId
 * @param {string} action - What action was taken
 * @param {string} [rationale] - Why this action was chosen
 * @param {Object} [metadata]
 */
function logDecision(paneId, action, rationale = '', metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.DECISION,
    paneId: String(paneId),
    content: action,
    metadata: {
      ...metadata,
      rationale,
      decisionId: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
  };
  queueLog(role, entry);

  // Also add to shared decisions
  memoryStore.addSharedDecision({
    action,
    rationale,
    agent: role,
    paneId: String(paneId),
    ...metadata
  });
}

/**
 * Log an error event
 * @param {string} paneId
 * @param {string} message
 * @param {Error|Object} [error]
 * @param {Object} [metadata]
 */
function logError(paneId, message, error = null, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.ERROR,
    paneId: String(paneId),
    content: message,
    metadata: {
      ...metadata,
      errorMessage: error?.message || String(error || ''),
      errorStack: error?.stack?.split('\n').slice(0, 5).join('\n') || ''
    }
  };
  queueLog(role, entry);
}

/**
 * Log a state change
 * @param {string} paneId
 * @param {string} fromState
 * @param {string} toState
 * @param {Object} [metadata]
 */
function logState(paneId, fromState, toState, metadata = {}) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const entry = {
    type: EntryType.STATE,
    paneId: String(paneId),
    content: `${fromState} -> ${toState}`,
    metadata: {
      ...metadata,
      fromState,
      toState
    }
  };
  queueLog(role, entry);
}

/**
 * Log a trigger message (inter-agent communication)
 * @param {string} sourcePaneId
 * @param {string} targetPaneId
 * @param {string} content
 * @param {Object} [metadata]
 */
function logTriggerMessage(sourcePaneId, targetPaneId, content, metadata = {}) {
  const sourceRole = memoryStore.getRoleFromPaneId(sourcePaneId);
  const targetRole = memoryStore.getRoleFromPaneId(targetPaneId);

  // Log as output for source
  if (sourcePaneId) {
    queueLog(sourceRole, {
      type: EntryType.OUTPUT,
      paneId: String(sourcePaneId),
      content: truncateContent(content),
      metadata: {
        ...metadata,
        messageType: 'trigger_sent',
        target: targetRole,
        targetPaneId: String(targetPaneId)
      }
    });
  }

  // Log as input for target
  if (targetPaneId) {
    queueLog(targetRole, {
      type: EntryType.INPUT,
      paneId: String(targetPaneId),
      content: truncateContent(content),
      metadata: {
        ...metadata,
        messageType: 'trigger_received',
        source: sourceRole,
        sourcePaneId: String(sourcePaneId)
      }
    });
  }
}

/**
 * Log Codex exec JSONL event
 * @param {string} paneId
 * @param {Object} event - Parsed JSONL event
 */
function logCodexEvent(paneId, event) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  const eventType = event.type || 'unknown';

  let entry;
  switch (eventType) {
    case 'message_start':
    case 'message':
      entry = {
        type: EntryType.OUTPUT,
        paneId: String(paneId),
        content: event.content || event.message || '',
        metadata: {
          codexEvent: eventType,
          messageId: event.id,
          model: event.model
        }
      };
      break;

    case 'tool_use':
      entry = {
        type: EntryType.TOOL_USE,
        paneId: String(paneId),
        content: `Tool: ${event.name || 'unknown'}`,
        metadata: {
          codexEvent: eventType,
          toolName: event.name,
          toolId: event.id
        }
      };
      break;

    case 'tool_result':
      entry = {
        type: EntryType.TOOL_RESULT,
        paneId: String(paneId),
        content: truncateContent(event.content || ''),
        metadata: {
          codexEvent: eventType,
          toolId: event.tool_use_id,
          isError: event.is_error
        }
      };
      break;

    case 'text':
    case 'content_block_delta':
      // Skip streaming deltas - too noisy
      return;

    case 'session_meta':
      entry = {
        type: EntryType.SYSTEM,
        paneId: String(paneId),
        content: `Session: ${event.session_id || 'unknown'}`,
        metadata: {
          codexEvent: eventType,
          sessionId: event.session_id
        }
      };
      break;

    case 'message_stop':
    case 'done':
      entry = {
        type: EntryType.SYSTEM,
        paneId: String(paneId),
        content: 'Message complete',
        metadata: {
          codexEvent: eventType,
          stopReason: event.stop_reason
        }
      };
      break;

    default:
      // Log other events as system
      entry = {
        type: EntryType.SYSTEM,
        paneId: String(paneId),
        content: `Codex event: ${eventType}`,
        metadata: {
          codexEvent: eventType,
          raw: truncateContent(JSON.stringify(event), 500)
        }
      };
  }

  if (entry) {
    queueLog(role, entry);
  }
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Queue a log entry for batched writing
 * @param {string} role
 * @param {Object} entry
 */
function queueLog(role, entry) {
  if (!logBuffer.has(role)) {
    logBuffer.set(role, []);
  }

  entry.timestamp = new Date().toISOString();
  logBuffer.get(role).push(entry);

  // Schedule flush if not already scheduled
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, BUFFER_FLUSH_INTERVAL);
  }
}

/**
 * Flush all buffered logs to disk
 */
function flushLogs() {
  flushTimer = null;

  for (const [role, entries] of logBuffer.entries()) {
    if (entries.length === 0) continue;

    for (const entry of entries) {
      memoryStore.appendTranscript(role, entry);
    }
  }

  logBuffer.clear();
}

/**
 * Force immediate flush (for shutdown)
 */
function forceFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushLogs();
}

/**
 * Truncate content to reasonable size
 * @param {string} content
 * @param {number} [maxLength=10000]
 * @returns {string}
 */
function truncateContent(content, maxLength = 10000) {
  if (!content) return '';
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `... [truncated ${content.length - maxLength} chars]`;
}

/**
 * Sanitize params to avoid logging sensitive data
 * @param {Object} params
 * @returns {Object}
 */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params;

  const sanitized = {};
  const sensitiveKeys = ['password', 'token', 'key', 'secret', 'credential', 'auth'];

  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(s => lowerKey.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 1000) {
      sanitized[key] = value.slice(0, 1000) + '... [truncated]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

/**
 * Start a new logging session for a pane
 * @param {string} paneId
 * @param {Object} [metadata]
 */
function startSession(paneId, metadata = {}) {
  logSystem(paneId, 'Session started', {
    ...metadata,
    sessionStart: true
  });
}

/**
 * End a logging session for a pane
 * @param {string} paneId
 * @param {Object} [metadata]
 */
function endSession(paneId, metadata = {}) {
  logSystem(paneId, 'Session ended', {
    ...metadata,
    sessionEnd: true
  });
  forceFlush();
}

/**
 * Get recent transcript for a pane
 * @param {string} paneId
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getRecentTranscript(paneId, limit = 50) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  return memoryStore.readTranscript(role, { limit });
}

/**
 * Get transcript stats for a pane
 * @param {string} paneId
 * @returns {Object}
 */
function getTranscriptStats(paneId) {
  const role = memoryStore.getRoleFromPaneId(paneId);
  return memoryStore.getTranscriptStats(role);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Entry types
  EntryType,

  // Logging functions
  logInput,
  logOutput,
  logToolUse,
  logToolResult,
  logSystem,
  logDecision,
  logError,
  logState,
  logTriggerMessage,
  logCodexEvent,

  // Session management
  startSession,
  endSession,
  forceFlush,

  // Query functions
  getRecentTranscript,
  getTranscriptStats
};
