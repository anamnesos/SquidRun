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
const { PIPE_PATH, INSTANCE_DIRS } = require('./config');

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

// Store PTY processes: Map<paneId, { pty, pid, alive, cwd, scrollback }>
const terminals = new Map();

// U1: Scrollback buffer settings - keep last 50KB of output per terminal
const SCROLLBACK_MAX_SIZE = 50000;

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

// Spawn a new PTY for a pane
function spawnTerminal(paneId, cwd) {
  // Kill existing terminal for this pane if any
  if (terminals.has(paneId)) {
    const existing = terminals.get(paneId);
    if (existing.pty && existing.alive) {
      try {
        existing.pty.kill();
      } catch (e) { /* ignore */ }
    }
  }

  const shell = getShell();
  // Use role-specific instance directory if available
  const instanceDir = INSTANCE_DIRS[paneId];
  const workDir = instanceDir || cwd || process.cwd();

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
  };

  terminals.set(paneId, terminalInfo);

  // Forward PTY output to all connected clients
  ptyProcess.onData((data) => {
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

  return { paneId, pid: ptyProcess.pid };
}

// Write data to a terminal
function writeTerminal(paneId, data) {
  const terminal = terminals.get(paneId);
  if (terminal && terminal.pty && terminal.alive) {
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
  if (terminal && terminal.pty) {
    try {
      terminal.pty.kill();
    } catch (e) { /* ignore */ }
    terminal.alive = false;
    terminals.delete(paneId);
    return true;
  }
  return false;
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
    });
  }
  return list;
}

// Handle incoming client messages
function handleMessage(client, message) {
  try {
    const msg = JSON.parse(message);
    logInfo(`Received: ${msg.action} for pane ${msg.paneId || 'N/A'}`);

    switch (msg.action) {
      case 'spawn': {
        const result = spawnTerminal(msg.paneId, msg.cwd);
        sendToClient(client, {
          event: 'spawned',
          paneId: msg.paneId,
          pid: result.pid,
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

      case 'shutdown': {
        logInfo('Shutdown requested via protocol');
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
