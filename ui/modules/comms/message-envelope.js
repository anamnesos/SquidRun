// @ts-check

/** @typedef {import('../../types/contracts').CanonicalEnvelopeMetadata} CanonicalEnvelopeMetadata */
/** @typedef {import('../../types/contracts').EnvelopeDisplay} EnvelopeDisplay */
/** @typedef {import('../../types/contracts').OutboundMessageEnvelope} OutboundMessageEnvelope */
/** @typedef {import('../../types/contracts').OutboundMessageEnvelopeInput} OutboundMessageEnvelopeInput */
/** @typedef {import('../../types/contracts').ProjectMetadata} ProjectMetadata */
/** @typedef {import('../../types/contracts').SpecialTargetRequest} SpecialTargetRequest */
/** @typedef {import('../../types/contracts').TriggerFallbackDescriptor} TriggerFallbackDescriptor */
/** @typedef {import('../../types/contracts').WebSocketDispatchMessage} WebSocketDispatchMessage */

const ENVELOPE_VERSION = 'hm-envelope-v1';
const OBLIGATION_EXPECTED_CLASSES = new Set(['verdict', 'ack', 'packet', 'answer', 'receipt']);
const OBLIGATION_STALENESS_CLASSES = new Set(['turn', 'beat', 'day', 'open']);

/**
 * @param {unknown} value
 * @returns {any}
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return /** @type {any} */ (value);
}

/**
 * @param {unknown} value
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
function asNonEmptyString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function asFiniteTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toIso(value) {
  const ts = asFiniteTimestamp(value, Date.now());
  try {
    return new Date(ts).toISOString();
  } catch {
    return new Date(Date.now()).toISOString();
  }
}

/**
 * @param {unknown} [projectInput]
 * @returns {ProjectMetadata | null}
 */
function normalizeProjectMetadata(projectInput = null) {
  const project = asObject(projectInput);
  const name = asNonEmptyString(project.name);
  const projectPath = asNonEmptyString(project.path);
  const sessionId = asNonEmptyString(project.session_id || project.sessionId);
  const source = asNonEmptyString(project.source);
  if (!name && !projectPath && !sessionId && !source) return null;
  return {
    name: name || null,
    path: projectPath || null,
    session_id: sessionId || null,
    source: source || null,
  };
}

/**
 * @param {unknown} [displayInput]
 * @returns {EnvelopeDisplay | null}
 */
function normalizeEnvelopeDisplay(displayInput = null) {
  const display = asObject(displayInput);
  const face = asNonEmptyString(
    display.face || display.authored_face || display.authoredFace,
    null
  );
  if (!face) return null;
  return { face };
}

/**
 * @param {unknown} [expectationInput]
 * @returns {import('../../types/contracts').ObligationExpectation | null}
 */
function normalizeEnvelopeExpectation(expectationInput = null) {
  const expectation = asObject(expectationInput);
  const expectedClass = asNonEmptyString(expectation.class || expectation.expected_class || expectation.expectedClass);
  const stalenessClass = asNonEmptyString(
    expectation.staleness_class || expectation.stalenessClass || expectation.staleness
  );
  const normalizedClass = expectedClass?.toLowerCase() || '';
  const normalizedStaleness = stalenessClass?.toLowerCase() || '';
  if (!OBLIGATION_EXPECTED_CLASSES.has(normalizedClass)
    || !OBLIGATION_STALENESS_CLASSES.has(normalizedStaleness)) return null;
  const leaseId = asNonEmptyString(expectation.lease_id || expectation.leaseId);
  return {
    class: /** @type {import('../../types/contracts').ObligationExpectation['class']} */ (normalizedClass),
    staleness_class: /** @type {import('../../types/contracts').ObligationExpectation['staleness_class']} */ (normalizedStaleness),
    ...(leaseId ? { lease_id: leaseId } : {}),
  };
}

/**
 * @param {unknown} [fulfillmentInput]
 * @returns {import('../../types/contracts').ObligationFulfillmentDeclaration | null}
 */
function normalizeEnvelopeFulfillment(fulfillmentInput = null) {
  const fulfillment = typeof fulfillmentInput === 'string'
    ? { obligation_id: fulfillmentInput }
    : asObject(fulfillmentInput);
  const obligationId = asNonEmptyString(fulfillment.obligation_id || fulfillment.obligationId);
  return obligationId ? { obligation_id: obligationId } : null;
}

/**
 * @param {OutboundMessageEnvelopeInput} [input]
 * @returns {OutboundMessageEnvelope}
 */
