const runtimeStatusMilestoneRefreshContract = require('./fixtures/mira-core-runtime-status-milestone-refresh-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeStatusMilestoneRefresh,
  runtimeStatusMilestoneRefreshIdempotencyKey,
  validateMiraCoreRuntimeStatusMilestoneRefreshOutput,
} = require('../modules/mira-core/runtime-status-milestone-refresh');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-status-milestone-refresh');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeStatusMilestoneRefresh({
    contract: runtimeStatusMilestoneRefreshContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function manifest(output) {
  return output.runtime_status_milestone_refresh_manifest;
}

function validationReport(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output) {
  expect(() => assertNoForbiddenOutput(output, runtimeStatusMilestoneRefreshContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeStatusMilestoneRefreshOutput(output, runtimeStatusMilestoneRefreshContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeManifestKey(output) {
  output.runtime_status_milestone_refresh_manifest.idempotency_key =
    runtimeStatusMilestoneRefreshIdempotencyKey(output.runtime_status_milestone_refresh_manifest);
}

describe('mira core runtime status milestone readiness refresh v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const currentManifest = manifest(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeStatusMilestoneRefreshContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeStatusMilestoneRefreshContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentManifest.schema).toBe(RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentManifest, runtimeStatusMilestoneRefreshContract.expectedManifestShape.requiredFields);
    expect(runtimeStatusMilestoneRefreshContract.expectedManifestShape.requiredFields).toEqual(REQUIRED_MANIFEST_FIELDS);
    expectRequiredFields(report, runtimeStatusMilestoneRefreshContract.expectedValidationReportShape.requiredFields);
    expect(runtimeStatusMilestoneRefreshContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeStatusMilestoneRefreshOutput(output, runtimeStatusMilestoneRefreshContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('inventories exactly Phases 1-33 with expected paths, commits, stale markers, and capability truth', () => {
    const currentManifest = manifest(build());
    const expected = runtimeStatusMilestoneRefreshContract.expectedManifestShape;

    expect(currentManifest.phase_inventory).toHaveLength(33);
    expect(currentManifest.phase_inventory.map((item) => item.phase)).toEqual(Array.from({ length: 33 }, (_value, index) => index + 1));
    for (const expectedItem of runtimeStatusMilestoneRefreshContract.phaseRegistryExpected) {
      const item = currentManifest.phase_inventory.find((entry) => entry.phase === expectedItem.phase);
      expect(item).toBeTruthy();
      expectRequiredFields(item, expected.phaseInventoryRequiredFields);
      expect(item).toEqual(expect.objectContaining(expectedItem));
      expect(item.capability_truth).toEqual(expect.objectContaining(expected.phaseCapabilityTruthRequiredValues));
      expect(item.evidenceRefs.length).toBeGreaterThan(0);
    }
    expect(currentManifest.phase_inventory.find((item) => item.phase === 13).status).toBe('stale_superseded_by_phase_23_and_phase_31');
    expect(currentManifest.phase_inventory.find((item) => item.phase === 23).status).toBe('stale_superseded_by_phase_31');
    expect(currentManifest.phase_inventory.find((item) => item.phase === 31).status).toBe('stale_superseded_by_phase_34');
    expect(currentManifest.phase_inventory.find((item) => item.phase === 33).committed_baseline).toBe(BASELINE_COMMIT);
  });

  test('schema registry, CLI registry, and commit chain cover Phase 1-33 in fixture order', () => {
    const currentManifest = manifest(build());
    const counts = runtimeStatusMilestoneRefreshContract.expectedManifestShape.expectedCounts;

    expect(currentManifest.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeStatusMilestoneRefreshContract.baseline.commit);
    expect(currentManifest.schema_registry).toHaveLength(counts.schema_registry);
    expect(currentManifest.schema_registry.map((entry) => entry.phase)).toEqual(Array.from({ length: 33 }, (_value, index) => index + 1));
    expect(currentManifest.cli_registry).toHaveLength(counts.cli_registry);
    expect(currentManifest.cli_registry.map((entry) => entry.phase)).toEqual(Array.from({ length: 33 }, (_value, index) => index + 1));
    for (const cliEntry of currentManifest.cli_registry) {
      expect(cliEntry.stdout_only_required).toBe(true);
      expect(cliEntry.output_behavior).toBe('stdout_only');
      expect(cliEntry.side_effects_allowed).toBe(false);
    }
    expect(currentManifest.commit_chain).toEqual(runtimeStatusMilestoneRefreshContract.commitChainExpected);
    expect(currentManifest.commit_chain).toHaveLength(counts.commit_chain);
    expect(currentManifest.commit_chain[currentManifest.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('stale readiness and Oracle closure truth are carried forward', () => {
    const currentManifest = manifest(build());

    expect(currentManifest.stale_readiness).toEqual(expect.objectContaining({
      phase13_readiness_current: false,
      phase13_superseded_by: 'phase_23_milestone_readiness',
      phase23_milestone_readiness_current: false,
      phase23_superseded_by: 'phase_31_runtime_milestone_refresh',
      phase31_runtime_milestone_refresh_current: false,
      phase31_superseded_by: 'phase_34_runtime_status_milestone_refresh',
    }));
    expect(currentManifest.closure_summary).toEqual(expect.objectContaining({
      phase30_oracle_115_prerequisite_mapping_closure: true,
      phase30_recomputed_idempotency_bogus_mapping_rejected: true,
      phase32_oracle_123_expires_at_closure: true,
      phase32_expires_at_bound_to_generated_at: true,
      phase33_oracle_127_validation_report_tamper_coverage_closure: true,
      phase33_static_acceptance_ok_values_recomputed: true,
      phase33_tamper_results_bound_to_fixture: true,
    }));
    expect(currentManifest.closure_summary.closed_review_refs).toEqual(['ORACLE #115', 'ORACLE #123', 'ORACLE #127']);
  });

  test('capability, proof boundary, recommendations, and side-effect truth stay non-authorizing', () => {
    const output = build();
    const currentManifest = manifest(output);

    expect(currentManifest.capability_matrix).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      realRuntimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
    expect(currentManifest.boundary_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      builderOracleDirectServerTargetsAllowed: false,
      socketIsBridgeGreenProof: false,
      deliveryAcceptanceIsModelProcessingProof: false,
      statusSurfaceIsRuntimeProof: false,
      dryRunnerContractIsRunnerExecutionProof: false,
    }));
    expect(currentManifest.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeStatusMilestoneRefreshContract.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of currentManifest.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
    }
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(currentManifest.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    expect(currentManifest.side_effect_result.outputFileWritten).toBe(false);
  });

  test('static rules, acceptance checks, tamper coverage, and referenced paths are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeStatusMilestoneRefreshOutput(output, runtimeStatusMilestoneRefreshContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeStatusMilestoneRefreshContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeStatusMilestoneRefreshContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeStatusMilestoneRefreshContract.tamperCases.length);
    expect(validationReport(output).tamper_case_results.every((entry) => entry.covered)).toBe(true);
    expect(validationReport(output).referenced_path_results).toHaveLength(33 * 4);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.exists)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to registry/closure changes', () => {
    const first = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = manifest(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.manifest_id).toBe(second.manifest_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = manifest(changed).idempotency_key;
    manifest(changed).closure_summary.phase33_tamper_results_bound_to_fixture = false;
    recomputeManifestKey(changed);
    expect(manifest(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'phase33-oracle127-closure-carried');
  });

  test('validator rejects count drift, commit drift, stale readiness overclaims, and closure removal', () => {
    const missingPhase = clone(build());
    manifest(missingPhase).phase_inventory.pop();
    recomputeManifestKey(missingPhase);
    expectValidatorFails(missingPhase, 'phase-inventory-count-33');

    const missingSchema = clone(build());
    manifest(missingSchema).schema_registry.pop();
    recomputeManifestKey(missingSchema);
    expectValidatorFails(missingSchema, 'schema-registry-count-33');

    const missingCli = clone(build());
    manifest(missingCli).cli_registry.pop();
    recomputeManifestKey(missingCli);
    expectValidatorFails(missingCli, 'cli-registry-count-33');

    const missingCommit = clone(build());
    manifest(missingCommit).commit_chain.pop();
    recomputeManifestKey(missingCommit);
    expectValidatorFails(missingCommit, 'commit-chain-exact');

    const stale31 = clone(build());
    manifest(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeManifestKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-superseded');

    const missingClosure = clone(build());
    manifest(missingClosure).closure_summary.phase30_oracle_115_prerequisite_mapping_closure = false;
    recomputeManifestKey(missingClosure);
    expectValidatorFails(missingClosure, 'phase30-oracle115-closure-carried');
  });

  test('validator rejects capability/proof overclaims, side-effect lies, and missing referenced paths', () => {
    const runtime = clone(build());
    manifest(runtime).capability_matrix.runtimeStarted = true;
    manifest(runtime).boundary_truth.runtimeStarted = true;
    recomputeManifestKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const proof = clone(build());
    manifest(proof).boundary_truth.deliveryAcceptanceIsModelProcessingProof = true;
    recomputeManifestKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const sideEffect = clone(build());
    manifest(sideEffect).side_effect_result.no_output_file_written = false;
    manifest(sideEffect).side_effect_result.outputFilesWritten = 1;
    manifest(sideEffect).side_effect_result.outputFileWritten = true;
    recomputeManifestKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effect-truth-all-blocked');

    const missingPath = clone(build());
    manifest(missingPath).phase_inventory[32].module_path = 'ui/modules/mira-core/missing.js';
    recomputeManifestKey(missingPath);
    expectValidatorFails(missingPath, 'referenced-paths-exist');
  });

  test('validator rejects unsafe recommendations, common customer-send drift, Tier2+ drift, and forbidden content', () => {
    const liveRuntime = clone(build());
    manifest(liveRuntime).next_phase_recommendations[0].action = 'implement live runtime';
    recomputeManifestKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const customerSend = clone(build());
    manifest(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeManifestKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');

    const tier = clone(build());
    manifest(tier).next_phase_recommendations[0].tier = 'tier2';
    recomputeManifestKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');

    const verificationDrift = clone(build());
    manifest(verificationDrift).verification_summary.prior_phase_closures[0].status = 'send message to client';
    recomputeManifestKey(verificationDrift);
    expectValidatorFails(verificationDrift, 'unsafe-action-drift-blocked');

    const forbidden = clone(build());
    manifest(forbidden).verification_summary.note = 'raw bearer token';
    recomputeManifestKey(forbidden);
    expectValidatorFails(forbidden, 'no-raw-private-secret-output');
    expectValidatorFails(forbidden, 'forbidden-output-strings-absent');
  });

  test('validator rejects validation-report ok lies, missing tamper coverage, path result lies, and fake proof', () => {
    const staticLie = clone(build());
    validationReport(staticLie).static_rule_results[0].ok = false;
    expectValidatorFails(staticLie, 'validation-report-matches-contract');

    const acceptanceLie = clone(build());
    validationReport(acceptanceLie).acceptance_check_results[0].ok = false;
    expectValidatorFails(acceptanceLie, 'validation-report-matches-contract');

    const missingTamper = clone(build());
    validationReport(missingTamper).tamper_case_results = [];
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const pathLie = clone(build());
    validationReport(pathLie).referenced_path_results[0].exists = false;
    expectValidatorFails(pathLie, 'validation-report-matches-contract');

    const fakeProof = clone(build());
    manifest(fakeProof).verification_summary.proof_status = 'proven_by_reported_command';
    manifest(fakeProof).verification_summary.reported_commands = [];
    recomputeManifestKey(fakeProof);
    expectValidatorFails(fakeProof, 'proof-boundaries-false');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-status-milestone-refresh-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(manifest(output).schema).toBe(RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION);
    expect(manifest(output).sessionId).toBe('session-cli');
    expect(manifest(output).phase_inventory).toHaveLength(33);
    expect(manifest(output).schema_registry).toHaveLength(33);
    expect(manifest(output).cli_registry).toHaveLength(33);
    expect(manifest(output).commit_chain).toHaveLength(21);
    expect(manifest(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(manifest(output).capability_matrix.runtimeStarted).toBe(false);
    expect(manifest(output).capability_matrix.runnerExecuted).toBe(false);
    expect(manifest(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(manifest(output).boundary_truth.deliveryAcceptanceIsModelProcessingProof).toBe(false);
    expect(manifest(output).side_effect_result.no_output_file_written).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeStatusMilestoneRefreshOutput(output, runtimeStatusMilestoneRefreshContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
