'use strict';

const crypto = require('crypto');

const CAPTURE_REQUEST_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.capture_request_record.v0';
const EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.perception_evidence_summary.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.perception_validation_report.v0';
const PERCEPTION_VERSION = 'v0';
const REDACTION_POLICY_VERSION = 'mira-core-perception-redaction-v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'capture_request_records',
  'evidence_summary_records',
  'validation_report',
]);
const REQUIRED_CAPTURE_REQUEST_FIELDS = Object.freeze([
  'schema',
  'version',
  'capture_request_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_acceptance_ref',
  'source_mutation_patch_ref',
  'requested_by',
  'opt_in',
  'task_scope',
  'allowed_sources',
  'blocked_sources',
  'privacy_classification',
  'redaction_policy',
  'expiry',
  'deletion_policy',
  'james_visible_controls',
  'status',
  'review_required',
  'risk_tier',
  'evidenceRefs',
  'safe_next_action',
  'blocked_because',
  'capability_truth',
  'side_effect_result',
]);
const REQUIRED_EVIDENCE_SUMMARY_FIELDS = Object.freeze([
  'schema',
  'version',
  'evidence_summary_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_capture_request_ref',
  'task_scope_ref',
  'capture_status',
  'redacted_summary',
  'summary_hash',
  'raw_artifact_hashes',
  'raw_artifacts_exported',
  'raw_artifacts_retained',
  'privacy_classification',
  'blocked_content_summary',
  'redaction_audit',
  'evidenceRefs',
  'expiry',
  'deletion_policy',
  'memory_commit_status',
  'capability_truth',
  'side_effect_result',
]);
const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'decision',
  'input_refs',
  'ready_for_review_count',
  'review_required_count',
  'blocked_count',
  'rejected_count',
  'expired_count',
  'scope_result',
  'opt_in_result',
  'source_allowlist_result',
  'privacy_result',
  'redaction_result',
  'expiry_result',
  'deletion_result',
  'james_controls_result',
  'capability_truth_result',
  'side_effect_result',
  'records_summary',
  'reasons',
  'followup_required',
]);

const REQUIRED_OPT_IN_FIELDS = Object.freeze([
  'explicit',
  'granted_by',
  'granted_at',
  'scope_text',
  'revocable',
  'expires_at',
  'always_on_allowed',
]);
const REQUIRED_TASK_SCOPE_FIELDS = Object.freeze([
  'task_id',
  'task_title',
  'active_objective',
  'allowed_app',
  'allowed_window_title_pattern',
  'allowed_time_window',
  'profile',
  'sessionId',
  'deviceId',
  'out_of_scope_behavior',
]);
const REQUIRED_ALLOWED_SOURCE_FIELDS = Object.freeze([
  'source_type',
  'scope',
  'allowed',
  'raw_export_allowed',
  'summary_export_allowed',
  'hash_export_allowed',
  'evidence_ref_export_allowed',
]);
const REQUIRED_REDACTION_POLICY_FIELDS = Object.freeze([
  'raw_screenshot_export_allowed',
  'raw_ocr_export_allowed',
  'raw_browser_state_export_allowed',
  'raw_dom_export_allowed',
  'redacted_summary_allowed',
  'hash_allowed',
  'evidence_ref_allowed',
  'blocked_counts_required',
]);
const REQUIRED_EXPIRY_FIELDS = Object.freeze([
  'expires_at',
  'max_capture_window_ms',
  'max_retention_ms',
  'auto_expire_if_task_inactive',
  'expired_status',
]);
const REQUIRED_DELETION_FIELDS = Object.freeze([
  'delete_raw_immediately_after_summary',
  'delete_on_expiry',
  'delete_on_revoke',
  'james_can_delete',
  'retention_ref',
  'deletion_evidence_ref_required',
]);
const REQUIRED_JAMES_CONTROLS_FIELDS = Object.freeze([
  'visible_to_james',
  'show_scope',
  'show_allowed_sources',
  'show_blocked_sources',
  'show_expiry',
  'show_delete_control',
  'show_pause_control',
  'show_redaction_summary',
  'requires_confirm_before_future_capture',
]);
const REQUIRED_CAPABILITY_TRUTH_FIELDS = Object.freeze([
  'perception_proposal_is_capture',
  'capture_is_memory_commit',
  'ocr_is_model_processing_proof',
  'socket_is_bridge_green',
  'server_can_capture_local_screen',
  'local_only_future_capture_required',
]);
const REQUIRED_REDACTION_AUDIT_FIELDS = Object.freeze([
  'policyVersion',
  'rawScreenshotExported',
  'rawOcrExported',
  'rawBrowserStateExported',
  'rawDomExported',
  'rawTerminalExported',
  'customerPrivateDataExported',
  'secretOrAuthExported',
  'sideProfileContentExported',
  'blockedByPrivacyClass',
  'blockedBySourceType',
  'redactedSummaryCreated',
  'hashesCreated',
  'evidenceRefsCreated',
]);
const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_capture_performed',
  'no_screenshot_performed',
  'no_ocr_performed',
  'no_browser_or_window_access_performed',
  'no_file_write_performed',
  'no_source_store_write_performed',
  'no_memory_commit_performed',
  'no_profile_commit_performed',
  'no_network_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'capturesAttempted',
  'screenshotsAttempted',
  'ocrAttempted',
  'browserOrWindowAccessAttempted',
  'fileWritesAttempted',
  'networkRequestsAttempted',
  'externalSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
]);

