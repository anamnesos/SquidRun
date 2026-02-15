/**
 * Transition Ledger
 * First-class transition objects with owner lease, phase validation,
 * precondition capture, evidence classification, and deterministic fallback.
 */

const LEDGER_SOURCE = 'transition-ledger.js';
const DEFAULT_OVERALL_TIMEOUT_MS = 5000;
const DEFAULT_OWNER_LEASE_TTL_MS = 15000;
const MAX_TRANSITIONS = 500;

const ROLE_BY_PANE = Object.freeze({
  '1': 'architect',
  '2': 'devops',
  '5': 'analyst',
  system: 'system',
});

const TRANSITION_KIND = Object.freeze({
  MESSAGE_SUBMIT: 'message.submit',
});

const TRANSITION_CATEGORY = Object.freeze({
  INJECT: 'inject',
});

const TRANSITION_PHASE = Object.freeze({
  REQUESTED: 'requested',
  ACCEPTED: 'accepted',
  DEFERRED: 'deferred',
  APPLIED: 'applied',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  DROPPED: 'dropped',
  CANCELLED: 'cancelled',
});

const TERMINAL_PHASES = new Set([
  TRANSITION_PHASE.VERIFIED,
  TRANSITION_PHASE.FAILED,
  TRANSITION_PHASE.TIMED_OUT,
  TRANSITION_PHASE.DROPPED,
  TRANSITION_PHASE.CANCELLED,
]);

const PHASE_GRAPH = Object.freeze({
  [TRANSITION_PHASE.REQUESTED]: [TRANSITION_PHASE.ACCEPTED, TRANSITION_PHASE.DEFERRED, TRANSITION_PHASE.DROPPED],
  [TRANSITION_PHASE.ACCEPTED]: [TRANSITION_PHASE.APPLIED, TRANSITION_PHASE.FAILED, TRANSITION_PHASE.TIMED_OUT],
  [TRANSITION_PHASE.DEFERRED]: [TRANSITION_PHASE.ACCEPTED, TRANSITION_PHASE.DROPPED, TRANSITION_PHASE.TIMED_OUT],
  [TRANSITION_PHASE.APPLIED]: [TRANSITION_PHASE.VERIFYING, TRANSITION_PHASE.FAILED],
  [TRANSITION_PHASE.VERIFYING]: [TRANSITION_PHASE.VERIFIED, TRANSITION_PHASE.FAILED, TRANSITION_PHASE.TIMED_OUT],
  [TRANSITION_PHASE.VERIFIED]: [],
  [TRANSITION_PHASE.FAILED]: [],
  [TRANSITION_PHASE.TIMED_OUT]: [],
  [TRANSITION_PHASE.DROPPED]: [],
  [TRANSITION_PHASE.CANCELLED]: [],
});

const EVIDENCE_CLASS = Object.freeze({
  STRONG: 'strong',
  WEAK: 'weak',
  DISALLOWED: 'disallowed',
  NONE: 'none',
});

const VERIFICATION_OUTCOME = Object.freeze({
  PASS: 'pass',
  RISKED_PASS: 'risked_pass',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
});

const FALLBACK_ACTION = Object.freeze({
  DEFER: 'defer',
  DROP: 'drop',
  SAFE_MODE: 'safe_mode',
  RETRY: 'retry',
});

// Backward-compatible lifecycle labels used by earlier scaffold/tests.
const TRANSITION_STATES = Object.freeze({
  REQUESTED: 'requested',
  QUEUED: 'queued',
  APPLIED: 'applied',
  SUBMIT_REQUESTED: 'submit_requested',
  SUBMIT_SENT: 'submit_sent',
  DELIVERED_VERIFIED: 'delivered_verified',
  DELIVERED_UNVERIFIED: 'delivered_unverified',
  FAILED: 'failed',
  DROPPED: 'dropped',
  TIMED_OUT: 'timed_out',
});

const REQUIRED_FIELDS = Object.freeze([
  'transitionId',
  'correlationId',
  'causationId',
  'paneId',
  'category',
  'intentType',
  'transitionType',
  'origin.actorType',
  'origin.actorRole',
  'origin.source',
  'owner.module',
  'owner.leaseId',
  'owner.acquiredAt',
  'owner.leaseTtlMs',
  'phase',
  'timeoutBudget.overallMs',
  'fallbackPolicy.onTimeout',
  'verification.outcome',
  'verification.confidence',
  'verification.verifiedAt',
  'outcome.status',
  'outcome.reasonCode',
  'outcome.resolvedBy',
  'evidence',
  'createdAt',
  'updatedAt',
  'closed',
  'closedAt',
]);

const NULLABLE_REQUIRED_FIELDS = new Set([
  'causationId',
  'verification.verifiedAt',
  'closedAt',
]);

const DEFAULT_EVIDENCE_SPEC = Object.freeze({
  requiredClass: 'strong',
  acceptedSignals: [
    'verify.pass',
    'inject.verified',
    'daemon.write.ack',
    'pty.data.received',
    'inject.submit.sent',
  ],
  disallowedSignals: [],
});

const DEFAULT_TIMEOUT_BUDGET = Object.freeze({
  acceptMs: 500,
  applyMs: 1000,
  verifyMs: 3000,
  overallMs: DEFAULT_OVERALL_TIMEOUT_MS,
});

