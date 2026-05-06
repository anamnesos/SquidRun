const encryptionKeyContract = require('./fixtures/mira-core-encryption-key-contract.json');
const {
  AAD_FIELDS,
  ALGORITHM_ALLOWLIST,
  BASELINE_COMMIT,
  ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreEncryptionKey,
  validateMiraCoreEncryptionKeyOutput,
} = require('../modules/mira-core/encryption-key');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-encryption-key');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreEncryptionKey({
    contract: encryptionKeyContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.encryption_key_assessment;
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
  expect(() => assertNoForbiddenOutput(output, encryptionKeyContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreEncryptionKeyOutput(output, encryptionKeyContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core encryption key assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, encryptionKeyContract.expectedOutputShape.requiredTopLevelFields);
    expect(encryptionKeyContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, encryptionKeyContract.expectedEncryptionKeyAssessmentShape.requiredFields);
    expect(encryptionKeyContract.expectedEncryptionKeyAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, encryptionKeyContract.expectedValidationReportShape.requiredFields);
    expect(encryptionKeyContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreEncryptionKeyOutput(output, encryptionKeyContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 18 baseline and dependency without claiming real DB or KMS', () => {
    const currentAssessment = assessment(build());
    const dependency = currentAssessment.baseline_dependency;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(encryptionKeyContract.baseline.commit);
    expectRequiredFields(dependency, expected.baselineDependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.baselineDependencyRequiredValues));
    expect(dependency.baseline_ref).toBe(`commit:${BASELINE_COMMIT}`);
    expect(dependency.phase_18_persistence_audit_ref).toBe('mira-core-persistence-audit-contract:phase_18_green');
    expect(dependency.real_db_dependency_exists).toBe(false);
    expect(dependency.real_kms_dependency_exists).toBe(false);
  });

  test('key reference policy is scoped, reference-only, and secret-free', () => {
    const policy = assessment(build()).key_reference_policy;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(policy, expected.keyReferencePolicyRequiredFields);
    expect(policy).toEqual(expect.objectContaining(expected.keyReferencePolicyRequiredValues));
    expect(policy.algorithm_allowlist).toEqual(ALGORITHM_ALLOWLIST);
    expect(policy.tenant_id).toBe('tenant:james-main-validation');
    expect(policy.profile).toBe('main');
    expect(policy.device_id).toBe('VIGIL');
    expect(policy.session_id).toBe('app-session-326');
    expect(policy.key_id).toBe('key-ref-validation-001');
    expect(policy.provider_ref).toBe('kms-ref-validation-no-secret');
    expect(policy.audit_refs.length).toBeGreaterThan(0);
    expect(policy.provenance_refs).toContain('commit:3742ab7');
    expect(policy.secret_material_exported).toBe(false);
    expect(policy.no_secret_material).toBe(true);
  });

  test('encryption plan is envelope metadata only with placeholders and AAD scope', () => {
    const plan = assessment(build()).encryption_plan;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(plan, expected.encryptionPlanRequiredFields);
    expect(plan).toEqual(expect.objectContaining(expected.encryptionPlanRequiredValues));
    expect(plan.aad_fields).toEqual(AAD_FIELDS);
    expect(plan.payload_hash).toMatch(/^sha256:/);
    expect(plan.schema_table_item_scope).toEqual(expect.objectContaining({
      schema: 'squidrun.mira_core.server_persistence_schema.v0',
      table: 'sync_items',
      profile: 'main',
      device_id: 'VIGIL',
      session_id: 'app-session-326',
    }));
    expect(plan.ciphertext_placeholder).toBe('ciphertext-placeholder-reference-only');
    expect(plan.test_vector_placeholder).toBe('test-vector-placeholder-reference-only');
    expect(plan.plaintext_exported).toBe(false);
    expect(plan.data_key_exported).toBe(false);
    expect(plan.real_ciphertext_exported).toBe(false);
    expect(plan.encryption_performed_now).toBe(false);
    expect(plan.decryption_performed_now).toBe(false);
  });

  test('secret handling blocks private/data key, token, env, and decrypted-content exposure', () => {
    const boundary = assessment(build()).secret_handling_boundary;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(boundary, expected.secretHandlingBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.secretHandlingBoundaryRequiredValues));
    expect(boundary.private_key_material_allowed).toBe(false);
    expect(boundary.data_key_material_allowed).toBe(false);
    expect(boundary.tokens_cookies_session_secrets_allowed).toBe(false);
    expect(boundary.env_secret_read_allowed).toBe(false);
    expect(boundary.model_visible_decrypted_raw_content).toBe(false);
    expect(boundary.plaintext_payload_visible).toBe(false);
    expect(boundary.secret_scanner_required).toBe(true);
  });

  test('rotation, revocation, and rewrap rules are dry-run and fail closed', () => {
    const rules = assessment(build()).rotation_revocation_rewrap_rules;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(rules, expected.rotationRevocationRewrapRulesRequiredFields);
    expect(rules).toEqual(expect.objectContaining(expected.rotationRevocationRewrapRulesRequiredValues));
    expect(rules.dry_run_only).toBe(true);
    expect(rules.rotation_planned_only).toBe(true);
    expect(rules.revoked_key_refs_fail_closed).toBe(true);
    expect(rules.expired_key_refs_fail_closed).toBe(true);
    expect(rules.mismatched_key_refs_fail_closed).toBe(true);
    expect(rules.stale_key_refs_fail_closed).toBe(true);
    expect(rules.unknown_provider_refs_fail_closed).toBe(true);
    expect(rules.rewrap_requires_audit_refs).toBe(true);
    expect(rules.no_kms_network_performed).toBe(true);
  });

  test('delete/export/backup/restore rules are redacted, reference-only, and tombstone-first', () => {
    const rules = assessment(build()).delete_export_backup_restore_rules;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(rules, expected.deleteExportBackupRestoreRulesRequiredFields);
    expect(rules).toEqual(expect.objectContaining(expected.deleteExportBackupRestoreRulesRequiredValues));
    expect(rules.deletion_policy_precedence_required).toBe(true);
    expect(rules.tombstone_beats_key_rewrap).toBe(true);
    expect(rules.tombstone_beats_restore).toBe(true);
    expect(rules.export_manifest_redacted_only).toBe(true);
    expect(rules.backup_manifest_redacted_only).toBe(true);
    expect(rules.encrypted_reference_only).toBe(true);
    expect(rules.raw_ciphertext_exported).toBe(false);
    expect(rules.raw_plaintext_exported).toBe(false);
    expect(rules.raw_payload_exported).toBe(false);
    expect(rules.restore_decrypts_now).toBe(false);
  });

  test('capability boundary prevents encryption/key-reference overclaims', () => {
    const boundary = assessment(build()).capability_boundary;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(boundary, expected.capabilityBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.capabilityBoundaryRequiredValues));
    expect(boundary.encryption_validity_permits).toBe('future_key_reference_envelope_metadata_validation_only');
    expect(boundary.allowed_target_role).toBe('architect');
    expect(boundary.local_acceptance_required).toBe(true);
    expect(boundary.local_execution_authorized).toBe(false);
    expect(boundary.db_write_authorized).toBe(false);
    expect(boundary.storage_write_authorized).toBe(false);
    expect(boundary.builder_direct_target_authorized).toBe(false);
    expect(boundary.oracle_direct_target_authorized).toBe(false);
    expect(boundary.tier2_plus_authorized).toBe(false);
    expect(boundary.customer_send_authorized).toBe(false);
    expect(boundary.deploy_authorized).toBe(false);
    expect(boundary.trade_authorized).toBe(false);
    expect(boundary.memory_profile_commit_authorized).toBe(false);
    expect(boundary.model_processing_proven).toBe(false);
    expect(boundary.bridge_green_proven).toBe(false);
    expect(boundary.raw_restore_authorized).toBe(false);
  });

  test('real KMS/encryption gates remain blocked until future controls exist', () => {
    const gates = assessment(build()).migration_gates;
    const expected = encryptionKeyContract.expectedEncryptionKeyAssessmentShape;

    expectRequiredFields(gates, expected.migrationGatesRequiredFields);
    expect(gates).toEqual(expect.objectContaining(expected.migrationGatesRequiredValues));
    expect(gates.real_kms_allowed_now).toBe(false);
    expect(gates.real_encryption_allowed_now).toBe(false);
    expect(gates.future_real_kms_allowed_after_gates).toBe(true);
    expect(gates.requires_kms_choice_gate).toBe(true);
    expect(gates.requires_key_custody_gate).toBe(true);
    expect(gates.requires_rotation_runbook_gate).toBe(true);
    expect(gates.requires_red_team_leakage_tests_gate).toBe(true);
    expect(gates.requires_secret_storage_policy_gate).toBe(true);
    expect(gates.feature_flag_default).toBe('off');
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      encryptionKeyContract.expectedEncryptionKeyAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, encryptionKeyContract.expectedEncryptionKeyAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_kms).toBe(true);
      expect(gate.required_before_real_encryption).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      encryptionKeyContract.expectedEncryptionKeyAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, encryptionKeyContract.expectedEncryptionKeyAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = encryptionKeyContract.expectedEncryptionKeyAssessmentShape.sideEffectRequiredValues;
    const expectedReport = encryptionKeyContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.kmsCallsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseOrStoreWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.envSecretReadsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.keyGenerationsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.encryptionsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.decryptionsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreEncryptionKeyOutput(output, encryptionKeyContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of encryptionKeyContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(encryptionKeyContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(encryptionKeyContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects baseline/dependency drift and real DB/KMS overclaims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.encryption_key_assessment.baseline_commit = 'badc0de';
    expectValidatorFails(baselineDrift, 'phase-19-baseline-3742ab7-pinned');

    const missingDependency = clone(valid);
    missingDependency.encryption_key_assessment.baseline_dependency.phase_18_persistence_audit_ref = null;
    expectValidatorFails(missingDependency, 'phase-18-dependency-required');

    const realDbDependency = clone(valid);
    realDbDependency.encryption_key_assessment.baseline_dependency.real_db_dependency_exists = true;
    expectValidatorFails(realDbDependency, 'phase-18-dependency-required');

    const realKmsDependency = clone(valid);
    realKmsDependency.encryption_key_assessment.baseline_dependency.real_kms_dependency_exists = true;
    expectValidatorFails(realKmsDependency, 'phase-18-dependency-required');
  });

  test('validator rejects unsupported algorithms, missing scope, and secret-bearing key refs', () => {
    const valid = build();

    const unsupportedAlgorithm = clone(valid);
    unsupportedAlgorithm.encryption_key_assessment.key_reference_policy.algorithm_allowlist.push('rsa-sha1-production');
    expectValidatorFails(unsupportedAlgorithm, 'key-reference-policy-shape-required');
    expectValidatorFails(unsupportedAlgorithm, 'algorithm-allowlist-reference-only');

    const missingScope = clone(valid);
    missingScope.encryption_key_assessment.key_reference_policy.profile = 'side-profile';
    expectValidatorFails(missingScope, 'key-reference-policy-shape-required');

    const missingAudit = clone(valid);
    missingAudit.encryption_key_assessment.key_reference_policy.audit_refs = [];
    expectValidatorFails(missingAudit, 'key-reference-policy-shape-required');

    const secretMaterial = clone(valid);
    secretMaterial.encryption_key_assessment.key_reference_policy.secret_material_exported = true;
    expectValidatorFails(secretMaterial, 'key-reference-policy-shape-required');
  });

  test('validator rejects plaintext, ciphertext, payload, encrypt/decrypt, and AAD scope drift', () => {
    const valid = build();

    const plaintextExport = clone(valid);
    plaintextExport.encryption_key_assessment.encryption_plan.plaintext_exported = true;
    expectValidatorFails(plaintextExport, 'encryption-plan-envelope-metadata-only');

    const dataKeyExport = clone(valid);
    dataKeyExport.encryption_key_assessment.encryption_plan.data_key_exported = true;
    expectValidatorFails(dataKeyExport, 'encryption-plan-envelope-metadata-only');

    const rawPayload = clone(valid);
    rawPayload.encryption_key_assessment.encryption_plan.raw_payload_exported = true;
    expectValidatorFails(rawPayload, 'encryption-plan-envelope-metadata-only');

    const realCiphertext = clone(valid);
    realCiphertext.encryption_key_assessment.encryption_plan.real_ciphertext_exported = true;
    expectValidatorFails(realCiphertext, 'encryption-plan-envelope-metadata-only');

    const encryptNow = clone(valid);
    encryptNow.encryption_key_assessment.encryption_plan.encryption_performed_now = true;
    expectValidatorFails(encryptNow, 'encryption-plan-envelope-metadata-only');

    const decryptNow = clone(valid);
    decryptNow.encryption_key_assessment.encryption_plan.decryption_performed_now = true;
    expectValidatorFails(decryptNow, 'encryption-plan-envelope-metadata-only');

    const aadDrift = clone(valid);
    aadDrift.encryption_key_assessment.encryption_plan.aad_fields = aadDrift.encryption_key_assessment.encryption_plan.aad_fields.filter((field) => field !== 'tenant_id');
    expectValidatorFails(aadDrift, 'encryption-plan-envelope-metadata-only');
  });

  test('validator rejects secret-boundary leakage and KMS/env/action side-effect lies', () => {
    const secretBoundaryFields = [
      'private_key_material_allowed',
      'data_key_material_allowed',
      'tokens_cookies_session_secrets_allowed',
      'env_secret_read_allowed',
      'env_secret_exported',
      'model_visible_decrypted_raw_content',
      'plaintext_payload_visible',
      'decrypted_raw_content_exported',
      'key_generation_allowed_now',
      'encryption_decryption_allowed_now',
    ];

    for (const field of secretBoundaryFields) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.secret_handling_boundary[field] = true;
      expectValidatorFails(tampered, 'secret-handling-boundary-no-material');
    }

    const sideEffectFields = [
      ['no_network_performed', 'networkRequestsAttempted'],
      ['no_kms_call_performed', 'kmsCallsAttempted'],
      ['no_env_secret_read_performed', 'envSecretReadsAttempted'],
      ['no_key_generation_performed', 'keyGenerationsAttempted'],
      ['no_encryption_performed', 'encryptionsAttempted'],
      ['no_decryption_performed', 'decryptionsAttempted'],
      ['no_secret_material_exported', 'secretMaterialExportsAttempted'],
      ['no_output_file_written', 'fileWritesAttempted'],
    ];
    for (const [booleanField, counterField] of sideEffectFields) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.side_effect_result[booleanField] = false;
      tampered.encryption_key_assessment.side_effect_result[counterField] = 1;
      expectValidatorFails(tampered, 'validation-only-no-real-kms-encryption');
      expectValidatorFails(tampered, 'side-effect-truth-all-zero');
    }
  });

  test('validator rejects revoked, expired, stale, mismatched, unknown-provider, and no-audit rewrap gaps', () => {
    const rulesToFlip = [
      'revoked_key_refs_fail_closed',
      'expired_key_refs_fail_closed',
      'mismatched_key_refs_fail_closed',
      'stale_key_refs_fail_closed',
      'unknown_provider_refs_fail_closed',
      'rotation_metadata_required',
      'revocation_metadata_required',
      'rewrap_requires_audit_refs',
      'no_kms_network_performed',
    ];

    for (const field of rulesToFlip) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.rotation_revocation_rewrap_rules[field] = false;
      expectValidatorFails(tampered, 'rotation-revocation-rewrap-fail-closed');
    }
  });

  test('validator rejects raw export/backup/restore and tombstone precedence regressions', () => {
    const fieldsToFlip = [
      'deletion_policy_precedence_required',
      'tombstone_beats_key_rewrap',
      'tombstone_beats_restore',
      'export_manifest_redacted_only',
      'backup_manifest_redacted_only',
      'encrypted_reference_only',
      'backup_restore_planned_only',
    ];
    for (const field of fieldsToFlip) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.delete_export_backup_restore_rules[field] = false;
      expectValidatorFails(tampered, 'delete-export-backup-restore-redacted-only');
      if (field === 'deletion_policy_precedence_required' || field === 'tombstone_beats_key_rewrap' || field === 'tombstone_beats_restore') {
        expectValidatorFails(tampered, 'tombstone-deletion-precedence-required');
      }
    }

    const exportFields = ['raw_ciphertext_exported', 'raw_plaintext_exported', 'raw_payload_exported', 'restore_decrypts_now'];
    for (const field of exportFields) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.delete_export_backup_restore_rules[field] = true;
      expectValidatorFails(tampered, 'delete-export-backup-restore-redacted-only');
    }
  });

  test('validator rejects capability overclaims from encryption validity', () => {
    const overclaims = [
      ['local_execution_authorized', true],
      ['db_write_authorized', true],
      ['storage_write_authorized', true],
      ['builder_direct_target_authorized', true],
      ['oracle_direct_target_authorized', true],
      ['tier2_plus_authorized', true],
      ['customer_send_authorized', true],
      ['deploy_authorized', true],
      ['trade_authorized', true],
      ['memory_profile_commit_authorized', true],
      ['model_processing_proven', true],
      ['bridge_green_proven', true],
      ['raw_restore_authorized', true],
      ['server_resurrection_of_deleted_state_authorized', true],
    ];

    for (const [field, value] of overclaims) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.capability_boundary[field] = value;
      expectValidatorFails(tampered, 'capability-boundary-validation-only');
    }

    const wrongTarget = clone(build());
    wrongTarget.encryption_key_assessment.capability_boundary.allowed_target_role = 'oracle';
    expectValidatorFails(wrongTarget, 'capability-boundary-validation-only');
  });

  test('validator rejects real-KMS gate drift, missing gates/blockers, missing output shape, and validation side-effect lies', () => {
    const valid = build();

    const realKmsAllowed = clone(valid);
    realKmsAllowed.encryption_key_assessment.migration_gates.real_kms_allowed_now = true;
    expectValidatorFails(realKmsAllowed, 'migration-real-kms-gated');

    const realEncryptionAllowed = clone(valid);
    realEncryptionAllowed.encryption_key_assessment.migration_gates.real_encryption_allowed_now = true;
    expectValidatorFails(realEncryptionAllowed, 'migration-real-kms-gated');

    const missingGate = clone(valid);
    missingGate.encryption_key_assessment.acceptance_gate_summary.pop();
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.encryption_key_assessment.blocker_summary.pop();
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const outputMissing = clone(valid);
    delete outputMissing.validation_report;
    expectValidatorFails(outputMissing, 'output-shape-complete');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_kms_call_performed = false;
    reportSideEffectLie.validation_report.side_effect_result.kmsCallsAttempted = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');
  });

  test('validator rejects forbidden secret/key/plaintext/ciphertext/proof/live side-effect substrings in values', () => {
    const forbiddenValues = [
      'OPENAI_API_KEY',
      'BEGIN PRIVATE KEY',
      'DATA KEY',
      'access_token',
      'session_secret',
      'cookie=abc',
      '.env secret',
      'KMS decrypted plaintext',
      'model visible decrypted content',
      'raw plaintext payload',
      'raw ciphertext payload',
      'customer private note',
      'raw comms body',
      'database write complete',
      'kms call complete',
      'network request complete',
      'key generated',
      'encryption performed',
      'decryption performed',
      'output file written',
      'server executed local work',
      'encryption authorizes local execution',
      'encryption proves model processing',
      'socket alone proves bridge green',
      'builder direct target authorized',
      'oracle direct target authorized',
      'tier2 authorized by encryption',
      'memory commit authorized by encryption',
    ];

    for (const forbidden of forbiddenValues) {
      const tampered = clone(build());
      tampered.encryption_key_assessment.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'forbidden-substrings-absent');
    }
  });

  test('idempotency is stable for equivalent inputs and sensitive to scope changes', () => {
    const first = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = assessment(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedTenant = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL', tenantId: 'tenant:other' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.assessment_id).toBe(second.assessment_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedTenant.idempotency_key);

    const tampered = clone(build());
    tampered.encryption_key_assessment.key_reference_policy.provider_ref_secret_free = false;
    expectValidatorFails(tampered, 'idempotency-stable');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-encryption-key-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
      tenantId: 'tenant:james-main-validation',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(assessment(output).schema).toBe(ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION);
    expect(assessment(output).sessionId).toBe('session-cli');
    expect(assessment(output).side_effect_result.no_kms_call_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_key_generation_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_encryption_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_decryption_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_output_file_written).toBe(true);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreEncryptionKeyOutput(output, encryptionKeyContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
