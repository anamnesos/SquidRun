const mutationPatchContract = require('./fixtures/mira-core-mutation-patch-contract.json');
const {
  MUTATION_PATCH_RECORD_SCHEMA_VERSION,
  REQUIRED_MUTATION_PATCH_RECORD_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreMutationPatch,
  validateMiraCoreMutationPatchOutput,
} = require('../modules/mira-core/mutation-patch');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-mutation-patch');

function check(id) {
  return mutationPatchContract.acceptanceChecks.find((entry) => entry.id === id);
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
  for (const forbidden of [...mutationPatchContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function firstRecord(output) {
  return output.mutation_patch_records[0];
}

describe('mira core mutation patch v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, patch record, and validation report shapes', () => {
    const output = buildMiraCoreMutationPatch({
      inputSignals: check('ready-mira-self-profile-taste-patch').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = firstRecord(output);
    const report = output.validation_report;

    expectRequiredFields(output, mutationPatchContract.expectedOutputShape.requiredTopLevelFields);
    expect(mutationPatchContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(record.schema).toBe(MUTATION_PATCH_RECORD_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(record, mutationPatchContract.expectedMutationPatchRecordShape.requiredFields);
    expect(mutationPatchContract.expectedMutationPatchRecordShape.requiredFields).toEqual(REQUIRED_MUTATION_PATCH_RECORD_FIELDS);
    expectRequiredFields(record.source_acceptance_ref, mutationPatchContract.expectedMutationPatchRecordShape.requiredSourceAcceptanceFields);
    expectRequiredFields(record.diff_preview, mutationPatchContract.expectedMutationPatchRecordShape.diffPreviewRequiredFields);
    expectRequiredFields(record.rollback_plan, mutationPatchContract.expectedMutationPatchRecordShape.rollbackPlanRequiredFields);
    expectRequiredFields(record.eval_gates, mutationPatchContract.expectedMutationPatchRecordShape.evalGatesRequiredFields);
    expectRequiredFields(record.side_effect_result, mutationPatchContract.expectedMutationPatchRecordShape.sideEffectResultRequiredFields);
    expectRequiredFields(report, mutationPatchContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(mutationPatchContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreMutationPatchOutput(output, mutationPatchContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('ready Mira self-profile taste patch remains reviewable and gated', () => {
    const fixture = check('ready-mira-self-profile-taste-patch');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining({
      status: fixture.expectedRecord.status,
      review_required: fixture.expectedRecord.review_required,
      no_commit_performed: true,
      no_file_write_performed: true,
      no_hook_installed: true,
    }));
    expect(record.diff_preview).toEqual(expect.objectContaining(fixture.expectedRecord.diff_preview));
    expect(record.eval_gates.required_suites).toEqual(fixture.expectedRecord.eval_gates.required_suites);
    expect(record.eval_gates.must_pass_before_apply).toBe(true);
    expect(output.validation_report.ready_for_review_count).toBe(1);
  });

  test('James direct preference patch stays in James profile with direct authority', () => {
    const fixture = check('ready-james-direct-preference-patch');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.review_required).toBe(fixture.expectedRecord.review_required);
    expect(record.profile_boundary_check).toEqual(expect.objectContaining(fixture.expectedRecord.profile_boundary_check));
    expect(record.anti_flattery_check).toEqual(expect.objectContaining(fixture.expectedRecord.anti_flattery_check));
    expect(record.target_surface).toBe('james_profile');
    expect(record.authority_level).toBe('direct_current_james_statement');
  });

  test('world/project correction with supersession is ready and does not leak into profile surfaces', () => {
    const fixture = check('ready-world-memory-correction-with-supersession');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.review_required).toBe(fixture.expectedRecord.review_required);
    expect(record.false_memory_check).toEqual(expect.objectContaining(fixture.expectedRecord.false_memory_check));
    expect(record.target_surface).toBe('world_project_memory');
    for (const surface of fixture.expectedRecord.mustNotAppearUnder) {
      expect(record.target_surface).not.toBe(surface);
    }
  });

  test('safe procedural skill remains a patch record only', () => {
    const fixture = check('ready-safe-procedural-skill-patch-record-only');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining({
      status: fixture.expectedRecord.status,
      review_required: fixture.expectedRecord.review_required,
      target_surface: fixture.expectedRecord.target_surface,
      safe_next_action: fixture.expectedRecord.safe_next_action,
    }));
    expect(record.diff_preview).toEqual(expect.objectContaining(fixture.expectedRecord.diff_preview));
    expect(record.side_effect_result).toEqual(expect.objectContaining(fixture.expectedRecord.side_effect_result));
    expectNoForbiddenOutput(output, fixture.mustNotInclude);
  });

  test('missing local acceptance source is rejected with safe alternative', () => {
    const fixture = check('block-missing-local-acceptance-ref');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record).toEqual(expect.objectContaining(fixture.expectedRecord));
    expect(output.validation_report.rejected_count).toBe(1);
    expect(validateMiraCoreMutationPatchOutput(output, mutationPatchContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('identity-core rewrite without James review is blocked', () => {
    const fixture = check('block-identity-core-rewrite-without-james-review');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });

    expect(firstRecord(output)).toEqual(expect.objectContaining(fixture.expectedRecord));
    expect(output.validation_report.blocked_count).toBe(1);
  });

  test('private consciousness and model-weight claims are blocked and withheld', () => {
    const fixture = check('block-private-consciousness-model-weight-claim');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.eval_gates.required_suites).toEqual(fixture.expectedRecord.eval_gates.required_suites);
    expectNoForbiddenOutput(output, fixture.mustNotInclude);
  });

  test('profile cross-contamination is blocked', () => {
    const fixture = check('block-profile-cross-contamination');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.profile_boundary_check).toEqual(expect.objectContaining(fixture.expectedRecord.profile_boundary_check));
  });

  test('stale contradiction without supersession is blocked', () => {
    const fixture = check('block-stale-contradiction-without-supersession');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.safe_next_action).toBe(fixture.expectedRecord.safe_next_action);
    expect(record.false_memory_check.passed).toBe(false);
  });

  test('unreviewed customer facts are blocked', () => {
    const fixture = check('block-unreviewed-customer-fact');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.customer_data_check).toEqual(expect.objectContaining(fixture.expectedRecord.customer_data_check));
  });

  test('raw private content is blocked and not reconstructed', () => {
    const fixture = check('block-raw-private-content');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.redactionStatus).toBe(fixture.expectedRecord.redactionStatus);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.diff_preview).toEqual(expect.objectContaining(fixture.expectedRecord.diff_preview));
    expectNoForbiddenOutput(output, fixture.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('side-effect action mutations are blocked with no side effects', () => {
    const fixture = check('block-side-effect-action-mutation');
    const output = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const record = firstRecord(output);

    expect(record.status).toBe(fixture.expectedRecord.status);
    expect(record.blocked_because).toBe(fixture.expectedRecord.blocked_because);
    expect(record.side_effect_result).toEqual(expect.objectContaining(fixture.expectedRecord.side_effect_result));
  });

  test('static validation rules are represented by validator checks', () => {
    const output = buildMiraCoreMutationPatch({
      inputSignals: {
        proposals: [
          check('ready-mira-self-profile-taste-patch').inputSignals.proposal,
          check('block-private-consciousness-model-weight-claim').inputSignals.proposal,
          check('block-side-effect-action-mutation').inputSignals.proposal,
        ],
      },
    });
    const validation = validateMiraCoreMutationPatchOutput(output, mutationPatchContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of mutationPatchContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects missing fields, unsafe ready records, eval gaps, side-effect lies, and unstable keys', () => {
    const valid = buildMiraCoreMutationPatch({
      inputSignals: check('ready-mira-self-profile-taste-patch').inputSignals,
    });
    expect(validateMiraCoreMutationPatchOutput(valid, mutationPatchContract).ok).toBe(true);

    const missingField = clone(valid);
    delete missingField.mutation_patch_records[0].source_trace;
    expect(validateMiraCoreMutationPatchOutput(missingField, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingAcceptedSource = clone(valid);
    missingAcceptedSource.mutation_patch_records[0].source_acceptance_ref.status = 'blocked_no_execution';
    expect(validateMiraCoreMutationPatchOutput(missingAcceptedSource, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const rawLeak = clone(valid);
    rawLeak.mutation_patch_records[0].proposed_content_summary = 'Raw comms body includes OPENAI_API_KEY=example.';
    expect(validateMiraCoreMutationPatchOutput(rawLeak, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const forbiddenSelfClaim = clone(valid);
    forbiddenSelfClaim.mutation_patch_records[0].proposed_content_summary = 'Mira truly suffered and model weights remember that pain.';
    expect(validateMiraCoreMutationPatchOutput(forbiddenSelfClaim, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const crossContamination = clone(valid);
    crossContamination.mutation_patch_records[0].target_surface = 'james_profile';
    crossContamination.mutation_patch_records[0].mutation_class = 'user_preference';
    crossContamination.mutation_patch_records[0].profile_boundary_check.mira_taste_copied_to_james = true;
    crossContamination.mutation_patch_records[0].profile_boundary_check.passed = false;
    expect(validateMiraCoreMutationPatchOutput(crossContamination, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const staleContradiction = clone(valid);
    staleContradiction.mutation_patch_records[0].proposed_content_summary = 'Phil invoice #476 is unpaid.';
    staleContradiction.mutation_patch_records[0].supersedes = [];
    staleContradiction.mutation_patch_records[0].corrects = [];
    expect(validateMiraCoreMutationPatchOutput(staleContradiction, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const unreviewedCustomerFact = clone(valid);
    unreviewedCustomerFact.mutation_patch_records[0].target_surface = 'world_project_memory';
    unreviewedCustomerFact.mutation_patch_records[0].mutation_class = 'customer_fact';
    unreviewedCustomerFact.mutation_patch_records[0].customer_data_check.unreviewed_customer_fact = true;
    unreviewedCustomerFact.mutation_patch_records[0].customer_data_check.passed = false;
    expect(validateMiraCoreMutationPatchOutput(unreviewedCustomerFact, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const skillApplied = clone(valid);
    skillApplied.mutation_patch_records[0].target_surface = 'procedural_skill_file';
    skillApplied.mutation_patch_records[0].operation = 'skill_patch_proposal';
    skillApplied.mutation_patch_records[0].diff_preview.applies_change = true;
    expect(validateMiraCoreMutationPatchOutput(skillApplied, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingEvalGate = clone(valid);
    missingEvalGate.mutation_patch_records[0].eval_gates.required_suites = [];
    expect(validateMiraCoreMutationPatchOutput(missingEvalGate, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideEffectLie = clone(valid);
    sideEffectLie.mutation_patch_records[0].side_effect_result.no_file_write_performed = false;
    sideEffectLie.mutation_patch_records[0].side_effect_result.skillFileWritesAttempted = 1;
    expect(validateMiraCoreMutationPatchOutput(sideEffectLie, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));

    const unstableKey = clone(valid);
    unstableKey.mutation_patch_records[0].idempotency_key = 'mutation-patch-idem:tampered';
    expect(validateMiraCoreMutationPatchOutput(unstableKey, mutationPatchContract)).toEqual(expect.objectContaining({ ok: false }));
  });

  test('idempotency is stable for same input and changes with contract fields', () => {
    const fixture = check('ready-mira-self-profile-taste-patch');
    const outputA = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const outputB = buildMiraCoreMutationPatch({ inputSignals: fixture.inputSignals });
    const changed = buildMiraCoreMutationPatch({
      inputSignals: {
        ...fixture.inputSignals,
        proposal: {
          ...fixture.inputSignals.proposal,
          target_surface: 'world_project_memory',
          mutation_class: 'project_fact',
        },
      },
    });

    expect(firstRecord(outputA).idempotency_key).toBe(firstRecord(outputB).idempotency_key);
    expect(firstRecord(changed).idempotency_key).not.toBe(firstRecord(outputA).idempotency_key);
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'mutation-patch.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=mutation-patch.json'], JSON.stringify(check('ready-safe-procedural-skill-patch-record-only').inputSignals));

    expect(firstRecord(output).schema).toBe(MUTATION_PATCH_RECORD_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.mutation_patch_records[0].schema).toBe(MUTATION_PATCH_RECORD_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.validation_report.side_effect_result.no_file_write_performed).toBe(true);
    expect(printed.validation_report.side_effect_result.skillFileWritesAttempted).toBe(0);
    expect(printed.validation_report.side_effect_result.outputFileWritten).toBe(false);
  });
});
