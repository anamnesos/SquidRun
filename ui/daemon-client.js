/**
 * Daemon Client - Client library for connecting to the terminal daemon
 *
 * Used by Electron main.js to communicate with the terminal daemon.
 * Handles connection, reconnection, and message routing.
 */

const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const log = require('./modules/logger');
const { PANE_ROLES, resolveCoordPath } = require('./config');

// Named pipe path (Windows) or Unix socket
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\squidrun-terminal'
  : '/tmp/squidrun-terminal.sock';

// In packaged builds, __dirname points inside app.asar which can't be spawned.
// Resolve to the unpacked copy so child_process.spawn works.
const ASAR_UNPACKED_DIR = __dirname.replace('app.asar', 'app.asar.unpacked');
const DAEMON_SCRIPT = path.join(ASAR_UNPACKED_DIR, 'terminal-daemon.js');
const DAEMON_PID_FILE = resolveCoordPath('runtime/daemon.pid', { forWrite: true });

class DaemonClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.connectPromise = null;
    this.spawnedDuringLastConnect = false;
    this.buffer = '';
    this.reconnecting = false;
    this.terminals = new Map(); // Cache of known terminals
    this.lastActivity = new Map(); // Track last activity time per pane
    this.pendingWriteAcks = new Map(); // requestEventId -> { resolve, timer }
    this.writeAckSeq = 0;
  }

  /**
   * Connect to the daemon, spawning it if necessary
   * @returns {Promise<boolean>} true if connected
   */
  async connect() {
    if (this.connected && this.client && !this.client.destroyed) {
      this.spawnedDuringLastConnect = false;
      return true;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this._connectInternal();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _connectInternal() {
    this.spawnedDuringLastConnect = false;

    // Try to connect first
    const connected = await this._tryConnect();
    if (connected) {
      log.info('DaemonClient', 'Connected to existing daemon');
      return true;
    }

    // Daemon not running, spawn it
    log.info('DaemonClient', 'Daemon not running, spawning...');
    await this._spawnDaemon();

    // Wait a bit for daemon to start
    await this._sleep(500);

    // Try to connect again
    const retryConnected = await this._tryConnect();
    if (retryConnected) {
      this.spawnedDuringLastConnect = true;
      log.info('DaemonClient', 'Connected to newly spawned daemon');
      return true;
    }

    log.error('DaemonClient', 'Failed to connect to daemon after spawn');
    this.spawnedDuringLastConnect = false;
    return false;
  }

  /**
   * Try to connect to the daemon
   * @returns {Promise<boolean>}
   */
  _tryConnect() {
    return new Promise((resolve) => {
      const client = net.createConnection(PIPE_PATH);
      let settled = false;
      let timeout = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
      };

      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.client && this.client !== client) {
          this._teardownSocket(this.client);
        }
        this.client = client;
        this.connected = true;
        this._setupClient(client);
        resolve(true);
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this._teardownSocket(client);
        resolve(false);
      };

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this._teardownSocket(client);
        resolve(false);
      }, 2000);

      client.on('connect', onConnect);
      client.on('error', onError);
    });
  }

  _teardownSocket(socket) {
    if (!socket) return;
    try {
      if (typeof socket.removeAllListeners === 'function') {
        socket.removeAllListeners();
      }
    } catch {
      // Ignore listener cleanup failures during reconnect churn.
    }
    try {
      if (!socket.destroyed && typeof socket.destroy === 'function') {
        socket.destroy();
      }
    } catch {
      // Ignore teardown failures; reconnect path will recover.
    }
  }

  /**
   * Setup client event handlers
   */
  _setupClient(socket = this.client) {
    this.buffer = '';

    socket.on('data', (data) => {
      if (socket !== this.client) return;
      this.buffer += data.toString();

      // Process complete messages (newline-delimited)
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this._handleMessage(line.trim());
        }
      }
    });

    socket.on('close', () => {
      if (socket !== this.client) return;
      log.warn('DaemonClient', 'Connection closed');
      this.connected = false;
      this.client = null;
      this._rejectPendingWriteAcks('daemon_disconnected');
      this.emit('disconnected');

      // Attempt reconnect
      if (!this.reconnecting) {
        this._attemptReconnect();
      }
    });

    socket.on('error', (err) => {
      if (socket !== this.client) return;
      log.error('DaemonClient', 'Connection error', err.message);
      this.connected = false;
      this._rejectPendingWriteAcks('daemon_connection_error');
    });
  }

  /**
   * Handle incoming message from daemon
   */
  _handleMessage(message) {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'connected':
          // Initial connection, cache terminal list
          this.terminals.clear();
          for (const term of msg.terminals || []) {
            this.terminals.set(term.paneId, term);
          }
          this.emit('connected', msg.terminals);
          break;

        case 'data':
          this.lastActivity.set(msg.paneId, Date.now()); // Track activity
          try {
            this.emit('data', msg.paneId, msg.data);
          } catch (err) {
            log.warn('DaemonClient', `Data listener error for pane ${msg.paneId}: ${err.message}`);
          }
          break;

        case 'exit':
          this.emit('exit', msg.paneId, msg.code);
          if (this.terminals.has(msg.paneId)) {
            this.terminals.get(msg.paneId).alive = false;
          }
          break;

        case 'spawned':
          this.terminals.set(msg.paneId, {
            paneId: msg.paneId,
            pid: msg.pid,
            alive: true,
            dryRun: msg.dryRun || false,
          });
          this.emit('spawned', msg.paneId, msg.pid, msg.dryRun || false);
          break;

        case 'list':
          this.terminals.clear();
          for (const term of msg.terminals || []) {
            this.terminals.set(term.paneId, term);
          }
          this.emit('list', msg.terminals);
          break;

        case 'attached':
          // U1: Include scrollback in attached event
          this.emit('attached', msg.paneId, msg.pid, msg.alive, msg.scrollback);
          break;

        case 'killed':
          this.terminals.delete(msg.paneId);
          this.emit('killed', msg.paneId);
          break;

        case 'error':
          this.emit('error', msg.paneId, msg.message);
          break;

        case 'pong':
          this.emit('pong');
          break;

        // D3: Handle graceful shutdown notification from daemon
        case 'shutdown':
          log.warn('DaemonClient', 'Daemon is shutting down', msg.message);
          this.emit('shutdown', msg.message, msg.timestamp);
          // Don't attempt reconnect - daemon is intentionally shutting down
          this.reconnecting = true; // Prevent auto-reconnect
          break;

        // D2: Handle health check response
        case 'health':
          this.emit('health', msg);
          break;

        // Handle heartbeat state changes
        case 'heartbeat-state-changed':
          this.emit('heartbeat-state-changed', msg.state, msg.interval, msg.timestamp);
          break;

        // Handle heartbeat status response
        case 'heartbeat-status':
          this.emit('heartbeat-status', msg);
          break;

        // ID-1: Handle identity injection response
        case 'identity-injected':
          this.emit('identity-injected', msg.paneId, msg.role, msg.message);
          break;

        // Handle watchdog alert
        case 'watchdog-alert':
          this.emit('watchdog-alert', msg.message, msg.timestamp);
          break;

        case 'agent-stuck-detected':
          this.emit('agent-stuck-detected', msg);
          break;

        case 'agent-stuck-alert':
          this.emit('agent-stuck-alert', msg);
          break;

        // Handle Codex exec activity state changes
        case 'codex-activity':
          this.emit('codex-activity', msg.paneId, msg.state, msg.detail);
          break;

        // Event Kernel: daemon-side event envelope
        case 'kernel-event':
          this.emit('kernel-event', msg.eventData || null);
          if (msg.eventData?.type === 'daemon.write.ack') {
            const requestEventId = msg.eventData?.payload?.requestedByEventId;
            if (requestEventId) {
              const pending = this.pendingWriteAcks.get(requestEventId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingWriteAcks.delete(requestEventId);
                pending.resolve({
                  success: true,
                  requestEventId,
                  eventData: msg.eventData,
                  status: msg.eventData?.payload?.status,
                });
              }
            }
            this.emit('write-ack', msg.eventData);
          }
          break;

        // Event Kernel: daemon-side diagnostics
        case 'kernel-stats':
          this.emit('kernel-stats', msg.stats || {});
          break;

        default:
          log.warn('DaemonClient', 'Unknown event', msg.event);
      }
    } catch (err) {
      log.error('DaemonClient', 'Error parsing message', err.message);
    }
  }

  /**
   * Attempt to reconnect to daemon
   */
  async _attemptReconnect() {
    if (this.reconnecting) return;
    if (this.connected && this.client && !this.client.destroyed) return;
    this.reconnecting = true;

    log.info('DaemonClient', 'Attempting to reconnect...');

    for (let i = 0; i < 5; i++) {
      await this._sleep(1000);
      const connected = await this._tryConnect();
      if (connected) {
        log.info('DaemonClient', 'Reconnected successfully');
        this.reconnecting = false;
        this.emit('reconnected');
        return;
      }
    }

    log.error('DaemonClient', 'Failed to reconnect after 5 attempts');
    this.reconnecting = false;
    this.emit('reconnect-failed');
  }

  _resolveNodeBinary() {
    if (os.platform() !== 'darwin') return 'node';

    const candidates = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/opt/local/bin/node',
    ];

    try {
      const home = os.homedir();
      // NVM default
      const nvmDefaultAlias = path.join(home, '.nvm', 'alias', 'default');
      if (fs.existsSync(nvmDefaultAlias)) {
        const version = fs.readFileSync(nvmDefaultAlias, 'utf8').trim();
        if (version) {
          candidates.unshift(path.join(home, '.nvm', 'versions', 'node', version, 'bin', 'node'));
        }
      }
      // N/Volta/fnm
      candidates.unshift(path.join(home, '.volta', 'bin', 'node'));
      candidates.unshift(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'));
    } catch (err) {
      // Ignore homedir access errors
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    return 'node';
  }

  /**
   * Spawn the daemon process (detached)
   */
  async _spawnDaemon() {
    return new Promise((resolve) => {
      const nodeBin = this._resolveNodeBinary();
      log.info('DaemonClient', `Spawning daemon with ${nodeBin}`, DAEMON_SCRIPT);

      // Spawn as detached process so it survives parent exit
      const daemon = spawn(nodeBin, [DAEMON_SCRIPT], {
        detached: true,
        stdio: 'ignore', // Don't inherit stdio - daemon runs independently
        cwd: ASAR_UNPACKED_DIR,
      });

      // Unref so parent can exit without waiting
      daemon.unref();

      log.info('DaemonClient', 'Daemon spawned with PID', daemon.pid);
      resolve();
    });
  }

  /**
   * Send a message to the daemon
   */
  _send(message) {
    if (!this.connected || !this.client) {
      log.error('DaemonClient', 'Not connected');
      return false;
    }

    try {
      this.client.write(JSON.stringify(message) + '\n');
      return true;
    } catch (err) {
      log.error('DaemonClient', 'Send error', err.message);
      return false;
    }
  }

  /**
   * Spawn a terminal in a pane
   * @param {string} paneId - The pane identifier
   * @param {string} [cwd] - Working directory
   * @param {boolean} [dryRun=false] - If true, spawn mock terminal instead of real PTY
   */
  spawn(paneId, cwd, dryRun = false, mode = null, env = null, spawnOptions = null) {
    const id = String(paneId);
    const incomingEnv = (env && typeof env === 'object') ? env : {};
    const explicitRole = typeof incomingEnv.SQUIDRUN_ROLE === 'string'
      ? incomingEnv.SQUIDRUN_ROLE.trim()
      : '';
    const role = explicitRole || String(PANE_ROLES?.[id] || '').trim();
    const spawnEnv = {
      SQUIDRUN_ROLE: role,
      SQUIDRUN_PANE_ID: id,
      ...incomingEnv,
    };
    const payload = {
      action: 'spawn',
      paneId: id,
      cwd,
      dryRun,
      mode,
      env: spawnEnv,
    };
    if (spawnOptions && typeof spawnOptions === 'object') {
      payload.options = { ...spawnOptions };
    }
    return this._send(payload);
  }

  /**
   * Write data to a terminal
   * @param {string} paneId - The pane identifier
   * @param {string} data - Data to write
   * @param {Object|null} kernelMeta - Optional event-kernel metadata
   */
  write(paneId, data, kernelMeta = null) {
    return this._send({
      action: 'write',
      paneId,
      data,
      kernelMeta: kernelMeta || undefined,
    });
  }

  _nextWriteAckEventId() {
    this.writeAckSeq += 1;
    return `write-${Date.now()}-${this.writeAckSeq}`;
  }

  _rejectPendingWriteAcks(reason = 'daemon_disconnected') {
    for (const [eventId, pending] of this.pendingWriteAcks.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        success: false,
        requestEventId: eventId,
        status: 'ack_timeout',
        error: reason,
      });
    }
    this.pendingWriteAcks.clear();
  }

  /**
   * Write data and wait for daemon.write.ack for this specific write.
   * requestEventId is carried in kernelMeta.eventId and echoed by daemon ack.
   * @param {string} paneId
   * @param {string} data
   * @param {Object|null} kernelMeta
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=2000]
   * @returns {Promise<{success:boolean,status?:string,error?:string,requestEventId?:string,eventData?:Object}>}
   */
  async writeAndWaitAck(paneId, data, kernelMeta = null, options = {}) {
    const timeoutMs = Math.max(100, Number(options?.timeoutMs) || 2000);
    const normalizedMeta = (kernelMeta && typeof kernelMeta === 'object')
      ? { ...kernelMeta }
      : {};
    if (!normalizedMeta.eventId) {
      normalizedMeta.eventId = this._nextWriteAckEventId();
    }
    const requestEventId = normalizedMeta.eventId;

    if (!this.connected || !this.client) {
      return {
        success: false,
        requestEventId,
        status: 'not_connected',
        error: 'Daemon not connected',
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWriteAcks.delete(requestEventId);
        resolve({
          success: false,
          requestEventId,
          status: 'ack_timeout',
          error: `write ack timeout after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pendingWriteAcks.set(requestEventId, { resolve, timer });

      const sent = this.write(paneId, data, normalizedMeta);
      if (!sent) {
        clearTimeout(timer);
        this.pendingWriteAcks.delete(requestEventId);
        resolve({
          success: false,
          requestEventId,
          status: 'send_failed',
          error: 'Failed to send write to daemon',
        });
      }
    });
  }

  /**
   * Pause terminal output
   * @param {string} paneId - The pane identifier
   */
  pause(paneId) {
    return this._send({
      action: 'pause',
      paneId,
    });
  }

  /**
   * Resume terminal output
   * @param {string} paneId - The pane identifier
   */
  resume(paneId) {
    return this._send({
      action: 'resume',
      paneId,
    });
  }

  /**
   * Resize a terminal
   * @param {string} paneId - The pane identifier
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   * @param {Object|null} kernelMeta - Optional event-kernel metadata
   */
  resize(paneId, cols, rows, kernelMeta = null) {
    return this._send({
      action: 'resize',
      paneId,
      cols,
      rows,
      kernelMeta: kernelMeta || undefined,
    });
  }

  /**
   * Kill a terminal
   * @param {string} paneId - The pane identifier
   */
  kill(paneId) {
    return this._send({
      action: 'kill',
      paneId,
    });
  }

  /**
   * Request list of all terminals
   */
  list() {
    return this._send({
      action: 'list',
    });
  }

  /**
   * Attach to a terminal (request its current state)
   * @param {string} paneId - The pane identifier
   */
  attach(paneId) {
    return this._send({
      action: 'attach',
      paneId,
    });
  }

  /**
   * Send ping to daemon
   */
  ping() {
    return this._send({
      action: 'ping',
    });
  }

  /**
   * Request health check from daemon
   * Returns: uptime, terminal count, memory usage
   */
  health() {
    return this._send({
      action: 'health',
    });
  }

  // ============================================================
  // ID-1: Session Identity Injection
  // Inject role identity message for /resume identification
  // ============================================================

  /**
   * Inject identity message into terminal for Claude session identification
   * Makes sessions identifiable when using /resume
   * @param {string} paneId - The pane identifier
   */
  injectIdentity(paneId) {
    return this._send({
      action: 'inject-identity',
      paneId,
    });
  }

  // ============================================================
  // FX2: Session Persistence Methods
  // ============================================================

  /**
   * Get saved session state from daemon
   * @returns {Promise<Object|null>} Session state or null
   */
  getSession() {
    return this._send({
      action: 'get-session',
    });
  }

  /**
   * Manually save current session state
   */
  saveSession() {
    return this._send({
      action: 'save-session',
    });
  }

  /**
   * Clear saved session state
   */
  clearSession() {
    return this._send({
      action: 'clear-session',
    });
  }

  /**
   * Request daemon shutdown (kills all terminals)
   */
  shutdown() {
    return this._send({
      action: 'shutdown',
    });
  }

  /**
   * Disconnect from daemon (doesn't kill terminals)
   */
  disconnect() {
    this._rejectPendingWriteAcks('daemon_disconnected');
    if (this.client) {
      this._teardownSocket(this.client);
      this.client = null;
    }
    this.connected = false;
  }

  /**
   * True if the daemon was spawned during the most recent connect() call.
   * This distinguishes full daemon restarts from lightweight app reconnects.
   * @returns {boolean}
   */
  didSpawnDuringLastConnect() {
    return this.spawnedDuringLastConnect === true;
  }

  /**
   * Check if daemon is running
   * @returns {Promise<boolean>}
   */
  async isDaemonRunning() {
    // Check if PID file exists and process is running
    if (fs.existsSync(DAEMON_PID_FILE)) {
      try {
        const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf-8').trim());
        if (pid) {
          // Try to check if process exists
          try {
            process.kill(pid, 0); // Signal 0 doesn't kill, just checks
            return true;
          } catch (_e) {
            // Process doesn't exist
            return false;
          }
        }
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Get cached terminal info
   * @param {string} paneId
   */
  getTerminal(paneId) {
    return this.terminals.get(paneId);
  }

  /**
   * Get all cached terminals
   */
  getTerminals() {
    return Array.from(this.terminals.values());
  }

  /**
   * Get last activity timestamp for a pane
   * @param {string} paneId
   * @returns {number|null} timestamp or null if no activity recorded
   */
  getLastActivity(paneId) {
    return this.lastActivity.get(paneId) || null;
  }

  /**
   * Get all activity timestamps
   * @returns {Object} paneId -> timestamp
   */
  getAllActivity() {
    return Object.fromEntries(this.lastActivity);
  }

  /**
   * Sleep utility
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let instance = null;

/**
 * Get the daemon client instance
 * @returns {DaemonClient}
 */
function getDaemonClient() {
  if (!instance) {
    instance = new DaemonClient();
  }
  return instance;
}

module.exports = {
  DaemonClient,
  getDaemonClient,
  PIPE_PATH,
};
