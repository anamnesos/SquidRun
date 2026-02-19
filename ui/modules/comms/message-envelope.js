const ENVELOPE_VERSION = 'hm-envelope-v1';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asNonEmptyString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function asFiniteTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function toIso(value) {
  const ts = asFiniteTimestamp(value, Date.now());
  try {
    return new Date(ts).toISOString();
  } catch {
    return new Date(Date.now()).toISOString();
  }
}

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

function buildOutboundMessageEnvelope(input = {}) {
  const source = asObject(input);
  const senderInput = asObject(source.sender);
  const targetInput = asObject(source.target);

  const timestampMs = asFiniteTimestamp(source.timestamp_ms || source.timestampMs, Date.now());
  const senderRole = asNonEmptyString(
    senderInput.role || source.sender_role || source.senderRole,
    'unknown'
  );
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
    sender: {
      role: senderRole,
    },
    target: {
      raw: targetRaw,
      role: targetRole,
      pane_id: targetPaneId,
    },
    project: normalizeProjectMetadata(source.project),
  };
}

function buildCanonicalEnvelopeMetadata(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    envelope_version: envelope.version,
    envelope,
    project: envelope.project,
    session_id: envelope.session_id,
    sender: envelope.sender,
    target: envelope.target,
    timestamp_ms: envelope.timestamp_ms,
    sent_at: envelope.sent_at,
  };
}

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

function buildTriggerFallbackDescriptor(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    content: envelope.content,
    messageId: envelope.message_id,
    metadata: buildCanonicalEnvelopeMetadata(envelope),
  };
}

function buildSpecialTargetRequest(envelopeInput = {}) {
  const envelope = buildOutboundMessageEnvelope(envelopeInput);
  return {
    content: envelope.content,
    messageId: envelope.message_id,
    senderRole: asNonEmptyString(envelope.sender?.role, 'system'),
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
  normalizeProjectMetadata,
};

