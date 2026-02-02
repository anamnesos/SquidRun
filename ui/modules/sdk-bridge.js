/**
 * SDK Bridge - Multi-Session Support
 *
 * Manages 6 independent SDK sessions (one per pane/agent).
 * Each agent has its own full context window - NOT subagents.
 *
 * IPC Handlers:
 * - sdk-send-message(paneId, message) - send to specific agent
 * - sdk-subscribe(paneId) - stream responses back to renderer
 * - sdk-get-session-ids - for persistence on app close
 * - sdk-start-sessions - initialize all 6 agents
 * - sdk-stop-sessions - graceful shutdown with session ID capture
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const log = require('./logger');

// Pane configuration - role and model per pane (6-pane architecture)
const PANE_CONFIG = {
  '1': { role: 'Architect', model: 'claude' },
  '2': { role: 'Infra', model: 'codex' },
  '3': { role: 'Frontend', model: 'claude' },
  '4': { role: 'Backend', model: 'codex' },
  '5': { role: 'Analyst', model: 'gemini' },
  '6': { role: 'Reviewer', model: 'claude' },
};

// Legacy: Pane ID to role mapping (derived from PANE_CONFIG for backward compatibility)
const PANE_ROLES = Object.fromEntries(
  Object.entries(PANE_CONFIG).map(([id, config]) => [id, config.role])
);

// Reverse mapping - role to pane ID (supports multiple name variations including legacy)
const ROLE_TO_PANE = {
  'lead': '1',
  'Lead': '1',
  'LEAD': '1',
  'architect': '1',
  'Architect': '1',
  'ARCHITECT': '1',
  '1': '1',
  // Pane 2: Infra (legacy: Orchestrator)
  'infra': '2',
  'Infra': '2',
  'INFRA': '2',
  'orchestrator': '2',
  'Orchestrator': '2',
  'ORCHESTRATOR': '2',
  '2': '2',
  // Pane 3: Frontend (legacy: Worker A, Implementer A)
  'frontend': '3',
  'Frontend': '3',
  'FRONTEND': '3',
  'worker-a': '3',
  'Worker A': '3',
  'WORKER-A': '3',
  'worker_a': '3',
  'implementer-a': '3',
  'Implementer A': '3',
  'IMPLEMENTER-A': '3',
  '3': '3',
  // Pane 4: Backend (legacy: Worker B, Implementer B)
  'backend': '4',
  'Backend': '4',
  'BACKEND': '4',
  'worker-b': '4',
  'Worker B': '4',
  'WORKER-B': '4',
  'worker_b': '4',
  'implementer-b': '4',
  'Implementer B': '4',
  'IMPLEMENTER-B': '4',
  '4': '4',
  // Pane 5: Analyst (legacy: Investigator)
  'analyst': '5',
  'Analyst': '5',
  'ANALYST': '5',
  'investigator': '5',
  'Investigator': '5',
  'INVESTIGATOR': '5',
  '5': '5',
  'reviewer': '6',
  'Reviewer': '6',
  'REVIEWER': '6',
  '6': '6',
};

// Session state file for persistence
const SESSION_STATE_FILE = path.join(__dirname, '..', '..', 'session-state.json');

class SDKBridge extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.active = false;
    this.ready = false;
    this.mainWindow = null;

    // Track 6 independent sessions (derived from PANE_CONFIG)
    this.sessions = Object.fromEntries(
      Object.entries(PANE_CONFIG).map(([id, config]) => [
        id,
        { id: null, role: config.role, model: config.model, status: 'idle' },
      ])
    );

    // Subscribers for streaming responses
    this.subscribers = new Set(['1', '2', '3', '4', '5', '6']); // All panes subscribed by default

    // Message queue for when process isn't ready
    this.pendingMessages = [];

    // Buffer for incomplete JSON lines
    this.buffer = '';
  }

  /**
   * Set the main window for IPC communication
   */
  setMainWindow(win) {
    this.mainWindow = win;
  }

  /**
   * Send IPC event to renderer (only to subscribed panes)
   */
  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // For pane-specific messages, check subscription
      if (data && data.paneId && !this.subscribers.has(data.paneId)) {
        return; // Skip if pane not subscribed
      }
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Load saved session IDs from disk
   * Format: { "sdk_sessions": { "1": "sessionId", ... } }
   * Compatible with Python SDK manager format
   */
  loadSessionState() {
    try {
      if (fs.existsSync(SESSION_STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf8'));
        // Use nested sdk_sessions key (matches Python format)
        const sessions = data.sdk_sessions || data; // Fallback to flat format for migration
        for (const [paneId, sessionId] of Object.entries(sessions)) {
          if (this.sessions[paneId] && sessionId) {
            this.sessions[paneId].id = sessionId;
            log.info('SDK Bridge', `Loaded session for pane ${paneId}: ${sessionId}`);
          }
        }
        return true;
      }
    } catch (err) {
      log.error('SDK Bridge', 'Failed to load session state', err);
    }
    return false;
  }

  /**
   * Save session IDs to disk for persistence
   * Format: { "sdk_sessions": { "1": "sessionId", ... } }
   * Compatible with Python SDK manager format
   */
  saveSessionState() {
    try {
      // Load existing file to preserve other data (like Python does)
      let existing = {};
      if (fs.existsSync(SESSION_STATE_FILE)) {
        try {
          existing = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf8'));
        } catch (_e) {
          // File corrupted, start fresh
          existing = {};
        }
      }

      // Build sessions object
      const sessions = {};
      for (const [paneId, session] of Object.entries(this.sessions)) {
        if (session.id) {
          sessions[paneId] = session.id;
        }
      }

      // Use nested sdk_sessions key (matches Python format)
      existing.sdk_sessions = sessions;

      fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(existing, null, 2));
      log.info('SDK Bridge', 'Saved session state:', sessions);
      return true;
    } catch (err) {
      log.error('SDK Bridge', 'Failed to save session state', err);
      return false;
    }
  }

  /**
   * Start the Python SDK manager process
   * @param {object} options - { workspace: string }
   */
  startProcess(options = {}) {
    if (this.process && this.active) {
      log.info('SDK Bridge', 'Process already running');
      return this.process;
    }

    // Try to load existing session state
    this.loadSessionState();

    const sdkPath = path.join(__dirname, '..', '..', 'hivemind-sdk-v2.py');
    const args = [sdkPath, '--ipc'];  // Must pass --ipc for JSON protocol

    if (options.workspace) {
      args.push('--workspace', options.workspace);
    }

    // Use py launcher with specific version on Windows
    // Python 3.12 is the most stable for asyncio on Windows
    const pythonCmd = process.platform === 'win32' ? 'py' : 'python';
    const pythonArgs = process.platform === 'win32' ? ['-3.12', ...args] : args;

    log.info('SDK Bridge', `Starting V2 process: ${pythonCmd} ${pythonArgs.join(' ')}`);

    this.process = spawn(pythonCmd, pythonArgs, {
      cwd: options.workspace || process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',  // Force UTF-8 encoding for Python I/O
      },
    });

    this.active = true;
    this.buffer = '';

    // Handle stdout (JSON messages from Python)
    // IMPORTANT: Specify 'utf8' encoding to handle emojis and special characters
    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString('utf8');

      // Process complete lines (each line is a JSON message)
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handlePythonMessage(line);
        }
      }
    });

    // Handle stderr (errors and debug output)
    this.process.stderr.on('data', (data) => {
      const errorText = data.toString('utf8');
      log.error('SDK Bridge', 'Python stderr:', errorText);

      // Parse for pane-specific errors
      const paneMatch = errorText.match(/\[Pane (\d)\]/);
      const paneId = paneMatch ? paneMatch[1] : '1';

      this.sendToRenderer('sdk-error', {
        paneId,
        error: errorText,
      });
    });

    // Handle process exit
    this.process.on('close', (code) => {
      log.info('SDK Bridge', `Process exited with code: ${code}`);
      this.active = false;
    this.ready = false;

      // Mark all sessions as stopped
      for (const paneId of Object.keys(this.sessions)) {
        this.sessions[paneId].status = 'stopped';
        this.sendToRenderer('sdk-streaming', { paneId, active: false });
        this.sendToRenderer('sdk-status-changed', {
          paneId,
          status: 'stopped',
          sessionId: this.sessions[paneId].id,
        });
      }

      this.sendToRenderer('sdk-session-end', { code });
      this.emit('close', code);
    });

    this.process.on('error', (err) => {
      log.error('SDK Bridge', 'Process error', err);
      this.active = false;
      this.ready = false;
      this.sendToRenderer('sdk-error', { paneId: '1', error: err.message });
    });

    // NOTE: Don't flush pending messages here - wait for "ready" signal from Python
    // This prevents race condition where messages are sent before agents are initialized

    // Send ping after short delay to get ready signal
    // This handles case where JS missed the initial ready signal
    setTimeout(() => {
      if (this.process && this.active && !this.ready) {
        log.info('SDK Bridge', 'Sending ping to get ready signal');
        this.process.stdin.write(JSON.stringify({ command: 'ping' }) + '\n');
      }
    }, 2000);

    return this.process;
  }

  /**
   * Get model type for a pane
   * @param {string} paneId - Pane ID ('1' through '6')
   * @returns {string} Model type ('claude', 'codex', or 'gemini')
   */
  getModelForPane(paneId) {
    const config = PANE_CONFIG[paneId];
    return config ? config.model : 'claude'; // Default to claude
  }

  /**
   * Send message to specific pane/agent
   * @param {string} paneId - Target pane ('1', '2', '3', '4', '5', '6')
   * @param {string} message - User message
   */
  sendMessage(paneId, message) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;

    if (!this.sessions[normalizedPaneId]) {
      log.error('SDK Bridge', `Unknown pane: ${paneId}`);
      return false;
    }

    // Use Python's expected key names (command, pane_id, session_id, model)
    const cmd = {
      command: 'send',
      pane_id: normalizedPaneId,
      message: message,
      session_id: this.sessions[normalizedPaneId].id, // Include for resume
      model: this.getModelForPane(normalizedPaneId),  // Model type for routing
    };

    const sent = this.sendToProcess(cmd);

    // Emit delivery confirmation for UI feedback
    if (sent) {
      this.sendToRenderer('sdk-message-delivered', { paneId: normalizedPaneId });
    }

    return sent;
  }

  /**
   * Subscribe to responses from a pane
   * @param {string} paneId - Pane to subscribe to
   */
  subscribe(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    this.subscribers.add(normalizedPaneId);
    log.info('SDK Bridge', `Subscribed to pane ${normalizedPaneId}`);
    return true;
  }

  /**
   * Unsubscribe from a pane's responses
   * @param {string} paneId - Pane to unsubscribe from
   */
  unsubscribe(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    this.subscribers.delete(normalizedPaneId);
    log.info('SDK Bridge', `Unsubscribed from pane ${normalizedPaneId}`);
    return true;
  }

  /**
   * Get all session IDs for persistence
   */
  getSessionIds() {
    const ids = {};
    for (const [paneId, session] of Object.entries(this.sessions)) {
      ids[paneId] = {
        sessionId: session.id,
        role: session.role,
        status: session.status,
      };
    }
    return ids;
  }

  /**
   * Initialize all 6 agent sessions
   * Note: Python auto-starts all sessions in start_all() on process launch.
   * No init-sessions command needed - just start the process.
   * @param {object} options - { workspace: string, resumeIds: { paneId: sessionId } }
   */
  async startSessions(options = {}) {
    // Apply any provided resume IDs before starting
    if (options.resumeIds) {
      for (const [paneId, sessionId] of Object.entries(options.resumeIds)) {
        if (this.sessions[paneId]) {
          this.sessions[paneId].id = sessionId;
        }
      }
    }

    // Start the Python process if not running
    // Python auto-starts all 6 sessions via manager.start_all()
    if (!this.active) {
      this.startProcess(options);
    }

    // Notify UI that sessions are starting
    this.sendToRenderer('sdk-session-start', { panes: Object.keys(this.sessions) });

    return true;
  }

  /**
   * Send command to Python process
   */
  sendToProcess(command) {
    // Queue if process not running
    if (!this.process || !this.active) {
      log.info('SDK Bridge', 'Process not running, queueing message');
      this.pendingMessages.push(command);
      return false;
    }

    // Queue if agents not yet ready (prevents race condition)
    if (!this.ready) {
      log.info('SDK Bridge', 'Agents not ready, queueing message');
      this.pendingMessages.push(command);
      return false;
    }

    const json = JSON.stringify(command);
    log.info('SDK Bridge', `Sending to Python: ${json}`);
    this.process.stdin.write(json + '\n');
    return true;
  }

  /**
   * Flush pending messages after process starts
   */
  flushPendingMessages() {
    if (this.pendingMessages.length > 0) {
      log.info('SDK Bridge', `Flushing ${this.pendingMessages.length} pending messages`);
      for (const msg of this.pendingMessages) {
        this.sendToProcess(msg);
      }
      this.pendingMessages = [];
    }
  }

  /**
   * Handle JSON message from Python process
   */
  handlePythonMessage(line) {
    try {
      const msg = JSON.parse(line);
      this.routeMessage(msg);
    } catch (_err) {
      // Not JSON - log as debug output
      log.info('SDK Bridge', `Python output: ${line}`);
    }
  }

  /**
   * Route message from Python to appropriate renderer handler
   * Note: Python sends snake_case keys (pane_id, session_id, role)
   * We check both for compatibility
   */
  routeMessage(msg) {
    // Python sends 'role', check both 'agent' and 'role' in ROLE_TO_PANE
    // Also check both snake_case (pane_id) and camelCase (paneId)
    const paneId = ROLE_TO_PANE[msg.agent] || ROLE_TO_PANE[msg.role] || msg.pane_id || msg.paneId || '1';

    // Update session state if message contains session info
    // Check both snake_case (session_id) and camelCase (sessionId)
    const sessionId = msg.session_id || msg.sessionId;
    if (sessionId && this.sessions[paneId]) {
      this.sessions[paneId].id = sessionId;
    }

    // Update status based on message type
    // Handle both: JS-style "streaming" with active:bool AND Python-style "status" with state:string
    if (msg.type === 'streaming' && this.sessions[paneId]) {
      this.sessions[paneId].status = msg.active ? 'active' : 'idle';
      this.sendToRenderer('sdk-status-changed', {
        paneId,
        status: this.sessions[paneId].status,
        sessionId: this.sessions[paneId].id,
      });
    } else if (msg.type === 'status' && this.sessions[paneId]) {
      // Python sends status messages with state: "thinking", "idle", "connected", "disconnected"
      const stateToStatus = {
        'thinking': 'active',
        'connected': 'ready',
        'disconnected': 'stopped',
        'idle': 'idle',
      };
      const newStatus = stateToStatus[msg.state] || msg.state;
      this.sessions[paneId].status = newStatus;
      this.sendToRenderer('sdk-status-changed', {
        paneId,
        status: newStatus,
        sessionId: this.sessions[paneId].id,
      });
      // Also emit streaming event for active/idle states
      if (msg.state === 'thinking') {
        this.sendToRenderer('sdk-streaming', { paneId, active: true });
      } else if (msg.state === 'idle') {
        this.sendToRenderer('sdk-streaming', { paneId, active: false });
      }
    }

    // Route to renderer based on message type
    switch (msg.type) {
      case 'session-init':
        // Session initialized with ID (check both snake_case and camelCase)
        const initSessionId = msg.session_id || msg.sessionId;
        if (this.sessions[paneId]) {
          this.sessions[paneId].id = initSessionId;
          this.sessions[paneId].status = 'ready';
          this.sendToRenderer('sdk-status-changed', {
            paneId,
            status: 'ready',
            sessionId: initSessionId,
          });
        }
        this.sendToRenderer('sdk-message', {
          paneId,
          message: { type: 'system', subtype: 'session', content: `Session ready: ${initSessionId}` },
        });
        break;

      case 'assistant':
      case 'text':
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'tool_use':
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'tool_result':
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'streaming':
        this.sendToRenderer('sdk-streaming', { paneId, active: msg.active });
        break;

      case 'status':
        // Handled above in status update block, but also pass through for UI display
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'system':
        // SystemMessage from SDK - may contain session info
        if (msg.data && msg.data.session_id && this.sessions[paneId]) {
          this.sessions[paneId].id = msg.data.session_id;
        }
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'user':
        // UserMessage echo from Python - suppress to avoid duplication
        // (daemon-handlers.js already displays user message immediately when sent)
        log.info('SDK Bridge', `User echo for pane ${paneId} (suppressed - already displayed)`);
        break;

      case 'thinking':
        // ThinkingBlock content
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'text_delta':
        // STR-3: Real-time text streaming for typewriter effect
        // Forward to renderer for incremental display
        this.sendToRenderer('sdk-text-delta', {
          paneId,
          text: msg.text,
        });
        break;

      case 'thinking_delta':
        // Extended thinking streaming (optional - for future use)
        this.sendToRenderer('sdk-thinking-delta', {
          paneId,
          thinking: msg.thinking,
        });
        break;

      case 'result':
        // Agent completed - capture session ID (check both snake_case and camelCase)
        const resultSessionId = msg.session_id || msg.sessionId;
        if (resultSessionId && this.sessions[paneId]) {
          this.sessions[paneId].id = resultSessionId;
          this.sessions[paneId].status = 'idle';
          this.sendToRenderer('sdk-status-changed', {
            paneId,
            status: 'idle',
            sessionId: resultSessionId,
          });
        }
        this.sendToRenderer('sdk-streaming', { paneId, active: false });
        this.sendToRenderer('sdk-message', { paneId, message: msg });
        break;

      case 'error':
        this.sendToRenderer('sdk-error', { paneId, error: msg.error || msg.content || msg.message });
        break;

      case 'ready':
        // Python has initialized all agents - now safe to send messages
        log.info('SDK Bridge', 'Received ready signal, agents:', msg.agents);
        this.ready = true;
        this.flushPendingMessages();
        this.sendToRenderer('sdk-ready', { agents: msg.agents });
        break;

      case 'agent_started':
        // Individual agent started
        this.sendToRenderer('sdk-agent-started', {
          paneId: msg.pane_id || paneId,
          role: msg.role,
          resumed: msg.resumed,
        });
        break;

      case 'warning':
        log.warn('SDK Bridge', msg.message);
        this.sendToRenderer('sdk-warning', { paneId, message: msg.message });
        break;

      case 'message_received':
        // Acknowledgment that Python received the message - don't clutter UI
        log.info('SDK Bridge', `Message received by pane ${paneId}`);
        break;

      case 'all_stopped':
        // All agents stopped - internal event, don't show raw JSON to user
        log.info('SDK Bridge', 'All agents stopped, sessions saved:', msg.sessions_saved);
        this.emit('sessions-stopped', this.getSessionIds());
        break;

      case 'sessions':
        // Response to get_sessions command - internal, just log
        log.info('SDK Bridge', 'Sessions:', msg.sessions);
        this.emit('sessions-list', msg.sessions);
        break;

      default:
        // Pass through unknown types
        this.sendToRenderer('sdk-message', { paneId, message: msg });
    }
  }

  /**
   * Stop all sessions gracefully
   * Captures session IDs before stopping for persistence
   */
  async stopSessions() {
    if (!this.process || !this.active) {
      return this.getSessionIds();
    }

    // Tell Python to stop all sessions and return final IDs
    const cmd = { command: 'stop' };
    this.sendToProcess(cmd);

    // Save session state before stopping
    this.saveSessionState();

    // Give Python time to respond, then force kill if needed
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.forceStop();
        resolve(this.getSessionIds());
      }, 5000);

      this.once('sessions-stopped', (ids) => {
        clearTimeout(timeout);
        resolve(ids);
      });
    });
  }

  /**
   * Force stop the process
   */
  forceStop() {
    if (this.process) {
      log.info('SDK Bridge', 'Force stopping process');
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.active = false;
    this.ready = false;

    // Mark all sessions as stopped
    for (const paneId of Object.keys(this.sessions)) {
      this.sessions[paneId].status = 'stopped';
      this.sendToRenderer('sdk-status-changed', {
        paneId,
        status: 'stopped',
        sessionId: this.sessions[paneId].id,
      });
    }
  }

  /**
   * Stop the SDK process (legacy compatibility)
   */
  stop() {
    this.saveSessionState();
    this.forceStop();
  }

  /**
   * Send input to running SDK process (legacy compatibility)
   */
  write(input) {
    if (this.process && this.active) {
      this.process.stdin.write(input + '\n');
    }
  }

  /**
   * Check if SDK is active
   */
  isActive() {
    return this.active;
  }

  /**
   * Get all sessions (legacy compatibility)
   */
  getSessions() {
    return this.getSessionIds();
  }

  /**
   * Get status of a specific pane
   */
  getPaneStatus(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    return this.sessions[normalizedPaneId] || null;
  }

  /**
   * Broadcast message to all panes (TRUE PARALLELISM via Python asyncio.gather)
   * @param {string} message - Message to broadcast
   * @param {string[]} exclude - Pane IDs to exclude (optional)
   */
  broadcast(message, exclude = []) {
    const cmd = {
      command: 'broadcast',
      message: message,
      exclude: exclude,
    };
    return this.sendToProcess(cmd);
  }

  /**
   * Interrupt a specific agent
   */
  interrupt(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    // Use Python's expected key names
    const cmd = {
      command: 'interrupt',
      pane_id: normalizedPaneId,
    };
    return this.sendToProcess(cmd);
  }

  // ========== Legacy V1 support (for backward compatibility) ==========

  /**
   * Legacy: Start with a prompt (V1 style)
   * Routes to Lead pane in V2
   */
  start(prompt, options = {}) {
    if (!this.active) {
      this.startProcess(options);
    }

    // Send to Lead - sendMessage queues if not ready, no setTimeout needed
    this.sendMessage('1', prompt);

    return this.process;
  }
}

// Singleton instance
let sdkBridge = null;

function getSDKBridge() {
  if (!sdkBridge) {
    sdkBridge = new SDKBridge();
  }
  return sdkBridge;
}

module.exports = {
  SDKBridge,
  getSDKBridge,
  PANE_CONFIG,
  PANE_ROLES,
  ROLE_TO_PANE,
  SESSION_STATE_FILE,
};
