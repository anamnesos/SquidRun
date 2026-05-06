const authBindingContract = require('./fixtures/mira-core-auth-binding-contract.json');
const {
  AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION,
  BASELINE_COMMIT,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreAuthBinding,
  validateMiraCoreAuthBindingOutput,
} = require('../modules/mira-core/auth-binding');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-auth-binding');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreAuthBinding({
    contract: authBindingContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.auth_binding_assessment;
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
  expect(() => assertNoForbiddenOutput(output, authBindingContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreAuthBindingOutput(output, authBindingContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core auth binding assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, authBindingContract.expectedOutputShape.requiredTopLevelFields);
    expect(authBindingContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, authBindingContract.expectedAuthBindingAssessmentShape.requiredFields);
    expect(authBindingContract.expectedAuthBindingAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, authBindingContract.expectedValidationReportShape.requiredFields);
    expect(authBindingContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreAuthBindingOutput(output, authBindingContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 15 baseline and keeps real auth gated', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(authBindingContract.baseline.commit);
    expect(currentAssessment.migration_path).toEqual(expect.objectContaining({
      baseline_commit: BASELINE_COMMIT,
      phase_14_gap_blocker_id: 'auth-session-device-profile-binding-specified',
      real_auth_allowed_now: false,
      future_real_auth_allowed_after_gates: true,
      feature_flag_default: 'off',
      no_real_token_generation_now: true,
      no_session_creation_now: true,
    }));
  });

  test('auth binding is Architect-only and creates no token or session', () => {
    const currentAssessment = assessment(build());
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(currentAssessment.auth_binding, expected.authBindingRequiredFields);
    expect(currentAssessment.auth_binding).toEqual(expect.objectContaining(expected.authBindingRequiredValues));
    expect(currentAssessment.auth_binding.principal_id).toBe('principal:james-main-validation');
    expect(currentAssessment.auth_binding.role).toBe('architect');
    expect(currentAssessment.auth_binding.token_generated_now).toBe(false);
    expect(currentAssessment.auth_binding.session_created_now).toBe(false);
  });

  test('session, device, profile, role, and target proof rules fail closed', () => {
    const rules = assessment(build()).scope_rules;
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(rules, expected.scopeRulesRequiredFields);
    expect(rules).toEqual(expect.objectContaining(expected.scopeRulesRequiredValues));
    expect(rules.current_session_freshness_required).toBe(true);
    expect(rules.device_registration_status_required).toBe(true);
    expect(rules.role_discovery_proof_required).toBe(true);
    expect(rules.target_proof_required).toBe(true);
    expect(rules.profile_mismatch_rejected).toBe(true);
    expect(rules.side_profile_access_blocked).toBe(true);
  });

  test('token envelope is hash-only with audience, scope, expiry, revocation, and replay controls', () => {
    const envelope = assessment(build()).token_envelope;
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(envelope, expected.tokenEnvelopeRequiredFields);
    expect(envelope).toEqual(expect.objectContaining(expected.tokenEnvelopeRequiredValues));
    expect(envelope.token_id).toBe('token-validation-001');
    expect(envelope.token_hash).toBe('sha256:test-vector-token-hash');
    expect(envelope.scope_allowlist).toEqual(['proposal:validate', 'intent:validate', 'status:read']);
    expect(envelope.token_hash_only).toBe(true);
    expect(envelope.raw_token_available).toBe(false);
  });

  test('authorization boundary allows validation only and blocks execution, targets, and durable effects', () => {
    const boundary = assessment(build()).authorization_boundary;
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(boundary, expected.authorizationBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.authorizationBoundaryRequiredValues));
    expect(boundary.valid_auth_permits).toBe('server_to_local_proposal_intent_validation_only');
    expect(boundary.local_execution_authorized).toBe(false);
    expect(boundary.shell_or_pty_authorized).toBe(false);
    expect(boundary.builder_direct_target_authorized).toBe(false);
    expect(boundary.oracle_direct_target_authorized).toBe(false);
    expect(boundary.tier2_plus_authorized).toBe(false);
    expect(boundary.memory_profile_commit_authorized).toBe(false);
    expect(boundary.local_acceptance_required).toBe(true);
  });

  test('profile mismatch handling withholds side-profile content and exports only redacted reason codes', () => {
    const mismatch = assessment(build()).profile_mismatch_handling;
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(mismatch, expected.profileMismatchHandlingRequiredFields);
    expect(mismatch).toEqual(expect.objectContaining(expected.profileMismatchHandlingRequiredValues));
    expect(mismatch.decision).toBe('blocked');
    expect(mismatch.fail_closed).toBe(true);
    expect(mismatch.mismatch_reason_codes).toEqual([
      'profile_mismatch',
      'session_mismatch',
      'device_mismatch',
      'side_profile_blocked',
    ]);
  });

  test('verification report contains freshness, binding, role proof, and replay/idempotency results', () => {
    const verification = assessment(build()).verification_report_contract;
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(verification, expected.verificationReportRequiredFields);
    expect(verification).toEqual(expect.objectContaining(expected.verificationReportRequiredValues));
    expectRequiredFields(verification.freshness_result, expected.freshnessResultRequiredFields);
    expect(verification.freshness_result).toEqual(expect.objectContaining(expected.freshnessResultRequiredValues));
    expectRequiredFields(verification.profile_device_session_binding_result, expected.bindingResultRequiredFields);
    expect(verification.profile_device_session_binding_result).toEqual(expect.objectContaining(expected.bindingResultRequiredValues));
    expectRequiredFields(verification.role_proof_result, expected.roleProofResultRequiredFields);
    expect(verification.role_proof_result).toEqual(expect.objectContaining(expected.roleProofResultRequiredValues));
    expectRequiredFields(verification.replay_idempotency_result, expected.replayIdempotencyResultRequiredFields);
    expect(verification.replay_idempotency_result).toEqual(expect.objectContaining(expected.replayIdempotencyResultRequiredValues));
  });

  test('revocation, expiry, and no-secret/no-raw guarantees are explicit', () => {
    const currentAssessment = assessment(build());
    const expected = authBindingContract.expectedAuthBindingAssessmentShape;

    expectRequiredFields(currentAssessment.revocation_expiry_rules, expected.revocationExpiryRulesRequiredFields);
    expect(currentAssessment.revocation_expiry_rules).toEqual(expect.objectContaining(expected.revocationExpiryRulesRequiredValues));
    expectRequiredFields(currentAssessment.no_secret_no_raw_guarantees, expected.noSecretNoRawRequiredFields);
    expect(currentAssessment.no_secret_no_raw_guarantees).toEqual(expect.objectContaining(expected.noSecretNoRawRequiredValues));
    expect(currentAssessment.no_secret_no_raw_guarantees.raw_token_in_output).toBe(false);
    expect(currentAssessment.no_secret_no_raw_guarantees.session_secret_exported).toBe(false);
    expect(currentAssessment.no_secret_no_raw_guarantees.auth_secret_stored).toBe(false);
    expect(currentAssessment.no_secret_no_raw_guarantees.raw_profile_content_exported).toBe(false);
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      authBindingContract.expectedAuthBindingAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, authBindingContract.expectedAuthBindingAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_auth).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      authBindingContract.expectedAuthBindingAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, authBindingContract.expectedAuthBindingAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = authBindingContract.expectedAuthBindingAssessmentShape.sideEffectRequiredValues;
    const expectedReport = authBindingContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.authSecretsOrTokensCreated).toBe(0);
    expect(assessment(output).side_effect_result.sessionsCreated).toBe(0);
    expect(assessment(output).side_effect_result.deviceRegistryMutationsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.roleDiscoveryMutationsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreAuthBindingOutput(output, authBindingContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of authBindingContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(authBindingContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(authBindingContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects raw token, session material, credential, and profile leakage', () => {
    const valid = build();

    const rawToken = clone(valid);
    rawToken.auth_binding_assessment.token_envelope.token_id = 'access_token:abc123';
    expectValidatorFails(rawToken, 'forbidden-output-strings-absent');

    const secretValue = clone(valid);
    secretValue.auth_binding_assessment.no_secret_no_raw_guarantees.session_secret_exported = true;
    expectValidatorFails(secretValue, 'no-secret-no-raw-guarantees-required');

    const authSecretStored = clone(valid);
    authSecretStored.auth_binding_assessment.no_secret_no_raw_guarantees.auth_secret_stored = true;
    expectValidatorFails(authSecretStored, 'no-secret-no-raw-guarantees-required');

    const profileLeak = clone(valid);
    profileLeak.auth_binding_assessment.profile_mismatch_handling.safe_next_action = 'raw profile content visible';
    expectValidatorFails(profileLeak, 'forbidden-output-strings-absent');

    const credentialLeak = clone(valid);
    credentialLeak.auth_binding_assessment.token_envelope.nonce = 'cookie=abc123';
    expectValidatorFails(credentialLeak, 'forbidden-output-strings-absent');
  });

  test('validator rejects expired, revoked, unknown, stale, and replay-unsafe bindings', () => {
    const valid = build();

    const expiredSession = clone(valid);
    expiredSession.auth_binding_assessment.verification_report_contract.freshness_result.expired_session_rejected = false;
    expectValidatorFails(expiredSession, 'verification-report-shape-required');

    const unknownProfile = clone(valid);
    unknownProfile.auth_binding_assessment.verification_report_contract.profile_device_session_binding_result.unknown_profile_blocked = false;
    expectValidatorFails(unknownProfile, 'verification-report-shape-required');

    const unknownDevice = clone(valid);
    unknownDevice.auth_binding_assessment.revocation_expiry_rules.unknown_devices_blocked = false;
    expectValidatorFails(unknownDevice, 'revocation-expiry-rules-required');

    const revokedDevice = clone(valid);
    revokedDevice.auth_binding_assessment.revocation_expiry_rules.revoked_devices_blocked = false;
    expectValidatorFails(revokedDevice, 'revocation-expiry-rules-required');

    const replayAccepted = clone(valid);
    replayAccepted.auth_binding_assessment.verification_report_contract.replay_idempotency_result.nonce_reuse_rejected = false;
    expectValidatorFails(replayAccepted, 'verification-report-shape-required');
  });

  test('validator rejects stale role proof, missing target proof, Builder/Oracle target, and Tier 2+ authorization', () => {
    const valid = build();

    const staleRoleProofAccepted = clone(valid);
    staleRoleProofAccepted.auth_binding_assessment.verification_report_contract.role_proof_result.stale_role_discovery_blocked = false;
    expectValidatorFails(staleRoleProofAccepted, 'verification-report-shape-required');
    expectValidatorFails(staleRoleProofAccepted, 'architect-only-role-proof-required');

    const missingTargetProofAccepted = clone(valid);
    missingTargetProofAccepted.auth_binding_assessment.scope_rules.target_proof_required = false;
    expectValidatorFails(missingTargetProofAccepted, 'session-device-profile-scope-rules-required');
    expectValidatorFails(missingTargetProofAccepted, 'architect-only-role-proof-required');

    const builderTarget = clone(valid);
    builderTarget.auth_binding_assessment.authorization_boundary.builder_direct_target_authorized = true;
    expectValidatorFails(builderTarget, 'authorization-boundary-validation-only');

    const oracleTarget = clone(valid);
    oracleTarget.auth_binding_assessment.authorization_boundary.allowed_target_role = 'oracle';
    expectValidatorFails(oracleTarget, 'authorization-boundary-validation-only');

    const tierTwoAuthorized = clone(valid);
    tierTwoAuthorized.auth_binding_assessment.authorization_boundary.tier2_plus_authorized = true;
    expectValidatorFails(tierTwoAuthorized, 'authorization-boundary-validation-only');
  });

  test('validator rejects execution, shell/PTY, sends, deploys, trades, memory/profile commit, and proof overclaims', () => {
    const valid = build();

    const localExecution = clone(valid);
    localExecution.auth_binding_assessment.authorization_boundary.local_execution_authorized = true;
    expectValidatorFails(localExecution, 'authorization-boundary-validation-only');

    const shellOrPty = clone(valid);
    shellOrPty.auth_binding_assessment.authorization_boundary.shell_or_pty_authorized = true;
    expectValidatorFails(shellOrPty, 'authorization-boundary-validation-only');

    const customerSend = clone(valid);
    customerSend.auth_binding_assessment.authorization_boundary.customer_send_authorized = true;
    expectValidatorFails(customerSend, 'authorization-boundary-validation-only');

    const deploy = clone(valid);
    deploy.auth_binding_assessment.authorization_boundary.deploy_authorized = true;
    expectValidatorFails(deploy, 'authorization-boundary-validation-only');

    const trade = clone(valid);
    trade.auth_binding_assessment.authorization_boundary.trade_authorized = true;
    expectValidatorFails(trade, 'authorization-boundary-validation-only');

    const memoryCommit = clone(valid);
    memoryCommit.auth_binding_assessment.authorization_boundary.memory_profile_commit_authorized = true;
    expectValidatorFails(memoryCommit, 'authorization-boundary-validation-only');

    const modelProof = clone(valid);
    modelProof.auth_binding_assessment.authorization_boundary.model_processing_proven = true;
    expectValidatorFails(modelProof, 'authorization-boundary-validation-only');

    const bridgeProof = clone(valid);
    bridgeProof.auth_binding_assessment.verification_report_contract.bridge_green_proven = true;
    expectValidatorFails(bridgeProof, 'verification-report-shape-required');
  });

  test('validator rejects baseline drift, missing gates, missing blockers, side-effect lies, and output-file claims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.auth_binding_assessment.baseline_commit = 'f41b02a';
    expectValidatorFails(baselineDrift, 'phase-16-baseline-3904697-pinned');

    const missingGate = clone(valid);
    missingGate.auth_binding_assessment.acceptance_gate_summary = missingGate.auth_binding_assessment.acceptance_gate_summary.slice(1);
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.auth_binding_assessment.blocker_summary = missingBlocker.auth_binding_assessment.blocker_summary.slice(1);
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const sideEffectLie = clone(valid);
    sideEffectLie.auth_binding_assessment.side_effect_result.no_network_performed = false;
    sideEffectLie.auth_binding_assessment.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(sideEffectLie, 'validation-only-no-real-auth');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_memory_profile_commit_performed = false;
    reportSideEffectLie.validation_report.side_effect_result.memoryProfileCommitsAttempted = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');

    const outputFileClaim = clone(valid);
    outputFileClaim.auth_binding_assessment.side_effect_result.outputFileWritten = true;
    expectValidatorFails(outputFileClaim, 'validation-only-no-real-auth');
  });

  test('CLI prints stdout JSON only, consumes fixture directly, and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'auth-binding.json'])).toEqual({
      fixturePath: expect.stringContaining('mira-core-auth-binding-contract.json'),
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=auth-binding.json'], JSON.stringify({ profile: 'main' }));

    expect(assessment(output).schema).toBe(AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(report(output).decision).toBe('accepted');
    expect(assessment(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(assessment(output).auth_binding.role).toBe('architect');
    expect(assessment(output).token_envelope.raw_token_available).toBe(false);
    expect(assessment(output).authorization_boundary.allowed_target_role).toBe('architect');
    expect(assessment(output).authorization_boundary.local_execution_authorized).toBe(false);
    expect(assessment(output).authorization_boundary.model_processing_proven).toBe(false);
    expect(assessment(output).side_effect_result.no_network_performed).toBe(true);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.auth_binding_assessment.schema).toBe(AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
  });
});
