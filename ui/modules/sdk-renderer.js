/**
 * SDK Message Renderer
 * Replaces xterm.js terminal emulation with structured message display
 * for Claude Agent SDK output.
 *
 * Task #2 - SDK Prototype Sprint
 * Owner: Worker A
 */

const log = require('./logger');
const config = require('../config');
const { showToast } = require('./notifications');

// Pane configuration - initialized from canonical source (config.js)
// Can be overridden via setPaneConfig for SDK mode if needed
let PANE_IDS = [...config.PANE_IDS];
let PANE_ROLES = { ...config.PANE_ROLES };

function setPaneConfig({ paneIds, paneRoles } = {}) {
  if (Array.isArray(paneIds)) {
    PANE_IDS = paneIds;
  }
  if (paneRoles && typeof paneRoles === 'object') {
    PANE_ROLES = paneRoles;
  }
}

function setSDKPaneConfig() {
  // Reset to canonical config values
  setPaneConfig({ paneIds: [...config.PANE_IDS], paneRoles: { ...config.PANE_ROLES } });
}

// Message containers per pane
const containers = new Map();

// Session IDs per pane (for resume capability)
const sessionIds = new Map();

// Message ID counter for delivery tracking
let messageIdCounter = 0;

// ===== HIVEMIND HONEYCOMB ANIMATION =====
// Branded honeycomb thinking indicator (replaces generic braille spinner)
// 7 hexagons: 1 center + 6 surrounding, pulse animation via CSS

/**
 * Generate honeycomb HTML structure
 * @returns {string} HTML for 7-cell honeycomb
 */
function generateHoneycombHTML() {
  return `
    <div class="hive-honeycomb">
      <div class="hive-hex hive-hex-0"></div>
      <div class="hive-hex hive-hex-1"></div>
      <div class="hive-hex hive-hex-2"></div>
      <div class="hive-hex hive-hex-3"></div>
      <div class="hive-hex hive-hex-4"></div>
      <div class="hive-hex hive-hex-5"></div>
      <div class="hive-hex hive-hex-6"></div>
    </div>
  `;
}

// Pending messages awaiting delivery confirmation
const pendingMessages = new Map();

// ===== STREAMING TEXT DELTA STATE =====
// Track active streaming messages per pane for typewriter effect
const streamingMessages = new Map();  // paneId -> { element, buffer, complete }
const TYPEWRITER_DELAY = 0; // No delay - render immediately for responsiveness

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
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 */
function initSDKPane(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane) {
    log.error('SDK', `Pane ${paneId} not found - available panes: ${Array.from(document.querySelectorAll('.pane')).map(p => p.dataset.paneId).join(', ')}`);
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
    log.info('SDK', `Created new container for pane ${paneId}`);
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
  log.info('SDK', `Initialized pane ${paneId} (${PANE_ROLES[paneId]})`);
}

/**
 * Initialize all SDK panes
 */
