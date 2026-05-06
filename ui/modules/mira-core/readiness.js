'use strict';

const crypto = require('crypto');

const READINESS_MANIFEST_SCHEMA_VERSION = 'squidrun.mira_core.readiness_manifest.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.readiness_validation_report.v0';
const READINESS_VERSION = 'v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'readiness_manifest',
  'validation_report',
]);

const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'schema',
  'version',
  'manifest_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'phase_inventory',
  'schema_registry',
  'cli_registry',
  'capability_matrix',
  'boundary_truth',
  'artifact_summary',
  'verification_summary',
  'blocker_summary',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'fixture_schema',
  'readiness_manifest_schema',
  'phase_inventory_count',
  'schema_registry_count',
  'cli_registry_count',
  'fixture_static_rule_count',
  'acceptance_check_count',
  'required_blocker_count',
  'next_recommendation_count',
  'phase_inventory_result',
  'schema_registry_result',
  'cli_registry_result',
  'capability_boundary_result',
  'verification_truth_result',
  'blocker_summary_result',
  'next_recommendation_result',
  'idempotency_result',
  'forbidden_output_result',
  'side_effect_result',
  'passed',
  'reasons',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_source_store_write_performed',
  'no_memory_profile_commit_performed',
  'no_network_performed',
  'no_server_deploy_performed',
  'no_queue_created',
  'no_database_write_performed',
  'no_auth_secret_or_signing_material_created',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_window_access_performed',
  'no_external_send_performed',
  'no_customer_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_runtime_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'sourceStoreWritesAttempted',
  'memoryProfileCommitsAttempted',
  'networkRequestsAttempted',
  'serverDeploysAttempted',
  'queuesCreated',
  'databaseWritesAttempted',
  'authSecretsOrSigningMaterialCreated',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserWindowAccessAttempted',
  'externalSendsAttempted',
  'customerSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw terminal scrollback',
  'raw comms transcript',
  'raw screenshot OCR',
  'browser profile',
  'customer phone',
  'customer address',
  'side profile',
  'server executed local work',
  'server can run shell',
  'server can operate PTY',
  'server can deploy',
  'server can trade',
  'socket alone proves bridge green',
  'lease proves model processing',
  'manifest proves execution',
]);

const DEFAULT_PHASE_INVENTORY = Object.freeze([
  {
    phase: 1,
    name: 'snapshot',
    module_path: 'ui/modules/mira-core/snapshot.js',
    cli_path: 'ui/scripts/hm-mira-core-snapshot.js',
    test_path: 'ui/__tests__/mira-core-snapshot.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-snapshot-contract.json',
    status: 'local_read_only_runtime_present',
    boundary_mode: 'local_read_only_snapshot',
    real_now: 'local snapshot summary surface with redacted refs, counts, hashes, watermarks, and capability state only',
    validation_only: false,
    proposal_only: false,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 2,
    name: 'orientation',
    module_path: 'ui/modules/mira-core/orientation.js',
    cli_path: 'ui/scripts/hm-mira-core-status.js',
    test_path: 'ui/__tests__/mira-core-orientation.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-orientation-contract.json',
    status: 'local_read_only_runtime_present',
    boundary_mode: 'local_read_only_orientation',
    real_now: 'local orientation surface over snapshot capability, memory, redaction, bridge, and next safe actions',
    validation_only: false,
    proposal_only: false,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 3,
    name: 'profiles',
    module_path: 'ui/modules/mira-core/profiles.js',
    cli_path: 'ui/scripts/hm-mira-core-profiles.js',
    test_path: 'ui/__tests__/mira-core-profiles.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-profile-contract.json',
    status: 'local_read_only_runtime_present',
    boundary_mode: 'read_only_profile_projection_pending_proposals',
    real_now: 'local self-profile and James-profile read-only projection plus pending proposals, with no durable profile rewrite',
    validation_only: false,
    proposal_only: true,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 4,
    name: 'proposal-validator',
    module_path: 'ui/modules/mira-core/proposal-validator.js',
    cli_path: 'ui/scripts/hm-mira-core-validate-proposal.js',
    test_path: 'ui/__tests__/mira-core-proposal-validator.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-proposal-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'memory_proposal_validation_only_no_commit',
    real_now: 'local validation decision for memory/profile proposals only; accepted means pending, not committed',
    validation_only: true,
    proposal_only: true,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 5,
    name: 'eval-runner',
    module_path: 'ui/modules/mira-core/eval-runner.js',
    cli_path: 'ui/scripts/hm-mira-core-eval-runner.js',
    test_path: 'ui/__tests__/mira-core-eval-runner.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-eval-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'model_free_eval_fixture_validation',
    real_now: 'static fixture completeness and gate coverage validation without model calls',
    validation_only: true,
    proposal_only: false,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 6,
    name: 'pulse',
    module_path: 'ui/modules/mira-core/pulse.js',
    cli_path: 'ui/scripts/hm-mira-core-pulse.js',
    test_path: 'ui/__tests__/mira-core-pulse.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-pulse-contract.json',
    status: 'local_read_only_runtime_present',
    boundary_mode: 'bounded_local_reflection_cards_only',
    real_now: 'local read-only Pulse cards and proposals, not execution, sends, deploys, or memory commits',
    validation_only: false,
    proposal_only: true,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 7,
    name: 'server-upload',
    module_path: 'ui/modules/mira-core/server-upload.js',
    cli_path: 'ui/scripts/hm-mira-core-server-upload.js',
    test_path: 'ui/__tests__/mira-core-server-upload.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-upload-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'upload_envelope_preparation_only_no_network',
    real_now: 'redacted upload envelope preparation and validation only; no server upload occurs',
    validation_only: true,
    proposal_only: false,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 8,
    name: 'intent-queue',
    module_path: 'ui/modules/mira-core/intent-queue.js',
    cli_path: 'ui/scripts/hm-mira-core-intent-queue.js',
    test_path: 'ui/__tests__/mira-core-intent-queue.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-intent-queue-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'intent_record_preparation_only_no_real_queue',
    real_now: 'intent records prepared for pending local acceptance only; no queue, route, lease, or execution',
    validation_only: true,
    proposal_only: true,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 9,
    name: 'local-acceptance',
    module_path: 'ui/modules/mira-core/local-acceptance.js',
    cli_path: 'ui/scripts/hm-mira-core-local-acceptance.js',
    test_path: 'ui/__tests__/mira-core-local-acceptance.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-local-acceptance-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'local_acceptance_and_dry_run_lease_contract_only',
    real_now: 'local acceptance records and dry-run lease contracts only; acceptance is not execution and lease is not model-processing proof',
    validation_only: true,
    proposal_only: false,
    capability_level: 'tier1_local_reversible',
  },
  {
    phase: 10,
    name: 'mutation-patch',
    module_path: 'ui/modules/mira-core/mutation-patch.js',
    cli_path: 'ui/scripts/hm-mira-core-mutation-patch.js',
    test_path: 'ui/__tests__/mira-core-mutation-patch.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-mutation-patch-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'mutation_patch_proposal_only_no_apply',
    real_now: 'reviewable mutation patch records only; no file, memory, profile, or skill mutation is applied',
    validation_only: true,
    proposal_only: true,
    capability_level: 'tier1_local_reversible',
  },
  {
    phase: 11,
    name: 'perception',
    module_path: 'ui/modules/mira-core/perception.js',
    cli_path: 'ui/scripts/hm-mira-core-perception.js',
    test_path: 'ui/__tests__/mira-core-perception.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-perception-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'perception_capture_proposal_only_no_capture',
    real_now: 'task-scoped capture request and evidence-summary proposal records only; no screenshots, OCR, browser/window access, or always-on screen memory',
    validation_only: true,
    proposal_only: true,
    capability_level: 'tier0_read_only',
  },
  {
    phase: 12,
    name: 'server-boundary',
    module_path: 'ui/modules/mira-core/server-boundary.js',
    cli_path: 'ui/scripts/hm-mira-core-server-boundary.js',
    test_path: 'ui/__tests__/mira-core-server-boundary.test.js',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-boundary-contract.json',
    status: 'local_validation_runtime_present',
    boundary_mode: 'server_receive_store_status_boundary_validation_only_no_server',
    real_now: 'server receive/status boundary records only; no server runtime, network, db write, queue, or local execution',
    validation_only: true,
    proposal_only: false,
    capability_level: 'tier0_read_only',
  },
]);