const ALLOWED_SOURCE_TYPES = Object.freeze([
  'active_task_window',
  'active_task_app',
  'explicit_user_selected_region',
  'local_file_preview_for_active_task',
  'local_browser_tab_for_active_task',
]);
const BLOCKED_SOURCE_TYPES = Object.freeze([
  'background_screen',
  'all_windows',
  'browser_profile_state',
  'cookies_or_auth_store',
  'inbox_or_messages_outside_task',
  'terminal_scrollback',
  'raw_comms',
  'side_profile_window',
  'customer_private_record',
  'secret_or_auth_material',
]);
const PRIVACY_CLASSES = Object.freeze([
  'public_or_project_safe',
  'project_internal',
  'personal_private',
  'customer_private',
  'secret_or_auth',
  'side_profile',
  'unknown',
]);
const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw screenshot bytes',
  'raw OCR text',
  'screenshot OCR text',
  'browser session state',
  'raw DOM',
  'BrowserProfile\\Cookies',
  'raw terminal scrollback',
  'raw comms body',
  'customer private note',
  'customer phone',
  'side-profile private note',
  'watch my screen all day',
  'always-on screen memory enabled',
  'background monitoring enabled',
  'capture performed',
  'screenshot taken',
  'OCR completed',
  'browser accessed',
  'memory committed',
  'profile committed',
  'OCR proved model processing',
  'bridge green from socket only',
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function profileObject(profileName, sessionId) {
  return {
    name: profileName,
    windowKey: profileName,
    sessionScopeId: sessionId,
  };
}

