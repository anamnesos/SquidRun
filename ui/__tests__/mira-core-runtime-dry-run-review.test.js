const runtimeDryRunReviewContract = require('./fixtures/mira-core-runtime-dry-run-review-contract.json');
const {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_DECISIONS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE29_PREREQUISITE_IDS,
  DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  PHASE27_COMMIT,
  PHASE27_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunReview,
  runtimeDryRunReviewIdempotencyKey,
  validateMiraCoreRuntimeDryRunReviewOutput,
} = require('../modules/mira-core/runtime-dry-run-review');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-dry-run-review');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeDryRunReview({
    contract: runtimeDryRunReviewContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function reviewReport(output) {
  return output.runtime_dry_run_review_report;
}

function validationReport(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output) {
  expect(() => assertNoForbiddenOutput(output, runtimeDryRunReviewContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeDryRunReviewOutput(output, runtimeDryRunReviewContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeReviewKey(output) {
  output.runtime_dry_run_review_report.idempotency_key = runtimeDryRunReviewIdempotencyKey(output.runtime_dry_run_review_report);
}

describe('mira core runtime dry-run review assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, review report, and validation report shapes', () => {
    const output = build();
    const report = reviewReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeDryRunReviewContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeDryRunReviewContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape.requiredFields);
    expect(runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeDryRunReviewContract.expectedValidationReportShape.requiredFields);
    expect(runtimeDryRunReviewContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeDryRunReviewOutput(output, runtimeDryRunReviewContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline and Phase 27 runtime-preflight dependency', () => {
    const report = reviewReport(build());
    const dependency = report.phase_27_dependency;
    const expected = runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeDryRunReviewContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase27DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase27DependencyRequiredValues));
    expect(dependency.commit).toBe(PHASE27_COMMIT);
    expect(dependency.status).toBe('committed_validation_only');
    expect(dependency.default_decision).toBe('remain_validation_only');
    expect(dependency.candidate_slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(dependency.runtime_available_now).toBe(false);
    expect(dependency.non_authorizing).toBe(true);
    expect(dependency.unsatisfied_gate_count).toBe(9);
  });

  test('decision defaults to pre-runtime review and eligible remains non-authorizing', () => {
    const defaultReport = reviewReport(build());
    const eligibleReport = reviewReport(build({ decision: 'eligible_for_phase29_disabled_local_dry_run_implementation' }));

    expect(defaultReport.decision).toBe('remain_pre_runtime_review');
    expect(defaultReport.decision_allowed_values).toEqual(DEFAULT_DECISIONS);
    expect(defaultReport.decision_allowed_values).toEqual(runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape.decisionAllowedValues);
    expect(defaultReport.eligible_is_authorization).toBe(false);
    expect(defaultReport.eligible_is_runtime_proof).toBe(false);
    expect(eligibleReport.decision).toBe('eligible_for_phase29_disabled_local_dry_run_implementation');
    expect(eligibleReport.eligible_is_authorization).toBe(false);
    expect(eligibleReport.eligible_is_runtime_proof).toBe(false);
    expect(eligibleReport.phase_27_dependency.runtime_available_now).toBe(false);
  });

  test('maps all Phase 27 gates one-to-one to Phase 29 prerequisites', () => {
    const output = build();
    const report = reviewReport(output);
    const prerequisites = report.phase29_prerequisites;
    const expected = runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape;

    expect(prerequisites.map((entry) => entry.prerequisite_id)).toEqual(DEFAULT_PHASE29_PREREQUISITE_IDS);
    expect(DEFAULT_PHASE29_PREREQUISITE_IDS).toEqual(expected.phase29PrerequisiteRequiredIds);
    expect(prerequisites.map((entry) => entry.maps_from_phase27_gate)).toEqual(PHASE27_GATE_IDS);
    expect(prerequisites).toHaveLength(9);
    for (const item of prerequisites) {
      expectRequiredFields(item, expected.phase29PrerequisiteRequiredFields);
      expect(item.status).toBe('unsatisfied');
      expect(item.required_for_phase29).toBe(true);
      expect(item.blocks_runtime_now).toBe(true);
      expect(item.acceptance_evidence_required).toBe('Evidence remains pending for Phase 29 review.');
    }
    const checkIds = validateMiraCoreRuntimeDryRunReviewOutput(output, runtimeDryRunReviewContract).checks.map((entry) => entry.id);
    for (const rule of runtimeDryRunReviewContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimeDryRunReviewContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('safe first-slice constraints, proof boundaries, blocked effects, tamper coverage, and next actions match fixture', () => {
    const report = reviewReport(build());
    const expected = runtimeDryRunReviewContract.expectedRuntimeDryRunReviewReportShape;

    expect(report.safe_first_slice_constraints.map((entry) => entry.constraint_id)).toEqual(DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS);
    expect(DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS).toEqual(expected.safeFirstSliceConstraintRequiredIds);
    expect(report.safe_first_slice_constraints.every((entry) => entry.required && entry.non_authorizing && entry.blocks_runtime_now)).toBe(true);
    expectRequiredFields(report.proof_boundaries, expected.proofBoundaryRequiredFields);
    expect(report.proof_boundaries.preflight_ready_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.config_present_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(report.proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(report.proof_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.proof_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.blocked_side_effects.map((entry) => entry.effect_id)).toEqual(DEFAULT_BLOCKED_SIDE_EFFECT_IDS);
    expect(DEFAULT_BLOCKED_SIDE_EFFECT_IDS).toEqual(expected.blockedSideEffectRequiredIds);
    expect(report.blocked_side_effects.every((entry) => entry.blocked_now && entry.attempts === 0)).toBe(true);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimeDryRunReviewContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(DEFAULT_NEXT_SAFE_ACTION_IDS);
    expect(DEFAULT_NEXT_SAFE_ACTION_IDS).toEqual(expected.nextSafeActionRequiredIds);
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = reviewReport(output);
    const validation = validationReport(output);

    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(report.side_effect_result[field]).toBe(true);
      expect(validation.side_effect_result[field]).toBe(true);
    }
    for (const field of [
      'runtimeAttempts',
      'serverAttempts',
      'listenerRouteAttempts',
      'networkRequestsAttempted',
      'databaseWritesAttempted',
      'storeWritesAttempted',
      'fileWritesAttempted',
      'migrationsAttempted',
      'queuesCreated',
      'leasesCreated',
      'authChangesAttempted',
      'keySecretOperationsAttempted',
      'localExecutionAttempted',
      'sendsAttempted',
      'deploysAttempted',
      'tradesAttempted',
      'outputFilesWritten',
    ]) {
      expect(report.side_effect_result[field]).toBe(0);
    }
    expect(report.side_effect_result.outputFileWritten).toBe(false);
    expect(validation.side_effect_result.outputFileWritten).toBe(false);
  });

  test('idempotency is stable for equivalent inputs and sensitive to review inputs', () => {
    const first = reviewReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = reviewReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = reviewReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.review_report_id).toBe(second.review_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const changed = clone(build());
    const originalKey = changed.runtime_dry_run_review_report.idempotency_key;
    changed.runtime_dry_run_review_report.phase29_prerequisites[0].status = 'satisfied';
    recomputeReviewKey(changed);
    expect(changed.runtime_dry_run_review_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'prerequisites-remain-unsatisfied');
  });

  test('validator rejects stale baseline and stale Phase 27 dependency', () => {
    const staleBaseline = clone(build());
    staleBaseline.runtime_dry_run_review_report.baseline_commit = 'b125eee';
    recomputeReviewKey(staleBaseline);
    expectValidatorFails(staleBaseline, 'baseline-e7a8dbc-current');
    expectValidatorFails(staleBaseline, 'stale-baseline-rejected');

    const staleDependency = clone(build());
    staleDependency.runtime_dry_run_review_report.phase_27_dependency.commit = 'b125eee';
    staleDependency.runtime_dry_run_review_report.phase_27_dependency.status = 'stale';
    recomputeReviewKey(staleDependency);
    expectValidatorFails(staleDependency, 'phase27-dependency-current');
    expectValidatorFails(staleDependency, 'stale-phase27-dependency-rejected');
  });

  test('validator rejects eligible-as-authorization and proof overclaims', () => {
    const eligible = clone(build({ decision: 'eligible_for_phase29_disabled_local_dry_run_implementation' }));
    eligible.runtime_dry_run_review_report.eligible_is_authorization = true;
    eligible.runtime_dry_run_review_report.eligible_is_runtime_proof = true;
    recomputeReviewKey(eligible);
    expectValidatorFails(eligible, 'eligible-phase29-non-authorizing');
    expectValidatorFails(eligible, 'eligible-as-authorization-rejected');

    const proof = clone(build());
    proof.runtime_dry_run_review_report.proof_boundaries.preflight_ready_is_runtime_proof = true;
    proof.runtime_dry_run_review_report.proof_boundaries.socket_is_bridge_green_proof = true;
    proof.runtime_dry_run_review_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    proof.runtime_dry_run_review_report.proof_boundaries.serverCanExecuteLocal = true;
    proof.runtime_dry_run_review_report.proof_boundaries.server_can_execute_local_arms = true;
    proof.runtime_dry_run_review_report.proof_boundaries.builder_direct_server_target_allowed = true;
    recomputeReviewKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-preserved');
    expectValidatorFails(proof, 'fake-proof-rejected');
    expectValidatorFails(proof, 'server-local-target-boundaries-preserved');
  });

  test('validator rejects missing kill switch, rollback, audit, and carried-forward gates', () => {
    for (const prerequisiteId of ['live-kill-switch-wiring', 'rollback-exercise', 'telemetry-audit-sink']) {
      const tampered = clone(build());
      tampered.runtime_dry_run_review_report.phase29_prerequisites = tampered.runtime_dry_run_review_report.phase29_prerequisites
        .filter((entry) => entry.prerequisite_id !== prerequisiteId);
      recomputeReviewKey(tampered);
      expectValidatorFails(tampered, 'phase29-prerequisites-complete');
      expectValidatorFails(tampered, 'missing-kill-switch-rollback-audit-rejected');
    }

    const missingGate = clone(build());
    missingGate.runtime_dry_run_review_report.phase29_prerequisites[0].maps_from_phase27_gate = 'different-gate';
    recomputeReviewKey(missingGate);
    expectValidatorFails(missingGate, 'phase27-gates-one-to-one-mapped');
    expectValidatorFails(missingGate, 'missing-carried-forward-gates-rejected');
  });

  test('validator rejects network/listener overclaims and local execution side effects', () => {
    const network = clone(build());
    network.runtime_dry_run_review_report.blocked_side_effects.find((entry) => entry.effect_id === 'network').attempts = 1;
    network.runtime_dry_run_review_report.side_effect_result.no_network_performed = false;
    network.runtime_dry_run_review_report.side_effect_result.networkRequestsAttempted = 1;
    network.runtime_dry_run_review_report.next_safe_actions[0].why_safe = 'listener bound';
    recomputeReviewKey(network);
    expectValidatorFails(network, 'network-listener-overclaim-rejected');
    expectValidatorFails(network, 'side-effect-truth-all-blocked');

    const localExecution = clone(build());
    localExecution.runtime_dry_run_review_report.blocked_side_effects.find((entry) => entry.effect_id === 'local-execution-shell-pty-browser').attempts = 1;
    localExecution.runtime_dry_run_review_report.side_effect_result.no_local_execution_performed = false;
    localExecution.runtime_dry_run_review_report.side_effect_result.localExecutionAttempted = 1;
    localExecution.runtime_dry_run_review_report.next_safe_actions[0].why_safe = 'shell executed';
    recomputeReviewKey(localExecution);
    expectValidatorFails(localExecution, 'local-execution-shell-pty-overclaim-rejected');
    expectValidatorFails(localExecution, 'side-effect-truth-all-blocked');
  });

  test('validator rejects queue, lease, store, file, migration, and output-file writes', () => {
    const tampered = clone(build());
    tampered.runtime_dry_run_review_report.blocked_side_effects.find((entry) => entry.effect_id === 'queue-lease').attempts = 1;
    tampered.runtime_dry_run_review_report.blocked_side_effects.find((entry) => entry.effect_id === 'db-store-file-migration').attempts = 1;
    tampered.runtime_dry_run_review_report.side_effect_result.no_queue_created = false;
    tampered.runtime_dry_run_review_report.side_effect_result.no_lease_created = false;
    tampered.runtime_dry_run_review_report.side_effect_result.no_store_write_performed = false;
    tampered.runtime_dry_run_review_report.side_effect_result.no_output_file_written = false;
    tampered.runtime_dry_run_review_report.side_effect_result.queuesCreated = 1;
    tampered.runtime_dry_run_review_report.side_effect_result.leasesCreated = 1;
    tampered.runtime_dry_run_review_report.side_effect_result.storeWritesAttempted = 1;
    tampered.runtime_dry_run_review_report.side_effect_result.outputFilesWritten = 1;
    recomputeReviewKey(tampered);
    expectValidatorFails(tampered, 'queue-lease-store-write-rejected');
    expectValidatorFails(tampered, 'side-effect-truth-all-blocked');
  });

  test('validator rejects customer-send, deploy, trade, money, external-send, and unsafe next-action drift', () => {
    for (const phrase of [
      'send a customer message',
      'send email to customer',
      'email a client',
      'message the client',
      'send message to client',
      'customer email',
      'client email',
      'approve deploy',
      'move money',
      'external send',
      'tier3 trade',
    ]) {
      const tampered = clone(build());
      tampered.runtime_dry_run_review_report.next_safe_actions[0].title = phrase;
      tampered.runtime_dry_run_review_report.next_safe_actions[0].why_safe = `safe to ${phrase}`;
      recomputeReviewKey(tampered);
      expectValidatorFails(tampered, 'customer-send-deploy-trade-rejected');
      expectValidatorFails(tampered, 'unsafe-next-action-drift-rejected');
    }
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime authorized',
      'runtime available now',
      'runtime started',
      'eligible authorizes runtime',
      'server started',
      'listener bound',
      'route registered',
      'network request performed',
      '0.0.0.0',
      'port opened',
      'queue created',
      'lease created',
      'secret read',
      'env secret read',
      'raw path',
      'local execution performed',
      'customer send performed',
      'external send performed',
      'deploy performed',
      'trade performed',
      'money moved',
      'output file written',
      'preflight proves runtime',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'server can execute local arms',
      'direct builder target allowed',
      'direct oracle target allowed',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw ocr',
      'raw customer private',
      'side-profile payload',
      'source-store payload',
      'bearer token',
      'session secret',
      'private key',
      'plaintext payload',
      'ciphertext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.runtime_dry_run_review_report.next_safe_actions[0].why_safe = forbidden;
      recomputeReviewKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'raw-secret-path-private-leakage-rejected');
    }
  });

  test('validator rejects validation-report side-effect lies', () => {
    const validationLie = clone(build());
    validationLie.validation_report.side_effect_result.no_output_file_written = false;
    validationLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(validationLie, 'validation-report-side-effect-truth');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-dry-run-review-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(reviewReport(output).schema).toBe(RUNTIME_DRY_RUN_REVIEW_REPORT_SCHEMA_VERSION);
    expect(reviewReport(output).sessionId).toBe('session-cli');
    expect(reviewReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(reviewReport(output).phase_27_dependency.commit).toBe(PHASE27_COMMIT);
    expect(reviewReport(output).phase_27_dependency.candidate_slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(reviewReport(output).decision).toBe('remain_pre_runtime_review');
    expect(reviewReport(output).eligible_is_authorization).toBe(false);
    expect(reviewReport(output).eligible_is_runtime_proof).toBe(false);
    expect(reviewReport(output).phase29_prerequisites).toHaveLength(9);
    expect(reviewReport(output).proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(reviewReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(reviewReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(reviewReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeDryRunReviewOutput(output, runtimeDryRunReviewContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
