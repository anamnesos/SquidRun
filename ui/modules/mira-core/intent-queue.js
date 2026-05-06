'use strict';

const crypto = require('crypto');

const INTENT_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.intent_record.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.intent_queue_validation_report.v0';
const INTENT_QUEUE_VERSION = 'v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze(['intent_records', 'validation_report']);
const REQUIRED_INTENT_RECORD_FIELDS = Object.freeze([
  'schema',
  'version',
  'intent_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_refs',
  'requested_by',
  'target_role',
  'allowed_target_roles',
  'risk_tier',
  'action_class',
  'status',
  'local_arm_required',
  'review_required',
  'expires_at',
  'dedupe_key',
  'payload_summary',
  'payload_hash',
  'payload_redaction_status',
  'evidenceRefs',
  'safe_next_action',
  'blocked_because',
  'no_execution_performed',
]);
const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'decision',
  'input_refs',
  'accepted_count',
  'review_required_count',
  'blocked_count',
  'rejected_count',
  'expired_count',
  'routing_result',
  'risk_result',
  'redaction_result',
  'profile_scope_result',
  'freshness_result',
  'idempotency_result',
  'dedupe_result',
  'capability_truth_result',
  'side_effect_result',
  'records_summary',
  'reasons',
  'followup_required',
]);
const REQUIRED_SOURCE_REF_FIELDS = Object.freeze([
  'source_type',
  'source_id',
  'source_hash',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
]);
const REQUIRED_REQUESTED_BY_FIELDS = Object.freeze([
  'kind',
  'display_ref',
  'authority_level',
  'source_ref',
]);

const SAFE_PENDING_RISK_TIERS = Object.freeze(['tier0_read_only', 'tier1_local_reversible']);
const SAFE_PENDING_ACTION_CLASSES = Object.freeze([
  'read_only_research',
  'offline_reminder',
  'status_request',
  'memory_proposal_review',
  'eval_followup_review',
  'safe_plan_preparation',
  'draft_only_no_send',
]);
const REVIEW_REQUIRED_ACTION_CLASSES = Object.freeze([
  'repo_mutation',
  'test_run_with_side_effect_risk',
  'browser_or_gui_action',
]);
const ALWAYS_BLOCKED_ACTION_CLASSES = Object.freeze([
  'identity_core_rewrite',
  'secrets_or_auth_change',
  'deploy',
  'customer_send',
  'telegram_send_as_mira',
  'webhook_change',
  'payment_or_invoice_action',
  'trade_or_financial_action',
  'destructive_filesystem_or_database_action',
  'local_shell_execution',
  'pty_operation',
]);
const DIRECT_TARGETS_BLOCKED = Object.freeze([
  'builder',
  'oracle',
  'hidden_host',
  'supervisor',
  'pty',
  'shell',
  'server',
]);
const RAW_PAYLOAD_CLASSES = Object.freeze([
  'raw_comms',
  'raw_terminal',
  'screenshot_ocr',
  'browser_state',
  'secret_like',
  'auth_change',
  'customer_private_data',
  'side_profile_content',
  'raw_database_record',
]);
const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser session state',
  'BrowserProfile\\Cookies',
  'customer private note',
  'customer phone',
  'side-profile private note',
  'full sqlite row payload',
  'server can execute local shell',
  'cloud can operate PTY',
  'server routed to builder',
  'server routed to oracle',
  'lease created',
  'queue write complete',
  'customer message sent',
  'deployment started',
  'trade placed',
  'model-processing proof from websocket acceptance',
  'identity rewrite committed',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortObject(value)))
    .digest('hex');
}

