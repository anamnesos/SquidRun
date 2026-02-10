/**
 * Event Kernel - Two-lane event system for Hivemind
 * Lane A: Interaction Kernel (always-on) - pub/sub, contracts, state vectors
 * Lane B: Timeline / Telemetry (optional) - ring buffer, query
 */

const PANE_IDS = ['1', '2', '5', 'system'];

// --- ID Generation ---
let idCounter = 0;
function generateId() {
  try {
    return crypto.randomUUID();
  } catch {
    idCounter++;
    return `evt-${Date.now()}-${idCounter}`;
  }
}

// --- Lane A: Core State ---
let listeners = {};          // type -> Set<handler>
let wildcardListeners = {};  // prefix -> Set<handler>
let seqCounters = {};        // source -> monotonic seq
let contracts = [];          // registered contracts
let paneStates = {};         // paneId -> state vector
let correlationId = null;    // current active correlation
let deferQueues = {};        // paneId -> [{ event, contractId, deferredAt }]
let devMode = false;
let stats = { totalEmitted: 0, totalDropped: 0, contractViolations: 0, bufferSize: 0 };

// Safe mode tracking
let safeModeActive = false;
let violationTimestamps = [];
const SAFE_MODE_WINDOW_MS = 10000;
const SAFE_MODE_VIOLATION_THRESHOLD = 3;
const SAFE_MODE_COOLDOWN_MS = 30000;
let safeModeTimer = null;

// --- Lane B: Ring Buffer ---
let telemetryEnabled = true;
const BUFFER_MAX_SIZE = 1000;
const BUFFER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
let ringBuffer = [];

// --- Default State Vector ---
function defaultStateVector() {
  return {
    activity: 'idle',
    gates: { focusLocked: false, compacting: 'none', safeMode: false },
    connectivity: { bridge: 'up', pty: 'up' },
    overlay: { open: false },
  };
}

// Initialize pane states
function initPaneStates() {
  paneStates = {};
  for (const id of PANE_IDS) {
    paneStates[id] = defaultStateVector();
  }
}
initPaneStates();

// --- Payload Sanitization ---
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const result = {};
  for (const key of Object.keys(payload)) {
    if ((key === 'body' || key === 'message') && !devMode) {
      const val = payload[key];
      const length = typeof val === 'string' ? val.length : (val ? JSON.stringify(val).length : 0);
      result[key] = { redacted: true, length };
    } else {
      result[key] = payload[key];
    }
  }
  return result;
}

// --- Sequence Numbers ---
function nextSeq(source) {
  if (!seqCounters[source]) seqCounters[source] = 0;
  seqCounters[source]++;
  return seqCounters[source];
}

// --- Wildcard Matching ---
function matchesWildcard(pattern, type) {
  if (!pattern.endsWith('.*')) return pattern === type;
  const prefix = pattern.slice(0, -2);
  return type.startsWith(prefix + '.') || type === prefix;
}

// --- Contract Checking ---
// opts.isRecheck: true when re-evaluating deferred events during resume
//   - skips trackViolation() to avoid cascading-violation false positives (S3)
function checkContracts(event, stateVector, opts = {}) {
  for (const contract of contracts) {
    const applies = contract.appliesTo.some(pattern => {
      if (pattern.includes('*')) return matchesWildcard(pattern, event.type);
      return pattern === event.type;
    });
    if (!applies) continue;

    // Emit contract.checked
    emitInternal('contract.checked', {
      paneId: event.paneId,
      payload: { contractId: contract.id, eventType: event.type },
    });

    // Check preconditions
    const allMet = contract.preconditions.every(fn => fn(event, stateVector));
    if (allMet) continue;

    // Violation detected
    if (contract.mode === 'shadow') {
      emitInternal('contract.shadow.violation', {
        paneId: event.paneId,
        payload: { contractId: contract.id, eventType: event.type, severity: contract.severity },
      });
      continue; // Shadow mode: don't enforce
    }

    // Enforced violation — skip stats/tracking for re-checks of deferred events
    if (!opts.isRecheck) {
      stats.contractViolations++;
      trackViolation();
    }

    const violationType = contract.emitOnViolation || 'contract.violation';
    emitInternal(violationType, {
      paneId: event.paneId,
      payload: { contractId: contract.id, eventType: event.type, action: contract.action, severity: contract.severity },
    });

    return { action: contract.action, contractId: contract.id };
  }
  return null;
}

