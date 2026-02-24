const WebSocket = require('ws');
const log = require('./logger');
const {
  normalizeDeviceId,
} = require('./cross-device-target');

const DEFAULT_ACK_TIMEOUT_MS = 12000;
const DEFAULT_RECONNECT_BASE_MS = 750;
const DEFAULT_RECONNECT_MAX_MS = 10000;

function asNonEmptyString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getReconnectDelayMs(attempt) {
  const baseMs = parsePositiveInt(process.env.SQUIDRUN_BRIDGE_RECONNECT_BASE_MS, DEFAULT_RECONNECT_BASE_MS);
  const maxMs = parsePositiveInt(process.env.SQUIDRUN_BRIDGE_RECONNECT_MAX_MS, DEFAULT_RECONNECT_MAX_MS);
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(maxMs, baseMs * Math.pow(2, exponent));
}

function buildAckResult(input = {}) {
  return {
    ok: input.ok === true,
    accepted: input.accepted === true || input.ok === true,
    queued: input.queued === true || input.accepted === true || input.ok === true,
    verified: input.verified === true || input.ok === true,
    status: asNonEmptyString(input.status) || (input.ok ? 'bridge_delivered' : 'bridge_failed'),
    error: asNonEmptyString(input.error) || null,
    fromDevice: asNonEmptyString(input.fromDevice) || null,
    toDevice: asNonEmptyString(input.toDevice) || null,
  };
}

class BridgeClient {
  constructor(options = {}) {
    this.relayUrl = asNonEmptyString(options.relayUrl);
    this.deviceId = normalizeDeviceId(options.deviceId);
    this.sharedSecret = asNonEmptyString(options.sharedSecret);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.shouldRun = false;
    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.pendingAcks = new Map();
  }

  isConfigured() {
    return Boolean(this.relayUrl && this.deviceId && this.sharedSecret);
  }

  isReady() {
    return this.connected && this.registered && this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  start() {
    if (!this.isConfigured()) return false;
    this.shouldRun = true;
    this.connect();
    return true;
  }

  stop() {
    this.shouldRun = false;
    this.clearReconnectTimer();
    this.rejectPendingAcks({
      ok: false,
      status: 'bridge_stopped',
      error: 'Bridge client stopped',
    });
    if (this.socket) {
      try {
        this.socket.close(1000, 'client stop');
      } catch (_) {
        // Best-effort close only.
      }
      this.socket = null;
    }
    this.connected = false;
    this.registered = false;
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    if (!this.isConfigured()) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delayMs = getReconnectDelayMs(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    log.warn('Bridge', `Relay disconnected. Reconnecting in ${delayMs}ms`);
  }

  connect() {
    if (!this.shouldRun || !this.isConfigured()) return false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return true;
    }

    this.clearReconnectTimer();
    const ws = new WebSocket(this.relayUrl);
    this.socket = ws;
    this.connected = false;
    this.registered = false;

    ws.on('open', () => {
      this.connected = true;
      this.registered = false;
      this.sendRaw({
        type: 'register',
        deviceId: this.deviceId,
        sharedSecret: this.sharedSecret,
      });
    });

    ws.on('message', (raw) => {
      this.handleIncoming(raw).catch((err) => {
        log.warn('Bridge', `Failed handling relay message: ${err.message}`);
      });
    });

    ws.on('close', () => {
      this.connected = false;
      this.registered = false;
      if (this.socket === ws) {
        this.socket = null;
      }
      this.rejectPendingAcks({
        ok: false,
        status: 'bridge_disconnected',
        error: 'Relay connection closed',
      });
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.warn('Bridge', `Relay connection error: ${err.message}`);
    });

    return true;
  }

  parseMessage(raw) {
    try {
      const decoded = raw?.toString?.() || '';
      return JSON.parse(decoded);
    } catch (_) {
      return null;
    }
  }

  sendRaw(payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.warn('Bridge', `Failed sending relay payload: ${err.message}`);
      return false;
    }
  }

  rejectPendingAcks(result = {}) {
    const normalized = buildAckResult(result);
    for (const [messageId, entry] of this.pendingAcks.entries()) {
      this.pendingAcks.delete(messageId);
      clearTimeout(entry.timeout);
      entry.resolve(normalized);
    }
  }