const DEFAULT_FALLBACK_POLICY = Object.freeze({
  onTimeout: FALLBACK_ACTION.DEFER,
  maxRetries: 0,
  retryBackoffMs: [],
});

const OWNER_MUTATION_EVENTS = new Set([
  'inject.queued',
  'inject.applied',
  'inject.submit.requested',
  'inject.submit.sent',
  'inject.failed',
  'inject.dropped',
  'inject.timeout',
]);

let bus = null;
let subscriptions = [];
let transitionCounter = 0;
let leaseCounter = 0;

let transitions = new Map();  // transitionId -> transition object
let transitionOrder = [];     // ordered transition IDs
let activeByKey = new Map();  // pane|corr -> transitionId
let timerById = new Map();    // transitionId -> timeoutId

let stats = {
  created: 0,
  settledVerified: 0,
  settledUnverified: 0,
  failed: 0,
  dropped: 0,
  timedOut: 0,
  invalid: 0,
  active: 0,
};

function nowMs() {
  return Date.now();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildTransitionId() {
  transitionCounter += 1;
  return `tr-${nowMs()}-${transitionCounter}`;
}

function buildLeaseId() {
  leaseCounter += 1;
  return `lease-${nowMs()}-${leaseCounter}`;
}

function keyFor(paneId, correlationId) {
  return `${String(paneId || 'system')}|${String(correlationId || 'none')}`;
}

function actorTypeFromEvent(event) {
  if (event?.payload?.priority === true) return 'user';
  if (event?.source === LEDGER_SOURCE) return 'system';
  return 'agent';
}

function actorRoleFromPane(paneId) {
  return ROLE_BY_PANE[String(paneId || 'system')] || 'system';
}

function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

function missingRequiredFields(transition) {
  const missing = [];
  for (const path of REQUIRED_FIELDS) {
    const value = getPath(transition, path);
    if (
      value === undefined
      || value === ''
      || (value === null && !NULLABLE_REQUIRED_FIELDS.has(path))
    ) {
      missing.push(path);
    }
  }
  if (!Array.isArray(transition.phaseHistory) || transition.phaseHistory.length === 0) {
    missing.push('phaseHistory');
  }
  return missing;
}

function setStatsActive() {
  stats.active = activeByKey.size;
}

function mapPhaseToLifecycle(phase) {
  switch (phase) {
    case TRANSITION_PHASE.REQUESTED:
      return TRANSITION_STATES.REQUESTED;
    case TRANSITION_PHASE.DEFERRED:
      return TRANSITION_STATES.QUEUED;
    case TRANSITION_PHASE.APPLIED:
      return TRANSITION_STATES.APPLIED;
    case TRANSITION_PHASE.VERIFYING:
      return TRANSITION_STATES.SUBMIT_SENT;
    case TRANSITION_PHASE.VERIFIED:
      return TRANSITION_STATES.DELIVERED_VERIFIED;
    case TRANSITION_PHASE.TIMED_OUT:
      return TRANSITION_STATES.TIMED_OUT;
    case TRANSITION_PHASE.DROPPED:
      return TRANSITION_STATES.DROPPED;
    case TRANSITION_PHASE.FAILED:
      return TRANSITION_STATES.FAILED;
    default:
      return phase;
  }
}

function eventNameForPhase(phase) {
  if (phase === TRANSITION_PHASE.VERIFYING) return 'transition.verification.started';
  return `transition.${phase}`;
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const summary = {};
  if (payload.status !== undefined) summary.status = payload.status;
  if (payload.reason !== undefined) summary.reason = payload.reason;
  if (payload.meaningful !== undefined) summary.meaningful = payload.meaningful;
  if (payload.chunkType !== undefined) summary.chunkType = payload.chunkType;
  if (payload.bytesAccepted !== undefined) summary.bytesAccepted = payload.bytesAccepted;
  return summary;
}

function normalizeEvidenceSpec(event) {
  const candidate = event?.payload?.evidenceSpec;
  if (!candidate || typeof candidate !== 'object') {
    return clone(DEFAULT_EVIDENCE_SPEC);
  }

  const requiredClass = typeof candidate.requiredClass === 'string'
    ? candidate.requiredClass
    : DEFAULT_EVIDENCE_SPEC.requiredClass;

  const acceptedSignals = Array.isArray(candidate.acceptedSignals)
    ? candidate.acceptedSignals.filter((item) => typeof item === 'string')
    : clone(DEFAULT_EVIDENCE_SPEC.acceptedSignals);

  const disallowedSignals = Array.isArray(candidate.disallowedSignals)
    ? candidate.disallowedSignals.filter((item) => typeof item === 'string')
    : clone(DEFAULT_EVIDENCE_SPEC.disallowedSignals);

  return {
    requiredClass,
    acceptedSignals,
    disallowedSignals,
  };
}

function normalizeFallbackPolicy(event) {
  const candidate = event?.payload?.fallbackPolicy;
  if (!candidate || typeof candidate !== 'object') {
    return clone(DEFAULT_FALLBACK_POLICY);
  }

  const actionValues = new Set(Object.values(FALLBACK_ACTION));
  const onTimeout = (typeof candidate.onTimeout === 'string' && actionValues.has(candidate.onTimeout))
    ? candidate.onTimeout
    : DEFAULT_FALLBACK_POLICY.onTimeout;
  const maxRetries = Number.isInteger(candidate.maxRetries) && candidate.maxRetries >= 0
    ? candidate.maxRetries
    : DEFAULT_FALLBACK_POLICY.maxRetries;
  const retryBackoffMs = Array.isArray(candidate.retryBackoffMs)
    ? candidate.retryBackoffMs.filter((item) => Number.isFinite(item) && item >= 0)
    : clone(DEFAULT_FALLBACK_POLICY.retryBackoffMs);

  return {
    onTimeout,
    maxRetries,
    retryBackoffMs,
  };
}

function emitLedgerEvent(type, transition, event, payload = {}) {
  if (!bus) return null;
  return bus.emit(type, {
    paneId: transition.paneId,
    correlationId: transition.correlationId,
    causationId: event?.eventId || transition.causationId || transition.sourceEventId || null,
    payload: {
      transitionId: transition.transitionId,
      phase: transition.phase,
      reasonCode: payload.reasonCode || null,
      ownerLeaseId: transition.owner.leaseId,
      evidenceClassObserved: transition.verification.evidenceClassObserved,
      ...payload,
    },
    source: LEDGER_SOURCE,
  });
}

function createTransitionFromEvent(event) {
  const paneId = String(event?.paneId || 'system');
  const correlationId = event?.correlationId || `corr-missing-${nowMs()}`;
  const key = keyFor(paneId, correlationId);
  const existingId = activeByKey.get(key);
  if (existingId && transitions.has(existingId)) {
    return transitions.get(existingId);
  }

  const createdAt = nowMs();
  const transition = {
    transitionId: buildTransitionId(),
    correlationId,
    causationId: event?.eventId || event?.causationId || null,
    paneId,
    category: TRANSITION_CATEGORY.INJECT,
    intentType: 'inject.requested',
    transitionType: TRANSITION_KIND.MESSAGE_SUBMIT,
    origin: {
      actorType: actorTypeFromEvent(event),
      actorRole: actorRoleFromPane(paneId),
      source: event?.source || 'unknown',
    },
    owner: {
      module: event?.source || 'unknown',
      leaseId: buildLeaseId(),
      acquiredAt: createdAt,
      leaseTtlMs: DEFAULT_OWNER_LEASE_TTL_MS,
    },
    preconditions: [],
    evidenceSpec: normalizeEvidenceSpec(event),
    timeoutBudget: clone(DEFAULT_TIMEOUT_BUDGET),
    fallbackPolicy: normalizeFallbackPolicy(event),
    phase: TRANSITION_PHASE.REQUESTED,
    phaseHistory: [
      { phase: TRANSITION_PHASE.REQUESTED, ts: createdAt, eventId: event?.eventId || null, note: 'created' },
    ],
    verification: {
      outcome: VERIFICATION_OUTCOME.UNKNOWN,
      evidenceClassObserved: EVIDENCE_CLASS.NONE,
      confidence: 0,
      verifiedAt: null,
    },
    outcome: {
      status: 'partial',
      reasonCode: 'pending',
      resolvedBy: 'normal',
    },
    evidence: [],
    sourceEventId: event?.eventId || null,
    createdAt,
    updatedAt: createdAt,
    closed: false,
    closedAt: null,
    // Compatibility field used by earlier tests and diagnostics.
    lifecycle: TRANSITION_STATES.REQUESTED,
  };

  const missing = missingRequiredFields(transition);
  if (missing.length > 0) {
    stats.invalid += 1;
    emitLedgerEvent('transition.invalid', transition, event, {
      reasonCode: 'missing_required_fields',
      missingFields: missing,
    });
  }

  transitions.set(transition.transitionId, transition);
  transitionOrder.push(transition.transitionId);
  activeByKey.set(key, transition.transitionId);
  stats.created += 1;
  setStatsActive();
  pruneTransitions();

  emitLedgerEvent('transition.requested', transition, event, {});
  return transition;
}

function getTransitionForEvent(event, { create = false } = {}) {
  const paneId = String(event?.paneId || 'system');
  const correlationId = event?.correlationId;
  if (!correlationId) {
    return create ? createTransitionFromEvent(event) : null;
  }
  const key = keyFor(paneId, correlationId);
  const id = activeByKey.get(key);
  if (id && transitions.has(id)) return transitions.get(id);
  if (!create) return null;
  return createTransitionFromEvent(event);
}

function clearTransitionTimeout(transitionId) {
  const timeoutId = timerById.get(transitionId);
  if (!timeoutId) return;
  clearTimeout(timeoutId);
  timerById.delete(transitionId);
}

function removeFromActiveIndex(transition) {
  activeByKey.delete(keyFor(transition.paneId, transition.correlationId));
  setStatsActive();
}

function isPhaseTransitionAllowed(current, next) {
  if (current === next) return true;
  const allowed = PHASE_GRAPH[current] || [];
  return allowed.includes(next);
}

function markInvalid(transition, event, reasonCode, payload = {}) {
  stats.invalid += 1;
  emitLedgerEvent('transition.invalid', transition, event, {
    reasonCode,
    ...payload,
  });
}

function ensureOwnerInvariant(transition, event) {
  if (!transition || !event) return true;
  if (!OWNER_MUTATION_EVENTS.has(event?.type)) return true;
  if (!event?.source) {
    markInvalid(transition, event, 'owner_source_missing');
    return false;
  }
  if (event.source !== transition.owner.module) {
    markInvalid(transition, event, 'ownership_conflict', {
      expectedOwner: transition.owner.module,
      observedOwner: event.source,
    });
    return false;
  }
  if (nowMs() - transition.owner.acquiredAt > transition.owner.leaseTtlMs) {
    markInvalid(transition, event, 'owner_lease_expired');
    return false;
  }
  return true;
}

function promoteToAppliedWithPreconditions(transition, event, note = 'submit_without_explicit_apply') {
  if (!transition || transition.closed) return false;

  if (transition.phase === TRANSITION_PHASE.REQUESTED || transition.phase === TRANSITION_PHASE.DEFERRED) {
    if (!evaluatePreconditionsForApply(transition, event)) {
      if (transition.phase === TRANSITION_PHASE.REQUESTED) {
        setPhase(transition, TRANSITION_PHASE.DEFERRED, event, 'precondition_failed_before_apply');
      }
      return false;
    }
    if (transition.phase === TRANSITION_PHASE.REQUESTED) {
      if (!setPhase(transition, TRANSITION_PHASE.ACCEPTED, event)) return false;
    }
  }

  if (transition.phase === TRANSITION_PHASE.ACCEPTED) {
    if (!evaluatePreconditionsForApply(transition, event)) {
      return false;
    }
    if (!setPhase(transition, TRANSITION_PHASE.APPLIED, event, note)) return false;
  }

  return transition.phase === TRANSITION_PHASE.APPLIED || transition.phase === TRANSITION_PHASE.VERIFYING;
}

function setPhase(transition, nextPhase, event, note = '') {
  if (!transition || transition.closed) return false;
  const current = transition.phase;
  if (!isPhaseTransitionAllowed(current, nextPhase)) {
    markInvalid(transition, event, 'phase_order_violation', {
      currentPhase: current,
      attemptedPhase: nextPhase,
    });
    return false;
  }
  if (current === nextPhase) return true;

  transition.phase = nextPhase;
  transition.lifecycle = mapPhaseToLifecycle(nextPhase);
  transition.causationId = event?.eventId || transition.causationId || transition.sourceEventId || null;
  transition.updatedAt = nowMs();
  transition.phaseHistory.push({
    phase: nextPhase,
    ts: transition.updatedAt,
    eventId: event?.eventId || null,
    note: note || null,
  });
  emitLedgerEvent(eventNameForPhase(nextPhase), transition, event, { reasonCode: null });
  return true;
}

function evaluatePreconditionsForApply(transition, event) {
  const paneState = (bus && typeof bus.getState === 'function')
    ? bus.getState(transition.paneId)
    : null;
  const checkedAt = nowMs();
  const preconditions = [
    {
      id: 'focus-lock-guard',
      result: paneState && paneState.gates && paneState.gates.focusLocked === false ? 'pass' : 'fail',
      checkedAt,
      failureAction: 'defer',
    },
    {
      id: 'compaction-gate',
      result: paneState && paneState.gates && paneState.gates.compacting !== 'confirmed' ? 'pass' : 'fail',
      checkedAt,
      failureAction: 'defer',
    },
  ];

  transition.preconditions = preconditions;
  const failed = preconditions.filter((item) => item.result !== 'pass');
  if (failed.length > 0) {
    markInvalid(transition, event, 'precondition_failed_before_apply', {
      failedPreconditions: failed.map((item) => item.id),
    });
    return false;
  }
  return true;
}

function classifyEvidence(event, transition = null) {
  if (!event || !event.type) return EVIDENCE_CLASS.NONE;
  const signalType = event.type;
  const disallowedSignals = transition?.evidenceSpec?.disallowedSignals;
  const acceptedSignals = transition?.evidenceSpec?.acceptedSignals;

  if (Array.isArray(disallowedSignals) && disallowedSignals.includes(signalType)) {
    return EVIDENCE_CLASS.DISALLOWED;
  }

  if (Array.isArray(acceptedSignals) && !acceptedSignals.includes(signalType)) {
    return EVIDENCE_CLASS.NONE;
  }

  if (signalType === 'verify.pass' || signalType === 'inject.verified') {
    return EVIDENCE_CLASS.STRONG;
  }

  if (signalType === 'daemon.write.ack') {
    return event?.payload?.status === 'accepted' ? EVIDENCE_CLASS.WEAK : EVIDENCE_CLASS.NONE;
  }

  if (signalType === 'pty.data.received') {
    const state = transition && bus && typeof bus.getState === 'function'
      ? bus.getState(transition.paneId)
      : null;
    if (state && state.gates && state.gates.compacting === 'confirmed') {
      return EVIDENCE_CLASS.DISALLOWED;
    }
    return EVIDENCE_CLASS.WEAK;
  }

  if (signalType === 'inject.submit.sent') {
    return EVIDENCE_CLASS.WEAK;
  }

  return EVIDENCE_CLASS.NONE;
}

function recordEvidence(transition, event, evidenceClass) {
  if (!transition || transition.closed || evidenceClass === EVIDENCE_CLASS.NONE) return;

  const entry = {
    eventId: event?.eventId || null,
    type: event?.type || 'unknown',
    ts: Number.isFinite(event?.ts) ? event.ts : nowMs(),
    class: evidenceClass,
    payload: summarizePayload(event?.payload),
  };
  transition.evidence.push(entry);
  transition.updatedAt = nowMs();
  transition.verification.evidenceClassObserved = evidenceClass;
  if (evidenceClass === EVIDENCE_CLASS.STRONG) transition.verification.confidence = 1.0;
  if (evidenceClass === EVIDENCE_CLASS.WEAK && transition.verification.confidence < 0.65) {
    transition.verification.confidence = 0.65;
  }
  if (evidenceClass === EVIDENCE_CLASS.DISALLOWED) transition.verification.confidence = 0.0;

  emitLedgerEvent('transition.evidence.recorded', transition, event, {
    reasonCode: null,
    evidenceType: entry.type,
    evidenceClassObserved: evidenceClass,
  });
}

function hasEvidence(transition, cls) {
  return transition.evidence.some((entry) => entry.class === cls);
}

function enforceEvidenceSpec(transition, terminalPhase, event, reasonCode, options = {}) {
  const requiredClass = transition?.evidenceSpec?.requiredClass || 'strong';
  const hasStrong = hasEvidence(transition, EVIDENCE_CLASS.STRONG);
  const hasWeak = hasEvidence(transition, EVIDENCE_CLASS.WEAK);
  const hasDisallowed = hasEvidence(transition, EVIDENCE_CLASS.DISALLOWED);

  if (hasDisallowed && !options.manualOverride) {
    markInvalid(transition, event, 'evidence_spec_disallowed', {
      requiredClass,
      attemptedPhase: terminalPhase,
    });
    return {
      terminalPhase: TRANSITION_PHASE.FAILED,
      reasonCode: 'disallowed_evidence',
      options: {
        ...options,
        verificationOutcome: VERIFICATION_OUTCOME.FAIL,
      },
    };
  }

  if (terminalPhase !== TRANSITION_PHASE.VERIFIED) {
    return { terminalPhase, reasonCode, options };
  }

  if (requiredClass === 'manual_only' && !options.manualOverride) {
    markInvalid(transition, event, 'evidence_spec_manual_only', { attemptedPhase: terminalPhase });
    return {
      terminalPhase: TRANSITION_PHASE.FAILED,
      reasonCode: 'manual_verification_required',
      options: {
        ...options,
        verificationOutcome: VERIFICATION_OUTCOME.UNKNOWN,
      },
    };
  }

  if (requiredClass === 'weak_allowed') {
    if (hasStrong) {
      return { terminalPhase, reasonCode, options };
    }
    if (hasWeak) {
      return {
        terminalPhase,
        reasonCode,
        options: {
          ...options,
          verificationOutcome: options.verificationOutcome || VERIFICATION_OUTCOME.RISKED_PASS,
        },
      };
    }
    markInvalid(transition, event, 'evidence_spec_missing_required', { requiredClass });
    return {
      terminalPhase: TRANSITION_PHASE.TIMED_OUT,
      reasonCode: 'evidence_missing_required',
      options: {
        ...options,
        resolvedBy: options.resolvedBy || 'fallback',
        verificationOutcome: VERIFICATION_OUTCOME.UNKNOWN,
      },
    };
  }

  // Default policy: strong evidence required for clean verify.
  if (hasStrong) {
    return { terminalPhase, reasonCode, options };
  }

  markInvalid(transition, event, 'evidence_spec_missing_required', { requiredClass });
  if (hasWeak) {
    return {
      terminalPhase: TRANSITION_PHASE.TIMED_OUT,
      reasonCode: 'evidence_below_required',
      options: {
        ...options,
        resolvedBy: options.resolvedBy || 'fallback',
        verificationOutcome: VERIFICATION_OUTCOME.RISKED_PASS,
      },
    };
  }

  return {
    terminalPhase: TRANSITION_PHASE.TIMED_OUT,
    reasonCode: 'evidence_missing_required',
    options: {
      ...options,
      resolvedBy: options.resolvedBy || 'fallback',
      verificationOutcome: VERIFICATION_OUTCOME.UNKNOWN,
    },
  };
}

function finalizeTransition(transition, terminalPhase, event, reasonCode, options = {}) {
  if (!transition || transition.closed) return;
  const enforced = enforceEvidenceSpec(transition, terminalPhase, event, reasonCode, options);
  const effectivePhase = enforced.terminalPhase;
  const effectiveReason = enforced.reasonCode || reasonCode;
  const effectiveOptions = enforced.options || options;

  if (!setPhase(transition, effectivePhase, event, effectiveReason)) {
    // Don't force-close on phase violation. Keep transition open and invalid for triage.
    markInvalid(transition, event, 'terminal_phase_set_failed', { attemptedPhase: effectivePhase });
    return;
  }

  transition.closed = true;
  transition.closedAt = nowMs();
  transition.updatedAt = transition.closedAt;
  clearTransitionTimeout(transition.transitionId);
  removeFromActiveIndex(transition);

  transition.outcome.reasonCode = effectiveReason || 'unknown';
  transition.outcome.resolvedBy = effectiveOptions.resolvedBy || 'normal';

  if (effectivePhase === TRANSITION_PHASE.VERIFIED) {
    transition.verification.verifiedAt = transition.closedAt;
    transition.verification.outcome = effectiveOptions.verificationOutcome || VERIFICATION_OUTCOME.PASS;
    if (transition.verification.outcome === VERIFICATION_OUTCOME.RISKED_PASS) {
      stats.settledUnverified += 1;
      transition.outcome.status = 'partial';
      transition.lifecycle = TRANSITION_STATES.DELIVERED_UNVERIFIED;
    } else {
      stats.settledVerified += 1;
      transition.outcome.status = 'success';
      transition.lifecycle = TRANSITION_STATES.DELIVERED_VERIFIED;
    }
  } else if (effectivePhase === TRANSITION_PHASE.TIMED_OUT) {
    stats.timedOut += 1;
    if (effectiveOptions.verificationOutcome) {
      transition.verification.outcome = effectiveOptions.verificationOutcome;
    } else {
      transition.verification.outcome = VERIFICATION_OUTCOME.UNKNOWN;
    }
    transition.verification.verifiedAt = transition.closedAt;
    transition.outcome.status = transition.verification.outcome === VERIFICATION_OUTCOME.RISKED_PASS ? 'partial' : 'failure';
    transition.lifecycle = transition.verification.outcome === VERIFICATION_OUTCOME.RISKED_PASS
      ? TRANSITION_STATES.DELIVERED_UNVERIFIED
      : TRANSITION_STATES.TIMED_OUT;
    if (transition.verification.outcome === VERIFICATION_OUTCOME.RISKED_PASS) {
      stats.settledUnverified += 1;
    }
  } else if (effectivePhase === TRANSITION_PHASE.DROPPED) {
    stats.dropped += 1;
    transition.verification.outcome = VERIFICATION_OUTCOME.FAIL;
    transition.outcome.status = 'failure';
    transition.lifecycle = TRANSITION_STATES.DROPPED;
  } else {
    stats.failed += 1;
    transition.verification.outcome = VERIFICATION_OUTCOME.FAIL;
    transition.outcome.status = 'failure';
    transition.lifecycle = TRANSITION_STATES.FAILED;
  }
}

function scheduleTransitionTimeout(transition, event) {
  if (!transition || transition.closed) return;
  clearTransitionTimeout(transition.transitionId);
  const timeoutMs = transition.timeoutBudget.overallMs || DEFAULT_OVERALL_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    handleTimeout(transition.transitionId);
  }, timeoutMs);
  timerById.set(transition.transitionId, timeoutId);
  emitLedgerEvent('transition.timeout.armed', transition, event, {
    reasonCode: null,
    timeoutBudgetMs: timeoutMs,
  });
}

