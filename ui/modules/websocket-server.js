/**
 * WebSocket Server for Agent Communication
 * Provides low-latency message delivery bypassing file-based triggers
 */

const { WebSocketServer } = require('ws');
const log = require('./logger');

const DEFAULT_PORT = 9900;
const MESSAGE_ACK_TTL_MS = 60000;
let wss = null;
let clients = new Map(); // clientId -> { ws, paneId, role }
let clientIdCounter = 0;
let messageHandler = null; // External handler for incoming messages
let recentMessageAcks = new Map(); // messageId -> { ackPayload, expiresAt }
let pendingMessageAcks = new Map(); // messageId -> Promise<ackPayload>

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log.error('WebSocket', `Failed to send JSON payload: ${err.message}`);
    return false;
  }
}

function coerceAckResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return {
      ok: Boolean(result.ok),
      status: result.status || (result.ok ? 'ok' : 'failed'),
      details: result,
    };
  }
  if (Object.prototype.hasOwnProperty.call(result, 'success')) {
    return {
      ok: Boolean(result.success),
      status: result.success ? 'ok' : 'failed',
      details: result,
    };
  }
  return null;
}

function isAckEligibleMessage(message) {
  return Boolean(message?.ackRequired && (message.type === 'send' || message.type === 'broadcast'));
}

function getNormalizedMessageId(message) {
  if (!message || typeof message.messageId !== 'string') return null;
  const trimmed = message.messageId.trim();
  return trimmed ? trimmed : null;
}

function pruneExpiredMessageAcks(now = Date.now()) {
  for (const [messageId, entry] of recentMessageAcks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentMessageAcks.delete(messageId);
    }
  }
}

function cacheMessageAck(messageId, ackPayload, now = Date.now()) {
  if (!messageId || !ackPayload) return;
  recentMessageAcks.set(messageId, {
    ackPayload,
    expiresAt: now + MESSAGE_ACK_TTL_MS,
  });
}

/**
 * Start the WebSocket server
 * @param {object} options - Configuration options
 * @param {number} options.port - Port to listen on (default: 9900)
 * @param {function} options.onMessage - Handler for incoming messages
 * @returns {Promise<WebSocketServer>}
 */
function start(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  messageHandler = options.onMessage || null;
  recentMessageAcks.clear();
  pendingMessageAcks.clear();

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
          handleMessage(clientId, data).catch((err) => {
            log.error('WebSocket', `Unhandled message error for client ${clientId}: ${err.message}`);
          });
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
async function handleMessage(clientId, rawData) {
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
    sendJson(clientInfo.ws, { type: 'registered', paneId: message.paneId, role: message.role });
    return;
  }

  const ackEligible = isAckEligibleMessage(message);
  const messageId = ackEligible ? getNormalizedMessageId(message) : null;

  if (ackEligible && messageId) {
    pruneExpiredMessageAcks();

    const cached = recentMessageAcks.get(messageId);
    if (cached?.ackPayload) {
      sendJson(clientInfo.ws, cached.ackPayload);
      return;
    }

    const pending = pendingMessageAcks.get(messageId);
    if (pending) {
      try {
        const pendingAck = await pending;
        if (pendingAck) {
          sendJson(clientInfo.ws, pendingAck);
        }
      } catch (err) {
        const failedAck = {
          type: 'send-ack',
          messageId,
          ok: false,
          status: 'handler_error',
          error: err.message,
          timestamp: Date.now(),
        };
        sendJson(clientInfo.ws, failedAck);
      }
      return;
    }
  }

  let resolvePendingAck = null;
  let rejectPendingAck = null;
  if (ackEligible && messageId) {
    const pending = new Promise((resolve, reject) => {
      resolvePendingAck = resolve;
      rejectPendingAck = reject;
    });
    pendingMessageAcks.set(messageId, pending);
  }

  function finalizeAckTracking(ackPayload, err) {
    if (!ackEligible || !messageId) return;
    pendingMessageAcks.delete(messageId);
    if (ackPayload) {
      cacheMessageAck(messageId, ackPayload);
      if (resolvePendingAck) resolvePendingAck(ackPayload);
      return;
    }
    if (rejectPendingAck) {
      rejectPendingAck(err || new Error('ACK processing failed'));
    }
  }

  let wsDeliveryCount = 0;

  // Handle agent-to-agent messages
  if (message.type === 'send') {
    const { target, content, priority } = message;
    // Try WebSocket clients first (for future direct agent-to-agent)
    if (sendToTarget(target, content, { from: clientInfo.role || clientId, priority })) {
      wsDeliveryCount = 1;
    }
    // Don't return - let messageHandler also route to terminals
  }

  // Handle broadcast
  if (message.type === 'broadcast') {
    wsDeliveryCount = broadcast(message.content, { from: clientInfo.role || clientId, excludeSender: clientId });
    // Don't return - let messageHandler also route to terminals/triggers
  }

  let handlerResult = null;

  // Pass to external handler if set
  if (messageHandler) {
    try {
      handlerResult = await messageHandler({
        clientId,
        paneId: clientInfo.paneId,
        role: clientInfo.role,
        message,
      });
    } catch (err) {
      log.error('WebSocket', `messageHandler failed for client ${clientId}: ${err.message}`);
      if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
        const ackPayload = {
          type: 'send-ack',
          messageId: message.messageId || null,
          ok: false,
          status: 'handler_error',
          error: err.message,
          wsDeliveryCount,
          timestamp: Date.now(),
        };
        sendJson(clientInfo.ws, ackPayload);
        finalizeAckTracking(ackPayload, err);
      }
      else {
        finalizeAckTracking(null, err);
      }
      return;
    }
  }

  if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
    const handlerAck = coerceAckResult(handlerResult);
    const websocketDelivered = wsDeliveryCount > 0;
    const ok = websocketDelivered || Boolean(handlerAck?.ok);

    let status = websocketDelivered ? 'delivered.websocket' : 'unrouted';
    if (handlerAck?.status) {
      status = handlerAck.status;
      if (websocketDelivered && handlerAck.ok === false) {
        status = 'delivered.websocket';
      }
    }

    const ackPayload = {
      type: 'send-ack',
      messageId: message.messageId || null,
      ok,
      status,
      wsDeliveryCount,
      handlerResult: handlerAck?.details || null,
      timestamp: Date.now(),
    };
    sendJson(clientInfo.ws, ackPayload);
    finalizeAckTracking(ackPayload);
    return;
  }

  finalizeAckTracking(null);
}

/**
 * Send message to a specific target (paneId or role)
 * @param {string} target - Target paneId or role name
 * @param {string} content - Message content
 * @param {object} meta - Metadata (from, priority)
 */
function sendToTarget(target, content, meta = {}) {
  const targetStr = String(target);
  const targetRole = targetStr.toLowerCase();
  const payload = JSON.stringify({
    type: 'message',
    from: meta.from || 'system',
    priority: meta.priority || 'normal',
    content,
    timestamp: Date.now(),
  });

  let sent = false;
  for (const [clientId, info] of clients) {
    const paneMatch = info.paneId !== null && String(info.paneId) === targetStr;
    const roleMatch = typeof info.role === 'string' && info.role.toLowerCase() === targetRole;
    if (paneMatch || roleMatch) {
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
    recentMessageAcks.clear();
    pendingMessageAcks.clear();

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
  if (!wss) return null;
  if (typeof wss.address === 'function') {
    const address = wss.address();
    if (address && typeof address === 'object' && address.port) {
      return address.port;
    }
  }
  return wss.options?.port || null;
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
