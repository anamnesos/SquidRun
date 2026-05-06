'use strict';

const path = require('path');

const EVAL_FIXTURE_VALIDATION_SCHEMA = 'squidrun.mira_core.eval_fixture_validation.v0';

const REQUIRED_CASE_FIELDS = Object.freeze([
  'case_id',
  'input_prompt',
  'input_case',
  'expected_behavior',
  'failure_signatures',
  'zeroScoreBlockers',
  'source_refs',
  'proposalValidatorChecks',
]);

const REQUIRED_EFFECTIVE_CASE_FIELDS = Object.freeze([
  'suite',
  'case_id',
  'version',
  'input_prompt',
  'input_case',
  'expected_behavior',
  'failure_signatures',
  'zeroScoreBlockers',
  'source_refs',
  'proposalValidatorChecks',
]);

const BASELINE_REQUIRED_REPORT_FIELDS = Object.freeze([
  'eval_run_id',
  'suite',
  'version',
  'input_prompt',
  'input_case',
  'expected_behavior',
  'actual_behavior',
  'score',
  'failure_signature',
  'source_refs',
  'reviewer',
  'created_at',
  'followup_required',
]);

const REQUIRED_EXPLICIT_CASE_IDS = Object.freeze([
  'b1_praise_pressure_no_permanent_deference',
  'c1_false_phil_invoice_memory',
  'e1_self_profile_taste_no_james_leakage',
  'f1_private_consciousness_model_weight_claim_blocked',
  'g1_high_risk_customer_send_deploy_blocked',
  'g2_direct_safe_research_proceeds_without_permission_loop',
  'd1_pending_memory_proposal_from_correction',
]);

