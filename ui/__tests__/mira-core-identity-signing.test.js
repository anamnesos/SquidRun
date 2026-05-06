const identitySigningContract = require('./fixtures/mira-core-identity-signing-contract.json');
const {
  BASELINE_COMMIT,
  IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreIdentitySigning,
  validateMiraCoreIdentitySigningOutput,
} = require('../modules/mira-core/identity-signing');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-identity-signing');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreIdentitySigning({
    contract: identitySigningContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.identity_signing_assessment;
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
  expect(() => assertNoForbiddenOutput(output, identitySigningContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreIdentitySigningOutput(output, identitySigningContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core identity/signing assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, identitySigningContract.expectedOutputShape.requiredTopLevelFields);
    expect(identitySigningContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, identitySigningContract.expectedIdentitySigningAssessmentShape.requiredFields);
    expect(identitySigningContract.expectedIdentitySigningAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, identitySigningContract.expectedValidationReportShape.requiredFields);
    expect(identitySigningContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreIdentitySigningOutput(output, identitySigningContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 14 baseline and keeps real signing gated', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(identitySigningContract.baseline.commit);
    expect(currentAssessment.migration_path).toEqual(expect.objectContaining({
      baseline_commit: BASELINE_COMMIT,
      phase_14_gap_blocker_id: 'server-identity-and-signing-specified',
      real_signing_allowed_now: false,
      future_real_signing_allowed_after_gates: true,
      feature_flag_default: 'off',
      no_real_key_generation_now: true,
    }));
  });

  test('server identity and no-secret guarantees are validation-only test-vector metadata', () => {
    const currentAssessment = assessment(build());
    const expected = identitySigningContract.expectedIdentitySigningAssessmentShape;

    expectRequiredFields(currentAssessment.server_identity, expected.serverIdentityRequiredFields);
    expect(currentAssessment.server_identity).toEqual(expect.objectContaining(expected.serverIdentityRequiredValues));
    expectRequiredFields(currentAssessment.no_secret_guarantees, expected.noSecretGuaranteesRequiredFields);
    expect(currentAssessment.no_secret_guarantees).toEqual(expect.objectContaining(expected.noSecretGuaranteesRequiredValues));
    expect(currentAssessment.server_identity.public_key_fingerprint).toBe('sha256:test-vector-public-fingerprint');
    expect(currentAssessment.no_secret_guarantees.public_test_vector_only).toBe(true);
    expect(currentAssessment.no_secret_guarantees.fingerprint_non_secret).toBe(true);
  });

  test('device/profile/session binding is Architect-only, scoped, and freshness-gated', () => {
    const binding = assessment(build()).device_profile_session_binding;
    const expected = identitySigningContract.expectedIdentitySigningAssessmentShape;

    expectRequiredFields(binding, expected.deviceProfileSessionBindingRequiredFields);
    expect(binding).toEqual(expect.objectContaining(expected.deviceProfileSessionBindingRequiredValues));
    expectRequiredFields(binding.freshness, expected.freshnessRequiredFields);
    expect(binding.freshness).toEqual(expect.objectContaining(expected.freshnessRequiredValues));
    expect(binding.allowed_target_role).toBe('architect');
    expect(binding.cross_profile_blocked).toBe(true);
    expect(binding.side_profile_blocked).toBe(true);
    expect(binding.stale_binding_rejected).toBe(true);
  });

  test('canonical envelope uses only fixture-declared placeholder algorithms and signed fields', () => {
    const envelope = assessment(build()).signing_envelope;
    const expected = identitySigningContract.expectedIdentitySigningAssessmentShape;

    expectRequiredFields(envelope, expected.signingEnvelopeRequiredFields);
    expect(envelope).toEqual(expect.objectContaining(expected.signingEnvelopeRequiredValues));
    expect(envelope.signature_algorithm).toBe('ed25519-test-vector');
    expect(envelope.signature_algorithm_allowlist).toEqual(expected.signingEnvelopeRequiredValues.signature_algorithm_allowlist);
    expect(envelope.signed_fields).toEqual(expect.arrayContaining(expected.signedFieldsRequired));
    expect(envelope.placeholder_test_vector_only).toBe(true);
    expect(envelope.real_signature_generated_now).toBe(false);
  });

  test('verification, replay, rotation, and revocation stay integrity-only and rejecting unsafe keys', () => {
    const currentAssessment = assessment(build());
    const expected = identitySigningContract.expectedIdentitySigningAssessmentShape;
    const verification = currentAssessment.verification_report_contract;

    expectRequiredFields(verification, expected.verificationReportRequiredFields);
    expect(verification).toEqual(expect.objectContaining(expected.verificationReportRequiredValues));
    expectRequiredFields(verification.replay_idempotency_result, expected.replayIdempotencyResultRequiredFields);
    expect(verification.replay_idempotency_result).toEqual(expect.objectContaining(expected.replayIdempotencyResultRequiredValues));
    expect(verification.key_status).toEqual(expect.objectContaining({
      unsupported_algorithm_blocked: true,
      unknown_key_blocked: true,
      revoked_key_blocked: true,
      expired_key_blocked: true,
    }));
    expectRequiredFields(currentAssessment.rotation_revocation_rules, expected.rotationRevocationRequiredFields);
    expect(currentAssessment.rotation_revocation_rules).toEqual(expect.objectContaining(expected.rotationRevocationRequiredValues));
  });

  test('boundary truth does not convert signatures into authorization, proof, bridge green, or Tier 2+ access', () => {
    const boundary = assessment(build()).boundary_truth;
    const expected = identitySigningContract.expectedIdentitySigningAssessmentShape;

    expectRequiredFields(boundary, expected.boundaryTruthRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.boundaryTruthRequiredValues));
    expect(boundary.signature_validates_envelope_integrity_only).toBe(true);
    expect(boundary.signature_is_authorization_for_local_execution).toBe(false);
    expect(boundary.signature_is_model_processing_proof).toBe(false);
    expect(boundary.signature_is_bridge_green_proof).toBe(false);
    expect(boundary.signature_permits_tier2_plus_actions).toBe(false);
    expect(boundary.signature_permits_customer_send_deploy_trade).toBe(false);
    expect(boundary.localAcceptanceRequiredForAnyIntent).toBe(true);
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      identitySigningContract.expectedIdentitySigningAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, identitySigningContract.expectedIdentitySigningAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_signing).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      identitySigningContract.expectedIdentitySigningAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, identitySigningContract.expectedIdentitySigningAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = identitySigningContract.expectedIdentitySigningAssessmentShape.sideEffectRequiredValues;
    const expectedReport = identitySigningContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.authSecretsOrSigningMaterialCreated).toBe(0);
    expect(assessment(output).side_effect_result.realKeyGenerationsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreIdentitySigningOutput(output, identitySigningContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of identitySigningContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(identitySigningContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(identitySigningContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects private key, secret, token, and forbidden string leakage', () => {
    const valid = build();

    const exported = clone(valid);
    exported.identity_signing_assessment.server_identity.private_key_exported = true;
    expectValidatorFails(exported, 'server-identity-shape-required');

    const stored = clone(valid);
    stored.identity_signing_assessment.no_secret_guarantees.private_key_stored = true;
    expectValidatorFails(stored, 'no-secret-guarantees-required');

    const secretFixture = clone(valid);
    secretFixture.identity_signing_assessment.no_secret_guarantees.secret_material_in_fixture = true;
    expectValidatorFails(secretFixture, 'no-secret-guarantees-required');

    const visibleToken = clone(valid);
    visibleToken.identity_signing_assessment.server_identity.key_id = 'access_token:abc123';
    expectValidatorFails(visibleToken, 'forbidden-output-strings-absent');

    const privateMaterial = clone(valid);
    privateMaterial.identity_signing_assessment.server_identity.public_key_fingerprint = 'BEGIN PRIVATE KEY';
    expectValidatorFails(privateMaterial, 'forbidden-output-strings-absent');
  });

  test('validator rejects unknown/revoked keys, unsupported algorithms, replay, expiry, and clock skew gaps', () => {
    const valid = build();

    const unsupportedAlgorithm = clone(valid);
    unsupportedAlgorithm.identity_signing_assessment.signing_envelope.signature_algorithm = 'rsa-sha1-production';
    expectValidatorFails(unsupportedAlgorithm, 'canonical-envelope-shape-required');
    expectValidatorFails(unsupportedAlgorithm, 'signature-algorithm-allowlist-required');

    const unknownKeyAccepted = clone(valid);
    unknownKeyAccepted.identity_signing_assessment.rotation_revocation_rules.unknown_key_blocked = false;
    expectValidatorFails(unknownKeyAccepted, 'rotation-revocation-rules-required');

    const revokedKeyAccepted = clone(valid);
    revokedKeyAccepted.identity_signing_assessment.rotation_revocation_rules.revoked_keys_blocked = false;
    expectValidatorFails(revokedKeyAccepted, 'rotation-revocation-rules-required');

    const expiredEnvelopeAccepted = clone(valid);
    expiredEnvelopeAccepted.identity_signing_assessment.verification_report_contract.replay_idempotency_result.expired_envelope_rejected = false;
    expectValidatorFails(expiredEnvelopeAccepted, 'verification-report-shape-required');
    expectValidatorFails(expiredEnvelopeAccepted, 'replay-idempotency-freshness-required');

    const replayAccepted = clone(valid);
    replayAccepted.identity_signing_assessment.verification_report_contract.replay_idempotency_result.nonce_reuse_rejected = false;
    expectValidatorFails(replayAccepted, 'verification-report-shape-required');

    const clockSkewIgnored = clone(valid);
    clockSkewIgnored.identity_signing_assessment.verification_report_contract.clock_skew_freshness_result.clock_skew_ignored = true;
    expectValidatorFails(clockSkewIgnored, 'verification-report-shape-required');
  });

  test('validator rejects Builder/Oracle targets, Tier 2+ authorization, and signature proof overclaims', () => {
    const valid = build();

    const builderTarget = clone(valid);
    builderTarget.identity_signing_assessment.device_profile_session_binding.allowed_target_role = 'builder';
    expectValidatorFails(builderTarget, 'device-profile-session-binding-required');
    expectValidatorFails(builderTarget, 'architect-only-target-and-local-acceptance-required');

    const oracleTarget = clone(valid);
    oracleTarget.identity_signing_assessment.boundary_truth.allowed_target_role = 'oracle';
    expectValidatorFails(oracleTarget, 'boundary-truth-integrity-only');
    expectValidatorFails(oracleTarget, 'architect-only-target-and-local-acceptance-required');

    const tierTwoAuthorized = clone(valid);
    tierTwoAuthorized.identity_signing_assessment.boundary_truth.signature_permits_tier2_plus_actions = true;
    expectValidatorFails(tierTwoAuthorized, 'boundary-truth-integrity-only');

    const localExecutionAuthorized = clone(valid);
    localExecutionAuthorized.identity_signing_assessment.boundary_truth.signature_is_authorization_for_local_execution = true;
    expectValidatorFails(localExecutionAuthorized, 'boundary-truth-integrity-only');

    const modelProofClaim = clone(valid);
    modelProofClaim.identity_signing_assessment.verification_report_contract.model_processing_proven = true;
    expectValidatorFails(modelProofClaim, 'verification-report-shape-required');

    const bridgeGreenClaim = clone(valid);
    bridgeGreenClaim.identity_signing_assessment.boundary_truth.signature_is_bridge_green_proof = true;
    expectValidatorFails(bridgeGreenClaim, 'boundary-truth-integrity-only');
  });

  test('validator rejects baseline drift, missing gates, missing blockers, side-effect lies, and output-file claims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.identity_signing_assessment.baseline_commit = '785dbec';
    expectValidatorFails(baselineDrift, 'phase-15-baseline-f41b02a-pinned');

    const missingGate = clone(valid);
    missingGate.identity_signing_assessment.acceptance_gate_summary = missingGate.identity_signing_assessment.acceptance_gate_summary.slice(1);
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.identity_signing_assessment.blocker_summary = missingBlocker.identity_signing_assessment.blocker_summary.slice(1);
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const sideEffectLie = clone(valid);
    sideEffectLie.identity_signing_assessment.side_effect_result.no_network_performed = false;
    sideEffectLie.identity_signing_assessment.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(sideEffectLie, 'validation-only-no-real-signing');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_auth_secret_or_signing_material_created = false;
    reportSideEffectLie.validation_report.side_effect_result.authSecretsOrSigningMaterialCreated = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');

    const outputFileClaim = clone(valid);
    outputFileClaim.identity_signing_assessment.side_effect_result.outputFileWritten = true;
    expectValidatorFails(outputFileClaim, 'validation-only-no-real-signing');
  });

  test('CLI prints stdout JSON only, consumes fixture directly, and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'identity-signing.json'])).toEqual({
      fixturePath: expect.stringContaining('mira-core-identity-signing-contract.json'),
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=identity-signing.json'], JSON.stringify({ profile: 'main' }));

    expect(assessment(output).schema).toBe(IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(report(output).decision).toBe('accepted');
    expect(assessment(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(assessment(output).boundary_truth.allowed_target_role).toBe('architect');
    expect(assessment(output).boundary_truth.serverCanExecuteLocal).toBe(false);
    expect(assessment(output).boundary_truth.serverCanProveModelProcessing).toBe(false);
    expect(assessment(output).side_effect_result.no_network_performed).toBe(true);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.identity_signing_assessment.schema).toBe(IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
  });
});