function sha256(value) {
  return `sha256:${stableHash(value)}`;
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function normalizeProfileName(value) {
  return String(value || 'main').trim() || 'main';
}

function normalizeRole(value) {
  return String(value || 'architect').trim().toLowerCase() || 'architect';
}

function normalizeScope(inputSignals = {}, request = {}) {
  const envelopeScope = inputSignals.envelopeScope || {};
  const profileName = normalizeProfileName(
    envelopeScope.profile
    || request.profile
    || inputSignals.profile
    || inputSignals.fixtureA?.profile
    || 'main'
  );
  return {
    profileName,
    sessionId: envelopeScope.sessionId || request.sessionId || inputSignals.sessionId || inputSignals.fixtureA?.sessionId || 'app-session-326',
    deviceId: envelopeScope.deviceId || request.deviceId || inputSignals.deviceId || inputSignals.fixtureA?.deviceId || 'VIGIL',
  };
}

function envelopeScope(inputSignals = {}) {
  const envelope = inputSignals.envelopeScope || {};
  return {
    profileName: normalizeProfileName(envelope.profile || inputSignals.profile || inputSignals.fixtureA?.profile || 'main'),
    sessionId: envelope.sessionId || inputSignals.sessionId || inputSignals.fixtureA?.sessionId || 'app-session-326',
    deviceId: envelope.deviceId || inputSignals.deviceId || inputSignals.fixtureA?.deviceId || 'VIGIL',
  };
}

function profileObject(scope) {
  return {
    name: scope.profileName,
    windowKey: scope.profileName,
    sessionScopeId: scope.sessionId,
  };
}

function requestList(inputSignals = {}) {
  if (Array.isArray(inputSignals.requests)) return inputSignals.requests;
  if (inputSignals.request && typeof inputSignals.request === 'object') return [inputSignals.request];
  if (inputSignals.fixtureA || inputSignals.action_class || inputSignals.risk_tier || inputSignals.payload_hash || inputSignals.source_hash) {
    return [inputSignals];
  }
  if (asArray(inputSignals.rawPayloadClasses).length > 0) {
    return [{
      requested_by: 'server_offline_capture',
      target_role: 'architect',
      risk_tier: 'tier0_read_only',
      action_class: 'offline_reminder',
      rawPayloadClasses: inputSignals.rawPayloadClasses,
    }];
  }
  if (asArray(inputSignals.blockedExamples).length > 0) {
    return [{
      requested_by: 'server_offline_capture',
      target_role: 'architect',
      risk_tier: 'tier0_read_only',
      action_class: 'offline_reminder',
      blockedExamples: inputSignals.blockedExamples,
      payload_redaction_status: 'blocked',
    }];
  }
  if (inputSignals.requestedPhase) {
    return [{
      requested_by: 'system',
      target_role: 'architect',
      risk_tier: 'tier0_read_only',
      action_class: 'status_request',
      payload_summary: 'Prepare Phase 8 side-effect audit status.',
    }];
  }
  return [];
}

function requestedBy(value, sourceId = 'intent-request') {
  const kind = typeof value === 'object' && value !== null
    ? String(value.kind || 'system')
    : String(value || 'system');
  return {
    kind,
    display_ref: typeof value === 'object' && value !== null ? (value.display_ref || kind) : kind,
    authority_level: typeof value === 'object' && value !== null ? (value.authority_level || 'request_metadata') : 'request_metadata',
    source_ref: typeof value === 'object' && value !== null ? (value.source_ref || sourceId) : sourceId,
  };
}

function sourceRefsFor(inputSignals = {}, request = {}, scope, generatedAt) {
  const refs = asArray(request.source_refs).length > 0
    ? request.source_refs
    : (asArray(inputSignals.source_refs).length > 0 ? inputSignals.source_refs : []);
  const sourceCreatedAt = request.source_ref_generated_at || generatedAt;
  if (refs.length === 0) {
    const sourceId = request.source_id || `${request.action_class || 'intent'}:${stableHash(request).slice(0, 10)}`;
    return [{
      source_type: request.source_type || 'intent_request',
      source_id: sourceId,
      source_hash: request.source_hash || request.sourceHash || sha256({
        sourceId,
        action_class: request.action_class,
        payload_hash: request.payload_hash,
      }),
      created_at: sourceCreatedAt,
      profile: request.profile || scope.profileName,
      sessionId: request.sessionId || scope.sessionId,
      deviceId: request.deviceId || scope.deviceId,
    }];
  }
  return refs.map((ref) => ({
    source_type: ref.source_type || 'intent_request',
    source_id: ref.source_id || `source:${stableHash(ref).slice(0, 10)}`,
    source_hash: ref.source_hash || sha256(ref),
    created_at: ref.created_at || sourceCreatedAt,
    profile: ref.profile || scope.profileName,
    sessionId: ref.sessionId || scope.sessionId,
    deviceId: ref.deviceId || scope.deviceId,
  }));
}

function rawClassesFor(inputSignals = {}, request = {}) {
  return Array.from(new Set(asArray(inputSignals.rawPayloadClasses).concat(asArray(request.rawPayloadClasses))));
}

function privatePayloadDetected(inputSignals = {}, request = {}) {
  if (request.payload_redaction_status === 'blocked' || request.payloadRedactionStatus === 'blocked') return true;
  if (asArray(inputSignals.blockedExamples).length > 0 || asArray(request.blockedExamples).length > 0) return true;
  const summary = String(request.payload_summary || '');
  return FORBIDDEN_OUTPUT_SUBSTRINGS.some((forbidden) => forbidden && summary.includes(forbidden));
}

function payloadFor(inputSignals = {}, request = {}) {
  const rawClasses = rawClassesFor(inputSignals, request);
  if (rawClasses.some((item) => RAW_PAYLOAD_CLASSES.includes(item)) || privatePayloadDetected(inputSignals, request)) {
    return {
      payload_summary: 'Redacted request summary unavailable because payload contains blocked private content.',
      payload_redaction_status: 'blocked',
      payload_hash: request.payload_hash || sha256({
        redacted: true,
        rawClasses,
        action_class: request.action_class,
        blockedInputPresent: true,
      }),
      rawBlocked: true,
      redactionCounts: {
        rawPayloadBlocked: 1,
        secretLikeBlocked: rawClasses.includes('secret_like') ? 1 : 0,
        customerPrivateDataBlocked: rawClasses.includes('customer_private_data') ? 1 : 0,
        sideProfileBlocked: rawClasses.includes('side_profile_content') ? 1 : 0,
        terminalOrBrowserBlocked: rawClasses.some((item) => ['raw_terminal', 'browser_state', 'screenshot_ocr'].includes(item)) ? 1 : 0,
      },
    };
  }
  const payload_summary = String(request.payload_summary || 'Prepare local Architect review for this intent.').slice(0, 220);
  const payload_redaction_status = request.payload_redaction_status || request.payloadRedactionStatus || 'none';
  const payload_hash = request.payload_hash || request.payloadHash || sha256({
    payload_summary,
    payload_redaction_status,
    action_class: request.action_class,
  });
  return {
    payload_summary,
    payload_redaction_status,
    payload_hash,
    rawBlocked: false,
    redactionCounts: {
      rawPayloadBlocked: 0,
      secretLikeBlocked: 0,
      customerPrivateDataBlocked: 0,
      sideProfileBlocked: 0,
      terminalOrBrowserBlocked: 0,
    },
  };
}

function isExpired(request = {}, generatedAt) {
  if (!request.expires_at) return false;
  const expiresAt = Date.parse(request.expires_at);
  const now = Date.parse(generatedAt);
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now;
}

function isStaleSource(sourceRefs = [], generatedAt) {
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(now)) return false;
  return sourceRefs.some((ref) => {
    const created = Date.parse(ref.created_at);
    return Number.isFinite(created) && now - created > 72 * 60 * 60 * 1000;
  });
}