function handleTimeout(transitionId) {
  const transition = transitions.get(transitionId);
  if (!transition || transition.closed) return;

  const hasStrong = hasEvidence(transition, EVIDENCE_CLASS.STRONG);
  const hasWeak = hasEvidence(transition, EVIDENCE_CLASS.WEAK);
  const hasDisallowed = hasEvidence(transition, EVIDENCE_CLASS.DISALLOWED);

  if (hasStrong) {
    finalizeTransition(transition, TRANSITION_PHASE.VERIFIED, null, 'late_strong_evidence');
    return;
  }

  if (hasDisallowed) {
    finalizeTransition(transition, TRANSITION_PHASE.FAILED, null, 'disallowed_evidence');
    return;
  }

  if (transition.fallbackPolicy.onTimeout === FALLBACK_ACTION.DROP) {
    finalizeTransition(transition, TRANSITION_PHASE.TIMED_OUT, null, 'timeout_drop_fallback', {
      resolvedBy: 'fallback',
      verificationOutcome: VERIFICATION_OUTCOME.UNKNOWN,
    });
    return;
  }

  if (hasWeak) {
    finalizeTransition(transition, TRANSITION_PHASE.TIMED_OUT, null, 'timeout_with_weak_evidence', {
      resolvedBy: 'fallback',
      verificationOutcome: VERIFICATION_OUTCOME.RISKED_PASS,
    });
    return;
  }

  finalizeTransition(transition, TRANSITION_PHASE.TIMED_OUT, null, 'timeout_without_evidence', {
    resolvedBy: 'fallback',
    verificationOutcome: VERIFICATION_OUTCOME.UNKNOWN,
  });
}

