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
const path = require('path');
const pty = require('node-pty');

// Named pipe path (Windows) or Unix socket
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\hivemind-terminal'
  : '/tmp/hivemind-terminal.sock';

// Instance working directories (role injection)
const WORKSPACE_PATH = path.join(__dirname, '..', 'workspace');
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'lead'),
  '2': path.join(WORKSPACE_PATH, 'instances', 'worker-a'),
  '3': path.join(WORKSPACE_PATH, 'instances', 'worker-b'),
  '4': path.join(WORKSPACE_PATH, 'instances', 'reviewer'),
};

// Store PTY processes: Map<paneId, { pty, pid, alive, cwd }>
const terminals = new Map();

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
    console.error('[Daemon] Error sending to client:', err.message);
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

  console.log(`[Daemon] Spawning terminal for pane ${paneId} in ${workDir}`);

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
  };

  terminals.set(paneId, terminalInfo);

  // Forward PTY output to all connected clients
  ptyProcess.onData((data) => {
    broadcast({
      event: 'data',
      paneId,
      data,
    });
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[Daemon] Terminal ${paneId} exited with code ${exitCode}`);
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
    });
  }
  return list;
}

// Handle incoming client messages
function handleMessage(client, message) {
  try {
    const msg = JSON.parse(message);
    console.log(`[Daemon] Received: ${msg.action} for pane ${msg.paneId || 'N/A'}`);

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
        const terminals = listTerminals();
        sendToClient(client, {
          event: 'list',
          terminals,
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

      case 'shutdown': {
        console.log('[Daemon] Shutdown requested');
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
    console.error('[Daemon] Error handling message:', err.message);
    sendToClient(client, {
      event: 'error',
      message: `Parse error: ${err.message}`,
    });
  }
}

// Create the server
const server = net.createServer((client) => {
  console.log('[Daemon] Client connected');
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
    console.log('[Daemon] Client disconnected');
    clients.delete(client);
    // Don't kill terminals - that's the whole point!
  });

  client.on('error', (err) => {
    console.error('[Daemon] Client error:', err.message);
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
  console.log('[Daemon] SIGINT received, shutting down...');
  for (const [paneId] of terminals) {
    killTerminal(paneId);
  }
  server.close();
  cleanupSocket();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Daemon] SIGTERM received, shutting down...');
  for (const [paneId] of terminals) {
    killTerminal(paneId);
  }
  server.close();
  cleanupSocket();
  process.exit(0);
});

// Start the server
cleanupSocket();
server.listen(PIPE_PATH, () => {
  console.log(`[Daemon] Terminal daemon listening on ${PIPE_PATH}`);
  console.log('[Daemon] PID:', process.pid);

  // Write PID file for easy process management
  const fs = require('fs');
  const pidFile = path.join(__dirname, 'daemon.pid');
  fs.writeFileSync(pidFile, process.pid.toString());
  console.log(`[Daemon] PID written to ${pidFile}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[Daemon] Another instance is already running on', PIPE_PATH);
    process.exit(1);
  } else {
    console.error('[Daemon] Server error:', err);
    process.exit(1);
  }
});
