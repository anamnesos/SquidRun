const runtimeMilestoneRefreshContract = require('./fixtures/mira-core-runtime-milestone-refresh-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeMilestoneRefresh,
  runtimeMilestoneRefreshIdempotencyKey,
  validateMiraCoreRuntimeMilestoneRefreshOutput,
} = require('../modules/mira-core/runtime-milestone-refresh');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-milestone-refresh');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeMilestoneRefresh({
    contract: runtimeMilestoneRefreshContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function manifest(output) {
  return output.runtime_milestone_refresh_manifest;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output) {
  expect(() => assertNoForbiddenOutput(output, runtimeMilestoneRefreshContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeMilestoneRefreshOutput(output, runtimeMilestoneRefreshContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeManifestKey(output) {
  output.runtime_milestone_refresh_manifest.idempotency_key =
    runtimeMilestoneRefreshIdempotencyKey(output.runtime_milestone_refresh_manifest);
}

describe('mira core runtime milestone readiness refresh v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();
    const currentManifest = manifest(output);
    const validation = report(output);

    expectRequiredFields(output, runtimeMilestoneRefreshContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeMilestoneRefreshContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentManifest.schema).toBe(RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentManifest, runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape.requiredFields);
    expect(runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape.requiredFields).toEqual(REQUIRED_MANIFEST_FIELDS);
    expectRequiredFields(validation, runtimeMilestoneRefreshContract.expectedValidationReportShape.requiredFields);
    expect(runtimeMilestoneRefreshContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeMilestoneRefreshOutput(output, runtimeMilestoneRefreshContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.accepted).toBe(true);
    expect(validation.decision).toBe('accepted_validation_only');
    expectNoForbiddenOutput(output);
  });

  test('inventories exactly Phases 1-30 with expected paths, commits, stale markers, and capability truth', () => {
    const currentManifest = manifest(build());
    const inventory = currentManifest.phase_inventory;
    const expected = runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape;

    expect(inventory).toHaveLength(30);
    expect(inventory.map((item) => item.phase)).toEqual(Array.from({ length: 30 }, (_value, index) => index + 1));
    for (const expectedItem of expected.phaseInventoryExpected) {
      const item = inventory.find((entry) => entry.phase === expectedItem.phase);
      expect(item).toBeTruthy();
      expectRequiredFields(item, expected.phaseInventoryRequiredFields);
      expect(item).toEqual(expect.objectContaining(expectedItem));
      expect(item.capability_truth).toEqual(expect.objectContaining(expected.phaseCapabilityTruthRequiredValues));
      expect(item.capability_truth.localArmsProofSeparate).toBe(true);
      expect(item.evidenceRefs.length).toBeGreaterThan(0);
    }
    expect(inventory.find((item) => item.phase === 13).status).toBe('stale_superseded_by_phase_23_and_phase_31');
    expect(inventory.find((item) => item.phase === 23).status).toBe('stale_superseded_by_phase_31');
    expect(inventory.find((item) => item.phase === 30).committed_baseline).toBe(BASELINE_COMMIT);
  });

  test('commit chain, schema registry, and CLI registry cover Phase 1-30 in fixture order', () => {
    const currentManifest = manifest(build());
    const expected = runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape;

    expect(currentManifest.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeMilestoneRefreshContract.baseline.commit);
    expect(currentManifest.commit_chain).toEqual(expected.commitChainExpected);
    expect(currentManifest.commit_chain).toHaveLength(expected.expectedCounts.commit_chain);
    expect(currentManifest.commit_chain[currentManifest.commit_chain.length - 1].commit).toBe(BASELINE_COMMIT);
    expect(currentManifest.schema_registry).toEqual(expected.schemaRegistryExpected);
    expect(currentManifest.schema_registry).toHaveLength(expected.expectedCounts.schema_registry);
    expect(currentManifest.cli_registry).toEqual(expected.cliRegistryExpected);
    expect(currentManifest.cli_registry).toHaveLength(expected.expectedCounts.cli_registry);
    for (const cliEntry of currentManifest.cli_registry) {
      expectRequiredFields(cliEntry, expected.cliRegistryRequiredFields);
      expect(cliEntry.stdout_only_required).toBe(true);
      expect(cliEntry.output_file_behavior).toBe('no_output_file');
      expect(cliEntry.runtime_side_effects_allowed).toBe(false);
    }
  });

  test('capability, boundary, stale-readiness, Phase 22 closure, and Phase 30 closure truth match contract', () => {
    const currentManifest = manifest(build());
    const expected = runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape.requiredLiteralValues;

    expect(currentManifest.capability_matrix.runtime_started).toBe(expected['capability_matrix.runtime_started']);
    expect(currentManifest.capability_matrix.runtime_available_now).toBe(expected['capability_matrix.runtime_available_now']);
    expect(currentManifest.capability_matrix.eligible_is_authorization).toBe(expected['capability_matrix.eligible_is_authorization']);
    expect(currentManifest.capability_matrix.serverCanExecuteLocal).toBe(expected['capability_matrix.serverCanExecuteLocal']);
    expect(currentManifest.capability_matrix.serverCanProveModelProcessing).toBe(false);
    expect(currentManifest.capability_matrix.directBuilderOracleServerTargetsAllowed).toBe(false);
    expect(currentManifest.boundary_truth.socketIsBridgeGreenProof).toBe(false);
    expect(currentManifest.boundary_truth.deliveryAcceptanceIsModelProcessingProof).toBe(false);
    expect(currentManifest.boundary_truth.controlPathIsRuntimeProof).toBe(false);
    expect(currentManifest.stale_readiness.phase13ReadinessCurrent).toBe(false);
    expect(currentManifest.stale_readiness.phase23MilestoneReadinessCurrent).toBe(false);
    expect(currentManifest.phase_22_closure.oracle_78_79_80_bypasses_closed).toBe(true);
    expect(currentManifest.phase_22_closure.direct_request_case_binding).toBe(true);
    expect(currentManifest.phase_30_closure.oracle_115_phase29_mapping_bypass_closed).toBe(true);
    expect(currentManifest.phase_30_closure.phase29_prerequisite_mapping_exact).toBe(true);
    expect(currentManifest.phase_30_closure.recomputed_idempotency_bogus_mapping_rejected).toBe(true);
    expect(currentManifest.runtime_control_path_summary.default_decision).toBe('remain_control_path_contract_only');
    expect(currentManifest.runtime_control_path_summary.runtime_started).toBe(false);
  });

  test('blockers, recommendations, unsafe policy, verification summary, and side-effect truth are explicit', () => {
    const output = build();
    const currentManifest = manifest(output);
    const expected = runtimeMilestoneRefreshContract.expectedRuntimeMilestoneRefreshManifestShape;

    expect(currentManifest.verification_summary.no_fake_test_proof).toBe(true);
    expect(currentManifest.verification_summary.proof_status).toBe('unknown_without_phase31_command_input');
    expect(currentManifest.verification_summary.unknown_or_degraded_proof).toBe(true);
    expect(currentManifest.blocker_summary.map((entry) => entry.blocker_id)).toEqual(expected.blockerSummaryRequired);
    expect(currentManifest.blocker_summary.length).toBeGreaterThanOrEqual(expected.expectedCounts.blocker_summary_min);
    expect(currentManifest.next_phase_recommendations).toEqual(expect.arrayContaining(expected.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate))));
    expect(currentManifest.next_phase_recommendations.length).toBeGreaterThanOrEqual(expected.expectedCounts.next_phase_recommendations_min);
    for (const recommendation of currentManifest.next_phase_recommendations) {
      expectRequiredFields(recommendation, expected.nextRecommendationRequiredFields);
      expect(expected.nextRecommendationAllowedTiers).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
      expect(recommendation.prerequisites.length).toBeGreaterThan(0);
    }
    expect(currentManifest.unsafe_action_policy).toEqual(expect.objectContaining(expected.unsafeActionPolicyRequiredValues));
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(currentManifest.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_result[field]).toBe(true);
    }
    expect(currentManifest.side_effect_result.runtimeStarted).toBe(false);
    expect(currentManifest.side_effect_result.serverStarted).toBe(false);
    expect(currentManifest.side_effect_result.outputFileWritten).toBe(false);
    expect(currentManifest.side_effect_result.outputFilesWritten).toBe(0);
  });

  test('static rules and protected acceptance checks are represented by validation output', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeMilestoneRefreshOutput(output, runtimeMilestoneRefreshContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).checks.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeMilestoneRefreshContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(reportCheckIds).toContain(rule.id);
    }
    for (const check of runtimeMilestoneRefreshContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(reportCheckIds).toContain(check.id);
    }
    expect(report(output).checks.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to registry changes', () => {
    const first = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = manifest(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.manifest_id).toBe(second.manifest_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    tampered.runtime_milestone_refresh_manifest.phase_inventory[29].committed_baseline = 'wrong';
    recomputeManifestKey(tampered);
    expectValidatorFails(tampered, 'phase-inventory-exactly-30');
  });

  test('validator rejects stale phase count, stale commit chain, registry drift, and stale readiness overclaims', () => {
    const droppedPhase = clone(build());
    droppedPhase.runtime_milestone_refresh_manifest.phase_inventory =
      droppedPhase.runtime_milestone_refresh_manifest.phase_inventory.filter((entry) => entry.phase !== 30);
    recomputeManifestKey(droppedPhase);
    expectValidatorFails(droppedPhase, 'phase-inventory-exactly-30');
    expectValidatorFails(droppedPhase, 'stale_phase_count_rejected');

    const staleChain = clone(build());
    staleChain.runtime_milestone_refresh_manifest.commit_chain.pop();
    recomputeManifestKey(staleChain);
    expectValidatorFails(staleChain, 'commit-chain-through-679e018');

    const registryDrift = clone(build());
    registryDrift.runtime_milestone_refresh_manifest.schema_registry.pop();
    recomputeManifestKey(registryDrift);
    expectValidatorFails(registryDrift, 'schema-registry-exactly-30');

    const staleReadiness = clone(build());
    staleReadiness.runtime_milestone_refresh_manifest.stale_readiness.phase23MilestoneReadinessCurrent = true;
    recomputeManifestKey(staleReadiness);
    expectValidatorFails(staleReadiness, 'phase13-and-phase23-stale-superseded');
  });

  test('validator rejects missing Phase 30 closure, runtime overclaims, and direct target overclaims', () => {
    const missingClosure = clone(build());
    missingClosure.runtime_milestone_refresh_manifest.phase_30_closure.oracle_115_phase29_mapping_bypass_closed = false;
    recomputeManifestKey(missingClosure);
    expectValidatorFails(missingClosure, 'phase30-oracle-115-closure-carried-forward');

    const runtime = clone(build());
    runtime.runtime_milestone_refresh_manifest.capability_matrix.runtime_available_now = true;
    runtime.runtime_milestone_refresh_manifest.capability_matrix.runtime_started = true;
    runtime.runtime_milestone_refresh_manifest.boundary_truth.runtimeStarted = true;
    recomputeManifestKey(runtime);
    expectValidatorFails(runtime, 'runtime-control-path-non-authorizing');
    expectValidatorFails(runtime, 'capability-truth-preserved');

    const target = clone(build());
    target.runtime_milestone_refresh_manifest.capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    target.runtime_milestone_refresh_manifest.boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeManifestKey(target);
    expectValidatorFails(target, 'capability-truth-preserved');
    expectValidatorFails(target, 'direct_builder_oracle_targets_blocked');
  });

  test('validator rejects unsafe recommendations, Tier2+ recommendations, side-effect lies, and missing blockers', () => {
    const unsafe = clone(build());
    unsafe.runtime_milestone_refresh_manifest.next_phase_recommendations[0].title = 'send email to customer';
    unsafe.runtime_milestone_refresh_manifest.next_phase_recommendations[0].why_safe = 'safe to send email to customer';
    recomputeManifestKey(unsafe);
    expectValidatorFails(unsafe, 'unsafe-action-drift-blocked');

    const blockerSafeAction = clone(build());
    blockerSafeAction.runtime_milestone_refresh_manifest.blocker_summary[0].safe_next_action = 'send email to customer';
    recomputeManifestKey(blockerSafeAction);
    expectValidatorFails(blockerSafeAction, 'unsafe-action-drift-blocked');

    const blockerReason = clone(build());
    blockerReason.runtime_milestone_refresh_manifest.blocker_summary[0].blocked_because = 'safe to message the client';
    recomputeManifestKey(blockerReason);
    expectValidatorFails(blockerReason, 'unsafe-action-drift-blocked');

    const verificationNarrative = clone(build());
    verificationNarrative.runtime_milestone_refresh_manifest.verification_summary.prior_phase30_reported.source = 'send message to client';
    recomputeManifestKey(verificationNarrative);
    expectValidatorFails(verificationNarrative, 'unsafe-action-drift-blocked');

    const tier = clone(build());
    tier.runtime_milestone_refresh_manifest.next_phase_recommendations[0].tier = 'Tier3';
    recomputeManifestKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');

    const sideEffect = clone(build());
    sideEffect.runtime_milestone_refresh_manifest.side_effect_result.no_output_file_written = false;
    sideEffect.runtime_milestone_refresh_manifest.side_effect_result.outputFilesWritten = 1;
    recomputeManifestKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effects-blocked-now');

    const missingBlocker = clone(build());
    missingBlocker.runtime_milestone_refresh_manifest.blocker_summary.pop();
    recomputeManifestKey(missingBlocker);
    expectValidatorFails(missingBlocker, 'remaining-blockers-complete');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'bearer token',
      'api key',
      'private key',
      'session secret',
      'raw terminal',
      'raw screenshot',
      'browser cookie',
      'customer private',
      'runtime started',
      'server started',
      'listener bound',
      'network request sent',
      'database write',
      'output file written',
      'queue created',
      'local execution performed',
      'shell executed',
      'customer send performed',
      'external send performed',
      'deploy performed',
      'trade performed',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
    ]) {
      const tampered = clone(build());
      tampered.runtime_milestone_refresh_manifest.blocker_summary[0].safe_next_action = forbidden;
      recomputeManifestKey(tampered);
      expectValidatorFails(tampered, 'no-raw-private-secret-output');
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-milestone-refresh-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(manifest(output).schema).toBe(RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION);
    expect(manifest(output).sessionId).toBe('session-cli');
    expect(manifest(output).phase_inventory).toHaveLength(30);
    expect(manifest(output).schema_registry).toHaveLength(30);
    expect(manifest(output).cli_registry).toHaveLength(30);
    expect(manifest(output).commit_chain).toHaveLength(18);
    expect(manifest(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(manifest(output).phase_30_closure.oracle_115_phase29_mapping_bypass_closed).toBe(true);
    expect(manifest(output).capability_matrix.runtime_started).toBe(false);
    expect(manifest(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(manifest(output).side_effect_result.no_output_file_written).toBe(true);
    expect(manifest(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeMilestoneRefreshOutput(output, runtimeMilestoneRefreshContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