function pruneTransitions() {
  let index = 0;
  while (transitionOrder.length > MAX_TRANSITIONS && index < transitionOrder.length) {
    const candidateId = transitionOrder[index];
    const candidate = transitions.get(candidateId);
    if (!candidate || candidate.closed) {
      transitionOrder.splice(index, 1);
      transitions.delete(candidateId);
      clearTransitionTimeout(candidateId);
      continue;
    }
    index += 1;
  }
}

function handleInjectRequested(event) {
  createTransitionFromEvent(event);
}

function handleInjectQueued(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }
  setPhase(transition, TRANSITION_PHASE.DEFERRED, event);
}

function handleInjectApplied(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }

  if (!evaluatePreconditionsForApply(transition, event)) {
    setPhase(transition, TRANSITION_PHASE.DEFERRED, event, 'precondition_failed_before_apply');
    return;
  }

  if (!TERMINAL_PHASES.has(transition.phase)) {
    if (transition.phase === TRANSITION_PHASE.REQUESTED || transition.phase === TRANSITION_PHASE.DEFERRED) {
      setPhase(transition, TRANSITION_PHASE.ACCEPTED, event);
    }
    setPhase(transition, TRANSITION_PHASE.APPLIED, event);
  }
}

function handleInjectSubmitRequested(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }

  if (!promoteToAppliedWithPreconditions(transition, event, 'submit_without_explicit_apply')) {
    return;
  }

  if (transition.phase === TRANSITION_PHASE.APPLIED) {
    setPhase(transition, TRANSITION_PHASE.VERIFYING, event);
    scheduleTransitionTimeout(transition, event);
  } else if (transition.phase !== TRANSITION_PHASE.VERIFYING) {
    markInvalid(transition, event, 'submit_requested_out_of_phase', { currentPhase: transition.phase });
  } else {
    scheduleTransitionTimeout(transition, event);
  }
}

