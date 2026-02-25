const WebSocket = require('ws');
const log = require('./logger');
const {
  normalizeDeviceId,
} = require('./cross-device-target');

const DEFAULT_ACK_TIMEOUT_MS = 12000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_PAIRING_TIMEOUT_MS = 12000;
const DEFAULT_RECONNECT_BASE_MS = 750;
const DEFAULT_RECONNECT_MAX_MS = 10000;
const DEFAULT_PING_INTERVAL_MS = 30000;
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

function normalizeConnectedDevices(input) {
  if (!Array.isArray(input)) return [];
  const normalized = new Set();
  for (const value of input) {
    const deviceId = normalizeDeviceId(value);
    if (deviceId) normalized.add(deviceId);
  }
  return Array.from(normalized).sort();
}

function normalizeRoleList(input) {
  if (!Array.isArray(input)) return [];
  const normalized = new Set();
  for (const value of input) {
    const role = asNonEmptyString(value).toLowerCase();
    if (role) normalized.add(role);
  }
  return Array.from(normalized).sort();
}

function normalizeDiscoveryEntry(input = {}) {
  const entry = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const deviceId = normalizeDeviceId(entry.device_id || entry.deviceId || entry.id);
  if (!deviceId) return null;
  return {
    device_id: deviceId,
    roles: normalizeRoleList(entry.roles),
    connected_since: asNonEmptyString(entry.connected_since || entry.connectedSince || entry.connected_at || entry.connectedAt) || null,
  };
}

function normalizeDiscoveryDevices(input) {
  if (!Array.isArray(input)) return [];
  const normalized = new Map();
  for (const entry of input) {
    const device = normalizeDiscoveryEntry(entry);
    if (!device) continue;
    normalized.set(device.device_id, device);
  }
  return Array.from(normalized.values()).sort((a, b) => a.device_id.localeCompare(b.device_id));
}

