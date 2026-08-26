'use strict';

/**
 * CONTRACTS-FIRST (Oracle, honesty-audit defects #1 + #2 — fake "All agents
 * running" + freeze-green heartbeat). Builder implements INTO these.
 *
 * >>> REMOVE the .skip on the describe below when implementing. <<<
 *
 * Spec agreed Builder #46 / Oracle #193:
 * - Status is asserted only from evidence that can EXPIRE: the liveness
 *   poll (readDaemonTerminalForPane alive===true). Spawn results only SEED.
 * - Banner text is COUNTED: "N/M agents live"; a dead pane is NAMED by id.
 * - A poll gone silent past staleAfterMs -> tone 'stale' (amber), never
 *   silently green.
 * - The heartbeat indicator reuses the SAME staleness helper.
 *
 * Expected module: ui/modules/agent-liveness-status.js exporting
 *   createLivenessStatus({ staleAfterMs }) -> { seed, recordPoll, report }
 *   isStale(lastEventMs, nowMs, staleAfterMs) -> boolean   (shared helper)
 */

describe('agent liveness status — the green that cannot lie', () => {
  const { createLivenessStatus, isStale } = require('../modules/agent-liveness-status');

  test('all panes polling alive -> counted green, no dead panes', () => {
    const s = createLivenessStatus({ staleAfterMs: 10000 });
    s.seed(['1', '2', '3']);
    for (const id of ['1', '2', '3']) s.recordPoll(id, { alive: true }, 1000);
    const r = s.report(2000);
    expect(r.text).toBe('3/3 agents live');
    expect(r.tone).toBe('ok');
    expect(r.deadPaneIds).toEqual([]);
  });

  test('a dead pane is COUNTED OUT and NAMED — never absorbed into green', () => {
    const s = createLivenessStatus({ staleAfterMs: 10000 });
    s.seed(['1', '2', '3']);
    s.recordPoll('1', { alive: true }, 1000);
    s.recordPoll('2', { alive: false }, 1000);
    s.recordPoll('3', { alive: true }, 1000);
    const r = s.report(2000);
    expect(r.text).toContain('2/3 agents live');
    expect(r.text).toContain('2'); // dead pane named by id in the banner
    expect(r.tone).toBe('degraded');
    expect(r.deadPaneIds).toEqual(['2']);
  });

  test('spawn success alone NEVER produces green — seeding is not evidence', () => {
    const s = createLivenessStatus({ staleAfterMs: 10000 });
    s.seed(['1', '2', '3']); // spawn returned ok for all three...
    const r = s.report(500); // ...but no poll has confirmed anything yet
    expect(r.tone).not.toBe('ok');
    expect(r.text).not.toMatch(/3\/3 agents live$/);
  });

  test('silent poll past staleAfterMs -> amber stale, last counts kept but marked', () => {
    const s = createLivenessStatus({ staleAfterMs: 10000 });
    s.seed(['1', '2']);
    s.recordPoll('1', { alive: true }, 1000);
    s.recordPoll('2', { alive: true }, 1000);
    expect(s.report(5000).tone).toBe('ok');
    const stale = s.report(12001); // poller died: no data for > staleAfterMs
    expect(stale.tone).toBe('stale');
    expect(stale.text.toLowerCase()).toContain('stale');
  });

  test('recovery: fresh poll after staleness returns to counted truth', () => {
    const s = createLivenessStatus({ staleAfterMs: 10000 });
    s.seed(['1']);
    s.recordPoll('1', { alive: true }, 1000);
    expect(s.report(20000).tone).toBe('stale');
    s.recordPoll('1', { alive: true }, 21000);
    const r = s.report(21500);
    expect(r.tone).toBe('ok');
    expect(r.text).toBe('1/1 agents live');
  });

  test('shared staleness helper: the heartbeat indicator derives amber from it', () => {
    expect(isStale(1000, 5000, 10000)).toBe(false);
    expect(isStale(1000, 11001, 10000)).toBe(true);
    expect(isStale(1000, 11000, 10000)).toBe(false); // boundary: exactly at limit is fresh
    // NaN last-event (no event ever) is stale, not fresh — absence of
    // evidence must never render green (the freeze-green heartbeat defect).
    expect(isStale(NaN, 5000, 10000)).toBe(true);
  });
});

// >>> REMOVE .skip when taking the per-pane staleness fix (Oracle #195). <<<
// Gate finding on the 6/6 module: staleness is GLOBAL (lastPollAt), so a
// half-dead poller (pane 1 fresh, pane 2 silent for minutes) keeps counting
// pane 2's ancient alive=true as live. A pane's own evidence must expire.
test('per-pane evidence expires: a pane not polled past staleAfterMs cannot count live', () => {
  const { createLivenessStatus } = require('../modules/agent-liveness-status');
  const s = createLivenessStatus({ staleAfterMs: 10000 });
  s.seed(['1', '2']);
  s.recordPoll('1', { alive: true }, 1000);
  s.recordPoll('2', { alive: true }, 1000);
  // pane 1 keeps polling fresh; pane 2 goes silent
  s.recordPoll('1', { alive: true }, 30000);
  const r = s.report(30500);
  expect(r.tone).not.toBe('ok');           // must not be clean green
  expect(r.text).not.toBe('2/2 agents live'); // pane 2's evidence expired
});