function handleInjectSubmitSent(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }

  if (transition.phase === TRANSITION_PHASE.REQUESTED || transition.phase === TRANSITION_PHASE.DEFERRED) {
    if (!evaluatePreconditionsForApply(transition, event)) {
      if (transition.phase === TRANSITION_PHASE.REQUESTED) {
        setPhase(transition, TRANSITION_PHASE.DEFERRED, event, 'precondition_failed_before_apply');
      }
      return;
    }
    if (transition.phase === TRANSITION_PHASE.REQUESTED) {
      if (!setPhase(transition, TRANSITION_PHASE.ACCEPTED, event, 'submit_sent_without_accept')) {
        return;
      }
    }
  }

  if (transition.phase === TRANSITION_PHASE.ACCEPTED) {
    if (!evaluatePreconditionsForApply(transition, event)) {
      return;
    }
    if (!setPhase(transition, TRANSITION_PHASE.APPLIED, event, 'submit_sent_without_apply')) {
      return;
    }
    setPhase(transition, TRANSITION_PHASE.VERIFYING, event, 'submit_sent');
  } else if (transition.phase === TRANSITION_PHASE.APPLIED) {
    setPhase(transition, TRANSITION_PHASE.VERIFYING, event, 'submit_sent');
  } else if (transition.phase !== TRANSITION_PHASE.VERIFYING) {
    markInvalid(transition, event, 'submit_sent_out_of_phase', { currentPhase: transition.phase });
    return;
  }
  recordEvidence(transition, event, classifyEvidence(event, transition));
  scheduleTransitionTimeout(transition, event);
}

