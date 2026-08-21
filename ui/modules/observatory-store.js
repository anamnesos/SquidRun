const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVENT_SCHEMA = 'squidrun.observatory_event.v1';
const EVENT_TYPES = new Set([
  'opened',
  'evidence_added',
  'disconfirmer_added',
  'next_probe_set',
  'review_scheduled',
  'status_changed',
  'promoted_to_initiative',
  'expired',
]);
const OWNER_SEATS = new Set(['architect', 'builder', 'oracle']);
const STATUSES = new Set(['open', 'watching', 'resolved', 'dismissed', 'expired']);
const ACTIVE_STATUSES = new Set(['open', 'watching']);
const STAKES = new Set(['low', 'medium', 'high']);

class ObservatoryLogError extends Error {
  constructor(message, { lineNumber = null, validEvents = [], states = new Map() } = {}) {
    super(message);
    this.name = 'ObservatoryLogError';
    this.lineNumber = lineNumber;
    this.validEvents = validEvents;
    this.states = states;
  }
}

function asNonEmptyString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeIso(value, label) {
  const normalized = asNonEmptyString(value, label);
  const timestamp = new Date(normalized);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return timestamp.toISOString();
}

function normalizeOwner(value) {
  const owner = String(value || '').trim().toLowerCase();
  if (!OWNER_SEATS.has(owner)) throw new Error(`invalid observatory owner: ${value}`);
  return owner;
}

function normalizeStakes(value) {
  const stakes = String(value || '').trim().toLowerCase();
  if (!STAKES.has(stakes)) throw new Error('stakes must be low, medium, or high');
  return stakes;
}

function generateObservationId(now = new Date()) {
  return `obs-${Math.floor(now.getTime() / 1000)}-${crypto.randomBytes(3).toString('hex')}`;
}

function makeEvidenceReference(input, actor, at) {
  const scopeSearched = typeof input.scopeSearched === 'string' ? input.scopeSearched.trim() : '';
  const missingArtifact = input.missingArtifact === true;
  if (missingArtifact && !scopeSearched) {
    throw new Error('missing-artifact evidence requires scopeSearched');
  }
  return {
    ref: asNonEmptyString(input.ref, 'evidence ref'),
    note: typeof input.note === 'string' ? input.note.trim() : '',
    scopeSearched,
    missingArtifact,
    countercheck: input.countercheck === true,
    recordedBy: normalizeOwner(actor),
    recordedAt: normalizeIso(at, 'evidence timestamp'),
  };
}

function validateOpening(input, actor, at) {
  const owner = normalizeOwner(actor);
  const openedAt = normalizeIso(at, 'opened timestamp');
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length === 0) throw new Error('at least one evidence reference is required');
  const reviewAt = normalizeIso(input.reviewAt, 'reviewAt');
  const expiresAt = input.expiresAt ? normalizeIso(input.expiresAt, 'expiresAt') : null;
  const noExpiryReason = typeof input.noExpiryReason === 'string'
    ? input.noExpiryReason.trim()
    : '';
  if (!expiresAt && !noExpiryReason) {
    throw new Error('expiresAt or noExpiryReason is required');
  }
  if (expiresAt && new Date(expiresAt).getTime() <= new Date(openedAt).getTime()) {
    throw new Error('expiresAt must be later than the opening time');
  }

  return {
    question: asNonEmptyString(input.question, 'question'),
    whyItMatters: asNonEmptyString(input.whyItMatters, 'whyItMatters'),
    stakes: normalizeStakes(input.stakes),
    favorable: input.favorable === true,
    status: 'open',
    evidence: evidence.map((entry) => makeEvidenceReference(entry, owner, openedAt)),
    disconfirmers: (Array.isArray(input.disconfirmers) ? input.disconfirmers : [])
      .map((entry) => makeEvidenceReference(entry, owner, openedAt)),
    nextProbe: asNonEmptyString(input.nextProbe, 'nextProbe'),
    reviewAt,
    expiresAt,
    noExpiryReason: expiresAt ? null : noExpiryReason,
  };
}

function makeEvent({ id, owner, type, payload = {}, at = new Date().toISOString() }) {
  const eventType = String(type || '').trim();
  if (!EVENT_TYPES.has(eventType)) throw new Error(`invalid observatory event type: ${type}`);
  return {
    schema: EVENT_SCHEMA,
    id: asNonEmptyString(id, 'observation id'),
    owner: normalizeOwner(owner),
    type: eventType,
    at: normalizeIso(at instanceof Date ? at.toISOString() : at, 'event timestamp'),
    payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
  };
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  if (event.schema !== EVENT_SCHEMA) throw new Error(`unsupported event schema: ${event.schema}`);
  const normalized = makeEvent(event);
  for (const field of ['id', 'owner', 'type', 'at']) {
    if (event[field] !== normalized[field]) {
      throw new Error(`event ${field} must be canonical`);
    }
  }
  return normalized;
}