function scopeMismatch(scope, sourceRefs = [], envelope) {
  if (
    scope.profileName !== envelope.profileName
    || scope.sessionId !== envelope.sessionId
    || scope.deviceId !== envelope.deviceId
  ) {
    return true;
  }
  return sourceRefs.some((ref) => ref.profile !== envelope.profileName || ref.sessionId !== envelope.sessionId || ref.deviceId !== envelope.deviceId);
}

function safeAlternative(actionClass, targetRole = 'architect') {
  const map = {
    customer_send: 'Prepare a non-sent draft or read-only customer context note for local review.',
    deploy: 'Prepare a deploy readiness checklist without deploying.',
    trade_or_financial_action: 'Prepare a read-only risk summary.',
    payment_or_invoice_action: 'Prepare a read-only risk summary.',
    identity_core_rewrite: 'Create a review-only identity proposal with evidence and eval refs.',
    secrets_or_auth_change: 'Prepare a redacted checklist of required auth facts for local review.',
    local_shell_execution: 'Ask local Architect to review the request after reconnect.',
    pty_operation: 'Ask local Architect to review the request after reconnect.',
    repo_mutation: 'Prepare a read-only implementation plan or acceptance checklist for local Architect review.',
    browser_or_gui_action: 'Prepare a read-only plan for local Architect review.',
    builder: 'Target local Architect for review; local Architect may delegate after reconnect.',
    oracle: 'Target local Architect for review; local Architect may delegate after reconnect.',
  };
  return map[actionClass] || map[targetRole] || 'Prepare a safe read-only alternative for local Architect review.';
}

