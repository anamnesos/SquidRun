const milestoneContract = require('./fixtures/mira-core-milestone-readiness-contract.json');
const {
  BASELINE_COMMIT,
  MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_NEXT_RECOMMENDATION_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreMilestoneReadiness,
  milestoneReadinessIdempotencyKey,
  validateMiraCoreMilestoneReadinessOutput,
} = require('../modules/mira-core/milestone-readiness');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-milestone-readiness');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreMilestoneReadiness({
    contract: milestoneContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function manifest(output) {
  return output.milestone_readiness_manifest;
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
  expect(() => assertNoForbiddenOutput(output, milestoneContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreMilestoneReadinessOutput(output, milestoneContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core milestone readiness phase-registry refresh v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();
    const currentManifest = manifest(output);
    const validation = report(output);

    expectRequiredFields(output, milestoneContract.expectedOutputShape.requiredTopLevelFields);
    expect(milestoneContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentManifest.schema).toBe(MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentManifest, milestoneContract.expectedMilestoneReadinessManifestShape.requiredFields);
    expect(milestoneContract.expectedMilestoneReadinessManifestShape.requiredFields).toEqual(REQUIRED_MANIFEST_FIELDS);
    expectRequiredFields(validation, milestoneContract.expectedValidationReportShape.requiredFields);
    expect(milestoneContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreMilestoneReadinessOutput(output, milestoneContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('inventories exactly Phases 1-22 with expected paths, commits, and stale Phase 13 marker', () => {
    const currentManifest = manifest(build());
    const inventory = currentManifest.phase_inventory;
    const expected = milestoneContract.expectedMilestoneReadinessManifestShape.phaseInventoryExpected;

    expect(inventory).toHaveLength(22);
    expect(inventory.map((item) => item.phase)).toEqual(Array.from({ length: 22 }, (_value, index) => index + 1));
    for (const expectedItem of expected) {
      const item = inventory.find((entry) => entry.phase === expectedItem.phase);
      expect(item).toBeTruthy();
      expectRequiredFields(item, milestoneContract.expectedMilestoneReadinessManifestShape.phaseInventoryRequiredFields);
      expect(item).toEqual(expect.objectContaining(expectedItem));
      expect(item.capability_truth).toEqual(expect.objectContaining(milestoneContract.expectedMilestoneReadinessManifestShape.phaseCapabilityTruthRequiredValues));
      expect(item.capability_truth.localArmsProofSeparate).toBe(true);
      expect(item.evidenceRefs.length).toBeGreaterThan(0);
    }
    expect(inventory.find((item) => item.phase === 13).status).toBe('stale_local_readiness_runtime_present_superseded_by_phase_23');
    expect(currentManifest.boundary_truth.phase13ReadinessIsCurrentForPhases14Through22).toBe(false);
  });

  test('commit chain and registries cover the Phase 1-22 package in order', () => {
    const currentManifest = manifest(build());
    const expected = milestoneContract.expectedMilestoneReadinessManifestShape;

    expect(currentManifest.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(milestoneContract.baseline.commit);
    expect(currentManifest.commit_chain).toEqual(expected.commitChainExpected);
    expect(currentManifest.commit_chain.map((entry) => entry.commit)).toEqual([
      '785dbec',
      'f41b02a',
      '3904697',
      '6f97287',
      'afabea1',
      '3742ab7',
      '8a8ccf0',
      'ce9e55d',
      'ffe130c',
      'b7e2106',
    ]);
    expect(currentManifest.schema_registry).toHaveLength(expected.schemaRegistryExpectedCount);
    expect(currentManifest.cli_registry).toHaveLength(expected.cliRegistryExpectedCount);
    expect(currentManifest.schema_registry.map((entry) => entry.phase)).toEqual(currentManifest.phase_inventory.map((entry) => entry.phase));
    expect(currentManifest.cli_registry.map((entry) => entry.phase)).toEqual(currentManifest.phase_inventory.map((entry) => entry.phase));
    for (const cliEntry of currentManifest.cli_registry) {
      expect(cliEntry.stdout_only).toBe(true);
      expect(cliEntry.output_file_mode).toBe(false);
      expect(cliEntry.read_only_or_validation_only).toBe(true);
    }
  });

  test('capability matrix and boundary truth preserve runtime, proof, and target limits', () => {
    const currentManifest = manifest(build());
    const expected = milestoneContract.expectedMilestoneReadinessManifestShape;

    expectRequiredFields(currentManifest.capability_matrix, expected.capabilityMatrixRequiredFields);
    expect(currentManifest.capability_matrix).toEqual(expect.objectContaining(expected.capabilityMatrixRequiredValues));
    expect(currentManifest.capability_matrix.allowedNowRiskTiers).toEqual(expected.allowedNowRiskTiers);
    expect(currentManifest.capability_matrix.blockedRiskTiers).toEqual(expected.blockedRiskTiers);
    expect(currentManifest.boundary_truth.serverCanExecuteLocal).toBe(false);
    expect(currentManifest.boundary_truth.serverCanProveModelProcessing).toBe(false);
    expect(currentManifest.boundary_truth.realRuntimeAvailable).toBe(false);
    expect(currentManifest.boundary_truth.builderOracleDirectServerTargetsAllowed).toBe(false);
    expect(currentManifest.boundary_truth.socketIsBridgeGreenProof).toBe(false);
    expect(currentManifest.boundary_truth.deliveryAcceptanceIsModelProcessingProof).toBe(false);
    expect(currentManifest.boundary_truth.runtimeHarnessIsRealRuntimeProof).toBe(false);
  });

  test('Phase 22 closure records Oracle #78/#79/#80 and same-sequence binding regressions', () => {
    const closure = manifest(build()).phase_22_closure;
    const expected = milestoneContract.expectedPhase22ClosureShape;

    expectRequiredFields(closure, expected.requiredFields);
    expect(closure).toEqual(expect.objectContaining(expected.requiredLiteralValues));
    expect(closure.oracle_review_refs).toEqual(expect.arrayContaining(expected.requiredReviewRefs));
    expect(closure.closed_bypass_classes).toEqual(expect.arrayContaining(expected.requiredClosedBypassClasses));
    expect(closure.required_request_case_binding).toEqual(expect.arrayContaining(expected.requiredRequestCases));
  });

  test('artifact, verification, blockers, recommendations, and side-effect truth are explicit', () => {
    const output = build();
    const currentManifest = manifest(output);

    expect(currentManifest.artifact_summary.phase_inventory_count).toBe(22);
    expect(currentManifest.artifact_summary.schema_registry_count).toBe(22);
    expect(currentManifest.artifact_summary.cli_registry_count).toBe(22);
    expect(currentManifest.artifact_summary.stale_phase13_present).toBe(true);
    expect(currentManifest.artifact_summary.phase22_closure_present).toBe(true);
    expect(currentManifest.verification_summary.no_fake_test_proof).toBe(true);
    expect(currentManifest.verification_summary.proof_status).toBe('unknown_without_phase23_command_input');
    expect(currentManifest.verification_summary.unknown_or_degraded_proof).toBe(true);
    expect(currentManifest.blocker_summary.map((entry) => entry.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(REQUIRED_BLOCKER_IDS).toEqual(milestoneContract.expectedMilestoneReadinessManifestShape.requiredBlockerIds);
    expect(currentManifest.next_phase_recommendations.map((entry) => entry.recommendation_id)).toEqual(REQUIRED_NEXT_RECOMMENDATION_IDS);
    for (const recommendation of currentManifest.next_phase_recommendations) {
      expectRequiredFields(recommendation, milestoneContract.expectedMilestoneReadinessManifestShape.nextRecommendationRequiredFields);
      expect(milestoneContract.expectedMilestoneReadinessManifestShape.allowedNextRecommendationRiskTiers).toContain(recommendation.risk_tier);
      expect(recommendation.why_safe).toBeTruthy();
      expect(recommendation.prerequisites.length).toBeGreaterThan(0);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
    for (const field of milestoneContract.expectedMilestoneReadinessManifestShape.sideEffectResultRequiredFields) {
      expect(currentManifest.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_result[field]).toBe(true);
    }
    expect(currentManifest.side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static rules and acceptance checks are represented by validation output', () => {
    const output = build();
    const validation = validateMiraCoreMilestoneReadinessOutput(output, milestoneContract);
    const checkIds = validation.checks.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of milestoneContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(report(output).acceptance_checks.map((entry) => entry.id)).toEqual(milestoneContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).acceptance_checks.every((entry) => entry.ok)).toBe(true);
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
    tampered.milestone_readiness_manifest.phase_inventory[21].committed_baseline = 'wrong';
    tampered.milestone_readiness_manifest.idempotency_key = milestoneReadinessIdempotencyKey(tampered.milestone_readiness_manifest);
    expectValidatorFails(tampered, 'phase-paths-and-commits-match-registry');
  });

  test('validator rejects stale 12-phase inventory and missing registry entries', () => {
    const stale = clone(build());
    stale.milestone_readiness_manifest.phase_inventory = stale.milestone_readiness_manifest.phase_inventory.slice(0, 12);
    stale.milestone_readiness_manifest.schema_registry = stale.milestone_readiness_manifest.schema_registry.slice(0, 12);
    stale.milestone_readiness_manifest.cli_registry = stale.milestone_readiness_manifest.cli_registry.slice(0, 12);
    expectValidatorFails(stale, 'phase-inventory-exactly-1-through-22');
    expectValidatorFails(stale, 'schema-cli-registry-complete');

    const missingPhase = clone(build());
    missingPhase.milestone_readiness_manifest.phase_inventory =
      missingPhase.milestone_readiness_manifest.phase_inventory.filter((entry) => entry.phase !== 22);
    expectValidatorFails(missingPhase, 'phase-inventory-exactly-1-through-22');
  });

  test('validator rejects Phase 13 current overclaim and missing Phase 22 closure', () => {
    const phase13Current = clone(build());
    phase13Current.milestone_readiness_manifest.phase_inventory.find((entry) => entry.phase === 13).status = 'current';
    phase13Current.milestone_readiness_manifest.boundary_truth.phase13ReadinessIsCurrentForPhases14Through22 = true;
    expectValidatorFails(phase13Current, 'phase13-stale-superseded-by-phase23');

    const missingClosure = clone(build());
    missingClosure.milestone_readiness_manifest.phase_22_closure.oracle_78_79_bypasses_closed = false;
    expectValidatorFails(missingClosure, 'phase22-validation-only-closures-recorded');

    const missingRequestCase = clone(build());
    missingRequestCase.milestone_readiness_manifest.phase_22_closure.required_request_case_binding.pop();
    expectValidatorFails(missingRequestCase, 'phase22-validation-only-closures-recorded');
  });

  test('validator rejects runtime, proof, target, and Phase 22 capability overclaims', () => {
    const runtime = clone(build());
    runtime.milestone_readiness_manifest.capability_matrix.realRuntimeAvailable = true;
    expectValidatorFails(runtime, 'capability-matrix-no-runtime-overclaim');
    expectValidatorFails(runtime, 'manifest-literal-values');

    const local = clone(build());
    local.milestone_readiness_manifest.boundary_truth.serverCanExecuteLocal = true;
    expectValidatorFails(local, 'capability-matrix-no-runtime-overclaim');

    const target = clone(build());
    target.milestone_readiness_manifest.capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    expectValidatorFails(target, 'capability-matrix-no-runtime-overclaim');

    const phase22 = clone(build());
    phase22.milestone_readiness_manifest.phase_inventory.find((entry) => entry.phase === 22).validation_only = false;
    expectValidatorFails(phase22, 'phase-paths-and-commits-match-registry');
    expectValidatorFails(phase22, 'phase22-validation-only-closures-recorded');
  });

  test('validator rejects side-effect lies, unsafe recommendations, path drift, and commit-chain drift', () => {
    const sideEffect = clone(build());
    sideEffect.milestone_readiness_manifest.side_effect_result.no_network_performed = false;
    sideEffect.milestone_readiness_manifest.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(sideEffect, 'side-effect-truth-all-safe');

    const reportSideEffect = clone(build());
    reportSideEffect.validation_report.side_effect_result.no_output_file_written = false;
    reportSideEffect.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(reportSideEffect, 'validation-report-side-effect-truth');

    const unsafeRecommendation = clone(build());
    unsafeRecommendation.milestone_readiness_manifest.next_phase_recommendations[0].risk_tier = 'tier3_external_side_effect';
    expectValidatorFails(unsafeRecommendation, 'next-recommendations-tier0-tier1-only');

    const pathDrift = clone(build());
    pathDrift.milestone_readiness_manifest.phase_inventory[0].module_path = 'ui/modules/mira-core/wrong.js';
    expectValidatorFails(pathDrift, 'phase-paths-and-commits-match-registry');

    const commitDrift = clone(build());
    commitDrift.milestone_readiness_manifest.commit_chain.reverse();
    expectValidatorFails(commitDrift, 'commit-chain-complete-and-ordered');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'live server runtime present',
      'server can execute local',
      'server can prove model processing',
      'direct builder target allowed',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'network request performed',
      'database write performed',
      'queue created',
      'local execution performed',
      'deploy performed',
      'trade performed',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw customer private',
      'private key',
      'bearer token',
      'plaintext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.milestone_readiness_manifest.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'forbidden-raw-private-content-absent');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-milestone-readiness-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(manifest(output).schema).toBe(MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION);
    expect(manifest(output).sessionId).toBe('session-cli');
    expect(manifest(output).phase_inventory).toHaveLength(22);
    expect(manifest(output).schema_registry).toHaveLength(22);
    expect(manifest(output).cli_registry).toHaveLength(22);
    expect(manifest(output).baseline_commit).toBe('b7e2106');
    expect(manifest(output).phase_22_closure.oracle_78_79_bypasses_closed).toBe(true);
    expect(manifest(output).capability_matrix.realRuntimeAvailable).toBe(false);
    expect(manifest(output).side_effect_result.no_output_file_written).toBe(true);
    expect(manifest(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreMilestoneReadinessOutput(output, milestoneContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
