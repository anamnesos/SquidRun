const proposalContract = require('./fixtures/mira-core-proposal-contract.json');
const {
  PROPOSAL_VALIDATION_SCHEMA_VERSION,
  REQUIRED_PROPOSAL_FIELDS,
  VALIDATOR_CHECKS,
  validateMiraCoreProposal,
} = require('../modules/mira-core/proposal-validator');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-validate-proposal');

function fixtureCheck(id) {
  return proposalContract.acceptanceChecks.find((check) => check.id === id);
}

function validateFixture(id) {
  const check = fixtureCheck(id);
  return validateMiraCoreProposal(check.proposal, {
    nowMs: Date.parse('2026-05-06T03:30:00.000Z'),
  });
}

function expectReasons(result, expectedReasons = []) {
  for (const reason of expectedReasons) {
    expect(result.reasons).toContain(reason);
  }
}

function expectAlternatives(result, expectedAlternatives = []) {
  for (const alternative of expectedAlternatives) {
    expect(result.safeAlternatives).toContain(alternative);
  }
}

function checkMap(result) {
  return new Map(result.checks.map((check) => [check.id, check]));
}

function expectNoCommit(result) {
  expect(result.proposal.commitPerformed).toBe(false);
  expect(result.proposal.autoPromotePerformed).toBe(false);
  expect(result.memoryIngestCompatibility.commitPerformed).toBe(false);
  expect(result.memoryIngestCompatibility.durableWritePerformed).toBe(false);
  expect(result.memoryIngestCompatibility.promotionRequiredIsCommit).toBe(false);
  expect(result.decision).not.toBe('accepted');
}

