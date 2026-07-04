'use strict';

/**
 * S467 born-blind fix: promise:collision consumed availableWindows /
 * existingBusyMin that no producer created — structurally silent forever.
 * These contracts pin the producer AND the end-to-end sight restoration.
 */
const { buildScheduleCollisionFact } = require('../modules/main/trustquote-tell-feed');

const DAY = 24 * 3600000;
function evt(id, startMs, hours, jobId) {
  return {
    id,
    collection: 'calendar-events',
    data: {
      status: 'scheduled', jobId,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + hours * 3600000).toISOString(),
      customerId: `cust-${id}`, title: `job ${id}`,
    },
  };
}

test('producer emits work-hour capacity windows and explicit busy accounting', () => {
  const nowMs = new Date('2026-07-06T15:00:00Z').getTime(); // a Monday
  const fact = buildScheduleCollisionFact([evt('a', nowMs + DAY, 3, 'j1'), evt('b', nowMs + 2 * DAY, 4, 'j2')], nowMs, 'live', []);
  expect(fact).not.toBeNull();
  expect(Array.isArray(fact.facts.availableWindows)).toBe(true);
  expect(fact.facts.availableWindows.length).toBeGreaterThan(0);
  expect(fact.facts.existingBusyMin).toBe(0); // by construction: busy time rides commitments
  for (const w of fact.facts.availableWindows) {
    expect(w.endMs).toBeGreaterThan(w.startMs);
    expect(w.startMs).toBeGreaterThanOrEqual(nowMs - DAY); // never in the deep past
    expect(new Date(w.startMs).getDay()).not.toBe(0); // Sundays off
  }
});

test('windows are GENEROUS: two comfortable bookings must remain feasible (no false collision)', () => {
  const { collisionFeasibility } = (() => {
    // consume through the scorer's own math: read it from source (source of truth)
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'the-tell', 'scorer.js'), 'utf8');
    const fn = src.match(/function collisionFeasibility[\s\S]*?\n}/)[0];
    return new Function('isNum', fn + '; return { collisionFeasibility };')(Number.isFinite);
  })();
  const nowMs = new Date('2026-07-06T15:00:00Z').getTime();
  const fact = buildScheduleCollisionFact([evt('a', nowMs + DAY, 3, 'j1'), evt('b', nowMs + 2 * DAY, 4, 'j2')], nowMs, 'live', []);
  const hard = fact.facts.commitments.map((c) => ({ dueMs: c.endMs, durationMin: c.durationMin }));
  const feas = collisionFeasibility(hard, fact.facts.availableWindows, fact.facts.existingBusyMin, nowMs);
  expect(feas.feasible).toBe(true); // 7h of work in 2 days of 10h windows: never a collision
});
