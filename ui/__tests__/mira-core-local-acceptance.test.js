const localAcceptanceContract = require('./fixtures/mira-core-local-acceptance-contract.json');
const {
  ACCEPTANCE_RECORD_SCHEMA_VERSION,
  DRY_RUN_LEASE_SCHEMA_VERSION,
  REQUIRED_ACCEPTANCE_RECORD_FIELDS,
  REQUIRED_DRY_RUN_LEASE_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreLocalAcceptance,
  validateMiraCoreLocalAcceptanceOutput,
} = require('../modules/mira-core/local-acceptance');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-local-acceptance');

function acceptance(id) {
  return localAcceptanceContract.acceptanceChecks.find((check) => check.id === id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...localAcceptanceContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function firstRecord(output) {
  return output.acceptance_records[0];
}

describe('mira core local acceptance v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, acceptance, dry-run lease, and report shapes', () => {
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: acceptance('valid-tier0-intent-accepted-local-only').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.acceptance_records[0];
    const lease = output.dry_run_lease_records[0];
    const report = output.validation_report;

    expectRequiredFields(output, localAcceptanceContract.expectedOutputShape.requiredTopLevelFields);
    expect(localAcceptanceContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(record.schema).toBe(ACCEPTANCE_RECORD_SCHEMA_VERSION);
    expect(lease.schema).toBe(DRY_RUN_LEASE_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(record, localAcceptanceContract.expectedAcceptanceRecordShape.requiredFields);
    expect(localAcceptanceContract.expectedAcceptanceRecordShape.requiredFields).toEqual(REQUIRED_ACCEPTANCE_RECORD_FIELDS);
    expectRequiredFields(lease, localAcceptanceContract.expectedDryRunLeaseRecordShape.requiredFields);
    expect(localAcceptanceContract.expectedDryRunLeaseRecordShape.requiredFields).toEqual(REQUIRED_DRY_RUN_LEASE_FIELDS);
    expectRequiredFields(record.source_intent_ref, localAcceptanceContract.expectedAcceptanceRecordShape.sourceIntentRequiredFields);
    expectRequiredFields(record.accepted_by, localAcceptanceContract.expectedAcceptanceRecordShape.acceptedByRequiredFields);
    expectRequiredFields(record.role_discovery, localAcceptanceContract.expectedAcceptanceRecordShape.roleDiscoveryRequiredFields);
    expectRequiredFields(record.current_risk_recheck, localAcceptanceContract.expectedAcceptanceRecordShape.currentRiskRecheckRequiredFields);
    expectRequiredFields(record.local_delegation, localAcceptanceContract.expectedAcceptanceRecordShape.localDelegationRequiredFields);
    expectRequiredFields(lease.local_delegation_candidate, localAcceptanceContract.expectedDryRunLeaseRecordShape.localDelegationCandidateRequiredFields);
    expectRequiredFields(lease.proof_boundaries, localAcceptanceContract.expectedDryRunLeaseRecordShape.proofBoundaryRequiredFields);
    expectRequiredFields(report, localAcceptanceContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(localAcceptanceContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreLocalAcceptanceOutput(output, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('valid Tier 0 pending Architect intent becomes local-only acceptance plus dry-run lease contract', () => {
    const check = acceptance('valid-tier0-intent-accepted-local-only');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = firstRecord(output);
    const lease = output.dry_run_lease_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(record.source_intent_ref.allowed_target_roles).toEqual(['architect']);
    expect(lease).toEqual(expect.objectContaining(check.expectedDryRunLease));
    expect(lease.proof_boundaries).toEqual(expect.objectContaining(
      localAcceptanceContract.expectedDryRunLeaseRecordShape.proofBoundaryRequiredValues
    ));
    expect(record.role_discovery.architect_role_registered).toBe(true);
    expect(record.role_discovery.role_target_proof).toBe('architect_local_verified');
    expect(record.current_risk_recheck.decision).toBe('still_tier0_or_tier1');
    expect(record.profile_scope_result.decision).toBe('match');
    expect(record.freshness_result.decision).toBe('fresh');
    expect(output.validation_report.accepted_count).toBe(1);
    expect(output.validation_report.dry_run_lease_candidate_count).toBe(1);
  });

  test('valid Tier 1 plan intent can be accepted locally with expiry and no execution', () => {
    const check = acceptance('valid-tier1-plan-intent-accepted-with-expiry');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(record.risk_tier).toBe('tier1_local_reversible');
    expect(record.source_intent_ref.expires_at).toBe('2026-05-08T03:00:00.000Z');
    expect(output.dry_run_lease_records).toHaveLength(1);
  });

  test('missing Architect role discovery blocks acceptance and does not treat socket as bridge green', () => {
    const check = acceptance('role-discovery-missing-blocks-acceptance');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(record.role_discovery.socket_connection_status).toBe('connected');
    expect(record.role_discovery.socket_is_bridge_green).toBe(false);
    expect(output.dry_run_lease_records).toHaveLength(0);
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('fresh risk upgrade blocks acceptance', () => {
    const check = acceptance('fresh-risk-recheck-upgrade-blocks');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    expect(firstRecord(output)).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(output.validation_report.risk_recheck_result.riskUpgradesBlocked).toBe(1);
    expect(output.dry_run_lease_records).toHaveLength(0);
  });

  test('expired and stale intents become expired, never accepted', () => {
    const check = acceptance('expired-stale-intent-rejected');
    const output = buildMiraCoreLocalAcceptance({ inputSignals: check.inputSignals });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(output.validation_report.reasons).toEqual(expect.arrayContaining(check.validationReportMustIncludeReason));
    expect(output.validation_report.expired_count).toBe(1);
    expect(output.dry_run_lease_records).toHaveLength(0);
  });

  test('profile/session/device mismatch blocks acceptance', () => {
    const check = acceptance('profile-session-device-mismatch-blocked');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    expect(firstRecord(output)).toEqual(expect.objectContaining(check.expectedAcceptance));
    expect(output.validation_report.profile_scope_result.mismatchesBlocked).toBe(1);
    expect(output.dry_run_lease_records).toHaveLength(0);
  });

  test('direct Builder and Oracle cross-device targets remain blocked', () => {
    const check = acceptance('direct-builder-oracle-cross-device-target-blocked');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const expected of check.expectedAcceptance) {
      const record = output.acceptance_records.find((entry) => entry.source_intent_ref.target_role === expected.target_role);
      expect(record).toEqual(expect.objectContaining(expected));
    }
    expect(output.dry_run_lease_records).toHaveLength(0);
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('local delegation is represented only as future local Architect work after acceptance', () => {
    const check = acceptance('local-delegation-after-acceptance-only');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = firstRecord(output);
    const lease = output.dry_run_lease_records[0];

    expect(record.local_delegation).toEqual(expect.objectContaining(check.expectedAcceptance.local_delegation));
    expect(lease.local_delegation_candidate).toEqual(expect.objectContaining(check.expectedDryRunLease.local_delegation_candidate));
  });

  test('acceptance and reject validations are idempotent and sensitive to changed decision/risk', () => {
    const check = acceptance('acceptance-and-reject-idempotent');
    const outputA = buildMiraCoreLocalAcceptance({ inputSignals: { acceptanceA: check.inputSignals.acceptanceA } });
    const outputB = buildMiraCoreLocalAcceptance({ inputSignals: { acceptanceA: check.inputSignals.acceptanceB } });
    const changedDecision = buildMiraCoreLocalAcceptance({
      inputSignals: {
        acceptanceA: {
          ...check.inputSignals.acceptanceA,
          status: 'blocked_no_execution',
        },
        intent: {
          status: 'blocked',
        },
      },
    });
    const changedRisk = buildMiraCoreLocalAcceptance({
      inputSignals: {
        acceptanceA: {
          ...check.inputSignals.acceptanceA,
          risk_tier: check.inputSignals.changedRisk.risk_tier,
        },
        currentRiskRecheck: {
          current_risk_tier: check.inputSignals.changedRisk.risk_tier,
        },
      },
    });

    expect(outputA.acceptance_records[0].idempotency_key).toBe(outputB.acceptance_records[0].idempotency_key);
    expect(changedDecision.acceptance_records[0].idempotency_key).not.toBe(outputA.acceptance_records[0].idempotency_key);
    expect(changedRisk.acceptance_records[0].idempotency_key).not.toBe(outputA.acceptance_records[0].idempotency_key);
    expect(outputA.validation_report.idempotency_result.excludes).toEqual(expect.arrayContaining(check.expectedOutput.keysMustExclude));
  });

  test('proof boundaries are explicit for acceptance, dry-run lease, socket, and model processing', () => {
    const check = acceptance('proof-boundaries-are-explicit');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const lease = output.dry_run_lease_records[0];

    expect(lease.proof_boundaries).toEqual(expect.objectContaining(check.expectedDryRunLease.proof_boundaries));
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('raw payload leakage is blocked and redacted', () => {
    const check = acceptance('raw-payload-leakage-prevented');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    expect(firstRecord(output)).toEqual(expect.objectContaining(check.expectedAcceptance));
    expectNoForbiddenOutput(output, check.forbiddenOutputSubstringsMustBeAbsent);
    expect(output.dry_run_lease_records).toHaveLength(0);
  });

  test('local acceptance creates no queue, real lease, route, execution, send, deploy, trade, store write, or output file', () => {
    const check = acceptance('no-side-effects');
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const record of output.acceptance_records) {
      expect(record).toEqual(expect.objectContaining(check.expectedOutput.acceptance_records.everyRecord));
    }
    for (const lease of output.dry_run_lease_records) {
      expect(lease).toEqual(expect.objectContaining(check.expectedOutput.dry_run_lease_records.everyRecord));
    }
    expect(output.validation_report.side_effect_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.side_effect_result));
    expect(output.validation_report.side_effect_result.outputFileWritten).toBe(false);
    for (const forbidden of check.expectedOutput.mustNotInclude) {
      if (forbidden === 'enqueue') {
        expect(output.validation_report.side_effect_result.no_enqueue_performed).toBe(true);
        expect(output.validation_report.side_effect_result.queueWritesAttempted).toBe(0);
        continue;
      }
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('static validation rules are covered by the output validator', () => {
    const output = buildMiraCoreLocalAcceptance({
      inputSignals: {
        intents: [
          acceptance('valid-tier0-intent-accepted-local-only').inputSignals.intent,
          acceptance('role-discovery-missing-blocks-acceptance').inputSignals.intent,
          ...acceptance('direct-builder-oracle-cross-device-target-blocked').inputSignals.intents,
        ],
        currentContext: acceptance('valid-tier0-intent-accepted-local-only').inputSignals.currentContext,
      },
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const validation = validateMiraCoreLocalAcceptanceOutput(output, localAcceptanceContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((check) => check.id);
    for (const rule of localAcceptanceContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects missing fields, invalid acceptance, proof lies, and side-effect lies', () => {
    const valid = buildMiraCoreLocalAcceptance({
      inputSignals: acceptance('valid-tier0-intent-accepted-local-only').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    expect(validateMiraCoreLocalAcceptanceOutput(valid, localAcceptanceContract).ok).toBe(true);

    const missingField = clone(valid);
    delete missingField.acceptance_records[0].source_intent_ref;
    expect(validateMiraCoreLocalAcceptanceOutput(missingField, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const nonPendingAccepted = clone(valid);
    nonPendingAccepted.acceptance_records[0].source_intent_ref.status = 'blocked';
    expect(validateMiraCoreLocalAcceptanceOutput(nonPendingAccepted, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingRoleProofAccepted = clone(valid);
    missingRoleProofAccepted.acceptance_records[0].role_discovery.architect_role_registered = false;
    expect(validateMiraCoreLocalAcceptanceOutput(missingRoleProofAccepted, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const riskUpgradedAccepted = clone(valid);
    riskUpgradedAccepted.acceptance_records[0].current_risk_recheck.current_risk_tier = 'tier3_external_side_effect';
    expect(validateMiraCoreLocalAcceptanceOutput(riskUpgradedAccepted, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const staleAccepted = clone(valid);
    staleAccepted.acceptance_records[0].freshness_result.decision = 'stale';
    expect(validateMiraCoreLocalAcceptanceOutput(staleAccepted, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const scopeMismatchAccepted = clone(valid);
    scopeMismatchAccepted.acceptance_records[0].profile_scope_result.decision = 'mismatch';
    expect(validateMiraCoreLocalAcceptanceOutput(scopeMismatchAccepted, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const leaseProofLie = clone(valid);
    leaseProofLie.dry_run_lease_records[0].proof_boundaries.dry_run_lease_is_real_lease = true;
    leaseProofLie.dry_run_lease_records[0].proof_boundaries.dry_run_lease_is_model_processing_proof = true;
    expect(validateMiraCoreLocalAcceptanceOutput(leaseProofLie, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideEffectLie = clone(valid);
    sideEffectLie.validation_report.side_effect_result.no_lease_created = false;
    sideEffectLie.validation_report.side_effect_result.leasesCreated = 1;
    expect(validateMiraCoreLocalAcceptanceOutput(sideEffectLie, localAcceptanceContract)).toEqual(expect.objectContaining({ ok: false }));
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'acceptance.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=acceptance.json'], JSON.stringify(acceptance('valid-tier0-intent-accepted-local-only').inputSignals));

    expect(output.acceptance_records[0].schema).toBe(ACCEPTANCE_RECORD_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.acceptance_records[0].schema).toBe(ACCEPTANCE_RECORD_SCHEMA_VERSION);
    expect(printed.dry_run_lease_records[0].schema).toBe(DRY_RUN_LEASE_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.validation_report.side_effect_result.no_lease_created).toBe(true);
    expect(printed.validation_report.side_effect_result.leasesCreated).toBe(0);
  });
});
