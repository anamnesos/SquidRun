/**
 * SDK Bridge V2 - Multi-Session Support
 *
 * Manages 4 independent SDK sessions (one per pane/agent).
 * Each agent has its own full context window - NOT subagents.
 *
 * IPC Handlers:
 * - sdk-send-message(paneId, message) - send to specific agent
 * - sdk-subscribe(paneId) - stream responses back to renderer
 * - sdk-get-session-ids - for persistence on app close
 * - sdk-start-sessions - initialize all 4 agents
 * - sdk-stop-sessions - graceful shutdown with session ID capture
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// Pane ID to role mapping
const PANE_ROLES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
};

// Reverse mapping - role to pane ID (supports multiple name variations)
const ROLE_TO_PANE = {
  'lead': '1',
  'Lead': '1',
  'LEAD': '1',
  '1': '1',
  'worker-a': '2',
  'Worker A': '2',
  'WORKER-A': '2',
  'worker_a': '2',
  'workerA': '2',
  'WorkerA': '2',
  '2': '2',
  'worker-b': '3',
  'Worker B': '3',
  'WORKER-B': '3',
  'worker_b': '3',
  'workerB': '3',
  'WorkerB': '3',
  '3': '3',
  'reviewer': '4',
  'Reviewer': '4',
  'REVIEWER': '4',
  '4': '4',
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

    // V2: Track 4 independent sessions
    this.sessions = {
      '1': { id: null, role: 'Lead', status: 'idle' },
      '2': { id: null, role: 'Worker A', status: 'idle' },
      '3': { id: null, role: 'Worker B', status: 'idle' },
      '4': { id: null, role: 'Reviewer', status: 'idle' },
    };

    // Subscribers for streaming responses
    this.subscribers = new Set(['1', '2', '3', '4']); // All panes subscribed by default

    // Message queue for when process isn't ready
    this.pendingMessages = [];

    // Buffer for incomplete JSON lines
    this.buffer = '';

    // Track if Python has sent "ready" message (all agents initialized)
    this.ready = false;
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
        // V2 FIX: Use nested sdk_sessions key (matches Python format)
        const sessions = data.sdk_sessions || data; // Fallback to flat format for migration
        for (const [paneId, sessionId] of Object.entries(sessions)) {
          if (this.sessions[paneId] && sessionId) {
            this.sessions[paneId].id = sessionId;
            console.log(`[SDK Bridge] Loaded session for pane ${paneId}: ${sessionId}`);
          }
        }
        return true;
      }
    } catch (err) {
      console.error('[SDK Bridge] Failed to load session state:', err);
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

      // V2 FIX: Use nested sdk_sessions key (matches Python format)
      existing.sdk_sessions = sessions;

      fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(existing, null, 2));
      console.log('[SDK Bridge] Saved session state:', sessions);
      return true;
    } catch (err) {
      console.error('[SDK Bridge] Failed to save session state:', err);
      return false;
    }
  }

  /**
   * Start the Python SDK manager process
   * @param {object} options - { workspace: string }
   */
  startProcess(options = {}) {
    if (this.process && this.active) {
      console.log('[SDK Bridge] Process already running');
      return this.process;
    }

    // Try to load existing session state
    this.loadSessionState();

    const sdkPath = path.join(__dirname, '..', '..', 'hivemind-sdk-v2.py');
    const args = [sdkPath, '--ipc'];  // V2 FIX: Must pass --ipc for JSON protocol

    if (options.workspace) {
      args.push('--workspace', options.workspace);
    }

    // Use py launcher with specific version on Windows
    // Python 3.12 is the most stable for asyncio on Windows
    const pythonCmd = process.platform === 'win32' ? 'py' : 'python';
    const pythonArgs = process.platform === 'win32' ? ['-3.12', ...args] : args;

    console.log('[SDK Bridge] Starting V2 process:', pythonCmd, pythonArgs.join(' '));

    this.process = spawn(pythonCmd, pythonArgs, {
      cwd: options.workspace || process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.active = true;
    this.buffer = '';

    // Handle stdout (JSON messages from Python)
    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString();

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
      const errorText = data.toString();
      console.error('[SDK Bridge] Python stderr:', errorText);

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
      console.log('[SDK Bridge] Process exited with code:', code);
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
      console.error('[SDK Bridge] Process error:', err);
      this.active = false;
      this.ready = false;
      this.sendToRenderer('sdk-error', { paneId: '1', error: err.message });
    });

    // NOTE: Don't flush pending messages here - wait for "ready" signal from Python
    // This prevents race condition where messages are sent before agents are initialized

    // V2 FIX: Send ping after short delay to get ready signal
    // This handles case where JS missed the initial ready signal
    setTimeout(() => {
      if (this.process && this.active && !this.ready) {
        console.log('[SDK Bridge] Sending ping to get ready signal');
        this.process.stdin.write(JSON.stringify({ command: 'ping' }) + '\n');
      }
    }, 2000);

    return this.process;
  }

  /**
   * V2: Send message to specific pane/agent
   * @param {string} paneId - Target pane ('1', '2', '3', '4')
   * @param {string} message - User message
   */
  sendMessage(paneId, message) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;

    if (!this.sessions[normalizedPaneId]) {
      console.error(`[SDK Bridge] Unknown pane: ${paneId}`);
      return false;
    }

    // V2 FIX: Use Python's expected key names (command, pane_id, session_id)
    const cmd = {
      command: 'send',
      pane_id: normalizedPaneId,
      message: message,
      session_id: this.sessions[normalizedPaneId].id, // Include for resume
    };

    const sent = this.sendToProcess(cmd);

    // Emit delivery confirmation for UI feedback
    if (sent) {
      this.sendToRenderer('sdk-message-delivered', { paneId: normalizedPaneId });
    }

    return sent;
  }

  /**
   * V2: Subscribe to responses from a pane
   * @param {string} paneId - Pane to subscribe to
   */
  subscribe(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    this.subscribers.add(normalizedPaneId);
    console.log(`[SDK Bridge] Subscribed to pane ${normalizedPaneId}`);
    return true;
  }

  /**
   * V2: Unsubscribe from a pane's responses
   * @param {string} paneId - Pane to unsubscribe from
   */
  unsubscribe(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    this.subscribers.delete(normalizedPaneId);
    console.log(`[SDK Bridge] Unsubscribed from pane ${normalizedPaneId}`);
    return true;
  }

  /**
   * V2: Get all session IDs for persistence
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
   * V2: Initialize all 4 agent sessions
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
    // Python auto-starts all 4 sessions via manager.start_all()
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
      console.log('[SDK Bridge] Process not running, queueing message');
      this.pendingMessages.push(command);
      return false;
    }

    // Queue if agents not yet ready (prevents race condition)
    if (!this.ready) {
      console.log('[SDK Bridge] Agents not ready, queueing message');
      this.pendingMessages.push(command);
      return false;
    }

    const json = JSON.stringify(command);
    console.log('[SDK Bridge] Sending to Python:', json);
    this.process.stdin.write(json + '\n');
    return true;
  }

  /**
   * Flush pending messages after process starts
   */
  flushPendingMessages() {
    if (this.pendingMessages.length > 0) {
      console.log(`[SDK Bridge] Flushing ${this.pendingMessages.length} pending messages`);
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
      console.log('[SDK Bridge] Python output:', line);
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
        console.log(`[SDK Bridge] User echo for pane ${paneId} (suppressed - already displayed)`);
        break;

      case 'thinking':
        // ThinkingBlock content
        this.sendToRenderer('sdk-message', { paneId, message: msg });
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
        console.log('[SDK Bridge] Received ready signal, agents:', msg.agents);
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
        console.warn('[SDK Bridge] Warning:', msg.message);
        this.sendToRenderer('sdk-warning', { paneId, message: msg.message });
        break;

      case 'message_received':
        // Acknowledgment that Python received the message - don't clutter UI
        console.log(`[SDK Bridge] Message received by pane ${paneId}`);
        break;

      case 'all_stopped':
        // All agents stopped - internal event, don't show raw JSON to user
        console.log('[SDK Bridge] All agents stopped, sessions saved:', msg.sessions_saved);
        this.emit('sessions-stopped', this.getSessionIds());
        break;

      case 'ready':
        // IPC server ready - internal event, don't show to user
        console.log('[SDK Bridge] Python ready, agents:', msg.agents);
        this.emit('python-ready', msg.agents);
        break;

      case 'sessions':
        // Response to get_sessions command - internal, just log
        console.log('[SDK Bridge] Sessions:', msg.sessions);
        this.emit('sessions-list', msg.sessions);
        break;

      default:
        // Pass through unknown types
        this.sendToRenderer('sdk-message', { paneId, message: msg });
    }
  }

  /**
   * V2: Stop all sessions gracefully
   * Captures session IDs before stopping for persistence
   */
  async stopSessions() {
    if (!this.process || !this.active) {
      return this.getSessionIds();
    }

    // Tell Python to stop all sessions and return final IDs
    // V2 FIX: Use Python's expected key name
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
      console.log('[SDK Bridge] Force stopping process');
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
   * V2: Get status of a specific pane
   */
  getPaneStatus(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    return this.sessions[normalizedPaneId] || null;
  }

  /**
   * V2: Broadcast message to all panes (TRUE PARALLELISM via Python asyncio.gather)
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
   * V2: Interrupt a specific agent
   */
  interrupt(paneId) {
    const normalizedPaneId = ROLE_TO_PANE[paneId] || paneId;
    // V2 FIX: Use Python's expected key names
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
  PANE_ROLES,
  ROLE_TO_PANE,
  SESSION_STATE_FILE,
};
