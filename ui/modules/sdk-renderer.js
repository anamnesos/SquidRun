/**
 * SDK Message Renderer
 * Replaces xterm.js terminal emulation with structured message display
 * for Claude Agent SDK output.
 *
 * Task #2 - SDK Prototype Sprint
 * Owner: Worker A
 */

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4'];
const PANE_ROLES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer'
};

// Message containers per pane
const containers = new Map();

// Session IDs per pane (for resume capability)
const sessionIds = new Map();

// Message ID counter for delivery tracking
let messageIdCounter = 0;

// Pending messages awaiting delivery confirmation
const pendingMessages = new Map();

/**
 * Generate unique message ID
 * @returns {string} Unique message ID
 */
function generateMessageId() {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

/**
 * Create delivery state element
 * @param {string} state - 'sending' | 'sent' | 'delivered'
 * @returns {HTMLElement} Delivery state span
 */
function createDeliveryState(state) {
  const stateEl = document.createElement('span');
  stateEl.className = `sdk-delivery-state ${state}`;

  const icons = {
    sending: '\u25CB', // ○ hollow circle
    sent: '\u25CF',    // ● filled circle
    delivered: '\u2713' // ✓ checkmark
  };

  stateEl.innerHTML = `<span class="sdk-delivery-icon">${icons[state]}</span>`;
  return stateEl;
}

/**
 * Update message delivery state
 * @param {string} messageId - Message ID to update
 * @param {string} newState - New state ('sent' | 'delivered')
 */
function updateDeliveryState(messageId, newState) {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!msgEl) return;

  const stateEl = msgEl.querySelector('.sdk-delivery-state');
  if (stateEl) {
    stateEl.className = `sdk-delivery-state ${newState}`;
    const icons = {
      sending: '\u25CB',
      sent: '\u25CF',
      delivered: '\u2713'
    };
    stateEl.innerHTML = `<span class="sdk-delivery-icon">${icons[newState]}</span>`;
  }

  // Remove from pending if delivered
  if (newState === 'delivered') {
    pendingMessages.delete(messageId);
  }
}

/**
 * Initialize SDK pane - replaces terminal with message container
 * @param {string} paneId - Pane ID (1-4)
 */
function initSDKPane(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane) {
    console.error(`[SDK] Pane ${paneId} not found - available panes:`,
      Array.from(document.querySelectorAll('.pane')).map(p => p.dataset.paneId));
    return;
  }

  // SDK-FIX2: Robustly find or create the terminal container
  // First try the original .pane-terminal by ID (most reliable)
  let terminalDiv = document.getElementById(`terminal-${paneId}`);

  // Fallback: query within the pane
  if (!terminalDiv) {
    terminalDiv = pane.querySelector('.pane-terminal');
  }

  // SDK-1 FIX: Handle case where xterm has already modified DOM
  if (!terminalDiv) {
    // xterm may have replaced .pane-terminal - look for xterm's container
    const xtermContainer = pane.querySelector('.xterm');
    if (xtermContainer) {
      terminalDiv = xtermContainer.parentElement;
    }
  }

  if (!terminalDiv) {
    // Fallback: create container after pane-header
    const header = pane.querySelector('.pane-header');
    terminalDiv = document.createElement('div');
    terminalDiv.className = 'pane-terminal sdk-container';
    terminalDiv.id = `terminal-${paneId}`;
    if (header) {
      header.after(terminalDiv);
    } else {
      pane.appendChild(terminalDiv);
    }
    console.log(`[SDK] Created new container for pane ${paneId}`);
  }

  // Clear any existing xterm content and replace with SDK message container
  terminalDiv.innerHTML = '';

  const sdkPane = document.createElement('div');
  sdkPane.className = 'sdk-pane';
  sdkPane.dataset.paneId = paneId;

  const sdkMessages = document.createElement('div');
  sdkMessages.className = 'sdk-messages';
  sdkMessages.id = `sdk-messages-${paneId}`;

  sdkPane.appendChild(sdkMessages);
  terminalDiv.appendChild(sdkPane);

  containers.set(paneId, sdkMessages);
  console.log(`[SDK] Initialized pane ${paneId} (${PANE_ROLES[paneId]}) - container:`, sdkMessages);
}

/**
 * Initialize all SDK panes
 */
