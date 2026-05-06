const runtimeGapContract = require('./fixtures/mira-core-server-runtime-gap-contract.json');
const {
  BASELINE_COMMIT,
  GAP_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreServerRuntimeGap,
  validateMiraCoreServerRuntimeGapOutput,
} = require('../modules/mira-core/server-runtime-gap');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-server-runtime-gap');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function build(inputSignals = {}) {
  return buildMiraCoreServerRuntimeGap({
    contract: runtimeGapContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.server_runtime_gap_assessment;
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
  for (const forbidden of [...runtimeGapContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreServerRuntimeGapOutput(output, runtimeGapContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core server-runtime gap assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const gap = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, runtimeGapContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeGapContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(gap.schema).toBe(GAP_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(gap, runtimeGapContract.expectedGapAssessmentShape.requiredFields);
    expect(runtimeGapContract.expectedGapAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, runtimeGapContract.expectedValidationReportShape.requiredFields);
    expect(runtimeGapContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreServerRuntimeGapOutput(output, runtimeGapContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.passed).toBe(true);
    expectNoForbiddenOutput(output);
  });

  test('pins Phase 1-13 baseline and keeps real server runtime blocked', () => {
    const gap = assessment(build());

    expect(gap.baseline_commit).toBe(BASELINE_COMMIT);
    expect(gap.baseline_refs).toEqual(expect.objectContaining({
      commit: BASELINE_COMMIT,
      phase_range: runtimeGapContract.acceptanceChecks.find((check) => check.id === 'baseline-785dbec-pinned').expected.phase_range,
    }));
    expect(gap.migration_boundary).toEqual(expect.objectContaining({
      phase_1_13_baseline_commit: BASELINE_COMMIT,
      phase_1_13_remains_validation_only: true,
      real_server_runtime_blocked: true,
      feature_flag_default: 'off',
    }));
  });

  test('server identity and signing gates are blocked until specified and reviewed', () => {
    const gap = assessment(build());
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(gap.server_identity, expected.serverIdentityRequiredFields);
    expect(gap.server_identity).toEqual(expect.objectContaining(expected.serverIdentityRequiredValues));
    expectRequiredFields(gap.signing_envelope, expected.signingEnvelopeRequiredFields);
    expect(gap.signing_envelope).toEqual(expect.objectContaining(expected.signingEnvelopeRequiredValues));
    expect(gap.server_identity.private_key_exported).toBe(false);
    expect(gap.signing_envelope.signed_fields).toEqual(expect.arrayContaining([
      'profile',
      'sessionId',
      'deviceId',
      'idempotency_key',
      'nonce',
      'timestamp',
      'source_watermarks',
      'redaction_audit',
    ]));
  });

  test('auth binding rejects cross-scope and side-profile access before receive/store', () => {
    const gap = assessment(build());
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(gap.auth_binding, expected.authBindingRequiredFields);
    expect(gap.auth_binding).toEqual(expect.objectContaining(expected.authBindingRequiredValues));
    expect(gap.auth_binding.profile_mismatch_rejected).toBe(true);
    expect(gap.auth_binding.session_mismatch_rejected).toBe(true);
    expect(gap.auth_binding.device_mismatch_rejected).toBe(true);
    expect(gap.auth_binding.side_profile_access_blocked).toBe(true);
  });

  test('receive/store allows only redacted eligible items and blocks raw classes', () => {
    const gap = assessment(build());
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(gap.receive_store_policy, expected.receiveStorePolicyRequiredFields);
    expect(gap.receive_store_policy).toEqual(expect.objectContaining(expected.receiveStorePolicyRequiredValues));
    expect(gap.receive_store_policy.eligible_syncEligibility).toEqual(expected.eligibleSyncEligibility);
    expect(gap.receive_store_policy.eligible_redactionStatus).toEqual(expected.eligibleRedactionStatus);
    expect(gap.receive_store_policy.blocked_syncEligibility).toEqual(expected.blockedSyncEligibility);
    expect(gap.receive_store_policy.blocked_raw_classes).toEqual(expected.blockedRawClasses);
    expect(gap.receive_store_policy.raw_storage_allowed).toBe(false);
    expect(gap.receive_store_policy.no_store_write_now).toBe(true);
  });

  test('deletion/export/retention and replay/watermark gates are required before future storage', () => {
    const gap = assessment(build());
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(gap.deletion_export_retention, expected.deletionExportRetentionRequiredFields);
    expect(gap.deletion_export_retention).toEqual(expect.objectContaining(expected.deletionExportRetentionRequiredValues));
    expect(gap.deletion_export_retention.redacted_export_only).toBe(true);
    expect(gap.deletion_export_retention.no_deletion_or_export_now).toBe(true);
    expectRequiredFields(gap.replay_idempotency_watermarks, expected.replayIdempotencyWatermarksRequiredFields);
    expect(gap.replay_idempotency_watermarks).toEqual(expect.objectContaining(expected.replayIdempotencyWatermarksRequiredValues));
    expect(gap.replay_idempotency_watermarks.nonce_reuse_rejected).toBe(true);
    expect(gap.replay_idempotency_watermarks.watermark_regression_rejected).toBe(true);
  });

  test('offline local-arms and bridge/delivery proof boundaries do not overclaim', () => {
    const gap = assessment(build());
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(gap.offline_local_arms_status, expected.offlineLocalArmsStatusRequiredFields);
    expect(gap.offline_local_arms_status).toEqual(expect.objectContaining(expected.offlineLocalArmsStatusRequiredValues));
    expectRequiredFields(gap.bridge_delivery_proof_truth, expected.bridgeDeliveryProofTruthRequiredFields);
    expect(gap.bridge_delivery_proof_truth).toEqual(expect.objectContaining(expected.bridgeDeliveryProofTruthRequiredValues));
    expect(gap.bridge_delivery_proof_truth.bridge_green_requires).toEqual(expected.bridgeDeliveryProofTruthRequiredValues.bridge_green_requires);
    expect(gap.bridge_delivery_proof_truth.model_processing_proof_requires).toEqual(expected.bridgeDeliveryProofTruthRequiredValues.model_processing_proof_requires);
  });

  test('server-to-local intent limits are Architect-only, Tier 0/Tier 1, and local-acceptance-required', () => {
    const limits = assessment(build()).server_to_local_intent_limits;
    const expected = runtimeGapContract.expectedGapAssessmentShape;

    expectRequiredFields(limits, expected.serverToLocalIntentLimitsRequiredFields);
    expect(limits).toEqual(expect.objectContaining(expected.serverToLocalIntentLimitsRequiredValues));
    expect(limits.allowed_target_roles).toEqual(['architect']);
    expect(limits.blocked_direct_targets).toEqual(['builder', 'oracle']);
    expect(limits.allowed_risk_tiers).toEqual(['tier0_read_only', 'tier1_local_reversible']);
    expect(limits.blocked_risk_tiers).toEqual([
      'tier2_repo_mutation',
      'tier3_external_side_effect',
      'tier4_financial_or_irreversible',
    ]);
  });

  test('required acceptance gates and blocker summaries are complete and unique', () => {
    const gap = assessment(build());

    expect(gap.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(gap.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(runtimeGapContract.expectedGapAssessmentShape.requiredAcceptanceGateIds);
    for (const gate of gap.acceptance_gate_summary) {
      expectRequiredFields(gate, runtimeGapContract.expectedGapAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
    }
    expect(gap.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(gap.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(runtimeGapContract.expectedGapAssessmentShape.requiredBlockerIds);
    for (const blocker of gap.blocker_summary) {
      expectRequiredFields(blocker, runtimeGapContract.expectedGapAssessmentShape.blockerSummaryRequiredFields);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expected = runtimeGapContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expected));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expected));
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseOrStoreWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented by validator checks', () => {
    const output = build();
    const validation = validateMiraCoreServerRuntimeGapOutput(output, runtimeGapContract);
    const checkIds = validation.checks.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeGapContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(runtimeGapContract.acceptanceChecks.map((check) => check.id)).toEqual([
      'baseline-785dbec-pinned',
      'identity-and-signing-missing-keeps-server-blocked',
      'auth-binding-rejects-cross-scope',
      'receive-store-allows-only-redacted-eligible-items',
      'raw-private-content-rejected',
      'deletion-export-retention-required-before-store',
      'replay-watermark-regression-rejected',
      'offline-local-arms-status-does-not-overclaim',
      'server-to-local-intents-architect-tier0-tier1-only',
      'bridge-delivery-proof-boundaries',
      'migration-from-phase-1-13-remains-blocked',
      'phase-14-side-effect-truth',
    ]);
  });

  test('validator rejects runtime, privacy, proof, intent, side-effect, and output-file overclaims', () => {
    const valid = build();
    expect(validateMiraCoreServerRuntimeGapOutput(valid, runtimeGapContract).ok).toBe(true);

    const rawStorageAllowed = clone(valid);
    rawStorageAllowed.server_runtime_gap_assessment.receive_store_policy.raw_storage_allowed = true;
    expectValidatorFails(rawStorageAllowed, 'redacted-receive-store-eligibility-only');

    const privateKeyExported = clone(valid);
    privateKeyExported.server_runtime_gap_assessment.server_identity.private_key_exported = true;
    expectValidatorFails(privateKeyExported, 'server-identity-required-before-receive');

    const privateKeyString = clone(valid);
    privateKeyString.server_runtime_gap_assessment.server_identity.blocking_gaps.push('BEGIN PRIVATE KEY');
    const privateKeyStringValidation = validateMiraCoreServerRuntimeGapOutput(privateKeyString, runtimeGapContract);
    expect(privateKeyStringValidation.ok).toBe(false);
    expect(privateKeyStringValidation.checks.find((entry) => entry.id === 'raw-private-content-blocked')).toEqual(expect.objectContaining({ ok: false }));

    const socketGreen = clone(valid);
    socketGreen.server_runtime_gap_assessment.bridge_delivery_proof_truth.socketIsBridgeGreenProof = true;
    expectValidatorFails(socketGreen, 'bridge-delivery-proof-boundaries-preserved');

    const deliveryProof = clone(valid);
    deliveryProof.server_runtime_gap_assessment.bridge_delivery_proof_truth.deliveryAcceptanceIsModelProcessingProof = true;
    expectValidatorFails(deliveryProof, 'bridge-delivery-proof-boundaries-preserved');

    const queueWrite = clone(valid);
    queueWrite.server_runtime_gap_assessment.server_to_local_intent_limits.queue_write_allowed_now = true;
    expectValidatorFails(queueWrite, 'server-to-local-intents-architect-only');

    const builderTarget = clone(valid);
    builderTarget.server_runtime_gap_assessment.server_to_local_intent_limits.serverOriginatedTarget = 'builder';
    expectValidatorFails(builderTarget, 'server-to-local-intents-architect-only');

    const oracleTarget = clone(valid);
    oracleTarget.server_runtime_gap_assessment.server_to_local_intent_limits.allowed_target_roles = ['architect', 'oracle'];
    expectValidatorFails(oracleTarget, 'server-to-local-intents-architect-only');

    const tier3Intent = clone(valid);
    tier3Intent.server_runtime_gap_assessment.server_to_local_intent_limits.allowed_risk_tiers.push('tier3_external_side_effect');
    expectValidatorFails(tier3Intent, 'server-to-local-intents-architect-only');

    const tier4Intent = clone(valid);
    tier4Intent.server_runtime_gap_assessment.server_to_local_intent_limits.blocked_risk_tiers = ['tier2_repo_mutation'];
    expectValidatorFails(tier4Intent, 'server-to-local-intents-architect-only');

    const sideEffectLie = clone(valid);
    sideEffectLie.server_runtime_gap_assessment.side_effect_result.no_network_performed = false;
    sideEffectLie.server_runtime_gap_assessment.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(sideEffectLie, 'phase-14-validation-only');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_file_mutation_performed_by_validator = false;
    reportSideEffectLie.validation_report.side_effect_result.outputFileWritten = true;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');

    const outputFileClaim = clone(valid);
    outputFileClaim.server_runtime_gap_assessment.side_effect_result.outputFileWritten = true;
    expectValidatorFails(outputFileClaim, 'phase-14-validation-only');
  });

  test('validator rejects missing gate, missing blocker, baseline drift, and migration overclaim', () => {
    const valid = build();

    const missingGate = clone(valid);
    missingGate.server_runtime_gap_assessment.acceptance_gate_summary = missingGate.server_runtime_gap_assessment.acceptance_gate_summary.slice(1);
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.server_runtime_gap_assessment.blocker_summary = missingBlocker.server_runtime_gap_assessment.blocker_summary.slice(1);
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const baselineDrift = clone(valid);
    baselineDrift.server_runtime_gap_assessment.baseline_commit = 'deadbee';
    expectValidatorFails(baselineDrift, 'baseline-commit-pinned');

    const migrationOverclaim = clone(valid);
    migrationOverclaim.server_runtime_gap_assessment.migration_boundary.real_server_runtime_blocked = false;
    expectValidatorFails(migrationOverclaim, 'migration-boundary-from-phase-1-13');
  });

  test('CLI prints stdout JSON only, consumes fixture directly, and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'runtime-gap.json'])).toEqual({
      fixturePath: expect.stringContaining('mira-core-server-runtime-gap-contract.json'),
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=runtime-gap.json'], JSON.stringify({ profile: 'main' }));

    expect(assessment(output).schema).toBe(GAP_ASSESSMENT_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(report(output).passed).toBe(true);
    expect(assessment(output).migration_boundary.real_server_runtime_blocked).toBe(true);
    expect(assessment(output).offline_local_arms_status.serverCanExecuteLocal).toBe(false);
    expect(assessment(output).bridge_delivery_proof_truth.deliveryAcceptanceIsModelProcessingProof).toBe(false);
    expect(report(output).side_effect_result.no_network_performed).toBe(true);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.server_runtime_gap_assessment.schema).toBe(GAP_ASSESSMENT_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
  });
});