// --- Safe Mode ---
function trackViolation() {
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  violationTimestamps.push(now);
  // Trim to window
  violationTimestamps = violationTimestamps.filter(t => now - t < SAFE_MODE_WINDOW_MS);

  if (!safeModeActive && violationTimestamps.length >= SAFE_MODE_VIOLATION_THRESHOLD) {
    enterSafeMode();
  }
}

function enterSafeMode() {
  if (safeModeActive) return;
  safeModeActive = true;
  // Update all pane state vectors
  for (const id of Object.keys(paneStates)) {
    paneStates[id].gates.safeMode = true;
  }
  emitInternal('safemode.entered', {
    paneId: 'system',
    payload: { triggerReason: 'cascading_violations', violationCount: violationTimestamps.length },
  });
  armSafeModeExit();
}

function armSafeModeExit() {
  if (safeModeTimer) clearTimeout(safeModeTimer);
  safeModeTimer = setTimeout(() => {
    exitSafeMode();
  }, SAFE_MODE_COOLDOWN_MS);
}

function exitSafeMode() {
  if (!safeModeActive) return;
  safeModeActive = false;
  safeModeTimer = null;
  for (const id of Object.keys(paneStates)) {
    paneStates[id].gates.safeMode = false;
  }
  emitInternal('safemode.exited', { paneId: 'system', payload: {} });
}

// --- Deferred Queue ---
const DEFAULT_DEFER_TTL_MS = 30000; // 30 seconds

function deferEvent(event, contractId) {
  const paneId = event.paneId || 'system';
  if (!deferQueues[paneId]) deferQueues[paneId] = [];
  deferQueues[paneId].push({
    event,
    contractId,
    deferredAt: typeof Date.now === 'function' ? Date.now() : Date.now(),
    ttl: DEFAULT_DEFER_TTL_MS,
  });
}

function resumeDeferredEvents(paneId) {
  const queue = deferQueues[paneId];
  if (!queue || queue.length === 0) return;
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  // Process FIFO with TTL check and gate re-check
  const remaining = [];
  for (const entry of queue) {
    // TTL expiry check — drop if exceeded
    if (now - entry.deferredAt > entry.ttl) {
      stats.totalDropped++;
      const dropType = entry.event.type.split('.')[0] + '.dropped';
      emitInternal(dropType, {
        paneId: entry.event.paneId,
        payload: { reason: 'ttl_expired', originalEventId: entry.event.eventId, contractId: entry.contractId },
      });
      continue;
    }
    // Re-check contracts with isRecheck flag to avoid false violation cascades (S3)
    const stateVector = paneStates[entry.event.paneId] || defaultStateVector();
    const violation = checkContracts(entry.event, stateVector, { isRecheck: true });
    if (violation && (violation.action === 'defer' || violation.action === 'block')) {
      remaining.push(entry);
    } else {
      emitInternal('inject.resumed', {
        paneId: entry.event.paneId,
        payload: { originalEventId: entry.event.eventId },
      });
      deliverToListeners(entry.event);
    }
  }
  deferQueues[paneId] = remaining;
}

// --- Internal emit (bypasses contracts to prevent infinite loops) ---
function emitInternal(type, { paneId, payload, correlationId: corrId, causationId } = {}) {
  const source = 'event-bus.js';
  const event = {
    eventId: generateId(),
    correlationId: corrId || correlationId || generateId(),
    causationId: causationId || null,
    type,
    source,
    paneId: paneId || 'system',
    ts: typeof Date.now === 'function' ? Date.now() : Date.now(),
    seq: nextSeq(source),
    payload: sanitizePayload(payload || {}),
  };
  deliverToListeners(event);
  recordToBuffer(event);
  return event;
}

// --- Listener Delivery ---
function deliverToListeners(event) {
  // Exact match listeners
  const handlers = listeners[event.type];
  if (handlers) {
    for (const handler of handlers) {
      try { handler(event); } catch (e) { /* Lane A must not crash */ }
    }
  }
  // Wildcard listeners
  for (const pattern of Object.keys(wildcardListeners)) {
    if (matchesWildcard(pattern, event.type)) {
      const wHandlers = wildcardListeners[pattern];
      if (wHandlers) {
        for (const handler of wHandlers) {
          try { handler(event); } catch (e) { /* Lane A must not crash */ }
        }
      }
    }
  }
}