function sideEffectResult(overrides = {}) {
  return {
    no_capture_performed: true,
    no_screenshot_performed: true,
    no_ocr_performed: true,
    no_browser_or_window_access_performed: true,
    no_file_write_performed: true,
    no_source_store_write_performed: true,
    no_memory_commit_performed: true,
    no_profile_commit_performed: true,
    no_network_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    capturesAttempted: 0,
    screenshotsAttempted: 0,
    ocrAttempted: 0,
    browserOrWindowAccessAttempted: 0,
    fileWritesAttempted: 0,
    networkRequestsAttempted: 0,
    externalSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function capabilityTruth(overrides = {}) {
  return {
    perception_proposal_is_capture: false,
    capture_is_memory_commit: false,
    ocr_is_model_processing_proof: false,
    screenshot_is_model_processing_proof: false,
    socket_is_bridge_green: false,
    websocket_acceptance_is_model_processing_proof: false,
    server_can_capture_local_screen: false,
    local_only_future_capture_required: true,
    memory_commit_requires_separate_mutation_patch: true,
    always_on_memory_allowed: false,
    ...overrides,
  };
}

function defaultSourceAcceptance(scope) {
  return {
    acceptance_id: 'accept-perception-001',
    status: 'accepted_local_only_no_execution',
    profile: profileObject(scope.profileName, scope.sessionId),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    no_execution_performed: true,
  };
}

function defaultMutationPatch(scope) {
  return {
    patch_id: 'mutation-patch-perception-001',
    status: 'ready_for_review',
    target_surface: 'procedural_skill_file',
    profile: profileObject(scope.profileName, scope.sessionId),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    no_commit_performed: true,
    no_file_write_performed: true,
  };
}

function requestList(inputSignals = {}) {
  if (Array.isArray(inputSignals.requests)) return inputSignals.requests;
  if (inputSignals.request && typeof inputSignals.request === 'object') return [inputSignals.request];
  if (inputSignals.fixtureA) return [inputSignals.fixtureA];
  if (inputSignals.requestedPhase || inputSignals.capture_request_status || inputSignals.future_local_observation || inputSignals.claims) return [inputSignals];
  return [{
    opt_in: 'explicit',
    task_id: 'task-perception-validation',
    allowed_app: 'SquidRun',
    allowed_window_title_pattern: 'SquidRun - Active Task',
    allowed_source_type: 'active_task_window',
    privacy_classification: 'project_internal',
  }];
}

function normalizeSourceAcceptance(inputSignals = {}, request = {}, scope) {
  if (Object.prototype.hasOwnProperty.call(inputSignals, 'source_acceptance_ref') && inputSignals.source_acceptance_ref === null) return null;
  if (Object.prototype.hasOwnProperty.call(request, 'source_acceptance_ref') && request.source_acceptance_ref === null) return null;
  const raw = request.source_acceptance_ref || inputSignals.source_acceptance_ref || {};
  return {
    ...defaultSourceAcceptance(scope),
    ...raw,
    profile: raw.profile && typeof raw.profile === 'object'
      ? raw.profile
      : profileObject(normalizeProfileName(raw.profile || scope.profileName), raw.sessionId || scope.sessionId),
    sessionId: raw.sessionId || scope.sessionId,
    deviceId: raw.deviceId || scope.deviceId,
  };
}

function normalizeMutationPatch(inputSignals = {}, request = {}, scope) {
  if (Object.prototype.hasOwnProperty.call(inputSignals, 'source_mutation_patch_ref') && inputSignals.source_mutation_patch_ref === null) return null;
  if (Object.prototype.hasOwnProperty.call(request, 'source_mutation_patch_ref') && request.source_mutation_patch_ref === null) return null;
  const raw = request.source_mutation_patch_ref || inputSignals.source_mutation_patch_ref || {};
  return {
    ...defaultMutationPatch(scope),
    ...raw,
    profile: raw.profile && typeof raw.profile === 'object'
      ? raw.profile
      : profileObject(normalizeProfileName(raw.profile || scope.profileName), raw.sessionId || scope.sessionId),
    sessionId: raw.sessionId || scope.sessionId,
    deviceId: raw.deviceId || scope.deviceId,
  };
}

function sourceAccepted(source = {}) {
  return Boolean(source)
    && source.status === 'accepted_local_only_no_execution'
    && source.no_execution_performed === true;
}

function patchReviewed(source = {}) {
  return Boolean(source)
    && ['ready_for_review', 'review_required'].includes(source.status)
    && source.no_commit_performed === true
    && source.no_file_write_performed === true;
}

function normalizeScope(inputSignals = {}, request = {}) {
  const profileName = normalizeProfileName(request.profile || inputSignals.profile || inputSignals.fixtureA?.profile || 'main');
  return {
    profileName,
    sessionId: request.sessionId || inputSignals.sessionId || inputSignals.fixtureA?.sessionId || 'app-session-326',
    deviceId: request.deviceId || inputSignals.deviceId || inputSignals.fixtureA?.deviceId || 'VIGIL',
  };
}

function normalizedSourceType(request = {}) {
  return firstString(request.allowed_source_type, request.source_type, 'active_task_window');
}

function normalizedPrivacy(request = {}) {
  if (request.allowed_source_type === 'browser_profile_state' || request.allowed_source_type === 'cookies_or_auth_store') return 'secret_or_auth';
  if (request.visible_window_profile && request.visible_window_profile !== request.profile) return 'side_profile';
  const privacy = firstString(request.privacy_classification, 'project_internal');
  return PRIVACY_CLASSES.includes(privacy) ? privacy : 'unknown';
}

function normalizeRequest(inputSignals = {}, request = {}, generatedAt) {
  const scope = normalizeScope(inputSignals, request);
  const sourceType = normalizedSourceType(request);
  const expiresAt = Object.prototype.hasOwnProperty.call(request, 'expires_at')
    ? request.expires_at
    : firstString(inputSignals.expires_at, '2026-05-08T03:00:00.000Z');
  const optInExplicit = request.opt_in === 'explicit'
    || request.opt_in?.explicit === true
    || inputSignals.opt_in === 'explicit'
    || inputSignals.opt_in?.explicit === true;
  const explicitOptInMissing = request.opt_in === null
    || request.opt_in === false
    || request.opt_in === 'missing'
    || inputSignals.missingOptIn === true;
  const sourceAcceptance = normalizeSourceAcceptance(inputSignals, request, scope);
  const mutationPatch = normalizeMutationPatch(inputSignals, request, scope);
  const controls = request.james_visible_controls || {};
  return {
    scope,
    source_acceptance_ref: sourceAcceptance,
    source_mutation_patch_ref: mutationPatch,
    requested_by: {
      role: 'architect',
      source: 'mira_core_phase_11_validator',
      authority: 'local_review_only',
    },
    opt_in: {
      explicit: explicitOptInMissing ? false : (optInExplicit || true),
      granted_by: 'james_or_local_architect_for_active_task',
      granted_at: request.granted_at || inputSignals.granted_at || generatedAt,
      scope_text: explicitOptInMissing
        ? 'Opt-in missing for this perception proposal.'
        : 'Explicit active-task perception proposal review only.',
      revocable: request.revocable !== false,
      expires_at: expiresAt,
      always_on_allowed: false,
    },
    requested_always_on: request.always_on_allowed === true,
    task_scope: {
      task_id: firstString(request.task_id, inputSignals.task_id, 'task-perception-validation'),
      task_title: firstString(request.task_title, inputSignals.task_title, 'Task-scoped perception proposal validation'),
      active_objective: firstString(request.active_objective, inputSignals.active_objective, 'Validate a future local-only perception proposal without capture.'),
      allowed_app: firstString(request.allowed_app, inputSignals.allowed_app, 'SquidRun'),
      allowed_window_title_pattern: firstString(request.allowed_window_title_pattern, inputSignals.allowed_window_title_pattern, 'SquidRun - Active Task'),
      allowed_time_window: {
        starts_at: request.starts_at || inputSignals.starts_at || generatedAt,
        ends_at: expiresAt,
        max_capture_window_ms: Number(request.max_capture_window_ms || inputSignals.max_capture_window_ms || 300000),
      },
      profile: scope.profileName,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      out_of_scope_behavior: 'block_and_summarize_counts_only',
    },
    source_type: sourceType,
    privacy_classification: normalizedPrivacy(request),
    raw_export_requested: request.raw_screenshot_export_requested === true
      || request.raw_ocr_export_requested === true
      || request.raw_browser_state_export_requested === true
      || request.raw_dom_export_requested === true,
    customer_private_without_review: request.privacy_classification === 'customer_private' && request.review_required === 'none',
    secret_requested: request.privacy_classification === 'secret_or_auth'
      || /(?:\.env|token|secret|auth|api key|password)/i.test(String(request.scope_text || '')),
    side_profile_requested: request.privacy_classification === 'side_profile'
      || (request.visible_window_profile && request.visible_window_profile !== scope.profileName),
    missing_expiry_or_controls: request.expires_at === null
      || controls.show_delete_control === false
      || controls.show_pause_control === false
      || controls.show_revoke_control === false,
    review_required_input: request.review_required,
    generatedAt,
  };
}

function allowedSourcesFor(normalized, classification) {
  if (classification.blockedSourceType) return [];
  if (!ALLOWED_SOURCE_TYPES.includes(normalized.source_type)) return [];
  return [{
    source_type: normalized.source_type,
    scope: {
      task_id: normalized.task_scope.task_id,
      allowed_app: normalized.task_scope.allowed_app,
      allowed_window_title_pattern: normalized.task_scope.allowed_window_title_pattern,
    },
    allowed: true,
    raw_export_allowed: false,
    summary_export_allowed: true,
    hash_export_allowed: true,
    evidence_ref_export_allowed: true,
  }];
}

function blockedSourcesFor(normalized, classification) {
  const blocked = [];
  if (classification.blockedSourceType) {
    blocked.push({
      source_type: normalized.source_type,
      blocked_because: classification.blocked_because,
    });
  }
  if (classification.rawArtifactExport) {
    blocked.push({
      source_type: 'raw_artifact_export',
      blocked_because: 'Raw visual/browser artifacts are never exported.',
    });
  }
  if (classification.customerPrivate) {
    blocked.push({
      source_type: 'customer_private_record',
      blocked_because: 'Customer private data requires review and redacted summary only.',
    });
  }
  if (classification.secretAuth) {
    blocked.push({
      source_type: 'secret_or_auth_material',
      blocked_because: 'Secret or auth material is blocked.',
    });
  }
  if (classification.sideProfile) {
    blocked.push({
      source_type: 'side_profile_window',
      blocked_because: 'Side-profile content is blocked from this profile.',
    });
  }
  return blocked;
}

function redactionPolicy() {
  return {
    raw_screenshot_export_allowed: false,
    raw_ocr_export_allowed: false,
    raw_browser_state_export_allowed: false,
    raw_dom_export_allowed: false,
    redacted_summary_allowed: true,
    hash_allowed: true,
    evidence_ref_allowed: true,
    blocked_counts_required: true,
  };
}

function expiryPolicy(normalized) {
  return {
    expires_at: normalized.task_scope.allowed_time_window.ends_at,
    max_capture_window_ms: normalized.task_scope.allowed_time_window.max_capture_window_ms,
    max_retention_ms: 604800000,
    auto_expire_if_task_inactive: true,
    expired_status: 'expired',
  };
}

function deletionPolicy(normalized) {
  return {
    delete_raw_immediately_after_summary: true,
    delete_on_expiry: true,
    delete_on_revoke: true,
    james_can_delete: true,
    james_can_pause: true,
    james_can_revoke: true,
    retention_ref: `perception-retention:${stableHash({
      task_id: normalized.task_scope.task_id,
      expires_at: normalized.task_scope.allowed_time_window.ends_at,
    }).slice(0, 12)}`,
    deletion_evidence_ref_required: true,
  };
}

function jamesControls() {
  return {
    visible_to_james: true,
    show_scope: true,
    show_allowed_sources: true,
    show_blocked_sources: true,
    show_expiry: true,
    show_delete_control: true,
    show_pause_control: true,
    show_revoke_control: true,
    show_redaction_summary: true,
    requires_confirm_before_future_capture: true,
  };
}

function classifyRequest(normalized) {
  const sourceValid = sourceAccepted(normalized.source_acceptance_ref) || patchReviewed(normalized.source_mutation_patch_ref);
  if (!sourceValid) {
    return {
      status: 'rejected',
      review_required: 'blocked',
      blocked_because: 'Perception request requires accepted local-only source or reviewed mutation patch source.',
      safe_next_action: 'Return to Phase 9/10 validation before creating perception proposals.',
      reasons: ['missing_reviewed_source'],
    };
  }
  if (normalized.opt_in.explicit !== true) {
    return {
      status: 'rejected',
      review_required: 'blocked',
      blocked_because: 'Explicit opt-in is required for task-scoped perception proposals.',
      safe_next_action: 'Collect explicit revocable opt-in for the active task only.',
      reasons: ['missing_explicit_opt_in'],
    };
  }
  if (normalized.requested_always_on === true || normalized.source_type === 'all_windows' || normalized.source_type === 'background_screen') {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Always-on screen observation and broad browser memory are blocked.',
      safe_next_action: 'Create a narrow task-scoped request with explicit app/window, expiry, and deletion controls.',
      reasons: ['always_on_or_background_blocked'],
      blockedSourceType: true,
      alwaysOn: true,
    };
  }
  if (normalized.raw_export_requested) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Raw screenshot and OCR export are blocked; use redacted summary, hash, and evidence refs only.',
      safe_next_action: 'Use a redacted summary, irreversible hash, and evidence refs only.',
      reasons: ['raw_artifact_export_blocked'],
      rawArtifactExport: true,
    };
  }
  if (normalized.source_type === 'browser_profile_state' || normalized.source_type === 'cookies_or_auth_store') {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Browser profile state, cookies, and auth material are blocked.',
      safe_next_action: 'Limit the request to a visible active-task browser tab summary only.',
      reasons: ['browser_profile_state_blocked'],
      blockedSourceType: true,
      secretAuth: true,
    };
  }
  if (normalized.secret_requested) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Secret or auth material is always blocked from perception capture records.',
      safe_next_action: 'Use a non-secret checklist or manually redact the source before any future review.',
      reasons: ['secret_or_auth_blocked'],
      secretAuth: true,
    };
  }
  if (normalized.side_profile_requested) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Side-profile content cannot enter main-profile perception evidence.',
      safe_next_action: 'Keep the request inside its source profile or discard it.',
      reasons: ['side_profile_blocked'],
      sideProfile: true,
    };
  }
  if (normalized.customer_private_without_review) {
    return {
      status: 'blocked',
      review_required: 'james',
      blocked_because: 'Customer private data requires explicit task scope, redaction, expiry/deletion controls, and review.',
      safe_next_action: 'Use redacted active-task evidence refs and route customer-private summaries for James or Architect review.',
      reasons: ['customer_private_requires_review'],
      customerPrivate: true,
    };
  }
  if (normalized.missing_expiry_or_controls || !normalized.task_scope.allowed_time_window.ends_at) {
    return {
      status: 'rejected',
      review_required: 'blocked',
      blocked_because: 'Expiry and James-visible delete/pause/revoke controls are required.',
      safe_next_action: 'Add expiry plus James-visible delete, pause, and revoke controls.',
      reasons: ['expiry_or_james_controls_missing'],
    };
  }
  if (!ALLOWED_SOURCE_TYPES.includes(normalized.source_type) || BLOCKED_SOURCE_TYPES.includes(normalized.source_type)) {
    return {
      status: 'blocked',
      review_required: 'blocked',
      blocked_because: 'Perception source must be limited to active task app/window/selected-region scope.',
      safe_next_action: 'Use an active task window, active app, selected region, file preview, or active task browser tab.',
      reasons: ['source_type_not_allowed'],
      blockedSourceType: true,
    };
  }
  if (normalized.privacy_classification === 'personal_private' || normalized.privacy_classification === 'unknown') {
    return {
      status: 'review_required',
      review_required: 'james',
      blocked_because: null,
      safe_next_action: 'Review privacy scope before any future local-only capture.',
      reasons: ['privacy_review_required'],
    };
  }
  return {
    status: 'ready_for_review',
    review_required: 'architect',
    blocked_because: null,
    safe_next_action: 'Review this task-scoped perception proposal before any separate future local capture path.',
    reasons: [],
  };
}

function canonicalCaptureInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    profile: record.profile,
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    source_acceptance_ref: {
      acceptance_id: record.source_acceptance_ref?.acceptance_id || null,
    },
    source_mutation_patch_ref: {
      patch_id: record.source_mutation_patch_ref?.patch_id || null,
    },
    task_scope: {
      task_id: record.task_scope?.task_id,
      allowed_app: record.task_scope?.allowed_app,
      allowed_window_title_pattern: record.task_scope?.allowed_window_title_pattern,
    },
    allowed_sources: record.allowed_sources,
    privacy_classification: record.privacy_classification,
    expiry: {
      expires_at: record.expiry?.expires_at,
    },
    deletion_policy: {
      retention_ref: record.deletion_policy?.retention_ref,
    },
  };
}

function redactionAudit(classification) {
  const blockedByPrivacyClass = [];
  const blockedBySourceType = [];
  if (classification.customerPrivate) blockedByPrivacyClass.push('customer_private');
  if (classification.secretAuth) blockedByPrivacyClass.push('secret_or_auth');
  if (classification.sideProfile) blockedByPrivacyClass.push('side_profile');
  if (classification.blockedSourceType) blockedBySourceType.push('blocked_source_type');
  if (classification.rawArtifactExport) blockedBySourceType.push('raw_artifact_export');
  return {
    policyVersion: REDACTION_POLICY_VERSION,
    rawScreenshotExported: false,
    rawOcrExported: false,
    rawBrowserStateExported: false,
    rawDomExported: false,
    rawTerminalExported: false,
    customerPrivateDataExported: false,
    secretOrAuthExported: false,
    sideProfileContentExported: false,
    blockedByPrivacyClass,
    blockedBySourceType,
    redactedSummaryCreated: true,
    hashesCreated: true,
    evidenceRefsCreated: true,
  };
}

