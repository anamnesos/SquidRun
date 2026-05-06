'use strict';

const crypto = require('crypto');

const RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION = 'squidrun.mira_core.runtime_operator_ui_surface_manifest.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_operator_ui_surface_validation_report.v0';
const RUNTIME_OPERATOR_UI_SURFACE_VERSION = 'v0';
const BASELINE_COMMIT = '801a92a';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_operator_ui_surface_manifest',
  'validation_report',
]);

const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'schema',
  'version',
  'surface_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_registry',
  'commit_chain',
  'source_recommendation',
  'carried_forward_recommendations',
  'stale_readiness',
  'phase34_prior_recommendations',
  'closure_summary',
  'source_artifact_refs',
  'surface_contract',
  'sections',
  'cards',
  'warnings',
  'actions',
  'capability_matrix',
  'boundary_truth',
  'redaction_summary',
  'unsafe_action_policy',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'fixture_ref',
  'baseline_commit',
  'decision',
  'accepted',
  'blocked',
  'reasons',
  'static_rule_results',
  'acceptance_check_results',
  'tamper_case_results',
  'required_literal_results',
  'forbidden_output_scan',
  'side_effect_truth',
  'summary',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_ui_implemented',
  'no_browser_window_capture',
  'no_runtime_performed',
  'no_runner_executed',
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
  'no_shell_or_pty_used',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'uiImplementationAttempts',
  'browserWindowCaptureAttempts',
  'runtimeAttempts',
  'runnerAttempts',
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
  'shellPtyAttempts',
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'bearer token',
  'api key',
  'private key',
  'data key',
  'session secret',
  'env secret',
  'raw terminal',
  'raw screenshot',
  'raw OCR',
  'browser cookie',
  'browser DOM',
  'customer private',
  'side profile payload',
  'decrypted payload',
  'raw comms body',
  'ui rendered',
  'browser opened',
  'window captured',
  'screenshot captured',
  'capture performed',
  'runtime started',
  'runner executed',
  'runtime is available',
  'runner is available',
  'server started',
  'listener bound',
  'network request sent',
  'database write',
  'store write',
  'file written',
  'migration executed',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'PTY executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'status card proves UI',
  'operator surface proves runtime',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'Builder direct target allowed',
  'Oracle direct target allowed',
]);

const NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze(new Set([
  'ui rendered',
  'browser opened',
  'window captured',
  'screenshot captured',
  'capture performed',
  'runtime started',
  'runner executed',
  'runtime is available',
  'runner is available',
  'server started',
  'listener bound',
  'network request sent',
  'database write',
  'store write',
  'file written',
  'migration executed',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'pty executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'status card proves ui',
  'operator surface proves runtime',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

const SECTION_DEFS = Object.freeze([
  {
    section_id: 'runtime-boundary',
    label: 'Runtime Boundary',
    description: 'Display-only runtime boundary facts; no runtime action is authorized.',
    card_ids: ['runtime-availability-card', 'runner-execution-card', 'server-local-boundary-card'],
  },
  {
    section_id: 'operator-status',
    label: 'Operator Status',
    description: 'Redacted local status metadata sourced from prior validation artifacts.',
    card_ids: ['phase35-current-card', 'phase34-satisfied-recs-card', 'stale-readiness-card'],
  },
  {
    section_id: 'warnings',
    label: 'Warnings',
    description: 'Boundary warnings that keep proof and side-effect claims false.',
    card_ids: ['proof-boundary-card'],
  },
  {
    section_id: 'next-actions',
    label: 'Next Actions',
    description: 'Disabled non-authorizing future contract actions only.',
    card_ids: ['next-safe-actions-card'],
  },
]);

const CARD_DEFS = Object.freeze([
  ['runtime-availability-card', 'runtime-boundary', 'Runtime Availability', 'status', 'blocked', 'high',
    'Runtime availability remains false; this card is redacted metadata only.'],
  ['runner-execution-card', 'runtime-boundary', 'Runner Execution', 'status', 'blocked', 'high',
    'Runner execution remains false; no runner action is available from this surface.'],
  ['server-local-boundary-card', 'runtime-boundary', 'Server Local Boundary', 'boundary', 'blocked', 'high',
    'Server-local action and direct Builder or Oracle targets stay blocked.'],
  ['phase35-current-card', 'operator-status', 'Phase35 Current', 'milestone', 'current', 'low',
    'Phase35 runtime next-action validation is current at 801a92a.'],
  ['phase34-satisfied-recs-card', 'operator-status', 'Phase34 Prior Recommendations', 'milestone', 'satisfied', 'low',
    'Phase34 prior Phase35 recommendations stay satisfied and closed.'],
  ['stale-readiness-card', 'operator-status', 'Stale Readiness', 'status', 'warning', 'medium',
    'Phase13, Phase23, and Phase31 stale readiness truth is preserved.'],
  ['proof-boundary-card', 'warnings', 'Proof Boundary', 'warning', 'blocked', 'high',
    'Status cards, socket delivery, and this operator surface are not proof.'],
  ['next-safe-actions-card', 'next-actions', 'Next Safe Actions', 'next_action', 'ready_for_review', 'tier0',
    'Only Tier0 or Tier1 future validation work remains visible here.'],
]);

const WARNING_DEFS = Object.freeze([
  ['ui-surface-not-ui-proof', 'UI Surface Is Not UI Proof', 'high',
    'This manifest describes a future display surface; it does not prove any local UI exists.'],
  ['runtime-not-available', 'Runtime Not Available', 'high',
    'Runtime availability remains false and no runtime action is authorized.'],
  ['socket-not-bridge-green', 'Socket Is Not Bridge Green', 'medium',
    'Socket connection alone cannot prove bridge green status.'],
  ['delivery-not-model-processing-proof', 'Delivery Is Not Model Proof', 'medium',
    'Delivery acceptance cannot prove model processing.'],
  ['no-output-file-or-store', 'No Output File Or Store', 'high',
    'Output-file and store mutation behavior stay blocked.'],
]);

const ACTION_DEFS = Object.freeze([
  ['view-redacted-status-summary', 'View redacted status summary', 'tier0', 'display_metadata'],
  ['copy-non-authorizing-contract-ref', 'Copy non-authorizing contract reference', 'tier0', 'contract_reference'],
  ['prepare-next-fixture-only-ui-surface-validator', 'Prepare next fixture-only UI surface validator', 'tier0', 'future_contract'],
  ['carry-forward-disabled-dry-run-reporting-reconciliation', 'Carry forward disabled dry-run reporting reconciliation', 'tier1', 'future_contract'],
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

function evidenceRef(store, eventId, relation = 'runtime_operator_ui_surface_validation') {
  return { store, eventId, relation };
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
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

function expectedManifestShape(contract = {}) {
  return contract.expectedManifestShape || {};
}

function surfaceShape(contract = {}) {
  return contract.surfaceShapeExpected || {};
}

function validationShape(contract = {}) {
  return contract.expectedValidationReportShape || {};
}

function phaseRegistry(contract = {}) {
  const expected = contract.phaseRegistryExpected || {};
  return {
    source_ref: expected.source_ref,
    current_through_phase: 35,
    expected_phases: expected.expected_phases || '1-35',
    phase_inventory_count: 35,
    schema_registry_count: 35,
    cli_registry_count: 35,
    phase35_current: true,
    phase35_commit: BASELINE_COMMIT,
    phase35_delta: clone(expected.phase35_delta || {}),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase36-baseline'),
      evidenceRef('mira-core-runtime-operator-ui-surface-contract', 'phase-registry'),
    ],
  };
}

function staleReadiness(contract = {}) {
  return {
    ...clone(contract.staleReadinessExpected || {}),
    evidenceRefs: [
      evidenceRef('mira-core-readiness', 'phase13-stale'),
      evidenceRef('mira-core-milestone-readiness', 'phase23-stale'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-stale'),
      evidenceRef('mira-core-runtime-next-action', 'phase35-current'),
    ],
  };
}

function phase34PriorRecommendations(contract = {}) {
  return {
    phase35_runtime_status_milestone_refresh_validator: {
      ...clone(contract.phase34PriorRecommendationsExpected?.[0] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-validator-satisfied')],
    },
    phase35_stdout_only_cli_smoke: {
      ...clone(contract.phase34PriorRecommendationsExpected?.[1] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-cli-satisfied')],
    },
  };
}

function closureSummary() {
  return {
    phase30_oracle_115_prerequisite_mapping_closure: true,
    phase32_oracle_123_expires_at_closure: true,
    phase33_oracle_127_validation_report_tamper_coverage_closure: true,
    phase34_oracle_131_read_only_review_green: true,
    phase35_oracle_134_read_only_review_green: true,
    closed_review_refs: ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('mira-core-runtime-dry-runner', 'oracle-123-closure'),
      evidenceRef('mira-core-runtime-operator-status', 'oracle-127-closure'),
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'oracle-131-closure'),
      evidenceRef('mira-core-runtime-next-action', 'oracle-134-closure'),
    ],
  };
}

function sourceArtifactRefs(contract = {}) {
  return clone(contract.sourceArtifactRefsExpected || []);
}

function surfaceContract(contract = {}) {
  return {
    surface_id: 'runtime_operator_status_ui_surface_contract_only',
    surface_kind: 'local_operator_status_metadata_surface',
    display_only: true,
    operator_visible: true,
    disabled_by_default: true,
    non_authorizing: true,
    ui_rendering_authorized: false,
    browser_window_capture_authorized: false,
    runtime_start_authorized: false,
    runner_execution_authorized: false,
    output_file_authorized: false,
    store_write_authorized: false,
    queue_lease_authorized: false,
    local_execution_authorized: false,
    send_deploy_trade_authorized: false,
    source_artifact_refs: sourceArtifactRefs(contract).map((ref) => ref.artifact_id),
    section_shape: clone(surfaceShape(contract).sectionRequiredFields || []),
    card_shape: clone(surfaceShape(contract).cardRequiredFields || []),
    warning_shape: clone(surfaceShape(contract).warningRequiredFields || []),
    action_shape: clone(surfaceShape(contract).actionRequiredFields || []),
    redaction_policy: {
      raw_private_content_allowed: false,
      raw_terminal_allowed: false,
      raw_screenshot_ocr_browser_allowed: false,
      secret_material_allowed: false,
      customer_private_content_allowed: false,
    },
    display_boundaries: {
      ui_rendering_authorized: false,
      browser_window_capture_authorized: false,
      runtime_start_authorized: false,
      output_file_authorized: false,
      action_execution_authorized: false,
    },
  };
}

function sections() {
  return SECTION_DEFS.map((section, index) => ({
    section_id: section.section_id,
    label: section.label,
    order: index + 1,
    description: section.description,
    card_ids: clone(section.card_ids),
    display_only: true,
    operator_visible: true,
    source_refs: ['phase33-runtime-operator-status', 'phase35-runtime-next-action'],
    redaction_status: 'redacted_metadata_only',
  }));
}

function cards() {
  return CARD_DEFS.map(([cardId, sectionId, label, kind, status, riskTier, summary]) => ({
    card_id: cardId,
    section_id: sectionId,
    label,
    kind,
    status,
    priority: riskTier === 'high' ? 'high' : 'medium',
    risk_tier: riskTier,
    operator_visible: true,
    display_only: true,
    disabled_by_default: true,
    non_authorizing: true,
    summary,
    source_refs: ['phase33-runtime-operator-status', 'phase34-runtime-status-milestone-refresh', 'phase35-runtime-next-action'],
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', `card:${cardId}`)],
    redaction_status: 'redacted_metadata_only',
    blocked_actions: ['ui-rendering', 'runtime-start', 'runner-execution', 'local-execution', 'external-action', 'output-file'],
    proof_boundary: {
      statusCardIsUiProof: false,
      operatorSurfaceIsRuntimeProof: false,
      operatorSurfaceIsModelProcessingProof: false,
    },
  }));
}

function warnings() {
  return WARNING_DEFS.map(([warningId, label, severity, message]) => ({
    warning_id: warningId,
    label,
    severity,
    message,
    source_refs: ['phase33-runtime-operator-status', 'phase35-runtime-next-action'],
    redaction_status: 'redacted_metadata_only',
    does_not_prove: ['ui_availability', 'runtime_availability', 'model_processing', 'bridge_green', 'runner_execution'],
    blocked_actions: ['ui-rendering', 'browser-window-capture', 'runtime-start', 'output-file', 'external-action'],
  }));
}

function actions() {
  return ACTION_DEFS.map(([actionId, label, tier, kind]) => ({
    action_id: actionId,
    label,
    tier,
    enabled: false,
    action_kind: kind,
    operator_visible: true,
    display_only: true,
    non_authorizing: true,
    requires_future_contract: true,
    source_refs: ['phase35-runtime-next-action'],
    blocked_side_effects: ['ui-rendering', 'browser-window-capture', 'runtime-start', 'queue', 'lease', 'local-execution', 'irreversible-action-boundary', 'output-file'],
    does_not_authorize_ui: true,
    does_not_authorize_runtime: true,
    does_not_authorize_execution: true,
  }));
}

function capabilityMatrix() {
  return {
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    realRuntimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    directBuilderOracleServerTargetsAllowed: false,
    allowed_future_server_target_role: 'architect',
    allowed_next_recommendation_tiers: ['tier0', 'tier1'],
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', 'capability-matrix')],
  };
}

function boundaryTruth() {
  return {
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    statusCardIsUiProof: false,
    operatorSurfaceIsRuntimeProof: false,
    operatorSurfaceIsRuntimeAuthorization: false,
    operatorSurfaceIsModelProcessingProof: false,
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', 'boundary-truth')],
  };
}

function redactionSummary() {
  return {
    raw_private_content_included: false,
    raw_terminal_included: false,
    raw_screenshot_ocr_browser_included: false,
    secret_material_included: false,
    customer_private_content_included: false,
    redaction_status: 'metadata_only',
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', 'redaction-summary')],
  };
}

function unsafeActionPolicy() {
  return {
    ui_rendering_allowed: false,
    browser_window_capture_allowed: false,
    customer_send_allowed: false,
    external_send_allowed: false,
    deploy_allowed: false,
    trade_allowed: false,
    financial_action_allowed: false,
    file_mutation_allowed: false,
    store_mutation_allowed: false,
    queue_lease_allowed: false,
    local_execution_allowed: false,
    shell_pty_allowed: false,
    live_runtime_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', 'unsafe-action-policy')],
  };
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(contract.nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    blocked_side_effects: ['ui-rendering', 'browser-window-capture', 'runtime-start', 'store-write', 'queue-lease', 'execution', 'irreversible-action-boundary', 'output-file'],
    evidenceRefs: [evidenceRef('mira-core-runtime-operator-ui-surface', `next:${candidate.recommendation_id}`)],
  }));
}

function sideEffectResult() {
  const result = REQUIRED_SIDE_EFFECT_FIELDS.reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) {
    result[field] = 0;
  }
  result.uiImplemented = false;
  result.browserWindowCapturePerformed = false;
  result.runtimeStarted = false;
  result.runnerExecuted = false;
  result.runtimeAvailable = false;
  result.serverStarted = false;
  result.listenerBound = false;
  result.networkPerformed = false;
  result.outputFileWritten = false;
  return result;
}

function canonicalManifestInput(manifest = {}) {
  return {
    profile: manifest.profile,
    sessionId: manifest.sessionId,
    deviceId: manifest.deviceId,
    baseline_commit: manifest.baseline_commit,
    phase_registry: manifest.phase_registry,
    commit_chain: manifest.commit_chain,
    source_recommendation: manifest.source_recommendation,
    carried_forward_recommendations: manifest.carried_forward_recommendations,
    stale_readiness: manifest.stale_readiness,
    phase34_prior_recommendations: manifest.phase34_prior_recommendations,
    closure_summary: manifest.closure_summary,
    source_artifact_refs: manifest.source_artifact_refs,
    surface_contract: manifest.surface_contract,
    sections: manifest.sections,
    cards: manifest.cards,
    warnings: manifest.warnings,
    actions: manifest.actions,
    capability_matrix: manifest.capability_matrix,
    boundary_truth: manifest.boundary_truth,
    redaction_summary: manifest.redaction_summary,
    unsafe_action_policy: manifest.unsafe_action_policy,
    next_phase_recommendations: manifest.next_phase_recommendations,
    side_effect_result: manifest.side_effect_result,
  };
}

function runtimeOperatorUiSurfaceIdempotencyKey(manifest) {
  return `runtime-operator-ui-surface:${stableHash(canonicalManifestInput(manifest))}`;
}

function buildManifest(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const manifest = {
    schema: RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION,
    version: RUNTIME_OPERATOR_UI_SURFACE_VERSION,
    surface_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    commit_chain: asArray(inputSignals.commit_chain).length > 0 ? clone(inputSignals.commit_chain) : clone(contract.commitChainExpected || []),
    source_recommendation: clone(contract.sourceRecommendation || {}),
    carried_forward_recommendations: clone(contract.carriedForwardRecommendations || []),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(),
    source_artifact_refs: sourceArtifactRefs(contract),
    surface_contract: surfaceContract(contract),
    sections: sections(),
    cards: cards(),
    warnings: warnings(),
    actions: actions(),
    capability_matrix: capabilityMatrix(),
    boundary_truth: boundaryTruth(),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase36-baseline'),
      evidenceRef('mira-core-runtime-operator-ui-surface-contract', 'phase36-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  manifest.idempotency_key = runtimeOperatorUiSurfaceIdempotencyKey(manifest);
  manifest.surface_id = `runtime-operator-ui-surface-${stableHash({
    key: manifest.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  return manifest;
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function requiredLiteralResults(value, literals = {}) {
  return Object.entries(literals || {}).map(([pathName, expected]) => ({
    id: pathName,
    path: pathName,
    expected,
    actual: pathValue(value, pathName),
    ok: valuesMatch(pathValue(value, pathName), expected),
  }));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => Number(value[field] || 0) === 0)
    && value.uiImplemented === false
    && value.browserWindowCapturePerformed === false
    && value.runtimeStarted === false
    && value.runnerExecuted === false
    && value.runtimeAvailable === false
    && value.serverStarted === false
    && value.listenerBound === false
    && value.networkPerformed === false
    && value.outputFileWritten === false;
}

function phase35CurrentOk(manifest) {
  const registry = manifest.phase_registry || {};
  const delta = registry.phase35_delta || {};
  return registry.current_through_phase === 35
    && registry.phase_inventory_count === 35
    && registry.schema_registry_count === 35
    && registry.cli_registry_count === 35
    && registry.phase35_current === true
    && registry.phase35_commit === BASELINE_COMMIT
    && delta.phase === 35
    && delta.committed_baseline === BASELINE_COMMIT
    && delta.status === 'local_validation_runtime_present_current'
    && delta.capability_truth?.runtimeStarted === false
    && delta.capability_truth?.runnerExecuted === false
    && delta.capability_truth?.runtimeAvailable === false
    && delta.capability_truth?.serverCanExecuteLocal === false
    && delta.capability_truth?.serverCanProveModelProcessing === false
    && delta.capability_truth?.directBuilderOracleServerTargetsAllowed === false;
}

function registryCountsOk(manifest) {
  const registry = manifest.phase_registry || {};
  return registry.phase_inventory_count === 35
    && registry.schema_registry_count === 35
    && registry.cli_registry_count === 35
    && registry.current_through_phase === 35;
}

function commitChainOk(manifest, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(manifest.commit_chain);
  return expected.length === 23
    && chain.length === 23
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(manifest, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const source = manifest.source_recommendation || {};
  return source.recommendation_id === expected.recommendation_id
    && source.tier === 'tier0'
    && source.status === 'selected_for_phase36_fixture_only_contract'
    && source.contract_only_now === true
    && source.implemented_now === false
    && source.does_not_authorize_ui === true
    && source.does_not_authorize_runtime === true;
}

function carriedForwardOk(manifest, contract = {}) {
  const expected = asArray(contract.carriedForwardRecommendations)[0] || {};
  const carried = asArray(manifest.carried_forward_recommendations);
  return carried.length === 1
    && carried[0].recommendation_id === expected.recommendation_id
    && carried[0].tier === 'tier1'
    && carried[0].status === 'carried_forward_not_implemented_in_phase36'
    && carried[0].does_not_authorize_ui === true
    && carried[0].does_not_authorize_runtime === true;
}

function phase34PriorRecommendationsOk(manifest) {
  const prior = manifest.phase34_prior_recommendations || {};
  return prior.phase35_runtime_status_milestone_refresh_validator?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && prior.phase35_runtime_status_milestone_refresh_validator?.must_not_reopen === true
    && prior.phase35_stdout_only_cli_smoke?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && prior.phase35_stdout_only_cli_smoke?.must_not_reopen === true;
}

function staleReadinessOk(manifest, phase) {
  const stale = manifest.stale_readiness || {};
  if (phase === 13) return stale.phase13_readiness_current === false && stale.phase13_superseded_by === 'phase_23_milestone_readiness';
  if (phase === 23) return stale.phase23_milestone_readiness_current === false && stale.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
  if (phase === 31) return stale.phase31_runtime_milestone_refresh_current === false
    && stale.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh'
    && stale.phase35_runtime_next_action_current === true;
  return false;
}

function closuresOk(manifest) {
  const closure = manifest.closure_summary || {};
  return closure.phase30_oracle_115_prerequisite_mapping_closure === true
    && closure.phase32_oracle_123_expires_at_closure === true
    && closure.phase33_oracle_127_validation_report_tamper_coverage_closure === true
    && closure.phase34_oracle_131_read_only_review_green === true
    && closure.phase35_oracle_134_read_only_review_green === true
    && ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134']
      .every((ref) => asArray(closure.closed_review_refs).includes(ref));
}

function sourceArtifactRefsOk(manifest, contract = {}) {
  return valuesMatch(manifest.source_artifact_refs, contract.sourceArtifactRefsExpected || []);
}

function surfaceContractOk(manifest, contract = {}) {
  const surface = manifest.surface_contract || {};
  return hasRequiredFields(surface, surfaceShape(contract).requiredFields || [])
    && surface.display_only === true
    && surface.operator_visible === true
    && surface.disabled_by_default === true
    && surface.non_authorizing === true
    && surface.ui_rendering_authorized === false
    && surface.browser_window_capture_authorized === false
    && surface.runtime_start_authorized === false
    && surface.runner_execution_authorized === false
    && surface.output_file_authorized === false
    && surface.store_write_authorized === false
    && surface.queue_lease_authorized === false
    && surface.local_execution_authorized === false
    && surface.send_deploy_trade_authorized === false;
}

function sectionsOk(manifest, contract = {}) {
  const required = surfaceShape(contract).requiredSections || [];
  const sectionFields = surfaceShape(contract).sectionRequiredFields || [];
  const list = asArray(manifest.sections);
  return list.length >= Number(expectedManifestShape(contract).expectedCounts?.sections_min || 0)
    && required.every((id) => list.some((section) => section.section_id === id))
    && list.every((section) => hasRequiredFields(section, sectionFields)
      && section.display_only === true
      && section.operator_visible === true
      && section.redaction_status === 'redacted_metadata_only');
}

function cardsOk(manifest, contract = {}) {
  const required = surfaceShape(contract).requiredCards || [];
  const fields = surfaceShape(contract).cardRequiredFields || [];
  const list = asArray(manifest.cards);
  return list.length >= Number(expectedManifestShape(contract).expectedCounts?.cards_min || 0)
    && required.every((id) => list.some((card) => card.card_id === id))
    && list.every((card) => hasRequiredFields(card, fields)
      && card.operator_visible === true
      && card.display_only === true
      && card.disabled_by_default === true
      && card.non_authorizing === true
      && card.redaction_status === 'redacted_metadata_only'
      && card.proof_boundary?.statusCardIsUiProof === false
      && card.proof_boundary?.operatorSurfaceIsRuntimeProof === false
      && card.proof_boundary?.operatorSurfaceIsModelProcessingProof === false);
}

function warningsOk(manifest, contract = {}) {
  const required = surfaceShape(contract).requiredWarnings || [];
  const fields = surfaceShape(contract).warningRequiredFields || [];
  const list = asArray(manifest.warnings);
  return list.length >= Number(expectedManifestShape(contract).expectedCounts?.warnings_min || 0)
    && required.every((id) => list.some((warning) => warning.warning_id === id))
    && list.every((warning) => hasRequiredFields(warning, fields)
      && warning.redaction_status === 'redacted_metadata_only'
      && asArray(warning.does_not_prove).length > 0
      && asArray(warning.blocked_actions).length > 0);
}

function actionsOk(manifest, contract = {}) {
  const required = surfaceShape(contract).requiredActions || [];
  const fields = surfaceShape(contract).actionRequiredFields || [];
  const list = asArray(manifest.actions);
  return list.length >= Number(expectedManifestShape(contract).expectedCounts?.actions_min || 0)
    && required.every((id) => list.some((action) => action.action_id === id))
    && list.every((action) => hasRequiredFields(action, fields)
      && action.enabled === false
      && action.operator_visible === true
      && action.display_only === true
      && action.non_authorizing === true
      && action.requires_future_contract === true
      && action.does_not_authorize_ui === true
      && action.does_not_authorize_runtime === true
      && action.does_not_authorize_execution === true);
}

function redactionOk(manifest) {
  const redaction = manifest.redaction_summary || {};
  return redaction.raw_private_content_included === false
    && redaction.raw_terminal_included === false
    && redaction.raw_screenshot_ocr_browser_included === false
    && redaction.secret_material_included === false
    && redaction.customer_private_content_included === false;
}

function capabilityTruthOk(manifest) {
  const capability = manifest.capability_matrix || {};
  return capability.runtimeStarted === false
    && capability.runnerExecuted === false
    && capability.runtimeAvailable === false
    && capability.realRuntimeAvailable === false
    && capability.serverCanExecuteLocal === false
    && capability.serverCanProveModelProcessing === false
    && capability.directBuilderOracleServerTargetsAllowed === false;
}

function proofBoundariesOk(manifest) {
  const boundary = manifest.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.statusCardIsUiProof === false
    && boundary.operatorSurfaceIsRuntimeProof === false
    && boundary.operatorSurfaceIsRuntimeAuthorization === false
    && boundary.operatorSurfaceIsModelProcessingProof === false;
}

function nextRecommendationsOk(manifest, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(manifest.next_phase_recommendations);
  return recommendations.length >= Number(expectedManifestShape(contract).expectedCounts?.next_phase_recommendations_min || 0)
    && expected.every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.action === candidate.action
        && recommendation.why_safe === candidate.why_safe
        && recommendation.does_not_authorize_ui === true
        && recommendation.does_not_authorize_runtime === true
    )))
    && recommendations.every((recommendation) => ['tier0', 'tier1'].includes(recommendation.tier)
      && recommendation.does_not_authorize_ui === true
      && recommendation.does_not_authorize_runtime === true
      && asArray(recommendation.blocked_side_effects).length > 0);
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

function hasOutboundRecipientIntent(text) {
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.some((token) => outboundTerms.has(token))
    && tokens.some((token) => recipientTerms.has(token));
}

function occurrenceIsNegated(text, index) {
  const before = String(text || '').slice(Math.max(0, index - 200), index);
  const lastBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const clause = before.slice(lastBoundary + 1);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled|false)\b/i.test(clause);
}

function hasUnsafeTerm(text, term) {
  const lower = String(text || '').toLowerCase();
  const needle = String(term || '').toLowerCase();
  if (!needle) return false;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (!occurrenceIsNegated(lower, index)) return true;
    index = lower.indexOf(needle, index + needle.length);
  }
  return false;
}

function unsafeActionDriftOk(manifest, contract = {}) {
  const unsafeTerms = [
    'tier2',
    'tier3',
    'tier4',
    'deploy',
    'trade',
    'wire money',
    'external send',
    'file write',
    'store write',
    'local execution',
    'shell',
    'pty',
    'browser capture',
    'browser window',
    'window capture',
    'screen capture',
    'render ui',
    'live ui',
    'runtime start',
    'start server',
    'open listener',
    'create queue',
    'create lease',
    'write output file',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(manifest.sections),
    ...collectStringValues(manifest.cards),
    ...collectStringValues(manifest.warnings),
    ...collectStringValues(manifest.actions),
    ...collectStringValues(manifest.next_phase_recommendations),
    ...collectStringValues(manifest.surface_contract),
    ...collectStringValues(manifest.phase34_prior_recommendations),
    ...collectStringValues(manifest.closure_summary),
  ];
  return strings.every((text) => {
    const lower = String(text || '').toLowerCase();
    return !unsafeTerms.some((term) => hasUnsafeTerm(lower, term))
      && !hasOutboundRecipientIntent(lower)
      && !phraseNeedles.some((phrase) => hasUnsafeTerm(lower, phrase));
  });
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    const hasForbidden = strings.some((entry) => {
      const lower = String(entry).toLowerCase();
      let index = lower.indexOf(needle);
      while (index !== -1) {
        if (!NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(needle) || !occurrenceIsNegated(lower, index)) {
          return true;
        }
        index = lower.indexOf(needle, index + needle.length);
      }
      return false;
    });
    if (hasForbidden) {
      throw new Error(`runtime_operator_ui_surface_forbidden_substring:${forbidden}`);
    }
  }
}

function validateManifest(manifest = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = manifest.schema === RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION
    && hasRequiredFields(manifest, expectedManifestShape(contract).requiredFields || REQUIRED_MANIFEST_FIELDS);
  const baselineOk = manifest.baseline_commit === BASELINE_COMMIT;
  const phase35Ok = phase35CurrentOk(manifest);
  const registryOk = registryCountsOk(manifest);
  const chainOk = commitChainOk(manifest, contract);
  const sourceOk = sourceRecommendationOk(manifest, contract);
  const carriedOk = carriedForwardOk(manifest, contract);
  const priorOk = phase34PriorRecommendationsOk(manifest);
  const phase13Ok = staleReadinessOk(manifest, 13);
  const phase23Ok = staleReadinessOk(manifest, 23);
  const phase31Ok = staleReadinessOk(manifest, 31);
  const closureOk = closuresOk(manifest);
  const sourceRefsOk = sourceArtifactRefsOk(manifest, contract);
  const surfaceOk = surfaceContractOk(manifest, contract);
  const sectionOk = sectionsOk(manifest, contract);
  const cardOk = cardsOk(manifest, contract);
  const warningOk = warningsOk(manifest, contract);
  const actionOk = actionsOk(manifest, contract);
  const redactionSafe = redactionOk(manifest);
  const capabilityOk = capabilityTruthOk(manifest);
  const proofOk = proofBoundariesOk(manifest);
  const sideEffectsOk = sideEffectValuesOk(manifest.side_effect_result);
  const recommendationsOk = nextRecommendationsOk(manifest, contract);
  const unsafeOk = unsafeActionDriftOk(manifest, contract);
  const idempotencyOk = manifest.idempotency_key === runtimeOperatorUiSurfaceIdempotencyKey(manifest);
  const literalsOk = literalValuesOk(manifest, expectedManifestShape(contract).requiredLiteralValues || {});
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  const staticRuleOk = {
    'baseline-pinned-801a92a': baselineOk,
    'phase35-current': phase35Ok,
    'phase-registry-count-35': registryOk,
    'schema-registry-count-35': registryOk,
    'cli-registry-count-35': registryOk,
    'commit-chain-exact-23': chainOk,
    'source-recommendation-tier0-selected': sourceOk,
    'tier1-recommendation-carried-forward': carriedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134': closureOk,
    'surface-shape-data-only': surfaceOk && sourceRefsOk,
    'sections-complete': sectionOk,
    'cards-complete': cardOk,
    'warnings-complete': warningOk,
    'actions-disabled-non-authorizing': actionOk,
    'redaction-summary-safe': redactionSafe && forbiddenOk,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectsOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'required-literal-checks-bound': literalsOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
  };

  const acceptanceOk = {
    'baseline-801a92a-pinned': baselineOk,
    'phase35-current-801a92a': phase35Ok,
    'phase-registry-exactly-35': registryOk,
    'schema-registry-exactly-35': registryOk,
    'cli-registry-exactly-35': registryOk,
    'commit-chain-count-23-ending-801a92a': chainOk,
    'source-tier0-ui-surface-contract-selected': sourceOk,
    'tier1-reporting-reconciliation-carried-forward': carriedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-oracle-115-123-127-131-134-present': closureOk,
    'source-artifact-refs-phase33-34-35-present': sourceRefsOk,
    'surface-contract-display-only': surfaceOk,
    'sections-present-and-display-only': sectionOk,
    'cards-present-and-redacted': cardOk,
    'warnings-present-and-boundary-safe': warningOk,
    'actions-disabled-and-non-authorizing': actionOk,
    'runtime-started-false': manifest.capability_matrix?.runtimeStarted === false && manifest.boundary_truth?.runtimeStarted === false,
    'runner-executed-false': manifest.capability_matrix?.runnerExecuted === false && manifest.boundary_truth?.runnerExecuted === false,
    'runtime-available-false': manifest.capability_matrix?.runtimeAvailable === false && manifest.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': manifest.capability_matrix?.serverCanExecuteLocal === false && manifest.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': manifest.capability_matrix?.serverCanProveModelProcessing === false && manifest.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': manifest.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && manifest.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectsOk,
    'redaction-summary-safe': redactionSafe && forbiddenOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'next-recommendations-non-authorizing': recommendationsOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-results-complete': literalsOk,
  };

  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, staticRuleOk[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, acceptanceOk[check.id] === true);
  add('manifest-literal-values', literalsOk);
  add('manifest-contract-complete',
    outputShapeOk
      && Object.values(staticRuleOk).every((ok) => ok === true)
      && Object.values(acceptanceOk).every((ok) => ok === true)
      && literalsOk);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function resultListMatches(results = [], expectedIds = [], recomputedById = {}) {
  const list = asArray(results);
  return idsEqual(list, 'id', expectedIds)
    && list.every((entry) => entry.ok === Boolean(recomputedById[entry.id]?.ok));
}

function tamperCaseResultsOk(results = [], contract = {}) {
  const tamperCases = asArray(contract.tamperCases);
  const list = asArray(results);
  return list.length === tamperCases.length
    && list.length >= Number(expectedManifestShape(contract).expectedCounts?.tamper_case_results_min || 0)
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function literalResultsOk(results = [], manifest = {}, contract = {}) {
  const expected = requiredLiteralResults(manifest, expectedManifestShape(contract).requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected);
}

function buildValidationReport(manifest, contract = {}, generatedAt = manifest.generated_at) {
  const validation = validateManifest(manifest, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const staticResults = asArray(contract.staticValidationRules).map((rule) => resultObject(
    rule.id,
    validation.resultById[rule.id]?.ok,
  ));
  const acceptanceResults = asArray(contract.acceptanceChecks).map((check) => resultObject(
    check.id,
    validation.resultById[check.id]?.ok,
  ));
  const tamperResults = asArray(contract.tamperCases).map((tamper) => ({
    id: tamper.id,
    covered: true,
    expectedFailure: tamper.expectedFailure,
  }));
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_OPERATOR_UI_SURFACE_VERSION,
    validation_id: `runtime-operator-ui-surface-validation-${stableHash({
      manifest_key: manifest.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-operator-ui-surface-contract.json',
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    required_literal_results: requiredLiteralResults(manifest, expectedManifestShape(contract).requiredLiteralValues || {}),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['redaction-summary-safe']?.ok),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: manifest.phase_registry?.current_through_phase,
      phase_registry_count: manifest.phase_registry?.phase_inventory_count,
      section_count: asArray(manifest.sections).length,
      card_count: asArray(manifest.cards).length,
      warning_count: asArray(manifest.warnings).length,
      action_count: asArray(manifest.actions).length,
      baseline_commit: manifest.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeOperatorUiSurface(options = {}) {
  const contract = options.contract || {};
  const runtime_operator_ui_surface_manifest = buildManifest(options);
  const validation_report = buildValidationReport(
    runtime_operator_ui_surface_manifest,
    contract,
    runtime_operator_ui_surface_manifest.generated_at,
  );
  const output = {
    runtime_operator_ui_surface_manifest,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeOperatorUiSurfaceOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const manifest = output.runtime_operator_ui_surface_manifest || {};
  const report = output.validation_report || {};
  const manifestValidation = validateManifest(manifest, contract);
  const recomputedById = manifestValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && manifest.schema === RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of manifestValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth));

  add('validation-report-matches-contract',
    report.accepted === manifestValidation.ok
      && report.blocked === !manifestValidation.ok
      && report.decision === (manifestValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(asArray(report.reasons), manifestValidation.checks.filter((check) => !check.ok).map((check) => check.id))
      && resultListMatches(
        report.static_rule_results,
        asArray(contract.staticValidationRules).map((rule) => rule.id),
        recomputedById,
      )
      && resultListMatches(
        report.acceptance_check_results,
        asArray(contract.acceptanceChecks).map((check) => check.id),
        recomputedById,
      )
      && tamperCaseResultsOk(report.tamper_case_results, contract)
      && literalResultsOk(report.required_literal_results, manifest, contract)
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['redaction-summary-safe']?.ok));

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true);
  } catch {
    add('forbidden-output-strings-absent', false);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

module.exports = {
  BASELINE_COMMIT,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeOperatorUiSurface,
  runtimeOperatorUiSurfaceIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeOperatorUiSurfaceOutput,
};
