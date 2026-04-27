'use strict';

const gate = require('../oracle-watch-execution-gate');

describe('oracle-watch-execution-gate', () => {
  test('blocks executable commands below James mission-size floor', () => {
    expect(gate.resolveExecutableCommandGate({ suggestedMarginUsd: 150 })).toEqual(expect.objectContaining({
      executable: false,
      reason: 'below_min_executable_margin',
      minMarginUsd: 200,
      marginUsd: 150,
    }));
  });

  test('allows watch-only low-margin rules to exist without executable command readiness', () => {
    expect(gate.resolveExecutableCommandGate({ suggestedMarginUsd: 125, watchOnly: true })).toEqual(expect.objectContaining({
      executable: false,
      reason: 'watch_only_or_no_trade',
      marginUsd: 125,
    }));
  });

  test('suppresses same-symbol same-trigger repeats after a veto-like execution state', () => {
    const rule = {
      ticker: 'HYPER/USD',
      trigger: 'lose_fail_retest',
      loseLevel: 0.158,
      retestMin: 0.158,
      retestMax: 0.161,
    };
    const nowMs = Date.parse('2026-04-25T20:00:00.000Z');

    const result = gate.shouldSuppressAfterPriorVeto(rule, {
      execution: {
        status: 'deferred_below_mission_floor',
        attemptedAt: '2026-04-25T19:45:00.000Z',
        triggerFingerprint: gate.buildRuleTriggerFingerprint(rule),
      },
    }, nowMs);

    expect(result).toEqual(expect.objectContaining({
      suppress: true,
      reason: 'same_symbol_trigger_prior_veto',
    }));
  });
});
