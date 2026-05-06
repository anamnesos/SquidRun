const persistenceAuditContract = require('./fixtures/mira-core-persistence-audit-contract.json');
const {
  BASELINE_COMMIT,
  PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCorePersistenceAudit,
  deterministicSchemaHash,
  validateMiraCorePersistenceAuditOutput,
} = require('../modules/mira-core/persistence-audit');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-persistence-audit');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCorePersistenceAudit({
    contract: persistenceAuditContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.persistence_audit_assessment;
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
  expect(() => assertNoForbiddenOutput(output, persistenceAuditContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCorePersistenceAuditOutput(output, persistenceAuditContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core persistence audit assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, persistenceAuditContract.expectedOutputShape.requiredTopLevelFields);
    expect(persistenceAuditContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, persistenceAuditContract.expectedPersistenceAuditAssessmentShape.requiredFields);
    expect(persistenceAuditContract.expectedPersistenceAuditAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, persistenceAuditContract.expectedValidationReportShape.requiredFields);
    expect(persistenceAuditContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCorePersistenceAuditOutput(output, persistenceAuditContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 17 baseline and keeps schema/audit work dry-run only', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(persistenceAuditContract.baseline.commit);
    expect(currentAssessment.persistence_assessment).toEqual(expect.objectContaining({
      baseline_ref: `commit:${BASELINE_COMMIT}`,
      storage_retention_ref: 'mira-core-storage-retention-contract:phase_17_green',
      schema_version: 'squidrun.mira_core.server_persistence_schema.v0',
      migration_status: 'dry_run_plan_only',
      database_created_now: false,
      database_write_performed_now: false,
    }));
    expect(currentAssessment.migration_gates).toEqual(expect.objectContaining({
      baseline_commit: BASELINE_COMMIT,
      phase_17_gate_id: 'requires_db_schema_gate',
      real_db_allowed_now: false,
      future_real_db_allowed_after_gates: true,
      feature_flag_default: 'off',
    }));
  });

  test('persistence assessment includes planned tables, indexes, checksums, and audit coverage', () => {
    const currentAssessment = assessment(build()).persistence_assessment;
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(currentAssessment, expected.persistenceAssessmentRequiredFields);
    expect(currentAssessment).toEqual(expect.objectContaining(expected.persistenceAssessmentRequiredValues));
    expect(currentAssessment.tables_planned).toEqual(expected.allowedSchemaSurfacesRequiredValues.allowed);
    expect(currentAssessment.accepted_schema_elements).toEqual(expected.allowedSchemaSurfacesRequiredValues.allowed);
    expect(currentAssessment.blocked_schema_elements).toEqual(expected.forbiddenSchemaSurfacesRequiredValues.forbidden_content);
    expect(currentAssessment.checksums_planned.schema_hash).toBe(deterministicSchemaHash());
    expect(currentAssessment.indexes_planned.length).toBeGreaterThan(0);
    expect(currentAssessment.audit_coverage).toEqual(expect.arrayContaining([
      'receive_validation',
      'tombstone_status',
      'export_manifest_status',
      'replay_watermark_status',
    ]));
  });

  test('allowed and forbidden schema surfaces are exact and planned-only', () => {
    const currentAssessment = assessment(build());
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(currentAssessment.allowed_schema_surfaces, expected.allowedSchemaSurfacesRequiredFields);
    expect(currentAssessment.allowed_schema_surfaces).toEqual(expect.objectContaining(expected.allowedSchemaSurfacesRequiredValues));
    expect(currentAssessment.allowed_schema_surfaces.allowed).toEqual(expected.allowedSchemaSurfacesRequiredValues.allowed);
    expect(currentAssessment.allowed_schema_surfaces.all_surfaces_planned_only).toBe(true);
    expect(currentAssessment.allowed_schema_surfaces.created_now).toBe(false);

    expectRequiredFields(currentAssessment.forbidden_schema_surfaces, expected.forbiddenSchemaSurfacesRequiredFields);
    expect(currentAssessment.forbidden_schema_surfaces).toEqual(expect.objectContaining(expected.forbiddenSchemaSurfacesRequiredValues));
    expect(currentAssessment.forbidden_schema_surfaces.forbidden_content).toEqual(expected.forbiddenSchemaSurfacesRequiredValues.forbidden_content);
    expect(currentAssessment.forbidden_schema_surfaces.raw_content_allowed).toBe(false);
    expect(currentAssessment.forbidden_schema_surfaces.raw_command_body_allowed).toBe(false);
    expect(currentAssessment.forbidden_schema_surfaces.secret_token_private_key_allowed).toBe(false);
  });

  test('per-table minimum fields preserve scope, redaction, replay, tombstone, and evidence requirements', () => {
    const fields = assessment(build()).per_table_minimum_fields;
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(fields, expected.perTableMinimumFieldsRequiredFields);
    expect(fields).toEqual(expect.objectContaining(expected.perTableMinimumFieldsRequiredValues));
    for (const surface of expected.allowedSchemaSurfacesRequiredValues.allowed) {
      expect(fields.table_minimum_fields).toHaveProperty(surface);
      expect(fields.table_minimum_fields[surface]).toEqual(expect.arrayContaining(expected.perTableMinimumFieldsRequiredValues.global_required_fields));
      expect(fields.table_minimum_fields[surface]).toEqual(expect.arrayContaining([
        'redaction_status',
        'payload_hash_or_ref',
        'idempotency_or_replay_key',
      ]));
    }
    expect(fields.table_minimum_fields.tombstones).toContain('deletion_tombstone_ref');
    expect(fields.table_minimum_fields.deletion_requests).toContain('deletion_tombstone_ref');
  });

  test('audit event contract is append-only, monotonic, role-scoped, and raw-payload-free', () => {
    const audit = assessment(build()).audit_event_contract;
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(audit, expected.auditEventContractRequiredFields);
    expect(audit).toEqual(expect.objectContaining(expected.auditEventContractRequiredValues));
    expect(audit.role_allowlist).toEqual(['architect', 'server_system', 'operator']);
    expect(audit.required_fields).toEqual(expect.arrayContaining([
      'actor',
      'role',
      'event_type',
      'source_ref',
      'scope',
      'decision_status',
      'reason_codes',
      'before_hash',
      'after_hash',
      'redaction_summary',
      'retention_class',
    ]));
    expect(audit.event_type_allowlist).toContain('schema_plan_validated');
    expect(audit.no_raw_payload).toBe(true);
    expect(audit.monotonic_sequence_required).toBe(true);
  });

  test('migration plan is deterministic, reversible, rollback-ready, and does no DB/file/network work', () => {
    const plan = assessment(build()).migration_plan_rules;
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(plan, expected.migrationPlanRulesRequiredFields);
    expect(plan).toEqual(expect.objectContaining(expected.migrationPlanRulesRequiredValues));
    expect(plan.deterministic_schema_hash_required).toBe(true);
    expect(plan.reversible_migration_plan_required).toBe(true);
    expect(plan.rollback_plan_required).toBe(true);
    expect(plan.rollback_plan.steps.length).toBeGreaterThan(0);
    expect(plan.no_migration_executed_now).toBe(true);
    expect(plan.no_db_opened_created_written).toBe(true);
    expect(plan.no_filesystem_output_file).toBe(true);
    expect(plan.no_network).toBe(true);
  });

  test('deletion/export audit and profile isolation/replay rules stay fail-closed', () => {
    const currentAssessment = assessment(build());
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(currentAssessment.deletion_export_audit_rules, expected.deletionExportAuditRulesRequiredFields);
    expect(currentAssessment.deletion_export_audit_rules).toEqual(expect.objectContaining(expected.deletionExportAuditRulesRequiredValues));
    expect(currentAssessment.deletion_export_audit_rules.tombstone_events_no_raw_payload).toBe(true);
    expect(currentAssessment.deletion_export_audit_rules.export_manifest_events_redacted_hashes_only).toBe(true);
    expect(currentAssessment.deletion_export_audit_rules.delete_request_events_leak_deleted_content).toBe(false);
    expect(currentAssessment.deletion_export_audit_rules.backup_purge_performed_now).toBe(false);

    expectRequiredFields(currentAssessment.profile_isolation_replay_rules, expected.profileIsolationReplayRulesRequiredFields);
    expect(currentAssessment.profile_isolation_replay_rules).toEqual(expect.objectContaining(expected.profileIsolationReplayRulesRequiredValues));
    expect(currentAssessment.profile_isolation_replay_rules.side_profile_mismatch_fail_closed).toBe(true);
    expect(currentAssessment.profile_isolation_replay_rules.tombstone_beats_stale_upload).toBe(true);
    expect(currentAssessment.profile_isolation_replay_rules.duplicate_idempotency_keys_rejected_or_diagnosed).toBe(true);
    expect(currentAssessment.profile_isolation_replay_rules.server_cannot_resurrect_deleted_local_state).toBe(true);
  });

  test('capability boundary prevents schema/audit overclaims', () => {
    const boundary = assessment(build()).capability_boundary;
    const expected = persistenceAuditContract.expectedPersistenceAuditAssessmentShape;

    expectRequiredFields(boundary, expected.capabilityBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.capabilityBoundaryRequiredValues));
    expect(boundary.schema_audit_validity_permits).toBe('future_persistence_schema_audit_validation_only');
    expect(boundary.allowed_target_role).toBe('architect');
    expect(boundary.local_execution_authorized).toBe(false);
    expect(boundary.builder_direct_target_authorized).toBe(false);
    expect(boundary.oracle_direct_target_authorized).toBe(false);
    expect(boundary.customer_send_authorized).toBe(false);
    expect(boundary.deploy_authorized).toBe(false);
    expect(boundary.trade_authorized).toBe(false);
    expect(boundary.memory_profile_commit_authorized).toBe(false);
    expect(boundary.model_processing_proven).toBe(false);
    expect(boundary.bridge_green_proven).toBe(false);
    expect(boundary.raw_restore_authorized).toBe(false);
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      persistenceAuditContract.expectedPersistenceAuditAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, persistenceAuditContract.expectedPersistenceAuditAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_db).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      persistenceAuditContract.expectedPersistenceAuditAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, persistenceAuditContract.expectedPersistenceAuditAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = persistenceAuditContract.expectedPersistenceAuditAssessmentShape.sideEffectRequiredValues;
    const expectedReport = persistenceAuditContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.databaseOpensAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseCreatesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.migrationsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.fileWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.rawContentStorageAttempted).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCorePersistenceAuditOutput(output, persistenceAuditContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of persistenceAuditContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(persistenceAuditContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(persistenceAuditContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects DB create/write, migration execution, file output, and side-effect lies', () => {
    const valid = build();

    const dbCreated = clone(valid);
    dbCreated.persistence_audit_assessment.persistence_assessment.database_created_now = true;
    expectValidatorFails(dbCreated, 'persistence-assessment-shape-required');

    const dbWrite = clone(valid);
    dbWrite.persistence_audit_assessment.persistence_assessment.database_write_performed_now = true;
    expectValidatorFails(dbWrite, 'persistence-assessment-shape-required');

    const migrationExecuted = clone(valid);
    migrationExecuted.persistence_audit_assessment.migration_plan_rules.no_migration_executed_now = false;
    expectValidatorFails(migrationExecuted, 'migration-plan-dry-run-required');

    const fileOutput = clone(valid);
    fileOutput.persistence_audit_assessment.migration_plan_rules.no_filesystem_output_file = false;
    expectValidatorFails(fileOutput, 'migration-plan-dry-run-required');

    const sideEffectLie = clone(valid);
    sideEffectLie.persistence_audit_assessment.side_effect_result.no_database_created = false;
    sideEffectLie.persistence_audit_assessment.side_effect_result.databaseCreatesAttempted = 1;
    expectValidatorFails(sideEffectLie, 'validation-only-no-real-db');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_database_write_performed = false;
    reportSideEffectLie.validation_report.side_effect_result.databaseWritesAttempted = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');
  });

  test('validator rejects forbidden schema surfaces, missing table scope fields, raw audit payloads, and missing rollback', () => {
    const valid = build();

    const extraSurface = clone(valid);
    extraSurface.persistence_audit_assessment.allowed_schema_surfaces.allowed.push('raw_command_logs');
    expectValidatorFails(extraSurface, 'allowed-schema-surfaces-required');

    const rawAllowed = clone(valid);
    rawAllowed.persistence_audit_assessment.forbidden_schema_surfaces.raw_content_allowed = true;
    expectValidatorFails(rawAllowed, 'forbidden-schema-surfaces-blocked');

    const commandAllowed = clone(valid);
    commandAllowed.persistence_audit_assessment.forbidden_schema_surfaces.raw_command_body_allowed = true;
    expectValidatorFails(commandAllowed, 'forbidden-schema-surfaces-blocked');

    const missingScope = clone(valid);
    missingScope.persistence_audit_assessment.per_table_minimum_fields.table_minimum_fields.sync_items =
      missingScope.persistence_audit_assessment.per_table_minimum_fields.table_minimum_fields.sync_items.filter((field) => field !== 'profile');
    expectValidatorFails(missingScope, 'per-table-minimum-fields-required');

    const rawAudit = clone(valid);
    rawAudit.persistence_audit_assessment.audit_event_contract.no_raw_payload = false;
    expectValidatorFails(rawAudit, 'audit-event-contract-required');

    const mutableAudit = clone(valid);
    mutableAudit.persistence_audit_assessment.audit_event_contract.append_only = false;
    expectValidatorFails(mutableAudit, 'audit-event-contract-required');

    const unorderedAudit = clone(valid);
    unorderedAudit.persistence_audit_assessment.audit_event_contract.monotonic_sequence_required = false;
    expectValidatorFails(unorderedAudit, 'audit-event-contract-required');

    const missingRollback = clone(valid);
    missingRollback.persistence_audit_assessment.migration_plan_rules.rollback_plan_required = false;
    expectValidatorFails(missingRollback, 'migration-plan-dry-run-required');
  });

  test('validator rejects deletion/export leaks, replay/idempotency regressions, and resurrection overclaims', () => {
    const valid = build();

    const deleteLeak = clone(valid);
    deleteLeak.persistence_audit_assessment.deletion_export_audit_rules.delete_request_events_leak_deleted_content = true;
    expectValidatorFails(deleteLeak, 'deletion-export-audit-rules-required');

    const exportLeak = clone(valid);
    exportLeak.persistence_audit_assessment.deletion_export_audit_rules.export_manifest_events_redacted_hashes_only = false;
    expectValidatorFails(exportLeak, 'deletion-export-audit-rules-required');

    const backupPurge = clone(valid);
    backupPurge.persistence_audit_assessment.deletion_export_audit_rules.backup_purge_performed_now = true;
    expectValidatorFails(backupPurge, 'deletion-export-audit-rules-required');

    const profileMismatch = clone(valid);
    profileMismatch.persistence_audit_assessment.profile_isolation_replay_rules.side_profile_mismatch_fail_closed = false;
    expectValidatorFails(profileMismatch, 'profile-isolation-replay-rules-required');

    const tombstoneLost = clone(valid);
    tombstoneLost.persistence_audit_assessment.profile_isolation_replay_rules.tombstone_beats_stale_upload = false;
    expectValidatorFails(tombstoneLost, 'profile-isolation-replay-rules-required');

    const duplicateSilent = clone(valid);
    duplicateSilent.persistence_audit_assessment.profile_isolation_replay_rules.duplicate_idempotency_keys_rejected_or_diagnosed = false;
    expectValidatorFails(duplicateSilent, 'profile-isolation-replay-rules-required');

    const resurrection = clone(valid);
    resurrection.persistence_audit_assessment.profile_isolation_replay_rules.server_cannot_resurrect_deleted_local_state = false;
    expectValidatorFails(resurrection, 'profile-isolation-replay-rules-required');
  });

  test('validator rejects capability overclaims from schema/audit validity', () => {
    const overclaims = [
      ['local_execution_authorized', true],
      ['shell_or_pty_authorized', true],
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
      tampered.persistence_audit_assessment.capability_boundary[field] = value;
      expectValidatorFails(tampered, 'capability-boundary-validation-only');
    }

    const wrongTarget = clone(build());
    wrongTarget.persistence_audit_assessment.capability_boundary.allowed_target_role = 'builder';
    expectValidatorFails(wrongTarget, 'capability-boundary-validation-only');
  });

  test('validator rejects missing gates, missing blockers, baseline drift, and migration gate drift', () => {
    const valid = build();

    const missingGate = clone(valid);
    missingGate.persistence_audit_assessment.acceptance_gate_summary.pop();
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.persistence_audit_assessment.blocker_summary.pop();
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const baselineDrift = clone(valid);
    baselineDrift.persistence_audit_assessment.baseline_commit = 'badc0de';
    expectValidatorFails(baselineDrift, 'phase-18-baseline-afabea1-pinned');

    const gateDrift = clone(valid);
    gateDrift.persistence_audit_assessment.migration_gates.real_db_allowed_now = true;
    expectValidatorFails(gateDrift, 'migration-real-db-gated');

    const outputMissing = clone(valid);
    delete outputMissing.validation_report;
    expectValidatorFails(outputMissing, 'output-shape-complete');
  });

  test('validator rejects forbidden raw/private/proof/live side-effect substrings in values', () => {
    const forbiddenValues = [
      'raw comms body',
      'raw terminal scrollback',
      'browser DOM',
      'customer private note',
      'BEGIN PRIVATE KEY',
      'database created',
      'migration executed',
      'audit log wrote raw payload',
      'export file written',
      'delete performed',
      'restore performed',
      'server executed local work',
      'schema authorizes local execution',
      'audit proves model processing',
      'socket alone proves bridge green',
      'builder direct target authorized',
      'oracle direct target authorized',
      'tier2 authorized by schema',
      'memory commit authorized by audit',
    ];

    for (const forbidden of forbiddenValues) {
      const tampered = clone(build());
      tampered.persistence_audit_assessment.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'forbidden-substrings-absent');
    }
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful changes', () => {
    const first = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = assessment(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.assessment_id).toBe(second.assessment_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    tampered.persistence_audit_assessment.allowed_schema_surfaces.created_now = true;
    expectValidatorFails(tampered, 'idempotency-stable');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-persistence-audit-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(assessment(output).schema).toBe(PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION);
    expect(assessment(output).sessionId).toBe('session-cli');
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(assessment(output).side_effect_result.no_database_created).toBe(true);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCorePersistenceAuditOutput(output, persistenceAuditContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