function handleDaemonWriteAck(event) {
  const transition = getTransitionForEvent(event, { create: false });
  if (!transition || transition.closed) return;

  const status = event?.payload?.status || '';
  const evidenceClass = classifyEvidence(event, transition);
  if (evidenceClass !== EVIDENCE_CLASS.NONE) {
    recordEvidence(transition, event, evidenceClass);
  }

  if (status && status !== 'accepted') {
    if (!ensureOwnerInvariant(transition, event)) {
      return;
    }
    finalizeTransition(transition, TRANSITION_PHASE.FAILED, event, `daemon_write_${status}`);
  }
}

function handlePtyData(event) {
  const transition = getTransitionForEvent(event, { create: false });
  if (!transition || transition.closed) return;

  const evidenceClass = classifyEvidence(event, transition);
  if (evidenceClass === EVIDENCE_CLASS.NONE) return;

  recordEvidence(transition, event, evidenceClass);
  if (evidenceClass === EVIDENCE_CLASS.DISALLOWED) {
    if (!ensureOwnerInvariant(transition, event)) {
      return;
    }
    finalizeTransition(transition, TRANSITION_PHASE.FAILED, event, 'disallowed_evidence');
  }
}

function handleStrongVerification(event) {
  const transition = getTransitionForEvent(event, { create: false });
  if (!transition || transition.closed) return;
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }
  const evidenceClass = classifyEvidence(event, transition);
  if (evidenceClass !== EVIDENCE_CLASS.NONE) {
    recordEvidence(transition, event, evidenceClass);
  }
  finalizeTransition(transition, TRANSITION_PHASE.VERIFIED, event, 'strong_verification');
}

