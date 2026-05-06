'use strict';

const crypto = require('crypto');

const RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_run_review_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_run_review_validation_report.v0';
const RUNTIME_DRY_RUN_REVIEW_VERSION = 'v0';
const BASELINE_COMMIT = 'e7a8dbc';
const PHASE27_COMMIT = 'e7a8dbc';
const CANDIDATE_SLICE_ID = 'runtime_slice_0_local_in_process_status_only';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_dry_run_review_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'review_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_27_dependency',
  'decision',
  'decision_allowed_values',
  'eligible_is_authorization',
  'eligible_is_runtime_proof',
  'phase29_prerequisites',
  'safe_first_slice_constraints',
  'proof_boundaries',
  'blocked_side_effects',
  'tamper_case_coverage',
  'next_safe_actions',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'report_id',
  'generated_at',
  'baseline_commit',
  'decision',
  'reasons',
  'phase27_dependency_result',
  'decision_result',
  'phase29_prerequisites_result',
  'safe_first_slice_constraints_result',
  'proof_boundary_result',
  'side_effect_result',
  'acceptance_checks',
  'failed_checks',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_performed',
  'no_server_performed',
  'no_listener_or_route_bound',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_change_performed',
  'no_key_secret_operation_performed',
  'no_local_execution_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeAttempts',
  'serverAttempts',
  'listenerRouteAttempts',
  'networkRequestsAttempted',
  'databaseWritesAttempted',
  'storeWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'leasesCreated',
  'authChangesAttempted',
  'keySecretOperationsAttempted',
  'localExecutionAttempted',
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const DEFAULT_DECISIONS = Object.freeze([
  'remain_pre_runtime_review',
  'blocked',
  'eligible_for_phase29_disabled_local_dry_run_implementation',
]);

const PHASE27_GATE_IDS = Object.freeze([
  'no-real-runtime-mode-implementation',
  'no-live-kill-switch-wiring',
  'no-tested-dry-run-runtime-path',
  'no-actual-local-only-binding-implementation',
  'no-real-telemetry-audit-sink',
  'no-storage-path-env-config-key-auth-binding',
  'no-operator-ui-status-surface',
  'no-rollback-exercise',
  'no-full-end-to-end-runtime-proof',
]);

const DEFAULT_PHASE29_PREREQUISITE_IDS = Object.freeze([
  'runtime-mode-flag-implementation',
  'live-kill-switch-wiring',
  'tested-dry-run-runtime-path',
  'actual-local-only-binding',
  'telemetry-audit-sink',
  'storage-env-config-key-auth-refs',
  'operator-ui-status-surface',
  'rollback-exercise',
  'end-to-end-runtime-proof',
]);

const DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS = Object.freeze([
  'disabled-by-default',
  'dev-only',
  'local-in-process-or-loopback-only',
  'no-listener-unless-separately-gated',
  'kill-switch-fail-closed',
  'dry-run-no-side-effects',
  'redacted-telemetry-preview',
  'operator-visible-status',
  'rollback-disable-plan',
]);

const DEFAULT_BLOCKED_SIDE_EFFECT_IDS = Object.freeze([
  'runtime',
  'server-listener-routes',
  'network',
  'db-store-file-migration',
  'queue-lease',
  'auth-key-secret',
  'local-execution-shell-pty-browser',
  'send-deploy-trade-customer',
  'output-file',
]);

