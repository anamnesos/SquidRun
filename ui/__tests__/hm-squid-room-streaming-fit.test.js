'use strict';

// Bug A: streaming-fit proof checks (fit-coherence + redraw paint outcome).
const {
  verifyStreamingFit,
  verifyFitCoherence,
  verifyRedrawOutcome,
  parseFitTelemetryLines,
} = require('../scripts/hm-squid-room-restart-proof');

function rec(paneId, over = {}) {
  return {
    paneId,
    operation: 'settle_redraw',
    ts: 1000,
    xtermCols: 80,
    xtermRows: 24,
    proposedCols: 80,
    proposedRows: 24,
    appliedCols: 80,
    appliedRows: 24,
    coherent: true,
    quietSettle: true,
    painted: true,
    beforeSignature: 'a:24:10',
    afterSignature: 'b:24:12',
    ...over,
  };
}

function evidence(byPane) {
  return {
    generatedAt: '2026-06-09T00:00:00.000Z',
    gitHead: 'deadbeef',
    appStatus: { session: 418 },
    sessionScope: 'scope',
    paths: { fitTelemetryPath: '/tmp/terminal-fit-telemetry.jsonl' },
    fitTelemetryByPane: byPane,
  };
}

describe('Bug A streaming-fit proof', () => {
  test('no telemetry -> UNKNOWN (non-blocking), not a false PASS', () => {
    const result = verifyStreamingFit(evidence({}));
    expect(result.kind).toBe('streaming_fit_verification');
    expect(result.status).toBe('UNKNOWN');
    expect(result.checks.find((c) => c.id === 'fit_coherence_during_streaming').status).toBe('UNKNOWN');
    expect(result.checks.find((c) => c.id === 'redraw_outcome_on_settle').status).toBe('UNKNOWN');
  });

  test('coherent + painted on all main panes -> PASS', () => {
    const result = verifyStreamingFit(evidence({ 1: rec('1'), 2: rec('2'), 3: rec('3') }));
    expect(result.status).toBe('PASS');
    expect(result.decision).toBe('streaming_fit_gate_met');
  });

  test('geometry drift on a pane -> fit_coherence FAIL', () => {
    const result = verifyFitCoherence(evidence({ 1: rec('1'), 2: rec('2', { coherent: false, proposedCols: 100 }) }));
    expect(result.status).toBe('FAIL');
    expect(result.evidence.offenders['2']).toBeDefined();
  });

  test('no paint delta on a quiet-settle pane -> redraw_outcome FAIL (X inert -> iterate to Y)', () => {
    const result = verifyRedrawOutcome(evidence({ 1: rec('1'), 2: rec('2', { painted: false, afterSignature: 'a:24:10' }) }));
    expect(result.status).toBe('FAIL');
    expect(result.why).toMatch(/NO paint delta|inert|\(Y\)/);
    expect(result.evidence.offenders['2']).toBeDefined();
  });

  test('confounded (quietSettle=false) painted records are EXCLUDED, never a PASS', () => {
    // All present records are mid-stream/confounded -> no evidence-grade data -> UNKNOWN, not PASS.
    const allConfounded = verifyRedrawOutcome(evidence({
      1: rec('1', { quietSettle: false }),
      2: rec('2', { quietSettle: false }),
    }));
    expect(allConfounded.status).toBe('UNKNOWN');
    expect(allConfounded.evidence.confoundedPanes).toEqual(expect.arrayContaining(['1', '2']));

    // A quiet pane PASSes on its own evidence; the confounded pane is excluded, not failed.
    const mixed = verifyRedrawOutcome(evidence({
      1: rec('1', { quietSettle: true, painted: true }),
      2: rec('2', { quietSettle: false, painted: true }),
    }));
    expect(mixed.status).toBe('PASS');
    expect(mixed.evidence.confoundedExcluded).toContain('2');
  });

  test('parseFitTelemetryLines keeps the LATEST record per pane', () => {
    const lines = [
      JSON.stringify(rec('1', { ts: 100, painted: false })),
      JSON.stringify(rec('1', { ts: 500, painted: true })), // newer wins
      'not json',
      JSON.stringify(rec('2', { ts: 300 })),
    ];
    const byPane = parseFitTelemetryLines(lines, 0);
    expect(byPane['1'].ts).toBe(500);
    expect(byPane['1'].painted).toBe(true);
    expect(byPane['2'].ts).toBe(300);
  });

  test('parseFitTelemetryLines drops records older than sinceMs', () => {
    const lines = [JSON.stringify(rec('1', { ts: 100 }))];
    expect(parseFitTelemetryLines(lines, 200)['1']).toBeUndefined();
  });
});