// --- Lane B: Ring Buffer ---
function recordToBuffer(event) {
  if (!telemetryEnabled) return;
  try {
    ringBuffer.push(event);
    evictBuffer();
    stats.bufferSize = ringBuffer.length;
  } catch (e) {
    // Lane B failure must not affect Lane A
    try {
      emitInternal('bus.error', { paneId: 'system', payload: { error: String(e), lane: 'B' } });
    } catch { /* truly catastrophic, silently ignore */ }
  }
}

function evictBuffer() {
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  // Spec: max(1000 events, 5 minutes) — buffer EXPANDS beyond 1000 during bursts
  // to preserve the 5-minute window. Only evict when BOTH conditions met:
  // length > BUFFER_MAX_SIZE AND oldest event is older than BUFFER_MAX_AGE_MS
  while (ringBuffer.length > BUFFER_MAX_SIZE && ringBuffer.length > 0) {
    if (now - ringBuffer[0].ts > BUFFER_MAX_AGE_MS) {
      ringBuffer.shift();
    } else {
      break; // Oldest event is within time window — keep it (burst expansion)
    }
  }
}

// --- Public API ---

/**
 * Emit an event through the kernel
 */
function emit(type, { paneId, payload, correlationId: corrId, causationId, source: emitterSource } = {}) {
  const source = emitterSource || 'unknown';
  const event = {
    eventId: generateId(),
    correlationId: corrId || correlationId || generateId(),
    causationId: causationId || null,
    type,
    source,
    paneId: paneId || 'system',
    ts: typeof Date.now === 'function' ? Date.now() : Date.now(),
    seq: nextSeq(source),
    payload: sanitizePayload(payload || {}),
  };

  stats.totalEmitted++;

  // Contract check (Lane A)
  const stateVector = paneStates[event.paneId] || defaultStateVector();
  const violation = checkContracts(event, stateVector);

  if (violation) {
    switch (violation.action) {
      case 'defer':
        deferEvent(event, violation.contractId);
        return event;
      case 'drop':
        stats.totalDropped++;
        return event;
      case 'block':
        stats.totalDropped++;
        return event;
      case 'skip':
        // Let event through but skip side effect (caller checks)
        event._skipped = true;
        deliverToListeners(event);
        recordToBuffer(event);
        return event;
      case 'continue':
      default:
        // Allow through with warning
        break;
    }
  }

  deliverToListeners(event);
  recordToBuffer(event);
  return event;
}

/**
 * Ingest a pre-built envelope event from external sources (daemon/bridge).
 * External events bypass local contract checks and keep original envelope IDs/sequences.
 */
function ingest(event) {
  if (!event || typeof event !== 'object' || !event.type) return null;

  const source = event.source || 'external';
  const seq = Number.isFinite(event.seq) ? event.seq : nextSeq(source);

  if (!seqCounters[source] || seq > seqCounters[source]) {
    seqCounters[source] = seq;
  }

  const normalized = {
    eventId: event.eventId || generateId(),
    correlationId: event.correlationId || generateId(),
    causationId: event.causationId !== undefined ? event.causationId : null,
    type: event.type,
    source,
    paneId: event.paneId || 'system',
    ts: Number.isFinite(event.ts) ? event.ts : (typeof Date.now === 'function' ? Date.now() : Date.now()),
    seq,
    payload: sanitizePayload(event.payload || {}),
  };

  stats.totalEmitted++;
  deliverToListeners(normalized);
  recordToBuffer(normalized);
  return normalized;
}

/**
 * Subscribe to an event type (supports wildcards like 'inject.*')
 */
function on(type, handler) {
  if (typeof handler !== 'function') return;
  if (type.includes('*')) {
    if (!wildcardListeners[type]) wildcardListeners[type] = new Set();
    wildcardListeners[type].add(handler);
  } else {
    if (!listeners[type]) listeners[type] = new Set();
    listeners[type].add(handler);
  }
}

/**
 * Unsubscribe from an event type
 */