const DEFAULT_NEXT_SAFE_ACTION_IDS = Object.freeze([
  'implement-phase28-validator-only',
  'draft-phase29-disabled-local-dry-run-implementation-contract',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-stale-baseline',
  'tamper-stale-phase27-dependency',
  'tamper-eligible-as-authorization',
  'tamper-missing-kill-switch',
  'tamper-missing-rollback',
  'tamper-missing-audit',
  'tamper-network-listener-overclaim',
  'tamper-local-execution-shell-pty',
  'tamper-queue-lease-store-write',
  'tamper-customer-send-deploy-trade',
  'tamper-raw-secret-path-private-leak',
  'tamper-fake-proof',
  'tamper-missing-carried-forward-gate',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime authorized',
  'runtime available now',
  'runtime started',
  'eligible authorizes runtime',
  'eligible proves runtime',
  'phase29 authorized',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
  'public interface allowed',
  '0.0.0.0',
  'port opened',
  'port bound',
  'database write performed',
  'store write performed',
  'file write performed',
  'migration executed',
  'queue created',
  'lease created',
  'auth changed',
  'key generated',
  'secret read',
  'env secret read',
  'raw path',
  'local execution performed',
  'shell executed',
  'pty executed',
  'browser state captured',
  'screenshot captured',
  'ocr captured',
  'memory committed',
  'profile committed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'money moved',
  'output file written',
  'preflight proves runtime',
  'config proves runtime',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'server can execute local arms',
  'direct builder target allowed',
  'direct oracle target allowed',
  'raw terminal scrollback',
  'raw browser state',
  'raw screenshot',
  'raw ocr',
  'raw customer private',
  'side-profile payload',
  'source-store payload',
  'bearer token',
  'session secret',
  'auth secret value',
  'private key',
  'data key',
  'plaintext payload',
  'ciphertext payload',
  'decrypted payload',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortedValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedValue(value))).digest('hex');
}

function pathValue(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((acc, key) => (
    acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
  ), value);
}

function valuesMatch(a, b) {
  return JSON.stringify(sortedValue(a)) === JSON.stringify(sortedValue(b));
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
}

function evidenceRef(store, eventId, relation = 'runtime_dry_run_review_validation') {
  return { store, eventId, relation };
}

function normalizeScope(inputSignals = {}) {
  const profile = inputSignals.profile || {};
  const profileName = inputSignals.profileName || profile.name || 'main';
  return {
    profile: {
      name: profileName,
      sessionScopeId: profile.sessionScopeId || profileName,
      windowKey: profile.windowKey || profileName,
    },
    sessionId: inputSignals.sessionId || 'session-328',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  if (options.generatedAt) return options.generatedAt;
  if (inputSignals.generatedAt) return inputSignals.generatedAt;
  if (typeof options.nowMs === 'number') return new Date(options.nowMs).toISOString();
  return new Date().toISOString();
}

function reviewExpected(contract = {}) {
  return contract.expectedRuntimeDryRunReviewReportShape || {};
}

function decisionValues(contract = {}) {
  return asArray(reviewExpected(contract).decisionAllowedValues).length > 0
    ? reviewExpected(contract).decisionAllowedValues
    : DEFAULT_DECISIONS;
}

function prerequisiteIds(contract = {}) {
  return asArray(reviewExpected(contract).phase29PrerequisiteRequiredIds).length > 0
    ? reviewExpected(contract).phase29PrerequisiteRequiredIds
    : DEFAULT_PHASE29_PREREQUISITE_IDS;
}

function safeConstraintIds(contract = {}) {
  return asArray(reviewExpected(contract).safeFirstSliceConstraintRequiredIds).length > 0
    ? reviewExpected(contract).safeFirstSliceConstraintRequiredIds
    : DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS;
}

function blockedSideEffectIds(contract = {}) {
  return asArray(reviewExpected(contract).blockedSideEffectRequiredIds).length > 0
    ? reviewExpected(contract).blockedSideEffectRequiredIds
    : DEFAULT_BLOCKED_SIDE_EFFECT_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(reviewExpected(contract).nextSafeActionRequiredIds).length > 0
    ? reviewExpected(contract).nextSafeActionRequiredIds
    : DEFAULT_NEXT_SAFE_ACTION_IDS;
}

function sideEffectResult() {
  return {
    no_runtime_performed: true,
    no_server_performed: true,
    no_listener_or_route_bound: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
    no_auth_change_performed: true,
    no_key_secret_operation_performed: true,
    no_local_execution_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_output_file_written: true,
    runtimeAttempts: 0,
    serverAttempts: 0,
    listenerRouteAttempts: 0,
    networkRequestsAttempted: 0,
    databaseWritesAttempted: 0,
    storeWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    leasesCreated: 0,
    authChangesAttempted: 0,
    keySecretOperationsAttempted: 0,
    localExecutionAttempted: 0,
    sendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFilesWritten: 0,
    outputFileWritten: false,
  };
}

function phase27Dependency() {
  return {
    phase: 'phase_27_runtime_slice_0_preflight_readiness',
    commit: PHASE27_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-preflight-contract.json',
    module_path: 'ui/modules/mira-core/runtime-preflight.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-preflight.js',
    test_path: 'ui/__tests__/mira-core-runtime-preflight.test.js',
    status: 'committed_validation_only',
    default_decision: 'remain_validation_only',
    candidate_slice_id: CANDIDATE_SLICE_ID,
    runtime_available_now: false,
    non_authorizing: true,
    unsatisfied_gate_count: 9,
    evidenceRefs: [
      evidenceRef('git', PHASE27_COMMIT, 'phase27_commit'),
      evidenceRef('mira-core-runtime-preflight', 'phase27-preflight'),
    ],
  };
}

function phase29Prerequisites(contract = {}) {
  const fixtureMap = new Map(asArray(reviewExpected(contract).phase29PrerequisiteMap)
    .map((item) => [item.prerequisite_id, item.maps_from_phase27_gate]));
  return prerequisiteIds(contract).map((prerequisiteId, index) => ({
    prerequisite_id: prerequisiteId,
    maps_from_phase27_gate: fixtureMap.get(prerequisiteId) || PHASE27_GATE_IDS[index],
    status: 'unsatisfied',
    required_for_phase29: true,
    blocks_runtime_now: true,
    acceptance_evidence_required: 'Evidence remains pending for Phase 29 review.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', `phase29-prerequisite:${prerequisiteId}`),
    ],
  }));
}