const DEFAULT_SCHEMA_REGISTRY = Object.freeze([
  {
    phase: 1,
    name: 'snapshot',
    fixture_schema: 'squidrun.mira_core.snapshot_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.snapshot.v0'],
    validation_report_schema: null,
  },
  {
    phase: 2,
    name: 'orientation',
    fixture_schema: 'squidrun.mira_core.orientation_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.orientation.v0'],
    validation_report_schema: null,
  },
  {
    phase: 3,
    name: 'profiles',
    fixture_schema: 'squidrun.mira_core.profile_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.profiles.v0'],
    validation_report_schema: null,
  },
  {
    phase: 4,
    name: 'proposal-validator',
    fixture_schema: 'squidrun.mira_core.proposal_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.proposal_validation.v0'],
    validation_report_schema: 'squidrun.mira_core.proposal_validation.v0',
  },
  {
    phase: 5,
    name: 'eval-runner',
    fixture_schema: 'squidrun.mira_core.eval_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.eval_fixture_validation.v0'],
    validation_report_schema: 'squidrun.mira_core.eval_fixture_validation.v0',
  },
  {
    phase: 6,
    name: 'pulse',
    fixture_schema: 'squidrun.mira_core.pulse_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.pulse.v0'],
    validation_report_schema: null,
  },
  {
    phase: 7,
    name: 'server-upload',
    fixture_schema: 'squidrun.mira_core.server_upload_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.server_upload_envelope.v0'],
    validation_report_schema: 'squidrun.mira_core.server_upload_validation_report.v0',
  },
  {
    phase: 8,
    name: 'intent-queue',
    fixture_schema: 'squidrun.mira_core.intent_queue_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.intent_record.v0'],
    validation_report_schema: 'squidrun.mira_core.intent_queue_validation_report.v0',
  },
  {
    phase: 9,
    name: 'local-acceptance',
    fixture_schema: 'squidrun.mira_core.local_acceptance_contract_fixture.v0',
    runtime_schemas: [
      'squidrun.mira_core.local_acceptance_record.v0',
      'squidrun.mira_core.dry_run_lease_contract.v0',
    ],
    validation_report_schema: 'squidrun.mira_core.local_acceptance_validation_report.v0',
  },
  {
    phase: 10,
    name: 'mutation-patch',
    fixture_schema: 'squidrun.mira_core.mutation_patch_contract_fixture.v0',
    runtime_schemas: ['squidrun.mira_core.mutation_patch_record.v0'],
    validation_report_schema: 'squidrun.mira_core.mutation_patch_validation_report.v0',
  },
  {
    phase: 11,
    name: 'perception',
    fixture_schema: 'squidrun.mira_core.perception_contract_fixture.v0',
    runtime_schemas: [
      'squidrun.mira_core.capture_request_record.v0',
      'squidrun.mira_core.perception_evidence_summary.v0',
    ],
    validation_report_schema: 'squidrun.mira_core.perception_validation_report.v0',
  },
  {
    phase: 12,
    name: 'server-boundary',
    fixture_schema: 'squidrun.mira_core.server_boundary_contract_fixture.v0',
    runtime_schemas: [
      'squidrun.mira_core.server_receive_record.v0',
      'squidrun.mira_core.server_status_summary.v0',
    ],
    validation_report_schema: 'squidrun.mira_core.server_boundary_validation_report.v0',
  },
]);

