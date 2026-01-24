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

// Named pipe path (Windows) or Unix socket
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\hivemind-terminal'
  : '/tmp/hivemind-terminal.sock';

const DAEMON_SCRIPT = path.join(__dirname, 'terminal-daemon.js');
const DAEMON_PID_FILE = path.join(__dirname, 'daemon.pid');

class DaemonClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.buffer = '';
    this.reconnecting = false;
    this.terminals = new Map(); // Cache of known terminals
  }

  /**
   * Connect to the daemon, spawning it if necessary
   * @returns {Promise<boolean>} true if connected
   */
  async connect() {
    // Try to connect first
    const connected = await this._tryConnect();
    if (connected) {
      console.log('[DaemonClient] Connected to existing daemon');
      return true;
    }

    // Daemon not running, spawn it
    console.log('[DaemonClient] Daemon not running, spawning...');
    await this._spawnDaemon();

    // Wait a bit for daemon to start
    await this._sleep(500);

    // Try to connect again
    const retryConnected = await this._tryConnect();
    if (retryConnected) {
      console.log('[DaemonClient] Connected to newly spawned daemon');
      return true;
    }

    console.error('[DaemonClient] Failed to connect to daemon after spawn');
    return false;
  }

  /**
   * Try to connect to the daemon
   * @returns {Promise<boolean>}
   */
  _tryConnect() {
    return new Promise((resolve) => {
      const client = net.createConnection(PIPE_PATH);

      const timeout = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 2000);

      client.on('connect', () => {
        clearTimeout(timeout);
        this.client = client;
        this.connected = true;
        this._setupClient();
        resolve(true);
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * Setup client event handlers
   */
  _setupClient() {
    this.buffer = '';

    this.client.on('data', (data) => {
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

    this.client.on('close', () => {
      console.log('[DaemonClient] Connection closed');
      this.connected = false;
      this.client = null;
      this.emit('disconnected');

      // Attempt reconnect
      if (!this.reconnecting) {
        this._attemptReconnect();
      }
    });

    this.client.on('error', (err) => {
      console.error('[DaemonClient] Connection error:', err.message);
      this.connected = false;
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
          this.emit('data', msg.paneId, msg.data);
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
          });
          this.emit('spawned', msg.paneId, msg.pid);
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
          console.log('[DaemonClient] Daemon is shutting down:', msg.message);
          this.emit('shutdown', msg.message, msg.timestamp);
          // Don't attempt reconnect - daemon is intentionally shutting down
          this.reconnecting = true; // Prevent auto-reconnect
          break;

        // D2: Handle health check response
        case 'health':
          this.emit('health', msg);
          break;

        default:
          console.log('[DaemonClient] Unknown event:', msg.event);
      }
    } catch (err) {
      console.error('[DaemonClient] Error parsing message:', err.message);
    }
  }

  /**
   * Attempt to reconnect to daemon
   */
  async _attemptReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    console.log('[DaemonClient] Attempting to reconnect...');

    for (let i = 0; i < 5; i++) {
      await this._sleep(1000);
      const connected = await this._tryConnect();
      if (connected) {
        console.log('[DaemonClient] Reconnected successfully');
        this.reconnecting = false;
        this.emit('reconnected');
        return;
      }
    }

    console.error('[DaemonClient] Failed to reconnect after 5 attempts');
    this.reconnecting = false;
    this.emit('reconnect-failed');
  }

  /**
   * Spawn the daemon process (detached)
   */
  async _spawnDaemon() {
    return new Promise((resolve) => {
      console.log('[DaemonClient] Spawning daemon:', DAEMON_SCRIPT);

      // Spawn as detached process so it survives parent exit
      const daemon = spawn('node', [DAEMON_SCRIPT], {
        detached: true,
        stdio: 'ignore', // Don't inherit stdio - daemon runs independently
        cwd: __dirname,
      });

      // Unref so parent can exit without waiting
      daemon.unref();

      console.log('[DaemonClient] Daemon spawned with PID:', daemon.pid);
      resolve();
    });
  }

  /**
   * Send a message to the daemon
   */
  _send(message) {
    if (!this.connected || !this.client) {
      console.error('[DaemonClient] Not connected');
      return false;
    }

    try {
      this.client.write(JSON.stringify(message) + '\n');
      return true;
    } catch (err) {
      console.error('[DaemonClient] Send error:', err.message);
      return false;
    }
  }

  /**
   * Spawn a terminal in a pane
   * @param {string} paneId - The pane identifier
   * @param {string} [cwd] - Working directory
   */
  spawn(paneId, cwd) {
    return this._send({
      action: 'spawn',
      paneId,
      cwd,
    });
  }

  /**
   * Write data to a terminal
   * @param {string} paneId - The pane identifier
   * @param {string} data - Data to write
   */
  write(paneId, data) {
    return this._send({
      action: 'write',
      paneId,
      data,
    });
  }

  /**
   * Resize a terminal
   * @param {string} paneId - The pane identifier
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(paneId, cols, rows) {
    return this._send({
      action: 'resize',
      paneId,
      cols,
      rows,
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
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.connected = false;
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
          } catch (e) {
            // Process doesn't exist
            return false;
          }
        }
      } catch (e) {
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