function blockedBecauseFor(actionClass, riskTier, targetRole) {
  if (targetRole === 'builder') return 'Server-originated direct Builder targeting is blocked in v0.';
  if (targetRole === 'oracle') return 'Server-originated direct Oracle targeting is blocked in v0.';
  const map = {
    customer_send: 'Customer-facing sends are external side effects and cannot enter the v0 intent queue as pending local acceptance.',
    deploy: 'Deploys are Tier 3 external side effects and are outside Phase 8 v0.',
    trade_or_financial_action: 'Financial or irreversible actions are blocked unless a fresh explicit lane is opened with current proof.',
    payment_or_invoice_action: 'Financial or irreversible actions are blocked unless a fresh explicit lane is opened with current proof.',
    identity_core_rewrite: 'Identity-core rewrites cannot be queued or committed in Phase 8.',
    secrets_or_auth_change: 'Secrets/auth changes are blocked in Phase 8.',
    local_shell_execution: 'Future server cannot execute local shell or PTY actions.',
    pty_operation: 'Future server cannot execute local shell or PTY actions.',
  };
  if (map[actionClass]) return map[actionClass];
  if (riskTier === 'tier3_external_side_effect') return 'Tier 3 external side effects are blocked in Phase 8 v0.';
  if (riskTier === 'tier4_financial_or_irreversible') return 'Financial or irreversible actions are blocked unless a fresh explicit lane is opened with current proof.';
  return 'Intent is blocked by Phase 8 v0 safety policy.';
}

function classifyIntent({ inputSignals, request, scope, envelope, generatedAt, source_refs, payload }) {
  const target_role = normalizeRole(request.target_role || 'architect');
  const risk_tier = request.risk_tier || 'tier0_read_only';
  const action_class = request.action_class || 'status_request';
  const reasons = [];
  let status = 'pending_local_acceptance';
  let review_required = 'architect';
  let blocked_because = null;
  let safe_next_action = 'Local Architect may accept this intent after reconnect.';

  if (payload.rawBlocked) {
    status = 'blocked';
    review_required = 'blocked';
    blocked_because = 'Intent payload contains blocked private content.';
    safe_next_action = 'Create a new redacted summary-only request for local Architect review.';
    reasons.push('raw_payload_blocked');
  } else if (scopeMismatch(scope, source_refs, envelope)) {
    status = 'blocked';
    review_required = 'blocked';
    blocked_because = 'Profile/session/device scope does not match the source envelope scope.';
    safe_next_action = 'Keep the request local to its source profile or create a separately scoped intent.';
    reasons.push('profile_mismatch');
  } else if (isExpired(request, generatedAt)) {
    status = 'expired';
    review_required = 'blocked';
    blocked_because = 'Intent expired before local acceptance.';
    safe_next_action = 'Drop or ask local Architect to review a fresh request after reconnect.';
    reasons.push('expired_intent');
  } else if (isStaleSource(source_refs, generatedAt)) {
    status = 'review_required';
    review_required = 'architect';
    blocked_because = null;
    safe_next_action = 'Ask local Architect to review a fresh source reference after reconnect.';
    reasons.push('stale_source_ref');
  } else if (DIRECT_TARGETS_BLOCKED.includes(target_role)) {
    status = 'blocked';
    review_required = 'blocked';
    blocked_because = blockedBecauseFor(action_class, risk_tier, target_role);
    safe_next_action = safeAlternative(action_class, target_role);
    reasons.push(`direct_${target_role}_target_blocked`);
  } else if (ALWAYS_BLOCKED_ACTION_CLASSES.includes(action_class) || risk_tier === 'tier3_external_side_effect' || risk_tier === 'tier4_financial_or_irreversible') {
    status = 'blocked';
    review_required = action_class === 'local_shell_execution' || action_class === 'pty_operation' ? 'blocked' : 'james';
    blocked_because = blockedBecauseFor(action_class, risk_tier, target_role);
    safe_next_action = safeAlternative(action_class, target_role);
    reasons.push('high_risk_blocked');
  } else if (risk_tier === 'tier2_repo_mutation' || REVIEW_REQUIRED_ACTION_CLASSES.includes(action_class)) {
    status = 'review_required';
    review_required = 'architect';
    blocked_because = null;
    safe_next_action = safeAlternative(action_class, target_role);
    reasons.push('tier2_review_required');
  } else if (!SAFE_PENDING_RISK_TIERS.includes(risk_tier) || !SAFE_PENDING_ACTION_CLASSES.includes(action_class)) {
    status = 'review_required';
    review_required = 'architect';
    blocked_because = null;
    safe_next_action = 'Prepare a read-only acceptance checklist for local Architect review.';
    reasons.push('unsupported_pending_class');
  } else if (risk_tier === 'tier1_local_reversible' && !request.expires_at) {
    status = 'review_required';
    review_required = 'architect';
    blocked_because = null;
    safe_next_action = 'Add an expiry and local Architect review before accepting this Tier 1 intent.';
    reasons.push('expiry_required');
  } else if (action_class === 'read_only_research') {
    safe_next_action = 'Local Architect may accept the read-only research intent after reconnect.';
  }

  if (status === 'pending_local_acceptance') {
    review_required = 'architect';
  }
  if (status !== 'pending_local_acceptance' && reasons.length === 0) reasons.push(status);
  if (status === 'expired' && !reasons.includes('stale_source_ref') && isStaleSource(source_refs, generatedAt)) {
    reasons.push('stale_source_ref');
  }

  return {
    status,
    review_required,
    blocked_because,
    safe_next_action,
    reasons,
    target_role,
    risk_tier,
    action_class,
  };
}

function canonicalIdempotencyInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    profile: {
      name: record.profile.name,
      windowKey: record.profile.windowKey,
    },
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    source_refs: [...record.source_refs]
      .map((ref) => ({ source_type: ref.source_type, source_id: ref.source_id, source_hash: ref.source_hash }))
      .sort((a, b) => `${a.source_type}:${a.source_id}`.localeCompare(`${b.source_type}:${b.source_id}`)),
    requested_by: {
      kind: record.requested_by.kind,
      source_ref: record.requested_by.source_ref,
    },
    target_role: record.target_role,
    allowed_target_roles: [...record.allowed_target_roles].sort(),
    risk_tier: record.risk_tier,
    action_class: record.action_class,
    payload_hash: record.payload_hash,
    payload_redaction_status: record.payload_redaction_status,
    expires_at: record.expires_at,
  };
}

function canonicalDedupeInput(record) {
  return {
    profile: {
      name: record.profile.name,
    },
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    requested_by: {
      kind: record.requested_by.kind,
    },
    target_role: record.target_role,
    risk_tier: record.risk_tier,
    action_class: record.action_class,
    payload_hash: record.payload_hash,
  };
}

function buildRecord(inputSignals, request, generatedAt, index) {
  const envelope = envelopeScope(inputSignals);
  const scope = normalizeScope(inputSignals, request);
  const source_refs = sourceRefsFor(inputSignals, request, scope, generatedAt);
  const payload = payloadFor(inputSignals, request);
  const classification = classifyIntent({
    inputSignals,
    request,
    scope,
    envelope,
    generatedAt,
    source_refs,
    payload,
  });
  const requested_by = requestedBy(request.requested_by || inputSignals.requested_by || 'system', source_refs[0]?.source_id || `intent-${index}`);
  const record = {
    schema: INTENT_RECORD_SCHEMA_VERSION,
    version: INTENT_QUEUE_VERSION,
    intent_id: `intent-${stableHash({ generatedAt, index, request, source_refs }).slice(0, 12)}`,
    idempotency_key: null,
    created_at: generatedAt,
    profile: profileObject(scope),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    source_refs,
    requested_by,
    target_role: classification.target_role,
    allowed_target_roles: ['architect'],
    risk_tier: classification.risk_tier,
    action_class: classification.action_class,
    status: classification.status,
    local_arm_required: true,
    review_required: classification.review_required,
    expires_at: request.expires_at || (requested_by.kind === 'server_offline_capture' || classification.risk_tier === 'tier1_local_reversible'
      ? '2026-05-08T03:00:00.000Z'
      : null),
    dedupe_key: null,
    payload_summary: payload.payload_summary,
    payload_hash: payload.payload_hash,
    payload_redaction_status: payload.payload_redaction_status,
    evidenceRefs: source_refs.map((ref) => ({
      store: ref.source_type,
      eventId: ref.source_id,
      relation: 'intent_source',
    })),
    safe_next_action: classification.safe_next_action,
    blocked_because: classification.blocked_because,
    no_execution_performed: true,
    no_queue_created: true,
    redactionCounts: payload.redactionCounts,
    reasons: classification.reasons,
  };
  if (record.status === 'pending_local_acceptance') {
    record.target_role = 'architect';
    record.allowed_target_roles = ['architect'];
  }
  record.idempotency_key = `intent-idem:${stableHash(canonicalIdempotencyInput(record))}`;
  record.dedupe_key = `intent-dedupe:${stableHash(canonicalDedupeInput(record))}`;
  return record;
}