function initAllSDKPanes() {
  console.log('[SDK] Initializing all panes...');

  // Clear existing containers map
  containers.clear();

  for (const paneId of PANE_IDS) {
    initSDKPane(paneId);
  }

  // Verify all panes were initialized
  const initialized = Array.from(containers.keys());
  const missing = PANE_IDS.filter(id => !containers.has(id));

  if (missing.length > 0) {
    console.error(`[SDK] Failed to initialize panes: ${missing.join(', ')}`);
  }

  console.log(`[SDK] All panes initialized: ${initialized.join(', ')} (${containers.size}/${PANE_IDS.length})`);
}

/**
 * Get CSS class based on message type
 * @param {Object} message - SDK message object
 * @returns {string} CSS class name
 */
function getMessageClass(message) {
  if (message.error) return 'sdk-error';
  if (message.type === 'assistant') return 'sdk-assistant';
  if (message.type === 'tool_use') return 'sdk-tool-use';
  if (message.type === 'tool_result') return 'sdk-tool-result';
  if (message.type === 'system' || message.subtype === 'init') return 'sdk-system';
  if (message.result !== undefined) return 'sdk-result';
  return 'sdk-default';
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate long text and wrap in collapsible if needed
 * @param {string} text - Text to potentially truncate
 * @param {number} maxLines - Max lines before collapsing (default 20)
 * @param {string} label - Label for collapsed section
 * @returns {string} HTML (possibly wrapped in details)
 */
function truncateIfLong(text, maxLines = 20, label = 'Content') {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return `<pre class="sdk-content">${escapeHtml(text)}</pre>`;
  }
  // Show first few lines, collapse the rest
  const preview = lines.slice(0, 5).join('\n');
  return `
    <details class="sdk-long-content">
      <summary>${escapeHtml(label)} (${lines.length} lines - click to expand)</summary>
      <pre class="sdk-content">${escapeHtml(text)}</pre>
    </details>
    <pre class="sdk-preview">${escapeHtml(preview)}...</pre>
  `;
}

/**
 * Format message content based on type
 * @param {Object} message - SDK message object
 * @returns {string} Formatted HTML
 */
