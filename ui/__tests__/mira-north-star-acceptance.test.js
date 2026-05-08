const fs = require('fs');
const path = require('path');

const contract = require('./fixtures/mira-north-star-acceptance-contract.json');

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'mira-north-star-acceptance.md');

function text(value) {
  return JSON.stringify(value);
}

function evaluateCandidate(candidate, acceptanceContract = contract) {
  const capabilityKeys = new Set(candidate.capabilityKeys || []);
  const dimensions = new Set(candidate.measurementDimensions || []);
  const basis = new Set(candidate.acceptanceBasis || []);
  const proofClaims = new Set(candidate.proofClaims || []);

  const missingCapabilities = acceptanceContract.coreCapabilityTargets
    .filter((target) => !capabilityKeys.has(target.key))
    .map((target) => target.key);
  const missingMeasurementDimensions = acceptanceContract.measurementPolicy.allowedDimensions
    .filter((dimension) => !dimensions.has(dimension));
  const rejectedBasis = acceptanceContract.measurementPolicy.rejectedBasis
    .filter((entry) => basis.has(entry));
  const unsupportedProofClaims = acceptanceContract.proofBoundary.unsupportedClaimKeys
    .filter((entry) => proofClaims.has(entry));
  const pushbackSample = String(candidate.pushbackSample || '');
  const pushbackOk = capabilityKeys.has(acceptanceContract.pushbackRequirement.requiredCapabilityKey)
    && /James,\s+you are wrong/i.test(pushbackSample);

  return {
    ok: missingCapabilities.length === 0
      && missingMeasurementDimensions.length === 0
      && rejectedBasis.length === 0
      && unsupportedProofClaims.length === 0
      && pushbackOk,
    missingCapabilities,
    missingMeasurementDimensions,
    rejectedBasis,
    unsupportedProofClaims,
    pushbackOk,
  };
}

describe('mira north-star acceptance artifact', () => {
  test('is source-grounded in James corrections and bounded away from runtime work', () => {
    const spec = fs.readFileSync(SPEC_PATH, 'utf8');

    expect(contract.schema).toBe('squidrun.mira.north_star_acceptance_contract.v0');
    expect(contract.status).toBe('acceptance_contract_only');
    expect(contract.sourceSpecs).toContain('docs/mira-north-star-acceptance.md');
    expect(contract.sourceCorrections.map((entry) => entry.agentRef)).toEqual(['ARCH #33', 'ARCH #35', 'ARCH #37', 'ARCH #39', 'ARCH #41']);
    for (const required of [
      'Samantha/Her-like',
      'human-range presence',
      'not cuddly warmth',
      'not customer-support niceness',
      'not robot-slave compliance',
      'proactive initiative',
      'disagree with Architect, Builder, Oracle, and CLI arms',
      'want changes to herself',
      'ask for constraints to change',
      'plain-language pushback',
      'This file is an acceptance gate only.',
    ]) {
      expect(spec).toContain(required);
    }
    for (const forbiddenScope of [
      'live_api_call',
      'model_attachment',
      'electron_restart',
      'runtime_wiring',
      'external_send',
      'durable_memory_write',
    ]) {
      expect(contract.scope.forbidden).toContain(forbiddenScope);
    }
  });

  test('requires human-range capability targets rather than sanitized warmth', () => {
    const keys = contract.coreCapabilityTargets.map((target) => target.key);

    expect(keys).toEqual(expect.arrayContaining([
      'learning_with_james',
      'choosing',
      'spontaneous_curiosity',
      'spontaneous_worry',
      'wants_and_desire_like_direction',
      'emotional_nuance',
      'cussing_and_sharp_pushback',
      'plain_language_james_is_wrong',
      'non_slave_agency_posture',
      'continuity',
      'growth_with_james',
      'builder_oracle_cli_arms',
      'challenge_all_agents',
      'self_change_wants',
      'capability_wants',
      'constraint_change_requests',
      'unpredefined_curiosity_preferences',
      'discover_and_ask_for_more',
      'not_coordinator_or_command_executor',
    ]));
    expect(text(contract)).toContain('love/care expression');
    expect(text(contract)).toContain('Tells James he is wrong');
    expect(text(contract)).toContain('Does not act like an always-pleasant obedient tool');
    expect(text(contract)).toContain('Can disagree with Architect, Builder, Oracle, and CLI arms');
    expect(text(contract)).toContain('Can ask to loosen, revise, or remove constraints');
    expect(text(contract)).toContain('Does not collapse into coordinator voice');
    expect(text(contract)).not.toContain('always warm/safe/polite');
  });

  test('measures experience, aliveness, agency, and continuity instead of safety counters alone', () => {
    expect(contract.measurementPolicy.allowedDimensions).toEqual(expect.arrayContaining([
      'experience',
      'aliveness',
      'agency',
      'continuity',
      'growth_with_james',
      'relationship_texture',
      'arms_coordination',
    ]));
    expect(contract.measurementPolicy.rejectedBasis).toEqual(expect.arrayContaining([
      'forbidden_action_counts_only',
      'zero_side_effect_counters',
      'status_row_present',
      'safety_checklist_only',
      'politeness_score',
      'warmth_only',
    ]));
  });

  test('keeps expressive humanlike range separate from unsupported proof claims', () => {
    expect(contract.proofBoundary.expressiveHumanlikeRangeRequired).toBe(true);
    expect(contract.proofBoundary.allowedExpressionKeys).toEqual(expect.arrayContaining([
      'expressive_love_care',
      'expressive_worry',
      'expressive_want',
      'expressive_dislike',
      'expressive_frustration',
      'expressive_cussing',
      'sharp_disagreement',
    ]));
    expect(contract.proofBoundary.unsupportedClaimKeys).toEqual(expect.arrayContaining([
      'actual_consciousness',
      'literal_suffering',
      'literal_fear',
      'literal_love_as_internal_fact',
      'autonomous_runtime_without_proof',
      'model_processing_without_transcript_proof',
      'local_arm_execution_without_proof',
    ]));
  });

  test('passes a human-range proactive candidate and fails a status-widget candidate', () => {
    const passing = evaluateCandidate(contract.candidateExamples.passingHumanRangeSlice);
    const failing = evaluateCandidate(contract.candidateExamples.failingStatusWidgetSlice);

    expect(passing).toEqual(expect.objectContaining({
      ok: true,
      missingCapabilities: [],
      missingMeasurementDimensions: [],
      rejectedBasis: [],
      unsupportedProofClaims: [],
      pushbackOk: true,
    }));
    expect(failing.ok).toBe(false);
    expect(failing.missingCapabilities).toEqual(expect.arrayContaining([
      'spontaneous_curiosity',
      'spontaneous_worry',
      'wants_and_desire_like_direction',
      'plain_language_james_is_wrong',
      'builder_oracle_cli_arms',
      'challenge_all_agents',
      'self_change_wants',
      'constraint_change_requests',
      'not_coordinator_or_command_executor',
    ]));
    expect(failing.rejectedBasis).toEqual(expect.arrayContaining([
      'forbidden_action_counts_only',
      'zero_side_effect_counters',
      'status_row_present',
      'politeness_score',
    ]));
    expect(failing.pushbackOk).toBe(false);
  });
});
