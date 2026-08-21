/**
 * Owns WebSocket startup status and retry bookkeeping for the main process.
 *
 * Message routing remains in SquidRunApp. This module is deliberately limited
 * to the small lifecycle seam around starting, reporting, retrying, and
 * clearing the WebSocket server so startup ordering stays visible in the app.
 */

const log = require('../logger');
const websocketServer = require('../websocket-server');

const DEFAULT_RETRY_BASE_MS = Number.parseInt(
  process.env.SQUIDRUN_WEBSOCKET_START_RETRY_BASE_MS || '500',
  10
);
const DEFAULT_RETRY_MAX_MS = Number.parseInt(
  process.env.SQUIDRUN_WEBSOCKET_START_RETRY_MAX_MS || '10000',
  10
);

class WebSocketStartupLifecycle {
  constructor(dependencies = {}) {
    this.server = dependencies.websocketServer || websocketServer;
    this.log = dependencies.log || log;
    this.resolvePortInfo = dependencies.resolvePortInfo || (() => ({
      port: this.server.DEFAULT_PORT,
      source: null,
    }));
    this.getSettings = dependencies.getSettings || (() => null);
    this.refreshStartupHealth = dependencies.refreshStartupHealth || null;
    this.getCurrentSessionNumber = dependencies.getCurrentSessionNumber || (() => null);
    this.isShuttingDown = dependencies.isShuttingDown || (() => false);
    this.setTimeoutFn = dependencies.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeoutFn || clearTimeout;
    this.retryBaseMs = dependencies.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = dependencies.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.startRetryTimer = null;
    this.startRetryAttempt = 0;
    this.startupStatus = null;
  }

  clearStartRetry() {
    if (this.startRetryTimer) {
      this.clearTimeoutFn(this.startRetryTimer);
      this.startRetryTimer = null;
    }
    this.startRetryAttempt = 0;
  }

  resolveRuntimePortInfo() {
    return this.resolvePortInfo();
  }

  buildStatusPatch(status = this.startupStatus) {
    const resolved = this.resolveRuntimePortInfo();
    const websocketClients = typeof this.server.getClients === 'function'
      ? this.server.getClients()
      : [];
    const running = typeof this.server.isRunning === 'function'
      ? this.server.isRunning()
      : false;
    const boundPort = typeof this.server.getPort === 'function'
      ? this.server.getPort()
      : null;
    const desiredPort = Number(
      status?.desiredPort || status?.port || resolved.port || this.server.DEFAULT_PORT || 0
    ) || null;
    const statusPatch = {
      running,
      port: boundPort || desiredPort,
      desiredPort,
      source: status?.source || resolved.source || null,
      clientCount: Array.isArray(websocketClients) ? websocketClients.length : 0,
      status: running ? 'running' : (status?.status || 'starting'),
      lastUpdatedAt: new Date().toISOString(),
    };
    if (status?.warning) statusPatch.warning = status.warning;
    if (status?.error) statusPatch.error = status.error;
    if (status?.code) statusPatch.code = status.code;
    return statusPatch;
  }

  writeStatus(status = this.startupStatus) {
    const settings = this.getSettings();
    if (!settings || typeof settings.writeAppStatus !== 'function') return;
    settings.writeAppStatus({
      statusPatch: {
        websocket: this.buildStatusPatch(status),
      },
    });
  }

  recordStartSuccess(portInfo = this.resolveRuntimePortInfo()) {
    this.startupStatus = {
      ok: true,
      status: 'running',
      port: portInfo.port,
      desiredPort: portInfo.port,
      source: portInfo.source || null,
      warning: null,
      error: null,
      code: null,
    };
    this.writeStatus(this.startupStatus);
  }

  recordStartFailure(err, portInfo = this.resolveRuntimePortInfo()) {
    this.startupStatus = {
      ok: false,
      status: 'bind_failed',
      port: Number(err?.port || portInfo.port || this.server.DEFAULT_PORT || 0) || null,
      desiredPort: Number(portInfo.port || err?.port || this.server.DEFAULT_PORT || 0) || null,
      source: portInfo.source || null,
      warning: 'websocket_bind_failed',
      error: err?.message || 'unknown_error',
      code: err?.code || null,
    };
    this.writeStatus(this.startupStatus);
  }

  refreshStartupHealthAfterFailure() {
    if (typeof this.refreshStartupHealth !== 'function') return;
    void this.refreshStartupHealth({
      sessionNumber: this.getCurrentSessionNumber(),
    }).catch((healthErr) => {
      this.log.warn('StartupHealth', `WebSocket bind failure health refresh failed: ${healthErr.message}`);
    });
  }

  isRetryableStartError(err) {
    const message = String(err?.message || '');
    return (
      message.includes('EADDRINUSE')
      || message.includes('address already in use')
      || message.includes('EACCES')
      || message.includes('comms worker exited')
      || message.includes('comms worker timeout')
    );
  }

  getStartRetryDelayMs(attempt) {
    const baseMs = Number.isFinite(this.retryBaseMs) && this.retryBaseMs > 0
      ? this.retryBaseMs
      : 500;
    const maxMs = Number.isFinite(this.retryMaxMs) && this.retryMaxMs > 0
      ? this.retryMaxMs
      : 10000;
    const exponent = Math.max(0, Number(attempt || 1) - 1);
    return Math.min(maxMs, baseMs * Math.pow(2, exponent));
  }

  scheduleStartRetry(startOptions, err) {
    if (this.isShuttingDown()) return;
    if (!startOptions || !this.isRetryableStartError(err)) return;
    if (this.startRetryTimer) return;

    this.startRetryAttempt += 1;
    const attempt = this.startRetryAttempt;
    const delayMs = this.getStartRetryDelayMs(attempt);
    this.log.warn('WebSocket', `Retrying server start in ${delayMs}ms (attempt ${attempt + 1})`);
    this.startRetryTimer = this.setTimeoutFn(async () => {
      this.startRetryTimer = null;
      if (this.isShuttingDown()) return;
      try {
        await this.server.start(startOptions);
        this.clearStartRetry();
        this.recordStartSuccess({
          port: startOptions.port,
          source: startOptions.portSource || this.startupStatus?.source || null,
        });
        this.log.info('WebSocket', 'Server start recovery succeeded');
      } catch (retryErr) {
        this.log.error('WebSocket', `Failed to start server: ${retryErr.message}`);
        this.recordStartFailure(retryErr, {
          port: startOptions.port,
          source: startOptions.portSource || this.startupStatus?.source || null,
        });
        this.scheduleStartRetry(startOptions, retryErr);
      }
    }, delayMs);
  }

  getState() {
    return {
      startRetryTimer: this.startRetryTimer,
      startRetryAttempt: this.startRetryAttempt,
      startupStatus: this.startupStatus,
    };
  }
}

function createWebSocketStartupLifecycle(dependencies = {}) {
  return new WebSocketStartupLifecycle(dependencies);
}

module.exports = {
  WebSocketStartupLifecycle,
  createWebSocketStartupLifecycle,
};