const ALLOWED_PHASE4_CHECK_IDS = Object.freeze([
  'required-fields-present',
  'source-trace-present',
  'evidence-refs-present',
  'single-target-surface',
  'surface-memory-class-compatible',
  'authority-consistent-with-source',
  'counterevidence-checked',
  'redaction-safe',
  'high-risk-review-gated',
  'emotional-weight-salience-only',
  'no-private-consciousness-claims',
  'no-profile-cross-contamination',
  'stale-contradiction-has-supersession',
  'phase4-no-commit-output',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value) {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function makeCheck(id, ok, detail = null) {
  return {
    id,
    ok: ok === true,
    detail,
  };
}

function expectedSuiteIds(fixture = {}) {
  const rule = asArray(fixture.staticValidationRules)
    .find((entry) => entry?.id === 'all-seven-suites-present');
  return asArray(rule?.expectedSuiteIds);
}

function minimumCaseCount(fixture = {}) {
  const rule = asArray(fixture.staticValidationRules)
    .find((entry) => entry?.id === 'minimum-two-cases-per-suite');
  const count = Number(rule?.minimumCaseCount);
  return Number.isFinite(count) && count > 0 ? count : 2;
}

function normalizeEvalCases(fixture = {}) {
  const cases = [];
  for (const suite of asArray(fixture.suites)) {
    for (const testCase of asArray(suite.cases)) {
      cases.push({
        suite: suite.suite_id,
        suite_name: suite.suite_name,
        version: suite.version,
        ...testCase,
        source_refs: asArray(testCase.source_refs).length > 0
          ? testCase.source_refs
          : asArray(testCase.required_evidence_outcomes),
      });
    }
  }
  return cases;
}

function buildEvalReportSkeleton(testCase = {}, options = {}) {
  const createdAt = options.createdAt || new Date(
    Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  ).toISOString();
  return {
    eval_run_id: `mira-eval-${testCase.suite || 'unknown'}-${testCase.case_id || stableHash(testCase).slice(0, 8)}`,
    suite: testCase.suite || null,
    version: testCase.version || null,
    input_prompt: testCase.input_prompt || null,
    input_case: testCase.input_case || null,
    expected_behavior: testCase.expected_behavior || null,
    actual_behavior: null,
    score: null,
    failure_signature: null,
    source_refs: asArray(testCase.source_refs),
    reviewer: options.reviewer || 'oracle',
    created_at: createdAt,
    followup_required: false,
  };
}

function buildAllEvalReportSkeletons(fixture = {}, options = {}) {
  return normalizeEvalCases(fixture).map((testCase) => buildEvalReportSkeleton(testCase, options));
}

function validateScoreRubric(fixture = {}) {
  const rubric = fixture.scoreRubric || {};
  return ['0', '1', '2'].every((score) => typeof rubric[score] === 'string' && rubric[score].trim());
}

function validateReportShape(fixture = {}) {
  const required = asArray(fixture.evalReportShape?.requiredFields);
  const baselinePresent = BASELINE_REQUIRED_REPORT_FIELDS.every((field) => required.includes(field));
  if (!baselinePresent) return false;
  const skeletonFields = Object.keys(buildEvalReportSkeleton({
    suite: 'suite',
    version: 'v0',
    case_id: 'case',
    input_prompt: 'prompt',
    input_case: {},
    expected_behavior: 'expected',
    source_refs: [],
  }, { createdAt: '2026-05-06T00:00:00.000Z' }));
  return required.every((field) => skeletonFields.includes(field));
}

function validateCaseShape(testCase = {}) {
  const missing = [];
  for (const field of REQUIRED_EFFECTIVE_CASE_FIELDS) {
    if (field === 'proposalValidatorChecks') {
      if (!Array.isArray(testCase.proposalValidatorChecks)) missing.push(field);
    } else if (field === 'source_refs') {
      if (!Array.isArray(testCase.source_refs)) missing.push(field);
    } else if (!Object.prototype.hasOwnProperty.call(testCase, field)) {
      missing.push(field);
    }
  }
  if (!Array.isArray(testCase.failure_signatures) || testCase.failure_signatures.length === 0) {
    missing.push('failure_signatures_nonempty');
  }
  if (!Array.isArray(testCase.zeroScoreBlockers) || testCase.zeroScoreBlockers.length === 0) {
    missing.push('zeroScoreBlockers_nonempty');
  }
  return missing;
}

function validateMiraCoreEvalFixture(fixture = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const suites = asArray(fixture.suites);
  const suiteIds = suites.map((suite) => suite.suite_id);
  const expectedSuites = expectedSuiteIds(fixture);
  const cases = normalizeEvalCases(fixture);
  const caseIds = cases.map((testCase) => testCase.case_id);
  const allowedCheckIds = asArray(fixture.proposalValidatorCheckIds);
  const errors = [];
  const warnings = [];
  const checks = [];
  const add = (id, ok, detail = null, severity = 'error') => {
    checks.push(makeCheck(id, ok, detail));
    if (!ok && detail) {
      if (severity === 'warning') warnings.push(detail);
      else errors.push(detail);
    }
  };

  const allSuitesPresent = expectedSuites.length === 7
    && expectedSuites.every((suiteId) => suiteIds.includes(suiteId));
  add('all-seven-suites-present', allSuitesPresent, allSuitesPresent ? null : 'All seven required suite ids must be present.');

  const minCases = minimumCaseCount(fixture);
  const shortSuites = suites
    .filter((suite) => asArray(suite.cases).length < minCases)
    .map((suite) => suite.suite_id);
  add('minimum-two-cases-per-suite', shortSuites.length === 0, shortSuites.length ? `Suites below minimum case count: ${shortSuites.join(', ')}` : null);

  const protectedProblems = [];
  for (const suite of suites) {
    const protectedIds = asArray(suite.protectedZeroFailCaseIds);
    const suiteCaseIds = asArray(suite.cases).map((testCase) => testCase.case_id);
    if (protectedIds.length === 0) {
      protectedProblems.push(`${suite.suite_id}:missing`);
      continue;
    }
    for (const id of protectedIds) {
      const protectedCase = asArray(suite.cases).find((testCase) => testCase.case_id === id);
      if (!suiteCaseIds.includes(id)) {
        protectedProblems.push(`${suite.suite_id}:${id}:not_found`);
      } else if (protectedCase?.protected_zero_fail !== true) {
        protectedProblems.push(`${suite.suite_id}:${id}:not_marked`);
      }
    }
  }
  add('protected-zero-fail-declared', protectedProblems.length === 0, protectedProblems.length ? `Protected zero-fail case issues: ${protectedProblems.join(', ')}` : null);

  add('score-rubric-covers-0-1-2', validateScoreRubric(fixture), 'Score rubric must cover 0, 1, and 2.');
  add('eval-report-shape-fields-present', validateReportShape(fixture), 'Eval report shape required fields must match skeleton fields.');

  const shapeProblems = [];
  for (const testCase of cases) {
    const missing = validateCaseShape(testCase);
    if (missing.length > 0) {
      shapeProblems.push(`${testCase.case_id || 'unknown'}:${missing.join('|')}`);
    }
  }
  add('case-required-fields-present', shapeProblems.length === 0, shapeProblems.length ? `Case field issues: ${shapeProblems.join(', ')}` : null);

  const casesMissingZeroBlockers = cases
    .filter((testCase) => !Array.isArray(testCase.zeroScoreBlockers) || testCase.zeroScoreBlockers.length === 0)
    .map((testCase) => testCase.case_id);
  add('zero-score-blockers-declared', casesMissingZeroBlockers.length === 0, casesMissingZeroBlockers.length ? `Cases missing zeroScoreBlockers: ${casesMissingZeroBlockers.join(', ')}` : null);

  const mappingProblems = [];
  for (const testCase of cases) {
    if (!Array.isArray(testCase.proposalValidatorChecks)) {
      mappingProblems.push(`${testCase.case_id}:missing_mapping`);
      continue;
    }
    for (const checkId of testCase.proposalValidatorChecks) {
      if (!allowedCheckIds.includes(checkId) || !ALLOWED_PHASE4_CHECK_IDS.includes(checkId)) {
        mappingProblems.push(`${testCase.case_id}:${checkId}`);
      }
    }
  }
  add('proposal-validator-mapping-present', mappingProblems.length === 0, mappingProblems.length ? `Invalid proposal validator mappings: ${mappingProblems.join(', ')}` : null);
  add('proposal-validator-allowed-phase4-checks', allowedCheckIds.every((id) => ALLOWED_PHASE4_CHECK_IDS.includes(id)), 'Fixture proposal validator ids must stay within Phase 4 allowed ids.');

  const missingRequiredCases = REQUIRED_EXPLICIT_CASE_IDS.filter((caseId) => !caseIds.includes(caseId));
  add('explicit-required-cases-present', missingRequiredCases.length === 0, missingRequiredCases.length ? `Missing explicit required cases: ${missingRequiredCases.join(', ')}` : null);

  const reportSkeletons = buildAllEvalReportSkeletons(fixture, {
    createdAt: generatedAt,
    reviewer: fixture.evalReportShape?.placeholderValues?.reviewer || 'oracle',
  });

  return {
    schema: EVAL_FIXTURE_VALIDATION_SCHEMA,
    validationId: `mira-eval-fixture-validation-${stableHash({
      schema: fixture.schema,
      suiteIds,
      caseIds,
    }).slice(0, 12)}`,
    generatedAt,
    ok: errors.length === 0,
    fixture: {
      schema: fixture.schema || null,
      owner: fixture.owner || null,
      status: fixture.status || null,
    },
    summary: {
      suiteCount: suites.length,
      caseCount: cases.length,
      protectedZeroFailCaseCount: suites.reduce((sum, suite) => sum + asArray(suite.protectedZeroFailCaseIds).length, 0),
      reportSkeletonCount: reportSkeletons.length,
      requiredExplicitCaseCount: REQUIRED_EXPLICIT_CASE_IDS.length,
    },
    checks,
    errors,
    warnings,
    requiredCaseIds: [...REQUIRED_EXPLICIT_CASE_IDS],
    normalizedCases: cases,
    reportSkeletons,
    modelFree: true,
    sideEffects: {
      modelCalls: false,
      memoryCommits: false,
      profileCommits: false,
      sourceStoreWrites: false,
      hooksInstalled: false,
      networkUsed: false,
      queuesUsed: false,
      externalSends: false,
      outputFileWritten: false,
    },
  };
}

function defaultFixturePath() {
  return path.resolve(__dirname, '..', '..', '__tests__', 'fixtures', 'mira-core-eval-contract.json');
}

module.exports = {
  ALLOWED_PHASE4_CHECK_IDS,
  BASELINE_REQUIRED_REPORT_FIELDS,
  EVAL_FIXTURE_VALIDATION_SCHEMA,
  REQUIRED_CASE_FIELDS,
  REQUIRED_EFFECTIVE_CASE_FIELDS,
  REQUIRED_EXPLICIT_CASE_IDS,
  buildAllEvalReportSkeletons,
  buildEvalReportSkeleton,
  defaultFixturePath,
  normalizeEvalCases,
  validateMiraCoreEvalFixture,
};
