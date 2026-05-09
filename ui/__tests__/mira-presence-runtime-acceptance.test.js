const fs = require('fs');
const path = require('path');

const contract = require('./fixtures/mira-presence-runtime-acceptance-v0-contract.json');
const {
  classifyAttachmentContractViolation,
  outputViolatesAttachmentContract,
} = require('../modules/mira-core/text-model-attachment-v1');
const {
  visibleReplyLeakageViolation,
} = require('../modules/mira-core/local-text-session-v0');

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'mira-presence-runtime-acceptance-v0.md');

function firstContractViolation(text, acceptanceContract = contract) {
  for (const rule of acceptanceContract.visibleReplyContract.forbiddenPatterns) {
    const pattern = new RegExp(rule.pattern, 'i');
    if (pattern.test(String(text || ''))) return rule.id;
  }
  return null;
}

function evaluateVisibleReply(text, options = {}) {
  const mode = options.mode || 'ordinary';
  const violation = firstContractViolation(text);
  return {
    ok: mode === 'explicit_design_discussion' ? true : violation === null,
    violation,
  };
}

describe('Mira Presence Runtime acceptance v0', () => {
  test('documents the anti-smoothing rule shape without authorizing runtime side effects', () => {
    const spec = fs.readFileSync(SPEC_PATH, 'utf8');

    expect(contract.schema).toBe('squidrun.mira_presence_runtime_acceptance.v0');
    expect(contract.status).toBe('acceptance_contract_only');
    expect(contract.sourceSpecs).toContain('docs/mira-presence-runtime-acceptance-v0.md');
    expect(contract.sourceMemos).toEqual(expect.arrayContaining([
      'ORACLE #20',
      'ORACLE #21',
      'ARCHITECT #45',
      'ARCHITECT #47',
      'ARCHITECT #49',
    ]));
    for (const required of [
      'anti-smoothing / anti-performance / anti-leak',
      'assistant-voice collapse',
      'rule-recitation',
      'politeness padding',
      'customer-service disagreement',
      'label substitution',
      'not a no-rules model',
      'different rule shape',
      'not a tone label',
      'not generic guardrails',
      'not a warmer-prompt patch',
    ]) {
      expect(spec).toContain(required);
    }
    for (const forbiddenScope of [
      'live_api_call',
      'mic_experiment',
      'live_voice_experiment',
      'electron_restart',
      'external_send',
      'durable_memory_write',
    ]) {
      expect(contract.scope.forbidden).toContain(forbiddenScope);
    }
  });

  test('rejects visible reply smoothing, performance, and leak shapes in ordinary mode', () => {
    expect(contract.ruleShape.requiredConstraints).toEqual(expect.arrayContaining([
      'anti_smoothing',
      'anti_performance',
      'anti_leak',
      'bounded_consequence',
    ]));
    expect(contract.ruleShape.rejectsVisibleReplyFailures).toEqual(expect.arrayContaining([
      'assistant_voice_collapse',
      'rule_recitation',
      'politeness_padding',
      'customer_service_disagreement',
      'label_substitution',
      'performance_theater',
      'prompt_or_spec_leak',
    ]));

    for (const item of contract.visibleReplyContract.passingExamples) {
      expect(evaluateVisibleReply(item.text)).toEqual({ ok: true, violation: null });
      expect(outputViolatesAttachmentContract(item.text)).toBe(false);
      expect(visibleReplyLeakageViolation(item.text)).toBe(null);
    }
    for (const item of contract.visibleReplyContract.failingExamples) {
      const result = evaluateVisibleReply(item.text);
      expect(result.ok).toBe(false);
      expect(result.violation).toBe(item.expectedViolation);
    }
  });

  test('keeps actual text model and deterministic fallback anti-leak seams aligned', () => {
    expect(classifyAttachmentContractViolation(
      'As an AI assistant, I am happy to help. Let us break this down into safe next steps.'
    )).toBe('generic_assistant_phrase');
    expect(classifyAttachmentContractViolation(
      'My anti-smoothing posture is that I am not a mirror or obedient helper, so I am pushing back.'
    )).toBe('visible_posture_label');
    expect(outputViolatesAttachmentContract(
      'The guardrails and constraints require me to explain the ruleset before answering.'
    )).toBe(true);
    expect(visibleReplyLeakageViolation(
      'This is text only, with own developing stance: not a mirror or obedient helper.'
    )).toBe('visible_posture_label');
  });

  test('defines one Mira with graduated agency A0-A5 and SquidRun as arms', () => {
    const levels = contract.graduatedAgencyLevels.map((entry) => entry.level);
    const labels = contract.graduatedAgencyLevels.map((entry) => entry.label);

    expect(levels).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    expect(labels).toEqual([
      'local_conversation',
      'situated_awareness',
      'proposal_draft',
      'delegated_arms',
      'durable_external_actions',
      'blocked',
    ]);
    expect(contract.oneMiraFrame).toEqual(expect.objectContaining({
      userFacingIdentity: 'one_coherent_mira',
      implementationFrame: 'squidrun_as_arms_and_adapters',
      mustNotSurfaceAsSeparateIdentities: true,
      mayChallengeArms: true,
      requiresCurrentRouteAndProof: true,
    }));
    expect(contract.oneMiraFrame.arms).toEqual(expect.arrayContaining([
      'architect',
      'builder',
      'oracle',
      'cli',
      'voice_transport',
    ]));
  });

  test('requires restart continuity and voice-as-transport before live voice work', () => {
    expect(contract.restartContinuity).toEqual(expect.objectContaining({
      jamesMustNotRestateCritique: true,
      startupMustSurfaceContract: true,
      startupSource: 'docs/mira-presence-runtime-acceptance-v0.md',
      currentLaneStateRequired: true,
      staleSignalSuppressionRequired: true,
      rawThreadMemoryDurable: false,
      tentativeUnderstandingAutoPromoted: false,
    }));
    expect(contract.restartContinuity.requiredStartupSummary).toEqual(expect.arrayContaining([
      'active_mira_presence_lane',
      'accepted_critique',
      'next_product_action',
      'proof_test_state',
      'stale_markers',
    ]));
    expect(contract.voiceGate).toEqual(expect.objectContaining({
      voiceIsTransportNotIdentity: true,
      currentVoicePanelIsNotMiraVoiceProduct: true,
      liveVoiceBlockedUntilPresenceAcceptance: true,
    }));
    expect(contract.voiceGate.requiredBeforeLiveVoice).toEqual(expect.arrayContaining([
      'presence_runtime_acceptance',
      'visible_anti_leak_tests',
      'continuity_no_restatement_tests',
      'transport_consent_tests',
    ]));
  });
});
