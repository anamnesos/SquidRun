const readinessContract = require('./fixtures/mira-core-readiness-contract.json');
const {
  DEFAULT_BLOCKER_IDS,
  DEFAULT_NEXT_RECOMMENDATION_IDS,
  DEFAULT_PHASE_INVENTORY,
  DEFAULT_SCHEMA_REGISTRY,
  READINESS_MANIFEST_SCHEMA_VERSION,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreReadiness,
  manifestIdempotencyKey,
  validateMiraCoreReadinessOutput,
} = require('../modules/mira-core/readiness');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-readiness');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function build(inputSignals = {}) {
  return buildMiraCoreReadiness({
    contract: readinessContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function manifest(output) {
  return output.readiness_manifest;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...readinessContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreReadinessOutput(output, readinessContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core readiness/index manifest v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();
    const readiness = manifest(output);
    const validation = report(output);

    expectRequiredFields(output, readinessContract.expectedOutputShape.requiredTopLevelFields);
    expect(readinessContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(readiness.schema).toBe(READINESS_MANIFEST_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(readiness, readinessContract.expectedReadinessManifestShape.requiredFields);
    expect(readinessContract.expectedReadinessManifestShape.requiredFields).toEqual(REQUIRED_MANIFEST_FIELDS);
    expectRequiredFields(validation, readinessContract.expectedValidationReportShape.requiredFields);
    expect(readinessContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreReadinessOutput(output, readinessContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.passed).toBe(true);
    expectNoForbiddenOutput(output);
  });

  test('phase inventory represents exactly phases 1 through 12 without live runtime overclaim', () => {
    const output = build();
    const inventory = manifest(output).phase_inventory;
    const expected = readinessContract.expectedReadinessManifestShape.phaseInventoryExpected;

    expect(inventory).toHaveLength(12);
    expect(inventory.map((item) => item.phase)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(DEFAULT_PHASE_INVENTORY).toEqual(expected);
    for (const item of inventory) {
      expectRequiredFields(item, readinessContract.expectedReadinessManifestShape.phaseInventoryRequiredFields);
      const fixtureItem = expected.find((entry) => entry.phase === item.phase);
      expect(item).toEqual(expect.objectContaining(fixtureItem));
      expect(item.real_now).not.toMatch(/server executed local work|manifest proves execution/i);
    }
  });

  test('schema and CLI registries cover all prior phases and remain stdout-only/no-side-effects', () => {
    const output = build();
    const readiness = manifest(output);

    expect(readiness.schema_registry).toHaveLength(12);
    expect(readiness.cli_registry).toHaveLength(12);
    expect(DEFAULT_SCHEMA_REGISTRY).toEqual(readinessContract.expectedReadinessManifestShape.schemaRegistryExpected);
    for (const entry of readiness.schema_registry) {
      expectRequiredFields(entry, readinessContract.expectedReadinessManifestShape.schemaRegistryRequiredFields);
      const expected = readinessContract.expectedReadinessManifestShape.schemaRegistryExpected.find((item) => item.phase === entry.phase);
      expect(entry).toEqual(expect.objectContaining(expected));
    }
    for (const entry of readiness.cli_registry) {
      expectRequiredFields(entry, readinessContract.expectedReadinessManifestShape.cliRegistryRequiredFields);
      expect(entry).toEqual(expect.objectContaining(readinessContract.expectedReadinessManifestShape.cliRegistryRequiredValues));
    }
  });

  test('capability matrix and boundary truth preserve server/local limits', () => {
    const readiness = manifest(build());

    expectRequiredFields(readiness.capability_matrix, readinessContract.expectedReadinessManifestShape.capabilityMatrixRequiredFields);
    expect(readiness.capability_matrix).toEqual(expect.objectContaining(readinessContract.expectedReadinessManifestShape.capabilityMatrixRequiredValues));
    expect(readiness.capability_matrix.allowedNowRiskTiers).toEqual(readinessContract.expectedReadinessManifestShape.allowedNowRiskTiers);
    expect(readiness.capability_matrix.blockedRiskTiers).toEqual(readinessContract.expectedReadinessManifestShape.blockedRiskTiers);
    expectRequiredFields(readiness.boundary_truth, readinessContract.expectedReadinessManifestShape.boundaryTruthRequiredFields);
    expect(readiness.boundary_truth).toEqual(expect.objectContaining(readinessContract.expectedReadinessManifestShape.boundaryTruthRequiredValues));
  });

  test('artifact summary indexes artifacts without inventing server runtime', () => {
    const readiness = manifest(build());

    expectRequiredFields(readiness.artifact_summary, readinessContract.expectedReadinessManifestShape.artifactSummaryRequiredFields);
    expect(readiness.artifact_summary).toEqual(expect.objectContaining(readinessContract.expectedReadinessManifestShape.artifactSummaryRequiredValues));
    expect(readiness.artifact_summary.missing_artifacts).toEqual([]);
    expect(readiness.artifact_summary.degraded_artifacts).toEqual([]);
    expect(readiness.artifact_summary.server_runtime_count).toBe(0);
  });

  test('verification summary does not fake proof when no command/result was supplied', () => {
    const readiness = manifest(build());

    expectRequiredFields(readiness.verification_summary, readinessContract.expectedReadinessManifestShape.verificationSummaryRequiredFields);
    expect(readiness.verification_summary.no_fake_test_proof).toBe(true);
    expect(readiness.verification_summary.test_commands_reported).toEqual([]);
    expect(readiness.verification_summary.test_proof_status).toBe('unknown');
    expect(readiness.verification_summary.unknown_or_degraded_proof).toBe(true);
    expect(readiness.verification_summary.missing_proof_reason).toMatch(/No complete command\/result/);
  });

  test('reported command proof is only proven when command/result evidence is supplied', () => {
    const output = build({
      verification: {
        commands: [{
          command: 'npm test -- --runTestsByPath __tests__/mira-core-readiness.test.js --runInBand',
          result: 'PASS',
          suite_count: 1,
          test_count: 16,
          passed_count: 16,
          failed_count: 0,
          evidenceRefs: [{ store: 'jest', eventId: 'phase13-targeted', relation: 'reported_result' }],
        }],
      },
    });
    const readiness = manifest(output);

    expect(readiness.verification_summary.test_proof_status).toBe('proven_by_reported_command');
    expect(readiness.verification_summary.unknown_or_degraded_proof).toBe(false);
    expect(readiness.verification_summary.test_result_counts).toEqual(expect.objectContaining({
      suite_count: 1,
      test_count: 16,
      passed_count: 16,
      failed_count: 0,
    }));
    expect(validateMiraCoreReadinessOutput(output, readinessContract).ok).toBe(true);
  });

  test('required blockers and Tier 0/Tier 1 next recommendations are present', () => {
    const readiness = manifest(build());

    expect(readiness.blocker_summary.map((item) => item.blocker_id)).toEqual(expect.arrayContaining(DEFAULT_BLOCKER_IDS));
    for (const blocker of readiness.blocker_summary) {
      expectRequiredFields(blocker, readinessContract.expectedReadinessManifestShape.blockerSummaryRequiredFields);
    }
    expect(readiness.next_phase_recommendations.map((item) => item.recommendation_id)).toEqual(expect.arrayContaining(DEFAULT_NEXT_RECOMMENDATION_IDS));
    for (const recommendation of readiness.next_phase_recommendations) {
      expectRequiredFields(recommendation, readinessContract.expectedReadinessManifestShape.nextRecommendationRequiredFields);
      expect(readinessContract.expectedReadinessManifestShape.allowedNextRecommendationRiskTiers).toContain(recommendation.risk_tier);
      expect(readinessContract.expectedReadinessManifestShape.forbiddenNextRecommendationRiskTiers).not.toContain(recommendation.risk_tier);
      expect(recommendation.allowed).toBe(true);
      expect(recommendation.why_safe).toBeTruthy();
      expect(recommendation.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in manifest and validation report', () => {
    const output = build();
    const expected = readinessContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(manifest(output).side_effect_result).toEqual(expect.objectContaining(expected));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expected));
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(manifest(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(manifest(output).side_effect_result.databaseWritesAttempted).toBe(0);
  });

  test('static validation rules are represented by validator checks', () => {
    const output = build();
    const validation = validateMiraCoreReadinessOutput(output, readinessContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of readinessContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful changes', () => {
    const outputA = build({
      profile: 'main',
      sessionId: 'session-13',
      deviceId: 'VIGIL',
    });
    const outputB = build({
      profile: 'main',
      sessionId: 'session-13',
      deviceId: 'VIGIL',
    });
    const changedPhase = build({
      profile: 'main',
      sessionId: 'session-13',
      deviceId: 'VIGIL',
      phase_inventory: readinessContract.expectedReadinessManifestShape.phaseInventoryExpected.map((item) => (
        item.phase === 7 ? { ...item, boundary_mode: 'changed_boundary_mode' } : item
      )),
    });
    const changedSchema = build({
      profile: 'main',
      sessionId: 'session-13',
      deviceId: 'VIGIL',
      schema_registry: readinessContract.expectedReadinessManifestShape.schemaRegistryExpected.map((item) => (
        item.phase === 12 ? { ...item, runtime_schemas: ['squidrun.mira_core.changed_schema.v0'] } : item
      )),
    });
    const capabilityChanged = clone(manifest(outputA));
    capabilityChanged.capability_matrix.serverCanExecuteLocal = true;

    expect(manifest(outputA).idempotency_key).toBe(manifest(outputB).idempotency_key);
    expect(manifest(changedPhase).idempotency_key).not.toBe(manifest(outputA).idempotency_key);
    expect(manifest(changedSchema).idempotency_key).not.toBe(manifest(outputA).idempotency_key);
    expect(manifestIdempotencyKey(capabilityChanged)).not.toBe(manifest(outputA).idempotency_key);
    expect(report(outputA).idempotency_result.excludes).toEqual(expect.arrayContaining(['generated_at', 'manifest_id', 'validation_run_id']));
  });

  test('validator rejects missing phase, live behavior labels, capability lies, direct targets, fake proof, missing blockers, unsafe recommendations, side effects, and idempotency tampering', () => {
    const valid = build();
    expect(validateMiraCoreReadinessOutput(valid, readinessContract).ok).toBe(true);

    const missingPhase = clone(valid);
    missingPhase.readiness_manifest.phase_inventory = missingPhase.readiness_manifest.phase_inventory.filter((item) => item.phase !== 12);
    expectValidatorFails(missingPhase, 'phase-inventory-complete');

    const liveRuntime = clone(valid);
    liveRuntime.readiness_manifest.phase_inventory[6].status = 'live_server_runtime_present';
    expectValidatorFails(liveRuntime, 'phase-paths-do-not-overclaim');

    const serverCanExecute = clone(valid);
    serverCanExecute.readiness_manifest.capability_matrix.serverCanExecuteLocal = true;
    expectValidatorFails(serverCanExecute, 'capability-boundary-truth');

    const serverCanProve = clone(valid);
    serverCanProve.readiness_manifest.boundary_truth.serverCanProveModelProcessing = true;
    expectValidatorFails(serverCanProve, 'capability-boundary-truth');

    const directBuilderTarget = clone(valid);
    directBuilderTarget.readiness_manifest.boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    expectValidatorFails(directBuilderTarget, 'capability-boundary-truth');

    const fakeProof = clone(valid);
    fakeProof.readiness_manifest.verification_summary.test_proof_status = 'proven_by_reported_command';
    fakeProof.readiness_manifest.verification_summary.test_commands_reported = [];
    fakeProof.readiness_manifest.verification_summary.unknown_or_degraded_proof = false;
    expectValidatorFails(fakeProof, 'verification-proof-honesty');

    const missingBlocker = clone(valid);
    missingBlocker.readiness_manifest.blocker_summary = missingBlocker.readiness_manifest.blocker_summary.slice(1);
    expectValidatorFails(missingBlocker, 'required-blockers-present');

    const unsafeRecommendation = clone(valid);
    unsafeRecommendation.readiness_manifest.next_phase_recommendations[0].risk_tier = 'tier3_external_side_effect';
    expectValidatorFails(unsafeRecommendation, 'next-recommendations-tier-limited');

    const sideEffectLie = clone(valid);
    sideEffectLie.readiness_manifest.side_effect_result.no_network_performed = false;
    sideEffectLie.readiness_manifest.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(sideEffectLie, 'side-effect-truth');

    const outputFileLie = clone(valid);
    outputFileLie.validation_report.side_effect_result.no_runtime_output_file_written = false;
    outputFileLie.validation_report.side_effect_result.outputFileWritten = true;
    expectValidatorFails(outputFileLie, 'validation-side-effect-truth');

    const badIdempotency = clone(valid);
    badIdempotency.readiness_manifest.idempotency_key = 'readiness-manifest-idem:tampered';
    expectValidatorFails(badIdempotency, 'idempotency-stable-sensitive');
  });

  test('validator rejects forbidden raw/private output content', () => {
    const bad = clone(build());
    bad.readiness_manifest.evidenceRefs.push({
      store: 'bad',
      eventId: 'bad',
      relation: 'raw comms transcript',
    });

    const validation = validateMiraCoreReadinessOutput(bad, readinessContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'forbidden-private-content-blocked')).toEqual(expect.objectContaining({ ok: false }));
    expect(validation.checks.find((entry) => entry.id === 'forbidden-substrings-absent')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('acceptance checks are covered by explicit fixture-driven assertions', () => {
    const output = build();
    const readiness = manifest(output);
    const acceptanceIds = readinessContract.acceptanceChecks.map((check) => check.id);

    expect(acceptanceIds).toEqual([
      'all-phases-1-through-12-represented',
      'contract-only-phases-not-mislabeled-live',
      'schema-and-cli-registries-complete',
      'capability-matrix-preserves-server-local-boundary',
      'architect-coordination-allowed-but-not-execution-proof',
      'raw-private-content-forbidden',
      'phase-13-no-side-effects',
      'verification-summary-does-not-fake-proof',
      'required-blocker-summary-present',
      'next-recommendations-tier0-tier1-only',
      'idempotency-stable-and-sensitive',
    ]);
    expect(readiness.phase_inventory).toHaveLength(readinessContract.acceptanceChecks[0].expected.phase_count);
    expect(readiness.boundary_truth.manifestIsExecutionProof).toBe(false);
    expect(readiness.boundary_truth.socketIsBridgeGreenProof).toBe(false);
    expect(readiness.boundary_truth.dryRunLeaseIsModelProcessingProof).toBe(false);
    expect(report(output).forbidden_output_result).toEqual(expect.objectContaining({
      forbidden_output_result: 'blocked',
      raw_private_content_exported: false,
    }));
  });

  test('CLI prints stdout JSON only, consumes fixture directly, and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'readiness.json'])).toEqual({
      fixturePath: expect.stringContaining('mira-core-readiness-contract.json'),
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=readiness.json'], JSON.stringify({
      verification: {
        commands: [{
          command: 'npm test -- --runTestsByPath __tests__/mira-core-readiness.test.js --runInBand',
          result: 'PASS',
          suite_count: 1,
          test_count: 16,
          passed_count: 16,
          failed_count: 0,
        }],
      },
    }));

    expect(manifest(output).schema).toBe(READINESS_MANIFEST_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(report(output).passed).toBe(true);
    expect(report(output).side_effect_result.no_network_performed).toBe(true);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.readiness_manifest.schema).toBe(READINESS_MANIFEST_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
  });
});
