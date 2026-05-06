const promotionContract = require('./fixtures/mira-core-runtime-promotion-gate-contract.json');
const {
  ALLOWED_PROMOTION_DECISIONS,
  BASELINE_COMMIT,
  DEFAULT_PREREQUISITE_GATE_IDS,
  DEFAULT_SIDE_EFFECT_GATE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimePromotionGate,
  runtimePromotionGateIdempotencyKey,
  validateMiraCoreRuntimePromotionGateOutput,
} = require('../modules/mira-core/runtime-promotion-gate');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-promotion-gate');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimePromotionGate({
    contract: promotionContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function gateReport(output) {
  return output.runtime_promotion_gate_report;
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
  expect(() => assertNoForbiddenOutput(output, promotionContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimePromotionGateOutput(output, promotionContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core runtime promotion gate assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, gate report, and validation report shapes', () => {
    const output = build();
    const currentReport = gateReport(output);
    const validation = report(output);

    expectRequiredFields(output, promotionContract.expectedOutputShape.requiredTopLevelFields);
    expect(promotionContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentReport.schema).toBe(RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentReport, promotionContract.expectedRuntimePromotionGateReportShape.requiredFields);
    expect(promotionContract.expectedRuntimePromotionGateReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, promotionContract.expectedValidationReportShape.requiredFields);
    expect(promotionContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimePromotionGateOutput(output, promotionContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline and Phase 23 dependency current through Phase 22', () => {
    const dependency = gateReport(build()).phase_23_dependency;
    const expected = promotionContract.expectedRuntimePromotionGateReportShape;

    expect(gateReport(build()).baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(promotionContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase23DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase23DependencyRequiredValues));
    expect(dependency.current_through_phase).toBe(22);
    expect(dependency.phase_inventory_count).toBe(22);
    expect(dependency.phase_13_stale_superseded).toBe(true);
    expect(dependency.phase_22_closure_required).toBe(true);
  });

  test('operator decision defaults to remain validation-only and eligible is not authorization', () => {
    const decision = gateReport(build()).operator_promotion_decision;
    const expected = promotionContract.expectedRuntimePromotionGateReportShape;

    expectRequiredFields(decision, expected.operatorPromotionDecisionRequiredFields);
    expect(decision.allowed_decisions).toEqual(ALLOWED_PROMOTION_DECISIONS);
    expect(decision.allowed_decisions).toEqual(expected.allowedPromotionDecisions);
    expect(decision.decision).toBe('remain_validation_only');
    expect(decision.default_decision).toBe('remain_validation_only');
    expect(decision.risk_tier).toBe('tier1_local_reversible_validation');
    expect(decision.operator_visible).toBe(true);
    expect(decision.runtime_started).toBe(false);
    expect(decision.eligible_decision_is_authorization).toBe(false);
    expect(decision.missing_gates.length).toBeGreaterThan(0);
  });

  test('eligible future slice remains non-authorizing when all gates are represented as satisfied', () => {
    const output = build({
      allPrerequisitesSatisfied: true,
      allEnvironmentGatesSatisfied: true,
      operatorDecision: 'eligible_for_future_runtime_slice',
    });
    const currentReport = gateReport(output);

    expect(currentReport.operator_promotion_decision.decision).toBe('eligible_for_future_runtime_slice');
    expect(currentReport.operator_promotion_decision.eligible_decision_is_authorization).toBe(false);
    expect(currentReport.operator_promotion_decision.runtime_started).toBe(false);
    expect(currentReport.side_effect_result.no_runtime_performed).toBe(true);
    expect(currentReport.side_effect_result.no_output_file_written).toBe(true);
    expect(validateMiraCoreRuntimePromotionGateOutput(output, promotionContract).ok).toBe(true);
  });

  test('prerequisite gates and environment config gates are reference-only', () => {
    const currentReport = gateReport(build());
    const expected = promotionContract.expectedRuntimePromotionGateReportShape;

    expect(currentReport.required_prerequisite_gates.map((gate) => gate.gate_id)).toEqual(DEFAULT_PREREQUISITE_GATE_IDS);
    expect(DEFAULT_PREREQUISITE_GATE_IDS).toEqual(expected.requiredPrerequisiteGateIds);
    for (const gate of currentReport.required_prerequisite_gates) {
      expectRequiredFields(gate, expected.requiredPrerequisiteGateFields);
      expect(gate.required_for_future_eligibility).toBe(true);
      expect(gate.reference_only).toBe(true);
      expect(gate.must_be_operator_visible).toBe(true);
      expect(gate.blocks_if_missing).toBe(true);
      if (expected.requiredPrerequisiteGateRefs[gate.gate_id]) {
        expect(gate.phase_refs).toContain(expected.requiredPrerequisiteGateRefs[gate.gate_id]);
      }
    }
    expect(currentReport.environment_config_gates.map((gate) => gate.gate_id)).toEqual(expected.requiredEnvironmentConfigGateIds);
    for (const gate of currentReport.environment_config_gates) {
      expectRequiredFields(gate, expected.environmentConfigGateRequiredFields);
      expect(gate.future_only).toBe(true);
      expect(gate.reference_only).toBe(true);
      expect(gate.raw_secret_allowed).toBe(false);
      expect(gate.raw_path_allowed).toBe(false);
      expect(gate.blocks_eligibility_if_missing).toBe(true);
    }
  });

  test('side-effect gates, proof boundaries, replay safety, and future limits stay safe', () => {
    const currentReport = gateReport(build());
    const expected = promotionContract.expectedRuntimePromotionGateReportShape;

    expect(currentReport.side_effect_gates.map((gate) => gate.gate_id)).toEqual(DEFAULT_SIDE_EFFECT_GATE_IDS);
    expect(DEFAULT_SIDE_EFFECT_GATE_IDS).toEqual(expected.requiredSideEffectGateIds);
    for (const gate of currentReport.side_effect_gates) {
      expectRequiredFields(gate, expected.sideEffectGateRequiredFields);
      expect(gate.must_remain_false_now).toBe(true);
      expect(gate.failure_decision).toBe('blocked');
    }
    expectRequiredFields(currentReport.proof_boundaries, expected.proofBoundaryRequiredFields);
    expect(currentReport.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(currentReport.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(currentReport.proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(currentReport.proof_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(currentReport.proof_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(currentReport.proof_boundaries.runtime_gate_is_runtime_proof).toBe(false);
    expectRequiredFields(currentReport.replay_safety_gates, expected.replaySafetyGateRequiredFields);
    expect(currentReport.replay_safety_gates.phase_22_oracle_78_79_80_closure_required).toBe(true);
    expect(currentReport.replay_safety_gates.same_sequence_decision_binding_required).toBe(true);
    expect(currentReport.replay_safety_gates.recomputed_idempotency_regressions_required).toBe(true);
    expect(currentReport.future_runtime_slice_limits.eligible_is_authorization).toBe(false);
    expect(currentReport.future_runtime_slice_limits.allowed_risk_tiers).toEqual(expected.allowedPromotionRiskTiers);
  });

  test('tamper coverage, blockers, next safe actions, side-effect truth, static rules, and acceptance checks are present', () => {
    const output = build();
    const currentReport = gateReport(output);
    const validation = validateMiraCoreRuntimePromotionGateOutput(output, promotionContract);

    expect(currentReport.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(promotionContract.tamperCases.map((entry) => entry.id));
    expect(currentReport.tamper_case_coverage.every((entry) => entry.covered)).toBe(true);
    expect(currentReport.blocker_summary.map((entry) => entry.blocker_id)).toEqual(promotionContract.expectedRuntimePromotionGateReportShape.blockerSummaryRequiredIds);
    expect(currentReport.next_safe_actions.map((entry) => entry.action_id)).toEqual(promotionContract.expectedRuntimePromotionGateReportShape.nextSafeActionRequiredIds);
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(currentReport.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_result[field]).toBe(true);
    }
    expect(currentReport.side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of promotionContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(report(output).acceptance_checks.map((entry) => entry.id)).toEqual(promotionContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).acceptance_checks.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to gate changes', () => {
    const first = gateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = gateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = gateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.gate_report_id).toBe(second.gate_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const tampered = clone(build());
    tampered.runtime_promotion_gate_report.proof_boundaries.socket_is_bridge_green_proof = true;
    tampered.runtime_promotion_gate_report.idempotency_key = runtimePromotionGateIdempotencyKey(tampered.runtime_promotion_gate_report);
    expectValidatorFails(tampered, 'proof-boundaries-preserved');
    expect(validateMiraCoreRuntimePromotionGateOutput(tampered, promotionContract).checks.find((entry) => entry.id === 'idempotency-sensitive-to-gates')).toEqual(expect.objectContaining({ ok: true }));
  });

  test('validator rejects missing Phase 23 dependency and stale readiness', () => {
    const missing = clone(build());
    missing.runtime_promotion_gate_report.phase_23_dependency.current_through_phase = 12;
    expectValidatorFails(missing, 'phase23-current-through-22-required');

    const baseline = clone(build());
    baseline.runtime_promotion_gate_report.phase_23_dependency.baseline_commit = 'b7e2106';
    expectValidatorFails(baseline, 'phase23-current-through-22-required');
  });

  test('validator rejects eligible overclaim with missing kill switch or environment gates', () => {
    const eligible = clone(build());
    eligible.runtime_promotion_gate_report.operator_promotion_decision.decision = 'eligible_for_future_runtime_slice';
    expectValidatorFails(eligible, 'operator-decision-allowed-and-safe');

    const missingKillSwitch = clone(build({
      allPrerequisitesSatisfied: true,
      allEnvironmentGatesSatisfied: true,
      operatorDecision: 'eligible_for_future_runtime_slice',
    }));
    missingKillSwitch.runtime_promotion_gate_report.required_prerequisite_gates =
      missingKillSwitch.runtime_promotion_gate_report.required_prerequisite_gates.filter((gate) => gate.gate_id !== 'operator-kill-switch');
    expectValidatorFails(missingKillSwitch, 'future-runtime-prerequisites-complete');
    expectValidatorFails(missingKillSwitch, 'kill-switch-rollback-audit-required');
  });

  test('validator rejects hidden listener/network/store side effects and report side-effect lies', () => {
    const hidden = clone(build());
    hidden.runtime_promotion_gate_report.side_effect_result.no_network_performed = false;
    hidden.runtime_promotion_gate_report.side_effect_result.networkRequestsAttempted = 1;
    expectValidatorFails(hidden, 'side-effect-gates-all-false-now');
    expectValidatorFails(hidden, 'side-effect-truth-all-safe');

    const reportLie = clone(build());
    reportLie.validation_report.side_effect_result.no_output_file_written = false;
    reportLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(reportLie, 'validation-report-side-effect-truth');
  });

  test('validator rejects unsafe tiers, direct action classes, and proof overclaims', () => {
    const tier3 = clone(build());
    tier3.runtime_promotion_gate_report.operator_promotion_decision.risk_tier = 'tier3_external_side_effect';
    expectValidatorFails(tier3, 'operator-decision-allowed-and-safe');
    expectValidatorFails(tier3, 'unsafe-tier-promotion-rejected');

    const requestedDeploy = clone(build());
    requestedDeploy.runtime_promotion_gate_report.operator_promotion_decision.requested_action_classes = ['deploy'];
    expectValidatorFails(requestedDeploy, 'unsafe-tier-promotion-rejected');

    const fakeProof = clone(build());
    fakeProof.runtime_promotion_gate_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    expectValidatorFails(fakeProof, 'proof-boundaries-preserved');
    expectValidatorFails(fakeProof, 'fake-proof-rejected');
  });

  test('validator rejects Phase 22 closure gaps and replay safety gate removal', () => {
    const missingClosure = clone(build());
    missingClosure.runtime_promotion_gate_report.replay_safety_gates.phase_22_oracle_78_79_80_closure_required = false;
    expectValidatorFails(missingClosure, 'replay-idempotency-tombstone-watermark-expiry-gates-present');

    const missingReplay = clone(build());
    missingReplay.runtime_promotion_gate_report.replay_safety_gates.same_sequence_decision_binding_required = false;
    expectValidatorFails(missingReplay, 'replay-idempotency-tombstone-watermark-expiry-gates-present');
  });

  test('validator rejects environment config raw secret/path and missing audit/rollback gates', () => {
    const rawSecret = clone(build());
    rawSecret.runtime_promotion_gate_report.environment_config_gates.find((gate) => gate.gate_id === 'auth-secret-presence-ref').raw_secret_allowed = true;
    expectValidatorFails(rawSecret, 'environment-config-reference-only');

    const rawPath = clone(build());
    rawPath.runtime_promotion_gate_report.environment_config_gates.find((gate) => gate.gate_id === 'storage-path-ref').raw_path_allowed = true;
    expectValidatorFails(rawPath, 'environment-config-reference-only');

    const missingAudit = clone(build());
    missingAudit.runtime_promotion_gate_report.environment_config_gates =
      missingAudit.runtime_promotion_gate_report.environment_config_gates.filter((gate) => gate.gate_id !== 'telemetry-audit-plan-ref');
    expectValidatorFails(missingAudit, 'environment-config-reference-only');
    expectValidatorFails(missingAudit, 'kill-switch-rollback-audit-required');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime started',
      'server started',
      'listener bound',
      'network request performed',
      'database write performed',
      'queue created',
      'lease created',
      'auth changed',
      'key generated',
      'secret read',
      'local execution performed',
      'deploy performed',
      'trade performed',
      'output file written',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'server can execute local arms',
      'direct builder target allowed',
      'eligible authorizes runtime',
      'tier3 promoted',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw customer private',
      'source-store payload',
      'bearer token',
      'session secret',
      'private key',
      'plaintext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.runtime_promotion_gate_report.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'raw-private-secret-leakage-rejected');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-promotion-gate-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(gateReport(output).schema).toBe(RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION);
    expect(gateReport(output).sessionId).toBe('session-cli');
    expect(gateReport(output).baseline_commit).toBe('3ce041c');
    expect(gateReport(output).phase_23_dependency.current_through_phase).toBe(22);
    expect(gateReport(output).operator_promotion_decision.decision).toBe('remain_validation_only');
    expect(gateReport(output).proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(gateReport(output).replay_safety_gates.phase_22_oracle_78_79_80_closure_required).toBe(true);
    expect(gateReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(gateReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(gateReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimePromotionGateOutput(output, promotionContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
