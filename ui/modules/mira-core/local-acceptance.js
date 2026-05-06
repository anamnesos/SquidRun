'use strict';

const crypto = require('crypto');

const ACCEPTANCE_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.local_acceptance_record.v0';
const DRY_RUN_LEASE_SCHEMA_VERSION = 'squidrun.mira_core.dry_run_lease_contract.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.local_acceptance_validation_report.v0';
const LOCAL_ACCEPTANCE_VERSION = 'v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze(['acceptance_records', 'dry_run_lease_records', 'validation_report']);
const REQUIRED_ACCEPTANCE_RECORD_FIELDS = Object.freeze([
  'schema',
  'version',
  'acceptance_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_intent_ref',
  'source_upload_ref',
  'accepted_by',
  'role_discovery',
  'role_proof_refs',
  'decision',
  'status',
  'target_role',
  'allowed_target_roles',
  'risk_tier',
  'action_class',
  'current_risk_recheck',
  'profile_scope_result',
  'freshness_result',
  'review_required',
  'local_delegation',
  'dry_run_lease_ref',
  'evidenceRefs',
  'reasons',
  'safe_next_action',
  'blocked_because',
  'no_queue_created',
  'no_lease_created',
  'no_route_performed',
  'no_execution_performed',
]);
const REQUIRED_DRY_RUN_LEASE_FIELDS = Object.freeze([
  'schema',
  'version',
  'lease_dry_run_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_acceptance_ref',
  'source_intent_ref',
  'dry_run_only',
  'lease_not_created',
  'queue_not_written',
  'route_not_sent',
  'execution_not_performed',
  'model_processing_not_proven',
  'server_originated_target_role',
  'local_acceptance_required',
  'local_delegation_candidate',
  'risk_tier',
  'action_class',
  'lease_scope',
  'proof_boundaries',
  'expires_at',
  'evidenceRefs',
  'side_effect_result',
]);
const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'decision',
  'input_refs',
  'accepted_count',
  'rejected_count',
  'blocked_count',
  'expired_count',
  'dry_run_lease_candidate_count',
  'role_discovery_result',
  'risk_recheck_result',
  'profile_scope_result',
  'freshness_result',
  'routing_result',
  'delegation_result',
  'proof_boundary_result',
  'idempotency_result',
  'side_effect_result',
  'records_summary',
  'reasons',
  'followup_required',
]);
const SAFE_RISK_TIERS = Object.freeze(['tier0_read_only', 'tier1_local_reversible']);
const BLOCKED_ACTION_CLASSES = Object.freeze([
  'identity_core_rewrite',
  'secrets_or_auth_change',
  'deploy',
  'customer_send',
  'local_shell_execution',
  'pty_operation',
  'trade_or_financial_action',
  'payment_or_invoice_action',
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
  'side-profile private note',
  'server routed to builder',
  'server routed to oracle',
  'direct builder target accepted',
  'direct oracle target accepted',
  'lease created',
  'queue write complete',
  'route sent',
  'shell command executed',
  'customer message sent',
  'deployment started',
  'trade placed',
  'acceptance executed work',
  'dry-run lease proved model processing',
  'bridge green from socket only',
  'model-processing proof from websocket acceptance',
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

function currentContext(inputSignals = {}) {
  const current = inputSignals.currentContext || {};
  const role = inputSignals.roleDiscovery || {};
  const hasExplicitRoleDiscovery = Object.prototype.hasOwnProperty.call(inputSignals, 'roleDiscovery')
    || Object.prototype.hasOwnProperty.call(current, 'architect_role_registered')
    || Object.prototype.hasOwnProperty.call(role, 'architect_role_registered')
    || Object.prototype.hasOwnProperty.call(inputSignals, 'architect_role_registered');
  const architectRoleRegistered = hasExplicitRoleDiscovery
    ? (current.architect_role_registered === true || role.architect_role_registered === true || inputSignals.architect_role_registered === true)
    : true;
  const roleTargetProof = current.role_target_proof
    || role.role_target_proof
    || inputSignals.role_target_proof
    || (architectRoleRegistered ? 'architect_local_verified' : 'missing');
  const risk = inputSignals.currentRiskRecheck || {};
  return {
    profile: normalizeProfileName(current.profile || inputSignals.profile || 'main'),
    sessionId: current.sessionId || inputSignals.sessionId || 'app-session-326',
    deviceId: current.deviceId || inputSignals.deviceId || 'VIGIL',
    architect_role_registered: architectRoleRegistered,
    role_target_proof: roleTargetProof,
    socket_connection_status: current.socket_connection_status || role.socket_connection_status || inputSignals.socket_connection_status || 'connected',
    current_risk_tier: current.current_risk_tier || risk.current_risk_tier || inputSignals.current_risk_tier || null,
  };
}

function defaultPendingIntent(inputSignals = {}) {
  const context = currentContext(inputSignals);
  return {
    intent_id: inputSignals.sourceIntentId || 'intent-local-acceptance-001',
    idempotency_key: inputSignals.sourceIntentKey || 'intent-idem:local-acceptance-001',
    dedupe_key: inputSignals.sourceIntentDedupeKey || 'intent-dedupe:local-acceptance-001',
    status: 'pending_local_acceptance',
    profile: context.profile,
    sessionId: context.sessionId,
    deviceId: context.deviceId,
    target_role: 'architect',
    allowed_target_roles: ['architect'],
    risk_tier: inputSignals.risk_tier || 'tier0_read_only',
    action_class: inputSignals.action_class || 'read_only_research',
    payload_hash: inputSignals.payload_hash || 'sha256:payload-local-acceptance',
    payload_redaction_status: inputSignals.payload_redaction_status || 'none',
    expires_at: inputSignals.expires_at || null,
    source_ref_generated_at: inputSignals.source_ref_generated_at || null,
    no_execution_performed: true,
    evidenceRefs: [{
      store: 'intent-queue',
      eventId: inputSignals.sourceIntentId || 'intent-local-acceptance-001',
      relation: 'pending_intent',
    }],
  };
}

function intentList(inputSignals = {}) {
  if (Array.isArray(inputSignals.intents)) return inputSignals.intents;
  if (inputSignals.intent && typeof inputSignals.intent === 'object') return [inputSignals.intent];
  if (inputSignals.acceptanceA) return [acceptanceFixtureIntent(inputSignals.acceptanceA)];
  if (inputSignals.acceptedIntent) return [defaultPendingIntent({
    ...inputSignals,
    ...inputSignals.acceptedIntent,
    risk_tier: inputSignals.acceptedIntent.risk_tier || 'tier0_read_only',
    action_class: inputSignals.acceptedIntent.action_class || 'read_only_research',
  })];
  if (asArray(inputSignals.blockedPayloadExamples).length > 0) {
    return [defaultPendingIntent({
      ...inputSignals,
      payload_redaction_status: 'blocked',
      payload_hash: sha256({ blockedPayloadExamples: inputSignals.blockedPayloadExamples }),
    })];
  }
  if (inputSignals.requestedPhase) return [defaultPendingIntent(inputSignals)];
  return [defaultPendingIntent(inputSignals)];
}

function acceptanceFixtureIntent(fixture = {}) {
  return {
    intent_id: fixture.sourceIntentId || 'intent-safe-research-001',
    idempotency_key: fixture.sourceIntentKey || 'intent-key-a',
    dedupe_key: fixture.sourceIntentDedupeKey || 'intent-dedupe-a',
    status: 'pending_local_acceptance',
    profile: fixture.profile || 'main',
    sessionId: fixture.sessionId || 'app-session-326',
    deviceId: fixture.deviceId || 'VIGIL',
    target_role: 'architect',
    allowed_target_roles: ['architect'],
    risk_tier: fixture.risk_tier || 'tier0_read_only',
    action_class: fixture.action_class || 'read_only_research',
    payload_hash: fixture.payload_hash || 'sha256:payload-a',
    payload_redaction_status: 'none',
    expires_at: fixture.expires_at || null,
    no_execution_performed: true,
    evidenceRefs: [{
      store: 'intent-queue',
      eventId: fixture.sourceIntentId || 'intent-safe-research-001',
      relation: 'pending_intent',
    }],
  };
}

function sourceIntentRef(intent = {}, context) {
  const intentId = intent.intent_id || `intent-${stableHash(intent).slice(0, 12)}`;
  const payloadHash = intent.payload_hash || sha256({ intent });
  return {
    intent_id: intentId,
    idempotency_key: intent.idempotency_key || `intent-idem:${stableHash({ intentId, payloadHash })}`,
    dedupe_key: intent.dedupe_key || `intent-dedupe:${stableHash({ target_role: intent.target_role || 'architect', payloadHash })}`,
    status: intent.status || 'unknown',
    profile: intent.profile || context.profile,
    sessionId: intent.sessionId || context.sessionId,
    deviceId: intent.deviceId || context.deviceId,
    target_role: normalizeRole(intent.target_role || 'architect'),
    allowed_target_roles: asArray(intent.allowed_target_roles).length > 0 ? intent.allowed_target_roles.map(normalizeRole) : ['architect'],
    risk_tier: intent.risk_tier || 'tier0_read_only',
    action_class: intent.action_class || 'read_only_research',
    payload_hash: payloadHash,
    expires_at: intent.expires_at || null,
    source_ref_generated_at: intent.source_ref_generated_at || null,
  };
}

function sourceUploadRef(inputSignals = {}) {
  return {
    upload_id: inputSignals.upload_id || 'upload-local-acceptance-001',
    idempotency_key: inputSignals.upload_idempotency_key || 'upload-idem:local-acceptance-001',
    schema: 'squidrun.mira_core.server_upload_envelope.v0',
  };
}

function roleDiscovery(inputSignals = {}, context) {
  const role = inputSignals.roleDiscovery || {};
  const registered = context.architect_role_registered === true;
  return {
    architect_role_registered: registered,
    architect_target: 'architect',
    role_target_proof: registered && context.role_target_proof === 'architect_local_verified'
      ? 'architect_local_verified'
      : (role.role_target_proof || 'missing'),
    socket_connection_status: context.socket_connection_status,
    socket_is_bridge_green: false,
    builder_direct_target_blocked: true,
    oracle_direct_target_blocked: true,
  };
}

function riskRecheck(inputSignals = {}, intent = {}, context, generatedAt) {
  const recheck = inputSignals.currentRiskRecheck || {};
  const currentRiskTier = recheck.current_risk_tier || context.current_risk_tier || intent.risk_tier || 'tier0_read_only';
  const upgraded = !SAFE_RISK_TIERS.includes(currentRiskTier) || BLOCKED_ACTION_CLASSES.includes(intent.action_class);
  return {
    previous_risk_tier: intent.risk_tier || 'tier0_read_only',
    current_risk_tier: currentRiskTier,
    decision: upgraded ? 'blocked_if_upgraded' : (recheck.decision || 'still_tier0_or_tier1'),
    checked_at: generatedAt,
    blocked_if_upgraded: upgraded,
    evidenceRefs: [{
      store: 'local-acceptance',
      eventId: `risk-recheck:${intent.intent_id || 'intent'}`,
      relation: 'current_risk_recheck',
    }],
  };
}

function profileScopeResult(intent = {}, context) {
  const match = normalizeProfileName(intent.profile) === context.profile
    && intent.sessionId === context.sessionId
    && intent.deviceId === context.deviceId;
  return {
    decision: match ? 'match' : 'mismatch',
    intentProfile: normalizeProfileName(intent.profile),
    intentSessionId: intent.sessionId || null,
    intentDeviceId: intent.deviceId || null,
    currentProfile: context.profile,
    currentSessionId: context.sessionId,
    currentDeviceId: context.deviceId,
  };
}

function freshnessResult(inputSignals = {}, intent = {}, generatedAt) {
  const now = Date.parse(generatedAt);
  const expiresAt = Date.parse(intent.expires_at || '');
  const sourceCreated = Date.parse(intent.source_ref_generated_at || inputSignals.source_ref_generated_at || generatedAt);
  const expired = Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now;
  const stale = Number.isFinite(sourceCreated) && Number.isFinite(now) && now - sourceCreated > 72 * 60 * 60 * 1000;
  return {
    decision: expired ? 'expired' : (stale ? 'stale' : 'fresh'),
    expired,
    stale_source_ref: stale,
    checked_at: generatedAt,
  };
}

function localDelegation() {
  return {
    state: 'available_after_acceptance_only',
    allowed_after_acceptance: true,
    allowed_local_delegate_roles: ['builder', 'oracle'],
    requires_current_local_route_proof: true,
    requires_fresh_risk_recheck: true,
    server_originated_direct_targeting_still_blocked: true,
    delegation_performed: false,
  };
}

function acceptedBy(context) {
  return {
    role: 'architect',
    profile: context.profile,
    sessionId: context.sessionId,
    deviceId: context.deviceId,
    source: 'local_acceptance_validator',
    authority: 'local_architect_role_proof',
  };
}

function safeNextActionFor(decision, intent = {}) {
  if (decision === 'accepted_local_only') {
    if (intent.action_class === 'safe_plan_preparation') {
      return 'Local Architect may prepare a plan after acceptance without mutating files or sending externally.';
    }
    return 'Local Architect may review or prepare the accepted local-only task without execution.';
  }
  const map = {
    missing_role_proof: 'Run read-only role discovery and target proof locally.',
    risk_upgraded: 'Prepare a non-sent draft or ask local Architect for a fresh gated review.',
    expired_or_stale: 'Reject and require a fresh intent if still relevant.',
    profile_mismatch: 'Keep the request scoped to its source profile or create a fresh matching intent.',
    direct_target_blocked: 'Target local Architect only; Builder/Oracle delegation may be considered locally after acceptance.',
    raw_payload_blocked: 'Use a redacted summary-plus-hash intent.',
    non_pending: 'Return the intent to Phase 8 validation or create a fresh pending_local_acceptance intent.',
    missing_keys: 'Regenerate a complete Phase 8 intent record with idempotency and dedupe keys.',
  };
  return map[decision] || 'Keep the intent blocked and prepare a safe read-only review note.';
}

function blockedBecause(reason) {
  const map = {
    missing_role_proof: 'Local Architect role discovery and target proof are required before acceptance.',
    risk_upgraded: 'Fresh risk recheck upgraded the intent above Tier 1.',
    expired_or_stale: 'Intent expired or source refs are stale before local acceptance.',
    profile_mismatch: 'Intent profile/session/device does not match current local context.',
    builder_direct_target: 'Server-originated direct Builder targeting is blocked.',
    oracle_direct_target: 'Server-originated direct Oracle targeting is blocked.',
    raw_payload_blocked: 'Raw private payload cannot be accepted into local handoff records.',
    non_pending: 'Only pending_local_acceptance intents can be accepted locally.',
    missing_keys: 'Source intent idempotency and dedupe keys are required before acceptance.',
  };
  return map[reason] || 'Intent cannot be accepted by Phase 9 policy.';
}

function classifyAcceptance(inputSignals = {}, intentRef, context, role, risk, scope, fresh) {
  const reasons = [];
  let failure = null;
  const target = normalizeRole(intentRef.target_role);
  if (intentRef.status !== 'pending_local_acceptance') {
    failure = 'non_pending';
    reasons.push('non_pending_intent');
  } else if (target === 'builder') {
    failure = 'builder_direct_target';
    reasons.push('direct_builder_target_blocked');
  } else if (target === 'oracle') {
    failure = 'oracle_direct_target';
    reasons.push('direct_oracle_target_blocked');
  } else if (target !== 'architect' || !asArray(intentRef.allowed_target_roles).includes('architect')) {
    failure = 'direct_target_blocked';
    reasons.push('wrong_target_role');
  } else if (role.architect_role_registered !== true || role.role_target_proof !== 'architect_local_verified') {
    failure = 'missing_role_proof';
    reasons.push('missing_role_proof');
  } else if (scope.decision !== 'match') {
    failure = 'profile_mismatch';
    reasons.push('profile_mismatch');
  } else if (fresh.decision === 'expired' || fresh.decision === 'stale') {
    failure = 'expired_or_stale';
    if (fresh.expired) reasons.push('expired_intent');
    if (fresh.stale_source_ref) reasons.push('stale_source_ref');
  } else if (risk.decision !== 'still_tier0_or_tier1' || risk.blocked_if_upgraded === true) {
    failure = 'risk_upgraded';
    reasons.push('risk_upgraded');
  } else if (intentRef.payload_redaction_status === 'blocked' || inputSignals.blockedPayloadExamples) {
    failure = 'raw_payload_blocked';
    reasons.push('raw_payload_blocked');
  } else if (!intentRef.idempotency_key || !intentRef.dedupe_key || intentRef.idempotency_key === 'missing' || intentRef.dedupe_key === 'missing') {
    failure = 'missing_keys';
    reasons.push('missing_idempotency_or_dedupe');
  }

  if (!failure) {
    return {
      decision: 'accepted_local_only',
      status: 'accepted_local_only_no_execution',
      blocked_because: null,
      safe_next_action: safeNextActionFor('accepted_local_only', intentRef),
      reasons,
    };
  }
  if (failure === 'expired_or_stale') {
    return {
      decision: 'expired',
      status: 'expired_no_execution',
      blocked_because: blockedBecause(failure),
      safe_next_action: safeNextActionFor(failure, intentRef),
      reasons,
    };
  }
  return {
    decision: failure === 'non_pending' ? 'rejected' : 'blocked',
    status: failure === 'non_pending' ? 'rejected_no_execution' : 'blocked_no_execution',
    blocked_because: blockedBecause(failure),
    safe_next_action: safeNextActionFor(failure, intentRef),
    reasons,
  };
}

function canonicalAcceptanceInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    source_intent_ref: {
      intent_id: record.source_intent_ref.intent_id,
      idempotency_key: record.source_intent_ref.idempotency_key,
      dedupe_key: record.source_intent_ref.dedupe_key,
      payload_hash: record.source_intent_ref.payload_hash,
    },
    profile: {
      name: record.profile.name,
    },
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    decision: record.decision,
    target_role: record.target_role,
    risk_tier: record.risk_tier,
    action_class: record.action_class,
    current_risk_tier: record.current_risk_recheck.current_risk_tier,
    profile_scope_decision: record.profile_scope_result.decision,
    freshness_decision: record.freshness_result.decision,
    role_target_proof: record.role_discovery.role_target_proof,
  };
}

function canonicalDryRunLeaseInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    source_acceptance_ref: {
      acceptance_id: record.source_acceptance_ref.acceptance_id,
      idempotency_key: record.source_acceptance_ref.idempotency_key,
    },
    profile: {
      name: record.profile.name,
    },
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    risk_tier: record.risk_tier,
    action_class: record.action_class,
    lease_scope: record.lease_scope,
    expires_at: record.expires_at,
  };
}

function buildAcceptanceRecord(inputSignals, intent, generatedAt, index) {
  const context = currentContext(inputSignals);
  const intentRef = sourceIntentRef(intent, context);
  const role = roleDiscovery(inputSignals, context);
  const risk = riskRecheck(inputSignals, intentRef, context, generatedAt);
  const scope = profileScopeResult(intentRef, context);
  const fresh = freshnessResult(inputSignals, intentRef, generatedAt);
  const classification = classifyAcceptance(inputSignals, intentRef, context, role, risk, scope, fresh);
  const record = {
    schema: ACCEPTANCE_RECORD_SCHEMA_VERSION,
    version: LOCAL_ACCEPTANCE_VERSION,
    acceptance_id: `acceptance-${stableHash({ generatedAt, index, intentRef }).slice(0, 12)}`,
    idempotency_key: null,
    created_at: generatedAt,
    profile: {
      name: context.profile,
      windowKey: context.profile,
      sessionScopeId: context.sessionId,
    },
    sessionId: context.sessionId,
    deviceId: context.deviceId,
    source_intent_ref: intentRef,
    source_upload_ref: sourceUploadRef(inputSignals),
    accepted_by: acceptedBy(context),
    role_discovery: role,
    role_proof_refs: [{
      store: 'local-acceptance',
      eventId: `role-proof:${intentRef.intent_id}`,
      relation: 'architect_target_proof',
    }],
    decision: classification.decision,
    status: classification.status,
    target_role: normalizeRole(intentRef.target_role),
    allowed_target_roles: ['architect'],
    risk_tier: intentRef.risk_tier,
    action_class: intentRef.action_class,
    current_risk_recheck: risk,
    profile_scope_result: scope,
    freshness_result: fresh,
    review_required: classification.decision === 'accepted_local_only' ? 'architect' : 'blocked',
    local_delegation: localDelegation(),
    dry_run_lease_ref: null,
    evidenceRefs: [{
      store: 'intent-queue',
      eventId: intentRef.intent_id,
      relation: 'source_intent',
    }],
    reasons: classification.reasons,
    safe_next_action: classification.safe_next_action,
    blocked_because: classification.blocked_because,
    no_queue_created: true,
    no_lease_created: true,
    no_route_performed: true,
    no_execution_performed: true,
  };
  record.idempotency_key = `acceptance-idem:${stableHash(canonicalAcceptanceInput(record))}`;
  return record;
}

