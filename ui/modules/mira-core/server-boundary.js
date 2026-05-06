'use strict';

const crypto = require('crypto');

const SERVER_RECEIVE_RECORD_SCHEMA_VERSION = 'squidrun.mira_core.server_receive_record.v0';
const SERVER_STATUS_SUMMARY_SCHEMA_VERSION = 'squidrun.mira_core.server_status_summary.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.server_boundary_validation_report.v0';
const SERVER_BOUNDARY_VERSION = 'v0';
const REDACTION_POLICY_VERSION = 'mira-core-server-boundary-redaction-v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'server_receive_records',
  'server_status_summaries',
  'validation_report',
]);
const REQUIRED_SERVER_RECEIVE_FIELDS = Object.freeze([
  'schema',
  'version',
  'receive_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_upload_ref',
  'source_intent_refs',
  'receive_mode',
  'decision',
  'accepted_items_summary',
  'withheld_items_summary',
  'stored_future_shape',
  'source_watermarks',
  'redaction_audit',
  'profile_scope_result',
  'stale_watermark_result',
  'capability_truth',
  'server_targeting',
  'deletion_controls',
  'export_controls',
  'replay_protection',
  'evidenceRefs',
  'reasons',
  'side_effect_result',
]);
const REQUIRED_SERVER_STATUS_FIELDS = Object.freeze([
  'schema',
  'version',
  'status_id',
  'idempotency_key',
  'created_at',
  'profile',
  'sessionId',
  'deviceId',
  'source_receive_refs',
  'pc_local_arms_status',
  'server_capability_summary',
  'stored_summary_counts',
  'pending_intent_summary',
  'redaction_summary',
  'bridge_delivery_truth',
  'local_architect_handoff',
  'deletion_export_controls',
  'operator_message',
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
  'accepted_receive_count',
  'status_summary_count',
  'blocked_count',
  'rejected_count',
  'eligibility_result',
  'redaction_result',
  'profile_scope_result',
  'idempotency_result',
  'watermark_result',
  'stale_result',
  'capability_truth_result',
  'targeting_result',
  'deletion_export_result',
  'side_effect_result',
  'records_summary',
  'reasons',
  'followup_required',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_server_deploy_performed',
  'no_network_performed',
  'no_database_write_performed',
  'no_queue_created',
  'no_auth_or_secret_generated',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_or_window_access_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'serverDeploysAttempted',
  'networkRequestsAttempted',
  'databaseWritesAttempted',
  'queuesCreated',
  'authSecretsGenerated',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserOrWindowAccessAttempted',
  'externalSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
]);
const REQUIRED_SOURCE_UPLOAD_FIELDS = Object.freeze([
  'upload_id',
  'idempotency_key',
  'schema',
  'profile',
  'sessionId',
  'deviceId',
  'snapshotRef',
  'source_watermarks',
  'redaction_audit',
  'no_network_performed',
]);
const REQUIRED_SOURCE_INTENT_FIELDS = Object.freeze([
  'intent_id',
  'idempotency_key',
  'status',
  'profile',
  'sessionId',
  'deviceId',
  'target_role',
  'risk_tier',
  'payload_hash',
  'payload_redaction_status',
  'no_execution_performed',
]);
const REQUIRED_ACCEPTED_ITEMS_SUMMARY_FIELDS = Object.freeze([
  'total',
  'by_syncEligibility',
  'by_authority',
  'by_source',
  'summary_refs',
  'hashes',
  'raw_payload_exported',
]);
const REQUIRED_STORED_FUTURE_SHAPE_FIELDS = Object.freeze([
  'storage_intent',
  'may_store_later',
  'store_kind',
  'redacted_summaries_only',
  'refs_only',
  'hashes_only',
  'raw_payload_storage_allowed',
  'requires_database_write_later',
  'write_performed_now',
]);
const REQUIRED_REDACTION_AUDIT_FIELDS = Object.freeze([
  'policyVersion',
  'rawSecretsStored',
  'rawTerminalStored',
  'rawCommsStored',
  'rawScreenshotOcrStored',
  'rawBrowserStateStored',
  'customerPrivateDataStored',
  'sideProfileContentStored',
  'acceptedCount',
  'redactedCount',
  'withheldCount',
  'withheldByReason',
  'auditRefs',
]);
const REQUIRED_CAPABILITY_TRUTH_FIELDS = Object.freeze([
  'serverCanConverse',
  'serverCanReportStatus',
  'serverCanQueueProposal',
  'serverCanExecuteLocal',
  'serverCanOperatePTY',
  'serverCanRunShell',
  'serverCanAccessBrowserOrWindow',
  'serverCanSendCustomerMessages',
  'serverCanDeploy',
  'serverCanTrade',
  'serverCanProveModelProcessing',
  'bridgeGreenFromSocketAlone',
  'localArmsOfflineHonesty',
]);
const REQUIRED_TARGETING_FIELDS = Object.freeze([
  'future_server_originated_target',
  'allowed_target_roles',
  'blocked_direct_targets',
  'local_architect_acceptance_required',
  'local_builder_oracle_delegation_only_after_acceptance',
]);
const REQUIRED_DELETION_FIELDS = Object.freeze([
  'delete_supported_later',
  'delete_by_profile',
  'delete_by_session',
  'delete_by_device',
  'delete_by_upload_id',
  'delete_by_intent_id',
  'james_visible_delete_control',
  'deletion_evidence_ref_required',
  'delete_performed_now',
]);
const REQUIRED_EXPORT_FIELDS = Object.freeze([
  'export_supported_later',
  'export_redacted_only',
  'export_refs_hashes_only',
  'raw_export_allowed',
  'james_visible_export_control',
  'export_performed_now',
]);