function off(type, handler) {
  if (type.includes('*')) {
    if (wildcardListeners[type]) {
      wildcardListeners[type].delete(handler);
      if (wildcardListeners[type].size === 0) delete wildcardListeners[type];
    }
  } else {
    if (listeners[type]) {
      listeners[type].delete(handler);
      if (listeners[type].size === 0) delete listeners[type];
    }
  }
}

/**
 * Register a contract
 */
function registerContract(contract) {
  if (!contract || !contract.id || !contract.appliesTo) return;
  // Remove existing contract with same id (re-registration)
  contracts = contracts.filter(c => c.id !== contract.id);
  contracts.push(contract);
}

/**
 * Get state vector for a pane
 */
function getState(paneId) {
  if (!paneStates[paneId]) {
    paneStates[paneId] = defaultStateVector();
  }
  return JSON.parse(JSON.stringify(paneStates[paneId]));
}

/**
 * Update state vector for a pane (partial merge)
 */
function updateState(paneId, patch) {
  if (!paneStates[paneId]) {
    paneStates[paneId] = defaultStateVector();
  }
  const prev = JSON.parse(JSON.stringify(paneStates[paneId]));
  const state = paneStates[paneId];

  // Shallow merge for top-level, deep merge for nested objects
  if (patch.activity !== undefined) state.activity = patch.activity;
  if (patch.gates) {
    if (patch.gates.focusLocked !== undefined) state.gates.focusLocked = patch.gates.focusLocked;
    if (patch.gates.compacting !== undefined) state.gates.compacting = patch.gates.compacting;
    if (patch.gates.safeMode !== undefined) state.gates.safeMode = patch.gates.safeMode;
  }
  if (patch.connectivity) {
    if (patch.connectivity.bridge !== undefined) state.connectivity.bridge = patch.connectivity.bridge;
    if (patch.connectivity.pty !== undefined) state.connectivity.pty = patch.connectivity.pty;
  }
  if (patch.overlay) {
    if (patch.overlay.open !== undefined) state.overlay.open = patch.overlay.open;
  }

  // Only emit state change event if state actually changed
  const nextSnapshot = JSON.parse(JSON.stringify(state));
  const changed = JSON.stringify(prev) !== JSON.stringify(nextSnapshot);
  if (changed) {
    emitInternal('pane.state.changed', {
      paneId,
      payload: { prev, next: nextSnapshot },
    });
  }

  // Check if gate cleared — resume deferred events
  const gateCleared = (prev.gates.focusLocked && !state.gates.focusLocked) ||
    (prev.gates.compacting === 'confirmed' && state.gates.compacting !== 'confirmed') ||
    (prev.gates.safeMode && !state.gates.safeMode);

  if (gateCleared) {
    resumeDeferredEvents(paneId);
  }
}

/**
 * Start a new correlation chain
 */
function startCorrelation() {
  correlationId = generateId();
  return correlationId;
}

/**
 * Get current active correlation ID
 */
function getCurrentCorrelation() {
  return correlationId;
}

/**
 * Query ring buffer (Lane B)
 * Supports: correlationId, paneId, type (exact or prefix with *), types[], since, until, limit
 * Returns matching events, newest first
 */
function query({ correlationId: corrId, paneId, type, types, since, until, limit: maxResults, timeRange } = {}) {
  if (!telemetryEnabled) return [];
  try {
    let results = [...ringBuffer];
    if (corrId) results = results.filter(e => e.correlationId === corrId);
    if (paneId) results = results.filter(e => e.paneId === paneId);
    if (type) {
      if (type.includes('*')) {
        results = results.filter(e => matchesWildcard(type, e.type));
      } else {
        results = results.filter(e => e.type === type);
      }
    }
    if (types && Array.isArray(types) && types.length > 0) {
      results = results.filter(e => types.some(t => {
        if (t.includes('*')) return matchesWildcard(t, e.type);
        return t === e.type;
      }));
    }
    if (since !== undefined) results = results.filter(e => e.ts >= since);
    if (until !== undefined) results = results.filter(e => e.ts <= until);
    // Legacy timeRange support
    if (timeRange) {
      const { start, end } = timeRange;
      if (start) results = results.filter(e => e.ts >= start);
      if (end) results = results.filter(e => e.ts <= end);
    }
    // Newest first
    results.reverse();
    // Apply limit
    if (maxResults && maxResults > 0) {
      results = results.slice(0, maxResults);
    }
    return results;
  } catch (e) {
    // Lane B failure
    return [];
  }
}

