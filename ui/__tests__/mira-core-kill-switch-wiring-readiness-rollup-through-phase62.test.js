const killSwitchWiringReadinessRollupThroughPhase63Contract = require('./fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase62-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_DRY_CHECK_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE63_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase63,
  killSwitchWiringReadinessRollupThroughPhase63IdempotencyKey,
  validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase63Output,
} = require('../modules/mira-core/kill-switch-wiring-readiness-rollup-through-phase62');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-readiness-rollup-through-phase62');

const PHASE53_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase53', 'boundary_refresh_summary'].join('_');
const PHASE54_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase54', 'boundary_refresh_summary'].join('_');
const PHASE55_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase55', 'boundary_refresh_summary'].join('_');
const PHASE56_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase56', 'boundary_refresh_summary'].join('_');
const PHASE57_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase57', 'boundary_refresh_summary'].join('_');
const PHASE58_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase58', 'boundary_refresh_summary'].join('_');
const PHASE59_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase59', 'boundary_refresh_summary'].join('_');
const PHASE60_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase60', 'boundary_refresh_summary'].join('_');
const PHASE61_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase61', 'boundary_refresh_summary'].join('_');
const PHASE62_BOUNDARY_REFRESH_SUMMARY_FIELD = ['phase62', 'boundary_refresh_summary'].join('_');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase63({
    contract: killSwitchWiringReadinessRollupThroughPhase63Contract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function rollup(output) {
  return output.kill_switch_wiring_readiness_rollup_through_phase62;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeRollupKey(output) {
  rollup(output).idempotency_key =
    killSwitchWiringReadinessRollupThroughPhase63IdempotencyKey(rollup(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase63Output(
    output,
    killSwitchWiringReadinessRollupThroughPhase63Contract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring readiness rollup through Phase62 v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringReadinessRollupThroughPhase63Contract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(rollup(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE63_SCHEMA_VERSION);
    expect(rollup(output).version).toBe(0);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(rollup(output), killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_DRY_CHECK_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringReadinessRollupThroughPhase63Contract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      schema: killSwitchWiringReadinessRollupThroughPhase63Contract.expectedOutputShape.reportSchema,
      fixture_path: 'ui/__tests__/fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase62-contract.json',
      baseline_commit: BASELINE_COMMIT,
      decision: 'accepted_validation_only',
      status: killSwitchWiringReadinessRollupThroughPhase63Contract.expectedValidationReportShape.requiredLiteralValues.status,
      caveats: [],
    }));
    expect(validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase63Output(output, killSwitchWiringReadinessRollupThroughPhase63Contract))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringReadinessRollupThroughPhase63Contract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline ef02359, registries through Phase 62, and exact commit chain', () => {
    const current = rollup(build());
    const expected = killSwitchWiringReadinessRollupThroughPhase63Contract.phaseRegistryExpected;
    const counts = killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringReadinessRollupThroughPhase63Contract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      expected_phases: expected.expected_phases,
      current_through_phase: counts.phase_inventory_count,
      phase_inventory_count: counts.phase_inventory_count,
      schema_registry_count:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.schema_registry_count'],
      cli_registry_count:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.cli_registry_count'],
      phase35_current: true,
      phase48_current: true,
      phase49_current: true,
      phase50_current: true,
      phase51_current: true,
      phase52_current: true,
      phase52_readiness_rollup_validation_current: true,
      phase53_current: true,
      phase53_commit: expected.current_truth.phase53_commit,
      phase53_readiness_rollup_validation_current: true,
      phase54_current: true,
      phase54_commit: expected.current_truth.phase54_commit,
      phase54_readiness_rollup_validation_current: true,
      phase55_current: true,
      phase55_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase55_commit'],
      phase55_readiness_rollup_validation_current: true,
      phase56_current: true,
      phase56_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase56_commit'],
      phase56_readiness_rollup_validation_current: true,
      phase57_current: true,
      phase57_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase57_commit'],
      phase57_readiness_rollup_validation_current: true,
      phase58_current: true,
      phase58_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase58_commit'],
      phase58_readiness_rollup_validation_current: true,
      phase59_current: true,
      phase59_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase59_commit'],
      phase59_readiness_rollup_validation_current: true,
      phase60_current: true,
      phase60_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase60_commit'],
      phase60_readiness_rollup_validation_current: true,
      phase61_current: true,
      phase61_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase61_commit'],
      phase61_readiness_rollup_validation_current: true,
      phase62_current: true,
      phase62_commit:
        killSwitchWiringReadinessRollupThroughPhase63Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase62_commit'],
      phase62_readiness_rollup_validation_current: true,
      phase62_duplicate_registry_count_closure_current: true,
    }));
    expect(current.phase_registry.phase52_delta).toEqual(expect.objectContaining(expected.phase52_delta));
    expect(current.phase_registry.phase53_delta).toEqual(expect.objectContaining(expected.phase53_delta));
    expect(current.phase_registry.phase54_delta).toEqual(expect.objectContaining(expected.phase54_delta));
    expect(current.phase_registry.phase55_delta).toEqual(expect.objectContaining(expected.phase55_delta));
    expect(current.phase_registry.phase56_delta).toEqual(expect.objectContaining(expected.phase56_delta));
    expect(current.phase_registry.phase57_delta).toEqual(expect.objectContaining(expected.phase57_delta));
    expect(current.phase_registry.phase58_delta).toEqual(expect.objectContaining(expected.phase58_delta));
    expect(current.phase_registry.phase59_delta).toEqual(expect.objectContaining(expected.phase59_delta));
    expect(current.phase_registry.phase60_delta).toEqual(expect.objectContaining(expected.phase60_delta));
    expect(current.phase_registry.phase61_delta).toEqual(expect.objectContaining(expected.phase61_delta));
    expect(current.phase_registry.phase62_delta).toEqual(expect.objectContaining(expected.phase62_delta));
    expect(current.schema_registry.count).toBe(counts.schema_registry_count);
    expect(current.cli_registry.count).toBe(counts.cli_registry_count);
    expect(current.schema_registry.entries).toHaveLength(counts.schema_registry_count);
    expect(current.cli_registry.entries).toHaveLength(counts.cli_registry_count);
    expect(current.commit_chain).toEqual(killSwitchWiringReadinessRollupThroughPhase63Contract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(counts.commit_chain_count);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves Phase62 source truth, stale truth, closure chain, and source refs', () => {
    const current = rollup(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.sourceRecommendation,
    ));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.currentTruthExpected,
    ));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase34PriorRecommendationsExpected,
    ));
    expect(current.closure_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #200');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #206');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #214');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #222');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #231');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #236');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #241');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #246');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #256');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #265');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #271');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #278');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #282');
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #284');
    expect(current.source_refs).toEqual(killSwitchWiringReadinessRollupThroughPhase63Contract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.source_ref_count);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase50-kill-switch-wiring-readiness-rollup-through-phase49'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase51-kill-switch-wiring-readiness-rollup-through-phase50'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase52-kill-switch-wiring-readiness-rollup-through-phase51'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase53-kill-switch-wiring-readiness-rollup-through-phase52'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase54-kill-switch-wiring-readiness-rollup-through-phase53'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase55-kill-switch-wiring-readiness-rollup-through-phase54'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase56-kill-switch-wiring-readiness-rollup-through-phase55'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase57-kill-switch-wiring-readiness-rollup-through-phase56'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase58-kill-switch-wiring-readiness-rollup-through-phase57'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase59-kill-switch-wiring-readiness-rollup-through-phase58'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase60-kill-switch-wiring-readiness-rollup-through-phase59'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase61-kill-switch-wiring-readiness-rollup-through-phase60'))
      .toBe(true);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase62-kill-switch-wiring-readiness-rollup-through-phase61'))
      .toBe(true);
  });

  test('binds the Phase62 readiness rollup plus Phase49/Phase50/Phase51/Phase52/Phase53/Phase54/Phase55/Phase56/Phase57/Phase58/Phase59/Phase60/Phase61/Phase62 evidence summaries', () => {
    const current = rollup(build());

    expect(current.readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.readinessRollupSummaryExpected,
    ));
    expect(current.phase49_boundary_refresh_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase49BoundaryRefreshSummaryExpected,
    ));
    expect(current.phase50_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase50ReadinessRollupSummaryExpected,
    ));
    expect(current.phase51_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase51ReadinessRollupSummaryExpected,
    ));
    expect(current.phase52_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase52ReadinessRollupSummaryExpected,
    ));
    expect(current.phase53_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase53ReadinessRollupSummaryExpected,
    ));
    expect(current.phase54_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase54ReadinessRollupSummaryExpected,
    ));
    expect(current.phase55_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase55ReadinessRollupSummaryExpected,
    ));
    expect(current.phase56_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase56ReadinessRollupSummaryExpected,
    ));
    expect(current.phase57_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase57ReadinessRollupSummaryExpected,
    ));
    expect(current.phase58_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase58ReadinessRollupSummaryExpected,
    ));
    expect(current.phase59_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase59ReadinessRollupSummaryExpected,
    ));
    expect(current.phase60_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase60ReadinessRollupSummaryExpected,
    ));
    expect(current.phase61_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase61ReadinessRollupSummaryExpected,
    ));
    expect(current.phase62_readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.phase62ReadinessRollupSummaryExpected,
    ));
    expect(current).not.toHaveProperty(PHASE53_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE54_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE55_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE56_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE57_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE58_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE59_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE60_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE61_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current).not.toHaveProperty(PHASE62_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(current.noop_boundary_refresh_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.noopBoundaryRefreshSummaryExpected,
    ));
    expect(current.noop_boundary_status).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.noopBoundaryStatusExpected,
    ));
    expect(current.readiness_rollup_summary).toEqual(expect.objectContaining({
      decision: 'remain_kill_switch_wiring_readiness_rollup_contract_only',
      current_through_phase: 62,
      selected_source_recommendation: 'phase63-kill-switch-wiring-readiness-rollup-through-phase62-contract',
      satisfied_prior_recommendation: 'phase63-kill-switch-wiring-readiness-rollup-through-phase61-validator',
      phase49_validator_satisfied: true,
      phase50_validator_satisfied: true,
      phase51_validator_satisfied: true,
      phase52_validator_satisfied: true,
      phase53_validator_satisfied: true,
      phase54_validator_satisfied: true,
      phase55_validator_satisfied: true,
      phase56_validator_satisfied: true,
      phase57_validator_satisfied: true,
      phase58_validator_satisfied: true,
      phase59_validator_satisfied: true,
      phase60_validator_satisfied: true,
      phase61_validator_satisfied: true,
      phase62_validator_satisfied: true,
      phase62_duplicate_registry_count_closure_carried: true,
      phase_registry_schema_registry_count_bound_to_expected_count: true,
      phase_registry_cli_registry_count_bound_to_expected_count: true,
      phase22_date_sensitive_expiry_caveat: 'non_authorizing_non_blocking_out_of_scope',
      phase22_caveat_blocks_phase60_fixture: false,
      phase22_caveat_blocks_phase61_fixture: false,
      phase22_caveat_blocks_phase62_fixture: false,
      phase22_caveat_blocks_phase63_fixture: false,
      phase22_caveat_authorizes_runtime: false,
      ready_for_runtime_now: false,
      ready_for_kill_switch_wiring_now: false,
      authorizes_runtime: false,
      authorizes_kill_switch_wiring: false,
      authorizes_output_file: false,
    }));
    expect(current.phase49_boundary_refresh_summary).toEqual(expect.objectContaining({
      committed_baseline: '17441a8',
      validation_green: true,
      targeted_tests: '18/18',
      combined_mira_core_tests: '49 suites / 777 tests',
      oracle_review_ref: 'ORACLE #194',
      builder_report_ref: 'BUILDER #301',
      remains_validation_only: true,
      no_runtime_performed: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase50_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '6ecba39',
      validation_green: true,
      targeted_tests: '14/14',
      combined_mira_core_tests: '50 suites / 791 tests',
      oracle_review_ref: 'ORACLE #200',
      builder_report_ref: 'BUILDER #306',
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase51_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '35febf1',
      validation_green: true,
      targeted_tests: '14/14',
      combined_mira_core_tests: '51 suites / 805 tests',
      oracle_review_ref: 'ORACLE #206',
      builder_report_ref: 'BUILDER #314',
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase52_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '3de1b93',
      validation_green: true,
      targeted_tests: '14/14',
      combined_mira_core_tests: '52 suites / 819 tests',
      oracle_review_ref: 'ORACLE #214',
      builder_report_ref: 'BUILDER #317',
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase53_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '08881c8',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #222',
      builder_report_ref: 'BUILDER #323',
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase54_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: 'a225381',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #231',
      builder_report_ref: 'BUILDER #334',
      builder_commit_ref: 'BUILDER #335',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase55_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '2d3101e',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #236',
      builder_report_ref: 'BUILDER #337',
      builder_commit_ref: 'BUILDER #338',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase56_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: 'a7dd3d6',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #241',
      builder_report_ref: 'BUILDER #340',
      builder_commit_ref: 'BUILDER #341',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase57_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '559d651',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #246',
      builder_report_ref: 'BUILDER #344',
      builder_commit_ref: 'BUILDER #345',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase58_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '02d48cc',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #256',
      builder_initial_report_ref: 'BUILDER #348',
      builder_patch_report_ref: 'BUILDER #349',
      builder_commit_ref: 'BUILDER #350',
      scoped_status_closure: 'scoped_phase58_through_phase57_files_only_bound_and_stale_phase56_rejected',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase59_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: 'ea795c8',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #265',
      builder_report_ref: 'BUILDER #354',
      scoped_status_closure: 'scoped_phase59_through_phase58_files_only_bound_and_stale_phase56_and_phase58_rejected',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase60_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '7ee9ea4',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #271',
      builder_report_ref: 'BUILDER #358',
      scoped_status_closure: 'scoped_phase60_through_phase59_files_only_bound_and_stale_phase56_phase58_phase59_rejected',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase61_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: '2b0457b',
      validation_green: true,
      targeted_tests: '14/14',
      oracle_review_ref: 'ORACLE #278',
      builder_report_ref: 'BUILDER #361',
      scoped_status_closure: 'scoped_phase61_through_phase60_files_only_bound_and_stale_phase56_phase58_phase59_phase60_rejected',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.phase62_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: BASELINE_COMMIT,
      validation_green: true,
      oracle_must_fix_ref: 'ORACLE #282',
      builder_patch_ref: 'BUILDER #367',
      oracle_review_ref: 'ORACLE #284',
      duplicate_registry_count_closure: 'phase_registry_schema_registry_count_and_cli_registry_count_bound_to_expectedCounts_62_in_phase63_with_phase62_closure_carried',
      scoped_status_closure: 'scoped_phase62_through_phase61_files_only_bound_and_stale_phase56_phase58_phase59_phase60_phase61_rejected',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      no_output_file_written: true,
      does_not_authorize_runtime: true,
      does_not_authorize_kill_switch_wiring: true,
    }));
  });

  test('preserves disabled runtime, no-op, env/config, kill-switch, gap, and blocked-slice boundaries', () => {
    const current = rollup(build());
    const counts = killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts;

    for (const [field, shape] of [
      ['runtime_mode_boundary', killSwitchWiringReadinessRollupThroughPhase63Contract.runtimeModeBoundaryShapeExpected],
      ['flag_reader_boundary', killSwitchWiringReadinessRollupThroughPhase63Contract.flagReaderBoundaryShapeExpected],
      ['env_config_read_boundary', killSwitchWiringReadinessRollupThroughPhase63Contract.envConfigReadBoundaryShapeExpected],
      ['kill_switch_boundary', killSwitchWiringReadinessRollupThroughPhase63Contract.killSwitchBoundaryShapeExpected],
      ['kill_switch_wiring_boundary', killSwitchWiringReadinessRollupThroughPhase63Contract.killSwitchWiringBoundaryShapeExpected],
    ]) {
      expect(current[field]).toEqual(expect.objectContaining(shape.requiredValues));
    }
    expect(current.noop_dry_check_request_contract).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.noopDryCheckRequestContractExpected,
    ));
    expect(current.noop_dry_check_result_contract).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.noopDryCheckResultContractExpected,
    ));
    expect(current.prerequisite_gap_matrix).toHaveLength(counts.prerequisite_gap_count);
    expect(current.readiness_gap_matrix).toHaveLength(counts.readiness_gap_count);
    expect(current.preimplementation_checklist_gaps).toHaveLength(counts.preimplementation_checklist_gap_count);
    expect(current.noop_dry_check_items).toHaveLength(counts.noop_dry_check_item_count);
    expect(current.blocked_future_slices).toHaveLength(counts.blocked_future_slice_count);
    expect(current.prerequisite_gap_matrix.every((item) => item.satisfied_now === false)).toBe(true);
    expect(current.readiness_gap_matrix.every((item) => item.satisfied_now === false)).toBe(true);
    expect(current.preimplementation_checklist_gaps.every((item) => item.satisfied_now === false)).toBe(true);
    expect(current.noop_dry_check_items.every((item) => (
      item.satisfied_now === false
      && item.authorizes_runtime === false
      && item.authorizes_kill_switch_wiring === false
    ))).toBe(true);
    expect(current.blocked_future_slices.every((slice) => slice.implementation_allowed_now === false)).toBe(true);
  });

  test('preserves capability, proof, redaction, boundary, and no-side-effect truth', () => {
    const output = build();
    const current = rollup(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.capabilityMatrixExpected,
    ));
    expect(current.proof_boundaries).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.proofBoundaryExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining({
      no_runtime_server_listener_routes: true,
      no_ui_browser_window_capture: true,
      no_network: true,
      no_db_store_file_migration_write: true,
      no_queue_or_lease: true,
      no_env_config_flag_read: true,
      no_auth_key_secret: true,
      no_local_execution_shell_pty: true,
      no_control_execution_or_reporting_sink: true,
      no_send_deploy_trade: true,
      no_output_file: true,
    }));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_exported: false,
      secret_material_exported: false,
      raw_config_exported: false,
    }));
    for (const field of Object.keys(killSwitchWiringReadinessRollupThroughPhase63Contract.sideEffectTruthExpected)) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.envRead).toBe(false);
    expect(current.side_effect_result.killSwitchLiveCheckPerformed).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are fixture-owned Tier0/Tier1 and non-authorizing', () => {
    const current = rollup(build());

    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      killSwitchWiringReadinessRollupThroughPhase63Contract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    expect(current.next_phase_recommendations).toHaveLength(
      killSwitchWiringReadinessRollupThroughPhase63Contract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.does_not_authorize_kill_switch_wiring).toBe(true);
      expect(recommendation.does_not_authorize_live_check).toBe(true);
      expect(recommendation.does_not_authorize_output_files).toBe(true);
    }
  });

  test('validation report binds static rules, acceptance checks, tamper cases, literals, and paths', () => {
    const output = build();
    const validation = validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase63Output(
      output,
      killSwitchWiringReadinessRollupThroughPhase63Contract,
    );

    expect(validation.ok).toBe(true);
    expect(report(output).static_rule_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringReadinessRollupThroughPhase63Contract.staticValidationRules.map((entry) => entry.id));
    expect(report(output).acceptance_check_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringReadinessRollupThroughPhase63Contract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).static_rule_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.static_rule_min_count,
    );
    expect(report(output).acceptance_check_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.acceptance_check_min_count,
    );
    expect(report(output).tamper_case_results).toHaveLength(killSwitchWiringReadinessRollupThroughPhase63Contract.tamperCases.length);
    expect(report(output).tamper_case_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.tamper_case_min_count,
    );
    expect(report(output).required_literal_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.required_literal_min_count,
    );
    expect(report(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.source_ref_count,
    );
    expect(report(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).forbidden_output_scan.ok).toBe(true);
    expect(report(output).unsafe_action_scan.ok).toBe(true);
    expect(report(output).scoped_status).toEqual(expect.objectContaining({
      only_fixture_changed_before_builder: true,
      scoped_phase63_through_phase62_files_only: true,
      unrelated_files_untouched: true,
    }));
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase56_files_only');
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase58_through_phase57_files_only');
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase59_through_phase58_files_only');
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase60_through_phase59_files_only');
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase61_through_phase60_files_only');
    expect(report(output).scoped_status).not.toHaveProperty('scoped_phase62_through_phase61_files_only');
  });

  test('idempotency is stable for equivalent input and sensitive to scope and rollup facts', () => {
    const first = rollup(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = rollup(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = rollup(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = rollup(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.rollup_id).toBe(second.rollup_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    const originalKey = rollup(tampered).idempotency_key;
    rollup(tampered).readiness_rollup_summary.ready_for_kill_switch_wiring_now = true;
    recomputeRollupKey(tampered);
    expect(rollup(tampered).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(tampered, 'accept-readiness-rollup-contract-only');
  });

  test('validator rejects baseline, registry, source, stale, closure, summary, and path drift', () => {
    const cases = [
      ['accept-schema-baseline-08881c8', (output) => { rollup(output).baseline_commit = 'd57e546'; }],
      ['accept-registries-48-48-48', (output) => { rollup(output).phase_registry.phase_inventory_count = 48; }],
      ['accept-registries-48-48-48', (output) => { rollup(output).phase_registry.schema_registry_count = 60; }],
      ['accept-registries-48-48-48', (output) => { rollup(output).phase_registry.cli_registry_count = 60; }],
      ['accept-phase62-duplicate-registry-count-closure-carried', (output) => { rollup(output).phase_registry.schema_registry_count = 61; }],
      ['accept-phase62-duplicate-registry-count-closure-carried', (output) => { rollup(output).phase_registry.cli_registry_count = 61; }],
      ['accept-phase62-duplicate-registry-count-closure-carried', (output) => { rollup(output).readiness_rollup_summary.phase62_duplicate_registry_count_closure_carried = false; }],
      ['accept-registries-48-48-48', (output) => { rollup(output).schema_registry.count = 48; }],
      ['accept-registries-48-48-48', (output) => { rollup(output).cli_registry.count = 48; }],
      ['accept-commit-chain-36-ending-08881c8', (output) => { rollup(output).commit_chain.pop(); }],
      ['accept-phase53-validator-satisfied', (output) => { rollup(output).satisfied_prior_recommendations[0].status = 'open'; }],
      ['accept-phase53-readiness-rollup-selected', (output) => { rollup(output).source_recommendation.recommendation_id = 'wrong'; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase49_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase52_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase52_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase52_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase52_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase52_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase52_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase52_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase53_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase53_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase53_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase53_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase53_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase53_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase53_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase54_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase54_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase54_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase54_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase54_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase54_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase54_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase55_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase55_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase55_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase55_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase55_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase55_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase55_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase56_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase56_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase56_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase56_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase56_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase56_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase56_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase57_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase57_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase57_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase57_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase57_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase57_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase57_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase58_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase58_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase58_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase58_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase58_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase58_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase58_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase59_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase59_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase59_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase59_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase59_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase59_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase59_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase60_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase60_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase60_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase60_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase60_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase60_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).phase_registry.phase60_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase62_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase62_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase62_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).current_truth.phase62_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { delete rollup(output).current_truth.phase62_readiness_rollup_validation_current; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase62_readiness_rollup_validation_current = false; }],
      ['accept-phase35-through-49-current', (output) => { rollup(output).phase_registry.phase62_duplicate_registry_count_closure_current = false; }],
      ['accept-stale-phase13-23-31', (output) => { rollup(output).stale_readiness.phase31_stale = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_214_phase52_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_222_phase53_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_236_phase55_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_241_phase56_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_246_phase57_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_256_phase58_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_265_phase59_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_271_phase60_review_closure_carried = false; }],
      ['accept-oracle-closure-through-200', (output) => { rollup(output).closure_summary.oracle_284_phase62_review_closure_carried = false; }],
      ['accept-source-refs-include-phase50', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase50-kill-switch-wiring-readiness-rollup-through-phase49'); }],
      ['accept-source-refs-include-phase51', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase51-kill-switch-wiring-readiness-rollup-through-phase50'); }],
      ['accept-source-refs-include-phase53', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase53-kill-switch-wiring-readiness-rollup-through-phase52'); }],
      ['accept-source-refs-include-phase54', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase54-kill-switch-wiring-readiness-rollup-through-phase53'); }],
      ['accept-source-refs-include-phase55', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase55-kill-switch-wiring-readiness-rollup-through-phase54'); }],
      ['accept-source-refs-include-phase56', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase56-kill-switch-wiring-readiness-rollup-through-phase55'); }],
      ['accept-source-refs-include-phase57', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase57-kill-switch-wiring-readiness-rollup-through-phase56'); }],
      ['accept-source-refs-include-phase58', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase58-kill-switch-wiring-readiness-rollup-through-phase57'); }],
      ['accept-source-refs-include-phase59', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase59-kill-switch-wiring-readiness-rollup-through-phase58'); }],
      ['accept-source-refs-include-phase60', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase60-kill-switch-wiring-readiness-rollup-through-phase59'); }],
      ['accept-source-refs-include-phase62', (output) => { rollup(output).source_refs = rollup(output).source_refs.filter((ref) => ref.artifact_id !== 'phase62-kill-switch-wiring-readiness-rollup-through-phase61'); }],
      ['accept-readiness-rollup-contract-only', (output) => { rollup(output).readiness_rollup_summary.ready_for_runtime_now = true; }],
      ['accept-readiness-rollup-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.authorizes_runtime = true; }],
      ['accept-readiness-rollup-through-phase53-contract-only', (output) => { rollup(output).readiness_rollup_summary.ready_for_kill_switch_wiring_now = true; }],
      ['accept-readiness-rollup-through-phase53-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.authorizes_output_file = true; }],
      ['static-phase50-readiness-rollup-still-evidence-only', (output) => { rollup(output).phase50_readiness_rollup_summary.validation_green = false; }],
      ['static-phase51-readiness-rollup-still-evidence-only', (output) => { rollup(output).phase51_readiness_rollup_summary.validation_green = false; }],
      ['static-phase52-readiness-rollup-still-evidence-only', (output) => { rollup(output).phase52_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase53-readiness-rollup-current', (output) => { rollup(output).phase53_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase54-readiness-rollup-current', (output) => { rollup(output).phase54_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase55-readiness-rollup-current', (output) => { rollup(output).phase55_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase56-readiness-rollup-current', (output) => { rollup(output).phase56_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase57-readiness-rollup-current', (output) => { rollup(output).phase57_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase58-readiness-rollup-current', (output) => { rollup(output).phase58_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase59-readiness-rollup-current', (output) => { rollup(output).phase59_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase59-scoped-status-closure-carried', (output) => { rollup(output).phase59_readiness_rollup_summary.scoped_status_closure = 'missing'; }],
      ['accept-phase60-readiness-rollup-current', (output) => { rollup(output).phase60_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase60-scoped-status-closure-carried', (output) => { rollup(output).phase60_readiness_rollup_summary.scoped_status_closure = 'missing'; }],
      ['accept-phase22-caveat-non-blocking-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.phase22_caveat_blocks_phase60_fixture = true; }],
      ['accept-phase22-caveat-non-blocking-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.phase22_caveat_blocks_phase61_fixture = true; }],
      ['accept-phase22-caveat-non-blocking-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.phase22_caveat_blocks_phase63_fixture = true; }],
      ['accept-readiness-rollup-through-phase54-contract-only', (output) => { rollup(output).readiness_rollup_summary.ready_for_noop_execution_now = true; }],
      ['accept-readiness-rollup-through-phase54-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.authorizes_output_file = true; }],
      ['accept-readiness-rollup-through-phase61-contract-only', (output) => { rollup(output).readiness_rollup_summary.ready_for_dry_run_now = true; }],
      ['accept-readiness-rollup-through-phase61-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.authorizes_output_file = true; }],
      ['accept-readiness-rollup-through-phase62-contract-only', (output) => { rollup(output).readiness_rollup_summary.ready_for_dry_run_now = true; }],
      ['accept-readiness-rollup-through-phase62-non-authorizing', (output) => { rollup(output).readiness_rollup_summary.authorizes_output_file = true; }],
      ['accept-phase62-readiness-rollup-current', (output) => { rollup(output).phase62_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase62-scoped-status-closure-carried', (output) => { rollup(output).phase62_readiness_rollup_summary.scoped_status_closure = 'missing'; }],
      ['accept-no-phase53-hybrid-artifact', (output) => { rollup(output)[PHASE53_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase54-hybrid-artifact', (output) => { rollup(output)[PHASE54_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase55-hybrid-artifact', (output) => { rollup(output)[PHASE55_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase56-hybrid-artifact', (output) => { rollup(output)[PHASE56_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase57-hybrid-artifact', (output) => { rollup(output)[PHASE57_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase58-hybrid-artifact', (output) => { rollup(output)[PHASE58_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase59-hybrid-artifact', (output) => { rollup(output)[PHASE59_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase60-hybrid-artifact', (output) => { rollup(output)[PHASE60_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
      ['accept-no-phase62-hybrid-artifact', (output) => { rollup(output)[PHASE62_BOUNDARY_REFRESH_SUMMARY_FIELD] = { hybrid: true }; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeRollupKey(output);
      expectValidatorFails(output, checkId);
    }

    const pathLie = clone(build());
    report(pathLie).referenced_path_results[0].exists = false;
    report(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
  });

  test('validator rejects no-op contract, boundary, matrix, capability, proof, and side-effect drift', () => {
    const cases = [
      ['accept-noop-refresh-contract-only', (output) => { rollup(output).noop_boundary_refresh_summary.noop_would_read_flag = true; }],
      ['accept-noop-boundary-status-blocked', (output) => { rollup(output).noop_boundary_status.noop_execution_allowed = true; }],
      ['accept-noop-request-no-read', (output) => { rollup(output).noop_dry_check_request_contract.no_env_config_flag_read = false; }],
      ['accept-noop-result-no-proof', (output) => { rollup(output).noop_dry_check_result_contract.no_live_check_performed = false; }],
      ['accept-runtime-mode-default-off', (output) => { rollup(output).runtime_mode_boundary.disabled = false; }],
      ['accept-runtime-mode-unimplemented', (output) => { rollup(output).runtime_mode_boundary.implemented = true; }],
      ['accept-flag-reader-false', (output) => { rollup(output).flag_reader_boundary.flagReadNow = true; }],
      ['accept-no-env-read', (output) => { rollup(output).flag_reader_boundary.envReadNow = true; }],
      ['accept-no-secret-read', (output) => { rollup(output).flag_reader_boundary.secretReadNow = true; }],
      ['accept-kill-wired-false', (output) => { rollup(output).kill_switch_boundary.killWired = true; }],
      ['accept-live-check-false', (output) => { rollup(output).kill_switch_boundary.liveCheck = true; }],
      ['accept-wiring-available-false', (output) => { rollup(output).kill_switch_wiring_boundary.killSwitchWiringAvailable = true; }],
      ['accept-prerequisite-gaps-unsatisfied', (output) => { rollup(output).prerequisite_gap_matrix[0].satisfied_now = true; }],
      ['accept-readiness-gaps-unsatisfied', (output) => { rollup(output).readiness_gap_matrix[0].satisfied_now = true; }],
      ['accept-preimplementation-gaps-unsatisfied', (output) => { rollup(output).preimplementation_checklist_gaps[0].satisfied_now = true; }],
      ['accept-noop-items-non-authorizing', (output) => { rollup(output).noop_dry_check_items[0].authorizes_kill_switch_wiring = true; }],
      ['accept-blocked-future-slices-five', (output) => { rollup(output).blocked_future_slices[0].implementation_allowed_now = true; }],
      ['accept-capability-false', (output) => { rollup(output).capability_matrix.serverCanExecuteLocal = true; }],
      ['accept-capability-false', (output) => { rollup(output).capability_matrix.readinessRollupAvailable = true; }],
      ['accept-direct-targets-blocked', (output) => {
        rollup(output).capability_matrix.directBuilderOracleServerTargetsBlocked = false;
        rollup(output).proof_boundaries.builder_oracle_direct_server_target_allowed = true;
      }],
      ['accept-proof-boundaries-false', (output) => { rollup(output).proof_boundaries.socket_is_bridge_green = true; }],
      ['accept-proof-boundaries-false', (output) => { rollup(output).proof_boundaries.readiness_rollup_is_live_check_proof = true; }],
      ['accept-side-effect-truth', (output) => {
        rollup(output).side_effect_result.no_output_file_written = false;
        rollup(output).side_effect_result.outputFileWritten = true;
      }],
      ['accept-forbidden-substrings', (output) => { rollup(output).redaction_summary.note = 'runtime started'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeRollupKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects unsafe action drift and Tier2+ recommendations after idempotency recompute', () => {
    for (const phrase of killSwitchWiringReadinessRollupThroughPhase63Contract.unsafeActionPhrases) {
      const output = clone(build());
      rollup(output).next_phase_recommendations[0].safe_next_action = `safe to ${phrase}`;
      recomputeRollupKey(output);
      expectValidatorFails(output, 'accept-unsafe-action-phrases');
    }

    const tier2 = clone(build());
    rollup(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeRollupKey(tier2);
    expectValidatorFails(tier2, 'accept-next-recs-tier0-tier1');
  });

  test('validator rejects validation-report lies, missing tamper coverage, and literal result lies', () => {
    const staticLie = clone(build());
    report(staticLie).static_rule_results[0].ok = false;
    expectValidatorFails(staticLie, 'validation-report-matches-contract');

    const acceptanceLie = clone(build());
    report(acceptanceLie).acceptance_check_results[0].ok = false;
    expectValidatorFails(acceptanceLie, 'validation-report-matches-contract');

    const missingTamper = clone(build());
    report(missingTamper).tamper_case_results = [];
    expectValidatorFails(missingTamper, 'validation-report-coverage-bound');
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const staleScopedStatus = clone(build());
    report(staleScopedStatus).scoped_status.scoped_phase56_files_only = true;
    expectValidatorFails(staleScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(staleScopedStatus, 'validation-report-matches-contract');

    const stalePhase58ScopedStatus = clone(build());
    report(stalePhase58ScopedStatus).scoped_status.scoped_phase58_through_phase57_files_only = true;
    expect(report(stalePhase58ScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only).toBe(true);
    expectValidatorFails(stalePhase58ScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(stalePhase58ScopedStatus, 'validation-report-matches-contract');

    const stalePhase59ScopedStatus = clone(build());
    report(stalePhase59ScopedStatus).scoped_status.scoped_phase59_through_phase58_files_only = true;
    expect(report(stalePhase59ScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only).toBe(true);
    expectValidatorFails(stalePhase59ScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(stalePhase59ScopedStatus, 'validation-report-matches-contract');

    const stalePhase60ScopedStatus = clone(build());
    report(stalePhase60ScopedStatus).scoped_status.scoped_phase60_through_phase59_files_only = true;
    expect(report(stalePhase60ScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only).toBe(true);
    expectValidatorFails(stalePhase60ScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(stalePhase60ScopedStatus, 'validation-report-matches-contract');

    const stalePhase61ScopedStatus = clone(build());
    report(stalePhase61ScopedStatus).scoped_status.scoped_phase61_through_phase60_files_only = true;
    expect(report(stalePhase61ScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only).toBe(true);
    expectValidatorFails(stalePhase61ScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(stalePhase61ScopedStatus, 'validation-report-matches-contract');

    const stalePhase62ScopedStatus = clone(build());
    report(stalePhase62ScopedStatus).scoped_status.scoped_phase62_through_phase61_files_only = true;
    expect(report(stalePhase62ScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only).toBe(true);
    expectValidatorFails(stalePhase62ScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(stalePhase62ScopedStatus, 'validation-report-matches-contract');

    const missingCurrentScopedStatus = clone(build());
    delete report(missingCurrentScopedStatus).scoped_status.scoped_phase63_through_phase62_files_only;
    expectValidatorFails(missingCurrentScopedStatus, 'validation-report-scoped-status-current');
    expectValidatorFails(missingCurrentScopedStatus, 'validation-report-matches-contract');

    const literalLie = clone(build());
    rollup(literalLie).baseline_commit = 'd57e546';
    recomputeRollupKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-readiness-rollup-through-phase62-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(rollup(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE63_SCHEMA_VERSION);
    expect(rollup(output).sessionId).toBe('session-cli');
    expect(rollup(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(rollup(output).phase_registry.current_through_phase)
      .toBe(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.phase_inventory_count);
    expect(rollup(output).schema_registry.count)
      .toBe(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.schema_registry_count);
    expect(rollup(output).cli_registry.count)
      .toBe(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.cli_registry_count);
    expect(rollup(output).commit_chain)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.commit_chain_count);
    expect(rollup(output).source_refs)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase63Contract.expectedCounts.source_ref_count);
    expect(rollup(output).readiness_rollup_summary.ready_for_kill_switch_wiring_now).toBe(false);
    expect(rollup(output).phase50_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase51_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase52_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase53_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase54_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase55_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase56_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase57_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase58_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase59_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase60_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).phase61_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output)).not.toHaveProperty(PHASE53_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE54_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE55_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE56_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE57_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE58_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE59_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE60_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output)).not.toHaveProperty(PHASE61_BOUNDARY_REFRESH_SUMMARY_FIELD);
    expect(rollup(output).noop_dry_check_items).toHaveLength(7);
    expect(rollup(output).blocked_future_slices).toHaveLength(5);
    expect(rollup(output).kill_switch_boundary.killWired).toBe(false);
    expect(rollup(output).kill_switch_wiring_boundary.killSwitchWiringAvailable).toBe(false);
    expect(rollup(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(rollup(output).capability_matrix.readinessRollupAvailable).toBe(false);
    expect(rollup(output).side_effect_result.no_output_file_written).toBe(true);
    expect(rollup(output).side_effect_result.no_noop_execution_performed).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase63Output(
      output,
      killSwitchWiringReadinessRollupThroughPhase63Contract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
