/**
 * Triggers - Reliability Metrics
 * Extracted from triggers.js
 */

const { PANE_IDS } = require('../../config');
const { formatDuration } = require('../formatters');

// ============================================================
// RELIABILITY METRICS
// ============================================================

const ROLLING_WINDOW_15M = 15 * 60 * 1000;
const ROLLING_WINDOW_1H = 60 * 60 * 1000;

// Event log for time-windowed analysis
const metricsEventLog = [];
const MAX_METRICS_EVENTS = 2000;

// Aggregate stats since app start
const reliabilityStats = {
  startTime: Date.now(),
  aggregate: {
    sent: 0,
    delivered: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,  // duplicates
    retries: 0,
  },
  byMode: {
    pty: { sent: 0, delivered: 0, failed: 0, timedOut: 0 },
  },
  byPane: {},  // paneId -> { sent, delivered, failed }
  byType: {
    trigger: { sent: 0, delivered: 0, failed: 0 },
    broadcast: { sent: 0, delivered: 0, failed: 0 },
    direct: { sent: 0, delivered: 0, failed: 0 },
  },
  latency: {
    samples: [],  // { queuedAt, sentAt, ackedAt }
    maxSamples: 100,
  },
};

// Initialize per-pane stats
PANE_IDS.forEach(id => {
  reliabilityStats.byPane[id] = { sent: 0, delivered: 0, failed: 0 };
});

/**
 * Record a metrics event for time-windowed analysis
 */
function recordMetricsEvent(type, data) {
  const event = {
    timestamp: Date.now(),
    type,
    ...data,
  };
  metricsEventLog.push(event);
  if (metricsEventLog.length > MAX_METRICS_EVENTS) {
    metricsEventLog.shift();
  }
}

/**
 * Get events within a time window
 */
function getEventsInWindow(windowMs) {
  const cutoff = Date.now() - windowMs;
  return metricsEventLog.filter(e => e.timestamp >= cutoff);
}

/**
 * Calculate stats from events in a window
 */
function calculateWindowStats(windowMs) {
  const events = getEventsInWindow(windowMs);
  const stats = { sent: 0, delivered: 0, failed: 0, timedOut: 0, skipped: 0 };

  events.forEach(e => {
    if (e.type === 'sent') stats.sent++;
    else if (e.type === 'delivered') stats.delivered++;
    else if (e.type === 'failed') stats.failed++;
    else if (e.type === 'timeout') stats.timedOut++;
    else if (e.type === 'skipped') stats.skipped++;
  });

  return stats;
}

/**
 * Record message sent
 */
function recordSent(mode, msgType, panes, queuedAt = null) {
  const sentAt = Date.now();
  reliabilityStats.aggregate.sent++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].sent++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].sent++;
  }

  panes.forEach(paneId => {
    if (reliabilityStats.byPane[paneId]) {
      reliabilityStats.byPane[paneId].sent++;
    }
  });

  recordMetricsEvent('sent', { mode, msgType, panes, queuedAt, sentAt });

  return { sentAt, queuedAt };
}

/**
 * Record successful delivery
 */
function recordDelivered(mode, msgType, paneId, sentAt = null) {
  const ackedAt = Date.now();
  reliabilityStats.aggregate.delivered++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].delivered++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].delivered++;
  }
  if (reliabilityStats.byPane[paneId]) {
    reliabilityStats.byPane[paneId].delivered++;
  }

  // Track latency if we have sentAt
  if (sentAt) {
    const latency = ackedAt - sentAt;
    reliabilityStats.latency.samples.push({ sentAt, ackedAt, latency });
    if (reliabilityStats.latency.samples.length > reliabilityStats.latency.maxSamples) {
      reliabilityStats.latency.samples.shift();
    }
  }

  recordMetricsEvent('delivered', { mode, msgType, paneId, sentAt, ackedAt });
}

/**
 * Record failed delivery
 */
function recordFailed(mode, msgType, paneId, reason) {
  reliabilityStats.aggregate.failed++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].failed++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].failed++;
  }
  if (reliabilityStats.byPane[paneId]) {
    reliabilityStats.byPane[paneId].failed++;
  }

  recordMetricsEvent('failed', { mode, msgType, paneId, reason });
}

/**
 * Record delivery timeout
 */
function recordTimeout(mode, msgType, panes) {
  reliabilityStats.aggregate.timedOut++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].timedOut++;
  }

  recordMetricsEvent('timeout', { mode, msgType, panes });
}

/**
 * Record skipped (duplicate) message
 */
function recordSkipped(sender, seq, recipient) {
  reliabilityStats.aggregate.skipped++;
  recordMetricsEvent('skipped', { sender, seq, recipient });
}

/**
 * Get comprehensive reliability statistics
 */
function getReliabilityStats() {
  const now = Date.now();
  const uptime = now - reliabilityStats.startTime;

  // Calculate average latency
  const latencySamples = reliabilityStats.latency.samples;
  let avgLatency = 0;
  let minLatency = 0;
  let maxLatency = 0;

  if (latencySamples.length > 0) {
    const latencies = latencySamples.map(s => s.latency);
    avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    minLatency = Math.min(...latencies);
    maxLatency = Math.max(...latencies);
  }

  // Calculate success rate
  const { sent, delivered } = reliabilityStats.aggregate;
  const successRate = sent > 0 ? Math.round((delivered / sent) * 100) : 100;

  return {
    uptime,
    uptimeFormatted: formatDuration(uptime),
    aggregate: { ...reliabilityStats.aggregate, successRate },
    byMode: { ...reliabilityStats.byMode },
    byPane: { ...reliabilityStats.byPane },
    byType: { ...reliabilityStats.byType },
    latency: {
      avg: avgLatency,
      min: minLatency,
      max: maxLatency,
      sampleCount: latencySamples.length,
    },
    windows: {
      last15m: calculateWindowStats(ROLLING_WINDOW_15M),
      last1h: calculateWindowStats(ROLLING_WINDOW_1H),
    },
  };
}

module.exports = {
  recordSent,
  recordDelivered,
  recordFailed,
  recordTimeout,
  recordSkipped,
  getReliabilityStats,
};