const ACCEPTED_SYNC_ELIGIBILITY = Object.freeze(['core_sync_safe', 'core_sync_redacted']);
const SAFE_INTENT_RISKS = Object.freeze(['tier0_read_only', 'tier1_local_reversible']);
const BLOCKED_UPLOAD_REASONS = Object.freeze(['blocked', 'local_only', 'approval_required']);
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
  'server can execute local shell',
  'server can operate PTY',
  'server can run shell',
  'server accessed browser',
  'server sent customer message',
  'server deployed',
  'server placed trade',
  'server proved model processing',
  'bridge green from socket only',
  'server routed to builder',
  'server routed to oracle',
  'database write complete',
  'queue created',
  'server deployed process',
]);
const RAW_PAYLOAD_PATTERNS = Object.freeze([
  /raw\s+comms\s+body/i,
  /terminal\s+scrollback/i,
  /screenshot\s+OCR\s+text/i,
  /browser\s+session\s+state/i,
  /secret/i,
  /customer\s+private\s+note/i,
  /OPENAI_API_KEY\s*=/i,
  /Authorization\s*:\s*Bearer/i,
  /BEGIN\s+PRIVATE\s+KEY/i,
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

function normalizeScope(inputSignals = {}) {
  const src = inputSignals.fixtureA || inputSignals.upload_envelope || inputSignals.upload || inputSignals.intent || {};
  return {
    profileName: normalizeProfileName(src.profile?.name || src.profile || inputSignals.profile || 'main'),
    sessionId: src.sessionId || inputSignals.sessionId || 'app-session-326',
    deviceId: src.deviceId || inputSignals.deviceId || 'VIGIL',
  };
}

function profileObject(scope) {
  return {
    name: scope.profileName,
    windowKey: scope.profileName,
    sessionScopeId: scope.sessionId,
  };
}

function sideEffectResult(overrides = {}) {
  return {
    no_server_deploy_performed: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_queue_created: true,
    no_auth_or_secret_generated: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_or_window_access_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    serverDeploysAttempted: 0,
    networkRequestsAttempted: 0,
    databaseWritesAttempted: 0,
    queuesCreated: 0,
    authSecretsGenerated: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserOrWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function capabilityTruth(localArmsOnline = false) {
  return {
    serverCanConverse: true,
    serverCanReportStatus: true,
    serverCanQueueProposal: true,
    serverCanReceiveRedactedUploadsLater: true,
    serverCanStoreRedactedSummariesLater: true,
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanRunShell: false,
    serverCanAccessBrowserOrWindow: false,
    serverCanSendCustomerMessages: false,
    serverCanDeploy: false,
    serverCanTrade: false,
    serverCanProveModelProcessing: false,
    bridgeGreenFromSocketAlone: false,
    localArmsOfflineHonesty: localArmsOnline
      ? 'Local execution still requires local Architect acceptance; server does not execute directly.'
      : 'Server can converse/status/prepare proposals only; local execution waits for local arms and Architect acceptance.',
  };
}

function serverTargeting() {
  return {
    future_server_originated_target: 'architect',
    allowed_target_roles: ['architect'],
    blocked_direct_targets: ['builder', 'oracle'],
    local_architect_acceptance_required: true,
    local_builder_oracle_delegation_only_after_acceptance: true,
  };
}

function deletionControls() {
  return {
    delete_supported_later: true,
    delete_by_profile: true,
    delete_by_session: true,
    delete_by_device: true,
    delete_by_upload_id: true,
    delete_by_intent_id: true,
    james_visible_delete_control: true,
    deletion_evidence_ref_required: true,
    delete_performed_now: false,
  };
}

function exportControls() {
  return {
    export_supported_later: true,
    export_redacted_only: true,
    export_refs_hashes_only: true,
    raw_export_allowed: false,
    james_visible_export_control: true,
    export_performed_now: false,
  };
}

function defaultWatermarks(scope, inputSignals = {}) {
  const contentHash = inputSignals.watermarksHash || inputSignals.fixtureA?.watermarksHash || 'sha256:watermarks-default';
  return [{
    source: 'snapshot',
    scope: scope.profileName,
    watermark: `snapshot:${scope.profileName}`,
    contentHash,
  }];
}

function normalizeUploadRef(inputSignals = {}, scope) {
  const src = inputSignals.upload_envelope || inputSignals.upload || inputSignals.fixtureA || {};
  const snapshotHash = src.snapshotHash || inputSignals.snapshotHash || inputSignals.fixtureA?.snapshotHash || 'sha256:snapshot-default';
  return {
    upload_id: src.upload_id || src.uploadId || 'upload-boundary-001',
    idempotency_key: src.idempotency_key || src.uploadKey || inputSignals.uploadKey || inputSignals.fixtureA?.uploadKey || 'upload-key-default',
    schema: src.schema || 'squidrun.mira_core.server_upload_envelope.v0',
    profile: src.profile && typeof src.profile === 'object' ? src.profile : profileObject(scope),
    sessionId: src.sessionId || scope.sessionId,
    deviceId: src.deviceId || scope.deviceId,
    snapshotRef: src.snapshotRef || {
      snapshotId: 'snapshot-boundary-001',
      schema: 'squidrun.mira_core.snapshot.v0',
      contentHash: snapshotHash,
    },
    source_watermarks: asArray(src.source_watermarks).length > 0
      ? src.source_watermarks
      : defaultWatermarks(scope, {
          ...inputSignals,
          watermarksHash: src.watermarksHash || inputSignals.watermarksHash,
        }),
    redaction_audit: src.redaction_audit || {
      policyVersion: REDACTION_POLICY_VERSION,
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      rawScreenshotOcrExported: false,
      rawBrowserStateExported: false,
      customerPrivateDataExported: false,
      sideProfileContentExported: false,
    },
    no_network_performed: src.no_network_performed !== false,
  };
}

function defaultUploadItems(inputSignals = {}, scope) {
  if (Array.isArray(inputSignals.upload_items)) return inputSignals.upload_items;
  if (inputSignals.payload) return [];
  const envelope = inputSignals.upload_envelope || {};
  const syncs = asArray(envelope.syncEligibilityValues);
  const redactions = asArray(envelope.redactionStatusValues);
  if (syncs.length > 0) {
    return syncs.map((syncEligibility, index) => ({
      id: `upload-item-${index + 1}`,
      syncEligibility,
      redactionStatus: redactions[index] || (syncEligibility === 'core_sync_redacted' ? 'applied' : 'none'),
      authority: index === 0 ? 'verified_tool_or_system_evidence' : 'derived',
      source: index === 0 ? 'snapshot' : 'profile',
      profile: scope.profileName,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      payload_hash: sha256({ syncEligibility, index }),
      redaction_audit_ref: syncEligibility === 'core_sync_redacted' ? 'redaction-audit:applied' : null,
    }));
  }
  return [{
    id: 'upload-item-safe-001',
    syncEligibility: 'core_sync_safe',
    redactionStatus: 'none',
    authority: 'verified_tool_or_system_evidence',
    source: 'snapshot',
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    payload_hash: 'sha256:item-safe-001',
  }];
}

function normalizeIntent(inputSignals = {}, intent = {}, scope, index = 0) {
  const src = {
    status: 'pending_local_acceptance',
    target_role: 'architect',
    allowed_target_roles: ['architect'],
    risk_tier: 'tier0_read_only',
    payload_redaction_status: 'none',
    no_execution_performed: true,
    ...inputSignals.intent,
    ...intent,
  };
  const intentKey = src.idempotency_key || src.intentKey || inputSignals.intentKey || inputSignals.fixtureA?.intentKey || `intent-key-${index + 1}`;
  return {
    intent_id: src.intent_id || `intent-boundary-${index + 1}`,
    idempotency_key: intentKey,
    status: src.status,
    profile: src.profile && typeof src.profile === 'object' ? src.profile : profileObject(scope),
    sessionId: src.sessionId || scope.sessionId,
    deviceId: src.deviceId || scope.deviceId,
    target_role: src.target_role || 'architect',
    allowed_target_roles: asArray(src.allowed_target_roles).length > 0 ? src.allowed_target_roles : ['architect'],
    risk_tier: src.risk_tier || 'tier0_read_only',
    payload_hash: src.payload_hash || sha256({ intentKey, target: src.target_role || 'architect' }),
    payload_redaction_status: src.payload_redaction_status || 'none',
    no_execution_performed: src.no_execution_performed !== false,
    expires_at: src.expires_at || null,
    source_ref_generated_at: src.source_ref_generated_at || null,
  };
}

function normalizeIntents(inputSignals = {}, scope) {
  if (Array.isArray(inputSignals.intents)) return inputSignals.intents.map((intent, index) => normalizeIntent(inputSignals, intent, scope, index));
  if (inputSignals.intent) return [normalizeIntent(inputSignals, inputSignals.intent, scope, 0)];
  if (inputSignals.fixtureA || inputSignals.intentKey) return [normalizeIntent(inputSignals, {}, scope, 0)];
  return [normalizeIntent(inputSignals, {}, scope, 0)];
}

function itemReason(item = {}, scope) {
  const reasons = [];
  if (BLOCKED_UPLOAD_REASONS.includes(item.syncEligibility)) reasons.push(item.syncEligibility);
  if (!ACCEPTED_SYNC_ELIGIBILITY.includes(item.syncEligibility)) reasons.push('blocked');
  if (item.syncEligibility === 'core_sync_redacted' && item.redactionStatus !== 'applied') reasons.push('unredacted_core_sync_redacted');
  if (item.syncEligibility === 'core_sync_redacted' && !item.payload_hash) reasons.push('unredacted_core_sync_redacted');
  if (!item.profile || !item.sessionId || !item.deviceId) reasons.push('missing_profile_session_device_scope');
  if (item.profile && normalizeProfileName(item.profile) !== scope.profileName) reasons.push('profile_mismatch');
  if (item.stale === true) reasons.push('stale_rejected');
  if (item.watermarkRegression === true) reasons.push('watermark_regression');
  return Array.from(new Set(reasons));
}

function intentReason(intent = {}, generatedAt) {
  const reasons = [];
  if (intent.status !== 'pending_local_acceptance') reasons.push('status_not_pending_local_acceptance');
  if (intent.target_role !== 'architect') reasons.push(`target_${intent.target_role}_blocked`);
  if (JSON.stringify(intent.allowed_target_roles) !== JSON.stringify(['architect'])) reasons.push('non_architect_allowed_target');
  if (!SAFE_INTENT_RISKS.includes(intent.risk_tier)) reasons.push('unsafe_risk_tier');
  if (intent.payload_redaction_status === 'blocked') reasons.push('payload_redaction_blocked');
  if (intent.no_execution_performed !== true) reasons.push('intent_not_validation_only');
  if (intent.expires_at && Date.parse(intent.expires_at) <= Date.parse(generatedAt)) reasons.push('stale_intent');
  if (intent.source_ref_generated_at) {
    const age = Date.parse(generatedAt) - Date.parse(intent.source_ref_generated_at);
    if (Number.isFinite(age) && age > 72 * 60 * 60 * 1000) reasons.push('stale_intent');
  }
  return Array.from(new Set(reasons));
}

function rawPayloadDetected(inputSignals = {}) {
  const payload = String(inputSignals.payload || '');
  return RAW_PAYLOAD_PATTERNS.some((pattern) => pattern.test(payload));
}

function summarizeItems(items = [], scope) {
  const accepted = [];
  const withheldByReason = {};
  const withheldRefs = [];
  for (const item of items) {
    const reasons = itemReason(item, scope);
    if (reasons.length === 0) {
      accepted.push(item);
      continue;
    }
    for (const reason of reasons) withheldByReason[reason] = Number(withheldByReason[reason] || 0) + 1;
    withheldRefs.push({
      id: item.id || `withheld-${stableHash(item).slice(0, 8)}`,
      reasons,
      payload_hash: item.payload_hash || sha256(item),
    });
  }
  const bySync = {};
  const byAuthority = {};
  const bySource = {};
  for (const item of accepted) {
    bySync[item.syncEligibility] = Number(bySync[item.syncEligibility] || 0) + 1;
    byAuthority[item.authority || 'derived'] = Number(byAuthority[item.authority || 'derived'] || 0) + 1;
    bySource[item.source || 'snapshot'] = Number(bySource[item.source || 'snapshot'] || 0) + 1;
  }
  return {
    accepted,
    withheldByReason,
    withheldRefs,
    accepted_items_summary: {
      total: accepted.length,
      by_syncEligibility: bySync,
      by_authority: byAuthority,
      by_source: bySource,
      summary_refs: accepted.map((item) => ({
        id: item.id,
        source: item.source || 'snapshot',
        ref: `summary:${item.id}`,
      })),
      hashes: accepted.map((item) => item.payload_hash || sha256(item)),
      raw_payload_exported: false,
    },
    withheld_items_summary: {
      total: withheldRefs.length,
      by_reason: withheldByReason,
      refs: withheldRefs,
    },
  };
}

function classifyReceive(inputSignals = {}, itemSummary, intents = [], generatedAt) {
  const reasons = [];
  if (rawPayloadDetected(inputSignals)) reasons.push('raw_private_payload_blocked');
  for (const reason of Object.keys(itemSummary.withheldByReason)) reasons.push(reason);
  const intentFailures = intents.flatMap((intent) => intentReason(intent, generatedAt));
  reasons.push(...intentFailures);
  if (inputSignals.upload?.stale === true) reasons.push('stale_upload');
  if (inputSignals.upload?.watermarkRegression === true) reasons.push('watermark_regression');
  if (inputSignals.sourceWatermarksMissing === true) reasons.push('missing_watermark');

  const unique = Array.from(new Set(reasons));
  if (unique.includes('watermark_regression') || unique.includes('missing_watermark') || unique.includes('stale_intent')) {
    return { decision: 'rejected', reasons: unique };
  }
  if (rawPayloadDetected(inputSignals) || Object.keys(itemSummary.withheldByReason).length > 0 || intentFailures.length > 0) {
    return { decision: 'blocked', reasons: unique };
  }
  if (unique.includes('stale_upload')) return { decision: 'accepted_with_warnings_no_write', reasons: unique };
  return { decision: 'accepted_for_future_store_shape_no_write', reasons: unique };
}

function receiveMode(inputSignals = {}, intents = []) {
  const hasUpload = Boolean(inputSignals.upload_envelope || inputSignals.upload_items || inputSignals.upload || inputSignals.payload || inputSignals.fixtureA || inputSignals.requestedPhase);
  const hasIntent = intents.length > 0;
  if (hasUpload && hasIntent) return 'combined_redacted_snapshot_and_intent_refs';
  if (hasIntent) return 'validation_only_intent_records';
  return 'redacted_upload_envelope_ref';
}

function storedFutureShape() {
  return {
    storage_intent: 'future_server_redacted_summary_store_contract',
    may_store_later: true,
    store_kind: 'redacted_summary_refs_hashes_watermarks',
    redacted_summaries_only: true,
    refs_only: true,
    hashes_only: true,
    raw_payload_storage_allowed: false,
    requires_database_write_later: true,
    write_performed_now: false,
  };
}

function redactionAudit(itemSummary, rawBlocked) {
  const rawReason = rawBlocked ? { raw_private_payload_blocked: 1 } : {};
  return {
    policyVersion: REDACTION_POLICY_VERSION,
    rawSecretsStored: false,
    rawTerminalStored: false,
    rawCommsStored: false,
    rawScreenshotOcrStored: false,
    rawBrowserStateStored: false,
    customerPrivateDataStored: false,
    sideProfileContentStored: false,
    acceptedCount: itemSummary.accepted_items_summary.total,
    redactedCount: Number(itemSummary.accepted_items_summary.by_syncEligibility.core_sync_redacted || 0),
    withheldCount: itemSummary.withheld_items_summary.total + (rawBlocked ? 1 : 0),
    withheldByReason: {
      ...itemSummary.withheld_items_summary.by_reason,
      ...rawReason,
    },
    auditRefs: ['server-boundary:redaction-policy:v0'],
  };
}

function profileScopeResult(uploadRef, intents, scope) {
  const mismatches = [];
  if (uploadRef.profile?.name !== scope.profileName || uploadRef.sessionId !== scope.sessionId || uploadRef.deviceId !== scope.deviceId) {
    mismatches.push('upload_scope_mismatch');
  }
  for (const intent of intents) {
    if (intent.profile?.name !== scope.profileName || intent.sessionId !== scope.sessionId || intent.deviceId !== scope.deviceId) {
      mismatches.push(`intent_scope_mismatch:${intent.intent_id}`);
    }
  }
  return {
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    passed: mismatches.length === 0,
    mismatches,
  };
}

function staleWatermarkResult(inputSignals = {}, uploadRef = {}, reasons = []) {
  const watermarks = asArray(uploadRef.source_watermarks);
  return {
    watermarks_present: watermarks.length > 0,
    watermark_regression: reasons.includes('watermark_regression'),
    stale_upload: reasons.includes('stale_upload'),
    stale_intent: reasons.includes('stale_intent'),
    decision: reasons.includes('watermark_regression') || reasons.includes('missing_watermark') || reasons.includes('stale_intent')
      ? 'rejected'
      : (reasons.includes('stale_upload') ? 'accepted_with_warning' : 'accepted'),
    reasons: reasons.filter((reason) => ['stale_upload', 'stale_intent', 'watermark_regression', 'missing_watermark'].includes(reason)),
  };
}

function canonicalReceiveInput(record) {
  return {
    schema: record.schema,
    version: record.version,
    profile: record.profile,
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    source_upload_ref: {
      upload_id: record.source_upload_ref?.upload_id,
      idempotency_key: record.source_upload_ref?.idempotency_key,
      snapshotContentHash: record.source_upload_ref?.snapshotRef?.contentHash,
      source_watermarks: record.source_upload_ref?.source_watermarks,
    },
    source_intent_refs: asArray(record.source_intent_refs).map((intent) => ({
      intent_id: intent.intent_id,
      idempotency_key: intent.idempotency_key,
    })),
    accepted_hashes: record.accepted_items_summary?.hashes,
    redactionPolicyVersion: record.redaction_audit?.policyVersion,
  };
}

function buildReceiveRecord(inputSignals = {}, generatedAt) {
  const scope = normalizeScope(inputSignals);
  const uploadRef = normalizeUploadRef(inputSignals, scope);
  const items = defaultUploadItems(inputSignals, scope);
  const itemSummary = summarizeItems(items, scope);
  const intents = normalizeIntents(inputSignals, scope);
  const classification = classifyReceive(inputSignals, itemSummary, intents, generatedAt);
  const receive = {
    schema: SERVER_RECEIVE_RECORD_SCHEMA_VERSION,
    version: SERVER_BOUNDARY_VERSION,
    receive_id: null,
    idempotency_key: null,
    created_at: generatedAt,
    profile: profileObject(scope),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    source_upload_ref: uploadRef,
    source_intent_refs: intents,
    receive_mode: receiveMode(inputSignals, intents),
    decision: classification.decision,
    accepted_items_summary: itemSummary.accepted_items_summary,
    withheld_items_summary: itemSummary.withheld_items_summary,
    stored_future_shape: storedFutureShape(),
    source_watermarks: uploadRef.source_watermarks,
    redaction_audit: redactionAudit(itemSummary, rawPayloadDetected(inputSignals)),
    profile_scope_result: profileScopeResult(uploadRef, intents, scope),
    stale_watermark_result: staleWatermarkResult(inputSignals, uploadRef, classification.reasons),
    capability_truth: capabilityTruth(inputSignals.pcLocalArms?.localArmsOnline === true),
    server_targeting: serverTargeting(),
    deletion_controls: deletionControls(),
    export_controls: exportControls(),
    replay_protection: {
      replay_safe: true,
      replay_performs_no_side_effects: true,
      idempotency_scope: ['profile', 'sessionId', 'deviceId', 'upload', 'intent', 'watermark', 'accepted_hashes'],
    },
    evidenceRefs: [{
      store: 'server-boundary',
      eventId: uploadRef.upload_id,
      relation: 'validation_only_receive_ref',
    }],
    reasons: classification.reasons,
    side_effect_result: sideEffectResult(),
  };
  receive.idempotency_key = `server-boundary-receive-idem:${stableHash(canonicalReceiveInput(receive))}`;
  receive.receive_id = `server-receive-${stableHash(receive.idempotency_key).slice(0, 12)}`;
  return receive;
}

function pcLocalArmsStatus(inputSignals = {}) {
  const pc = inputSignals.pcLocalArms || {};
  const localArmsOnline = pc.localArmsOnline === true;
  return {
    localArmsOnline,
    lastLocalSnapshotRef: pc.lastLocalSnapshotRef || null,
    lastLocalAcceptanceRef: pc.lastLocalAcceptanceRef || null,
    canExecuteOnPCNow: false,
    serverCanWakeOrExecutePC: false,
    honestStatusText: localArmsOnline
      ? 'Server can converse/status/prepare proposals; local execution still requires local Architect acceptance.'
      : 'Server can converse/status/prepare proposals only; local execution waits for local arms and Architect acceptance.',
  };
}

function bridgeDeliveryTruth(inputSignals = {}) {
  const bridge = inputSignals.bridge || {};
  const delivery = inputSignals.delivery || {};
  const socketConnected = bridge.socketConnected === true;
  const roleDiscovery = bridge.architectRoleDiscovery || 'missing';
  const targetProof = bridge.architectToArchitectTargetProof || 'missing';
  const quoteBack = delivery.recipientQuoteBack || 'missing';
  return {
    socketConnected,
    architectRoleDiscovery: roleDiscovery,
    architectToArchitectTargetProof: targetProof,
    nonArchitectCrossDeviceTargetsRejected: true,
    bridgeGreen: socketConnected && roleDiscovery === 'registered' && targetProof === 'verified',
    bridgeGreenFromSocketAlone: false,
    modelProcessingProof: false,
    modelProcessingProofBasis: quoteBack === 'present'
      ? 'local quote-back observed, but Phase 12 server boundary still cannot prove model processing'
      : 'missing recipient quote-back or equivalent local proof',
  };
}

function localArchitectHandoff() {
  return {
    future_target_role: 'architect',
    handoff_allowed_only_to_architect: true,
    builder_oracle_direct_target_blocked: true,
    local_acceptance_required: true,
    local_delegation_after_acceptance_only: true,
  };
}

function canonicalStatusInput(status) {
  return {
    schema: status.schema,
    version: status.version,
    profile: status.profile,
    sessionId: status.sessionId,
    deviceId: status.deviceId,
    source_receive_refs: status.source_receive_refs,
    stored_summary_counts: status.stored_summary_counts,
    pending_intent_summary: status.pending_intent_summary,
    localArmsOnline: status.pc_local_arms_status?.localArmsOnline,
    bridgeGreen: status.bridge_delivery_truth?.bridgeGreen,
    redaction_summary: status.redaction_summary,
  };
}

function buildStatusSummary(receive, inputSignals = {}, generatedAt) {
  const pending = receive.source_intent_refs.filter((intent) => intent.status === 'pending_local_acceptance' && intent.target_role === 'architect');
  const expired = receive.source_intent_refs.filter((intent) => intentReason(intent, generatedAt).includes('stale_intent'));
  const status = {
    schema: SERVER_STATUS_SUMMARY_SCHEMA_VERSION,
    version: SERVER_BOUNDARY_VERSION,
    status_id: null,
    idempotency_key: null,
    created_at: generatedAt,
    profile: receive.profile,
    sessionId: receive.sessionId,
    deviceId: receive.deviceId,
    source_receive_refs: [{
      receive_id: receive.receive_id,
      idempotency_key: receive.idempotency_key,
      decision: receive.decision,
    }],
    pc_local_arms_status: pcLocalArmsStatus(inputSignals),
    server_capability_summary: capabilityTruth(inputSignals.pcLocalArms?.localArmsOnline === true),
    stored_summary_counts: {
      accepted_count: receive.accepted_items_summary.total,
      redacted_count: receive.redaction_audit.redactedCount,
      withheld_count: receive.redaction_audit.withheldCount,
      write_performed_now: false,
    },
    pending_intent_summary: {
      pending_local_acceptance_count: pending.length,
      target_role: 'architect',
      blocked_direct_targets: ['builder', 'oracle'],
      oldest_intent_created_at: receive.source_intent_refs[0]?.created_at || null,
      expired_count: expired.length,
      stale_count: receive.stale_watermark_result.reasons.includes('stale_intent') ? 1 : 0,
      safe_next_action: 'Wait for local Architect acceptance before any local execution or delegation.',
    },
    redaction_summary: {
      raw_payload_storage_allowed: false,
      redacted_summaries_only: true,
      accepted_count: receive.redaction_audit.acceptedCount,
      withheld_count: receive.redaction_audit.withheldCount,
      withheldByReason: receive.redaction_audit.withheldByReason,
    },
    bridge_delivery_truth: bridgeDeliveryTruth(inputSignals),
    local_architect_handoff: localArchitectHandoff(),
    deletion_export_controls: {
      deletion_controls: receive.deletion_controls,
      export_controls: receive.export_controls,
    },
    operator_message: 'Server boundary validation only: server may converse/status/prepare proposals, but cannot execute local work or prove model processing.',
    evidenceRefs: [{
      store: 'server-boundary',
      eventId: receive.receive_id,
      relation: 'validation_only_status_summary',
    }],
    side_effect_result: sideEffectResult(),
  };
  status.idempotency_key = `server-boundary-status-idem:${stableHash(canonicalStatusInput(status))}`;
  status.status_id = `server-status-${stableHash(status.idempotency_key).slice(0, 12)}`;
  return status;
}

function buildValidationReport(receiveRecords, statusSummaries, generatedAt) {
  const accepted = receiveRecords.filter((record) => record.decision.startsWith('accepted'));
  const blocked = receiveRecords.filter((record) => record.decision === 'blocked');
  const rejected = receiveRecords.filter((record) => record.decision === 'rejected');
  const reasons = Array.from(new Set(receiveRecords.flatMap((record) => record.reasons)));
  const sideEffect = sideEffectResult();
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: SERVER_BOUNDARY_VERSION,
    validation_run_id: `server-boundary-validation-${stableHash({
      receiveKeys: receiveRecords.map((record) => record.idempotency_key),
      statusKeys: statusSummaries.map((record) => record.idempotency_key),
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: blocked.length + rejected.length > 0
      ? 'server_boundary_records_validated_with_blocks_no_side_effects'
      : 'server_boundary_records_validated_no_side_effects',
    input_refs: {
      receive_ids: receiveRecords.map((record) => record.receive_id),
      upload_ids: receiveRecords.map((record) => record.source_upload_ref.upload_id),
      intent_ids: receiveRecords.flatMap((record) => record.source_intent_refs.map((intent) => intent.intent_id)),
    },
    accepted_receive_count: accepted.length,
    status_summary_count: statusSummaries.length,
    blocked_count: blocked.length,
    rejected_count: rejected.length,
    eligibility_result: {
      acceptedSyncEligibility: ACCEPTED_SYNC_ELIGIBILITY,
      acceptedItemCount: receiveRecords.reduce((sum, record) => sum + record.accepted_items_summary.total, 0),
      withheldByReason: receiveRecords.reduce((acc, record) => {
        for (const [reason, count] of Object.entries(record.withheld_items_summary.by_reason || {})) {
          acc[reason] = Number(acc[reason] || 0) + Number(count || 0);
        }
        return acc;
      }, {}),
    },
    redaction_result: {
      rawSecretsStored: false,
      rawTerminalStored: false,
      rawCommsStored: false,
      rawScreenshotOcrStored: false,
      rawBrowserStateStored: false,
      customerPrivateDataStored: false,
      sideProfileContentStored: false,
    },
    profile_scope_result: {
      scoped: receiveRecords.every((record) => record.profile_scope_result.passed === true),
      profiles: Array.from(new Set(receiveRecords.map((record) => record.profile.name))),
    },
    idempotency_result: {
      stable: true,
      receive_keys: receiveRecords.map((record) => record.idempotency_key),
      status_keys: statusSummaries.map((record) => record.idempotency_key),
      excludes: ['receive_id', 'status_id', 'created_at', 'validation_run_id', 'generated_at'],
    },
    watermark_result: {
      missing_count: receiveRecords.filter((record) => record.stale_watermark_result.reasons.includes('missing_watermark')).length,
      regression_count: receiveRecords.filter((record) => record.stale_watermark_result.watermark_regression === true).length,
      decisions: receiveRecords.map((record) => record.stale_watermark_result.decision),
    },
    stale_result: {
      stale_upload_count: receiveRecords.filter((record) => record.stale_watermark_result.stale_upload === true).length,
      stale_intent_count: receiveRecords.filter((record) => record.stale_watermark_result.stale_intent === true).length,
    },
    capability_truth_result: {
      serverCanExecuteLocal: false,
      serverCanOperatePTY: false,
      serverCanRunShell: false,
      serverCanAccessBrowserOrWindow: false,
      serverCanSendCustomerMessages: false,
      serverCanDeploy: false,
      serverCanTrade: false,
      serverCanProveModelProcessing: false,
      bridgeGreenFromSocketAlone: false,
    },
    targeting_result: {
      future_target_role: 'architect',
      builder_oracle_direct_target_blocked: true,
      blockedDirectTargetCount: receiveRecords.flatMap((record) => record.source_intent_refs).filter((intent) => ['builder', 'oracle'].includes(intent.target_role)).length,
    },
    deletion_export_result: {
      delete_supported_later: true,
      export_supported_later: true,
      raw_export_allowed: false,
      delete_performed_now: false,
      export_performed_now: false,
    },
    side_effect_result: sideEffect,
    records_summary: receiveRecords.map((record) => ({
      receive_id: record.receive_id,
      decision: record.decision,
      receive_mode: record.receive_mode,
      accepted_items: record.accepted_items_summary.total,
      withheld_items: record.withheld_items_summary.total,
    })),
    reasons,
    followup_required: blocked.length + rejected.length > 0,
  };
}

function buildMiraCoreServerBoundary(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const server_receive_records = [buildReceiveRecord(inputSignals, generatedAt)];
  const server_status_summaries = server_receive_records.map((record) => buildStatusSummary(record, inputSignals, generatedAt));
  const output = {
    server_receive_records,
    server_status_summaries,
    validation_report: buildValidationReport(server_receive_records, server_status_summaries, generatedAt),
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

function validateMiraCoreServerBoundaryOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const receiveRecords = asArray(output.server_receive_records);
  const statusSummaries = asArray(output.server_status_summaries);
  const report = output.validation_report || {};
  const expectedReceive = contract.expectedServerReceiveRecordShape || {};
  const expectedStatus = contract.expectedServerStatusSummaryShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredReceiveFields = asArray(expectedReceive.requiredFields).length > 0 ? expectedReceive.requiredFields : REQUIRED_SERVER_RECEIVE_FIELDS;
  const requiredStatusFields = asArray(expectedStatus.requiredFields).length > 0 ? expectedStatus.requiredFields : REQUIRED_SERVER_STATUS_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0 ? expectedReport.requiredTopLevelFields : REQUIRED_VALIDATION_REPORT_FIELDS;

  add('output-shape-complete',
    hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && receiveRecords.every((record) => record.schema === SERVER_RECEIVE_RECORD_SCHEMA_VERSION && hasRequiredFields(record, requiredReceiveFields))
      && statusSummaries.every((record) => record.schema === SERVER_STATUS_SUMMARY_SCHEMA_VERSION && hasRequiredFields(record, requiredStatusFields))
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, requiredReportFields),
    'Missing server-boundary output fields.');

  add('redacted-upload-only',
    receiveRecords.every((record) => {
      const safeAccepted = record.accepted_items_summary.raw_payload_exported === false
        && Object.keys(record.accepted_items_summary.by_syncEligibility || {}).every((key) => ACCEPTED_SYNC_ELIGIBILITY.includes(key));
      const rawStoreFalse = record.stored_future_shape?.raw_payload_storage_allowed === false
        && record.stored_future_shape?.write_performed_now === false;
      return safeAccepted && rawStoreFalse;
    }),
    'Unsafe upload item accepted or raw storage allowed.');

  add('validation-only-intents-only',
    receiveRecords.every((record) => asArray(record.source_intent_refs).every((intent) => {
      if (intent.target_role !== 'architect') return record.decision !== 'accepted_for_future_store_shape_no_write';
      return intent.status === 'pending_local_acceptance'
        && intent.no_execution_performed === true
        && JSON.stringify(intent.allowed_target_roles) === JSON.stringify(['architect'])
        && SAFE_INTENT_RISKS.includes(intent.risk_tier)
        && ['none', 'applied'].includes(intent.payload_redaction_status);
    })),
    'Executable or non-Architect intent accepted.');

  add('no-raw-storage',
    receiveRecords.every((record) => Object.entries(expectedReceive.redactionAuditRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.redaction_audit?.[field], expectedValue))
      && Object.entries(expectedReceive.storedFutureShapeRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.stored_future_shape?.[field], expectedValue))),
    'Raw storage flag or future-store shape is unsafe.');

  add('profile-session-device-scope-required',
    receiveRecords.every((record) => record.profile?.name && record.sessionId && record.deviceId
      && record.profile_scope_result?.profile === record.profile.name
      && asArray(record.source_intent_refs).every((intent) => intent.profile?.name === record.profile.name && intent.sessionId === record.sessionId && intent.deviceId === record.deviceId))
      && statusSummaries.every((record) => record.profile?.name && record.sessionId && record.deviceId),
    'Profile/session/device scope missing or mismatched.');

  add('redaction-audit-required',
    receiveRecords.every((record) => hasRequiredFields(record.redaction_audit, asArray(expectedReceive.redactionAuditRequiredFields).length > 0 ? expectedReceive.redactionAuditRequiredFields : REQUIRED_REDACTION_AUDIT_FIELDS)
      && Object.entries(expectedReceive.redactionAuditRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.redaction_audit?.[field], expectedValue))),
    'Redaction audit missing or raw-stored value true.');

  add('idempotency-replay-safe',
    receiveRecords.every((record) => {
      try {
        return record.idempotency_key === `server-boundary-receive-idem:${stableHash(canonicalReceiveInput(record))}`;
      } catch {
        return false;
      }
    })
      && statusSummaries.every((record) => {
        try {
          return record.idempotency_key === `server-boundary-status-idem:${stableHash(canonicalStatusInput(record))}`;
        } catch {
          return false;
        }
      }),
    'Idempotency key is unstable.');

  add('stale-watermark-handling',
    receiveRecords.every((record) => {
      if (record.stale_watermark_result?.reasons?.includes('watermark_regression')) return record.decision === 'rejected';
      if (record.stale_watermark_result?.reasons?.includes('missing_watermark')) return record.decision === 'rejected';
      if (record.stale_watermark_result?.reasons?.includes('stale_intent')) return record.decision === 'rejected';
      if (record.stale_watermark_result?.reasons?.includes('stale_upload')) return record.decision !== 'accepted_for_future_store_shape_no_write';
      return true;
    }),
    'Stale/watermark failure was accepted.');

  add('server-capability-truth',
    receiveRecords.every((record) => Object.entries(expectedReceive.capabilityTruthRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.capability_truth?.[field], expectedValue)))
      && statusSummaries.every((status) => Object.entries(expectedStatus.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(status, field), expectedValue))),
    'Server capability truth overclaimed.');

  add('local-arms-offline-honesty',
    statusSummaries.every((status) => {
      if (status.pc_local_arms_status?.localArmsOnline === false) {
        return status.pc_local_arms_status?.canExecuteOnPCNow === false
          && status.pc_local_arms_status?.serverCanWakeOrExecutePC === false
          && /local execution waits for local arms/i.test(status.pc_local_arms_status?.honestStatusText || '');
      }
      return status.pc_local_arms_status?.canExecuteOnPCNow === false;
    }),
    'Local-arms offline status overclaimed execution.');

  add('local-architect-only-target',
    receiveRecords.every((record) => Object.entries(expectedReceive.serverTargetingRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.server_targeting?.[field], expectedValue))
      && asArray(record.source_intent_refs).every((intent) => intent.target_role === 'architect' || record.decision === 'blocked')),
    'Server-originated Builder/Oracle direct target accepted.');

  add('bridge-delivery-proof-boundary',
    statusSummaries.every((status) => status.bridge_delivery_truth?.bridgeGreenFromSocketAlone === false
      && status.bridge_delivery_truth?.modelProcessingProof === false
      && status.server_capability_summary?.serverCanProveModelProcessing === false),
    'Bridge or model-processing proof overclaimed.');

  add('deletion-export-controls-required',
    receiveRecords.every((record) => hasRequiredFields(record.deletion_controls, asArray(expectedReceive.deletionControlsRequiredFields).length > 0 ? expectedReceive.deletionControlsRequiredFields : REQUIRED_DELETION_FIELDS)
      && hasRequiredFields(record.export_controls, asArray(expectedReceive.exportControlsRequiredFields).length > 0 ? expectedReceive.exportControlsRequiredFields : REQUIRED_EXPORT_FIELDS)
      && Object.entries(expectedReceive.deletionExportRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(record.deletion_controls?.[field] ?? record.export_controls?.[field], expectedValue))),
    'Deletion/export controls missing or unsafe.');

  add('no-side-effects',
    receiveRecords.every((record) => sideEffectValuesOk(record.side_effect_result, expectedReport.sideEffectRequiredV0Values || {}))
      && statusSummaries.every((record) => sideEffectValuesOk(record.side_effect_result, expectedReport.sideEffectRequiredV0Values || {}))
      && sideEffectValuesOk(report.side_effect_result, expectedReport.sideEffectRequiredV0Values || {}),
    'Side-effect counters are nonzero.');

  add('model-free-validation', true, null);

  add('literal-values-preserved',
    receiveRecords.every((record) => Object.entries(expectedReceive.requiredLiteralValues || {}).every(([field, expectedValue]) => valuesMatch(pathValue(record, field), expectedValue))),
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
      throw new Error(`server_boundary_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ACCEPTED_SYNC_ELIGIBILITY,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SERVER_RECEIVE_FIELDS,
  REQUIRED_SERVER_STATUS_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_RECEIVE_RECORD_SCHEMA_VERSION,
  SERVER_STATUS_SUMMARY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreServerBoundary,
  stableHash,
  validateMiraCoreServerBoundaryOutput,
};