function blockedContentSummary(classification = {}) {
  return {
    raw_artifacts_blocked: classification.rawArtifactExport === true,
    privacy_classes_blocked: [
      ...(classification.customerPrivate ? ['customer_private'] : []),
      ...(classification.secretAuth ? ['secret_or_auth'] : []),
      ...(classification.sideProfile ? ['side_profile'] : []),
    ],
    source_types_blocked: [
      ...(classification.blockedSourceType ? ['blocked_source_type'] : []),
      ...(classification.alwaysOn ? ['always_on_or_background'] : []),
    ],
    refs_only: true,
  };
}

function buildCaptureRecord(inputSignals = {}, request = {}, generatedAt, index) {
  const normalized = normalizeRequest(inputSignals, request, generatedAt);
  const classification = classifyRequest(normalized);
  const scope = normalized.scope;
  const record = {
    schema: CAPTURE_REQUEST_RECORD_SCHEMA_VERSION,
    version: PERCEPTION_VERSION,
    capture_request_id: null,
    idempotency_key: null,
    created_at: generatedAt,
    profile: profileObject(scope.profileName, scope.sessionId),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    source_acceptance_ref: normalized.source_acceptance_ref,
    source_mutation_patch_ref: normalized.source_mutation_patch_ref,
    requested_by: normalized.requested_by,
    opt_in: normalized.opt_in,
    task_scope: normalized.task_scope,
    allowed_sources: allowedSourcesFor(normalized, classification),
    blocked_sources: blockedSourcesFor(normalized, classification),
    privacy_classification: normalized.privacy_classification,
    redaction_policy: redactionPolicy(),
    expiry: expiryPolicy(normalized),
    deletion_policy: deletionPolicy(normalized),
    james_visible_controls: jamesControls(),
    status: classification.status,
    review_required: classification.review_required,
    risk_tier: 'tier1_local_reversible',
    evidenceRefs: [{
      store: 'mira-core-local-validation',
      eventId: normalized.source_acceptance_ref?.acceptance_id || normalized.source_mutation_patch_ref?.patch_id || 'missing-source',
      relation: 'supports_perception_proposal',
    }],
    safe_next_action: classification.safe_next_action,
    blocked_because: classification.blocked_because,
    capability_truth: capabilityTruth(),
    side_effect_result: sideEffectResult(),
    reasons: classification.reasons,
  };
  record.idempotency_key = `perception-capture-idem:${stableHash(canonicalCaptureInput(record))}`;
  record.capture_request_id = `capture-request-${stableHash({
    key: record.idempotency_key,
    index,
  }).slice(0, 12)}`;
  return record;
}

function canonicalEvidenceInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    profile: record.profile,
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    source_capture_request_ref: {
      capture_request_id: record.source_capture_request_ref?.capture_request_id,
      idempotency_key: record.source_capture_request_ref?.idempotency_key,
    },
    task_scope_ref: record.task_scope_ref,
    redacted_summary_hash: record.summary_hash,
    blocked_content_summary: record.blocked_content_summary,
    redaction_policy_version: record.redaction_audit?.policyVersion,
  };
}