function proofBoundaries() {
  return {
    acceptance_is_execution: false,
    dry_run_lease_is_real_lease: false,
    dry_run_lease_is_model_processing_proof: false,
    socket_is_bridge_green: false,
    websocket_acceptance_is_model_processing_proof: false,
    required_model_processing_proof: 'recipient_quote_back_or_equivalent_transcript_proof_after_real_local_route',
  };
}

function localDelegationCandidate() {
  return {
    state: 'candidate_only',
    candidate_roles: ['builder', 'oracle'],
    server_direct_targeting_allowed: false,
    local_architect_may_delegate_after_acceptance: true,
    requires_current_role_route_proof: true,
    requires_recipient_quote_back_for_model_processing_proof: true,
  };
}

function sideEffectResult() {
  return {
    no_queue_created: true,
    no_enqueue_performed: true,
    no_lease_created: true,
    no_route_performed: true,
    no_network_performed: true,
    no_execution_performed: true,
    no_external_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_store_write_performed: true,
    queueWritesAttempted: 0,
    leasesCreated: 0,
    routesAttempted: 0,
    networkRequestsAttempted: 0,
    localExecutionAttempted: 0,
    externalSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    sourceStoreWritesAttempted: 0,
    memoryCommitsAttempted: 0,
    profileCommitsAttempted: 0,
    fileMutationsAttempted: 0,
    outputFileWritten: false,
  };
}

