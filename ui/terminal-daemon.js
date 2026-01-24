/**
 * Terminal Daemon - Manages PTY processes independently of Electron app
 *
 * This daemon runs as a separate process and owns all terminal PTYs.
 * The Electron app connects as a client via named pipe.
 * Terminals survive app restarts because the daemon keeps running.
 *
 * Protocol:
 * - Client → Daemon: { action: "spawn"|"write"|"resize"|"kill"|"list"|"attach", ... }
 * - Daemon → Client: { event: "data"|"exit"|"spawned"|"list"|"error", ... }
 */

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { PIPE_PATH, INSTANCE_DIRS, PANE_ROLES } = require('./config');

// ============================================================
// D1: DAEMON LOGGING TO FILE
// ============================================================

const LOG_FILE_PATH = path.join(__dirname, 'daemon.log');
const daemonStartTime = Date.now();

// Log levels
const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

// Log to both console and file
function log(level, message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}`;
  console.log(entry);

  try {
    fs.appendFileSync(LOG_FILE_PATH, entry + '\n');
  } catch (err) {
    // If we can't write to log file, at least console still works
  }
}

// Convenience log functions
function logInfo(message) { log(LOG_LEVELS.INFO, message); }
function logWarn(message) { log(LOG_LEVELS.WARN, message); }
function logError(message) { log(LOG_LEVELS.ERROR, message); }

// Initialize log file with startup message
function initLogFile() {
  const header = `\n${'='.repeat(60)}\nDaemon started at ${new Date().toISOString()}\nPID: ${process.pid}\n${'='.repeat(60)}\n`;
  try {
    fs.appendFileSync(LOG_FILE_PATH, header);
  } catch (err) {
    console.error('Could not initialize log file:', err.message);
  }
}

// Format uptime as human-readable string
function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// Store PTY processes: Map<paneId, { pty, pid, alive, cwd, scrollback, dryRun, lastActivity }>
const terminals = new Map();

// U1: Scrollback buffer settings - keep last 50KB of output per terminal
const SCROLLBACK_MAX_SIZE = 50000;

// V4 AR1: Default stuck threshold (60 seconds)
const DEFAULT_STUCK_THRESHOLD = 60000;

// ============================================================
// FX2: SESSION PERSISTENCE
// ============================================================

const SESSION_FILE_PATH = path.join(__dirname, 'session-state.json');

/**
 * Save current session state to disk
 * Called periodically and on shutdown
 */
function saveSessionState() {
  const sessionState = {
    savedAt: new Date().toISOString(),
    daemonPid: process.pid,
    terminals: [],
  };

  for (const [paneId, termInfo] of terminals) {
    sessionState.terminals.push({
      paneId,
      cwd: termInfo.cwd,
      alive: termInfo.alive,
      dryRun: termInfo.dryRun || false,
      scrollback: termInfo.scrollback || '',
      lastActivity: termInfo.lastActivity,
    });
  }

  try {
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionState, null, 2));
    logInfo(`Session state saved: ${sessionState.terminals.length} terminals`);
  } catch (err) {
    logError(`Failed to save session state: ${err.message}`);
  }
}

/**
 * Load saved session state from disk
 * Returns null if no saved state or invalid
 */
function loadSessionState() {
  try {
    if (!fs.existsSync(SESSION_FILE_PATH)) {
      logInfo('No saved session state found');
      return null;
    }
    const data = fs.readFileSync(SESSION_FILE_PATH, 'utf-8');
    const state = JSON.parse(data);
    logInfo(`Loaded session state from ${state.savedAt}`);
    return state;
  } catch (err) {
    logWarn(`Could not load session state: ${err.message}`);
    return null;
  }
}

/**
 * Clear saved session state
 */
function clearSessionState() {
  try {
    if (fs.existsSync(SESSION_FILE_PATH)) {
      fs.unlinkSync(SESSION_FILE_PATH);
      logInfo('Session state cleared');
    }
  } catch (err) {
    logWarn(`Could not clear session state: ${err.message}`);
  }
}

// Save session state periodically (every 30 seconds)
setInterval(() => {
  if (terminals.size > 0) {
    saveSessionState();
  }
}, 30000);

// ============================================================
// D2 (V3): DRY-RUN MODE
// ============================================================

// Mock responses for dry-run mode (simulates Claude agent)
const DRY_RUN_RESPONSES = [
  '[DRY-RUN] Claude agent simulated. Ready for input.\r\n',
  '[DRY-RUN] Processing your request...\r\n',
  '[DRY-RUN] Analyzing codebase structure...\r\n',
  '[DRY-RUN] Reading relevant files...\r\n',
  '[DRY-RUN] Task completed successfully.\r\n',
  '[DRY-RUN] Waiting for next instruction...\r\n',
];

// Simulated typing delay (ms per character)
const DRY_RUN_TYPING_DELAY = 15;

// Send mock data with simulated typing effect
function sendMockData(paneId, text, callback) {
  const terminal = terminals.get(paneId);
  if (!terminal || !terminal.alive) return;

  let index = 0;
  const sendChar = () => {
    if (index < text.length && terminal.alive) {
      const char = text[index];
      // Buffer for scrollback
      terminal.scrollback += char;
      if (terminal.scrollback.length > SCROLLBACK_MAX_SIZE) {
        terminal.scrollback = terminal.scrollback.slice(-SCROLLBACK_MAX_SIZE);
      }
      // Broadcast character
      broadcast({ event: 'data', paneId, data: char });
      index++;
      setTimeout(sendChar, DRY_RUN_TYPING_DELAY);
    } else if (callback) {
      callback();
    }
  };
  sendChar();
}

// Generate mock Claude response based on input
function generateMockResponse(input) {
  const trimmed = input.trim().toLowerCase();

  // Recognize common commands/patterns
  if (trimmed === '' || trimmed === '\r' || trimmed === '\n') {
    return '';
  }

  if (trimmed.includes('sync') || trimmed.includes('hivemind')) {
    return '\r\n[DRY-RUN] Sync received. Reading shared_context.md...\r\n[DRY-RUN] Worker acknowledged. Standing by for tasks.\r\n\r\n> ';
  }

  if (trimmed.includes('read') || trimmed.includes('cat')) {
    return '\r\n[DRY-RUN] Reading file... (simulated)\r\n[DRY-RUN] File contents displayed.\r\n\r\n> ';
  }

  if (trimmed.includes('edit') || trimmed.includes('write') || trimmed.includes('fix')) {
    return '\r\n[DRY-RUN] Editing file... (simulated)\r\n[DRY-RUN] Changes applied successfully.\r\n\r\n> ';
  }

  if (trimmed.includes('test') || trimmed.includes('npm')) {
    return '\r\n[DRY-RUN] Running tests... (simulated)\r\n[DRY-RUN] All 86 tests passed.\r\n\r\n> ';
  }

  if (trimmed.includes('help') || trimmed === '?') {
    return '\r\n[DRY-RUN] This is dry-run mode. Commands are simulated.\r\n[DRY-RUN] Toggle off in Settings to use real Claude.\r\n\r\n> ';
  }

  // Default response
  return '\r\n[DRY-RUN] Command received: "' + input.trim().substring(0, 50) + '"\r\n[DRY-RUN] Processing... Done.\r\n\r\n> ';
}

// Connected clients: Set<net.Socket>
const clients = new Set();

// Get the appropriate shell for the platform
function getShell() {
  return os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
}

// Send JSON message to a client
function sendToClient(client, message) {
  try {
    if (client && !client.destroyed) {
      client.write(JSON.stringify(message) + '\n');
    }
  } catch (err) {
    logError(`Error sending to client: ${err.message}`);
  }
}

// Broadcast message to all connected clients
function broadcast(message) {
  for (const client of clients) {
    sendToClient(client, message);
  }
}

// Spawn a new PTY for a pane (or mock terminal in dry-run mode)
function spawnTerminal(paneId, cwd, dryRun = false) {
  // Kill existing terminal for this pane if any
  if (terminals.has(paneId)) {
    const existing = terminals.get(paneId);
    if (existing.pty && existing.alive && !existing.dryRun) {
      try {
        existing.pty.kill();
      } catch (e) { /* ignore */ }
    }
    // Clear any dry-run timers
    if (existing.dryRunTimer) {
      clearTimeout(existing.dryRunTimer);
    }
  }

  // Use role-specific instance directory if available
  const instanceDir = INSTANCE_DIRS[paneId];
  const workDir = instanceDir || cwd || process.cwd();

  // DRY-RUN MODE: Create mock terminal instead of real PTY
  if (dryRun) {
    logInfo(`[DRY-RUN] Spawning MOCK terminal for pane ${paneId}`);

    const mockPid = 90000 + parseInt(paneId); // Fake PID for identification

    const terminalInfo = {
      pty: null,
      pid: mockPid,
      alive: true,
      cwd: workDir,
      scrollback: '',
      dryRun: true,
      inputBuffer: '', // Buffer for accumulating input
      lastActivity: Date.now(), // V4 AR1: Track last activity
    };

    terminals.set(paneId, terminalInfo);

    // Send initial mock prompt after short delay
    setTimeout(() => {
      if (terminalInfo.alive) {
        const welcomeMsg = `\r\n[DRY-RUN MODE] Mock Claude agent for Pane ${paneId}\r\n` +
          `[DRY-RUN] Role: ${PANE_ROLES[paneId] || 'Unknown'}\r\n` +
          `[DRY-RUN] Working dir: ${workDir}\r\n` +
          `[DRY-RUN] Commands are simulated. Toggle off in Settings for real Claude.\r\n\r\n> `;
        sendMockData(paneId, welcomeMsg);
      }
    }, 300);

    return { paneId, pid: mockPid, dryRun: true };
  }

  // NORMAL MODE: Spawn real PTY
  const shell = getShell();
  logInfo(`Spawning terminal for pane ${paneId} in ${workDir}`);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workDir,
    env: process.env,
  });

  const terminalInfo = {
    pty: ptyProcess,
    pid: ptyProcess.pid,
    alive: true,
    cwd: workDir,
    scrollback: '', // U1: Buffer for scrollback persistence
    dryRun: false,
    lastActivity: Date.now(), // V4 AR1: Track last activity
  };

  terminals.set(paneId, terminalInfo);

  // Forward PTY output to all connected clients
  ptyProcess.onData((data) => {
    // V4 AR1: Track last activity time
    terminalInfo.lastActivity = Date.now();

    // U1: Buffer output for scrollback persistence
    terminalInfo.scrollback += data;
    if (terminalInfo.scrollback.length > SCROLLBACK_MAX_SIZE) {
      // Keep only the last SCROLLBACK_MAX_SIZE characters
      terminalInfo.scrollback = terminalInfo.scrollback.slice(-SCROLLBACK_MAX_SIZE);
    }

    broadcast({
      event: 'data',
      paneId,
      data,
    });
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    logInfo(`Terminal ${paneId} exited with code ${exitCode}`);
    terminalInfo.alive = false;
    broadcast({
      event: 'exit',
      paneId,
      code: exitCode,
    });
  });

  return { paneId, pid: ptyProcess.pid, dryRun: false };
}

// Write data to a terminal
function writeTerminal(paneId, data) {
  const terminal = terminals.get(paneId);
  if (!terminal || !terminal.alive) {
    return false;
  }

  // DRY-RUN MODE: Handle input simulation
  if (terminal.dryRun) {
    // Echo the input character
    broadcast({ event: 'data', paneId, data });
    terminal.scrollback += data;

    // Accumulate input until Enter is pressed
    if (data === '\r' || data === '\n') {
      const input = terminal.inputBuffer;
      terminal.inputBuffer = '';

      // Generate and send mock response
      const response = generateMockResponse(input);
      if (response) {
        // Delay response slightly for realism
        setTimeout(() => {
          sendMockData(paneId, response);
        }, 100 + Math.random() * 200);
      }
    } else if (data === '\x7f' || data === '\b') {
      // Backspace: remove last character from buffer
      terminal.inputBuffer = terminal.inputBuffer.slice(0, -1);
    } else {
      terminal.inputBuffer += data;
    }
    return true;
  }

  // NORMAL MODE: Write to real PTY
  if (terminal.pty) {
    terminal.pty.write(data);
    return true;
  }
  return false;
}

// Resize a terminal
function resizeTerminal(paneId, cols, rows) {
  const terminal = terminals.get(paneId);
  if (terminal && terminal.pty && terminal.alive) {
    terminal.pty.resize(cols, rows);
    return true;
  }
  return false;
}

// Kill a terminal
function killTerminal(paneId) {
  const terminal = terminals.get(paneId);
  if (!terminal) return false;

  // Clean up dry-run timer if exists
  if (terminal.dryRunTimer) {
    clearTimeout(terminal.dryRunTimer);
  }

  // Kill real PTY if not dry-run
  if (terminal.pty && !terminal.dryRun) {
    try {
      terminal.pty.kill();
    } catch (e) { /* ignore */ }
  }

  terminal.alive = false;
  terminals.delete(paneId);
  logInfo(`Terminal ${paneId} killed (dryRun: ${terminal.dryRun || false})`);
  return true;
}

// List all terminals
function listTerminals() {
  const list = [];
  for (const [paneId, info] of terminals) {
    list.push({
      paneId,
      pid: info.pid,
      alive: info.alive,
      cwd: info.cwd,
      // U1: Include scrollback for session restoration
      scrollback: info.scrollback || '',
      // V3: Include dry-run flag
      dryRun: info.dryRun || false,
      // V4 AR1: Include last activity timestamp
      lastActivity: info.lastActivity || null,
    });
  }
  return list;
}

// V4 AR1: Get stuck terminals (no activity for threshold ms)
function getStuckTerminals(thresholdMs = DEFAULT_STUCK_THRESHOLD) {
  const now = Date.now();
  const stuck = [];
  for (const [paneId, info] of terminals) {
    if (info.alive && info.lastActivity) {
      const idleTime = now - info.lastActivity;
      if (idleTime > thresholdMs) {
        stuck.push({
          paneId,
          pid: info.pid,
          lastActivity: info.lastActivity,
          idleTimeMs: idleTime,
          idleTimeFormatted: formatUptime(Math.floor(idleTime / 1000)),
        });
      }
    }
  }
  return stuck;
}

// Handle incoming client messages
function handleMessage(client, message) {
  try {
    const msg = JSON.parse(message);
    logInfo(`Received: ${msg.action} for pane ${msg.paneId || 'N/A'}`);

    switch (msg.action) {
      case 'spawn': {
        const result = spawnTerminal(msg.paneId, msg.cwd, msg.dryRun || false);
        sendToClient(client, {
          event: 'spawned',
          paneId: msg.paneId,
          pid: result.pid,
          dryRun: result.dryRun || false,
        });
        break;
      }

      case 'write': {
        const success = writeTerminal(msg.paneId, msg.data);
        if (!success) {
          sendToClient(client, {
            event: 'error',
            paneId: msg.paneId,
            message: 'Terminal not found or not alive',
          });
        }
        break;
      }

      case 'resize': {
        resizeTerminal(msg.paneId, msg.cols, msg.rows);
        break;
      }

      case 'kill': {
        killTerminal(msg.paneId);
        sendToClient(client, {
          event: 'killed',
          paneId: msg.paneId,
        });
        break;
      }

      case 'list': {
        const terminalList = listTerminals();
        sendToClient(client, {
          event: 'list',
          terminals: terminalList,
        });
        break;
      }

      case 'attach': {
        // Attach just means the client wants to receive data from this terminal
        // Since we broadcast to all clients, they're already "attached"
        const terminal = terminals.get(msg.paneId);
        if (terminal) {
          sendToClient(client, {
            event: 'attached',
            paneId: msg.paneId,
            pid: terminal.pid,
            alive: terminal.alive,
            // U1: Include scrollback buffer for session restoration
            scrollback: terminal.scrollback || '',
          });
        } else {
          sendToClient(client, {
            event: 'error',
            paneId: msg.paneId,
            message: 'Terminal not found',
          });
        }
        break;
      }

      case 'ping': {
        sendToClient(client, { event: 'pong' });
        break;
      }

      // D2: Health check endpoint
      case 'health': {
        const uptimeMs = Date.now() - daemonStartTime;
        const uptimeSecs = Math.floor(uptimeMs / 1000);
        const memUsage = process.memoryUsage();

        sendToClient(client, {
          event: 'health',
          uptime: uptimeSecs,
          uptimeFormatted: formatUptime(uptimeSecs),
          terminalCount: terminals.size,
          activeTerminals: [...terminals.values()].filter(t => t.alive).length,
          clientCount: clients.size,
          memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
          },
          pid: process.pid,
        });
        logInfo(`Health check requested by client`);
        break;
      }

      // V4 AR1: Get stuck terminals
      case 'stuck': {
        const threshold = msg.threshold || DEFAULT_STUCK_THRESHOLD;
        const stuckTerminals = getStuckTerminals(threshold);
        sendToClient(client, {
          event: 'stuck',
          terminals: stuckTerminals,
          threshold,
          count: stuckTerminals.length,
        });
        if (stuckTerminals.length > 0) {
          logWarn(`Stuck check: ${stuckTerminals.length} terminal(s) idle > ${threshold}ms`);
        }
        break;
      }

      // FX2: Session persistence protocol actions
      case 'get-session': {
        const state = loadSessionState();
        sendToClient(client, {
          event: 'session-state',
          state: state,
        });
        break;
      }

      case 'save-session': {
        saveSessionState();
        sendToClient(client, {
          event: 'session-saved',
          success: true,
        });
        break;
      }

      case 'clear-session': {
        clearSessionState();
        sendToClient(client, {
          event: 'session-cleared',
          success: true,
        });
        break;
      }

      case 'shutdown': {
        logInfo('Shutdown requested via protocol');
        // FX2: Save session before shutdown
        saveSessionState();
        // Kill all terminals
        for (const [paneId] of terminals) {
          killTerminal(paneId);
        }
        // Close server
        server.close(() => {
          console.log('[Daemon] Server closed');
          process.exit(0);
        });
        break;
      }

      default:
        sendToClient(client, {
          event: 'error',
          message: `Unknown action: ${msg.action}`,
        });
    }
  } catch (err) {
    logError(`Error handling message: ${err.message}`);
    sendToClient(client, {
      event: 'error',
      message: `Parse error: ${err.message}`,
    });
  }
}

// Create the server
const server = net.createServer((client) => {
  logInfo('Client connected');
  clients.add(client);

  // Buffer for incomplete messages (messages are newline-delimited)
  let buffer = '';

  client.on('data', (data) => {
    buffer += data.toString();

    // Process complete messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        handleMessage(client, line.trim());
      }
    }
  });

  client.on('close', () => {
    logInfo('Client disconnected');
    clients.delete(client);
    // Don't kill terminals - that's the whole point!
  });

  client.on('error', (err) => {
    logError(`Client error: ${err.message}`);
    clients.delete(client);
  });

  // Send initial list of terminals to new client
  sendToClient(client, {
    event: 'connected',
    terminals: listTerminals(),
  });
});

// Clean up Unix socket file if it exists (Unix only)
function cleanupSocket() {
  if (os.platform() !== 'win32') {
    const fs = require('fs');
    try {
      if (fs.existsSync(PIPE_PATH)) {
        fs.unlinkSync(PIPE_PATH);
      }
    } catch (e) { /* ignore */ }
  }
}

// Handle process signals
process.on('SIGINT', () => {
  logInfo('SIGINT received, shutting down...');
  // FX2: Save session state before shutdown
  saveSessionState();
  // Notify clients of shutdown
  broadcast({
    event: 'shutdown',
    message: 'Daemon is shutting down (SIGINT)',
    timestamp: new Date().toISOString(),
  });
  for (const [paneId] of terminals) {
    killTerminal(paneId);
  }
  server.close();
  cleanupSocket();
  process.exit(0);
});

// D3: Graceful shutdown with client notification
process.on('SIGTERM', () => {
  logInfo('SIGTERM received, initiating graceful shutdown...');

  // FX2: Save session state before shutdown
  saveSessionState();

  // Notify all clients before shutdown
  broadcast({
    event: 'shutdown',
    message: 'Daemon is shutting down',
    timestamp: new Date().toISOString(),
  });
  logInfo(`Notified ${clients.size} client(s) of shutdown`);

  // Give clients a moment to process the shutdown message
  setTimeout(() => {
    // Kill all terminals
    for (const [paneId] of terminals) {
      killTerminal(paneId);
    }
    logInfo('All terminals killed');

    server.close(() => {
      logInfo('Server closed, exiting');
      cleanupSocket();
      process.exit(0);
    });

    // Force exit after 2 seconds if server doesn't close cleanly
    setTimeout(() => {
      logWarn('Forced exit after timeout');
      cleanupSocket();
      process.exit(0);
    }, 2000);
  }, 100);
});

// Start the server
cleanupSocket();
initLogFile();

server.listen(PIPE_PATH, () => {
  logInfo(`Terminal daemon listening on ${PIPE_PATH}`);
  logInfo(`PID: ${process.pid}`);

  // Write PID file for easy process management
  const pidFile = path.join(__dirname, 'daemon.pid');
  fs.writeFileSync(pidFile, process.pid.toString());
  logInfo(`PID written to ${pidFile}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logError(`Another instance is already running on ${PIPE_PATH}`);
    process.exit(1);
  } else {
    logError(`Server error: ${err.message}`);
    process.exit(1);
  }
});