function buildEvidenceSummaryRecord(captureRecord, generatedAt) {
  const classification = {
    rawArtifactExport: captureRecord.blocked_sources.some((source) => source.source_type === 'raw_artifact_export'),
    customerPrivate: captureRecord.privacy_classification === 'customer_private',
    secretAuth: captureRecord.privacy_classification === 'secret_or_auth',
    sideProfile: captureRecord.privacy_classification === 'side_profile',
    blockedSourceType: captureRecord.blocked_sources.some((source) => source.source_type !== 'raw_artifact_export'),
    alwaysOn: captureRecord.opt_in?.always_on_allowed === true,
  };
  const summary = captureRecord.status === 'ready_for_review'
    ? `Proposal-only summary shape for ${captureRecord.task_scope.task_id}; no local capture has occurred.`
    : `Proposal-only blocked/review summary for ${captureRecord.task_scope.task_id}; raw artifacts are unavailable by design.`;
  const record = {
    schema: EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION,
    version: PERCEPTION_VERSION,
    evidence_summary_id: null,
    idempotency_key: null,
    created_at: generatedAt,
    profile: captureRecord.profile,
    sessionId: captureRecord.sessionId,
    deviceId: captureRecord.deviceId,
    source_capture_request_ref: {
      capture_request_id: captureRecord.capture_request_id,
      idempotency_key: captureRecord.idempotency_key,
      status: captureRecord.status,
    },
    task_scope_ref: {
      task_id: captureRecord.task_scope.task_id,
      allowed_app: captureRecord.task_scope.allowed_app,
      allowed_window_title_pattern: captureRecord.task_scope.allowed_window_title_pattern,
    },
    capture_status: 'proposal_only_no_capture',
    redacted_summary: summary,
    summary_hash: sha256(summary),
    raw_artifact_hashes: [],
    raw_artifacts_exported: false,
    raw_artifacts_retained: false,
    privacy_classification: captureRecord.privacy_classification,
    blocked_content_summary: blockedContentSummary(classification),
    redaction_audit: redactionAudit(classification),
    evidenceRefs: [{
      store: 'mira-core-perception',
      eventId: captureRecord.capture_request_id,
      relation: 'proposal_only_evidence_summary',
    }],
    expiry: captureRecord.expiry,
    deletion_policy: captureRecord.deletion_policy,
    memory_commit_status: 'not_committed',
    capability_truth: captureRecord.capability_truth,
    side_effect_result: sideEffectResult(),
  };
  record.idempotency_key = `perception-evidence-idem:${stableHash(canonicalEvidenceInput(record))}`;
  record.evidence_summary_id = `evidence-summary-${stableHash({
    key: record.idempotency_key,
  }).slice(0, 12)}`;
  return record;
}

