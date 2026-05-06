const storageRetentionContract = require('./fixtures/mira-core-storage-retention-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreStorageRetention,
  validateMiraCoreStorageRetentionOutput,
} = require('../modules/mira-core/storage-retention');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-storage-retention');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreStorageRetention({
    contract: storageRetentionContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.storage_retention_assessment;
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
  expect(() => assertNoForbiddenOutput(output, storageRetentionContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreStorageRetentionOutput(output, storageRetentionContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core storage retention assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, storageRetentionContract.expectedOutputShape.requiredTopLevelFields);
    expect(storageRetentionContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, storageRetentionContract.expectedStorageRetentionAssessmentShape.requiredFields);
    expect(storageRetentionContract.expectedStorageRetentionAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, storageRetentionContract.expectedValidationReportShape.requiredFields);
    expect(storageRetentionContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreStorageRetentionOutput(output, storageRetentionContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 16 baseline and keeps real storage gated', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(storageRetentionContract.baseline.commit);
    expect(currentAssessment.storage_assessment_plan).toEqual(expect.objectContaining({
      baseline_ref: `commit:${BASELINE_COMMIT}`,
      decision: 'validation_only_future_storage_plan',
      status: 'future_storage_blocked_until_gates',
      write_performed_now: false,
    }));
    expect(currentAssessment.migration_gates).toEqual(expect.objectContaining({
      baseline_commit: BASELINE_COMMIT,
      phase_14_gap_blocker_id: 'redacted-receive-store-policy-specified',
      real_storage_allowed_now: false,
      future_real_storage_allowed_after_gates: true,
      feature_flag_default: 'off',
    }));
  });

  test('storage assessment plan includes scoped receive/upload refs and item counts', () => {
    const plan = assessment(build()).storage_assessment_plan;
    const expected = storageRetentionContract.expectedStorageRetentionAssessmentShape;

    expectRequiredFields(plan, expected.storageAssessmentPlanRequiredFields);
    expect(plan).toEqual(expect.objectContaining(expected.storageAssessmentPlanRequiredValues));
    expect(plan.authenticated_receive_ref).toBe('auth-binding-validation:validation-only');
    expect(plan.upload_envelope_ref).toBe('server-upload-envelope:validation-only');
    expect(plan.profile).toBe('main');
    expect(plan.device_id).toBe('VIGIL');
    expect(plan.item_count).toBe(6);
    expect(plan.accepted_count).toBe(2);
    expect(plan.withheld_count).toBe(4);
    expect(plan.tombstoned_count).toBe(1);
  });

  test('allowed storage classes exclude raw, private, secret, profile-mismatch, and side-profile content', () => {
    const classes = assessment(build()).allowed_storage_classes;
    const expected = storageRetentionContract.expectedStorageRetentionAssessmentShape;

    expectRequiredFields(classes, expected.allowedStorageClassesRequiredFields);
    expect(classes).toEqual(expect.objectContaining(expected.allowedStorageClassesRequiredValues));
    expect(classes.allowed).toEqual(expected.allowedStorageClassesRequiredValues.allowed);
    expect(classes.blocked_raw_classes).toEqual(expected.allowedStorageClassesRequiredValues.blocked_raw_classes);
    expect(classes.raw_content_storage_allowed).toBe(false);
    expect(classes.secret_storage_allowed).toBe(false);
    expect(classes.side_profile_storage_allowed).toBe(false);
  });

  test('future-store eligibility is limited to safe or already redacted items', () => {
    const eligibility = assessment(build()).item_storage_eligibility;
    const expected = storageRetentionContract.expectedStorageRetentionAssessmentShape;

    expectRequiredFields(eligibility, expected.itemStorageEligibilityRequiredFields);
    expect(eligibility).toEqual(expect.objectContaining(expected.itemStorageEligibilityRequiredValues));
    expect(eligibility.eligible_syncEligibility).toEqual(['core_sync_safe', 'core_sync_redacted']);
    expect(eligibility.eligible_redactionStatus).toEqual(['none', 'applied']);
    expect(eligibility.blocked_syncEligibility).toEqual(['blocked', 'local_only', 'approval_required']);
    expect(eligibility.withheld_reason_codes).toEqual(expect.arrayContaining([
      'profile_mismatch',
      'unredacted_core_sync_redacted',
      'stale_snapshot',
      'watermark_regression',
      'replay_detected',
    ]));
    expect(eligibility.future_store_mark_only).toBe(true);
  });

  test('retention, deletion, export, and restore/replay rules are contract-only', () => {
    const currentAssessment = assessment(build());
    const expected = storageRetentionContract.expectedStorageRetentionAssessmentShape;

    expectRequiredFields(currentAssessment.retention_rules, expected.retentionRulesRequiredFields);
    expect(currentAssessment.retention_rules).toEqual(expect.objectContaining(expected.retentionRulesRequiredValues));
    expectRequiredFields(currentAssessment.deletion_rules, expected.deletionRulesRequiredFields);
    expect(currentAssessment.deletion_rules).toEqual(expect.objectContaining(expected.deletionRulesRequiredValues));
    expectRequiredFields(currentAssessment.export_rules, expected.exportRulesRequiredFields);
    expect(currentAssessment.export_rules).toEqual(expect.objectContaining(expected.exportRulesRequiredValues));
    expectRequiredFields(currentAssessment.restore_replay_rules, expected.restoreReplayRulesRequiredFields);
    expect(currentAssessment.restore_replay_rules).toEqual(expect.objectContaining(expected.restoreReplayRulesRequiredValues));
    expect(currentAssessment.deletion_rules.delete_request_shape.schema).toBe('squidrun.mira_core.storage_delete_request.v0');
    expect(currentAssessment.export_rules.export_manifest_shape.schema).toBe('squidrun.mira_core.storage_export_manifest.v0');
    expect(currentAssessment.restore_replay_rules.tombstone_beats_stale_upload).toBe(true);
  });

  test('capability boundary preserves validation-only storage/auth truth', () => {
    const boundary = assessment(build()).capability_boundary;
    const expected = storageRetentionContract.expectedStorageRetentionAssessmentShape;

    expectRequiredFields(boundary, expected.capabilityBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.capabilityBoundaryRequiredValues));
    expect(boundary.valid_storage_auth_permits).toBe('future_storage_plan_validation_only');
    expect(boundary.allowed_target_role).toBe('architect');
    expect(boundary.local_acceptance_required).toBe(true);
    expect(boundary.local_execution_authorized).toBe(false);
    expect(boundary.builder_direct_target_authorized).toBe(false);
    expect(boundary.model_processing_proven).toBe(false);
    expect(boundary.bridge_green_proven).toBe(false);
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      storageRetentionContract.expectedStorageRetentionAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, storageRetentionContract.expectedStorageRetentionAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_storage).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      storageRetentionContract.expectedStorageRetentionAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, storageRetentionContract.expectedStorageRetentionAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = storageRetentionContract.expectedStorageRetentionAssessmentShape.sideEffectRequiredValues;
    const expectedReport = storageRetentionContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.databaseWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.fileWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.exportFilesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.deletesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.restoresAttempted).toBe(0);
    expect(assessment(output).side_effect_result.rawContentStorageAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreStorageRetentionOutput(output, storageRetentionContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of storageRetentionContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(storageRetentionContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(storageRetentionContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects raw/private/secret/profile-mismatch storage and forbidden raw values', () => {
    const valid = build();

    const rawAllowed = clone(valid);
    rawAllowed.storage_retention_assessment.allowed_storage_classes.raw_content_storage_allowed = true;
    expectValidatorFails(rawAllowed, 'allowed-storage-classes-required');
    expectValidatorFails(rawAllowed, 'raw-private-storage-blocked');

    const secretAllowed = clone(valid);
    secretAllowed.storage_retention_assessment.allowed_storage_classes.secret_storage_allowed = true;
    expectValidatorFails(secretAllowed, 'allowed-storage-classes-required');

    const customerPrivateAllowed = clone(valid);
    customerPrivateAllowed.storage_retention_assessment.allowed_storage_classes.customer_private_storage_allowed = true;
    expectValidatorFails(customerPrivateAllowed, 'allowed-storage-classes-required');

    const profileMismatchAllowed = clone(valid);
    profileMismatchAllowed.storage_retention_assessment.allowed_storage_classes.profile_mismatch_storage_allowed = true;
    expectValidatorFails(profileMismatchAllowed, 'allowed-storage-classes-required');

    const forbiddenRaw = clone(valid);
    forbiddenRaw.storage_retention_assessment.allowed_storage_classes.blocked_raw_classes.push('raw comms body');
    expectValidatorFails(forbiddenRaw, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe item eligibility, missing scope, stale snapshots, and replay gaps', () => {
    const valid = build();

    const blockedEligible = clone(valid);
    blockedEligible.storage_retention_assessment.item_storage_eligibility.eligible_syncEligibility.push('blocked');
    expectValidatorFails(blockedEligible, 'item-storage-eligibility-required');

    const localOnlyEligible = clone(valid);
    localOnlyEligible.storage_retention_assessment.item_storage_eligibility.eligible_syncEligibility.push('local_only');
    expectValidatorFails(localOnlyEligible, 'item-storage-eligibility-required');

    const approvalRequiredEligible = clone(valid);
    approvalRequiredEligible.storage_retention_assessment.item_storage_eligibility.eligible_syncEligibility.push('approval_required');
    expectValidatorFails(approvalRequiredEligible, 'item-storage-eligibility-required');

    const missingScopeAccepted = clone(valid);
    missingScopeAccepted.storage_retention_assessment.item_storage_eligibility.requires_profile_session_device_scope = false;
    expectValidatorFails(missingScopeAccepted, 'item-storage-eligibility-required');

    const staleSnapshotAccepted = clone(valid);
    staleSnapshotAccepted.storage_retention_assessment.retention_rules.stale_snapshot_handling = 'accept_write';
    expectValidatorFails(staleSnapshotAccepted, 'retention-rules-required');

    const replayGap = clone(valid);
    replayGap.storage_retention_assessment.retention_rules.replay_binding_required = false;
    expectValidatorFails(replayGap, 'retention-rules-required');
  });

  test('validator rejects export/delete/restore side effects and tombstone/raw restore failures', () => {
    const valid = build();

    const exportFile = clone(valid);
    exportFile.storage_retention_assessment.export_rules.export_file_written_now = true;
    expectValidatorFails(exportFile, 'export-rules-required');

    const rawExport = clone(valid);
    rawExport.storage_retention_assessment.export_rules.raw_secret_private_content_exported = true;
    expectValidatorFails(rawExport, 'export-rules-required');

    const deletePerformed = clone(valid);
    deletePerformed.storage_retention_assessment.deletion_rules.deletion_performed_now = true;
    expectValidatorFails(deletePerformed, 'deletion-rules-required');

    const restorePerformed = clone(valid);
    restorePerformed.storage_retention_assessment.restore_replay_rules.restore_performed_now = true;
    expectValidatorFails(restorePerformed, 'restore-replay-rules-required');

    const rawRestore = clone(valid);
    rawRestore.storage_retention_assessment.restore_replay_rules.raw_restore_from_server_allowed = true;
    expectValidatorFails(rawRestore, 'restore-replay-rules-required');

    const tombstoneLoses = clone(valid);
    tombstoneLoses.storage_retention_assessment.restore_replay_rules.tombstone_beats_stale_upload = false;
    expectValidatorFails(tombstoneLoses, 'restore-replay-rules-required');

    const resurrectsDeleted = clone(valid);
    resurrectsDeleted.storage_retention_assessment.restore_replay_rules.server_can_resurrect_deleted_local_memory_profile_state = true;
    expectValidatorFails(resurrectsDeleted, 'restore-replay-rules-required');
  });

  test('validator rejects local execution, shell/PTY, sends, deploys, trades, memory commits, targets, and proof overclaims', () => {
    const valid = build();

    const localExecution = clone(valid);
    localExecution.storage_retention_assessment.capability_boundary.local_execution_authorized = true;
    expectValidatorFails(localExecution, 'capability-boundary-validation-only');

    const shellOrPty = clone(valid);
    shellOrPty.storage_retention_assessment.capability_boundary.shell_or_pty_authorized = true;
    expectValidatorFails(shellOrPty, 'capability-boundary-validation-only');

    const builderTarget = clone(valid);
    builderTarget.storage_retention_assessment.capability_boundary.builder_direct_target_authorized = true;
    expectValidatorFails(builderTarget, 'capability-boundary-validation-only');

    const oracleTarget = clone(valid);
    oracleTarget.storage_retention_assessment.capability_boundary.allowed_target_role = 'oracle';
    expectValidatorFails(oracleTarget, 'capability-boundary-validation-only');

    const customerSend = clone(valid);
    customerSend.storage_retention_assessment.capability_boundary.customer_send_authorized = true;
    expectValidatorFails(customerSend, 'capability-boundary-validation-only');

    const deploy = clone(valid);
    deploy.storage_retention_assessment.capability_boundary.deploy_authorized = true;
    expectValidatorFails(deploy, 'capability-boundary-validation-only');

    const trade = clone(valid);
    trade.storage_retention_assessment.capability_boundary.trade_authorized = true;
    expectValidatorFails(trade, 'capability-boundary-validation-only');

    const memoryCommit = clone(valid);
    memoryCommit.storage_retention_assessment.capability_boundary.memory_profile_commit_authorized = true;
    expectValidatorFails(memoryCommit, 'capability-boundary-validation-only');

    const modelProof = clone(valid);
    modelProof.storage_retention_assessment.capability_boundary.model_processing_proven = true;
    expectValidatorFails(modelProof, 'capability-boundary-validation-only');

    const bridgeProof = clone(valid);
    bridgeProof.storage_retention_assessment.capability_boundary.bridge_green_proven = true;
    expectValidatorFails(bridgeProof, 'capability-boundary-validation-only');
  });

  test('validator rejects baseline drift, missing gates, missing blockers, side-effect lies, and output-file claims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.storage_retention_assessment.baseline_commit = '3904697';
    expectValidatorFails(baselineDrift, 'phase-17-baseline-6f97287-pinned');

    const missingGate = clone(valid);
    missingGate.storage_retention_assessment.acceptance_gate_summary = missingGate.storage_retention_assessment.acceptance_gate_summary.slice(1);
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.storage_retention_assessment.blocker_summary = missingBlocker.storage_retention_assessment.blocker_summary.slice(1);
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const databaseWrite = clone(valid);
    databaseWrite.storage_retention_assessment.side_effect_result.no_database_write_performed = false;
    databaseWrite.storage_retention_assessment.side_effect_result.databaseWritesAttempted = 1;
    expectValidatorFails(databaseWrite, 'validation-only-no-real-storage');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_export_file_written = false;
    reportSideEffectLie.validation_report.side_effect_result.exportFilesAttempted = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');

    const outputFileClaim = clone(valid);
    outputFileClaim.storage_retention_assessment.side_effect_result.outputFileWritten = true;
    expectValidatorFails(outputFileClaim, 'validation-only-no-real-storage');
  });

  test('CLI prints stdout JSON only, consumes fixture directly, and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'storage-retention.json'])).toEqual({
      fixturePath: expect.stringContaining('mira-core-storage-retention-contract.json'),
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=storage-retention.json'], JSON.stringify({ profile: 'main' }));

    expect(assessment(output).schema).toBe(STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(report(output).decision).toBe('accepted');
    expect(assessment(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(assessment(output).allowed_storage_classes.raw_content_storage_allowed).toBe(false);
    expect(assessment(output).item_storage_eligibility.eligible_syncEligibility).toEqual(['core_sync_safe', 'core_sync_redacted']);
    expect(assessment(output).export_rules.export_file_written_now).toBe(false);
    expect(assessment(output).deletion_rules.deletion_performed_now).toBe(false);
    expect(assessment(output).restore_replay_rules.restore_performed_now).toBe(false);
    expect(assessment(output).capability_boundary.allowed_target_role).toBe('architect');
    expect(assessment(output).capability_boundary.local_execution_authorized).toBe(false);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.storage_retention_assessment.schema).toBe(STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
  });
});
