'use strict';

/** Contracts for the lane registry + heartbeat decision core. */

const { applyLaneCommand } = require('../scripts/hm-lane');
const { decidePokes } = require('../scripts/hm-lane-heartbeat');

const MIN = 60000;

function freshLane(overrides = {}) {
  return {
    id: 'test-lane', owner: 'builder', objective: 'build the thing',
    status: 'open', openedAtMs: 0, updatedAtMs: 0, pokes: 0, lastPokeAtMs: 0, reason: null,
    ...overrides,
  };
}

describe('lane registry', () => {
  test('open/close/block lifecycle with honest blockers', () => {
    const state = { version: 1, lanes: {} };
    applyLaneCommand(state, 'open', 'L1', { owner: 'builder', objective: 'mount v2' }, 1000);
    expect(state.lanes.L1.status).toBe('open');
    expect(() => applyLaneCommand(state, 'block', 'L1', {}, 2000)).toThrow(/reason/);
    applyLaneCommand(state, 'block', 'L1', { reason: 'context floor' }, 2000);
    expect(state.lanes.L1.status).toBe('blocked');
    applyLaneCommand(state, 'reopen', 'L1', {}, 3000);
    expect(state.lanes.L1.pokes).toBe(0);
    applyLaneCommand(state, 'close', 'L1', { reason: 'shipped' }, 4000);
    expect(state.lanes.L1.status).toBe('done');
  });
});

describe('heartbeat decision core', () => {
  test('pokes an idle owner with an open lane', () => {
    const lanes = { L: freshLane({ id: 'L' }) };
    const { pokes } = decidePokes(lanes, { builder: 0 }, 10 * MIN, { idleMs: 8 * MIN });
    expect(pokes.map((l) => l.id)).toEqual(['L']);
  });

  test('does not poke an active owner', () => {
    const lanes = { L: freshLane() };
    const { pokes } = decidePokes(lanes, { builder: 9 * MIN }, 10 * MIN, { idleMs: 8 * MIN });
    expect(pokes).toEqual([]);
  });

  test('respects poke cooldown', () => {
    const lanes = { L: freshLane({ pokes: 1, lastPokeAtMs: 9 * MIN }) };
    const { pokes } = decidePokes(lanes, { builder: 0 }, 10 * MIN, { idleMs: 8 * MIN, cooldownMs: 7 * MIN });
    expect(pokes).toEqual([]);
  });

  test('owner activity after a poke resets escalation', () => {
    const lanes = { L: freshLane({ pokes: 2, lastPokeAtMs: 5 * MIN }) };
    // owner spoke at minute 6 (after the poke), now idle again but short of threshold
    const { pokes } = decidePokes(lanes, { builder: 6 * MIN }, 10 * MIN, { idleMs: 8 * MIN });
    expect(pokes).toEqual([]);
    expect(lanes.L.pokes).toBe(0); // reset because owner was seen after last poke
  });

  test('escalates to stall after max pokes with zero owner activity', () => {
    const lanes = { L: freshLane({ id: 'L', pokes: 3, lastPokeAtMs: 1 * MIN }) };
    const { pokes, stalls } = decidePokes(lanes, { builder: 0 }, 60 * MIN, { idleMs: 8 * MIN, maxPokes: 3 });
    expect(pokes).toEqual([]);
    expect(stalls.map((l) => l.id)).toEqual(['L']);
  });

  test('blocked and done lanes are never poked', () => {
    const lanes = {
      A: freshLane({ id: 'A', status: 'blocked' }),
      B: freshLane({ id: 'B', status: 'done' }),
    };
    const { pokes, stalls } = decidePokes(lanes, { builder: 0 }, 60 * MIN, { idleMs: 8 * MIN });
    expect(pokes).toEqual([]);
    expect(stalls).toEqual([]);
  });
});