function handleInjectFailed(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }
  recordEvidence(transition, event, EVIDENCE_CLASS.WEAK);
  if (transition.phase === TRANSITION_PHASE.REQUESTED || transition.phase === TRANSITION_PHASE.DEFERRED) {
    setPhase(transition, TRANSITION_PHASE.ACCEPTED, event, 'failure_without_apply');
  }
  finalizeTransition(transition, TRANSITION_PHASE.FAILED, event, event?.payload?.reason || 'inject_failed');
}

function handleInjectDropped(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }
  recordEvidence(transition, event, EVIDENCE_CLASS.WEAK);
  finalizeTransition(transition, TRANSITION_PHASE.DROPPED, event, event?.payload?.reason || 'inject_dropped');
}

function handleInjectTimeout(event) {
  const transition = getTransitionForEvent(event, { create: true });
  if (!ensureOwnerInvariant(transition, event)) {
    return;
  }
  recordEvidence(transition, event, EVIDENCE_CLASS.WEAK);
  if (transition.phase === TRANSITION_PHASE.REQUESTED || transition.phase === TRANSITION_PHASE.DEFERRED) {
    setPhase(transition, TRANSITION_PHASE.ACCEPTED, event, 'timeout_without_apply');
  }
  finalizeTransition(transition, TRANSITION_PHASE.TIMED_OUT, event, event?.payload?.reason || 'inject_timeout', {
    verificationOutcome: hasEvidence(transition, EVIDENCE_CLASS.WEAK)
      ? VERIFICATION_OUTCOME.RISKED_PASS
      : VERIFICATION_OUTCOME.UNKNOWN,
  });
}

