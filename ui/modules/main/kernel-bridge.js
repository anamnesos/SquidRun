/**
 * Event Kernel bridge (main process)
 * Bridges daemon event envelopes to renderer via IPC with transport metadata.
 */

const crypto = require('crypto');
const log = require('../logger');

const BRIDGE_VERSION = 1;
const BRIDGE_EVENT_CHANNEL = 'kernel:bridge-event';
const BRIDGE_STATS_CHANNEL = 'kernel:bridge-stats';

function generateId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

class KernelBridge {
  constructor(getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.bridgeSeq = 0;
    this.bridgeSourceSeq = 0;
    this.pendingDrops = new Map(); // key -> { stage, reason, droppedCount, oldestSeq, newestSeq }
    this.stats = {
      forwardedCount: 0,
      droppedCount: 0,
      lastBridgeSeq: 0,
      lastForwardedAt: 0,
      lastDroppedAt: 0,
    };
  }

  _nextBridgeSeq() {
    this.bridgeSeq += 1;
    return this.bridgeSeq;
  }

  _nextBridgeSourceSeq() {
    this.bridgeSourceSeq += 1;
    return this.bridgeSourceSeq;
  }

  _getMainWindow() {
    if (typeof this.getMainWindow !== 'function') return null;
    const window = this.getMainWindow();
    if (!window || typeof window.isDestroyed !== 'function' || window.isDestroyed()) {
      return null;
    }
    if (!window.webContents) {
      return null;
    }
    return window;
  }

  _buildEnvelope(event, direction) {
    const bridgeSeq = this._nextBridgeSeq();
    this.stats.lastBridgeSeq = bridgeSeq;
    return {
      bridgeVersion: BRIDGE_VERSION,
      bridgeSeq,
      bridgeTs: Date.now(),
      direction,
      event,
    };
  }

  _buildBridgeEvent(type, payload = {}, paneId = 'system') {
    return {
      eventId: generateId(),
      correlationId: generateId(),
      causationId: null,
      type,
      source: 'bridge',
      paneId: String(paneId || 'system'),
      ts: Date.now(),
      seq: this._nextBridgeSourceSeq(),
      payload,
    };
  }

  _sendEnvelope(window, envelope) {
    try {
      window.webContents.send(BRIDGE_EVENT_CHANNEL, envelope);
      return true;
    } catch (err) {
      log.warn('KernelBridge', `Failed to send ${BRIDGE_EVENT_CHANNEL}: ${err.message}`);
      return false;
    }
  }

  _sendStats(window) {
    try {
      window.webContents.send(BRIDGE_STATS_CHANNEL, {
        bridgeVersion: BRIDGE_VERSION,
        ...this.stats,
        pendingDropGroups: this.pendingDrops.size,
      });
    } catch (err) {
      log.warn('KernelBridge', `Failed to send ${BRIDGE_STATS_CHANNEL}: ${err.message}`);
    }
  }

  _recordDrop(stage, reason, bridgeSeq) {
    const key = `${stage}:${reason}`;
    const existing = this.pendingDrops.get(key);
    if (existing) {
      existing.droppedCount += 1;
      existing.newestSeq = bridgeSeq;
    } else {
      this.pendingDrops.set(key, {
        stage,
        reason,
        droppedCount: 1,
        oldestSeq: bridgeSeq,
        newestSeq: bridgeSeq,
      });
    }

    this.stats.droppedCount += 1;
    this.stats.lastDroppedAt = Date.now();
  }

  _flushDropSummaries(window) {
    if (this.pendingDrops.size === 0) return true;

    const entries = Array.from(this.pendingDrops.values());
    for (const entry of entries) {
      const droppedEvent = this._buildBridgeEvent('event.dropped', {
        stage: entry.stage,
        reason: entry.reason,
        droppedCount: entry.droppedCount,
        oldestSeq: entry.oldestSeq,
        newestSeq: entry.newestSeq,
      });
      const envelope = this._buildEnvelope(droppedEvent, 'main->renderer');
      const ok = this._sendEnvelope(window, envelope);
      if (!ok) {
        return false;
      }
    }

    this.pendingDrops.clear();
    return true;
  }

  _sendWithBookkeeping(event, direction) {
    const envelope = this._buildEnvelope(event, direction);
    const window = this._getMainWindow();

    if (!window) {
      this._recordDrop('bridge', 'renderer_unavailable', envelope.bridgeSeq);
      return false;
    }

    if (!this._flushDropSummaries(window)) {
      this._recordDrop('bridge', 'renderer_send_failed', envelope.bridgeSeq);
      return false;
    }

    const sent = this._sendEnvelope(window, envelope);
    if (!sent) {
      this._recordDrop('bridge', 'renderer_send_failed', envelope.bridgeSeq);
      return false;
    }

    this.stats.forwardedCount += 1;
    this.stats.lastForwardedAt = Date.now();
    this._sendStats(window);
    return true;
  }

  emitBridgeEvent(type, payload = {}, paneId = 'system') {
    const event = this._buildBridgeEvent(type, payload, paneId);
    return this._sendWithBookkeeping(event, 'main->renderer');
  }

  forwardDaemonEvent(event) {
    if (!event || typeof event !== 'object' || !event.type) {
      return false;
    }
    return this._sendWithBookkeeping(event, 'daemon->renderer');
  }

  getStats() {
    return {
      bridgeVersion: BRIDGE_VERSION,
      ...this.stats,
      pendingDropGroups: this.pendingDrops.size,
    };
  }
}

function createKernelBridge(getMainWindow) {
  return new KernelBridge(getMainWindow);
}

module.exports = {
  KernelBridge,
  createKernelBridge,
  BRIDGE_VERSION,
  BRIDGE_EVENT_CHANNEL,
  BRIDGE_STATS_CHANNEL,
};