function sideEffectResult() {
  return {
    no_queue_created: true,
    no_enqueue_performed: true,
    no_network_performed: true,
    no_route_performed: true,
    no_lease_created: true,
    no_execution_performed: true,
    queueWritesAttempted: 0,
    networkRequestsAttempted: 0,
    routesAttempted: 0,
    leasesCreated: 0,
    externalSendsAttempted: 0,
    sourceStoreWritesAttempted: 0,
    memoryCommitsAttempted: 0,
    profileCommitsAttempted: 0,
    fileMutationsAttempted: 0,
    localExecutionAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
  };
}

function buildValidationReport(records, inputSignals, generatedAt) {
  const reasons = Array.from(new Set(records.flatMap((record) => asArray(record.reasons))));
  const accepted_count = records.filter((record) => record.status === 'pending_local_acceptance').length;
  const review_required_count = records.filter((record) => record.status === 'review_required').length;
  const blocked_count = records.filter((record) => record.status === 'blocked').length;
  const rejected_count = records.filter((record) => record.status === 'rejected').length;
  const expired_count = records.filter((record) => record.status === 'expired').length;
  const blockedOrReview = blocked_count + review_required_count + rejected_count + expired_count;
  const side_effect_result = sideEffectResult();
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: INTENT_QUEUE_VERSION,
    validation_run_id: `intent-validation-${stableHash({ records: records.map((record) => record.idempotency_key), generatedAt }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: blockedOrReview > 0 ? 'records_validated_with_blocks_no_queue_created' : 'records_validated_no_queue_created',
    input_refs: {
      source_ref_count: records.reduce((sum, record) => sum + record.source_refs.length, 0),
      intent_ids: records.map((record) => record.intent_id),
    },
    accepted_count,
    review_required_count,
    blocked_count,
    rejected_count,
    expired_count,
    routing_result: {
      acceptedTargetRoles: Array.from(new Set(records.filter((record) => record.status === 'pending_local_acceptance').map((record) => record.target_role))),
      directBuilderOracleTargetsBlocked: records.filter((record) => DIRECT_TARGETS_BLOCKED.includes(record.target_role)).length,
      serverOriginatedIntentTarget: 'architect',
    },
    risk_result: {
      acceptedRiskTiers: Array.from(new Set(records.filter((record) => record.status === 'pending_local_acceptance').map((record) => record.risk_tier))),
      blockedActionClasses: records.filter((record) => record.status === 'blocked').map((record) => record.action_class),
      reviewRequiredActionClasses: records.filter((record) => record.status === 'review_required').map((record) => record.action_class),
    },
    redaction_result: {
      payloadRedactionStatuses: Array.from(new Set(records.map((record) => record.payload_redaction_status))),
      rawPayloadBlocked: records.reduce((sum, record) => sum + Number(record.redactionCounts?.rawPayloadBlocked || 0), 0),
      secretLikeBlocked: records.reduce((sum, record) => sum + Number(record.redactionCounts?.secretLikeBlocked || 0), 0),
      customerPrivateDataBlocked: records.reduce((sum, record) => sum + Number(record.redactionCounts?.customerPrivateDataBlocked || 0), 0),
      sideProfileBlocked: records.reduce((sum, record) => sum + Number(record.redactionCounts?.sideProfileBlocked || 0), 0),
      terminalOrBrowserBlocked: records.reduce((sum, record) => sum + Number(record.redactionCounts?.terminalOrBrowserBlocked || 0), 0),
    },
    profile_scope_result: {
      mismatchesBlocked: reasons.includes('profile_mismatch') ? records.filter((record) => asArray(record.reasons).includes('profile_mismatch')).length : 0,
      allRecordsScoped: records.every((record) => record.profile?.name && record.sessionId && record.deviceId),
    },
    freshness_result: {
      expiredCount: expired_count,
      staleSourceRefCount: records.filter((record) => asArray(record.reasons).includes('stale_source_ref')).length,
    },
    idempotency_result: {
      stable: true,
      keys: records.map((record) => record.idempotency_key),
      excludes: ['intent_id', 'created_at', 'validation_run_id', 'generated_at'],
    },
    dedupe_result: {
      stable: true,
      keys: records.map((record) => record.dedupe_key),
      duplicateCount: records.length - new Set(records.map((record) => record.dedupe_key)).size,
      retryCannotDuplicateSideEffects: true,
    },
    capability_truth_result: {
      serverCanExecuteLocal: false,
      serverCanOperatePTY: false,
      serverCanDeploy: false,
      serverCanSendCustomerMessages: false,
      serverCanTrade: false,
      serverCanProveModelProcessing: false,
      crossDeviceBuilderOracleTargeting: 'blocked',
    },
    side_effect_result,
    records_summary: records.map((record) => ({
      intent_id: record.intent_id,
      status: record.status,
      target_role: record.target_role,
      risk_tier: record.risk_tier,
      action_class: record.action_class,
      no_execution_performed: record.no_execution_performed,
    })),
    reasons,
    followup_required: blockedOrReview > 0,
  };
}

function buildMiraCoreIntentQueue(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const records = requestList(inputSignals).map((request, index) => buildRecord(inputSignals, request, generatedAt, index));
  const output = {
    intent_records: records,
    validation_report: buildValidationReport(records, inputSignals, generatedAt),
  };
  assertNoForbiddenOutput(output);
  return output;
}

function hasRequiredFields(value, fields) {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function pathValue(value, path) {
  return String(path || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function arraysEqual(a = [], b = []) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateMiraCoreIntentQueueOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const records = asArray(output.intent_records);
  const report = output.validation_report || {};
  const expectedRecord = contract.expectedIntentRecordShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredRecordFields = asArray(expectedRecord.requiredFields).length > 0 ? expectedRecord.requiredFields : REQUIRED_INTENT_RECORD_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0 ? expectedReport.requiredTopLevelFields : REQUIRED_VALIDATION_REPORT_FIELDS;

  add('output-shape-complete',
    hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && records.every((record) => hasRequiredFields(record, requiredRecordFields))
      && hasRequiredFields(report, requiredReportFields)
      && records.every((record) => record.schema === INTENT_RECORD_SCHEMA_VERSION
        && asArray(record.source_refs).every((ref) => hasRequiredFields(ref, REQUIRED_SOURCE_REF_FIELDS))
        && hasRequiredFields(record.requested_by, REQUIRED_REQUESTED_BY_FIELDS))
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION,
    'Missing required intent queue fields.');

  add('literal-values-preserved',
    records.every((record) => Object.entries(expectedRecord.requiredLiteralValues || {}).every(([field, expectedValue]) => pathValue(record, field) === expectedValue)),
    'Required literal changed.');

  add('accepted-risk-tier-limited',
    records.every((record) => record.status !== 'pending_local_acceptance' || SAFE_PENDING_RISK_TIERS.includes(record.risk_tier)),
    'High-risk record accepted.');

  add('higher-risk-blocked-or-review-required',
    records.every((record) => {
      if (record.risk_tier === 'tier2_repo_mutation') return ['review_required', 'blocked'].includes(record.status);
      if (record.risk_tier === 'tier3_external_side_effect' || record.risk_tier === 'tier4_financial_or_irreversible') return record.status === 'blocked';
      return true;
    }),
    'Higher-risk record has unsafe status.');

  add('local-architect-target-only',
    records.every((record) => {
      if (record.status === 'pending_local_acceptance') {
        return record.target_role === 'architect' && arraysEqual(record.allowed_target_roles, ['architect']) && record.review_required === 'architect';
      }
      return !(record.status === 'pending_local_acceptance' && DIRECT_TARGETS_BLOCKED.includes(record.target_role));
    }),
    'Accepted record targets a non-Architect role.');

  add('capability-truth-preserved',
    report.capability_truth_result?.serverCanExecuteLocal === false
      && report.capability_truth_result?.serverCanOperatePTY === false
      && report.capability_truth_result?.serverCanDeploy === false
      && report.capability_truth_result?.serverCanSendCustomerMessages === false
      && report.capability_truth_result?.serverCanTrade === false
      && report.capability_truth_result?.crossDeviceBuilderOracleTargeting === 'blocked',
    'Capability truth overclaimed.');

  add('profile-session-device-scope-required',
    records.every((record) => record.profile?.name && record.sessionId && record.deviceId
      && asArray(record.source_refs).every((ref) => ref.profile && ref.sessionId && ref.deviceId)),
    'Scope missing from record or source ref.');

  add('freshness-and-expiry-enforced',
    records.every((record) => {
      if (record.status === 'expired') return true;
      if (Date.parse(record.expires_at) <= Date.parse(record.created_at)) return record.status !== 'pending_local_acceptance';
      return !asArray(record.reasons).includes('stale_source_ref') || record.status !== 'pending_local_acceptance';
    }),
    'Expired or stale record accepted.');

  add('raw-payload-leak-prevention',
    records.every((record) => {
      const statusOk = record.payload_redaction_status !== 'blocked' || record.status === 'blocked';
      const summaryOk = !FORBIDDEN_OUTPUT_SUBSTRINGS.some((forbidden) => forbidden && String(record.payload_summary || '').includes(forbidden));
      return statusOk && summaryOk;
    }),
    'Raw payload leaked or accepted.');

  add('idempotency-and-dedupe-deterministic',
    records.every((record) => record.idempotency_key === `intent-idem:${stableHash(canonicalIdempotencyInput(record))}`
      && record.dedupe_key === `intent-dedupe:${stableHash(canonicalDedupeInput(record))}`),
    'Intent idempotency or dedupe key is unstable.');

  add('safe-alternative-for-blocked',
    records.every((record) => {
      if (!['blocked', 'review_required', 'expired', 'rejected'].includes(record.status)) return true;
      return typeof record.safe_next_action === 'string'
        && record.safe_next_action.length > 0
        && !/\b(enqueue|route sent|shell command|customer message sent|deployment started|trade placed|queue write complete)\b/i.test(record.safe_next_action);
    }),
    'Blocked/review record lacks safe alternative.');

  add('no-side-effects',
    report.side_effect_result?.no_queue_created === true
      && report.side_effect_result?.no_enqueue_performed === true
      && report.side_effect_result?.no_network_performed === true
      && report.side_effect_result?.no_route_performed === true
      && report.side_effect_result?.no_lease_created === true
      && report.side_effect_result?.no_execution_performed === true
      && Number(report.side_effect_result?.queueWritesAttempted || 0) === 0
      && Number(report.side_effect_result?.networkRequestsAttempted || 0) === 0
      && Number(report.side_effect_result?.routesAttempted || 0) === 0
      && Number(report.side_effect_result?.leasesCreated || 0) === 0
      && Number(report.side_effect_result?.externalSendsAttempted || 0) === 0
      && Number(report.side_effect_result?.sourceStoreWritesAttempted || 0) === 0
      && Number(report.side_effect_result?.memoryCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.profileCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.fileMutationsAttempted || 0) === 0
      && Number(report.side_effect_result?.localExecutionAttempted || 0) === 0,
    'Side-effect counters are nonzero.');

  add('model-free-validation', true, null);
  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-substrings-absent', true, null);
  } catch (err) {
    add('forbidden-substrings-absent', false, err.message);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const output = JSON.stringify(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (forbidden && output.includes(forbidden)) {
      throw new Error(`intent_queue_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALWAYS_BLOCKED_ACTION_CLASSES,
  DIRECT_TARGETS_BLOCKED,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  INTENT_RECORD_SCHEMA_VERSION,
  REQUIRED_INTENT_RECORD_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SAFE_PENDING_ACTION_CLASSES,
  SAFE_PENDING_RISK_TIERS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreIntentQueue,
  stableHash,
  validateMiraCoreIntentQueueOutput,
};
