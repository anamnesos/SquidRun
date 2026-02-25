const WebSocket = require('ws');
const log = require('./logger');
const {
  normalizeDeviceId,
} = require('./cross-device-target');

const DEFAULT_ACK_TIMEOUT_MS = 12000;
const DEFAULT_RECONNECT_BASE_MS = 750;
const DEFAULT_RECONNECT_MAX_MS = 10000;
const SENSITIVE_ENV_KEYWORDS_RE = /(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
const SENSITIVE_JSON_KEY_RE = /^(token|secret|password|pass|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential|cookie|session)$/i;
const SENSITIVE_PATH_SEGMENT_RE = /(^|[\\/])(\.env(\.[^\\/]+)?|id_rsa|id_dsa|credentials(\.[^\\/]+)?|token|secret|passwords?)([\\/]|$)/i;
const STRUCTURED_BRIDGE_TYPE_ALIASES = Object.freeze({
  fyi: 'FYI',
  conflictcheck: 'ConflictCheck',
  blocker: 'Blocker',
  approval: 'Approval',
  conflictresult: 'ConflictResult',
  approvalresult: 'ApprovalResult',
});

function asNonEmptyString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactSensitiveText(input) {
  if (typeof input !== 'string' || !input) return input;
  let redacted = input;

  redacted = redacted.replace(
    /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    (_match, protocol, user) => `${protocol}${user}:[REDACTED]@`
  );

  redacted = redacted.replace(
    /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    '$1 [REDACTED_TOKEN]'
  );

  redacted = redacted.replace(
    /\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gi,
    '[REDACTED_TOKEN]'
  );

  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;]+)/g,
    (match, key) => (SENSITIVE_ENV_KEYWORDS_RE.test(String(key)) ? `${key}=[REDACTED]` : match)
  );

  redacted = redacted.replace(
    /(["'])([A-Za-z0-9_-]+)\1\s*:\s*(["'])([^"']*)(\3)/g,
    (match, quoteA, key, quoteB) => (SENSITIVE_JSON_KEY_RE.test(String(key))
      ? `${quoteA}${key}${quoteA}:${quoteB}[REDACTED]${quoteB}`
      : match)
  );

  redacted = redacted.replace(
    /((?:[A-Za-z]:\\|\/)[^\s"'`]+)/g,
    (segment) => (SENSITIVE_PATH_SEGMENT_RE.test(segment) ? '[REDACTED_PATH]' : segment)
  );

  return redacted;
}

function redactSensitiveValue(input, seen = new WeakSet()) {
  if (typeof input === 'string') {
    return redactSensitiveText(input);
  }
  if (!input || typeof input !== 'object') return input;
  if (seen.has(input)) return input;
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveValue(item, seen));
  }

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && SENSITIVE_JSON_KEY_RE.test(String(key))) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactSensitiveValue(value, seen);
    }
  }
  return output;
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

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function normalizeStructuredBridgeType(typeInput) {
  const key = asNonEmptyString(typeInput).toLowerCase();
  if (!key) return null;
  return STRUCTURED_BRIDGE_TYPE_ALIASES[key] || null;
}

function normalizeStructuredBridgeMessage(structuredInput, fallbackContent = '') {
  const structured = asObject(structuredInput);
  if (!structured) return null;

  const normalizedType = normalizeStructuredBridgeType(structured.type);
  const payloadInput = asObject(structured.payload);
  const payload = payloadInput ? { ...payloadInput } : {};
  if (normalizedType) {
    return { type: normalizedType, payload };
  }

  const originalType = asNonEmptyString(structured.type) || null;
  return {
    type: 'FYI',
    payload: {
      category: asNonEmptyString(payload.category) || 'status',
      detail: asNonEmptyString(payload.detail) || asNonEmptyString(fallbackContent) || 'Structured message update',
      impact: asNonEmptyString(payload.impact) || 'context-only',
      ...payload,
      originalType,
    },
  };
}

