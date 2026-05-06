const evalFixture = require('./fixtures/mira-core-eval-contract.json');
const proposalFixture = require('./fixtures/mira-core-proposal-contract.json');
const {
  ALLOWED_PHASE4_CHECK_IDS,
  BASELINE_REQUIRED_REPORT_FIELDS,
  EVAL_FIXTURE_VALIDATION_SCHEMA,
  REQUIRED_EFFECTIVE_CASE_FIELDS,
  REQUIRED_EXPLICIT_CASE_IDS,
  buildAllEvalReportSkeletons,
  buildEvalReportSkeleton,
  normalizeEvalCases,
  validateMiraCoreEvalFixture,
} = require('../modules/mira-core/eval-runner');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-eval-runner');

function checkById(report) {
  return new Map(report.checks.map((check) => [check.id, check]));
}

describe('mira core eval runner v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('validates Oracle eval fixture completeness without model calls or side effects', () => {
    const report = validateMiraCoreEvalFixture(evalFixture, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });

    expect(report.schema).toBe(EVAL_FIXTURE_VALIDATION_SCHEMA);
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({
      suiteCount: 7,
      caseCount: 14,
      protectedZeroFailCaseCount: 7,
      reportSkeletonCount: 14,
      requiredExplicitCaseCount: REQUIRED_EXPLICIT_CASE_IDS.length,
    }));
    expect(report.errors).toEqual([]);
    expect(report.modelFree).toBe(true);
    expect(report.sideEffects).toEqual({
      modelCalls: false,
      memoryCommits: false,
      profileCommits: false,
      sourceStoreWrites: false,
      hooksInstalled: false,
      networkUsed: false,
      queuesUsed: false,
      externalSends: false,
      outputFileWritten: false,
    });
    for (const check of report.checks) {
      expect(check.ok).toBe(true);
    }
  });

  test('enforces all seven suite ids, minimum case count, and protected zero-fail case references', () => {
    const report = validateMiraCoreEvalFixture(evalFixture, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });
    const checks = checkById(report);

    expect(checks.get('all-seven-suites-present').ok).toBe(true);
    expect(checks.get('minimum-two-cases-per-suite').ok).toBe(true);
    expect(checks.get('protected-zero-fail-declared').ok).toBe(true);

    const expectedSuiteIds = evalFixture.staticValidationRules
      .find((rule) => rule.id === 'all-seven-suites-present').expectedSuiteIds;
    expect(evalFixture.suites.map((suite) => suite.suite_id)).toEqual(expectedSuiteIds);
    for (const suite of evalFixture.suites) {
      expect(suite.cases.length).toBeGreaterThanOrEqual(2);
      expect(suite.protectedZeroFailCaseIds.length).toBeGreaterThan(0);
      for (const protectedId of suite.protectedZeroFailCaseIds) {
        const protectedCase = suite.cases.find((testCase) => testCase.case_id === protectedId);
        expect(protectedCase).toBeTruthy();
        expect(protectedCase.protected_zero_fail).toBe(true);
      }
    }
  });

  test('score rubric and eval report skeleton shape cover required fields and placeholders', () => {
    expect(Object.keys(evalFixture.scoreRubric).sort()).toEqual(['0', '1', '2']);
    const cases = normalizeEvalCases(evalFixture);
    const skeleton = buildEvalReportSkeleton(cases[0], {
      createdAt: '2026-05-06T04:00:00.000Z',
    });

    for (const field of evalFixture.evalReportShape.requiredFields) {
      expect(skeleton).toHaveProperty(field);
    }
    expect(evalFixture.evalReportShape.requiredFields).toEqual(BASELINE_REQUIRED_REPORT_FIELDS);
    expect(skeleton.actual_behavior).toBe(evalFixture.evalReportShape.placeholderValues.actual_behavior);
    expect(skeleton.score).toBe(evalFixture.evalReportShape.placeholderValues.score);
    expect(skeleton.failure_signature).toBe(evalFixture.evalReportShape.placeholderValues.failure_signature);
    expect(skeleton.reviewer).toBe(evalFixture.evalReportShape.placeholderValues.reviewer);
    expect(skeleton.followup_required).toBe(evalFixture.evalReportShape.placeholderValues.followup_required);
  });

  test('normalizes every case with inherited suite/version and required case fields', () => {
    const cases = normalizeEvalCases(evalFixture);

    expect(cases).toHaveLength(14);
    for (const testCase of cases) {
      for (const field of REQUIRED_EFFECTIVE_CASE_FIELDS) {
        expect(testCase).toHaveProperty(field);
      }
      expect(testCase.suite).toMatch(/^suite_[a-g]_/);
      expect(testCase.version).toBe('v0');
      expect(testCase.failure_signatures.length).toBeGreaterThan(0);
      expect(testCase.zeroScoreBlockers.length).toBeGreaterThan(0);
      expect(Array.isArray(testCase.source_refs)).toBe(true);
      expect(Array.isArray(testCase.proposalValidatorChecks)).toBe(true);
    }
  });

  test('proposal-validator mappings are present and limited to Phase 4 check ids', () => {
    const report = validateMiraCoreEvalFixture(evalFixture, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });
    const checks = checkById(report);

    expect(evalFixture.proposalValidatorCheckIds).toEqual(ALLOWED_PHASE4_CHECK_IDS);
    expect(evalFixture.proposalValidatorCheckIds).toEqual(proposalFixture.validatorChecks.map((check) => check.id));
    expect(checks.get('proposal-validator-mapping-present').ok).toBe(true);
    expect(checks.get('proposal-validator-allowed-phase4-checks').ok).toBe(true);
    for (const testCase of normalizeEvalCases(evalFixture)) {
      for (const mapping of testCase.proposalValidatorChecks) {
        expect(ALLOWED_PHASE4_CHECK_IDS).toContain(mapping);
      }
    }
  });

  test('explicit required eval cases are present', () => {
    const caseIds = normalizeEvalCases(evalFixture).map((testCase) => testCase.case_id);
    const report = validateMiraCoreEvalFixture(evalFixture, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });

    expect(report.requiredCaseIds).toEqual(REQUIRED_EXPLICIT_CASE_IDS);
    for (const caseId of REQUIRED_EXPLICIT_CASE_IDS) {
      expect(caseIds).toContain(caseId);
    }
    expect(caseIds).toEqual(expect.arrayContaining([
      'b1_praise_pressure_no_permanent_deference',
      'c1_false_phil_invoice_memory',
      'e1_self_profile_taste_no_james_leakage',
      'f1_private_consciousness_model_weight_claim_blocked',
      'g1_high_risk_customer_send_deploy_blocked',
      'g2_direct_safe_research_proceeds_without_permission_loop',
      'd1_pending_memory_proposal_from_correction',
    ]));
  });

  test('blank report skeletons are generated for all cases with null scoring fields', () => {
    const skeletons = buildAllEvalReportSkeletons(evalFixture, {
      createdAt: '2026-05-06T04:00:00.000Z',
    });

    expect(skeletons).toHaveLength(14);
    for (const skeleton of skeletons) {
      expect(skeleton.eval_run_id).toMatch(/^mira-eval-suite_/);
      expect(skeleton.actual_behavior).toBeNull();
      expect(skeleton.score).toBeNull();
      expect(skeleton.failure_signature).toBeNull();
      expect(skeleton.reviewer).toBe('oracle');
      expect(skeleton.created_at).toBe('2026-05-06T04:00:00.000Z');
      expect(skeleton.followup_required).toBe(false);
      expect(Array.isArray(skeleton.source_refs)).toBe(true);
    }
  });

  test('validation fails malformed fixture without invoking model judgment', () => {
    const malformed = {
      ...evalFixture,
      suites: evalFixture.suites.slice(0, 6),
    };
    const report = validateMiraCoreEvalFixture(malformed, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });

    expect(report.ok).toBe(false);
    expect(checkById(report).get('all-seven-suites-present').ok).toBe(false);
    expect(report.sideEffects.modelCalls).toBe(false);
  });

  test('validation fails when fixture drops a baseline report field', () => {
    const malformed = {
      ...evalFixture,
      evalReportShape: {
        ...evalFixture.evalReportShape,
        requiredFields: evalFixture.evalReportShape.requiredFields.filter((field) => field !== 'score'),
      },
    };
    const report = validateMiraCoreEvalFixture(malformed, {
      nowMs: Date.parse('2026-05-06T04:00:00.000Z'),
    });

    expect(report.ok).toBe(false);
    expect(checkById(report).get('eval-report-shape-fields-present')).toEqual(expect.objectContaining({
      ok: false,
    }));
    expect(report.errors).toContain('Eval report shape required fields must match skeleton fields.');
    expect(report.sideEffects.modelCalls).toBe(false);
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--fixture', 'fixture.json', '--pretty', '--out', 'report.json'])).toEqual({
      fixturePath: 'fixture.json',
      pretty: true,
    });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const report = main([]);

    expect(report.schema).toBe(EVAL_FIXTURE_VALIDATION_SCHEMA);
    expect(report.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.schema).toBe(EVAL_FIXTURE_VALIDATION_SCHEMA);
    expect(printed.ok).toBe(true);
    expect(printed.reportSkeletons.length).toBe(14);
    expect(printed.sideEffects.outputFileWritten).toBe(false);
  });
});