function buildAckResult(input = {}) {
  const unknownDevice = normalizeDeviceId(input.unknownDevice);
  const connectedDevices = normalizeConnectedDevices(input.connectedDevices);
  return {
    ok: input.ok === true,
    accepted: input.accepted === true || input.ok === true,
    queued: input.queued === true || input.accepted === true || input.ok === true,
    verified: input.verified === true || input.ok === true,
    status: asNonEmptyString(input.status) || (input.ok ? 'bridge_delivered' : 'bridge_failed'),
    error: asNonEmptyString(input.error) || null,
    fromDevice: asNonEmptyString(input.fromDevice) || null,
    toDevice: asNonEmptyString(input.toDevice) || null,
    unknownDevice: unknownDevice || null,
    connectedDevices,
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
    this.onPairing = typeof options.onPairing === 'function' ? options.onPairing : null;
    this.shouldRun = false;
    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;
    this.pendingAcks = new Map();
    this.pendingDiscoveries = new Map();
    this.pendingPairingInit = null;
    this.pendingPairingJoin = null;
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
    this.clearPingTimer();
    this.rejectPendingAcks({
      ok: false,
      status: 'bridge_stopped',
      error: 'Bridge client stopped',
    });
    this.rejectPendingDiscoveries({
      ok: false,
      status: 'bridge_stopped',
      error: 'Bridge client stopped',
      devices: [],
    });
    this.rejectPendingPairing({
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

  clearPingTimer() {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  startPingLoop() {
    this.clearPingTimer();
    const pingIntervalMs = parsePositiveInt(process.env.SQUIDRUN_BRIDGE_PING_INTERVAL_MS, DEFAULT_PING_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      if (!this.isReady()) return;
      this.sendRaw({
        type: 'ping',
        ts: Date.now(),
      });
    }, pingIntervalMs);
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
      this.clearPingTimer();
      if (this.socket === ws) {
        this.socket = null;
      }
      this.rejectPendingAcks({
        ok: false,
        status: 'bridge_disconnected',
        error: 'Relay connection closed',
      });
      this.rejectPendingDiscoveries({
        ok: false,
        status: 'bridge_disconnected',
        error: 'Relay connection closed',
        devices: [],
      });
      this.rejectPendingPairing({
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

  rejectPendingDiscoveries(result = {}) {
    const normalized = {
      ok: result.ok === true,
      status: asNonEmptyString(result.status) || (result.ok === true ? 'bridge_discovery_ok' : 'bridge_discovery_failed'),
      error: asNonEmptyString(result.error) || null,
      devices: normalizeDiscoveryDevices(result.devices),
      fetchedAt: Number.isFinite(result.fetchedAt) ? result.fetchedAt : Date.now(),
    };
    for (const [requestId, entry] of this.pendingDiscoveries.entries()) {
      this.pendingDiscoveries.delete(requestId);
      clearTimeout(entry.timeout);
      entry.resolve(normalized);
    }
  }

  rejectPendingPairing(result = {}) {
    const normalized = {
      ok: result.ok === true,
      status: asNonEmptyString(result.status) || (result.ok === true ? 'pairing_ok' : 'pairing_failed'),
      error: asNonEmptyString(result.error) || null,
      reason: asNonEmptyString(result.reason) || null,
      code: asNonEmptyString(result.code) || null,
      expiresAt: Number.isFinite(result.expiresAt) ? result.expiresAt : null,
      paired: result.paired && typeof result.paired === 'object' ? result.paired : null,
    };
    if (this.pendingPairingInit) {
      const entry = this.pendingPairingInit;
      this.pendingPairingInit = null;
      clearTimeout(entry.timeout);
      entry.resolve(normalized);
    }
    if (this.pendingPairingJoin) {
      const entry = this.pendingPairingJoin;
      this.pendingPairingJoin = null;
      clearTimeout(entry.timeout);
      entry.resolve(normalized);
    }
  }

  emitPairingUpdate(update = {}) {
    if (typeof this.onPairing !== 'function') return;
    try {
      this.onPairing({
        ts: Date.now(),
        relayUrl: this.relayUrl,
        deviceId: this.deviceId,
        ...(update && typeof update === 'object' ? update : {}),
      });
    } catch (err) {
      log.warn('Bridge', `Failed to emit pairing update: ${err.message}`);
    }
  }

  async handleIncoming(raw) {
    const message = this.parseMessage(raw);
    if (!message || typeof message !== 'object') return;

    if (message.type === 'register-ack') {
      if (message.ok) {
        this.registered = true;
        this.reconnectAttempt = 0;
        this.startPingLoop();
        log.info('Bridge', `Connected to relay as ${this.deviceId}`);
        this.emitStatus({
          type: 'relay.connected',
          state: 'connected',
          status: 'relay_connected',
        });
      } else {
        this.registered = false;
        this.clearPingTimer();
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
        unknownDevice: message.unknownDevice,
        connectedDevices: message.connectedDevices,
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
        unknownDevice: normalizeDeviceId(message.unknownDevice) || null,
        connectedDevices: normalizeConnectedDevices(message.connectedDevices),
      });
      return;
    }

    if (message.type === 'xdeliver') {
      await this.handleInboundDelivery(message);
      return;
    }

    if (message.type === 'xdiscovery') {
      const requestId = asNonEmptyString(message.requestId) || asNonEmptyString(message.request_id);
      if (!requestId) return;
      const pending = this.pendingDiscoveries.get(requestId);
      if (!pending) return;
      this.pendingDiscoveries.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: message.ok !== false,
        status: asNonEmptyString(message.status) || (message.ok === false ? 'bridge_discovery_failed' : 'bridge_discovery_ok'),
        error: asNonEmptyString(message.error) || null,
        devices: normalizeDiscoveryDevices(message.devices || message.connected_devices),
        fetchedAt: Number.isFinite(message.fetchedAt) ? message.fetchedAt : (Number.isFinite(message.fetched_at) ? message.fetched_at : Date.now()),
      });
      return;
    }

    if (message.type === 'pairing-init-ack') {
      const code = asNonEmptyString(message.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const expiresAt = Number.isFinite(message.expires_at)
        ? message.expires_at
        : (Number.isFinite(message.expiresAt) ? message.expiresAt : null);
      const result = {
        ok: true,
        status: 'pairing_init_ok',
        error: null,
        reason: null,
        code: code || null,
        expiresAt,
        paired: null,
      };
      if (this.pendingPairingInit) {
        const entry = this.pendingPairingInit;
        this.pendingPairingInit = null;
        clearTimeout(entry.timeout);
        entry.resolve(result);
      }
      this.emitPairingUpdate({
        type: 'pairing-init-ack',
        ok: true,
        status: result.status,
        code: result.code,
        expiresAt: result.expiresAt,
      });
      return;
    }

    if (message.type === 'pairing-complete') {
      const paired = {
        device_id: normalizeDeviceId(message.device_id || message.deviceId || this.deviceId) || null,
        shared_secret: asNonEmptyString(message.shared_secret || message.sharedSecret) || null,
        relay_url: asNonEmptyString(message.relay_url || message.relayUrl || this.relayUrl) || null,
        paired_device_id: normalizeDeviceId(message.paired_device_id || message.pairedDeviceId) || null,
        paired_at: new Date().toISOString(),
      };
      const result = {
        ok: Boolean(paired.device_id && paired.shared_secret && paired.relay_url),
        status: 'pairing_complete',
        error: null,
        reason: null,
        code: null,
        expiresAt: null,
        paired,
      };
      if (this.pendingPairingJoin) {
        const entry = this.pendingPairingJoin;
        this.pendingPairingJoin = null;
        clearTimeout(entry.timeout);
        entry.resolve(result);
      }
      this.emitPairingUpdate({
        type: 'pairing-complete',
        ok: result.ok,
        status: result.status,
        paired,
      });
      return;
    }

    if (message.type === 'pairing-failed') {
      const reason = asNonEmptyString(message.reason || message.error || 'unknown');
      const result = {
        ok: false,
        status: `pairing_failed_${reason || 'unknown'}`,
        error: reason || 'pairing_failed',
        reason: reason || null,
        code: null,
        expiresAt: null,
        paired: null,
      };
      if (this.pendingPairingJoin) {
        const entry = this.pendingPairingJoin;
        this.pendingPairingJoin = null;
        clearTimeout(entry.timeout);
        entry.resolve(result);
      } else if (this.pendingPairingInit) {
        const entry = this.pendingPairingInit;
        this.pendingPairingInit = null;
        clearTimeout(entry.timeout);
        entry.resolve(result);
      }
      this.emitPairingUpdate({
        type: 'pairing-failed',
        ok: false,
        status: result.status,
        reason: result.reason,
        error: result.error,
      });
      return;
    }

    if (message.type === 'error') {
      const errorText = asNonEmptyString(message.error) || 'relay_error';
      if (errorText.toLowerCase() === 'unsupported_type:xdiscovery') {
        this.rejectPendingDiscoveries({
          ok: false,
          status: 'bridge_discovery_unsupported',
          error: 'Relay does not support device discovery (xdiscovery)',
          devices: [],
        });
      }
      this.emitStatus({
        type: 'relay.error',
        state: 'error',
        status: 'relay_error',
        error: errorText,
      });
      return;
    }

    if (message.type === 'pong') {
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

  discoverDevices(options = {}) {
    const timeoutMs = parsePositiveInt(options.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
    if (!this.isReady()) {
      return Promise.resolve({
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay is not connected',
        devices: [],
        fetchedAt: Date.now(),
      });
    }

    return new Promise((resolve) => {
      const requestId = `xdiscovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeout = setTimeout(() => {
        this.pendingDiscoveries.delete(requestId);
        resolve({
          ok: false,
          status: 'bridge_discovery_timeout',
          error: `No relay discovery response within ${timeoutMs}ms`,
          devices: [],
          fetchedAt: Date.now(),
        });
      }, timeoutMs);

      this.pendingDiscoveries.set(requestId, { resolve, timeout });
      const sent = this.sendRaw({
        type: 'xdiscovery',
        requestId,
        fromDevice: this.deviceId,
      });
      if (!sent) {
        this.pendingDiscoveries.delete(requestId);
        clearTimeout(timeout);
        resolve({
          ok: false,
          status: 'bridge_discovery_send_failed',
          error: 'Failed to send discovery request to relay',
          devices: [],
          fetchedAt: Date.now(),
        });
      }
    });
  }

  initiatePairing(options = {}) {
    const timeoutMs = parsePositiveInt(options.timeoutMs, DEFAULT_PAIRING_TIMEOUT_MS);
    if (!this.isReady()) {
      return Promise.resolve({
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay is not connected',
        reason: null,
        code: null,
        expiresAt: null,
        paired: null,
      });
    }
    if (this.pendingPairingInit || this.pendingPairingJoin) {
      return Promise.resolve({
        ok: false,
        status: 'pairing_in_progress',
        error: 'Another pairing request is already in progress',
        reason: null,
        code: null,
        expiresAt: null,
        paired: null,
      });
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPairingInit = null;
        resolve({
          ok: false,
          status: 'pairing_init_timeout',
          error: `No pairing-init response within ${timeoutMs}ms`,
          reason: null,
          code: null,
          expiresAt: null,
          paired: null,
        });
      }, timeoutMs);
      this.pendingPairingInit = { resolve, timeout };
      const sent = this.sendRaw({ type: 'pairing-init' });
      if (!sent) {
        const entry = this.pendingPairingInit;
        this.pendingPairingInit = null;
        if (entry) clearTimeout(entry.timeout);
        resolve({
          ok: false,
          status: 'pairing_init_send_failed',
          error: 'Failed to send pairing-init request to relay',
          reason: null,
          code: null,
          expiresAt: null,
          paired: null,
        });
      }
    });
  }

  joinPairingCode(codeInput, options = {}) {
    const code = asNonEmptyString(codeInput).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const timeoutMs = parsePositiveInt(options.timeoutMs, DEFAULT_PAIRING_TIMEOUT_MS);
    if (!code || code.length !== 6) {
      return Promise.resolve({
        ok: false,
        status: 'pairing_invalid_code',
        error: 'Pairing code must be 6 alphanumeric characters',
        reason: 'invalid_code',
        code: null,
        expiresAt: null,
        paired: null,
      });
    }
    if (!this.isReady()) {
      return Promise.resolve({
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay is not connected',
        reason: null,
        code: null,
        expiresAt: null,
        paired: null,
      });
    }
    if (this.pendingPairingInit || this.pendingPairingJoin) {
      return Promise.resolve({
        ok: false,
        status: 'pairing_in_progress',
        error: 'Another pairing request is already in progress',
        reason: null,
        code: null,
        expiresAt: null,
        paired: null,
      });
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPairingJoin = null;
        resolve({
          ok: false,
          status: 'pairing_join_timeout',
          error: `No pairing result within ${timeoutMs}ms`,
          reason: null,
          code: null,
          expiresAt: null,
          paired: null,
        });
      }, timeoutMs);
      this.pendingPairingJoin = { resolve, timeout };
      const sent = this.sendRaw({
        type: 'pairing-join',
        code,
      });
      if (!sent) {
        const entry = this.pendingPairingJoin;
        this.pendingPairingJoin = null;
        if (entry) clearTimeout(entry.timeout);
        resolve({
          ok: false,
          status: 'pairing_join_send_failed',
          error: 'Failed to send pairing-join request to relay',
          reason: null,
          code: null,
          expiresAt: null,
          paired: null,
        });
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