function initAllSDKPanes() {
  log.info('SDK', 'Initializing all panes...');

  // Clear existing containers map
  containers.clear();

  for (const paneId of PANE_IDS) {
    initSDKPane(paneId);
  }

  // Verify all panes were initialized
  const initialized = Array.from(containers.keys());
  const missing = PANE_IDS.filter(id => !containers.has(id));

  if (missing.length > 0) {
    log.error('SDK', `Failed to initialize panes: ${missing.join(', ')}`);
  }

  log.info('SDK', `All panes initialized: ${initialized.join(', ')} (${containers.size}/${PANE_IDS.length})`);
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

    // Python sends content as ARRAY of content blocks, not string
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

  // Handle Python-specific message types

  // User message (echo of what user sent)
  // Check for agent prefix pattern: (ROLE): message
  // If present, show as agent message with distinct styling
  // If not, show as actual user input
  if (message.type === 'user') {
    const content = message.content || message.message || '';
    const displayContent = typeof content === 'string' ? content : JSON.stringify(content);

    // Detect agent prefix: (ARCH): (FRONT #5): (ARCHITECT): etc.
    // Format: (ROLE) or (ROLE #N) where N is the sequence number
    // Supports: short names (ARCH, FRONT, BACK, ANA, REV) + full names + legacy names
    const agentMatch = displayContent.match(/^\((ARCH|ARCHITECT|LEAD|INFRA|ORCHESTRATOR|FRONT|FRONTEND|IMPLEMENTER-?A|WORKER-?A|BACK|BACKEND|IMPLEMENTER-?B|WORKER-?B|ANA|ANALYST|INVESTIGATOR|REV|REVIEWER)(?:\s*#(\d+))?\):\s*/i);

    if (agentMatch) {
      // This is a trigger message from another agent
      const role = agentMatch[1].toUpperCase().replace('-', '-');
      const seqNum = agentMatch[2] ? parseInt(agentMatch[2], 10) : null;
      const actualMessage = displayContent.slice(agentMatch[0].length);
      const roleConfig = {
        // Pane 1: Architect (short: Arch, legacy: Lead)
        'ARCH': { class: 'lead', label: 'Arch' },
        'ARCHITECT': { class: 'lead', label: 'Arch' },
        'LEAD': { class: 'lead', label: 'Arch' },
        // Pane 2: DevOps (legacy: Infra, Orchestrator, Backend, Worker B)
        'DEVOPS': { class: 'devops', label: 'DevOps' },
        'INFRA': { class: 'devops', label: 'DevOps' },
        'ORCHESTRATOR': { class: 'devops', label: 'DevOps' },
        'BACK': { class: 'devops', label: 'DevOps' },
        'BACKEND': { class: 'devops', label: 'DevOps' },
        'IMPLEMENTER-B': { class: 'devops', label: 'DevOps' },
        'IMPLEMENTERB': { class: 'devops', label: 'DevOps' },
        'WORKER-B': { class: 'devops', label: 'DevOps' },
        'WORKERB': { class: 'devops', label: 'DevOps' },
        // Pane 5: Analyst (short: Ana, legacy: Investigator)
        'ANA': { class: 'analyst', label: 'Ana' },
        'ANALYST': { class: 'analyst', label: 'Ana' },
        'INVESTIGATOR': { class: 'analyst', label: 'Ana' },
        // Frontend and Reviewer are internal teammates of Architect (no dedicated panes)
        'FRONT': { class: 'lead', label: 'Arch' },
        'FRONTEND': { class: 'lead', label: 'Arch' },
        'REV': { class: 'lead', label: 'Arch' },
        'REVIEWER': { class: 'lead', label: 'Arch' }
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
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
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
      log.info('SDK', `Recovered container for pane ${paneId}`);
    }
  }

  if (!container) {
    log.warn('SDK', `Container not found for pane ${paneId} - reinitializing`);
    initSDKPane(paneId);
    container = containers.get(paneId);
    if (!container) {
      log.error('SDK', `Failed to initialize container for pane ${paneId}`);
      showToast(`SDK error: Failed to initialize message container for pane ${paneId}`, 'error');
      return null;
    }
  }

  // If this is an assistant message and we have active streaming state,
  // the content was already displayed via text_delta - skip duplicate rendering
  if (message.type === 'assistant') {
    const streamState = streamingMessages.get(paneId);
    if (streamState && streamState.buffer.length > 0 && !streamState.complete) {
      // Content already displayed via streaming - just finalize
      log.info('SDK', `Skipping duplicate assistant message for pane ${paneId} (${streamState.buffer.length} chars already streamed)`);
      finalizeStreamingMessage(paneId);
      return null;
    }
  }

  // THINKING-FIX: Only remove streaming indicator for non-tool_use messages
  // For tool_use, we WANT the indicator to stay visible showing "Reading file..." etc.
  // It will be removed when: tool_result arrives, text_delta starts, or error occurs
  const isToolUse = message.type === 'tool_use' ||
    (message.type === 'assistant' && Array.isArray(message.content) &&
     message.content.some(b => b.type === 'tool_use'));

  if (!isToolUse) {
    streamingIndicator(paneId, false);
  }

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
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 */
function clearPane(paneId) {
  const container = containers.get(paneId);
  if (container) {
    container.innerHTML = '';
    log.info('SDK', `Cleared pane ${paneId}`);
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
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 */
function scrollToBottom(paneId) {
  const container = containers.get(paneId);
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Show/hide streaming indicator (Hivemind Honeycomb Animation)
 * Replaces generic braille spinner with branded honeycomb pulse.
 * UX-8: Supports contextual text based on tool use
 * ROUND-2: Intensity scaling - different pulse speeds for different operations
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @param {boolean} active - Whether to show or hide
 * @param {string} context - Optional context text (e.g., "Reading files...")
 * @param {string} category - Optional tool category for color coding (read, write, edit, search, bash, thinking)
 */
function streamingIndicator(paneId, active, context = null, category = 'thinking') {
  const container = containers.get(paneId);
  if (!container) return;

  // ROUND-2: Map tool categories to intensity levels
  // High intensity = faster pulse, brighter glow (heavy operations)
  // Low intensity = slower pulse, gentle glow (read-only operations)
  const intensityMap = {
    'bash': 'high',      // Command execution - high stakes
    'write': 'high',     // File creation - high stakes
    'edit': 'high',      // File modification - high stakes
    'read': 'low',       // Read-only - gentle
    'search': 'low',     // Glob/Grep - gentle
    'thinking': 'medium' // Default thinking state
  };
  const intensity = intensityMap[category] || 'medium';

  let indicator = container.querySelector('.sdk-streaming');

  if (active && !indicator) {
    // Create honeycomb indicator (Hivemind branded)
    indicator = document.createElement('div');
    indicator.className = 'sdk-streaming';
    indicator.dataset.tool = category;
    indicator.dataset.intensity = intensity;  // ROUND-2: Add intensity attribute
    indicator.innerHTML = `
      ${generateHoneycombHTML()}
      <span class="sdk-streaming-context">${escapeHtml(context || 'Thinking...')}</span>
    `;
    container.appendChild(indicator);
    scrollToBottom(paneId);

    // CSS handles animation - no JS interval needed for honeycomb

  } else if (active && indicator) {
    // UX-8: Update context text and category if indicator exists (smooth transition)
    const textEl = indicator.querySelector('.sdk-streaming-context');
    if (textEl && context) {
      // Add updating class for fade transition
      textEl.classList.add('updating');
      setTimeout(() => {
        textEl.textContent = context;
        textEl.classList.remove('updating');
      }, 75);
    }
    // Update category for color change (CSS variables handle the color)
    if (category) {
      indicator.dataset.tool = category;
      indicator.dataset.intensity = intensity;  // ROUND-2: Update intensity too
    }
  } else if (!active && indicator) {
    // Clean up (CSS animation stops automatically when element removed)
    indicator.remove();
  }
}

/**
 * STR-5: Append text delta for typewriter streaming effect
 * Called when Python SDK sends partial text via StreamEvent
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @param {string} text - Partial text chunk to append
 */
function appendTextDelta(paneId, text) {
  let container = containers.get(paneId);

  // Recover container if needed
  if (!container) {
    container = document.getElementById(`sdk-messages-${paneId}`);
    if (container) {
      containers.set(paneId, container);
    }
  }

  if (!container) {
    log.warn('SDK', `appendTextDelta: No container for pane ${paneId}`);
    return;
  }

  let streamState = streamingMessages.get(paneId);

  // Create new streaming message element if needed
  if (!streamState || streamState.complete) {
    // Remove any existing streaming indicator
    streamingIndicator(paneId, false);

    // Create new streaming message element
    const msgEl = document.createElement('div');
    msgEl.className = 'sdk-msg sdk-assistant sdk-streaming-text';

    // Add timestamp
    const timestamp = document.createElement('span');
    timestamp.className = 'sdk-timestamp';
    timestamp.textContent = new Date().toLocaleTimeString();
    msgEl.appendChild(timestamp);

    // Create content container with cursor
    const contentEl = document.createElement('pre');
    contentEl.className = 'sdk-content sdk-typewriter';
    msgEl.appendChild(contentEl);

    // Add blinking cursor
    const cursor = document.createElement('span');
    cursor.className = 'sdk-cursor';
    cursor.textContent = '▌';
    contentEl.appendChild(cursor);

    container.appendChild(msgEl);

    streamState = {
      element: msgEl,
      contentEl: contentEl,
      cursor: cursor,
      buffer: '',
      complete: false
    };
    streamingMessages.set(paneId, streamState);

    scrollToBottom(paneId);
  }

  // Append new text to buffer
  streamState.buffer += text;

  // Update content (insert before cursor)
  const textNode = document.createTextNode(text);
  streamState.contentEl.insertBefore(textNode, streamState.cursor);

  // Auto-scroll as text arrives
  scrollToBottom(paneId);
}

/**
 * STR-5: Finalize streaming message (remove cursor, mark complete)
 * Called when streaming stops for a pane
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 */
function finalizeStreamingMessage(paneId) {
  const streamState = streamingMessages.get(paneId);
  if (!streamState || streamState.complete) return;

  // Remove cursor
  if (streamState.cursor && streamState.cursor.parentNode) {
    streamState.cursor.remove();
  }

  // Mark complete
  streamState.complete = true;
  streamState.element.classList.remove('sdk-streaming-text');
  streamState.element.classList.add('sdk-complete');

  log.info('SDK', `Finalized streaming message for pane ${paneId}, ${streamState.buffer.length} chars`);
}

/**
 * STR-5: Clear streaming state for a pane (on new assistant turn)
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 */
function clearStreamingState(paneId) {
  const streamState = streamingMessages.get(paneId);
  if (streamState) {
    streamState.complete = true;
    if (streamState.cursor && streamState.cursor.parentNode) {
      streamState.cursor.remove();
    }
  }
  streamingMessages.delete(paneId);
}

/**
 * UX-8: Update streaming indicator with tool context
 * Parses tool_use messages and shows friendly descriptions
 * Color-coded by tool type for visual distinction
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @param {Object} toolUse - Tool use message object
 */
function updateToolContext(paneId, toolUse) {
  const toolName = toolUse.name || toolUse.tool || 'unknown';
  const input = toolUse.input || {};

  // Map tool names to friendly descriptions and tool category
  const contextMap = {
    'Read': () => ({
      text: `Reading ${getFileName(input.file_path || input.path || 'file')}...`,
      category: 'read'
    }),
    'Write': () => ({
      text: `Writing ${getFileName(input.file_path || input.path || 'file')}...`,
      category: 'write'
    }),
    'Edit': () => ({
      text: `Editing ${getFileName(input.file_path || input.path || 'file')}...`,
      category: 'edit'
    }),
    'Glob': () => ({
      text: `Finding files: ${input.pattern || '*'}`,
      category: 'search'
    }),
    'Grep': () => ({
      text: `Searching: ${(input.pattern || 'pattern').substring(0, 20)}...`,
      category: 'search'
    }),
    'Bash': () => ({
      text: `Running ${(input.command || '').split(' ')[0] || 'command'}...`,
      category: 'bash'
    }),
    'Task': () => ({
      text: `Delegating: ${(input.description || 'task').substring(0, 25)}...`,
      category: 'thinking'
    }),
    'WebFetch': () => {
      try {
        const hostname = new URL(input.url || '').hostname;
        return { text: `Fetching ${hostname}...`, category: 'search' };
      } catch {
        return { text: 'Fetching web page...', category: 'search' };
      }
    },
    'WebSearch': () => ({
      text: `Searching: ${(input.query || 'query').substring(0, 20)}...`,
      category: 'search'
    }),
  };

  const contextFn = contextMap[toolName];
  const result = contextFn ? contextFn() : { text: `Using ${toolName}...`, category: 'thinking' };

  streamingIndicator(paneId, true, result.text, result.category);
}

/**
 * Helper to extract filename from path
 */
function getFileName(filePath) {
  return filePath.split(/[/\\]/).pop() || 'file';
}

/**
 * Get session ID for a pane (for resume capability)
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @returns {string|null} Session ID or null
 */
function getSessionId(paneId) {
  return sessionIds.get(paneId) || null;
}

/**
 * Add a system message to pane
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @param {string} text - System message text
 */
function addSystemMessage(paneId, text) {
  appendMessage(paneId, { type: 'system', content: text });
}

/**
 * Add an error message to pane
 * @param {string} paneId - Pane ID (1, 2, 4, 5)
 * @param {string} error - Error message text
 */
function addErrorMessage(paneId, error) {
  appendMessage(paneId, { error });
}

module.exports = {
  // Initialization
  initSDKPane,
  initAllSDKPanes,
  setPaneConfig,
  setSDKPaneConfig,

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

  // STR-5: Typewriter streaming effect
  appendTextDelta,
  finalizeStreamingMessage,
  clearStreamingState,

  // Session management
  getSessionId,

  // Constants
  PANE_IDS,
  PANE_ROLES
};
