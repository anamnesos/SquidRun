'use strict';

const DOORBELL_TRIGGER_EVENTS = Object.freeze([
  'permission_prompt',
  'lead_escalation',
  'process_exit',
]);

const DOORBELL_ACK_EVENT = 'doorbell_ack';
const DOORBELL_EVENTS = Object.freeze([
  ...DOORBELL_TRIGGER_EVENTS,
  DOORBELL_ACK_EVENT,
]);

const DOORBELL_EVENT_SET = new Set(DOORBELL_EVENTS);
const DOORBELL_TRIGGER_EVENT_SET = new Set(DOORBELL_TRIGGER_EVENTS);

const DOORBELL_CHOKEPOINT_CALLERS = Object.freeze([
  { source: 'pty_permission_prompt_detector', eventName: 'permission_prompt' },
  { source: 'lead_escalation_message_parser', eventName: 'lead_escalation' },
  { source: 'pty_process_exit_handler', eventName: 'process_exit' },
  { source: 'squid_room_tab_ack', eventName: DOORBELL_ACK_EVENT },
]);

function createDoorbellState() {
  return {
    count: 0,
    sequence: 0,
    byPane: Object.create(null),
    history: [],
  };
}

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePaneId(value) {
  return asText(value, 'squid-room').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'squid-room';
}

function ensureDoorbellState(state) {
  if (!state || typeof state !== 'object') return createDoorbellState();
  if (!state.byPane || typeof state.byPane !== 'object') state.byPane = Object.create(null);
  if (!Array.isArray(state.history)) state.history = [];
  if (!Number.isFinite(Number(state.count))) state.count = 0;
  if (!Number.isFinite(Number(state.sequence))) state.sequence = 0;
  return state;
}

function validateDoorbellEvent(eventName) {
  const normalized = asText(eventName);
  if (!DOORBELL_EVENT_SET.has(normalized)) {
    throw new Error(`Unknown Shell V2 doorbell event: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function isDoorbellTriggerEvent(eventName) {
  return DOORBELL_TRIGGER_EVENT_SET.has(eventName);
}

function buildDoorbellReceipt(state, eventName, payload = {}) {
  const paneId = normalizePaneId(payload.paneId);
  const nextSequence = Number(state.sequence || 0) + 1;
  const action = eventName === DOORBELL_ACK_EVENT ? 'ack' : 'fire';
  const label = asText(payload.label, paneId);
  const detail = asText(payload.detail || payload.displayText || payload.reason, eventName);
  const messageId = asText(payload.messageId, `shell-v2-doorbell-${nextSequence}`);
  const timestampMs = Number.isFinite(Number(payload.timestampMs))
    ? Math.floor(Number(payload.timestampMs))
    : 0;

  return {
    messageId,
    sessionId: payload.sessionId || null,
    senderRole: 'system',
    targetRole: 'architect',
    channel: 'system',
    direction: 'outbound',
    sentAtMs: timestampMs,
    brokeredAtMs: timestampMs,
    rawBody: `[DOORBELL] ${eventName} pane=${paneId} label=${label} action=${action}: ${detail}`,
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: 'shell-v2-doorbell',
      scope: 'main',
      windowKey: 'main',
      shellV2Doorbell: true,
      doorbellEvent: eventName,
      doorbellAction: action,
      paneId,
      label,
      detail,
      previousCount: Number(state.count || 0),
      nextCount: eventName === DOORBELL_ACK_EVENT ? 0 : Number(state.count || 0) + 1,
    },
  };
}

async function writeDoorbellReceipt(receipt, deps = {}) {
  const writer = deps && typeof deps.writeJournal === 'function' ? deps.writeJournal : null;
  if (!writer) {
    return { ok: false, reason: 'doorbell_journal_writer_unavailable' };
  }
  const result = await writer(receipt);
  if (result && result.ok === false) return result;
  return result || { ok: true };
}

async function transitionDoorbell(state, eventName, payload = {}, deps = {}) {
  const normalizedEvent = validateDoorbellEvent(eventName);
  const doorbell = ensureDoorbellState(state);

  if (normalizedEvent === DOORBELL_ACK_EVENT && Number(doorbell.count || 0) <= 0) {
    return { ok: true, eventName: normalizedEvent, ignored: true, count: 0 };
  }

  if (normalizedEvent !== DOORBELL_ACK_EVENT && !isDoorbellTriggerEvent(normalizedEvent)) {
    throw new Error(`Doorbell event is not a trigger: ${normalizedEvent}`);
  }

  const paneId = normalizePaneId(payload.paneId);
  const receipt = buildDoorbellReceipt(doorbell, normalizedEvent, { ...payload, paneId });
  const journal = await writeDoorbellReceipt(receipt, deps);
  if (!journal || journal.ok === false) {
    return {
      ok: false,
      eventName: normalizedEvent,
      paneId,
      reason: journal?.reason || 'doorbell_receipt_failed',
      journal,
    };
  }

  doorbell.sequence = Number(doorbell.sequence || 0) + 1;
  if (normalizedEvent === DOORBELL_ACK_EVENT) {
    doorbell.count = 0;
    doorbell.byPane = Object.create(null);
  } else {
    doorbell.count = Number(doorbell.count || 0) + 1;
    doorbell.byPane[paneId] = {
      eventName: normalizedEvent,
      paneId,
      label: asText(payload.label, paneId),
      displayText: asText(payload.displayText || payload.detail || payload.reason, normalizedEvent),
      receiptMessageId: receipt.messageId,
    };
  }

  const transition = {
    eventName: normalizedEvent,
    paneId,
    count: Number(doorbell.count || 0),
    receiptMessageId: receipt.messageId,
    journal,
  };
  doorbell.history.push(transition);
  return { ok: true, ...transition };
}

module.exports = {
  DOORBELL_ACK_EVENT,
  DOORBELL_CHOKEPOINT_CALLERS,
  DOORBELL_EVENTS,
  DOORBELL_TRIGGER_EVENTS,
  createDoorbellState,
  normalizePaneId,
  transitionDoorbell,
  validateDoorbellEvent,
};
