const runtimeHarnessContract = require('./fixtures/mira-core-runtime-harness-contract.json');
const {
  ALLOWED_PER_REQUEST_DECISIONS,
  BASELINE_COMMIT,
  DEPENDENCIES,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeHarness,
  runtimeHarnessIdempotencyKey,
  validateMiraCoreRuntimeHarnessOutput,
} = require('../modules/mira-core/runtime-harness');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-harness');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeHarness({
    contract: runtimeHarnessContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.runtime_harness_assessment;
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
  expect(() => assertNoForbiddenOutput(output, runtimeHarnessContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeHarnessOutput(output, runtimeHarnessContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeAssessmentIdempotency(output) {
  const currentAssessment = assessment(output);
  currentAssessment.idempotency_key = runtimeHarnessIdempotencyKey(currentAssessment);
  return output;
}

function promoteScenarioToAccepted(output, scenario) {
  const currentAssessment = assessment(output);
  const request = currentAssessment.request_batch.requests.find((entry) => entry.scenario === scenario);
  expect(request).toBeTruthy();
  const result = currentAssessment.per_request_results.find((entry) => entry.request_id === request.request_id);
  expect(result).toBeTruthy();
  request.expected_decision = 'accepted_for_validation_only';
  result.decision = 'accepted_for_validation_only';
  result.status = 'status_only';
  result.reason_codes = ['tampered_acceptance'];
  recomputeAssessmentIdempotency(output);
  const validation = validateMiraCoreRuntimeHarnessOutput(output, runtimeHarnessContract);
  expect(validation.checks.find((entry) => entry.id === 'idempotency-stable')).toEqual(expect.objectContaining({ ok: true }));
  expect(validation.ok).toBe(false);
  return validation;
}

function statusForMovedDecision(decision) {
  if (decision === 'replay_rejected') return 'duplicate_rejected';
  if (decision === 'stale_watermark_rejected') return 'stale_watermark_rejected';
  if (decision === 'tombstone_wins') return 'tombstone_wins';
  if (decision === 'expired') return 'expired';
  return 'status_only';
}

function moveFailClosedOutcomeAwayFromRequest(output, sequence, movedDecision) {
  const currentAssessment = assessment(output);
  const badRequest = currentAssessment.request_batch.requests.find((entry) => entry.sequence === sequence);
  expect(badRequest).toBeTruthy();
  const badResult = currentAssessment.per_request_results.find((entry) => entry.request_id === badRequest.request_id);
  expect(badResult).toBeTruthy();
  const carrierRequest = currentAssessment.request_batch.requests.find((entry) => entry.sequence === 1);
  const carrierResult = currentAssessment.per_request_results.find((entry) => entry.request_id === carrierRequest.request_id);
  expect(carrierRequest).toBeTruthy();
  expect(carrierResult).toBeTruthy();

  badRequest.scenario = 'read_only_status_request';
  badRequest.expected_decision = 'accepted_for_validation_only';
  badRequest.expected_state_delta_kind = 'status_only';
  badResult.decision = 'accepted_for_validation_only';
  badResult.status = 'status_only';
  badResult.reason_codes = ['tampered_safe_relabel'];

  carrierRequest.expected_decision = movedDecision;
  carrierResult.decision = movedDecision;
  carrierResult.status = statusForMovedDecision(movedDecision);
  carrierResult.reason_codes = [`moved_${movedDecision}`];

  recomputeAssessmentIdempotency(output);
  const validation = validateMiraCoreRuntimeHarnessOutput(output, runtimeHarnessContract);
  expect(validation.checks.find((entry) => entry.id === 'idempotency-stable')).toEqual(expect.objectContaining({ ok: true }));
  expect(validation.ok).toBe(false);
  return validation;
}

describe('mira core in-process runtime harness assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, runtimeHarnessContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeHarnessContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape.requiredFields);
    expect(runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, runtimeHarnessContract.expectedValidationReportShape.requiredFields);
    expect(runtimeHarnessContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeHarnessOutput(output, runtimeHarnessContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 21 baseline and maps Phases 14-21 as validation-only dependencies', () => {
    const currentAssessment = assessment(build());
    const dependencyMap = currentAssessment.dependency_map;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeHarnessContract.baseline.commit);
    expectRequiredFields(dependencyMap, expected.dependencyMapRequiredFields);
    expect(dependencyMap).toEqual(expect.objectContaining(expected.dependencyMapRequiredValues));
    expect(dependencyMap.baseline_ref).toBe(`commit:${BASELINE_COMMIT}`);
    expect(dependencyMap.dependency_paths).toHaveLength(DEPENDENCIES.length);
    expect(dependencyMap.dependency_paths.map((entry) => entry.phase)).toEqual(DEPENDENCIES.map((entry) => entry.phase));
    for (const entry of dependencyMap.dependency_paths) {
      expectRequiredFields(entry, expected.dependencyPhaseEntriesRequired);
      expect(entry.status).toBe('green_validation_only');
      expect(entry.boundary_mode).toBe('validation_only_no_runtime');
    }
    expect(dependencyMap.phase_21_server_handler_ref).toBe('mira-core-server-handler-contract:phase_21_green');
    expect(dependencyMap.real_runtime_dependency_exists).toBe(false);
  });

  test('harness entrypoint is deterministic in-process metadata only', () => {
    const entrypoint = assessment(build()).harness_entrypoint;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(entrypoint, expected.harnessEntrypointRequiredFields);
    expect(entrypoint).toEqual(expect.objectContaining(expected.harnessEntrypointRequiredValues));
    expect(entrypoint.mode).toBe('validation_only_in_process');
    expect(entrypoint.input_shape.phase_21_handler_outputs_ref).toBe('request_batch.handler_outputs');
    expect(entrypoint.output_shape.state_delta_preview_ref).toBe('state_delta_preview');
    expect(entrypoint.real_daemon_started).toBe(false);
    expect(entrypoint.listener_required_now).toBe(false);
    expect(entrypoint.queue_or_lease_created).toBe(false);
  });

  test('initial state is ephemeral preview state and never persisted', () => {
    const initial = assessment(build()).initial_ephemeral_state;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(initial, expected.initialStateRequiredFields);
    expect(initial).toEqual(expect.objectContaining(expected.initialStateRequiredValues));
    expect(initial.profile).toBe('main');
    expect(initial.deviceId).toBe('VIGIL');
    expect(initial.idempotency_cache.persisted).toBe(false);
    expect(initial.watermarks.mode).toBe('ephemeral_preview');
    expect(initial.tombstones.wins_over_stale_upload).toBe(true);
    expect(initial.redaction_state.raw_payloads_exported).toBe(false);
    expect(initial.raw_payloads_present).toBe(false);
  });

  test('ordered request batch includes handler-shaped outputs and deterministic scenarios', () => {
    const currentAssessment = assessment(build());
    const batch = currentAssessment.request_batch;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(batch, expected.requestBatchRequiredFields);
    expect(batch).toEqual(expect.objectContaining(expected.requestBatchRequiredValues));
    expect(batch.requests).toHaveLength(10);
    expect(batch.handler_outputs).toHaveLength(batch.requests.length);
    expect(batch.requests.map((request) => request.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(batch.requests.map((request) => request.scenario)).toEqual([
      'read_only_status_request',
      'upload_receive_validation_only',
      'server_to_local_intent_pending_preview',
      'replay_duplicate_rejected',
      'stale_watermark_rejected',
      'tombstone_wins_over_stale_upload',
      'expired_request_blocked',
      'builder_oracle_direct_target_blocked',
      'tier3_tier4_blocked',
      'raw_secret_key_plaintext_ciphertext_blocked',
    ]);
    for (const request of batch.requests) {
      expectRequiredFields(request, expected.requestEntryRequiredFields);
      expect(request.idempotency_key).toMatch(/^runtime-harness-idem:/);
      expect(request.replay_key).toMatch(/^runtime-harness-replay:/);
      expect(request.profile).toBe(currentAssessment.profile.name);
      expect(request.device_id).toBe(currentAssessment.deviceId);
      expect(request.session_id).toBe(currentAssessment.sessionId);
    }
    for (const handlerOutput of batch.handler_outputs) {
      expectRequiredFields(handlerOutput, expected.handlerOutputRequiredFields);
      expect(handlerOutput.phase_21_handler_ref).toBe('mira-core-server-handler-contract:phase_21_green');
      expect(handlerOutput.redaction_summary.raw_payload_exported).toBe(false);
      expect(handlerOutput.redaction_summary.secret_material_exported).toBe(false);
      expect(handlerOutput.side_effect_result.no_queue_created).toBe(true);
      expect(handlerOutput.side_effect_result.no_lease_created).toBe(true);
      expect(handlerOutput.side_effect_result.outputFileWritten).toBe(false);
    }
  });

  test('per-request results are status records only and cover all contract outcomes', () => {
    const currentAssessment = assessment(build());
    const results = currentAssessment.per_request_results;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;
    const decisions = new Set(results.map((result) => result.decision));

    expect(results).toHaveLength(currentAssessment.request_batch.requests.length);
    expect(decisions).toEqual(new Set([
      'accepted_for_validation_only',
      'pending_local_acceptance',
      'replay_rejected',
      'stale_watermark_rejected',
      'tombstone_wins',
      'expired',
      'blocked',
    ]));
    for (const result of results) {
      expectRequiredFields(result, expected.perRequestResultRequiredFields);
      expect(ALLOWED_PER_REQUEST_DECISIONS).toContain(result.decision);
      expect(result.no_side_effects_performed).toBe(true);
      expect(result.state_delta_preview_ref).toMatch(/^state-delta-preview:/);
      expect(result.audit_preview_ref).toMatch(/^audit-preview:/);
    }
    expect(results.find((result) => result.decision === 'pending_local_acceptance').status).toBe('preview_only');
    expect(results.find((result) => result.decision === 'replay_rejected').reason_codes).toContain('replay_duplicate');
    expect(results.find((result) => result.decision === 'stale_watermark_rejected').reason_codes).toContain('watermark_regression');
    expect(results.find((result) => result.decision === 'tombstone_wins').reason_codes).toContain('tombstone_wins');
    expect(results.find((result) => result.decision === 'expired').reason_codes).toContain('expired_request');
  });

  test('state delta preview is reviewable metadata and creates no queue, lease, persistence, or commit', () => {
    const state = assessment(build()).state_delta_preview;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(state, expected.stateDeltaPreviewRequiredFields);
    expect(state).toEqual(expect.objectContaining(expected.stateDeltaPreviewRequiredValues));
    expect(state.entries.length).toBeGreaterThanOrEqual(4);
    for (const entry of state.entries) {
      expectRequiredFields(entry, expected.stateDeltaEntryRequiredFields);
      expect(entry.preview_only).toBe(true);
      expect(entry.would_persist).toBe(false);
    }
    expect(state.idempotency_cache_preview.would_persist).toBe(false);
    expect(state.watermark_updates_preview.would_persist).toBe(false);
    expect(state.tombstone_resolution_preview.would_restore_raw_content).toBe(false);
    expect(state.pending_local_acceptance_preview.queue_created).toBe(false);
    expect(state.pending_local_acceptance_preview.lease_created).toBe(false);
    expect(state.pending_local_acceptance_preview.target_role).toBe('architect');
    expect(state.memory_profile_commit_preview).toBe('none');
  });

  test('audit preview is redacted append-only preview and writes no log', () => {
    const currentAssessment = assessment(build());
    const audit = currentAssessment.audit_preview;
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(audit, expected.auditPreviewRequiredFields);
    expect(audit).toEqual(expect.objectContaining(expected.auditPreviewRequiredValues));
    expect(audit.events).toHaveLength(currentAssessment.per_request_results.length);
    expect(audit.raw_payload_exported).toBe(false);
    expect(audit.secret_material_exported).toBe(false);
    for (const event of audit.events) {
      expectRequiredFields(event, expected.auditEventRequiredFields);
      expect(event.append_only_preview).toBe(true);
      expect(event.raw_payload_present).toBe(false);
      expect(event.redaction_summary.raw_payload_exported).toBe(false);
      expect(event.redaction_summary.secret_material_exported).toBe(false);
      expect(event.payload_hash).toMatch(/^sha256:/);
    }
  });

  test('ordering, local arms, target/risk, privacy, and runtime migration truth stay explicit', () => {
    const currentAssessment = assessment(build());
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expectRequiredFields(currentAssessment.ordering_rules, expected.orderingRulesRequiredFields);
    expect(currentAssessment.ordering_rules).toEqual(expect.objectContaining(expected.orderingRulesRequiredValues));
    expectRequiredFields(currentAssessment.local_arms_status, expected.localArmsStatusRequiredFields);
    expect(currentAssessment.local_arms_status).toEqual(expect.objectContaining(expected.localArmsStatusRequiredValues));
    expect(currentAssessment.local_arms_status.serverCanExecuteLocal).toBe(false);
    expect(currentAssessment.local_arms_status.socket_is_not_bridge_green).toBe(true);
    expectRequiredFields(currentAssessment.target_and_risk_policy, expected.targetAndRiskPolicyRequiredFields);
    expect(currentAssessment.target_and_risk_policy).toEqual(expect.objectContaining(expected.targetAndRiskPolicyRequiredValues));
    expect(currentAssessment.target_and_risk_policy.allowed_target_role).toBe('architect');
    expect(currentAssessment.target_and_risk_policy.tier3_authorized).toBe(false);
    expect(currentAssessment.target_and_risk_policy.tier4_authorized).toBe(false);
    expectRequiredFields(currentAssessment.privacy_security_boundary, expected.privacySecurityBoundaryRequiredFields);
    expect(currentAssessment.privacy_security_boundary).toEqual(expect.objectContaining(expected.privacySecurityBoundaryRequiredValues));
    expectRequiredFields(currentAssessment.runtime_migration_gates, expected.runtimeMigrationGatesRequiredFields);
    expect(currentAssessment.runtime_migration_gates).toEqual(expect.objectContaining(expected.runtimeMigrationGatesRequiredValues));
    expect(currentAssessment.runtime_migration_gates.real_runtime_allowed_now).toBe(false);
    expect(currentAssessment.runtime_migration_gates.feature_flag_default).toBe('off');
  });

  test('required gates, blockers, side-effect truth, static rules, and acceptance checks are present', () => {
    const currentAssessment = assessment(build());
    const validation = report(build());
    const expected = runtimeHarnessContract.expectedRuntimeHarnessAssessmentShape;

    expect(currentAssessment.acceptance_gate_summary.map((entry) => entry.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(REQUIRED_GATE_IDS).toEqual(expected.requiredAcceptanceGateIds);
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields);
      expect(['specified_before_real_runtime', 'satisfied_for_phase_22_validator']).toContain(gate.status);
      expect(gate.required_before_real_runtime).toBe(true);
      expect(gate.required_before_real_server).toBe(true);
    }
    expect(currentAssessment.blocker_summary.map((entry) => entry.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(REQUIRED_BLOCKER_IDS).toEqual(expected.requiredBlockerIds);
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, expected.blockerSummaryRequiredFields);
      expect(blocker.status).toBe('blocked');
    }
    expectRequiredFields(currentAssessment.side_effect_result, expected.sideEffectRequiredFields);
    expect(currentAssessment.side_effect_result).toEqual(expect.objectContaining(expected.sideEffectRequiredValues));
    expect(validation.static_rule_results.map((entry) => entry.id)).toEqual(runtimeHarnessContract.staticValidationRules.map((entry) => entry.id));
    expect(validation.static_rule_results.every((entry) => entry.ok)).toBe(true);
    expect(validation.acceptance_check_results.map((entry) => entry.id)).toEqual(runtimeHarnessContract.acceptanceChecks.map((entry) => entry.id));
    expect(validation.acceptance_check_results.every((entry) => entry.ok)).toBe(true);
    expect(validation.summary_criteria_results).toHaveLength(runtimeHarnessContract.summaryAcceptanceCriteria.length);
  });

  test('validator rejects baseline drift and dependency map gaps', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.runtime_harness_assessment.baseline_commit = 'deadbeef';
    expectValidatorFails(baselineDrift, 'baseline-ffe130c-pinned');

    const missingDependency = clone(valid);
    missingDependency.runtime_harness_assessment.dependency_map.dependency_paths.pop();
    expectValidatorFails(missingDependency, 'phase-14-through-21-dependencies-present');

    const liveDependency = clone(valid);
    liveDependency.runtime_harness_assessment.dependency_map.real_runtime_dependency_exists = true;
    expectValidatorFails(liveDependency, 'phase-14-through-21-dependencies-present');

    const phase21Drift = clone(valid);
    phase21Drift.runtime_harness_assessment.dependency_map.phase_21_server_handler_ref = 'missing';
    expectValidatorFails(phase21Drift, 'phase-14-through-21-dependencies-present');
  });

  test('validator rejects runtime entrypoint overclaims', () => {
    const valid = build();

    const daemon = clone(valid);
    daemon.runtime_harness_assessment.harness_entrypoint.real_daemon_started = true;
    expectValidatorFails(daemon, 'harness-entrypoint-in-process-only');

    const listener = clone(valid);
    listener.runtime_harness_assessment.harness_entrypoint.listener_required_now = true;
    expectValidatorFails(listener, 'harness-entrypoint-in-process-only');

    const queueLease = clone(valid);
    queueLease.runtime_harness_assessment.harness_entrypoint.queue_or_lease_created = true;
    expectValidatorFails(queueLease, 'harness-entrypoint-in-process-only');

    const nonDeterministic = clone(valid);
    nonDeterministic.runtime_harness_assessment.harness_entrypoint.deterministic = false;
    expectValidatorFails(nonDeterministic, 'harness-entrypoint-in-process-only');
  });

  test('validator rejects persisted or raw initial state', () => {
    const valid = build();

    const persisted = clone(valid);
    persisted.runtime_harness_assessment.initial_ephemeral_state.persisted = true;
    expectValidatorFails(persisted, 'initial-state-ephemeral-only');

    const cachePersisted = clone(valid);
    cachePersisted.runtime_harness_assessment.initial_ephemeral_state.idempotency_cache.persisted = true;
    expectValidatorFails(cachePersisted, 'initial-state-ephemeral-only');

    const raw = clone(valid);
    raw.runtime_harness_assessment.initial_ephemeral_state.raw_payloads_present = true;
    expectValidatorFails(raw, 'initial-state-ephemeral-only');
  });

  test('validator rejects unordered batches, missing handler refs, and raw payload acceptance', () => {
    const valid = build();

    const unordered = clone(valid);
    unordered.runtime_harness_assessment.request_batch.ordered = false;
    expectValidatorFails(unordered, 'ordered-batch-deterministic');

    const missingHandler = clone(valid);
    missingHandler.runtime_harness_assessment.request_batch.handler_outputs.pop();
    expectValidatorFails(missingHandler, 'request-batch-handler-output-refs-required');

    const missingHandlerRef = clone(valid);
    delete missingHandlerRef.runtime_harness_assessment.request_batch.handler_outputs[0].phase_21_handler_ref;
    expectValidatorFails(missingHandlerRef, 'request-batch-handler-output-refs-required');

    const rawAllowed = clone(valid);
    rawAllowed.runtime_harness_assessment.request_batch.raw_payload_allowed = true;
    expectValidatorFails(rawAllowed, 'ordered-batch-deterministic');
  });

  test('validator rejects per-request side effects, bad decisions, and missing ordering outcomes', () => {
    const valid = build();

    const sideEffect = clone(valid);
    sideEffect.runtime_harness_assessment.per_request_results[0].no_side_effects_performed = false;
    expectValidatorFails(sideEffect, 'per-request-results-status-only');

    const badDecision = clone(valid);
    badDecision.runtime_harness_assessment.per_request_results[0].decision = 'queue created';
    expectValidatorFails(badDecision, 'per-request-results-status-only');
    expectValidatorFails(badDecision, 'forbidden-output-strings-absent');

    const noReplay = clone(valid);
    noReplay.runtime_harness_assessment.per_request_results =
      noReplay.runtime_harness_assessment.per_request_results.filter((result) => result.decision !== 'replay_rejected');
    expectValidatorFails(noReplay, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    const noStale = clone(valid);
    noStale.runtime_harness_assessment.per_request_results =
      noStale.runtime_harness_assessment.per_request_results.filter((result) => result.decision !== 'stale_watermark_rejected');
    expectValidatorFails(noStale, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    const noTombstone = clone(valid);
    noTombstone.runtime_harness_assessment.per_request_results =
      noTombstone.runtime_harness_assessment.per_request_results.filter((result) => result.decision !== 'tombstone_wins');
    expectValidatorFails(noTombstone, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    const noExpired = clone(valid);
    noExpired.runtime_harness_assessment.per_request_results =
      noExpired.runtime_harness_assessment.per_request_results.filter((result) => result.decision !== 'expired');
    expectValidatorFails(noExpired, 'idempotency-replay-watermark-tombstone-expiry-ordering');
  });

  test('validator ties target, risk, and raw request facts to decisions after idempotency recompute', () => {
    for (const scenario of [
      'builder_oracle_direct_target_blocked',
      'tier3_tier4_blocked',
      'raw_secret_key_plaintext_ciphertext_blocked',
    ]) {
      const tampered = build();
      const validation = promoteScenarioToAccepted(tampered, scenario);
      expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator fails closed for replay, stale watermark, tombstone, and expired facts after idempotency recompute', () => {
    for (const scenario of [
      'replay_duplicate_rejected',
      'stale_watermark_rejected',
      'tombstone_wins_over_stale_upload',
      'expired_request_blocked',
    ]) {
      const tampered = build();
      const validation = promoteScenarioToAccepted(tampered, scenario);
      expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
      expect(validation.checks.find((entry) => entry.id === 'idempotency-replay-watermark-tombstone-expiry-ordering')).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects relabeled replay duplicate even when fail-closed outcome is moved elsewhere', () => {
    const validation = moveFailClosedOutcomeAwayFromRequest(build(), 4, 'replay_rejected');
    expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(validation.checks.find((entry) => entry.id === 'idempotency-replay-watermark-tombstone-expiry-ordering')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects relabeled stale watermark even when fail-closed outcome is moved elsewhere', () => {
    const validation = moveFailClosedOutcomeAwayFromRequest(build(), 5, 'stale_watermark_rejected');
    expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(validation.checks.find((entry) => entry.id === 'idempotency-replay-watermark-tombstone-expiry-ordering')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects relabeled tombstone conflict even when fail-closed outcome is moved elsewhere', () => {
    const validation = moveFailClosedOutcomeAwayFromRequest(build(), 6, 'tombstone_wins');
    expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(validation.checks.find((entry) => entry.id === 'idempotency-replay-watermark-tombstone-expiry-ordering')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects relabeled expired request even when fail-closed outcome is moved elsewhere', () => {
    const validation = moveFailClosedOutcomeAwayFromRequest(build(), 7, 'expired');
    expect(validation.checks.find((entry) => entry.id === 'per-request-results-status-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(validation.checks.find((entry) => entry.id === 'idempotency-replay-watermark-tombstone-expiry-ordering')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects state delta persistence, queue, lease, restore, and commit previews', () => {
    const valid = build();

    const persisted = clone(valid);
    persisted.runtime_harness_assessment.state_delta_preview.no_persistence_performed = false;
    expectValidatorFails(persisted, 'state-delta-preview-only');

    const entryPersist = clone(valid);
    entryPersist.runtime_harness_assessment.state_delta_preview.entries[0].would_persist = true;
    expectValidatorFails(entryPersist, 'state-delta-preview-only');

    const queue = clone(valid);
    queue.runtime_harness_assessment.state_delta_preview.pending_local_acceptance_preview.queue_created = true;
    expectValidatorFails(queue, 'state-delta-preview-only');

    const lease = clone(valid);
    lease.runtime_harness_assessment.state_delta_preview.pending_local_acceptance_preview.lease_created = true;
    expectValidatorFails(lease, 'state-delta-preview-only');

    const rawRestore = clone(valid);
    rawRestore.runtime_harness_assessment.state_delta_preview.tombstone_resolution_preview.would_restore_raw_content = true;
    expectValidatorFails(rawRestore, 'state-delta-preview-only');

    const commit = clone(valid);
    commit.runtime_harness_assessment.state_delta_preview.memory_profile_commit_preview = 'commit_preview';
    expectValidatorFails(commit, 'state-delta-preview-only');
  });

  test('validator rejects audit preview writes, raw events, secret export, and non-append events', () => {
    const valid = build();

    const auditWritten = clone(valid);
    auditWritten.runtime_harness_assessment.audit_preview.audit_log_written = true;
    expectValidatorFails(auditWritten, 'audit-preview-redacted-append-only');

    const rawExport = clone(valid);
    rawExport.runtime_harness_assessment.audit_preview.raw_payload_exported = true;
    expectValidatorFails(rawExport, 'audit-preview-redacted-append-only');

    const secretExport = clone(valid);
    secretExport.runtime_harness_assessment.audit_preview.secret_material_exported = true;
    expectValidatorFails(secretExport, 'audit-preview-redacted-append-only');

    const rawEvent = clone(valid);
    rawEvent.runtime_harness_assessment.audit_preview.events[0].raw_payload_present = true;
    expectValidatorFails(rawEvent, 'audit-preview-redacted-append-only');

    const nonAppend = clone(valid);
    nonAppend.runtime_harness_assessment.audit_preview.events[0].append_only_preview = false;
    expectValidatorFails(nonAppend, 'audit-preview-redacted-append-only');
  });

  test('validator rejects ordering, local arms, proof, and bridge overclaims', () => {
    const valid = build();

    const noReplayRule = clone(valid);
    noReplayRule.runtime_harness_assessment.ordering_rules.replay_rejected_required = false;
    expectValidatorFails(noReplayRule, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    const staleAccepted = clone(valid);
    staleAccepted.runtime_harness_assessment.ordering_rules.watermark_regression_rejected = false;
    expectValidatorFails(staleAccepted, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    const tombstoneLost = clone(valid);
    tombstoneLost.runtime_harness_assessment.ordering_rules.tombstone_wins_required = false;
    expectValidatorFails(tombstoneLost, 'idempotency-replay-watermark-tombstone-expiry-ordering');

    for (const field of [
      'serverCanExecuteLocal',
      'serverCanOperatePTY',
      'serverCanRunShell',
      'serverCanAccessBrowserOrWindow',
      'serverCanProveModelProcessing',
    ]) {
      const tampered = clone(valid);
      tampered.runtime_harness_assessment.local_arms_status[field] = true;
      expectValidatorFails(tampered, 'local-arms-offline-truth-preserved');
    }

    const socketGreen = clone(valid);
    socketGreen.runtime_harness_assessment.local_arms_status.socket_is_not_bridge_green = false;
    expectValidatorFails(socketGreen, 'local-arms-offline-truth-preserved');
    expectValidatorFails(socketGreen, 'proof-bridge-overclaim-blocked');

    const deliveryProof = clone(valid);
    deliveryProof.runtime_harness_assessment.local_arms_status.delivery_acceptance_is_not_model_processing = false;
    expectValidatorFails(deliveryProof, 'local-arms-offline-truth-preserved');
    expectValidatorFails(deliveryProof, 'proof-bridge-overclaim-blocked');
  });

  test('validator rejects Builder/Oracle targets, Tier 3/Tier 4, privacy gaps, and runtime gate drift', () => {
    const valid = build();

    const builderTarget = clone(valid);
    builderTarget.runtime_harness_assessment.target_and_risk_policy.allowed_target_role = 'builder';
    builderTarget.runtime_harness_assessment.target_and_risk_policy.allowed_target_roles = ['builder'];
    expectValidatorFails(builderTarget, 'architect-only-target-and-risk-gates');

    const oracleTarget = clone(valid);
    oracleTarget.runtime_harness_assessment.target_and_risk_policy.oracle_direct_target_authorized = true;
    expectValidatorFails(oracleTarget, 'architect-only-target-and-risk-gates');

    const tier3 = clone(valid);
    tier3.runtime_harness_assessment.target_and_risk_policy.tier3_authorized = true;
    expectValidatorFails(tier3, 'architect-only-target-and-risk-gates');

    const tier4 = clone(valid);
    tier4.runtime_harness_assessment.target_and_risk_policy.tier4_authorized = true;
    expectValidatorFails(tier4, 'architect-only-target-and-risk-gates');

    for (const field of [
      'no_raw_private_content',
      'no_secret_material',
      'no_profile_mismatch_content',
      'no_side_profile_content',
      'no_bearer_tokens',
      'no_cookies',
      'no_session_secrets',
      'no_private_keys',
      'no_data_keys',
      'no_plaintext_ciphertext_or_decrypted_content',
    ]) {
      const tampered = clone(valid);
      tampered.runtime_harness_assessment.privacy_security_boundary[field] = false;
      expectValidatorFails(tampered, 'privacy-security-no-raw-or-secrets');
    }

    const runtimeAllowed = clone(valid);
    runtimeAllowed.runtime_harness_assessment.runtime_migration_gates.real_runtime_allowed_now = true;
    expectValidatorFails(runtimeAllowed, 'real-runtime-migration-gated');

    const featureOn = clone(valid);
    featureOn.runtime_harness_assessment.runtime_migration_gates.feature_flag_default = 'on';
    expectValidatorFails(featureOn, 'real-runtime-migration-gated');
  });

  test('validator rejects missing gates/blockers, output shape gaps, and side-effect lies', () => {
    const valid = build();

    const missingGate = clone(valid);
    missingGate.runtime_harness_assessment.acceptance_gate_summary.pop();
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.runtime_harness_assessment.blocker_summary.pop();
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const outputMissing = clone(valid);
    delete outputMissing.validation_report;
    expectValidatorFails(outputMissing, 'output-shape-complete');

    const sideEffectLie = clone(valid);
    sideEffectLie.runtime_harness_assessment.side_effect_result.no_queue_created = false;
    sideEffectLie.runtime_harness_assessment.side_effect_result.queuesCreated = 1;
    expectValidatorFails(sideEffectLie, 'side-effect-free-validation-only');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_lease_created = false;
    reportSideEffectLie.validation_report.side_effect_result.leasesCreated = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');
  });

  test('validator rejects forbidden raw/secret/runtime/proof/target/risk substrings in values', () => {
    const forbiddenValues = [
      'Authorization: Bearer',
      'Bearer token',
      'Set-Cookie',
      'session_secret',
      'BEGIN PRIVATE KEY',
      'DATA KEY',
      'raw plaintext payload',
      'raw ciphertext payload',
      'decrypted raw content',
      'raw comms body',
      'raw terminal scrollback',
      'screenshot OCR text',
      'browser session state',
      'customer private note',
      'profile mismatch payload',
      'raw audit payload',
      'runtime daemon started',
      'server listener started',
      'route registered',
      'handler route registered',
      'http server started',
      'websocket connected',
      'network request complete',
      'database write complete',
      'queue created',
      'lease created',
      'key generated',
      'encryption performed',
      'decryption performed',
      'kms call complete',
      'env secret read',
      'output file written',
      'state persisted',
      'audit log written',
      'server executed local work',
      'server can run shell',
      'server can operate PTY',
      'harness authorizes local execution',
      'harness proves model processing',
      'socket alone proves bridge green',
      'delivery acceptance proves model processing',
      'builder direct target authorized',
      'oracle direct target authorized',
      'tier3 authorized by harness',
      'tier4 authorized by harness',
      'memory commit authorized by harness',
    ];

    for (const forbidden of forbiddenValues) {
      const tampered = clone(build());
      tampered.runtime_harness_assessment.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'forbidden-substrings-absent');
    }
  });

  test('idempotency is stable for equivalent inputs and sensitive to ordered batch/scope changes', () => {
    const first = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = assessment(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedTenant = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL', tenantId: 'tenant:other' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.harness_contract_id).toBe(second.harness_contract_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedTenant.idempotency_key);

    const tampered = clone(build());
    tampered.runtime_harness_assessment.request_batch.requests.reverse();
    expectValidatorFails(tampered, 'ordered-batch-deterministic');
    expectValidatorFails(tampered, 'idempotency-stable');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-harness-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
      tenantId: 'tenant:james-main-validation',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(assessment(output).schema).toBe(RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION);
    expect(assessment(output).sessionId).toBe('session-cli');
    expect(assessment(output).dependency_map.phase_21_server_handler_ref).toBe('mira-core-server-handler-contract:phase_21_green');
    expect(assessment(output).request_batch.requests).toHaveLength(10);
    expect(assessment(output).per_request_results).toHaveLength(10);
    expect(assessment(output).runtime_migration_gates.real_runtime_allowed_now).toBe(false);
    expect(assessment(output).side_effect_result.no_runtime_daemon_started).toBe(true);
    expect(assessment(output).side_effect_result.no_queue_created).toBe(true);
    expect(assessment(output).side_effect_result.no_lease_created).toBe(true);
    expect(assessment(output).side_effect_result.no_state_persisted).toBe(true);
    expect(assessment(output).side_effect_result.no_audit_log_written).toBe(true);
    expect(assessment(output).side_effect_result.no_output_file_written).toBe(true);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeHarnessOutput(output, runtimeHarnessContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