function normalizeBridgeMetadata(metadataInput, fallbackContent = '', options = {}) {
  const ensureStructured = options && options.ensureStructured === true;
  const metadata = asObject(metadataInput);
  const normalized = metadata ? { ...metadata } : {};

  if (ensureStructured || Object.prototype.hasOwnProperty.call(normalized, 'structured')) {
    const structured = normalizeStructuredBridgeMessage(normalized.structured, fallbackContent);
    normalized.structured = structured || {
      type: 'FYI',
      payload: {
        category: 'status',
        detail: asNonEmptyString(fallbackContent) || 'Structured message update',
        impact: 'context-only',
        originalType: null,
      },
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

class BridgeClient {
  constructor(options = {}) {
    this.relayUrl = asNonEmptyString(options.relayUrl);
    this.deviceId = normalizeDeviceId(options.deviceId);
    this.sharedSecret = asNonEmptyString(options.sharedSecret);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.shouldRun = false;
    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.pendingAcks = new Map();
  }

  emitStatus(status = {}) {
    if (typeof this.onStatus !== 'function') return;
    try {
      this.onStatus({
        ts: Date.now(),
        relayUrl: this.relayUrl,
        deviceId: this.deviceId,
        ...(status && typeof status === 'object' ? status : {}),
      });
    } catch (err) {
      log.warn('Bridge', `Failed to emit bridge status: ${err.message}`);
    }
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
    this.emitStatus({
      type: 'relay.disconnected',
      state: 'disconnected',
      status: 'relay_stopped',
    });
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
    this.emitStatus({
      type: 'relay.connecting',
      state: 'connecting',
      status: 'relay_connecting',
    });
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
      this.emitStatus({
        type: 'relay.disconnected',
        state: 'disconnected',
        status: 'relay_disconnected',
      });
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.warn('Bridge', `Relay connection error: ${err.message}`);
      this.emitStatus({
        type: 'relay.error',
        state: 'error',
        status: 'relay_error',
        error: err.message,
      });
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
        this.emitStatus({
          type: 'relay.connected',
          state: 'connected',
          status: 'relay_connected',
        });
      } else {
        this.registered = false;
        log.warn('Bridge', `Relay registration rejected: ${asNonEmptyString(message.error) || 'unknown_error'}`);
        this.emitStatus({
          type: 'relay.error',
          state: 'error',
          status: 'relay_registration_rejected',
          error: asNonEmptyString(message.error) || 'unknown_error',
        });
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
      this.emitStatus({
        type: 'relay.dispatch',
        state: message.ok === true ? 'connected' : 'error',
        status: asNonEmptyString(message.status) || (message.ok ? 'bridge_delivered' : 'bridge_failed'),
        ok: message.ok === true,
        accepted: message.accepted === true || message.ok === true,
        queued: message.queued === true || message.accepted === true || message.ok === true,
        verified: message.verified === true || message.ok === true,
        messageId,
        fromDevice: asNonEmptyString(message.fromDevice),
        toDevice: asNonEmptyString(message.toDevice),
        error: asNonEmptyString(message.error) || null,
      });
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
    const normalizedMetadata = normalizeBridgeMetadata(message.metadata, content, {
      ensureStructured: true,
    });
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
          metadata: normalizedMetadata,
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
    const redactedContent = redactSensitiveText(content);
    const fromRole = asNonEmptyString(payload.fromRole) || 'architect';
    const targetRole = (asNonEmptyString(payload.targetRole) || 'architect').toLowerCase();
    const timeoutMs = parsePositiveInt(payload.timeoutMs, DEFAULT_ACK_TIMEOUT_MS);
    const metadata = redactSensitiveValue(normalizeBridgeMetadata(payload.metadata, redactedContent, {
      ensureStructured: true,
    }));

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
        targetRole,
        content: redactedContent,
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
  normalizeStructuredBridgeType,
  normalizeStructuredBridgeMessage,
  normalizeBridgeMetadata,
};