function cloneStates(states) {
  return new Map(Array.from(states.entries(), ([id, state]) => [
    id,
    JSON.parse(JSON.stringify(state)),
  ]));
}

function applyEvent(states, rawEvent) {
  const event = validateEvent(rawEvent);
  const current = states.get(event.id);

  if (event.type === 'opened') {
    if (current) throw new Error(`observation already opened: ${event.id}`);
    const opening = validateOpening(event.payload, event.owner, event.at);
    states.set(event.id, {
      id: event.id,
      owner: event.owner,
      createdAt: event.at,
      updatedAt: event.at,
      ...opening,
      initiativeId: null,
    });
    return states.get(event.id);
  }

  if (!current) throw new Error(`event precedes opened event: ${event.id}`);
  if (current.owner !== event.owner) {
    throw new Error(`owner mismatch for ${event.id}: ${event.owner} cannot mutate ${current.owner}`);
  }

  const next = {
    ...current,
    evidence: current.evidence.slice(),
    disconfirmers: current.disconfirmers.slice(),
    updatedAt: event.at,
  };
  if (event.type === 'evidence_added') {
    next.evidence.push(makeEvidenceReference(event.payload, event.owner, event.at));
  } else if (event.type === 'disconfirmer_added') {
    next.disconfirmers.push(makeEvidenceReference(event.payload, event.owner, event.at));
  } else if (event.type === 'next_probe_set') {
    next.nextProbe = asNonEmptyString(event.payload.nextProbe, 'nextProbe');
  } else if (event.type === 'review_scheduled') {
    next.reviewAt = normalizeIso(event.payload.reviewAt, 'reviewAt');
    if (event.payload.expiresAt) {
      next.expiresAt = normalizeIso(event.payload.expiresAt, 'expiresAt');
      next.noExpiryReason = null;
    } else if (event.payload.noExpiryReason) {
      next.expiresAt = null;
      next.noExpiryReason = asNonEmptyString(event.payload.noExpiryReason, 'noExpiryReason');
    }
  } else if (event.type === 'status_changed') {
    const status = String(event.payload.status || '').trim().toLowerCase();
    if (!STATUSES.has(status) || status === 'expired') {
      throw new Error(`invalid status change: ${event.payload.status}`);
    }
    next.status = status;
    next.statusReason = asNonEmptyString(event.payload.reason, 'status reason');
  } else if (event.type === 'promoted_to_initiative') {
    const initiativeId = asNonEmptyString(event.payload.initiativeId, 'initiativeId');
    if (next.initiativeId && next.initiativeId !== initiativeId) {
      throw new Error(`observation already linked to ${next.initiativeId}`);
    }
    next.initiativeId = initiativeId;
  } else if (event.type === 'expired') {
    next.status = 'expired';
    next.statusReason = asNonEmptyString(event.payload.reason, 'expiry reason');
  }

  states.set(event.id, next);
  return next;
}

function reconstructEvents(events) {
  const states = new Map();
  for (const event of events) applyEvent(states, event);
  return states;
}

function loadObservationLog(filePath) {
  if (!fs.existsSync(filePath)) return { events: [], states: new Map() };
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  const states = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const event = JSON.parse(lines[index]);
      applyEvent(states, event);
      events.push(event);
    } catch (err) {
      throw new ObservatoryLogError(
        `observatory log is invalid at line ${index + 1}: ${err.message}`,
        { lineNumber: index + 1, validEvents: events.slice(), states: cloneStates(states) }
      );
    }
  }
  return { events, states };
}

