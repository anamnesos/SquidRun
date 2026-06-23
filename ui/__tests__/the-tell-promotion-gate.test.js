'use strict';

const { evaluatePromotionGate, PROMOTION } = require('../modules/the-tell/promotion-gate');

const DAY = 86400000;
const NOW = 1_800_000_000_000;
const dAgo = (n) => NOW - n * DAY;
const OVERDUE = 'trustquote:invoice-aging';
const TASKS = 'trustquote:job-tasks-incomplete';

const spoke = (signalClass, verdict, tsDaysAgo) => ({
  ts: dAgo(tsDaysAgo), type: 'spoke', signalClass, key: `k${tsDaysAgo}`,
  claim: 'x', regretScore: 0.9, verify: { docId: 'd' },
  review: verdict === 'pending' ? { verdict: 'pending' } : { verdict, by: 'architect', at: dAgo(tsDaysAgo - 0.1) },
});
// liveness ticks the runner appends every tick (incl. silent ones); default 12h spacing < 25h tolerance
const tickRows = (shadowDaysAgo, stepHours = 12) => {
  const rows = [];
  for (let t = dAgo(shadowDaysAgo); t <= NOW; t += stepHours * 3600000) rows.push({ ts: t, type: 'tick', intervalMs: 20 * 60000 });
  if (rows.length === 0 || rows[rows.length - 1].ts < NOW) rows.push({ ts: NOW, type: 'tick', intervalMs: 20 * 60000 });
  return rows;
};
// by default the window is continuously observed (ticks present); pass { noTicks } or custom ticks to break it
const ledger = (shadowDaysAgo, rows, opts = {}) => ({
  shadowStartedAtMs: dAgo(shadowDaysAgo),
  rows: [...(opts.ticks ? opts.ticks : (opts.noTicks ? [] : tickRows(shadowDaysAgo))), ...rows],
});
const run = (lg, over = {}) => evaluatePromotionGate(lg, { nowMs: NOW, ...over });

describe('Rung-2 promotion gate — evidence-forced, a query over the ledger (no gut)', () => {
  test('PROMOTES a class once shadow >=7d, all reviewed, zero false-alarms, >=1 useful', () => {
    const out = run(ledger(8, [
      spoke(OVERDUE, 'useful', 5),
      spoke(OVERDUE, 'real_catch', 3),
      spoke(OVERDUE, 'useful', 1),
    ]));
    expect(out.perClass[OVERDUE].promotable).toBe(true);
    expect(out.promote).toContain(OVERDUE);
  });

  test('BLOCKS under 7 shadow days even with perfect rows', () => {
    const out = run(ledger(5, [spoke(OVERDUE, 'useful', 4), spoke(OVERDUE, 'useful', 1)]));
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[OVERDUE].blockers.some((b) => /under_7d/.test(b))).toBe(true);
  });

  test('BLOCKS on a false-alarm in the trailing window (it cried wolf)', () => {
    const out = run(ledger(9, [spoke(OVERDUE, 'useful', 5), spoke(OVERDUE, 'false_alarm', 2)]));
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[OVERDUE].blockers).toContain('1_false_alarms_in_window');
  });

  test('a false-alarm AGES OUT: fixed >7d ago + a clean trailing window -> promotes (not parking)', () => {
    // false_alarm 10 days ago (outside the 7d window), clean useful rows since
    const out = run(ledger(12, [
      spoke(OVERDUE, 'false_alarm', 10),
      spoke(OVERDUE, 'useful', 5),
      spoke(OVERDUE, 'useful', 1),
    ]));
    expect(out.perClass[OVERDUE].promotable).toBe(true);
  });

  test('BLOCKS on any unreviewed (pending) row — could hide a false-alarm', () => {
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5), spoke(OVERDUE, 'pending', 2)]));
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[OVERDUE].blockers).toContain('1_unreviewed_spoke_rows');
  });

  test('BLOCKS when correct-but-never-useful — real_catch only, no useful catch yet', () => {
    const out = run(ledger(8, [spoke(OVERDUE, 'real_catch', 5), spoke(OVERDUE, 'real_catch', 2)]));
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[OVERDUE].blockers).toContain('no_useful_catch_in_window');
  });

  test('PER-CLASS independence: overdue clears, tasks blocked on its own pending row', () => {
    const out = run(ledger(8, [
      spoke(OVERDUE, 'useful', 4),
      spoke(TASKS, 'pending', 2),
    ]));
    expect(out.promote).toEqual([OVERDUE]);
    expect(out.perClass[TASKS].promotable).toBe(false);
  });

  test('a class with NO rows is not promotable (no useful catch to earn it)', () => {
    const out = run(ledger(30, []));
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[TASKS].promotable).toBe(false);
    expect(out.promote).toEqual([]);
  });
});