function formatMessage(message) {
  // Session initialization
  if (message.subtype === 'init' && message.session_id) {
    sessionIds.set(message.paneId || '1', message.session_id);
    return `<span class="sdk-session-id">Session: ${escapeHtml(message.session_id)}</span>`;
  }

  // Assistant text output
  if (message.type === 'assistant') {
    const content = message.content;

    // V2 FIX: Python sends content as ARRAY of content blocks, not string
    if (Array.isArray(content)) {
      return content.map(block => {
        if (block.type === 'text') {
          // Don't truncate assistant text - show full response
          return `<pre class="sdk-content">${escapeHtml(block.text || '')}</pre>`;
        } else if (block.type === 'thinking') {
          return `<details class="sdk-thinking"><summary>Thinking...</summary><pre>${escapeHtml(block.thinking || '')}</pre></details>`;
        } else if (block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input, null, 2);
          // Collapse long tool inputs
          if (inputStr.split('\n').length > 10) {
            return `
              <details class="sdk-tool-details">
                <summary>${escapeHtml(block.name || 'Tool')}</summary>
                <pre class="sdk-tool-input">${escapeHtml(inputStr)}</pre>
              </details>
            `;
          }
          return `
            <div class="sdk-tool-header">${escapeHtml(block.name || 'Tool')}</div>
            <pre class="sdk-tool-input">${escapeHtml(inputStr)}</pre>
          `;
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2);
          return `
            <details class="sdk-tool-details">
              <summary>Result${block.is_error ? ' (Error)' : ''} · ${resultContent.split('\n').length} lines</summary>
              <pre class="sdk-tool-output">${escapeHtml(resultContent)}</pre>
            </details>
          `;
        }
        // Unknown block type - show as content (don't collapse)
        if (typeof block === 'string') {
          return `<pre class="sdk-content">${escapeHtml(block)}</pre>`;
        }
        // If it has a text property, use that
        if (block.text) {
          return `<pre class="sdk-content">${escapeHtml(block.text)}</pre>`;
        }
        // Last resort: stringify
        return `<pre class="sdk-content">${escapeHtml(JSON.stringify(block, null, 2))}</pre>`;
      }).join('\n');
    }

    // String content (legacy/fallback)
    return `<pre class="sdk-content">${escapeHtml(content || '')}</pre>`;
  }

  // Tool use (delegation to subagent or tool call)
  if (message.type === 'tool_use') {
    const toolName = message.name || 'Unknown Tool';
    const agentName = message.input?.agent || message.input?.subagent_type;

    if (agentName) {
      // Subagent delegation
      return `
        <div class="sdk-delegating-header">Delegating to ${escapeHtml(agentName.toUpperCase())}</div>
        <pre class="sdk-tool-input">${escapeHtml(message.input?.prompt || '')}</pre>
      `;
    }

    // Regular tool call
    return `
      <div class="sdk-tool-header">${escapeHtml(toolName)}</div>
      <pre class="sdk-tool-input">${escapeHtml(JSON.stringify(message.input, null, 2))}</pre>
    `;
  }

  // Tool result
  if (message.type === 'tool_result') {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content, null, 2);
    return `
      <details class="sdk-tool-details">
        <summary>Result</summary>
        <pre class="sdk-tool-output">${escapeHtml(content)}</pre>
      </details>
    `;
  }

  // Final result
  if (message.result !== undefined) {
    return `
      <div class="sdk-result-header">Complete</div>
      <pre class="sdk-result-content">${escapeHtml(message.result)}</pre>
    `;
  }

  // Error
  if (message.error) {
    return `
      <div class="sdk-error-header">Error</div>
      <pre class="sdk-error-content">${escapeHtml(message.error)}</pre>
    `;
  }

  // V2 FIX: Handle Python-specific message types

  // User message (echo of what user sent)
  // Check for agent prefix pattern: (ROLE): message
  // If present, show as agent message with distinct styling
  // If not, show as actual user input
  if (message.type === 'user') {
    const content = message.content || message.message || '';
    const displayContent = typeof content === 'string' ? content : JSON.stringify(content);

    // Detect agent prefix: (LEAD): (WORKER-A #5): (WORKER-B): (REVIEWER #12):
    // Format: (ROLE) or (ROLE #N) where N is the sequence number
    const agentMatch = displayContent.match(/^\((LEAD|WORKER-?A|WORKER-?B|REVIEWER)(?:\s*#(\d+))?\):\s*/i);

    if (agentMatch) {
      // This is a trigger message from another agent
      const role = agentMatch[1].toUpperCase().replace('-', '-');
      const seqNum = agentMatch[2] ? parseInt(agentMatch[2], 10) : null;
      const actualMessage = displayContent.slice(agentMatch[0].length);
      const roleConfig = {
        'LEAD': { class: 'lead', label: 'Lead' },
        'WORKER-A': { class: 'worker-a', label: 'Worker A' },
        'WORKERA': { class: 'worker-a', label: 'Worker A' },
        'WORKER-B': { class: 'worker-b', label: 'Worker B' },
        'WORKERB': { class: 'worker-b', label: 'Worker B' },
        'REVIEWER': { class: 'reviewer', label: 'Reviewer' }
      };
      const config = roleConfig[role] || roleConfig['LEAD'];
      // Display label with sequence number if present: "Lead #7" or just "Lead"
      const displayLabel = seqNum !== null ? `${config.label} #${seqNum}` : config.label;

      return `
        <div class="sdk-agent-msg sdk-agent-${config.class}">
          <span class="sdk-agent-label">${displayLabel}</span>
          <pre class="sdk-agent-content">${escapeHtml(actualMessage)}</pre>
        </div>
      `;
    }

    // Actual user input (no agent prefix)
    return `
      <div class="sdk-user">
        <span class="sdk-user-label">You</span>
        <pre class="sdk-user-content">${escapeHtml(displayContent)}</pre>
      </div>
    `;
  }

  // Status message (thinking, idle, connected, disconnected)
  if (message.type === 'status') {
    return `<div class="sdk-status">${escapeHtml(message.state || 'unknown')}</div>`;
  }

  // Unknown message type from Python (has raw field)
  if (message.type === 'unknown' && message.raw) {
    return `<pre class="sdk-unknown">${escapeHtml(message.raw)}</pre>`;
  }

  // System message (session info, etc.)
  if (message.type === 'system') {
    const subtype = message.subtype || '';
    const data = message.data || {};
    if (data.session_id) {
      // Only show session ID once at connection, not on every message
      // Use subtle styling and hide if already shown
      return `<div class="sdk-system sdk-session-info">Connected · ${escapeHtml(data.session_id.substring(0, 8))}</div>`;
    }
    return `<div class="sdk-system">${escapeHtml(subtype)}</div>`;
  }

  // Result message (completion info)
  if (message.type === 'result') {
    const cost = message.total_cost_usd ? `$${message.total_cost_usd.toFixed(4)}` : '';
    const duration = message.duration_ms ? `${(message.duration_ms / 1000).toFixed(1)}s` : '';
    const details = [duration, cost].filter(Boolean).join(' · ');
    return `
      <div class="sdk-result">
        Complete${details ? ` · ${escapeHtml(details)}` : ''}
        ${message.is_error ? '<span class="sdk-error-flag">with errors</span>' : ''}
      </div>
    `;
  }

  // Warning message (role dir missing, session load fail, etc.)
  if (message.type === 'warning') {
    return `<div class="sdk-warning">${escapeHtml(message.message || 'Warning')}</div>`;
  }

  // Interrupted message (Ctrl+C feedback)
  if (message.type === 'interrupted') {
    return `<div class="sdk-status">${escapeHtml(message.role || 'Agent')} interrupted</div>`;
  }

  // Agent started message
  if (message.type === 'agent_started') {
    return `<div class="sdk-system">${escapeHtml(message.role || 'Agent')} connected</div>`;
  }

  // Default: stringify unknown message types
  return `<pre>${escapeHtml(JSON.stringify(message, null, 2))}</pre>`;
}

/**
 * Append message to pane with type-specific formatting
 * @param {string} paneId - Pane ID (1-4)
 * @param {Object} message - SDK message object
 * @param {Object} options - Optional settings { trackDelivery: boolean, isOutgoing: boolean }
 * @returns {string|null} Message ID if tracking delivery, null otherwise
 */
function appendMessage(paneId, message, options = {}) {
  let container = containers.get(paneId);

  // SDK-FIX2: Try to recover container if not found
  if (!container) {
    // Try to get by ID directly
    container = document.getElementById(`sdk-messages-${paneId}`);
    if (container) {
      containers.set(paneId, container);
      console.log(`[SDK] Recovered container for pane ${paneId}`);
    }
  }

  if (!container) {
    console.warn(`[SDK] Container not found for pane ${paneId} - reinitializing`);
    initSDKPane(paneId);
    container = containers.get(paneId);
    if (!container) {
      console.error(`[SDK] Failed to initialize container for pane ${paneId}`);
      return null;
    }
  }

  // Remove streaming indicator if present
  streamingIndicator(paneId, false);

  const msgEl = document.createElement('div');
  msgEl.className = `sdk-msg ${getMessageClass(message)}`;
  msgEl.innerHTML = formatMessage(message);

  // Add message ID for delivery tracking
  const messageId = options.trackDelivery ? generateMessageId() : null;
  if (messageId) {
    msgEl.dataset.msgId = messageId;
    pendingMessages.set(messageId, { paneId, timestamp: Date.now() });
  }

  // Add timestamp
  const timestamp = document.createElement('span');
  timestamp.className = 'sdk-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  msgEl.insertBefore(timestamp, msgEl.firstChild);

  // Add delivery state for outgoing messages
  if (options.isOutgoing || options.trackDelivery) {
    const deliveryState = createDeliveryState('sending');
    msgEl.appendChild(deliveryState);

    // Auto-transition to 'sent' after 200ms (optimistic)
    setTimeout(() => updateDeliveryState(messageId, 'sent'), 200);
  }

  container.appendChild(msgEl);
  scrollToBottom(paneId);
}

/**
 * Clear pane content
 * @param {string} paneId - Pane ID (1-4)
 */
function clearPane(paneId) {
  const container = containers.get(paneId);
  if (container) {
    container.innerHTML = '';
    console.log(`[SDK] Cleared pane ${paneId}`);
  }
}

/**
 * Clear all panes
 */
function clearAllPanes() {
  for (const paneId of PANE_IDS) {
    clearPane(paneId);
  }
}

/**
 * Auto-scroll pane to bottom
 * @param {string} paneId - Pane ID (1-4)
 */
function scrollToBottom(paneId) {
  const container = containers.get(paneId);
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Show/hide streaming indicator (shimmer bar thinking animation)
 * UX-8: Now supports contextual text based on tool use
 * @param {string} paneId - Pane ID (1-4)
 * @param {boolean} active - Whether to show or hide
 * @param {string} context - Optional context text (e.g., "Reading files...")
 */
function streamingIndicator(paneId, active, context = null) {
  const container = containers.get(paneId);
  if (!container) return;

  let indicator = container.querySelector('.sdk-streaming');

  if (active && !indicator) {
    indicator = document.createElement('div');
    indicator.className = 'sdk-streaming';
    indicator.innerHTML = `
      <div class="sdk-streaming-bar"></div>
      <span class="sdk-streaming-text">${escapeHtml(context || 'Thinking...')}</span>
    `;
    container.appendChild(indicator);
    scrollToBottom(paneId);
  } else if (active && indicator && context) {
    // UX-8: Update context text if indicator exists
    const textEl = indicator.querySelector('.sdk-streaming-text');
    if (textEl) {
      textEl.textContent = context;
    }
  } else if (!active && indicator) {
    indicator.remove();
  }
}

/**
 * UX-8: Update streaming indicator with tool context
 * Parses tool_use messages and shows friendly descriptions
 * @param {string} paneId - Pane ID (1-4)
 * @param {Object} toolUse - Tool use message object
 */
function updateToolContext(paneId, toolUse) {
  const toolName = toolUse.name || toolUse.tool || 'unknown';
  const input = toolUse.input || {};

  // Map tool names to friendly descriptions
  const contextMap = {
    'Read': () => {
      const file = input.file_path || input.path || 'file';
      const fileName = file.split(/[/\\]/).pop();
      return `Reading ${fileName}...`;
    },
    'Write': () => {
      const file = input.file_path || input.path || 'file';
      const fileName = file.split(/[/\\]/).pop();
      return `Writing ${fileName}...`;
    },
    'Edit': () => {
      const file = input.file_path || input.path || 'file';
      const fileName = file.split(/[/\\]/).pop();
      return `Editing ${fileName}...`;
    },
    'Glob': () => {
      const pattern = input.pattern || '*';
      return `Finding files: ${pattern}`;
    },
    'Grep': () => {
      const pattern = input.pattern || 'pattern';
      return `Searching: ${pattern.substring(0, 20)}...`;
    },
    'Bash': () => {
      const cmd = input.command || '';
      const shortCmd = cmd.split(' ')[0] || 'command';
      return `Running ${shortCmd}...`;
    },
    'Task': () => {
      const desc = input.description || 'task';
      return `Delegating: ${desc.substring(0, 25)}...`;
    },
    'WebFetch': () => {
      const url = input.url || 'URL';
      try {
        const hostname = new URL(url).hostname;
        return `Fetching ${hostname}...`;
      } catch {
        return 'Fetching web page...';
      }
    },
    'WebSearch': () => {
      const query = input.query || 'query';
      return `Searching: ${query.substring(0, 20)}...`;
    },
  };

  const contextFn = contextMap[toolName];
  const context = contextFn ? contextFn() : `Using ${toolName}...`;

  streamingIndicator(paneId, true, context);
}

/**
 * Get session ID for a pane (for resume capability)
 * @param {string} paneId - Pane ID (1-4)
 * @returns {string|null} Session ID or null
 */
function getSessionId(paneId) {
  return sessionIds.get(paneId) || null;
}

/**
 * Add a system message to pane
 * @param {string} paneId - Pane ID (1-4)
 * @param {string} text - System message text
 */
function addSystemMessage(paneId, text) {
  appendMessage(paneId, { type: 'system', content: text });
}

/**
 * Add an error message to pane
 * @param {string} paneId - Pane ID (1-4)
 * @param {string} error - Error message text
 */
function addErrorMessage(paneId, error) {
  appendMessage(paneId, { error });
}

module.exports = {
  // Initialization
  initSDKPane,
  initAllSDKPanes,

  // Message handling
  appendMessage,
  addSystemMessage,
  addErrorMessage,

  // Delivery state tracking
  updateDeliveryState,
  generateMessageId,

  // Pane control
  clearPane,
  clearAllPanes,
  scrollToBottom,
  streamingIndicator,

  // UX-8: Contextual thinking states
  updateToolContext,

  // Session management
  getSessionId,

  // Constants
  PANE_IDS,
  PANE_ROLES
};