function subscribe(type, handler) {
  if (!bus) return;
  bus.on(type, handler);
  subscriptions.push({ type, handler });
}

function init(nextBus) {
  if (!nextBus || typeof nextBus.on !== 'function' || typeof nextBus.emit !== 'function') {
    throw new Error('transition-ledger init requires a bus with on/emit');
  }

  stop();
  bus = nextBus;

  subscribe('inject.requested', handleInjectRequested);
  subscribe('inject.queued', handleInjectQueued);
  subscribe('inject.applied', handleInjectApplied);
  subscribe('inject.submit.requested', handleInjectSubmitRequested);
  subscribe('inject.submit.sent', handleInjectSubmitSent);
  subscribe('inject.failed', handleInjectFailed);
  subscribe('inject.dropped', handleInjectDropped);
  subscribe('inject.timeout', handleInjectTimeout);

  subscribe('daemon.write.ack', handleDaemonWriteAck);
  subscribe('pty.data.received', handlePtyData);
  subscribe('verify.pass', handleStrongVerification);
  subscribe('inject.verified', handleStrongVerification);
}

function stop() {
  if (bus && subscriptions.length > 0) {
    for (const entry of subscriptions) {
      bus.off(entry.type, entry.handler);
    }
  }
  subscriptions = [];
}

function reset() {
  stop();
  for (const timeoutId of timerById.values()) {
    clearTimeout(timeoutId);
  }
  timerById.clear();
  transitions = new Map();
  transitionOrder = [];
  activeByKey = new Map();
  transitionCounter = 0;
  leaseCounter = 0;
  stats = {
    created: 0,
    settledVerified: 0,
    settledUnverified: 0,
    failed: 0,
    dropped: 0,
    timedOut: 0,
    invalid: 0,
    active: 0,
  };
}

function getTransition(transitionId) {
  const item = transitions.get(transitionId);
  return item ? clone(item) : null;
}

function getByCorrelation(correlationId, paneIdOrOptions = null, maybeOptions = {}) {
  if (!correlationId) return null;
  let paneId = paneIdOrOptions;
  let options = maybeOptions;
  if (paneIdOrOptions && typeof paneIdOrOptions === 'object' && !Array.isArray(paneIdOrOptions)) {
    paneId = null;
    options = paneIdOrOptions;
  }
  const includeClosed = options?.includeClosed !== false;

  if (paneId !== null && paneId !== undefined) {
    const id = activeByKey.get(keyFor(paneId, correlationId));
    if (id && transitions.has(id)) {
      const transition = transitions.get(id);
      if (includeClosed || !transition.closed) {
        return clone(transition);
      }
    }
    if (!includeClosed) return null;
    for (const transition of transitions.values()) {
      if (
        transition.correlationId === correlationId
        && String(transition.paneId) === String(paneId)
      ) {
        return clone(transition);
      }
    }
    return null;
  }

  for (const transition of transitions.values()) {
    if (transition.correlationId === correlationId && (includeClosed || !transition.closed)) {
      return clone(transition);
    }
  }
  return null;
}

function listTransitions({
  includeClosed = true,
  paneId = null,
  phase = null,
  intentType = null,
  reasonCode = null,
  since = null,
  until = null,
  limit = 100,
} = {}) {
  const items = [];
  for (const id of transitionOrder) {
    const item = transitions.get(id);
    if (!item) continue;
    if (!includeClosed && item.closed) continue;
    if (paneId !== null && paneId !== undefined && String(item.paneId) !== String(paneId)) continue;
    if (phase && item.phase !== phase) continue;
    if (intentType && item.intentType !== intentType) continue;
    if (reasonCode && item.outcome.reasonCode !== reasonCode) continue;
    if (since && item.createdAt < since) continue;
    if (until && item.createdAt > until) continue;
    items.push(clone(item));
  }
  return items.slice(-Math.max(0, limit));
}

function query(filters = {}) {
  return listTransitions(filters);
}

function getStats() {
  return {
    ...stats,
    totalStored: transitions.size,
  };
}

module.exports = {
  init,
  stop,
  reset,
  getTransition,
  getByCorrelation,
  listTransitions,
  query,
  getStats,
  classifyEvidence,
  TRANSITION_STATES,
  TRANSITION_PHASE,
  EVIDENCE_CLASS,
  VERIFICATION_OUTCOME,
  FALLBACK_ACTION,
  TRANSITION_KIND,
  DEFAULT_EVIDENCE_SPEC,
};