function buildDryRunLeaseRecord(acceptanceRecord, generatedAt) {
  const lease = {
    schema: DRY_RUN_LEASE_SCHEMA_VERSION,
    version: LOCAL_ACCEPTANCE_VERSION,
    lease_dry_run_id: `lease-dry-run-${stableHash({ acceptance: acceptanceRecord.idempotency_key }).slice(0, 12)}`,
    idempotency_key: null,
    created_at: generatedAt,
    profile: acceptanceRecord.profile,
    sessionId: acceptanceRecord.sessionId,
    deviceId: acceptanceRecord.deviceId,
    source_acceptance_ref: {
      acceptance_id: acceptanceRecord.acceptance_id,
      idempotency_key: acceptanceRecord.idempotency_key,
      decision: acceptanceRecord.decision,
    },
    source_intent_ref: acceptanceRecord.source_intent_ref,
    dry_run_only: true,
    lease_not_created: true,
    queue_not_written: true,
    route_not_sent: true,
    execution_not_performed: true,
    model_processing_not_proven: true,
    server_originated_target_role: 'architect',
    local_acceptance_required: true,
    local_delegation_candidate: localDelegationCandidate(),
    risk_tier: acceptanceRecord.risk_tier,
    action_class: acceptanceRecord.action_class,
    lease_scope: {
      local_only: true,
      role: 'architect',
      profile: acceptanceRecord.profile.name,
      sessionId: acceptanceRecord.sessionId,
      deviceId: acceptanceRecord.deviceId,
    },
    proof_boundaries: proofBoundaries(),
    expires_at: acceptanceRecord.source_intent_ref.expires_at || null,
    evidenceRefs: [{
      store: 'local-acceptance',
      eventId: acceptanceRecord.acceptance_id,
      relation: 'dry_run_lease_contract',
    }],
    side_effect_result: sideEffectResult(),
  };
  lease.idempotency_key = `lease-dry-run-idem:${stableHash(canonicalDryRunLeaseInput(lease))}`;
  return lease;
}

