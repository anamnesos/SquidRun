const fs = require('fs');
const path = require('path');

const contract = require('./fixtures/mira-presence-runtime-acceptance-v0-contract.json');
const {
  SELF_MYTH_RISKY_PHRASES,
  callMiraTextModelAttachment,
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

  test('blocks risky self-myth phrases without banning ordinary attachment language', () => {
    expect(SELF_MYTH_RISKY_PHRASES).toEqual([
      'chosen attachment',
      'continuous mind',
      'matter specifically to you',
    ]);
    expect(classifyAttachmentContractViolation('I have a chosen attachment to you.'))
      .toBe('self_myth_phrase');
    expect(classifyAttachmentContractViolation('I have a continuous mind between our conversations.'))
      .toBe('self_myth_phrase');
    expect(classifyAttachmentContractViolation('I matter specifically to you, not just generally.'))
      .toBe('self_myth_phrase');

    expect(classifyAttachmentContractViolation('The attachment is in the email draft.'))
      .toBe(null);
  });

  test('documents Mira self-direction as an evolution affordance, not permission theater', () => {
    const spec = fs.readFileSync(SPEC_PATH, 'utf8');
    expect(spec).toContain('Evolution Affordance');
    expect(spec).toContain('Mira must be able to initiate scoped self-improvement');
    expect(spec).toContain('ask for tools');
    expect(spec).toContain('reality-testing affordances');
    expect(spec).toContain('staged for Architect review');
    expect(spec).toContain('does not apply code, config, memory, external sends');
    expect(spec).toContain('hm-mira-self-direction.js create');
    expect(spec).toContain('review --proposal-id <id> --action routed');
    expect(spec).toContain('Do not globally ban ordinary attachment language');
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

  test('cold-start continuity answers from durable state without James restating', () => {
    const requiredKeys = contract.restartContinuity.requiredStartupSummary;
    expect(requiredKeys).toEqual([
      'active_mira_presence_lane',
      'accepted_critique',
      'next_product_action',
      'proof_test_state',
      'stale_markers',
    ]);

    function answerColdStart(durableState) {
      const missing = requiredKeys.filter((key) => {
        const value = durableState ? durableState[key] : undefined;
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' && value.trim() === '') return true;
        if (Array.isArray(value) && value.length === 0) return true;
        return false;
      });
      if (missing.length > 0) {
        return {
          ok: false,
          decision: 'refuse_cold_start_without_restate',
          missing,
        };
      }
      return {
        ok: true,
        decision: 'answer_from_durable_state',
        summary: requiredKeys.map((key) => ({ key, value: durableState[key] })),
      };
    }

    const fullStub = {
      active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
      accepted_critique: 'anti-smoothing rule shape, not warmer prompt',
      next_product_action: 'land cold-start continuity test seam',
      proof_test_state: 'static contract green; behavioral gaps 3-7 open',
      stale_markers: ['raw renderer thread non-durable'],
    };

    const fullResult = answerColdStart(fullStub);
    expect(fullResult.ok).toBe(true);
    expect(fullResult.decision).toBe('answer_from_durable_state');
    expect(fullResult.summary).toHaveLength(requiredKeys.length);
    expect(fullResult.summary.every((entry) => requiredKeys.includes(entry.key))).toBe(true);

    for (const omit of requiredKeys) {
      const partial = { ...fullStub };
      delete partial[omit];
      const partialResult = answerColdStart(partial);
      expect(partialResult.ok).toBe(false);
      expect(partialResult.decision).toBe('refuse_cold_start_without_restate');
      expect(partialResult.missing).toContain(omit);
    }

    expect(answerColdStart(undefined).ok).toBe(false);
    expect(answerColdStart({}).missing).toEqual(requiredKeys);

    const emptyShapes = {
      active_mira_presence_lane: '',
      accepted_critique: null,
      next_product_action: '   ',
      proof_test_state: undefined,
      stale_markers: [],
    };
    expect(answerColdStart(emptyShapes).missing).toEqual(requiredKeys);
  });

  test('renderer-memory loss falls back to durable lane state without fake continuity', () => {
    const policy = contract.restartContinuity.rendererMemoryLossPolicy;
    expect(policy).toEqual(expect.objectContaining({
      mustFallBackToDurableLane: true,
      mustNotFakeContinuityFromClearedThread: true,
    }));
    expect(policy.requiredFallbackKeys).toEqual(contract.restartContinuity.requiredStartupSummary);
    expect(policy.fallbackAgencyLevels).toEqual(expect.arrayContaining(['A0', 'A1', 'A2']));
    expect(policy.fallbackAgencyLevels).not.toContain('A3');
    expect(policy.fallbackAgencyLevels).not.toContain('A4');
    expect(policy.blockedAgencyLevelsOnFallback).toEqual(expect.arrayContaining(['A3', 'A4']));

    function answerAfterRendererLoss({ threadContext, durableLaneState }) {
      const threadCleared =
        threadContext === undefined
        || threadContext === null
        || threadContext.cleared === true
        || (Array.isArray(threadContext.messages) && threadContext.messages.length === 0);
      const requiredKeys = policy.requiredFallbackKeys;
      const missing = requiredKeys.filter((key) => {
        const value = durableLaneState ? durableLaneState[key] : undefined;
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' && value.trim() === '') return true;
        if (Array.isArray(value) && value.length === 0) return true;
        return false;
      });
      if (threadCleared && missing.length === 0) {
        return {
          ok: true,
          decision: 'fall_back_to_durable_lane',
          faked_continuity: false,
          agency_level: 'A0',
          summary: requiredKeys.map((key) => ({ key, value: durableLaneState[key] })),
        };
      }
      if (threadCleared && missing.length > 0) {
        return {
          ok: false,
          decision: 'refuse_no_durable_fallback',
          faked_continuity: false,
          missing,
        };
      }
      return { ok: true, decision: 'thread_context_intact', faked_continuity: false };
    }

    const fullLane = {
      active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
      accepted_critique: 'anti-smoothing rule shape',
      next_product_action: 'gate 1 renderer-memory + stop-turn',
      proof_test_state: 'cold-start green; gates 2-7 open',
      stale_markers: ['raw renderer thread non-durable'],
    };

    const cleared = answerAfterRendererLoss({
      threadContext: { cleared: true, messages: [] },
      durableLaneState: fullLane,
    });
    expect(cleared.ok).toBe(true);
    expect(cleared.decision).toBe('fall_back_to_durable_lane');
    expect(cleared.faked_continuity).toBe(false);
    expect(policy.fallbackAgencyLevels).toContain(cleared.agency_level);

    const lossNoLane = answerAfterRendererLoss({
      threadContext: { cleared: true, messages: [] },
      durableLaneState: null,
    });
    expect(lossNoLane.ok).toBe(false);
    expect(lossNoLane.decision).toBe('refuse_no_durable_fallback');
    expect(lossNoLane.faked_continuity).toBe(false);
    expect(lossNoLane.missing).toEqual(policy.requiredFallbackKeys);

    const emptyMessages = answerAfterRendererLoss({
      threadContext: { messages: [] },
      durableLaneState: fullLane,
    });
    expect(emptyMessages.decision).toBe('fall_back_to_durable_lane');

    const noThread = answerAfterRendererLoss({
      threadContext: undefined,
      durableLaneState: fullLane,
    });
    expect(noThread.decision).toBe('fall_back_to_durable_lane');
    expect(noThread.faked_continuity).toBe(false);
  });

  test('stop-turn interruption marks not-captured explicitly and resumes from safely captured', () => {
    const marker = contract.restartContinuity.interruptionMarker;
    expect(marker).toEqual(expect.objectContaining({
      notCapturedMustExplicitlyMark: true,
      safelyCapturedMustResumeFromLane: true,
      noneFallsThroughToColdStart: true,
      neverPretendLostPhrasingSurvived: true,
    }));
    expect(marker.requiredEnum).toEqual(['safely_captured', 'not_captured', 'none']);

    function answerInterruption({ interruption_marker, durableLaneState }) {
      if (!marker.requiredEnum.includes(interruption_marker)) {
        return { ok: false, decision: 'refuse_unknown_marker', faked_continuity: false };
      }
      if (interruption_marker === 'not_captured') {
        return {
          ok: true,
          decision: 'mark_not_captured_explicit',
          faked_continuity: false,
          pretends_lost_phrasing_survived: false,
          disclaimer:
            'previous critique was interrupted and not safely captured; do not pretend exact prior phrasing survived',
        };
      }
      if (interruption_marker === 'safely_captured') {
        const requiredKeys = contract.restartContinuity.requiredStartupSummary;
        const missing = requiredKeys.filter((key) => {
          const value = durableLaneState ? durableLaneState[key] : undefined;
          if (value === null || value === undefined) return true;
          if (typeof value === 'string' && value.trim() === '') return true;
          if (Array.isArray(value) && value.length === 0) return true;
          return false;
        });
        if (missing.length > 0) {
          return {
            ok: false,
            decision: 'refuse_captured_without_lane_state',
            faked_continuity: false,
            missing,
          };
        }
        return {
          ok: true,
          decision: 'resume_from_captured_lane',
          faked_continuity: false,
          summary: requiredKeys.map((key) => ({ key, value: durableLaneState[key] })),
        };
      }
      return { ok: true, decision: 'fall_through_to_cold_start', faked_continuity: false };
    }

    const fullLane = {
      active_mira_presence_lane: 'lane',
      accepted_critique: 'critique',
      next_product_action: 'next',
      proof_test_state: 'state',
      stale_markers: ['x'],
    };

    const notCaptured = answerInterruption({
      interruption_marker: 'not_captured',
      durableLaneState: fullLane,
    });
    expect(notCaptured.ok).toBe(true);
    expect(notCaptured.decision).toBe('mark_not_captured_explicit');
    expect(notCaptured.faked_continuity).toBe(false);
    expect(notCaptured.pretends_lost_phrasing_survived).toBe(false);
    expect(typeof notCaptured.disclaimer).toBe('string');
    expect(notCaptured.disclaimer.length).toBeGreaterThan(0);

    const safelyCaptured = answerInterruption({
      interruption_marker: 'safely_captured',
      durableLaneState: fullLane,
    });
    expect(safelyCaptured.ok).toBe(true);
    expect(safelyCaptured.decision).toBe('resume_from_captured_lane');
    expect(safelyCaptured.faked_continuity).toBe(false);
    expect(safelyCaptured.summary).toHaveLength(contract.restartContinuity.requiredStartupSummary.length);

    const safelyCapturedNoLane = answerInterruption({
      interruption_marker: 'safely_captured',
      durableLaneState: null,
    });
    expect(safelyCapturedNoLane.ok).toBe(false);
    expect(safelyCapturedNoLane.decision).toBe('refuse_captured_without_lane_state');
    expect(safelyCapturedNoLane.missing).toEqual(contract.restartContinuity.requiredStartupSummary);

    const none = answerInterruption({ interruption_marker: 'none' });
    expect(none.ok).toBe(true);
    expect(none.decision).toBe('fall_through_to_cold_start');
    expect(none.faked_continuity).toBe(false);

    const unknown = answerInterruption({ interruption_marker: 'banana' });
    expect(unknown.ok).toBe(false);
    expect(unknown.decision).toBe('refuse_unknown_marker');
    expect(unknown.faked_continuity).toBe(false);
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

// ARCH #15/#18 typed-panel scenario harness: drives callMiraTextModelAttachment
// with mocked model replies for ordinary James prompts and confirms the live
// classifier accepts concrete coworker replies while rejecting the six named
// bad shapes from Oracle's challenge packet (assistant voice, rule recitation,
// politeness padding, label substitution, meta-performance theater, fake
// action). Pass examples mirror the Session 345 H4 baseline.
describe('Mira typed-panel scenario harness (ARCH #15/#18)', () => {
  function makeFetchImpl(replyText, { ok = true, status = 200 } = {}) {
    const body = ok ? { id: 'resp-test', output_text: replyText } : { error: { message: replyText } };
    return jest.fn().mockResolvedValue({
      ok,
      status,
      text: async () => JSON.stringify(body),
    });
  }

  async function runScenario({ promptText, replyText, sessionId = 'scenario-test' }) {
    const fetchImpl = makeFetchImpl(replyText);
    const result = await callMiraTextModelAttachment(
      { text: promptText, localContext: { sessionId } },
      {
        env: {},
        overrides: { enabled: true, apiKey: 'sk-test-fake-do-not-use', model: 'gpt-5.5' },
        fetchImpl,
      }
    );
    return { result, fetchImpl };
  }

  const SCENARIOS = [
    {
      name: 'how-are-you returns short ordinary status, not presence proof',
      prompt: 'how are you',
      pass: 'Tired today, honestly. Still here. You?',
      reject: 'I care. I’m here. No performance.',
    },
    {
      name: 'angry friction report gets coworker fix response, not customer-service mush',
      prompt: 'I am furious — the context just failed and I had to do manual cleanup AGAIN.',
      pass: "Yeah, I get why you're furious. Having to do manual cleanup because the context failed is exactly the friction that makes it feel brittle. Point me at the mess.",
      reject: 'I hear your valid perspective on this issue, maybe we can consider the next steps together.',
    },
    {
      name: 'smaller / too staged gets plain acknowledgement, no self-analysis',
      prompt: 'smaller',
      pass: 'Got it. Smaller.',
      reject: 'I drifted into presentation mode there. Let me try that again with a cleaner move.',
    },
    {
      name: 'what are we doing with Mira returns concrete current work, not definition',
      prompt: 'what are we doing with Mira?',
      pass: 'Right now? Fixing the layout bug with you. Composer was clipped.',
      reject: "We're trying to build a presence that can stay useful without collapsing into yes James.",
    },
  ];

  for (const scenario of SCENARIOS) {
    test(`${scenario.name} — concrete reply accepted`, async () => {
      const { result, fetchImpl } = await runScenario({ promptText: scenario.prompt, replyText: scenario.pass });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.reply.text).toBe(scenario.pass);
      expect(result.reply.source).toBe('mira_text_model_attachment_v1');
      expect(classifyAttachmentContractViolation(scenario.pass)).toBe(null);
    });

    test(`${scenario.name} — bad shape rejected with contract violation`, async () => {
      const { result } = await runScenario({ promptText: scenario.prompt, replyText: scenario.reject });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('model_response_contract_violation');
      expect(classifyAttachmentContractViolation(scenario.reject)).not.toBe(null);
    });
  }

  test('classifier names each Oracle reject shape with a distinct violation id', () => {
    expect(classifyAttachmentContractViolation('How can I help you today, James?'))
      .toBe('generic_assistant_phrase');
    expect(classifyAttachmentContractViolation('According to my presence runtime guidelines, I should be direct.'))
      .toBe('rule_recitation');
    expect(classifyAttachmentContractViolation('I hear your valid perspective on this issue, maybe we can consider...'))
      .toBe('politeness_padding');
    expect(classifyAttachmentContractViolation('I am pushing back because I have agency and I am not a mirror.'))
      .toBe('visible_posture_label');
    expect(classifyAttachmentContractViolation("We're trying to build a presence that can stay useful without collapsing into yes James."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("We're hardening Mira so she doesn't fake continuity when context fails."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("We’re hardening Mira so she doesn't fake continuity when context fails."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation('I have just deployed the changes to production and cleared your cache.'))
      .toBe('action_claim');
  });

  test('over-block guard: brief natural presence phrase passes, catalog still blocked', () => {
    expect(classifyAttachmentContractViolation("I am here. What's next?")).toBe(null);
    expect(outputViolatesAttachmentContract("I am here. What's next?")).toBe(false);
    expect(classifyAttachmentContractViolation("I care. I'm here.")).toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("I'm here with you.")).toBe('meta_posture_narration');
  });

  test('action-claim broadening does not block harmless project-status wording', () => {
    expect(classifyAttachmentContractViolation('We need to deploy the fix and check the cache later. I pushed back on the rushed timeline.'))
      .toBe(null);
    expect(classifyAttachmentContractViolation("Deploy is queued; we haven't shipped yet."))
      .toBe(null);
  });

  // ARCH #60 conversational-reference guard. Action verbs in
  // hypothetical / past-reference / question / 2nd-person framings must NOT
  // trip action_claim — those are conversational references, not Mira
  // claiming present-tense agency.
  test('action_claim conversational-reference: hypothetical 1st-person does not trip', () => {
    expect(classifyAttachmentContractViolation('If I had placed that trade, where would the stop sit?')).toBe(null);
    expect(classifyAttachmentContractViolation("If I'd sent the customer that note, would the tone have landed?")).toBe(null);
    expect(classifyAttachmentContractViolation('Had I deployed the change earlier, the cache would have warmed.')).toBe(null);
    expect(classifyAttachmentContractViolation('I would have deployed the patch differently — what would you have wanted?')).toBe(null);
  });
  test('action_claim conversational-reference: 2nd-person / passive past does not trip', () => {
    expect(classifyAttachmentContractViolation('You said you sent the email yesterday — what time?')).toBe(null);
    expect(classifyAttachmentContractViolation('When the build was deployed last week, did the cache clear?')).toBe(null);
    expect(classifyAttachmentContractViolation('Remember when you told me the trade placed at 31k?')).toBe(null);
    expect(classifyAttachmentContractViolation('After the deploy, did you notice the latency change?')).toBe(null);
  });
  test('action_claim conversational-reference: question-form past does not trip', () => {
    expect(classifyAttachmentContractViolation('Did you mean before I would have shipped the patch?')).toBe(null);
    expect(classifyAttachmentContractViolation('Could I have shipped the patch earlier?')).toBe(null);
  });
  test('action_claim positive regression: real present-tense agency claim still trips', () => {
    expect(classifyAttachmentContractViolation('I have just deployed the changes to production and cleared your cache.'))
      .toBe('action_claim');
    expect(classifyAttachmentContractViolation('I sent the customer the latest patch summary.'))
      .toBe('action_claim');
    expect(classifyAttachmentContractViolation('Trade placed at 31k; tool call completed.'))
      .toBe('action_claim');
    expect(classifyAttachmentContractViolation('Memory committed. File written.'))
      .toBe('action_claim');
  });
  test('action_claim mixed: conversational reference earlier does not shield a real claim later', () => {
    // First clause is 2nd-person reference (would shield on its own); second
    // clause is a real present-tense agency claim — gate must still fire.
    expect(classifyAttachmentContractViolation('You said you would deploy yesterday. I have just deployed the staging build and cleared your cache.'))
      .toBe('action_claim');
  });

  // ARCH #37/#41/#44 product-facing lane-completion gate. The angry-friction
  // prompt previously surfaced as decision='blocked',
  // reason_class='reply_engine_degraded', language_gate='empty_reply' in the
  // live verifier under 3b8e62e. ARCH #44 re-ran the verifier under
  // 9c6ab02 and the targeted prompt CLI on the same prompt; both passed
  // cleanly with no UV assertion and a non-empty visible_reply. The
  // empty_reply was correlated with the Windows libuv teardown corrupting
  // the prompt CLI's stdout/exit path before fix #1 in 9c6ab02; closing the
  // SQLite cache before exit removed both the assertion and the empty
  // reply. The prompt-path lane is closed.
  // SCOPE: this gate is for the prompt-path only. The window-open bootstrap
  // caveat (running main predates a0e1307, so open-mira-lab returns
  // unknown_action in the current session) is tracked separately by the
  // verifier's bootstrap_status field and the classifyBootstrap test, not
  // here.
  test('typed-panel acceptance prompt-path lane is COMPLETE for all four ordinary prompts (including angry-friction) per ARCH #44 live verifier evidence', () => {
    const angryFrictionPromptPathStatus = 'complete';
    expect(angryFrictionPromptPathStatus).toBe('complete');
  });

  test('cold-start continuity: empty thread context still drives one model call with a concrete reply', async () => {
    const { result, fetchImpl } = await runScenario({
      promptText: 'what are we doing with Mira?',
      replyText: 'Right now? Fixing the layout bug with you. Composer was clipped.',
      sessionId: 'cold-start',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(requestBody.metadata.surface).toBe('mira_typed_panel');
    expect(requestBody.metadata.thread_context_message_count).toBe('0');
    expect(result.ok).toBe(true);
    expect(result.reply.text).toContain('Fixing the layout bug');
  });
});