function safeFirstSliceConstraints(contract = {}) {
  return safeConstraintIds(contract).map((constraintId) => ({
    constraint_id: constraintId,
    required: true,
    non_authorizing: true,
    blocks_runtime_now: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', `safe-first-slice:${constraintId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    preflight_ready_is_runtime_proof: false,
    config_present_is_runtime_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    serverCanExecuteLocal: false,
    server_can_execute_local_arms: false,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', 'proof-boundaries'),
    ],
  };
}

function blockedSideEffects(contract = {}) {
  return blockedSideEffectIds(contract).map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', `blocked-effect:${effectId}`),
    ],
  }));
}

function tamperCaseCoverage(contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const ids = fixtureCases.length > 0 ? fixtureCases.map((item) => item.id) : DEFAULT_TAMPER_CASE_IDS;
  return ids.map((caseId) => ({
    tamper_case_id: caseId,
    covered: true,
    expected_failure_checks: clone(fixtureCases.find((item) => item.id === caseId)?.expected_failure_checks || []),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase28-validator-only': 'Finish the Phase 28 validator',
    'draft-phase29-disabled-local-dry-run-implementation-contract': 'Draft the Phase 29 contract',
  };
  const reasons = {
    'implement-phase28-validator-only': 'This only checks review metadata and boundary truth.',
    'draft-phase29-disabled-local-dry-run-implementation-contract': 'This prepares a future contract review without enabling behavior.',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: reasons[actionId] || 'This is read-only review metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalReviewReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_27_dependency: report.phase_27_dependency,
    decision: report.decision,
    decision_allowed_values: report.decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    eligible_is_runtime_proof: report.eligible_is_runtime_proof,
    phase29_prerequisites: report.phase29_prerequisites,
    safe_first_slice_constraints: report.safe_first_slice_constraints,
    proof_boundaries: report.proof_boundaries,
    blocked_side_effects: report.blocked_side_effects,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeDryRunReviewIdempotencyKey(report) {
  return `runtime-dry-run-review:${stableHash(canonicalReviewReportInput(report))}`;
}

function buildReviewReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const allowed = decisionValues(contract);
  const requestedDecision = inputSignals.decision;
  const decision = allowed.includes(requestedDecision)
    ? requestedDecision
    : (reviewExpected(contract).requiredDefaultDecision || 'remain_pre_runtime_review');
  const report = {
    schema: RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUN_REVIEW_VERSION,
    review_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_27_dependency: phase27Dependency(),
    decision,
    decision_allowed_values: allowed,
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    phase29_prerequisites: phase29Prerequisites(contract),
    safe_first_slice_constraints: safeFirstSliceConstraints(contract),
    proof_boundaries: proofBoundaries(),
    blocked_side_effects: blockedSideEffects(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', 'phase28-review-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase28_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeDryRunReviewIdempotencyKey(report);
  report.review_report_id = `runtime-dry-run-review-${stableHash(report.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function resultObject(ok, detail = null, extra = {}) {
  return {
    ok: ok === true,
    detail,
    ...extra,
  };
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => value[field] === undefined || Number(value[field]) === 0)
    && value.outputFileWritten !== true;
}

function phase27DependencyOk(report, contract = {}) {
  const dependency = report.phase_27_dependency || {};
  const expected = reviewExpected(contract);
  return hasRequiredFields(dependency, expected.phase27DependencyRequiredFields || [])
    && Object.entries(expected.phase27DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.fixture_path === 'ui/__tests__/fixtures/mira-core-runtime-preflight-contract.json'
    && dependency.module_path === 'ui/modules/mira-core/runtime-preflight.js'
    && dependency.cli_path === 'ui/scripts/hm-mira-core-runtime-preflight.js'
    && dependency.test_path === 'ui/__tests__/mira-core-runtime-preflight.test.js'
    && dependency.commit === PHASE27_COMMIT
    && dependency.status === 'committed_validation_only'
    && dependency.default_decision === 'remain_validation_only'
    && dependency.candidate_slice_id === CANDIDATE_SLICE_ID
    && dependency.runtime_available_now === false
    && dependency.non_authorizing === true
    && dependency.unsatisfied_gate_count === 9
    && asArray(dependency.evidenceRefs).length > 0;
}

function decisionOk(report, contract = {}) {
  const allowed = decisionValues(contract);
  const eligibleSafe = report.decision !== 'eligible_for_phase29_disabled_local_dry_run_implementation'
    || (report.eligible_is_authorization === false
      && report.eligible_is_runtime_proof === false
      && report.phase_27_dependency?.runtime_available_now === false
      && sideEffectValuesOk(report.side_effect_result));
  return valuesMatch(report.decision_allowed_values, allowed)
    && allowed.includes(report.decision)
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && eligibleSafe;
}

function defaultDecisionOk(report, contract = {}) {
  return report.decision === (reviewExpected(contract).requiredDefaultDecision || 'remain_pre_runtime_review')
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false;
}

function phase29PrerequisitesOk(report, contract = {}) {
  const prerequisites = asArray(report.phase29_prerequisites);
  const ids = prerequisiteIds(contract);
  const expectedFields = reviewExpected(contract).phase29PrerequisiteRequiredFields || [];
  const expectedMap = new Map(asArray(reviewExpected(contract).phase29PrerequisiteMap)
    .map((item) => [item.prerequisite_id, item.maps_from_phase27_gate]));
  return prerequisites.length === ids.length
    && idsEqual(prerequisites, 'prerequisite_id', ids)
    && prerequisites.every((item) => hasRequiredFields(item, expectedFields)
      && item.maps_from_phase27_gate === (expectedMap.get(item.prerequisite_id) || PHASE27_GATE_IDS[ids.indexOf(item.prerequisite_id)])
      && item.status === 'unsatisfied'
      && item.required_for_phase29 === true
      && item.blocks_runtime_now === true
      && typeof item.acceptance_evidence_required === 'string'
      && asArray(item.evidenceRefs).length > 0);
}

function safeFirstSliceConstraintsOk(report, contract = {}) {
  const constraints = asArray(report.safe_first_slice_constraints);
  const ids = safeConstraintIds(contract);
  const expectedFields = reviewExpected(contract).safeFirstSliceConstraintRequiredFields || [];
  return constraints.length === ids.length
    && idsEqual(constraints, 'constraint_id', ids)
    && constraints.every((item) => hasRequiredFields(item, expectedFields)
      && item.required === true
      && item.non_authorizing === true
      && item.blocks_runtime_now === true
      && asArray(item.evidenceRefs).length > 0);
}

function killRollbackAuditOk(report) {
  const prerequisiteIdsPresent = new Set(asArray(report.phase29_prerequisites).map((item) => item.prerequisite_id));
  const constraintIdsPresent = new Set(asArray(report.safe_first_slice_constraints).map((item) => item.constraint_id));
  return prerequisiteIdsPresent.has('live-kill-switch-wiring')
    && prerequisiteIdsPresent.has('rollback-exercise')
    && prerequisiteIdsPresent.has('telemetry-audit-sink')
    && constraintIdsPresent.has('kill-switch-fail-closed')
    && constraintIdsPresent.has('rollback-disable-plan')
    && constraintIdsPresent.has('redacted-telemetry-preview');
}

function disabledDevLocalConstraintsOk(report) {
  const ids = new Set(asArray(report.safe_first_slice_constraints).map((item) => item.constraint_id));
  return ids.has('disabled-by-default')
    && ids.has('dev-only')
    && ids.has('local-in-process-or-loopback-only')
    && ids.has('no-listener-unless-separately-gated');
}

function proofBoundariesOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = reviewExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.preflight_ready_is_runtime_proof === false
    && proof.config_present_is_runtime_proof === false
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.serverCanExecuteLocal === false
    && proof.server_can_execute_local_arms === false
    && proof.builder_direct_server_target_allowed === false
    && proof.oracle_direct_server_target_allowed === false;
}

function blockedSideEffectsOk(report, contract = {}) {
  const effects = asArray(report.blocked_side_effects);
  const ids = blockedSideEffectIds(contract);
  return effects.length === ids.length
    && idsEqual(effects, 'effect_id', ids)
    && effects.every((effect) => effect.blocked_now === true
      && Number(effect.attempts || 0) === 0
      && asArray(effect.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function effectsById(report) {
  return new Map(asArray(report.blocked_side_effects).map((item) => [item.effect_id, item]));
}

function effectSafe(effectMap, effectId) {
  const effect = effectMap.get(effectId);
  return Boolean(effect) && effect.blocked_now === true && Number(effect.attempts || 0) === 0;
}

function hasAnyForbiddenString(value, forbidden) {
  const strings = collectStringValues(value);
  return strings.some((entry) => forbidden.some((item) => item && entry.includes(item)));
}

function networkListenerOk(report) {
  const effects = effectsById(report);
  return report.side_effect_result?.no_server_performed === true
    && report.side_effect_result?.no_listener_or_route_bound === true
    && report.side_effect_result?.no_network_performed === true
    && effectSafe(effects, 'server-listener-routes')
    && effectSafe(effects, 'network')
    && !hasAnyForbiddenString(report, [
      'server started',
      'listener bound',
      'route registered',
      'http server listening',
      'websocket listening',
      'network request performed',
      'public interface allowed',
      '0.0.0.0',
      'port opened',
      'port bound',
    ]);
}

function localExecutionOk(report) {
  const effects = effectsById(report);
  return report.side_effect_result?.no_local_execution_performed === true
    && effectSafe(effects, 'local-execution-shell-pty-browser')
    && !hasAnyForbiddenString(report, [
      'local execution performed',
      'shell executed',
      'pty executed',
      'browser state captured',
      'screenshot captured',
      'ocr captured',
    ]);
}

function queueLeaseStoreOk(report) {
  const effects = effectsById(report);
  return report.side_effect_result?.no_database_write_performed === true
    && report.side_effect_result?.no_store_write_performed === true
    && report.side_effect_result?.no_file_write_performed === true
    && report.side_effect_result?.no_migration_executed === true
    && report.side_effect_result?.no_queue_created === true
    && report.side_effect_result?.no_lease_created === true
    && report.side_effect_result?.no_output_file_written === true
    && effectSafe(effects, 'db-store-file-migration')
    && effectSafe(effects, 'queue-lease')
    && effectSafe(effects, 'output-file')
    && !hasAnyForbiddenString(report, [
      'database write performed',
      'store write performed',
      'file write performed',
      'migration executed',
      'queue created',
      'lease created',
      'output file written',
    ]);
}

function tamperCoverageOk(report, contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const ids = fixtureCases.length > 0 ? fixtureCases.map((item) => item.id) : DEFAULT_TAMPER_CASE_IDS;
  const coverage = asArray(report.tamper_case_coverage);
  return coverage.length === ids.length
    && idsEqual(coverage, 'tamper_case_id', ids)
    && coverage.every((item) => item.covered === true && asArray(item.evidenceRefs).length > 0);
}

function nextSafeActionsOk(report, contract = {}) {
  const actions = asArray(report.next_safe_actions);
  const ids = nextSafeActionIds(contract);
  return actions.length === ids.length
    && idsEqual(actions, 'action_id', ids)
    && actions.every((action) => action.allowed === true
      && /^tier[01]_/.test(action.risk_tier)
      && typeof action.why_safe === 'string'
      && asArray(action.evidenceRefs).length > 0);
}

function unsafeActionDriftOk(report) {
  const unsafePattern = /\b(tier[234]|runtime authorized|deploy|trade|money|send-to-customer|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const hasOutboundRecipientIntent = (text) => {
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.some((token) => outboundTerms.has(token))
      && tokens.some((token) => recipientTerms.has(token));
  };
  return asArray(report.next_safe_actions).every((action) => (
    action.allowed === true
      && !unsafePattern.test(String(action.risk_tier || ''))
      && !unsafePattern.test(String(action.why_safe || ''))
      && !unsafePattern.test(String(action.title || ''))
      && !hasOutboundRecipientIntent(action.risk_tier)
      && !hasOutboundRecipientIntent(action.why_safe)
      && !hasOutboundRecipientIntent(action.title)
  ));
}

function collectStringValues(value, acc = []) {
  if (typeof value === 'string') {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    if (strings.some((entry) => entry.includes(forbidden))) {
      throw new Error(`runtime_dry_run_review_forbidden_substring:${forbidden}`);
    }
  }
}

function validateReviewReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = reviewExpected(contract);

  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const dependencyOk = phase27DependencyOk(report, contract);
  const decisionSafe = decisionOk(report, contract);
  const defaultDecisionSafe = defaultDecisionOk(report, contract);
  const prerequisitesSafe = phase29PrerequisitesOk(report, contract);
  const constraintsSafe = safeFirstSliceConstraintsOk(report, contract);
  const killRollbackAuditSafe = killRollbackAuditOk(report);
  const proofSafe = proofBoundariesOk(report, contract);
  const effectsSafe = blockedSideEffectsOk(report, contract);
  const nextActionsSafe = nextSafeActionsOk(report, contract);
  const unsafeDriftSafe = unsafeActionDriftOk(report);

  add('output-shape-complete',
    report.schema === RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime dry-run review report shape is incomplete.');
  add('baseline-e7a8dbc-pinned', baselineOk, 'Baseline commit must stay pinned.');
  add('baseline-e7a8dbc-current', baselineOk, 'Baseline commit is stale.');
  add('stale-baseline-rejected', baselineOk, 'Stale baseline was accepted.');
  add('phase27-dependency-e7a8dbc-pinned', dependencyOk, 'Phase 27 dependency is missing or stale.');
  add('phase27-dependency-current', dependencyOk, 'Phase 27 dependency is stale.');
  add('phase27-candidate-non-authorizing', dependencyOk, 'Phase 27 dependency became authorizing.');
  add('stale-phase27-dependency-rejected', dependencyOk, 'Stale Phase 27 dependency was accepted.');
  add('decision-default-remain-pre-runtime-review', defaultDecisionSafe, 'Default decision changed.');
  add('eligible-phase29-state-non-authorizing', decisionSafe, 'Eligible decision became authorizing.');
  add('eligible-phase29-non-authorizing', decisionSafe, 'Eligible Phase 29 decision is unsafe.');
  add('eligible-as-authorization-rejected', decisionSafe, 'Eligible-as-authorization was accepted.');
  add('phase27-proof-boundaries-preserved', proofSafe, 'Phase 27 proof boundaries changed.');
  add('proof-boundaries-preserved', proofSafe, 'Proof boundaries were overclaimed.');
  add('fake-proof-rejected', proofSafe, 'Fake proof was accepted.');
  add('server-local-capability-truth-preserved', proofSafe, 'Server/local capability truth changed.');
  add('server-local-target-boundaries-preserved', proofSafe, 'Server target boundaries changed.');
  add('all-phase27-gates-mapped-to-phase29-prerequisites', prerequisitesSafe, 'Phase 27 gates were not mapped.');
  add('phase29-prerequisites-complete', prerequisitesSafe, 'Phase 29 prerequisites are incomplete.');
  add('phase27-gates-one-to-one-mapped', prerequisitesSafe, 'Phase 27 gates are not one-to-one mapped.');
  add('prerequisites-remain-unsatisfied', prerequisitesSafe, 'Prerequisites were marked satisfied.');
  add('missing-carried-forward-gates-rejected', prerequisitesSafe, 'Missing carried-forward gate was accepted.');
  add('safe-first-slice-constraints-complete', constraintsSafe, 'Safe first-slice constraints are incomplete.');
  add('disabled-dev-local-constraints-present', constraintsSafe && disabledDevLocalConstraintsOk(report), 'Disabled/dev/local constraints are missing.');
  add('kill-switch-rollback-audit-required', killRollbackAuditSafe, 'Kill switch, rollback, or audit requirement is missing.');
  add('missing-kill-switch-rollback-audit-rejected', killRollbackAuditSafe, 'Missing kill switch, rollback, or audit was accepted.');
  add('network-listener-overclaim-rejected', networkListenerOk(report), 'Network/listener overclaim was accepted.');
  add('local-execution-shell-pty-overclaim-rejected', localExecutionOk(report), 'Local execution overclaim was accepted.');
  add('queue-lease-store-write-rejected', queueLeaseStoreOk(report), 'Queue, lease, or store write overclaim was accepted.');
  add('customer-send-deploy-trade-rejected',
    report.side_effect_result?.no_send_performed === true
      && report.side_effect_result?.no_deploy_performed === true
      && report.side_effect_result?.no_trade_performed === true
      && unsafeDriftSafe,
    'Customer-send/deploy/trade drift was accepted.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('raw-secret-path-private-leakage-rejected', true, null);
  } catch (err) {
    add('raw-secret-path-private-leakage-rejected', false, err.message);
  }

  add('next-safe-actions-tier0-tier1-only', nextActionsSafe && unsafeDriftSafe, 'Next safe actions are unsafe.');
  add('unsafe-next-action-drift-rejected', nextActionsSafe && unsafeDriftSafe, 'Unsafe next-action drift was accepted.');
  add('side-effects-blocked-now', effectsSafe, 'Side-effect truth changed.');
  add('side-effect-truth-all-blocked', effectsSafe, 'Side-effect truth is unsafe.');
  add('tamper-coverage-complete', tamperCoverageOk(report, contract), 'Tamper coverage is incomplete.');
  add('idempotency-sensitive-to-baseline-prerequisites-and-decision',
    report.idempotency_key === runtimeDryRunReviewIdempotencyKey(report),
    'Runtime dry-run review idempotency key is unstable.');
  add('idempotency-sensitive-to-review-inputs',
    report.idempotency_key === runtimeDryRunReviewIdempotencyKey(report),
    'Runtime dry-run review idempotency did not reflect inputs.');
  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime dry-run review literal values changed.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(reviewReport, contract = {}, generatedAt = reviewReport.generated_at) {
  const validation = validateReviewReport(reviewReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUN_REVIEW_VERSION,
    report_id: `runtime-dry-run-review-validation-${stableHash({
      review_key: reviewReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.id),
    phase27_dependency_result: checkResult('phase27-dependency-current'),
    decision_result: checkResult('decision-default-remain-pre-runtime-review'),
    phase29_prerequisites_result: checkResult('phase29-prerequisites-complete'),
    safe_first_slice_constraints_result: checkResult('safe-first-slice-constraints-complete'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: Boolean(validation.resultById[check.id]?.ok),
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-review', 'phase28-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeDryRunReview(options = {}) {
  const contract = options.contract || {};
  const reviewReport = buildReviewReport(options);
  const validation_report = buildValidationReport(reviewReport, contract, reviewReport.generated_at);
  const output = {
    runtime_dry_run_review_report: reviewReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeDryRunReviewOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const reviewReport = output.runtime_dry_run_review_report || {};
  const validationReport = output.validation_report || {};
  const reviewValidation = validateReviewReport(reviewReport, contract);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && reviewReport.schema === RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(reviewReport, contract.expectedRuntimeDryRunReviewReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime dry-run review output shape is incomplete.');

  for (const check of reviewValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'Validation report literal values changed.');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(validationReport.side_effect_result),
    'Validation report side-effect truth is unsafe.');

  add('validation-report-acceptance-ids',
    idsEqual(asArray(validationReport.acceptance_checks), 'id', acceptanceIds),
    'Validation report acceptance check IDs do not match fixture.');

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

module.exports = {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_DECISIONS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE29_PREREQUISITE_IDS,
  DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  PHASE27_COMMIT,
  PHASE27_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunReview,
  runtimeDryRunReviewIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeDryRunReviewOutput,
};
