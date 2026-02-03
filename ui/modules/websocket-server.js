/**
 * WebSocket Server for Agent Communication
 * Provides low-latency message delivery bypassing file-based triggers
 */

const { WebSocketServer } = require('ws');
const log = require('./logger');

const DEFAULT_PORT = 9900;

let wss = null;
let clients = new Map(); // clientId -> { ws, paneId, role }
let clientIdCounter = 0;
let messageHandler = null; // External handler for incoming messages

/**
 * Start the WebSocket server
 * @param {object} options - Configuration options
 * @param {number} options.port - Port to listen on (default: 9900)
 * @param {function} options.onMessage - Handler for incoming messages
 * @returns {Promise<WebSocketServer>}
 */
function start(options = {}) {
  const port = options.port || DEFAULT_PORT;
  messageHandler = options.onMessage || null;

  return new Promise((resolve, reject) => {
    try {
      wss = new WebSocketServer({ port, host: '127.0.0.1' });

      wss.on('listening', () => {
        log.info('WebSocket', `Server listening on ws://127.0.0.1:${port}`);
        resolve(wss);
      });

      wss.on('connection', (ws, req) => {
        const clientId = ++clientIdCounter;
        const clientInfo = { ws, paneId: null, role: null, connectedAt: Date.now() };
        clients.set(clientId, clientInfo);

        log.info('WebSocket', `Client ${clientId} connected from ${req.socket.remoteAddress}`);

        ws.on('message', (data) => {
          handleMessage(clientId, data);
        });

        ws.on('close', (code, reason) => {
          const info = clients.get(clientId);
          const roleInfo = info?.role ? ` (${info.role})` : '';
          log.info('WebSocket', `Client ${clientId}${roleInfo} disconnected: ${code}`);
          clients.delete(clientId);
        });

        ws.on('error', (err) => {
          log.error('WebSocket', `Client ${clientId} error: ${err.message}`);
        });

        // Send welcome message with client ID
        ws.send(JSON.stringify({ type: 'welcome', clientId }));
      });

      wss.on('error', (err) => {
        log.error('WebSocket', `Server error: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} already in use`));
        }
      });

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Handle incoming message from a client
 * @param {number} clientId - Client identifier
 * @param {Buffer|string} rawData - Raw message data
 */
function handleMessage(clientId, rawData) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return;

  let message;
  try {
    const str = rawData.toString();
    message = JSON.parse(str);
  } catch (err) {
    // Plain text message
    message = { type: 'text', content: rawData.toString() };
  }

  log.info('WebSocket', `Received from client ${clientId}: ${JSON.stringify(message).substring(0, 100)}`);

  // Handle registration messages
  if (message.type === 'register') {
    clientInfo.paneId = message.paneId || null;
    clientInfo.role = message.role || null;
    log.info('WebSocket', `Client ${clientId} registered as pane=${message.paneId} role=${message.role}`);
    clientInfo.ws.send(JSON.stringify({ type: 'registered', paneId: message.paneId, role: message.role }));
    return;
  }

  // Handle agent-to-agent messages
  if (message.type === 'send') {
    const { target, content, priority } = message;
    sendToTarget(target, content, { from: clientInfo.role || clientId, priority });
    return;
  }

  // Handle broadcast
  if (message.type === 'broadcast') {
    broadcast(message.content, { from: clientInfo.role || clientId, excludeSender: clientId });
    return;
  }

  // Pass to external handler if set
  if (messageHandler) {
    messageHandler({
      clientId,
      paneId: clientInfo.paneId,
      role: clientInfo.role,
      message,
    });
  }
}

/**
 * Send message to a specific target (paneId or role)
 * @param {string} target - Target paneId or role name
 * @param {string} content - Message content
 * @param {object} meta - Metadata (from, priority)
 */
function sendToTarget(target, content, meta = {}) {
  const payload = JSON.stringify({
    type: 'message',
    from: meta.from || 'system',
    priority: meta.priority || 'normal',
    content,
    timestamp: Date.now(),
  });

  let sent = false;
  for (const [clientId, info] of clients) {
    if (info.paneId === target || info.role === target) {
      if (info.ws.readyState === 1) { // WebSocket.OPEN
        info.ws.send(payload);
        sent = true;
        log.info('WebSocket', `Sent to ${target} (client ${clientId}): ${content.substring(0, 50)}...`);
      }
    }
  }

  if (!sent) {
    log.warn('WebSocket', `No connected client for target: ${target}`);
  }

  return sent;
}

/**
 * Broadcast message to all connected clients
 * @param {string} content - Message content
 * @param {object} options - Options (from, excludeSender)
 */
function broadcast(content, options = {}) {
  const payload = JSON.stringify({
    type: 'broadcast',
    from: options.from || 'system',
    content,
    timestamp: Date.now(),
  });

  let count = 0;
  for (const [clientId, info] of clients) {
    if (options.excludeSender && clientId === options.excludeSender) continue;
    if (info.ws.readyState === 1) { // WebSocket.OPEN
      info.ws.send(payload);
      count++;
    }
  }

  log.info('WebSocket', `Broadcast to ${count} clients: ${content.substring(0, 50)}...`);
  return count;
}

/**
 * Send message to a specific pane (convenience wrapper)
 * @param {string} paneId - Target pane ID
 * @param {string} content - Message content
 * @param {object} meta - Metadata
 */
function sendToPane(paneId, content, meta = {}) {
  return sendToTarget(paneId, content, meta);
}

/**
 * Get list of connected clients
 * @returns {Array} Client info array
 */
function getClients() {
  return Array.from(clients.entries()).map(([id, info]) => ({
    clientId: id,
    paneId: info.paneId,
    role: info.role,
    connectedAt: info.connectedAt,
    ready: info.ws.readyState === 1,
  }));
}

/**
 * Stop the WebSocket server
 */
function stop() {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }

    // Close all client connections
    for (const [clientId, info] of clients) {
      info.ws.close(1000, 'Server shutting down');
    }
    clients.clear();

    wss.close(() => {
      log.info('WebSocket', 'Server stopped');
      wss = null;
      resolve();
    });
  });
}

/**
 * Check if server is running
 * @returns {boolean}
 */
function isRunning() {
  return wss !== null;
}

/**
 * Get server port
 * @returns {number|null}
 */
function getPort() {
  return wss?.options?.port || null;
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  sendToTarget,
  sendToPane,
  broadcast,
  DEFAULT_PORT,
};