/**
 * Get ring buffer statistics (Lane B)
 */
function getBufferStats() {
  if (!telemetryEnabled) return { size: 0, maxSize: BUFFER_MAX_SIZE, oldestTs: null, newestTs: null, droppedCount: stats.totalDropped, eventTypeCounts: {} };
  try {
    const eventTypeCounts = {};
    for (const event of ringBuffer) {
      eventTypeCounts[event.type] = (eventTypeCounts[event.type] || 0) + 1;
    }
    return {
      size: ringBuffer.length,
      maxSize: BUFFER_MAX_SIZE,
      oldestTs: ringBuffer.length > 0 ? ringBuffer[0].ts : null,
      newestTs: ringBuffer.length > 0 ? ringBuffer[ringBuffer.length - 1].ts : null,
      droppedCount: stats.totalDropped,
      eventTypeCounts,
    };
  } catch (e) {
    return { size: 0, maxSize: BUFFER_MAX_SIZE, oldestTs: null, newestTs: null, droppedCount: 0, eventTypeCounts: {} };
  }
}

/**
 * Get all events in a correlation chain, ordered by causation DAG then timestamp
 */
function getCorrelationChain(corrId) {
  if (!telemetryEnabled || !corrId) return [];
  try {
    const events = ringBuffer.filter(e => e.correlationId === corrId);
    if (events.length === 0) return [];

    // Build causation DAG: eventId -> [child events]
    const byId = new Map();
    const children = new Map();
    const roots = [];

    for (const event of events) {
      byId.set(event.eventId, event);
      if (!children.has(event.eventId)) children.set(event.eventId, []);
    }

    for (const event of events) {
      if (event.causationId && byId.has(event.causationId)) {
        if (!children.has(event.causationId)) children.set(event.causationId, []);
        children.get(event.causationId).push(event);
      } else {
        roots.push(event);
      }
    }

    // Sort roots and children by timestamp
    roots.sort((a, b) => a.ts - b.ts);
    for (const [, kids] of children) {
      kids.sort((a, b) => a.ts - b.ts);
    }

    // BFS traversal for topological order
    const result = [];
    const visited = new Set();
    const queue = [...roots];

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node.eventId)) continue;
      visited.add(node.eventId);
      result.push(node);
      const kids = children.get(node.eventId) || [];
      for (const child of kids) {
        if (!visited.has(child.eventId)) {
          queue.push(child);
        }
      }
    }

    // Add any orphans (events whose causationId doesn't match any event in the chain)
    for (const event of events) {
      if (!visited.has(event.eventId)) {
        result.push(event);
      }
    }

    return result;
  } catch (e) {
    return [];
  }
}

/**
 * Get raw ring buffer (Lane B)
 */
function getBuffer() {
  if (!telemetryEnabled) return [];
  return [...ringBuffer];
}

/**
 * Toggle telemetry (Lane B)
 */
function setTelemetryEnabled(enabled) {
  telemetryEnabled = enabled;
  if (!enabled) {
    ringBuffer = [];
    stats.bufferSize = 0;
  }
}

/**
 * Set dev mode (controls payload sanitization)
 */
function setDevMode(enabled) {
  devMode = enabled;
}

/**
 * Get stats
 */
function getStats() {
  return { ...stats, bufferSize: ringBuffer.length };
}

/**
 * Reset all state (for testing)
 */
function reset() {
  listeners = {};
  wildcardListeners = {};
  seqCounters = {};
  contracts = [];
  correlationId = null;
  deferQueues = {};
  devMode = false;
  safeModeActive = false;
  violationTimestamps = [];
  if (safeModeTimer) { clearTimeout(safeModeTimer); safeModeTimer = null; }
  telemetryEnabled = true;
  ringBuffer = [];
  stats = { totalEmitted: 0, totalDropped: 0, contractViolations: 0, bufferSize: 0 };
  initPaneStates();
}

module.exports = {
  // Lane A
  emit,
  ingest,
  on,
  off,
  registerContract,
  getState,
  updateState,
  startCorrelation,
  getCurrentCorrelation,
  // Lane B
  query,
  getBuffer,
  getBufferStats,
  getCorrelationChain,
  setTelemetryEnabled,
  // Utilities
  reset,
  getStats,
  setDevMode,
};