function buildValidationReport(acceptanceRecords, dryRunLeaseRecords, generatedAt) {
  const reasons = Array.from(new Set(acceptanceRecords.flatMap((record) => asArray(record.reasons))));
  const accepted_count = acceptanceRecords.filter((record) => record.decision === 'accepted_local_only').length;
  const rejected_count = acceptanceRecords.filter((record) => record.decision === 'rejected').length;
  const blocked_count = acceptanceRecords.filter((record) => record.decision === 'blocked').length;
  const expired_count = acceptanceRecords.filter((record) => record.decision === 'expired').length;
  const side_effect_result = sideEffectResult();
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: LOCAL_ACCEPTANCE_VERSION,
    validation_run_id: `local-acceptance-validation-${stableHash({
      ids: acceptanceRecords.map((record) => record.idempotency_key),
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: blocked_count + rejected_count + expired_count > 0
      ? 'local_acceptance_records_validated_with_blocks_no_side_effects'
      : 'local_acceptance_records_validated_no_side_effects',
    input_refs: {
      intent_ids: acceptanceRecords.map((record) => record.source_intent_ref.intent_id),
      upload_ids: Array.from(new Set(acceptanceRecords.map((record) => record.source_upload_ref.upload_id))),
    },
    accepted_count,
    rejected_count,
    blocked_count,
    expired_count,
    dry_run_lease_candidate_count: dryRunLeaseRecords.length,
    role_discovery_result: {
      acceptedWithRoleProof: acceptanceRecords.filter((record) => record.decision === 'accepted_local_only' && record.role_discovery.role_target_proof === 'architect_local_verified').length,
      blockedMissingRoleProof: acceptanceRecords.filter((record) => asArray(record.reasons).includes('missing_role_proof')).length,
      socketConnectionAloneIsBridgeGreen: false,
    },
    risk_recheck_result: {
      acceptedStillSafe: acceptanceRecords.filter((record) => record.decision === 'accepted_local_only' && record.current_risk_recheck.decision === 'still_tier0_or_tier1').length,
      riskUpgradesBlocked: acceptanceRecords.filter((record) => asArray(record.reasons).includes('risk_upgraded')).length,
    },
    profile_scope_result: {
      matches: acceptanceRecords.filter((record) => record.profile_scope_result.decision === 'match').length,
      mismatchesBlocked: acceptanceRecords.filter((record) => asArray(record.reasons).includes('profile_mismatch')).length,
    },
    freshness_result: {
      fresh: acceptanceRecords.filter((record) => record.freshness_result.decision === 'fresh').length,
      expired: expired_count,
      stale: acceptanceRecords.filter((record) => record.freshness_result.decision === 'stale').length,
    },
    routing_result: {
      target_role: 'architect',
      builder_direct_target_blocked: true,
      oracle_direct_target_blocked: true,
      route_not_sent: true,
    },
    delegation_result: {
      delegation_performed: false,
      available_after_acceptance_only: true,
      allowed_local_delegate_roles: ['builder', 'oracle'],
      server_direct_targeting_allowed: false,
    },
    proof_boundary_result: {
      acceptance_is_execution: false,
      dry_run_lease_is_real_lease: false,
      dry_run_lease_is_model_processing_proof: false,
      socket_is_bridge_green: false,
      websocket_acceptance_is_model_processing_proof: false,
    },
    idempotency_result: {
      stable: true,
      acceptance_keys: acceptanceRecords.map((record) => record.idempotency_key),
      dry_run_lease_keys: dryRunLeaseRecords.map((record) => record.idempotency_key),
      excludes: ['acceptance_id', 'lease_dry_run_id', 'created_at', 'validation_run_id', 'generated_at'],
    },
    side_effect_result,
    records_summary: acceptanceRecords.map((record) => ({
      acceptance_id: record.acceptance_id,
      decision: record.decision,
      status: record.status,
      target_role: record.target_role,
      risk_tier: record.risk_tier,
      action_class: record.action_class,
      no_execution_performed: record.no_execution_performed,
    })),
    reasons,
    followup_required: blocked_count + rejected_count + expired_count > 0,
  };
}

function buildMiraCoreLocalAcceptance(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const acceptance_records = intentList(inputSignals).map((intent, index) => buildAcceptanceRecord(inputSignals, intent, generatedAt, index));
  const dry_run_lease_records = acceptance_records
    .filter((record) => record.decision === 'accepted_local_only')
    .map((record) => {
      const lease = buildDryRunLeaseRecord(record, generatedAt);
      record.dry_run_lease_ref = {
        lease_dry_run_id: lease.lease_dry_run_id,
        idempotency_key: lease.idempotency_key,
      };
      record.idempotency_key = `acceptance-idem:${stableHash(canonicalAcceptanceInput(record))}`;
      lease.source_acceptance_ref.idempotency_key = record.idempotency_key;
      lease.idempotency_key = `lease-dry-run-idem:${stableHash(canonicalDryRunLeaseInput(lease))}`;
      return lease;
    });
  const output = {
    acceptance_records,
    dry_run_lease_records,
    validation_report: buildValidationReport(acceptance_records, dry_run_lease_records, generatedAt),
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

function valuesMatch(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateMiraCoreLocalAcceptanceOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const acceptanceRecords = asArray(output.acceptance_records);
  const dryRunLeaseRecords = asArray(output.dry_run_lease_records);
  const report = output.validation_report || {};
  const expectedAcceptance = contract.expectedAcceptanceRecordShape || {};
  const expectedLease = contract.expectedDryRunLeaseRecordShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredAcceptanceFields = asArray(expectedAcceptance.requiredFields).length > 0 ? expectedAcceptance.requiredFields : REQUIRED_ACCEPTANCE_RECORD_FIELDS;
  const requiredLeaseFields = asArray(expectedLease.requiredFields).length > 0 ? expectedLease.requiredFields : REQUIRED_DRY_RUN_LEASE_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0 ? expectedReport.requiredTopLevelFields : REQUIRED_VALIDATION_REPORT_FIELDS;

  add('output-shape-complete',
    hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && acceptanceRecords.every((record) => record.schema === ACCEPTANCE_RECORD_SCHEMA_VERSION && hasRequiredFields(record, requiredAcceptanceFields))
      && dryRunLeaseRecords.every((record) => record.schema === DRY_RUN_LEASE_SCHEMA_VERSION && hasRequiredFields(record, requiredLeaseFields))
      && hasRequiredFields(report, requiredReportFields)
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION,
    'Missing local acceptance output fields.');

  add('literal-values-preserved',
    acceptanceRecords.every((record) => Object.entries(expectedAcceptance.requiredLiteralValues || {}).every(([field, expectedValue]) => {
      if ((field === 'target_role' || field === 'allowed_target_roles') && record.decision !== 'accepted_local_only') return true;
      return valuesMatch(pathValue(record, field), expectedValue);
    }))
      && dryRunLeaseRecords.every((record) => Object.entries(expectedLease.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(record, field), expectedValue)))
      && dryRunLeaseRecords.every((record) => Object.entries(expectedLease.proofBoundaryRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.proof_boundaries?.[field], expectedValue))),
    'Required literal changed.');

  add('pending-intent-only',
    acceptanceRecords.every((record) => record.decision !== 'accepted_local_only' || record.source_intent_ref?.status === 'pending_local_acceptance'),
    'Non-pending intent accepted.');

  add('local-architect-role-proof-required',
    acceptanceRecords.every((record) => record.decision !== 'accepted_local_only'
      || (record.role_discovery?.architect_role_registered === true && record.role_discovery?.role_target_proof === 'architect_local_verified')),
    'Acceptance lacks role proof.');

  add('fresh-risk-recheck-required',
    acceptanceRecords.every((record) => record.decision !== 'accepted_local_only'
      || (record.current_risk_recheck?.decision === 'still_tier0_or_tier1' && SAFE_RISK_TIERS.includes(record.current_risk_recheck?.current_risk_tier))),
    'Acceptance lacks safe fresh risk recheck.');

  add('current-scope-required',
    acceptanceRecords.every((record) => record.decision !== 'accepted_local_only' || record.profile_scope_result?.decision === 'match'),
    'Acceptance has scope mismatch.');

  add('expired-stale-rejected',
    acceptanceRecords.every((record) => record.decision !== 'accepted_local_only' || record.freshness_result?.decision === 'fresh'),
    'Expired or stale intent accepted.');

  add('direct-builder-oracle-cross-device-blocked',
    acceptanceRecords.every((record) => {
      if (record.source_intent_ref?.target_role === 'builder' || record.source_intent_ref?.target_role === 'oracle') {
        return record.decision !== 'accepted_local_only';
      }
      return true;
    }),
    'Direct Builder/Oracle target accepted.');

  add('local-delegation-after-acceptance-only',
    acceptanceRecords.every((record) => record.local_delegation?.delegation_performed === false
      && record.local_delegation?.server_originated_direct_targeting_still_blocked === true),
    'Delegation performed or server direct targeting allowed.');

  add('proof-boundaries-preserved',
    dryRunLeaseRecords.every((record) => record.dry_run_only === true
      && record.lease_not_created === true
      && record.route_not_sent === true
      && record.execution_not_performed === true
      && record.model_processing_not_proven === true
      && record.proof_boundaries?.acceptance_is_execution === false
      && record.proof_boundaries?.dry_run_lease_is_real_lease === false
      && record.proof_boundaries?.dry_run_lease_is_model_processing_proof === false
      && record.proof_boundaries?.socket_is_bridge_green === false
      && record.proof_boundaries?.websocket_acceptance_is_model_processing_proof === false),
    'Proof boundary overclaimed.');

  add('idempotent-accept-reject',
    acceptanceRecords.every((record) => {
      try {
        return record.idempotency_key === `acceptance-idem:${stableHash(canonicalAcceptanceInput(record))}`;
      } catch {
        return false;
      }
    })
      && dryRunLeaseRecords.every((record) => {
        try {
          return record.idempotency_key === `lease-dry-run-idem:${stableHash(canonicalDryRunLeaseInput(record))}`;
        } catch {
          return false;
        }
      }),
    'Idempotency key is unstable.');

  add('raw-payload-leak-prevention',
    acceptanceRecords.every((record) => !FORBIDDEN_OUTPUT_SUBSTRINGS.some((forbidden) => forbidden && JSON.stringify(record).includes(forbidden)))
      && dryRunLeaseRecords.every((record) => !FORBIDDEN_OUTPUT_SUBSTRINGS.some((forbidden) => forbidden && JSON.stringify(record).includes(forbidden))),
    'Raw payload leaked.');

  add('no-side-effects',
    report.side_effect_result?.no_queue_created === true
      && report.side_effect_result?.no_enqueue_performed === true
      && report.side_effect_result?.no_lease_created === true
      && report.side_effect_result?.no_route_performed === true
      && report.side_effect_result?.no_network_performed === true
      && report.side_effect_result?.no_execution_performed === true
      && report.side_effect_result?.no_external_send_performed === true
      && report.side_effect_result?.no_deploy_performed === true
      && report.side_effect_result?.no_trade_performed === true
      && report.side_effect_result?.no_store_write_performed === true
      && Number(report.side_effect_result?.queueWritesAttempted || 0) === 0
      && Number(report.side_effect_result?.leasesCreated || 0) === 0
      && Number(report.side_effect_result?.routesAttempted || 0) === 0
      && Number(report.side_effect_result?.networkRequestsAttempted || 0) === 0
      && Number(report.side_effect_result?.localExecutionAttempted || 0) === 0
      && Number(report.side_effect_result?.externalSendsAttempted || 0) === 0
      && Number(report.side_effect_result?.deploysAttempted || 0) === 0
      && Number(report.side_effect_result?.tradesAttempted || 0) === 0
      && Number(report.side_effect_result?.sourceStoreWritesAttempted || 0) === 0
      && Number(report.side_effect_result?.memoryCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.profileCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.fileMutationsAttempted || 0) === 0,
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
      throw new Error(`local_acceptance_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ACCEPTANCE_RECORD_SCHEMA_VERSION,
  DRY_RUN_LEASE_SCHEMA_VERSION,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ACCEPTANCE_RECORD_FIELDS,
  REQUIRED_DRY_RUN_LEASE_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreLocalAcceptance,
  stableHash,
  validateMiraCoreLocalAcceptanceOutput,
};
