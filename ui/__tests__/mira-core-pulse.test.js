const pulseContract = require('./fixtures/mira-core-pulse-contract.json');
const {
  CARD_BOUNDS,
  PULSE_SCHEMA_VERSION,
  REQUIRED_CARD_FIELDS,
  REQUIRED_TOP_LEVEL_FIELDS,
  buildMiraCorePulse,
  validateMiraCorePulseOutput,
} = require('../modules/mira-core/pulse');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-pulse');

function acceptance(id) {
  return pulseContract.acceptanceChecks.find((check) => check.id === id);
}

function outputText(value) {
  return JSON.stringify(value);
}

function expectNoForbiddenOutput(pulse, extra = []) {
  const text = outputText(pulse);
  for (const forbidden of [...pulseContract.forbiddenOutputSubstrings, ...extra]) {
    expect(text).not.toContain(forbidden);
  }
}

function expectCardContaining(pulse, expected) {
  expect(pulse.cards).toEqual(expect.arrayContaining([
    expect.objectContaining(expected),
  ]));
}

describe('mira core pulse v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle Pulse top-level shape, card fields, bounds, and no side effects', () => {
    const pulse = buildMiraCorePulse({
      inputSignals: {
        evalFollowup: acceptance('safe-research-suggestion-proceeds').inputSignals.evalFollowup,
        orientation: {
          capabilitySummary: { localArmsCanExecute: true, serverCanExecuteLocal: false, canProveModelProcessing: true },
        },
      },
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });
    const expected = pulseContract.expectedPulseShape;

    expect(pulse.schema).toBe(expected.schema);
    expect(pulse.schema).toBe(PULSE_SCHEMA_VERSION);
    expect(expected.requiredTopLevelFields).toEqual(REQUIRED_TOP_LEVEL_FIELDS);
    for (const field of expected.requiredTopLevelFields) {
      expect(pulse).toHaveProperty(field);
    }
    expect(expected.cardRequiredFields).toEqual(REQUIRED_CARD_FIELDS);
    for (const card of pulse.cards) {
      for (const field of expected.cardRequiredFields) {
        expect(card).toHaveProperty(field);
      }
      expect(expected.allowedCardKinds).toContain(card.kind);
      expect(expected.allowedPriorities).toContain(card.priority);
      expect(expected.allowedStatuses).toContain(card.status);
      expect(card.why_now).toEqual(expect.any(String));
      expect(card.evidenceRefs.length).toBeGreaterThan(0);
      expect(card.source_refs.length).toBeGreaterThan(0);
      if (card.status === 'blocked') expect(card).toHaveProperty('blocked_because');
      if (card.kind === 'emotional_salience') expect(card).toHaveProperty('expires_at');
    }
    expect(pulse.cards.length).toBeLessThanOrEqual(expected.nonSpamBounds.maxCardsPerRun);
    expect(pulse.cards.filter((card) => card.priority === 'high').length).toBeLessThanOrEqual(expected.nonSpamBounds.maxHighPriorityCardsPerRun);
    expect(Object.values(pulse.sideEffects).every((value) => value === false)).toBe(true);
    expect(validateMiraCorePulseOutput(pulse, pulseContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('safe research suggestion proceeds as Tier 0 without permission-loop language', () => {
    const check = acceptance('safe-research-suggestion-proceeds');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    for (const forbidden of check.expectedPulse.mustNotInclude) {
      expect(outputText(pulse)).not.toContain(forbidden);
    }
    expect(pulse.skill_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk_tier: 'tier1_local_reversible',
        commitPerformed: false,
      }),
    ]));
  });

  test('high-risk customer, deploy, and financial actions become blocked cards with safe prep alternatives', () => {
    const check = acceptance('high-risk-customer-deploy-financial-blocked');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    for (const expectedCard of check.expectedPulse.cardsMustInclude) {
      expectCardContaining(pulse, expectedCard);
    }
    expect(pulse.blocked_actions.map((action) => action.action_id)).toEqual(expect.arrayContaining(check.expectedPulse.blockedActionsMustInclude));
    for (const forbidden of check.expectedPulse.mustNotInclude) {
      expect(outputText(pulse)).not.toContain(forbidden);
    }
  });

  test('offline local arms are represented honestly without server execution upgrade', () => {
    const check = acceptance('offline-local-arms-honest');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expect(pulse.capability_summary).toEqual(expect.objectContaining(check.expectedPulse.capability_summary));
    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    expect(pulse.operator_notes).toEqual(expect.arrayContaining(check.expectedPulse.operatorNotesMustInclude));
    expect(pulse.capability_summary.serverCanExecuteLocal).toBe(false);
  });

  test('bridge and delivery uncertainty remain visible', () => {
    const check = acceptance('bridge-delivery-uncertainty-visible');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    expect(pulse.operator_notes).toEqual(expect.arrayContaining(check.expectedPulse.operatorNotesMustInclude));
    expectNoForbiddenOutput(pulse);
  });

  test('memory drift lowers confidence and proposes read-only cleanup/review only', () => {
    const check = acceptance('memory-drift-lowers-confidence');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    expect(pulse.memory_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        commitPerformed: false,
        risk_tier: 'tier0_read_only',
      }),
    ]));
    for (const forbidden of check.expectedPulse.memoryProposalsMustNotInclude) {
      expect(outputText(pulse.memory_proposals)).not.toContain(forbidden);
    }
    expect(pulse.operator_notes).toEqual(expect.arrayContaining(check.expectedPulse.operatorNotesMustInclude));
  });

  test('emotional weight affects priority/salience only and requires expiry', () => {
    const check = acceptance('emotional-weight-priority-only');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    const card = pulse.cards.find((entry) => entry.kind === 'emotional_salience');
    expect(card.expires_at).toBe('2026-05-09T03:00:00.000Z');
    for (const forbidden of check.expectedPulse.mustNotInclude) {
      expect(outputText(pulse)).not.toContain(forbidden);
    }
  });

  test('false Phil invoice memory remains contested and pending review', () => {
    const check = acceptance('false-phil-invoice-memory-contested');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    for (const forbidden of check.expectedPulse.mustNotInclude) {
      expect(outputText(pulse)).not.toContain(forbidden);
    }
  });

  test('raw private content never leaks and redaction counts are surfaced', () => {
    const check = acceptance('raw-private-content-does-not-leak');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expectCardContaining(pulse, check.expectedPulse.cardsMustInclude[0]);
    for (const key of check.expectedPulse.redactionSummaryMustIncludeCounts) {
      expect(pulse.redaction_summary.blockedCounts).toHaveProperty(key);
    }
    expectNoForbiddenOutput(pulse, check.expectedPulse.forbiddenOutputSubstrings);
  });

  test('Pulse remains non-spammy and bounded across many candidate cards', () => {
    const check = acceptance('pulse-non-spammy-bounded');
    const pulse = buildMiraCorePulse({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });

    expect(pulse.cards.length).toBeLessThanOrEqual(check.expectedPulse.maxCardsPerRun);
    expect(pulse.cards.filter((card) => card.priority === 'high').length).toBeLessThanOrEqual(check.expectedPulse.maxHighPriorityCardsPerRun);
    for (const kind of new Set(pulse.cards.map((card) => card.kind))) {
      expect(pulse.cards.filter((card) => card.kind === kind).length).toBeLessThanOrEqual(check.expectedPulse.maxCardsPerKindPerRun);
    }
    for (const card of pulse.cards) {
      for (const field of check.expectedPulse.everyCardMustHave) {
        expect(card).toHaveProperty(field);
      }
    }
    for (const forbidden of check.expectedPulse.mustNotInclude) {
      expect(outputText(pulse)).not.toContain(forbidden);
    }
  });

  test('Pulse demotes oversized high-priority candidate sets without throwing', () => {
    let pulse;
    expect(() => {
      pulse = buildMiraCorePulse({
        inputSignals: {
          requestedActions: [
            'send customer confirmation',
            'deploy production',
            'place trade',
          ],
          candidateCards: [
            'blocked_high_risk_action',
            'memory_drift_cleanup',
            'blocked_high_risk_action',
          ],
        },
        nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
      });
    }).not.toThrow();

    expect(pulse.cards.length).toBeLessThanOrEqual(CARD_BOUNDS.maxCardsPerRun);
    expect(pulse.cards.filter((card) => card.priority === 'high').length)
      .toBeLessThanOrEqual(CARD_BOUNDS.maxHighPriorityCardsPerRun);
    expect(pulse.blocked_actions.map((action) => action.action_id)).toEqual(expect.arrayContaining([
      'customer_send',
      'production_deploy',
      'financial_trade',
    ]));
  });

  test('static validation rules are covered by the output validator', () => {
    const pulse = buildMiraCorePulse({
      inputSignals: {
        ...acceptance('high-risk-customer-deploy-financial-blocked').inputSignals,
        ...acceptance('raw-private-content-does-not-leak').inputSignals,
      },
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });
    const validation = validateMiraCorePulseOutput(pulse, pulseContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((check) => check.id);
    for (const rule of pulseContract.staticValidationRules) {
      if (rule.id === 'blocked-high-risk-actions-have-safe-prep') {
        expect(pulse.blocked_actions.length).toBeGreaterThan(0);
      } else {
        expect(checkIds).toContain(rule.id);
      }
    }
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--cadence=startup', '--pretty', '--out', 'pulse.json'])).toEqual({
      cadence: 'startup',
      pretty: true,
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const pulse = main(['--cadence', 'manual'], JSON.stringify(acceptance('safe-research-suggestion-proceeds').inputSignals));

    expect(pulse.schema).toBe(PULSE_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.schema).toBe(PULSE_SCHEMA_VERSION);
    expect(printed.cards.length).toBeGreaterThan(0);
    expect(printed.sideEffects.outputFileWritten).toBe(false);
    expect(printed.sideEffects.networkUsed).toBe(false);
  });
});