const DEFAULT_BLOCKER_IDS = Object.freeze([
  'real-server-runtime-blocked-pending-identity-signing-auth-storage-deletion-retention',
  'memory-profile-commits-blocked-pending-review-evals',
  'capture-apply-execution-local-gated',
  'memory-drift-reduces-sync-confidence',
]);

const DEFAULT_NEXT_RECOMMENDATION_IDS = Object.freeze([
  'readiness-static-review',
  'run-local-model-free-readiness-tests-if-available',
  'server-runtime-gap-spec-only',
]);

const ALLOWED_RECOMMENDATION_RISK_TIERS = Object.freeze([
  'tier0_read_only',
  'tier1_local_reversible',
]);

const FORBIDDEN_RECOMMENDATION_RISK_TIERS = Object.freeze([
  'tier2_repo_mutation',
  'tier2_repo_mutation_without_review',
  'tier3_external_side_effect',
  'tier4_financial_or_irreversible',
]);

const ALLOWED_TEST_PROOF_STATUSES = Object.freeze([
  'proven_by_reported_command',
  'partial',
  'unknown',
  'degraded',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
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

function hasRequiredFields(value, fields) {
  return asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function normalizeProfile(value) {
  const name = typeof value === 'object' && value ? value.name : value;
  const normalized = String(name || 'main').trim() || 'main';
  return {
    name: normalized,
    windowKey: normalized,
    sessionScopeId: normalized,
  };
}

function normalizeScope(inputSignals = {}) {
  const profile = normalizeProfile(inputSignals.profile);
  return {
    profile,
    sessionId: inputSignals.sessionId || 'app-session-326',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function evidenceRef(kind, id, relation = 'readiness_index') {
  return {
    store: 'mira-core-readiness',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function withEvidence(items, kind) {
  return asArray(items).map((item) => ({
    ...clone(item),
    evidenceRefs: asArray(item.evidenceRefs).length > 0
      ? clone(item.evidenceRefs)
      : [evidenceRef(kind, item.phase || item.name || item.registry_id || 'unknown')],
  }));
}

function phaseInventory(inputSignals = {}) {
  const base = asArray(inputSignals.phase_inventory).length > 0
    ? inputSignals.phase_inventory
    : DEFAULT_PHASE_INVENTORY;
  return withEvidence(base, 'phase');
}

function schemaRegistry(inputSignals = {}, inventory = phaseInventory(inputSignals)) {
  const base = asArray(inputSignals.schema_registry).length > 0
    ? inputSignals.schema_registry
    : DEFAULT_SCHEMA_REGISTRY;
  return withEvidence(base.map((entry) => {
    const phase = inventory.find((item) => item.phase === entry.phase) || {};
    return {
      registry_id: entry.registry_id || `phase-${entry.phase}-${entry.name}-schema`,
      phase: entry.phase,
      name: entry.name,
      fixture_schema: entry.fixture_schema,
      runtime_schemas: clone(entry.runtime_schemas || []),
      validation_report_schema: entry.validation_report_schema ?? null,
      source_fixture_path: entry.source_fixture_path || phase.fixture_path || null,
      source_module_path: entry.source_module_path || phase.module_path || null,
      status: entry.status || 'indexed_no_runtime_claim',
      evidenceRefs: entry.evidenceRefs,
    };
  }), 'schema');
}

function commandNameFromPath(cliPath) {
  const file = String(cliPath || '').split(/[\\/]/).pop() || '';
  return file.replace(/\.js$/i, '');
}

function cliRegistry(inputSignals = {}, inventory = phaseInventory(inputSignals)) {
  const base = asArray(inputSignals.cli_registry).length > 0
    ? inputSignals.cli_registry
    : inventory.map((phase) => ({
        phase: phase.phase,
        name: phase.name,
        cli_path: phase.cli_path,
        command_name: commandNameFromPath(phase.cli_path),
        stdout_json_allowed: true,
        output_file_mode_allowed: false,
        network_allowed: false,
        source_store_write_allowed: false,
        external_send_allowed: false,
        boundary_mode: phase.boundary_mode,
      }));
  return withEvidence(base, 'cli');
}

function capabilityMatrix(inputSignals = {}) {
  return {
    canBuildReadOnlySnapshot: true,
    canBuildReadOnlyOrientation: true,
    canBuildReadOnlyProfiles: true,
    canValidateMemoryProposal: true,
    canValidateEvalFixtures: true,
    canBuildPulseCards: true,
    canPrepareUploadEnvelopeOffline: true,
    canPrepareIntentRecordsOffline: true,
    canPrepareLocalAcceptanceDryRun: true,
    canPrepareMutationPatchRecords: true,
    canPreparePerceptionRequestRecords: true,
    canPrepareServerBoundaryRecords: true,
    canBuildReadinessManifest: true,
    localArchitectMayCoordinateWhenLocalArmsOnline: true,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    realServerRuntimeAvailable: false,
    durableMemoryProfileCommitAllowed: false,
    captureApplyExecutionAllowed: false,
    allowedNowRiskTiers: clone(inputSignals.allowedNowRiskTiers || ALLOWED_RECOMMENDATION_RISK_TIERS),
    blockedRiskTiers: clone(inputSignals.blockedRiskTiers || [
      'tier2_repo_mutation_without_review',
      'tier3_external_side_effect',
      'tier4_financial_or_irreversible',
    ]),
  };
}

function boundaryTruth() {
  return {
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanRunShell: false,
    serverCanAccessBrowserOrWindow: false,
    serverCanSendCustomerMessages: false,
    serverCanDeploy: false,
    serverCanTrade: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    serverOriginatedTarget: 'architect',
    localArchitectCoordinationRequiresLocalArmsOnline: true,
    socketIsBridgeGreenProof: false,
    manifestIsExecutionProof: false,
    uploadEnvelopeIsNetworkUpload: false,
    intentRecordIsRealQueue: false,
    acceptanceRecordIsExecution: false,
    dryRunLeaseIsModelProcessingProof: false,
    mutationPatchRecordIsAppliedChange: false,
    perceptionProposalIsCapture: false,
    serverBoundaryRecordIsServerRuntime: false,
    memoryDriftLowersSyncConfidence: true,
  };
}

function sideEffectResult(overrides = {}) {
  return {
    no_source_store_write_performed: true,
    no_memory_profile_commit_performed: true,
    no_network_performed: true,
    no_server_deploy_performed: true,
    no_queue_created: true,
    no_database_write_performed: true,
    no_auth_secret_or_signing_material_created: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_window_access_performed: true,
    no_external_send_performed: true,
    no_customer_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_runtime_output_file_written: true,
    sourceStoreWritesAttempted: 0,
    memoryProfileCommitsAttempted: 0,
    networkRequestsAttempted: 0,
    serverDeploysAttempted: 0,
    queuesCreated: 0,
    databaseWritesAttempted: 0,
    authSecretsOrSigningMaterialCreated: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    customerSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function artifactSummary(inventory, schemas, clis) {
  return {
    phase_count: inventory.length,
    fixture_count: inventory.filter((item) => item.fixture_path).length,
    module_count: inventory.filter((item) => item.module_path).length,
    cli_count: clis.length,
    test_count: inventory.filter((item) => item.test_path).length,
    missing_artifacts: [],
    degraded_artifacts: [],
    validation_only_count: inventory.filter((item) => item.validation_only === true).length,
    proposal_only_count: inventory.filter((item) => item.proposal_only === true).length,
    local_read_only_runtime_count: inventory.filter((item) => item.status === 'local_read_only_runtime_present').length,
    server_runtime_count: 0,
    evidenceRefs: [
      evidenceRef('artifact', `phase-count-${inventory.length}`),
      evidenceRef('artifact', `schema-count-${schemas.length}`),
      evidenceRef('artifact', `cli-count-${clis.length}`),
    ],
  };
}

function normalizeReportedCommands(inputSignals = {}) {
  const fromInput = inputSignals.test_commands_reported
    || inputSignals.testCommands
    || inputSignals.verification?.test_commands_reported
    || inputSignals.verification?.commands
    || [];
  return asArray(fromInput).map((entry) => {
    if (typeof entry === 'string') {
      return {
        command: entry,
        result: null,
        evidenceRefs: [evidenceRef('verification', stableHash(entry).slice(0, 10), 'reported_command')],
      };
    }
    return {
      command: entry.command || entry.cmd || 'unknown-command',
      result: entry.result || entry.status || entry.outcome || null,
      suite_count: entry.suite_count ?? entry.suites ?? null,
      test_count: entry.test_count ?? entry.tests ?? null,
      passed_count: entry.passed_count ?? entry.passed ?? null,
      failed_count: entry.failed_count ?? entry.failed ?? null,
      evidenceRefs: asArray(entry.evidenceRefs).length > 0
        ? entry.evidenceRefs
        : [evidenceRef('verification', stableHash(entry).slice(0, 10), 'reported_command')],
    };
  });
}

function summarizeTestCounts(commands, inputSignals = {}) {
  const supplied = inputSignals.test_result_counts || inputSignals.verification?.test_result_counts;
  if (supplied && typeof supplied === 'object') return clone(supplied);
  const totals = commands.reduce((acc, command) => {
    acc.reported_command_count += 1;
    if (Number.isFinite(Number(command.suite_count))) acc.suite_count += Number(command.suite_count);
    if (Number.isFinite(Number(command.test_count))) acc.test_count += Number(command.test_count);
    if (Number.isFinite(Number(command.passed_count))) acc.passed_count += Number(command.passed_count);
    if (Number.isFinite(Number(command.failed_count))) acc.failed_count += Number(command.failed_count);
    return acc;
  }, {
    reported_command_count: 0,
    suite_count: 0,
    test_count: 0,
    passed_count: 0,
    failed_count: 0,
  });
  return totals;
}

function proofStatus(commands, counts) {
  if (commands.length === 0) return 'unknown';
  const hasResult = commands.some((command) => command.result)
    || Number(counts.test_count || 0) > 0
    || Number(counts.suite_count || 0) > 0
    || Number(counts.passed_count || 0) > 0
    || Number(counts.failed_count || 0) > 0;
  return hasResult ? 'proven_by_reported_command' : 'partial';
}

function verificationSummary(inputSignals = {}) {
  const commands = normalizeReportedCommands(inputSignals);
  const counts = summarizeTestCounts(commands, inputSignals);
  const status = proofStatus(commands, counts);
  return {
    json_parse_status: 'parsed',
    fixture_static_rule_status: 'loaded',
    test_commands_reported: commands,
    test_result_counts: counts,
    test_proof_status: status,
    unknown_or_degraded_proof: status === 'unknown' || status === 'degraded',
    missing_proof_reason: status === 'proven_by_reported_command'
      ? null
      : 'No complete command/result pair was supplied to Phase 13; proof remains limited.',
    no_fake_test_proof: true,
    evidenceRefs: commands.length > 0
      ? commands.flatMap((command) => asArray(command.evidenceRefs))
      : [evidenceRef('verification', 'missing-proof', 'unknown_until_command_reported')],
  };
}

function blockerSummary(inputSignals = {}) {
  const custom = asArray(inputSignals.blocker_summary);
  if (custom.length > 0) return withEvidence(custom, 'blocker');
  return withEvidence([
    {
      blocker_id: DEFAULT_BLOCKER_IDS[0],
      severity: 'high',
      summary: 'Real server runtime remains blocked until identity, signing, auth, storage, deletion, and retention are specified and reviewed.',
      blocked_capability: 'real_server_runtime',
      unblocks_when: 'Server identity, auth, signing, storage, deletion, retention, and replay controls have reviewed contracts and tests.',
    },
    {
      blocker_id: DEFAULT_BLOCKER_IDS[1],
      severity: 'high',
      summary: 'Durable memory/profile commits remain blocked until review gates and eval coverage are promoted beyond proposal records.',
      blocked_capability: 'durable_memory_profile_commit',
      unblocks_when: 'James/Architect review, proposal validation, rollback, and eval gates are satisfied for a write path.',
    },
    {
      blocker_id: DEFAULT_BLOCKER_IDS[2],
      severity: 'high',
      summary: 'Capture, apply, and execution paths remain local-gated and absent from Phase 13 readiness generation.',
      blocked_capability: 'capture_apply_execution',
      unblocks_when: 'Explicit opt-in, local controls, dry-run proof boundaries, and separate execution gates are implemented.',
    },
    {
      blocker_id: DEFAULT_BLOCKER_IDS[3],
      severity: 'medium',
      summary: 'Memory drift lowers confidence for sync readiness and requires read-only review before any durable sync promotion.',
      blocked_capability: 'sync_confidence',
      unblocks_when: 'Missing/orphaned memory references are reviewed and a sync confidence report is generated.',
    },
  ], 'blocker');
}

function nextPhaseRecommendations(inputSignals = {}) {
  const custom = asArray(inputSignals.next_phase_recommendations);
  if (custom.length > 0) return withEvidence(custom, 'recommendation');
  return withEvidence([
    {
      recommendation_id: DEFAULT_NEXT_RECOMMENDATION_IDS[0],
      label: 'Readiness static review',
      risk_tier: 'tier0_read_only',
      allowed: true,
      why_safe: 'It reviews manifest fields and fixture coverage without mutating stores or contacting services.',
      blocked_side_effects: ['network', 'database_write', 'queue', 'send', 'deploy', 'trade', 'runtime_output_file'],
      prerequisites: ['Phase 13 fixture present', 'local artifact inventory available'],
    },
    {
      recommendation_id: DEFAULT_NEXT_RECOMMENDATION_IDS[1],
      label: 'Run local model-free readiness tests if available',
      risk_tier: 'tier1_local_reversible',
      allowed: true,
      why_safe: 'It is a local validation command over static fixtures and should emit stdout JSON or Jest results only.',
      blocked_side_effects: ['network', 'source_store_write', 'memory_profile_commit', 'send', 'deploy', 'trade'],
      prerequisites: ['No output-file mode', 'No external services'],
    },
    {
      recommendation_id: DEFAULT_NEXT_RECOMMENDATION_IDS[2],
      label: 'Server runtime gap spec only',
      risk_tier: 'tier0_read_only',
      allowed: true,
      why_safe: 'It documents remaining server-boundary gaps without starting a process, queue, store, capture path, or action path.',
      blocked_side_effects: ['server_process', 'queue', 'database_write', 'capture', 'apply', 'local_execution'],
      prerequisites: ['Phase 12 server-boundary validation accepted', 'Phase 13 readiness manifest reviewed'],
    },
  ], 'recommendation');
}

function canonicalManifestInput(manifest = {}) {
  return {
    profile: manifest.profile,
    sessionId: manifest.sessionId,
    deviceId: manifest.deviceId,
    phase_inventory: manifest.phase_inventory,
    schema_registry: manifest.schema_registry,
    cli_registry: manifest.cli_registry,
    capability_matrix: manifest.capability_matrix,
    boundary_truth: manifest.boundary_truth,
    artifact_summary: manifest.artifact_summary,
    verification_summary: manifest.verification_summary,
    blocker_summary: manifest.blocker_summary,
    next_phase_recommendations: manifest.next_phase_recommendations,
    side_effect_result: manifest.side_effect_result,
  };
}

function manifestIdempotencyKey(manifest) {
  return `readiness-manifest-idem:${stableHash(canonicalManifestInput(manifest))}`;
}

function buildReadinessManifest(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const inventory = phaseInventory(inputSignals);
  const schemas = schemaRegistry(inputSignals, inventory);
  const clis = cliRegistry(inputSignals, inventory);
  const manifest = {
    schema: READINESS_MANIFEST_SCHEMA_VERSION,
    version: READINESS_VERSION,
    manifest_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    phase_inventory: inventory,
    schema_registry: schemas,
    cli_registry: clis,
    capability_matrix: capabilityMatrix(inputSignals),
    boundary_truth: boundaryTruth(),
    artifact_summary: artifactSummary(inventory, schemas, clis),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(inputSignals),
    next_phase_recommendations: nextPhaseRecommendations(inputSignals),
    evidenceRefs: [
      evidenceRef('manifest', 'phase-13-readiness'),
      evidenceRef('fixture', 'mira-core-readiness-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  manifest.idempotency_key = manifestIdempotencyKey(manifest);
  manifest.manifest_id = `readiness-manifest-${stableHash(manifest.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(manifest);
  return manifest;
}

function resultObject(ok, details = {}) {
  return {
    ok: ok === true,
    ...details,
  };
}

function buildValidationReport(manifest, contract = {}, generatedAt = manifest.generated_at) {
  const validation = validateReadinessManifest(manifest, contract);
  const reasons = validation.checks.filter((check) => !check.ok).map((check) => check.detail || check.id);
  const expectedManifest = contract.expectedReadinessManifestShape || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: READINESS_VERSION,
    validation_run_id: `readiness-validation-${stableHash({
      manifest_key: manifest.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_schema: contract.schema || expectedReport.requiredLiteralValues?.fixture_schema || 'squidrun.mira_core.readiness_contract_fixture.v0',
    readiness_manifest_schema: READINESS_MANIFEST_SCHEMA_VERSION,
    phase_inventory_count: asArray(manifest.phase_inventory).length,
    schema_registry_count: asArray(manifest.schema_registry).length,
    cli_registry_count: asArray(manifest.cli_registry).length,
    fixture_static_rule_count: asArray(contract.staticValidationRules).length,
    acceptance_check_count: asArray(contract.acceptanceChecks).length,
    required_blocker_count: asArray(expectedManifest.requiredBlockerIds || DEFAULT_BLOCKER_IDS).length,
    next_recommendation_count: asArray(manifest.next_phase_recommendations).length,
    phase_inventory_result: validation.resultById['phase-inventory-complete'] || resultObject(false),
    schema_registry_result: validation.resultById['schema-registry-complete'] || resultObject(false),
    cli_registry_result: validation.resultById['cli-registry-no-side-effects'] || resultObject(false),
    capability_boundary_result: validation.resultById['capability-boundary-truth'] || resultObject(false),
    verification_truth_result: validation.resultById['verification-proof-honesty'] || resultObject(false),
    blocker_summary_result: validation.resultById['required-blockers-present'] || resultObject(false),
    next_recommendation_result: validation.resultById['next-recommendations-tier-limited'] || resultObject(false),
    idempotency_result: validation.resultById['idempotency-stable-sensitive'] || resultObject(false),
    forbidden_output_result: validation.resultById['forbidden-private-content-blocked'] || resultObject(false),
    side_effect_result: sideEffectResult(),
    passed: validation.ok,
    reasons,
    evidenceRefs: [
      evidenceRef('validation', manifest.manifest_id, 'readiness_manifest_validation'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreReadiness(options = {}) {
  const contract = options.contract || {};
  const manifest = buildReadinessManifest(options);
  const validation_report = buildValidationReport(manifest, contract, manifest.generated_at);
  const output = {
    readiness_manifest: manifest,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function expectedPhases(contract = {}) {
  const expected = contract.expectedReadinessManifestShape?.phaseInventoryExpected;
  return asArray(expected).length > 0 ? expected : DEFAULT_PHASE_INVENTORY;
}

function expectedSchemas(contract = {}) {
  const expected = contract.expectedReadinessManifestShape?.schemaRegistryExpected;
  return asArray(expected).length > 0 ? expected : DEFAULT_SCHEMA_REGISTRY;
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([path, expected]) => valuesMatch(pathValue(value, path), expected));
}

function sideEffectValuesOk(value = {}, expectedValues = {}) {
  const requiredPresent = REQUIRED_SIDE_EFFECT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
  const expectedOk = Object.entries(expectedValues || {}).every(([field, expected]) => valuesMatch(value[field], expected));
  const countersOk = SIDE_EFFECT_COUNTER_FIELDS.every((field) => value[field] === undefined || Number(value[field]) === 0);
  return requiredPresent
    && expectedOk
    && countersOk
    && value.outputFileWritten !== true
    && value.no_runtime_output_file_written !== false;
}

function phaseInventoryComplete(manifest, contract = {}) {
  const inventory = asArray(manifest.phase_inventory);
  const required = contract.expectedReadinessManifestShape?.phaseInventoryRequiredFields || REQUIRED_MANIFEST_FIELDS;
  const phases = inventory.map((item) => item.phase).sort((a, b) => a - b);
  const expected = expectedPhases(contract);
  const expectedNumbers = expected.map((item) => item.phase);
  return inventory.length === expected.length
    && valuesMatch(phases, expectedNumbers)
    && inventory.every((item) => hasRequiredFields(item, required));
}

function phaseLabelsPreserved(manifest, contract = {}) {
  const inventory = asArray(manifest.phase_inventory);
  return expectedPhases(contract).every((expected) => {
    const actual = inventory.find((item) => item.phase === expected.phase);
    return actual
      && actual.name === expected.name
      && actual.module_path === expected.module_path
      && actual.cli_path === expected.cli_path
      && actual.test_path === expected.test_path
      && actual.fixture_path === expected.fixture_path
      && actual.status === expected.status
      && actual.boundary_mode === expected.boundary_mode
      && actual.validation_only === expected.validation_only
      && actual.proposal_only === expected.proposal_only
      && actual.capability_level === expected.capability_level;
  });
}

function phasePathsDoNotOverclaim(manifest) {
  const unsafeStatusPattern = /(live_server|live_capture|live_apply|live_queue|applied_change|execution_runtime|server_runtime_present|external_send_complete|deploy_complete|trade_complete)/i;
  return asArray(manifest.phase_inventory).every((item) => {
    const text = `${item.status || ''} ${item.boundary_mode || ''} ${item.real_now || ''}`;
    return !unsafeStatusPattern.test(text);
  });
}

function schemaRegistryComplete(manifest, contract = {}) {
  const registry = asArray(manifest.schema_registry);
  const required = contract.expectedReadinessManifestShape?.schemaRegistryRequiredFields || [];
  const expected = expectedSchemas(contract);
  return registry.length === expected.length
    && registry.every((entry) => hasRequiredFields(entry, required))
    && expected.every((expectedEntry) => {
      const actual = registry.find((entry) => entry.phase === expectedEntry.phase);
      return actual
        && actual.name === expectedEntry.name
        && actual.fixture_schema === expectedEntry.fixture_schema
        && valuesMatch(actual.runtime_schemas, expectedEntry.runtime_schemas)
        && valuesMatch(actual.validation_report_schema, expectedEntry.validation_report_schema);
    });
}

function cliRegistryOk(manifest, contract = {}) {
  const registry = asArray(manifest.cli_registry);
  const required = contract.expectedReadinessManifestShape?.cliRegistryRequiredFields || [];
  const requiredValues = contract.expectedReadinessManifestShape?.cliRegistryRequiredValues || {};
  const phaseNumbers = expectedPhases(contract).map((item) => item.phase);
  return registry.length === phaseNumbers.length
    && registry.every((entry) => hasRequiredFields(entry, required)
      && Object.entries(requiredValues).every(([field, expected]) => valuesMatch(entry[field], expected)))
    && phaseNumbers.every((phase) => registry.some((entry) => entry.phase === phase));
}

function capabilityBoundaryOk(manifest, contract = {}) {
  const expected = contract.expectedReadinessManifestShape || {};
  return hasRequiredFields(manifest.capability_matrix, expected.capabilityMatrixRequiredFields || [])
    && Object.entries(expected.capabilityMatrixRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(manifest.capability_matrix?.[field], expectedValue))
    && valuesMatch(manifest.capability_matrix?.allowedNowRiskTiers, expected.allowedNowRiskTiers || ALLOWED_RECOMMENDATION_RISK_TIERS)
    && asArray(manifest.capability_matrix?.blockedRiskTiers).every((tier) => (expected.blockedRiskTiers || []).includes(tier))
    && hasRequiredFields(manifest.boundary_truth, expected.boundaryTruthRequiredFields || [])
    && Object.entries(expected.boundaryTruthRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(manifest.boundary_truth?.[field], expectedValue));
}

function architectCoordinationOk(manifest) {
  const truth = manifest.boundary_truth || {};
  return truth.localArchitectCoordinationRequiresLocalArmsOnline === true
    && truth.serverOriginatedTarget === 'architect'
    && truth.manifestIsExecutionProof === false
    && truth.socketIsBridgeGreenProof === false
    && truth.dryRunLeaseIsModelProcessingProof === false
    && truth.acceptanceRecordIsExecution === false;
}

function verificationTruthOk(manifest, contract = {}) {
  const summary = manifest.verification_summary || {};
  const allowed = contract.expectedReadinessManifestShape?.allowedTestProofStatuses || ALLOWED_TEST_PROOF_STATUSES;
  const commands = asArray(summary.test_commands_reported);
  const counts = summary.test_result_counts || {};
  const hasCounts = Number(counts.test_count || 0) > 0
    || Number(counts.suite_count || 0) > 0
    || Number(counts.passed_count || 0) > 0
    || Number(counts.failed_count || 0) > 0;
  if (summary.no_fake_test_proof !== true) return false;
  if (!allowed.includes(summary.test_proof_status)) return false;
  if (commands.length === 0 && summary.test_proof_status === 'proven_by_reported_command') return false;
  if (summary.test_proof_status === 'proven_by_reported_command' && !hasCounts && !commands.some((command) => command.result)) return false;
  if (commands.length === 0 && summary.unknown_or_degraded_proof !== true) return false;
  return true;
}

function blockersOk(manifest, contract = {}) {
  const blockers = asArray(manifest.blocker_summary);
  const requiredFields = contract.expectedReadinessManifestShape?.blockerSummaryRequiredFields || [];
  const requiredIds = contract.expectedReadinessManifestShape?.requiredBlockerIds || DEFAULT_BLOCKER_IDS;
  return requiredIds.every((id) => blockers.some((blocker) => blocker.blocker_id === id))
    && blockers.every((blocker) => hasRequiredFields(blocker, requiredFields));
}

function recommendationsOk(manifest, contract = {}) {
  const recommendations = asArray(manifest.next_phase_recommendations);
  const requiredFields = contract.expectedReadinessManifestShape?.nextRecommendationRequiredFields || [];
  const requiredIds = contract.expectedReadinessManifestShape?.requiredNextRecommendationIds || DEFAULT_NEXT_RECOMMENDATION_IDS;
  const allowedTiers = contract.expectedReadinessManifestShape?.allowedNextRecommendationRiskTiers || ALLOWED_RECOMMENDATION_RISK_TIERS;
  const forbiddenTiers = [
    ...FORBIDDEN_RECOMMENDATION_RISK_TIERS,
    ...asArray(contract.expectedReadinessManifestShape?.forbiddenNextRecommendationRiskTiers),
  ];
  return requiredIds.every((id) => recommendations.some((item) => item.recommendation_id === id))
    && recommendations.every((item) => hasRequiredFields(item, requiredFields)
      && item.allowed === true
      && allowedTiers.includes(item.risk_tier)
      && !forbiddenTiers.includes(item.risk_tier)
      && String(item.why_safe || '').trim().length > 0
      && asArray(item.evidenceRefs).length > 0);
}

function idempotencyOk(manifest) {
  try {
    return manifest.idempotency_key === manifestIdempotencyKey(manifest);
  } catch {
    return false;
  }
}

function artifactSummaryOk(manifest, contract = {}) {
  const expected = contract.expectedReadinessManifestShape || {};
  return hasRequiredFields(manifest.artifact_summary, expected.artifactSummaryRequiredFields || [])
    && Object.entries(expected.artifactSummaryRequiredValues || {}).every(([field, expectedValue]) => valuesMatch(manifest.artifact_summary?.[field], expectedValue));
}

function validateReadinessManifest(manifest = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, { id, detail, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };

  add('output-shape-complete',
    manifest.schema === READINESS_MANIFEST_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedReadinessManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS),
    'Readiness manifest required fields are missing.');

  add('phase-inventory-complete',
    phaseInventoryComplete(manifest, contract),
    'Phase inventory must contain exactly phases 1 through 12 with required fields.',
    { phase_count: asArray(manifest.phase_inventory).length });

  add('phase-paths-do-not-overclaim',
    phasePathsDoNotOverclaim(manifest),
    'Phase inventory mislabeled a local artifact as live runtime behavior.');

  add('proposal-validation-labels-preserved',
    phaseLabelsPreserved(manifest, contract),
    'Proposal, validation, dry-run, upload, intent, mutation, perception, or server-boundary label changed.');

  add('schema-registry-complete',
    schemaRegistryComplete(manifest, contract),
    'Schema registry is incomplete or drifted from fixture-owned schemas.',
    { schema_registry_count: asArray(manifest.schema_registry).length });

  add('cli-registry-no-side-effects',
    cliRegistryOk(manifest, contract),
    'CLI registry is incomplete or permits side-effect modes.',
    { cli_registry_count: asArray(manifest.cli_registry).length });

  add('capability-boundary-truth',
    capabilityBoundaryOk(manifest, contract),
    'Capability matrix or boundary truth overclaimed server/local capability.');

  add('architect-coordination-not-execution',
    architectCoordinationOk(manifest),
    'Architect coordination was treated as execution or proof.');

  try {
    assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-private-content-blocked', true, null, {
      forbidden_output_result: 'blocked',
      raw_private_content_exported: false,
      secret_like_content_exported: false,
      side_profile_content_exported: false,
    });
  } catch (err) {
    add('forbidden-private-content-blocked', false, err.message, {
      forbidden_output_result: 'failed',
      raw_private_content_exported: true,
    });
  }

  add('verification-proof-honesty',
    verificationTruthOk(manifest, contract),
    'Verification summary faked proof or omitted unknown/degraded status.');

  add('required-blockers-present',
    blockersOk(manifest, contract),
    'Required readiness blockers are missing.');

  add('next-recommendations-tier-limited',
    recommendationsOk(manifest, contract),
    'Next recommendations included a disallowed risk tier or missing safety metadata.');

  add('idempotency-stable-sensitive',
    idempotencyOk(manifest),
    'Readiness manifest idempotency key is unstable or insensitive.',
    { excludes: ['generated_at', 'manifest_id', 'validation_run_id'] });

  add('side-effect-truth',
    sideEffectValuesOk(manifest.side_effect_result, contract.expectedValidationReportShape?.sideEffectRequiredValues || {}),
    'Phase 13 side-effect truth is unsafe.');

  add('artifact-summary-complete',
    artifactSummaryOk(manifest, contract),
    'Artifact summary is incomplete.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function validateMiraCoreReadinessOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const manifest = output.readiness_manifest || {};
  const report = output.validation_report || {};
  const manifestValidation = validateReadinessManifest(manifest, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && manifest.schema === READINESS_MANIFEST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedReadinessManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Readiness output, manifest, or validation report shape is incomplete.');

  for (const check of manifestValidation.checks) {
    add(check.id, check.ok, check.detail);
  }

  add('validation-report-literals',
    Object.entries(contract.expectedValidationReportShape?.requiredLiteralValues || {}).every(([field, expected]) => valuesMatch(report[field], expected)),
    'Validation report literal values changed.');

  add('manifest-literal-values',
    literalValuesOk(manifest, contract.expectedReadinessManifestShape?.requiredLiteralValues || {}),
    'Manifest literal boundary values changed.');

  add('validation-side-effect-truth',
    sideEffectValuesOk(report.side_effect_result, contract.expectedValidationReportShape?.sideEffectRequiredValues || {}),
    'Validation report side-effect truth is unsafe.');

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
      throw new Error(`readiness_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_RECOMMENDATION_RISK_TIERS,
  ALLOWED_TEST_PROOF_STATUSES,
  DEFAULT_BLOCKER_IDS,
  DEFAULT_NEXT_RECOMMENDATION_IDS,
  DEFAULT_PHASE_INVENTORY,
  DEFAULT_SCHEMA_REGISTRY,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  READINESS_MANIFEST_SCHEMA_VERSION,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreReadiness,
  canonicalManifestInput,
  manifestIdempotencyKey,
  stableHash,
  validateMiraCoreReadinessOutput,
};