function buildOutboundMessageEnvelope(input = {}) {
  const source = asObject(input);
  const senderInput = asObject(source.sender);
  const targetInput = asObject(source.target);

  const timestampMs = asFiniteTimestamp(source.timestamp_ms || source.timestampMs, Date.now());
  const senderRole = asNonEmptyString(
    senderInput.role || source.sender_role || source.senderRole,
    'unknown'
  ) || 'unknown';
  const targetRaw = asNonEmptyString(
    targetInput.raw || source.target_raw || source.targetRaw,
    null
  );
  const targetRole = asNonEmptyString(
    targetInput.role || source.target_role || source.targetRole,
    null
  );
  const targetPaneId = asNonEmptyString(
    targetInput.pane_id || targetInput.paneId || source.target_pane_id || source.targetPaneId,
    null
  );

  return {
    version: ENVELOPE_VERSION,
    message_id: asNonEmptyString(source.message_id || source.messageId, null),
    timestamp_ms: timestampMs,
    sent_at: toIso(timestampMs),
    session_id: asNonEmptyString(source.session_id || source.sessionId, null),
    priority: asNonEmptyString(source.priority, null),
    content: asNonEmptyString(source.content, '') || '',
    display: normalizeEnvelopeDisplay(
      source.display || {
        face: source.face || source.authored_face || source.authoredFace,
      }
    ),
    sender: {
      role: senderRole,
    },
    target: {
      raw: targetRaw,
      role: targetRole,
      pane_id: targetPaneId,
    },
    project: normalizeProjectMetadata(source.project),
    expects: normalizeEnvelopeExpectation(source.expects),
    fulfills: normalizeEnvelopeFulfillment(source.fulfills),
  };
}

/**
 * @param {OutboundMessageEnvelopeInput | OutboundMessageEnvelope} [envelopeInput]
 * @returns {CanonicalEnvelopeMetadata}
 */
function buildCanonicalEnvelopeMetadata(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    envelope_version: envelope.version,
    envelope,
    project: envelope.project,
    display: envelope.display,
    session_id: envelope.session_id,
    sender: envelope.sender,
    target: envelope.target,
    expects: envelope.expects,
    fulfills: envelope.fulfills,
    timestamp_ms: envelope.timestamp_ms,
    sent_at: envelope.sent_at,
  };
}

/**
 * @param {OutboundMessageEnvelopeInput | OutboundMessageEnvelope} [envelopeInput]
 * @param {Record<string, unknown>} [options]
 * @returns {WebSocketDispatchMessage}
 */
function buildWebSocketDispatchMessage(envelopeInput = {}, options = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  const opts = asObject(options);
  return {
    type: 'send',
    target: asNonEmptyString(opts.target) || envelope.target.raw,
    content: envelope.content,
    priority: asNonEmptyString(opts.priority) || envelope.priority || 'normal',
    metadata: buildCanonicalEnvelopeMetadata(envelope),
    messageId: envelope.message_id,
    ackRequired: opts.ackRequired !== false,
    attempt: Number.isFinite(Number(opts.attempt)) ? Number(opts.attempt) : 1,
    maxAttempts: Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : 1,
  };
}

/**
 * @param {OutboundMessageEnvelopeInput | OutboundMessageEnvelope} [envelopeInput]
 * @returns {TriggerFallbackDescriptor}
 */
function buildTriggerFallbackDescriptor(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    content: envelope.content,
    messageId: envelope.message_id,
    metadata: buildCanonicalEnvelopeMetadata(envelope),
  };
}

/**
 * @param {OutboundMessageEnvelopeInput | OutboundMessageEnvelope} [envelopeInput]
 * @returns {SpecialTargetRequest}
 */
function buildSpecialTargetRequest(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    content: envelope.content,
    messageId: envelope.message_id,
    senderRole: asNonEmptyString(envelope.sender?.role, 'system') || 'system',
    sessionId: asNonEmptyString(envelope.session_id, null),
    metadata: buildCanonicalEnvelopeMetadata(envelope),
  };
}

module.exports = {
  ENVELOPE_VERSION,
  buildOutboundMessageEnvelope,
  buildCanonicalEnvelopeMetadata,
  buildWebSocketDispatchMessage,
  buildTriggerFallbackDescriptor,
  buildSpecialTargetRequest,
  normalizeEnvelopeDisplay,
  normalizeEnvelopeExpectation,
  normalizeEnvelopeFulfillment,
  normalizeProjectMetadata,
};