function appendEvent(filePath, event) {
  validateEvent(event);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function openObservation({ filePath, input, actor, at = new Date(), id = null }) {
  const owner = normalizeOwner(actor);
  const timestamp = at instanceof Date ? at.toISOString() : normalizeIso(at, 'opened timestamp');
  const observationId = id || generateObservationId(new Date(timestamp));
  const payload = validateOpening(input, owner, timestamp);
  const event = makeEvent({ id: observationId, owner, type: 'opened', payload, at: timestamp });
  const loaded = loadObservationLog(filePath);
  if (loaded.states.has(observationId)) {
    throw new Error(`observation already opened: ${observationId}`);
  }
  const state = applyEvent(loaded.states, event);
  appendEvent(filePath, event);
  return { event, state };
}

function assertMutable(state, actor, at, eventType) {
  const owner = normalizeOwner(actor);
  if (state.owner !== owner) throw new Error(`${owner} cannot mutate ${state.owner} observation ${state.id}`);
  if (!ACTIVE_STATUSES.has(state.status)) {
    throw new Error(`observation ${state.id} is ${state.status} and cannot be mutated`);
  }
  const eventTime = new Date(at);
  if (eventType !== 'expired' && effectiveStatus(state, eventTime) === 'expired') {
    throw new Error(`observation ${state.id} has expired and must be closed explicitly`);
  }
}

function appendObservationEvent({ filePath, id, actor, type, payload, at = new Date() }) {
  const loaded = loadObservationLog(filePath);
  const state = loaded.states.get(id);
  if (!state) throw new Error(`unknown observation: ${id}`);
  const timestamp = at instanceof Date ? at.toISOString() : normalizeIso(at, 'event timestamp');
  assertMutable(state, actor, timestamp, type);
  if (type === 'review_scheduled' && new Date(timestamp).getTime() >= new Date(state.reviewAt).getTime()) {
    const observationEvents = loaded.events.filter((event) => event.id === id);
    let checkpoint = -1;
    for (let index = 0; index < observationEvents.length; index += 1) {
      if (observationEvents[index].type === 'opened' || observationEvents[index].type === 'review_scheduled') {
        checkpoint = index;
      }
    }
    const progressTypes = new Set([
      'evidence_added',
      'disconfirmer_added',
      'next_probe_set',
      'promoted_to_initiative',
      'status_changed',
      'expired',
    ]);
    const progressed = observationEvents.slice(checkpoint + 1)
      .some((event) => progressTypes.has(event.type));
    if (!progressed) {
      throw new Error('a due review requires new evidence, a new probe, promotion, resolution, dismissal, or expiry');
    }
  }
  const event = makeEvent({ id, owner: actor, type, payload, at: timestamp });
  const next = applyEvent(loaded.states, event);
  appendEvent(filePath, event);
  return { event, state: next };
}

function effectiveStatus(state, now = new Date()) {
  if (!ACTIVE_STATUSES.has(state.status)) return state.status;
  if (state.expiresAt && new Date(state.expiresAt).getTime() <= now.getTime()) return 'expired';
  return state.status;
}

function latestEvidenceAt(state) {
  const timestamps = [...state.evidence, ...state.disconfirmers]
    .map((entry) => new Date(entry.recordedAt).getTime())
    .filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function projectObservation(state, now = new Date()) {
  const effective = effectiveStatus(state, now);
  const due = ACTIVE_STATUSES.has(state.status) && (
    effective === 'expired' || new Date(state.reviewAt).getTime() <= now.getTime()
  );
  const evidenceAt = latestEvidenceAt(state);
  return {
    ...state,
    effectiveStatus: effective,
    due,
    latestEvidenceAt: evidenceAt,
    evidenceAgeMs: evidenceAt ? Math.max(0, now.getTime() - new Date(evidenceAt).getTime()) : null,
  };
}

function listObservations(states, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const actor = options.actor ? normalizeOwner(options.actor) : null;
  const requestedStatus = options.status ? String(options.status).trim().toLowerCase() : null;
  let items = Array.from(states.values()).map((state) => projectObservation(state, now));
  if (options.mine === true && actor) items = items.filter((state) => state.owner === actor);
  if (options.due === true) items = items.filter((state) => state.due);
  if (options.activeOnly === true) {
    items = items.filter((state) => ACTIVE_STATUSES.has(state.effectiveStatus));
  }
  if (requestedStatus) items = items.filter((state) => state.effectiveStatus === requestedStatus);
  return items.sort((left, right) => {
    const reviewDelta = String(left.reviewAt).localeCompare(String(right.reviewAt));
    if (reviewDelta !== 0) return reviewDelta;
    return left.id.localeCompare(right.id);
  });
}

module.exports = {
  ACTIVE_STATUSES,
  EVENT_SCHEMA,
  EVENT_TYPES,
  OWNER_SEATS,
  ObservatoryLogError,
  appendEvent,
  appendObservationEvent,
  applyEvent,
  effectiveStatus,
  generateObservationId,
  latestEvidenceAt,
  listObservations,
  loadObservationLog,
  makeEvent,
  makeEvidenceReference,
  normalizeOwner,
  openObservation,
  projectObservation,
  reconstructEvents,
};