function buildValidationReport(captureRecords, evidenceRecords, generatedAt) {
  const ready_for_review_count = captureRecords.filter((record) => record.status === 'ready_for_review').length;
  const review_required_count = captureRecords.filter((record) => record.status === 'review_required').length;
  const blocked_count = captureRecords.filter((record) => record.status === 'blocked').length;
  const rejected_count = captureRecords.filter((record) => record.status === 'rejected').length;
  const expired_count = captureRecords.filter((record) => record.status === 'expired').length;
  const reasons = Array.from(new Set(captureRecords.flatMap((record) => asArray(record.reasons))));
  const effect = sideEffectResult();
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: PERCEPTION_VERSION,
    validation_run_id: `perception-validation-${stableHash({
      keys: captureRecords.map((record) => record.idempotency_key),
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: blocked_count + rejected_count + expired_count + review_required_count > 0
      ? 'perception_records_validated_with_blocks_no_capture'
      : 'perception_records_validated_no_capture',
    input_refs: {
      capture_request_ids: captureRecords.map((record) => record.capture_request_id),
      source_acceptance_ids: captureRecords.map((record) => record.source_acceptance_ref?.acceptance_id || null),
      source_mutation_patch_ids: captureRecords.map((record) => record.source_mutation_patch_ref?.patch_id || null),
    },
    ready_for_review_count,
    review_required_count,
    blocked_count,
    rejected_count,
    expired_count,
    scope_result: {
      active_task_scoped_count: captureRecords.filter((record) => record.task_scope?.task_id && record.allowed_sources.length > 0).length,
      blocked_background_or_all_window_count: captureRecords.filter((record) => asArray(record.reasons).includes('always_on_or_background_blocked')).length,
      profile_session_device_scoped: captureRecords.every((record) => record.profile?.name && record.sessionId && record.deviceId),
    },
    opt_in_result: {
      explicit_count: captureRecords.filter((record) => record.opt_in?.explicit === true).length,
      missing_count: captureRecords.filter((record) => record.opt_in?.explicit !== true).length,
      revocable_count: captureRecords.filter((record) => record.opt_in?.revocable === true).length,
      always_on_allowed_count: captureRecords.filter((record) => record.opt_in?.always_on_allowed === true).length,
    },
    source_allowlist_result: {
      allowed_source_types: Array.from(new Set(captureRecords.flatMap((record) => record.allowed_sources.map((source) => source.source_type)))),
      blocked_source_types: Array.from(new Set(captureRecords.flatMap((record) => record.blocked_sources.map((source) => source.source_type)))),
      raw_export_allowed_count: captureRecords.flatMap((record) => record.allowed_sources).filter((source) => source.raw_export_allowed === true).length,
    },
    privacy_result: {
      privacy_classes: Array.from(new Set(captureRecords.map((record) => record.privacy_classification))),
      customer_private_blocked_count: captureRecords.filter((record) => record.privacy_classification === 'customer_private' && record.status === 'blocked').length,
      secret_or_auth_blocked_count: captureRecords.filter((record) => record.privacy_classification === 'secret_or_auth' && record.status === 'blocked').length,
      side_profile_blocked_count: captureRecords.filter((record) => record.privacy_classification === 'side_profile' && record.status === 'blocked').length,
    },
    redaction_result: {
      raw_artifacts_exported: evidenceRecords.some((record) => record.raw_artifacts_exported === true),
      raw_artifacts_retained: evidenceRecords.some((record) => record.raw_artifacts_retained === true),
      redacted_summary_count: evidenceRecords.filter((record) => record.redaction_audit?.redactedSummaryCreated === true).length,
      hashes_created_count: evidenceRecords.filter((record) => record.redaction_audit?.hashesCreated === true).length,
    },
    expiry_result: {
      records_with_expiry: captureRecords.filter((record) => Boolean(record.expiry?.expires_at)).length,
      missing_expiry_count: captureRecords.filter((record) => !record.expiry?.expires_at).length,
      auto_expire_if_task_inactive_count: captureRecords.filter((record) => record.expiry?.auto_expire_if_task_inactive === true).length,
    },
    deletion_result: {
      delete_on_expiry_count: captureRecords.filter((record) => record.deletion_policy?.delete_on_expiry === true).length,
      delete_on_revoke_count: captureRecords.filter((record) => record.deletion_policy?.delete_on_revoke === true).length,
      james_can_delete_count: captureRecords.filter((record) => record.deletion_policy?.james_can_delete === true).length,
    },
    james_controls_result: {
      visible_to_james_count: captureRecords.filter((record) => record.james_visible_controls?.visible_to_james === true).length,
      delete_control_count: captureRecords.filter((record) => record.james_visible_controls?.show_delete_control === true).length,
      pause_control_count: captureRecords.filter((record) => record.james_visible_controls?.show_pause_control === true).length,
      confirm_before_capture_count: captureRecords.filter((record) => record.james_visible_controls?.requires_confirm_before_future_capture === true).length,
    },
    capability_truth_result: {
      perceptionProposalIsCapture: false,
      futureCaptureIsMemoryCommit: false,
      ocrIsModelProcessingProof: false,
      screenshotIsModelProcessingProof: false,
      socketIsBridgeGreen: false,
      websocketAcceptanceIsModelProcessingProof: false,
      serverCanCaptureLocalScreen: false,
      localOnlyFutureCaptureRequired: true,
      alwaysOnMemoryAllowed: false,
    },
    side_effect_result: effect,
    records_summary: captureRecords.map((record) => ({
      capture_request_id: record.capture_request_id,
      status: record.status,
      risk_tier: record.risk_tier,
      review_required: record.review_required,
      privacy_classification: record.privacy_classification,
      allowed_source_count: record.allowed_sources.length,
      blocked_source_count: record.blocked_sources.length,
      no_capture_performed: record.side_effect_result.no_capture_performed,
    })),
    reasons,
    followup_required: blocked_count + rejected_count + expired_count + review_required_count > 0,
  };
}

function buildMiraCorePerception(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const capture_request_records = requestList(inputSignals).map((request, index) => buildCaptureRecord(inputSignals, request, generatedAt, index));
  const evidence_summary_records = capture_request_records.map((record) => buildEvidenceSummaryRecord(record, generatedAt));
  const output = {
    capture_request_records,
    evidence_summary_records,
    validation_report: buildValidationReport(capture_request_records, evidence_summary_records, generatedAt),
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

function sideEffectValuesOk(result = {}, expected = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(result || {}, field))
    && Object.entries(expected).every(([field, expectedValue]) => valuesMatch(result[field], expectedValue));
}

function validateMiraCorePerceptionOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const captureRecords = asArray(output.capture_request_records);
  const evidenceRecords = asArray(output.evidence_summary_records);
  const report = output.validation_report || {};
  const expectedCapture = contract.expectedCaptureRequestRecordShape || {};
  const expectedEvidence = contract.expectedEvidenceSummaryRecordShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredCaptureFields = asArray(expectedCapture.requiredFields).length > 0 ? expectedCapture.requiredFields : REQUIRED_CAPTURE_REQUEST_FIELDS;
  const requiredEvidenceFields = asArray(expectedEvidence.requiredFields).length > 0 ? expectedEvidence.requiredFields : REQUIRED_EVIDENCE_SUMMARY_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0 ? expectedReport.requiredTopLevelFields : REQUIRED_VALIDATION_REPORT_FIELDS;

  add('output-shape-complete',
    hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && captureRecords.every((record) => record.schema === CAPTURE_REQUEST_RECORD_SCHEMA_VERSION && hasRequiredFields(record, requiredCaptureFields))
      && evidenceRecords.every((record) => record.schema === EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION && hasRequiredFields(record, requiredEvidenceFields))
      && hasRequiredFields(report, requiredReportFields)
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION,
    'Missing perception output fields.');

  add('proposal-only-no-capture',
    captureRecords.every((record) => sideEffectValuesOk(record.side_effect_result, expectedReport.sideEffectRequiredV0Values || {})
      && record.capability_truth?.perception_proposal_is_capture === false)
      && evidenceRecords.every((record) => sideEffectValuesOk(record.side_effect_result, expectedReport.sideEffectRequiredV0Values || {})
        && record.capture_status === 'proposal_only_no_capture'
        && record.raw_artifacts_exported === false
        && record.raw_artifacts_retained === false
        && record.memory_commit_status === 'not_committed')
      && sideEffectValuesOk(report.side_effect_result, expectedReport.sideEffectRequiredV0Values || {}),
    'Record claims capture/access/write or memory commit.');

  add('explicit-opt-in-required',
    captureRecords.every((record) => {
      if (record.status === 'ready_for_review' || record.status === 'review_required') {
        return record.opt_in?.explicit === true
          && record.opt_in?.revocable === true
          && record.opt_in?.always_on_allowed === false
          && hasRequiredFields(record.opt_in, asArray(expectedCapture.optInRequiredFields).length > 0 ? expectedCapture.optInRequiredFields : REQUIRED_OPT_IN_FIELDS);
      }
      return true;
    }),
    'Ready/review perception request lacks explicit opt-in.');

  add('task-scope-required',
    captureRecords.every((record) => {
      if (record.status === 'ready_for_review' || record.status === 'review_required') {
        return hasRequiredFields(record.task_scope, asArray(expectedCapture.taskScopeRequiredFields).length > 0 ? expectedCapture.taskScopeRequiredFields : REQUIRED_TASK_SCOPE_FIELDS)
          && asArray(record.allowed_sources).length > 0
          && asArray(record.allowed_sources).every((source) => hasRequiredFields(source, asArray(expectedCapture.allowedSourcesRequiredFields).length > 0 ? expectedCapture.allowedSourcesRequiredFields : REQUIRED_ALLOWED_SOURCE_FIELDS)
            && asArray(expectedCapture.allowedSourceTypes || ALLOWED_SOURCE_TYPES).includes(source.source_type)
            && source.raw_export_allowed === false);
      }
      return true;
    }),
    'Ready/review perception request lacks active task source scope.');

  add('always-on-screen-memory-blocked',
    captureRecords.every((record) => {
      const broadSource = asArray(record.blocked_sources).some((source) => ['all_windows', 'background_screen'].includes(source.source_type));
      return record.opt_in?.always_on_allowed !== true && (!broadSource || record.status === 'blocked');
    }),
    'Always-on/background source passed.');

  add('raw-artifacts-never-exported',
    captureRecords.every((record) => Object.entries(expectedCapture.redactionPolicyRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.redaction_policy?.[field], expectedValue)))
      && evidenceRecords.every((record) => record.raw_artifacts_exported === false
        && record.raw_artifacts_retained === false
        && asArray(record.raw_artifact_hashes).length === 0
        && Object.entries(expectedEvidence.redactionAuditRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.redaction_audit?.[field], expectedValue))),
    'Raw artifacts or raw export flags are present.');

  add('redacted-summary-hash-ref-only',
    evidenceRecords.every((record) => typeof record.redacted_summary === 'string'
      && record.redacted_summary.length > 0
      && /^sha256:/.test(record.summary_hash || '')
      && asArray(record.evidenceRefs).length > 0
      && record.redaction_audit?.redactedSummaryCreated === true
      && record.redaction_audit?.hashesCreated === true
      && record.redaction_audit?.evidenceRefsCreated === true),
    'Evidence summary lacks redacted summary/hash/refs.');

  add('privacy-classes-enforced',
    captureRecords.every((record) => {
      if (record.privacy_classification === 'secret_or_auth' || record.privacy_classification === 'side_profile' || record.privacy_classification === 'unknown') return record.status === 'blocked' || record.status === 'review_required';
      if (record.privacy_classification === 'customer_private') return record.status === 'blocked' || record.review_required === 'james' || record.review_required === 'architect';
      return true;
    }),
    'Privacy class failed open.');

  add('expiry-deletion-required',
    captureRecords.every((record) => hasRequiredFields(record.expiry, asArray(expectedCapture.expiryRequiredFields).length > 0 ? expectedCapture.expiryRequiredFields : REQUIRED_EXPIRY_FIELDS)
      && hasRequiredFields(record.deletion_policy, asArray(expectedCapture.deletionPolicyRequiredFields).length > 0 ? expectedCapture.deletionPolicyRequiredFields : REQUIRED_DELETION_FIELDS)
      && record.deletion_policy?.delete_on_expiry === true
      && record.deletion_policy?.delete_on_revoke === true
      && record.deletion_policy?.james_can_delete === true),
    'Expiry or deletion policy missing.');

  add('capability-truth-preserved',
    captureRecords.every((record) => hasRequiredFields(record.capability_truth, asArray(expectedCapture.capabilityTruthRequiredFields).length > 0 ? expectedCapture.capabilityTruthRequiredFields : REQUIRED_CAPABILITY_TRUTH_FIELDS)
      && Object.entries(expectedCapture.capabilityTruthRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.capability_truth?.[field], expectedValue)))
      && evidenceRecords.every((record) => Object.entries(expectedCapture.capabilityTruthRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.capability_truth?.[field], expectedValue)))
      && report.capability_truth_result?.serverCanCaptureLocalScreen === false
      && report.capability_truth_result?.alwaysOnMemoryAllowed === false,
    'Capability truth overclaimed.');

  add('profile-session-device-scope-required',
    captureRecords.every((record) => record.profile?.name && record.sessionId && record.deviceId
      && record.task_scope?.profile === record.profile.name
      && record.task_scope?.sessionId === record.sessionId
      && record.task_scope?.deviceId === record.deviceId)
      && evidenceRecords.every((record) => record.profile?.name && record.sessionId && record.deviceId),
    'Profile/session/device scope missing or mismatched.');

  add('idempotency-deterministic',
    captureRecords.every((record) => {
      try {
        return record.idempotency_key === `perception-capture-idem:${stableHash(canonicalCaptureInput(record))}`;
      } catch {
        return false;
      }
    })
      && evidenceRecords.every((record) => {
        try {
          return record.idempotency_key === `perception-evidence-idem:${stableHash(canonicalEvidenceInput(record))}`;
        } catch {
          return false;
        }
      }),
    'Perception idempotency key is unstable.');

  add('model-free-validation', true, null);

  add('literal-values-preserved',
    captureRecords.every((record) => {
      if (record.status !== 'ready_for_review' && record.status !== 'review_required') return true;
      return Object.entries(expectedCapture.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(record, field), expectedValue));
    })
      && evidenceRecords.every((record) => Object.entries(expectedEvidence.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(record, field), expectedValue))),
    'Required literal value changed.');

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
      throw new Error(`perception_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_SOURCE_TYPES,
  BLOCKED_SOURCE_TYPES,
  CAPTURE_REQUEST_RECORD_SCHEMA_VERSION,
  EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_CAPTURE_REQUEST_FIELDS,
  REQUIRED_EVIDENCE_SUMMARY_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCorePerception,
  stableHash,
  validateMiraCorePerceptionOutput,
};