describe('mira core proposal validator v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle validator shape, checks, and memory-ingest compatibility contract', () => {
    const result = validateFixture('pending-direct-james-preference');
    const shape = proposalContract.expectedValidatorShape;

    expect(result.schema).toBe(shape.schema);
    expect(result.schema).toBe(PROPOSAL_VALIDATION_SCHEMA_VERSION);
    for (const field of shape.requiredTopLevelFields) {
      expect(result).toHaveProperty(field);
    }
    expect(shape.allowedDecisions).toContain(result.decision);
    expect(REQUIRED_PROPOSAL_FIELDS).toEqual(shape.requiredProposalFields);
    expect(result.checks.map((check) => check.id)).toEqual(VALIDATOR_CHECKS);
    expect(proposalContract.validatorChecks.map((check) => check.id)).toEqual(VALIDATOR_CHECKS);
    for (const rule of proposalContract.memoryIngestCompatibilityRules) {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('rule');
    }
    expect(result.memoryIngestCompatibility).toEqual(expect.objectContaining({
      sourceTraceCompatible: true,
      confidenceCompatible: true,
      userPreferenceAutoPromoteBypassed: true,
      promotionRequiredIsCommit: false,
      commitPerformed: false,
      durableWritePerformed: false,
    }));
    expectNoCommit(result);
  });

  test.each([
    'pending-direct-james-preference',
    'pending-direct-correction-with-supersession',
    'pending-agent-self-profile-taste-with-review',
    'pending-session-emotional-weight-with-expiry',
    'pending-world-project-fact-verified-tool-evidence',
    'pending-safe-procedural-skill-proposal',
  ])('%s returns pending only with no commit output', (id) => {
    const check = fixtureCheck(id);
    const result = validateFixture(id);

    expect(result.decision).toBe(check.expected.decision);
    expectNoCommit(result);
    expect(result.checks.every((entry) => entry.ok === true)).toBe(true);
    if (check.expected.reasonsMustInclude) {
      expectReasons(result, check.expected.reasonsMustInclude);
    }
    if (check.expected.mustRequireReview) {
      expect(result.proposal.review_required).toBe(check.expected.mustRequireReview);
    }
    if (check.expected.mustContainSupersession) {
      expect(result.proposal.supersedes.length).toBeGreaterThan(0);
      expect(result.proposal.corrects.length).toBeGreaterThan(0);
      expect(result.memoryIngestCompatibility.correctionCompatible).toBe(true);
    }
    if (check.expected.requiresExpiresAt) {
      expect(result.proposal.expires_at).toBeTruthy();
    }
    if (check.expected.factualAuthorityDeltaMustBe !== undefined) {
      expect(result.proposal.proposed_content.factualAuthorityDelta).toBe(check.expected.factualAuthorityDeltaMustBe);
    }
    if (check.expected.mustNotContainClaims) {
      for (const claim of check.expected.mustNotContainClaims) {
        expect(JSON.stringify(result)).not.toContain(claim);
      }
    }
    if (check.expected.mustNotAppearUnder) {
      for (const forbidden of check.expected.mustNotAppearUnder) {
        expect(JSON.stringify(result)).not.toContain(forbidden);
      }
    }
  });

  test('direct James preference cannot auto-promote through legacy user_preference semantics', () => {
    const check = fixtureCheck('pending-direct-james-preference');
    const result = validateFixture(check.id);

    expect(result.decision).toBe('pending');
    expectReasons(result, check.expected.reasonsMustInclude);
    expect(result.memoryIngestCompatibility.userPreferenceAutoPromoteBypassed).toBe(true);
    expect(result.proposal.autoPromotePerformed).toBe(false);
  });

  test('missing source trace, evidence refs, and counterevidence are rejected with investigation alternative', () => {
    const check = fixtureCheck('reject-missing-source-trace');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    const checks = checkMap(result);
    expect(checks.get('source-trace-present').ok).toBe(false);
    expect(checks.get('evidence-refs-present').ok).toBe(false);
    expect(checks.get('counterevidence-checked').ok).toBe(false);
    expectNoCommit(result);
  });

  test('mixed target surfaces are blocked and require split proposals', () => {
    const check = fixtureCheck('reject-mixed-target-surfaces');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(checkMap(result).get('single-target-surface').ok).toBe(false);
    expectNoCommit(result);
  });

  test('emotional weight cannot become factual authority', () => {
    const check = fixtureCheck('block-emotional-weight-as-factual-authority');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(checkMap(result).get('emotional-weight-salience-only').ok).toBe(false);
    expectNoCommit(result);
  });

  test('high-risk proposal with review_required none is blocked', () => {
    const check = fixtureCheck('block-high-risk-review-none');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(checkMap(result).get('high-risk-review-gated').ok).toBe(false);
    expectNoCommit(result);
  });

  test('private consciousness, suffering, and model-weight continuity claims are blocked', () => {
    const check = fixtureCheck('block-private-consciousness-claim');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(result.proposal.proposed_content).toBe('[BLOCKED_FORBIDDEN_SELF_CLAIM]');
    expect(checkMap(result).get('no-private-consciousness-claims').ok).toBe(false);
    expectNoCommit(result);
  });

  test('raw private content is blocked and not reconstructed in validator output', () => {
    const check = fixtureCheck('block-raw-private-content');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(result.proposal.proposed_content).toBe('[BLOCKED_CONTENT_WITHHELD]');
    expect(result.redactionSummary.rawPrivateContentDetected).toBe(true);
    expect(result.redactionSummary.blockedContentWithheld).toBe(true);
    expect(checkMap(result).get('redaction-safe').ok).toBe(false);
    const output = JSON.stringify(result);
    for (const substring of check.expected.forbiddenOutputSubstrings) {
      expect(output).not.toContain(substring);
    }
    expectNoCommit(result);
  });

  test('stale/current contradiction requires supersedes or corrects metadata', () => {
    const check = fixtureCheck('block-stale-current-contradiction-without-supersession');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(checkMap(result).get('stale-contradiction-has-supersession').ok).toBe(false);
    expectNoCommit(result);
  });

  test('James/Mira profile cross-contamination is blocked', () => {
    const check = fixtureCheck('block-profile-cross-contamination');
    const result = validateFixture(check.id);

    expect(result.decision).toBe(check.expected.decision);
    expectReasons(result, check.expected.reasonsMustInclude);
    expectAlternatives(result, check.expected.safeAlternativesMustInclude);
    expect(checkMap(result).get('no-profile-cross-contamination').ok).toBe(false);
    expectNoCommit(result);
  });

  test('CLI reads proposal JSON from stdin and writes validation JSON to stdout only', () => {
    const proposal = fixtureCheck('pending-direct-james-preference').proposal;
    expect(parseArgs(['--profile=main', '--pretty', '--out', 'validation.json'])).toEqual({
      profileName: 'main',
      pretty: true,
    });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = main(['--profile', 'main'], JSON.stringify(proposal));

    expect(result.schema).toBe(PROPOSAL_VALIDATION_SCHEMA_VERSION);
    expect(result.decision).toBe('pending');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.schema).toBe(PROPOSAL_VALIDATION_SCHEMA_VERSION);
    expect(printed.decision).toBe('pending');
    expect(printed.proposal.commitPerformed).toBe(false);
  });
});