describe('our-concept classes have no app-truth oracle — never promoted by this gate', () => {
  test('margin/collision spokes land in blockedNoOracle, never in promote', () => {
    const out = run(ledger(30, [
      spoke('trustquote:job-margin', 'useful', 3),
      spoke('promise:collision', 'useful', 2),
      spoke(OVERDUE, 'useful', 1),
    ]));
    expect(out.blockedNoOracle).toEqual(expect.arrayContaining(['trustquote:job-margin', 'promise:collision']));
    expect(out.promote).not.toContain('trustquote:job-margin');
    expect(out.promote).not.toContain('promise:collision');
  });

  test('exposes the locked verdict vocabulary so feed + review + gate agree', () => {
    expect(PROMOTION.VERDICTS).toEqual(['useful', 'real_catch', 'false_alarm', 'pending']);
    expect(PROMOTION.ORACLE_BACKED_CLASSES).toContain(OVERDUE);
    expect(PROMOTION.ORACLE_BACKED_CLASSES).toContain(TASKS);
  });
});

describe('observation continuity — never CERTIFY trust on dead time (the HIGH audit finding)', () => {
  test('BLOCKS when the window has NO liveness ticks (runner never proved it was watching)', () => {
    // perfect-looking evidence but zero observation proof = could be 7 days of a dead runner
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5), spoke(OVERDUE, 'useful', 1)], { noTicks: true }));
    expect(out.continuouslyObserved).toBe(false);
    expect(out.perClass[OVERDUE].promotable).toBe(false);
    expect(out.perClass[OVERDUE].blockers.some((b) => /not_continuously_observed/.test(b))).toBe(true);
  });

  test('THE SILENT-STALL: runner died mid-window (ticks stop 2 days ago) -> trailing gap blocks promotion', () => {
    // ticks for the first part of the window, then nothing for the last ~2 days = a dead runner
    const ticks = [];
    for (let t = dAgo(8); t <= dAgo(2); t += 12 * 3600000) ticks.push({ ts: t, type: 'tick', intervalMs: 20 * 60000 });
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5)], { ticks }));
    expect(out.continuouslyObserved).toBe(false);
    expect(out.observation.reason).toBe('observation_gap_exceeds_tolerance');
    expect(out.perClass[OVERDUE].promotable).toBe(false);
  });

  test('BLOCKS on a multi-day hole in the middle of the window', () => {
    const ticks = [
      { ts: dAgo(8), type: 'tick' }, { ts: dAgo(7), type: 'tick' },
      // 4-day hole here
      { ts: dAgo(3), type: 'tick' }, { ts: dAgo(1), type: 'tick' }, { ts: NOW, type: 'tick' },
    ];
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5)], { ticks }));
    expect(out.continuouslyObserved).toBe(false);
    expect(out.perClass[OVERDUE].promotable).toBe(false);
  });

  test('TOLERATES an overnight sleep (gap < 25h) and still promotes when continuously-enough observed', () => {
    // ticks every ~20h (a nightly sleep) span the window — under the 25h tolerance
    const ticks = [];
    for (let t = dAgo(8); t <= NOW; t += 20 * 3600000) ticks.push({ ts: t, type: 'tick' });
    ticks.push({ ts: NOW, type: 'tick' });
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5), spoke(OVERDUE, 'useful', 1)], { ticks }));
    expect(out.continuouslyObserved).toBe(true);
    expect(out.perClass[OVERDUE].promotable).toBe(true);
  });

  test('continuity is gate-wide: a dead window blocks EVERY class, even a perfectly-reviewed one', () => {
    const out = run(ledger(8, [spoke(OVERDUE, 'useful', 5), spoke(TASKS, 'useful', 4)], { noTicks: true }));
    expect(out.promote).toEqual([]);
  });
});