  async handleIncoming(raw) {
    const message = this.parseMessage(raw);
    if (!message || typeof message !== 'object') return;

    if (message.type === 'register-ack') {
      if (message.ok) {
        this.registered = true;
        this.reconnectAttempt = 0;
        log.info('Bridge', `Connected to relay as ${this.deviceId}`);
      } else {
        this.registered = false;
        log.warn('Bridge', `Relay registration rejected: ${asNonEmptyString(message.error) || 'unknown_error'}`);
      }
      return;
    }

    if (message.type === 'xack') {
      const messageId = asNonEmptyString(message.messageId);
      if (!messageId) return;
      const pending = this.pendingAcks.get(messageId);
      if (!pending) return;
      this.pendingAcks.delete(messageId);
      clearTimeout(pending.timeout);
      pending.resolve(buildAckResult({
        ok: message.ok === true,
        accepted: message.accepted === true || message.ok === true,
        queued: message.queued === true || message.accepted === true || message.ok === true,
        verified: message.verified === true || message.ok === true,
        status: asNonEmptyString(message.status) || (message.ok ? 'bridge_delivered' : 'bridge_failed'),
        error: asNonEmptyString(message.error) || null,
        fromDevice: asNonEmptyString(message.fromDevice),
        toDevice: asNonEmptyString(message.toDevice),
      }));
      return;
    }

    if (message.type === 'xdeliver') {
      await this.handleInboundDelivery(message);
      return;
    }
  }

  async handleInboundDelivery(message = {}) {
    const messageId = asNonEmptyString(message.messageId);
    const fromDevice = normalizeDeviceId(message.fromDevice) || 'UNKNOWN';
    const content = asNonEmptyString(message.content);
    let result = {
      ok: false,
      status: 'bridge_handler_missing',
      error: 'No inbound bridge handler registered',
    };

    if (typeof this.onMessage === 'function') {
      try {
        const inboundResult = await this.onMessage({
          messageId,
          fromDevice,
          toDevice: this.deviceId,
          content,
          fromRole: asNonEmptyString(message.fromRole) || 'architect',
          metadata: (message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata))
            ? message.metadata
            : null,
        });
        result = buildAckResult({
          ok: Boolean(inboundResult?.ok),
          accepted: Boolean(inboundResult?.accepted),
          queued: Boolean(inboundResult?.queued),
          verified: Boolean(inboundResult?.verified),
          status: asNonEmptyString(inboundResult?.status) || (inboundResult?.ok ? 'bridge_delivered' : 'bridge_delivery_failed'),
          error: asNonEmptyString(inboundResult?.error) || null,
          fromDevice,
          toDevice: this.deviceId,
        });
      } catch (err) {
        result = buildAckResult({
          ok: false,
          status: 'bridge_handler_error',
          error: err.message,
          fromDevice,
          toDevice: this.deviceId,
        });
      }
    }

    this.sendRaw({
      type: 'xack',
      messageId,
      ok: result.ok,
      accepted: result.accepted,
      queued: result.queued,
      verified: result.verified,
      status: result.status,
      error: result.error,
      fromDevice,
      toDevice: this.deviceId,
    });
  }

  sendToDevice(payload = {}) {
    const messageId = asNonEmptyString(payload.messageId);
    const toDevice = normalizeDeviceId(payload.toDevice);
    const content = asNonEmptyString(payload.content);
    const fromRole = asNonEmptyString(payload.fromRole) || 'architect';
    const timeoutMs = parsePositiveInt(payload.timeoutMs, DEFAULT_ACK_TIMEOUT_MS);
    const metadata = (payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata))
      ? payload.metadata
      : null;

    if (!messageId) {
      return Promise.resolve(buildAckResult({
        ok: false,
        status: 'bridge_invalid_message_id',
        error: 'messageId is required',
      }));
    }
    if (!toDevice) {
      return Promise.resolve(buildAckResult({
        ok: false,
        status: 'bridge_invalid_target',
        error: 'toDevice is required',
      }));
    }
    if (!content) {
      return Promise.resolve(buildAckResult({
        ok: false,
        status: 'bridge_empty_content',
        error: 'content is required',
      }));
    }
    if (!this.isReady()) {
      return Promise.resolve(buildAckResult({
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay is not connected',
      }));
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(messageId);
        resolve(buildAckResult({
          ok: false,
          status: 'bridge_ack_timeout',
          error: `No relay ACK within ${timeoutMs}ms`,
          toDevice,
        }));
      }, timeoutMs);

      this.pendingAcks.set(messageId, { resolve, timeout });
      const sent = this.sendRaw({
        type: 'xsend',
        messageId,
        fromDevice: this.deviceId,
        toDevice,
        fromRole,
        content,
        metadata,
      });

      if (!sent) {
        this.pendingAcks.delete(messageId);
        clearTimeout(timeout);
        resolve(buildAckResult({
          ok: false,
          status: 'bridge_send_failed',
          error: 'Failed to send payload to relay',
          toDevice,
        }));
      }
    });
  }
}

function createBridgeClient(options = {}) {
  return new BridgeClient(options);
}

module.exports = {
  BridgeClient,
  createBridgeClient,
};
