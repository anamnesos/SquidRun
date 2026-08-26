'use strict';

/**
 * ORACLE CONTRACTS (green-against-shipped, Builder #57 handshake): the five
 * behavior semantics pinned so refactors cannot silently change them.
 * Engine-level where the semantics live (pure logic, no DOM); runtime-level
 * for the no-mount honesty paths. RESIDUAL GAP (named, not hidden): full
 * pulse-coalescing and hidden-tab skip need a runtime mount harness that
 * does not exist yet — pinned here only via their engine/no-mount halves.
 */

const { createSquidCreature } = require('../modules/squid-room-creature-engine');
const runtime = require('../modules/squid-room-creature-runtime');

describe('contract: reduced-motion kill', () => {
  test('reduced motion means breathing only — no travel, no delight effects', () => {
    const c = createSquidCreature({ petId: 'builder', reducedMotion: true });
    const x0 = c.state.x;
    const y0 = c.state.y;
    c.delight(); // must no-op in reduced motion
    for (let i = 0; i < 200; i += 1) c.tick(16);
    expect(c.state.x).toBe(x0);
    expect(c.state.y).toBe(y0);
    expect(c.state.delightMs || 0).toBe(0);
    // Alive, not frozen: breath still animates.
    expect(Math.abs(c.state.breath)).toBeGreaterThan(0);
  });

  test('setReducedMotion(true) mid-flight halts travel from that frame on', () => {
    const c = createSquidCreature({ petId: 'oracle', reducedMotion: false });
    for (let i = 0; i < 60; i += 1) c.tick(16);
    c.setReducedMotion(true);
    const x = c.state.x;
    const y = c.state.y;
    for (let i = 0; i < 120; i += 1) c.tick(16);
    expect(c.state.x).toBe(x);
    expect(c.state.y).toBe(y);
  });
});

describe('contract: pointer never mutates activity', () => {
  test('awareness is not state: pointer feed + ticks leave activity untouched', () => {
    const c = createSquidCreature({ petId: 'builder' });
    c.setActivity('resting');
    c.setPointer(12, 34, 4);
    for (let i = 0; i < 100; i += 1) c.tick(16);
    expect(c.state.activity).toBe('resting');
    c.setPointer(null, null); // leave
    for (let i = 0; i < 20; i += 1) c.tick(16);
    expect(c.state.activity).toBe('resting');
  });
});

describe('contract: activity transitions are validated, honest, idempotent', () => {
  test('only the three honest states are accepted; junk is ignored', () => {
    const c = createSquidCreature({ petId: 'oracle' });
    c.setActivity('working');
    expect(c.state.activity).toBe('working');
    c.setActivity('partying'); // not a real state — must not take
    expect(c.state.activity).toBe('working');
    c.setActivity('');
    expect(c.state.activity).toBe('working');
  });

  test('same-value set does not re-arm the jet cadence (idempotent)', () => {
    const c = createSquidCreature({ petId: 'builder' });
    c.setActivity('working');
    const armed = c.state.nextJetInMs;
    c.setActivity('working'); // no-op by contract
    expect(c.state.nextJetInMs).toBe(armed);
  });
});

describe('contract: suspension semantics (engine half)', () => {
  test('a huge resume dt clamps to one 64ms step — no teleport after a hidden tab', () => {
    const a = createSquidCreature({ petId: 'builder' });
    const b = createSquidCreature({ petId: 'builder' });
    for (let i = 0; i < 30; i += 1) { a.tick(16); b.tick(16); }
    a.tick(5 * 60 * 1000); // five minutes hidden, one resume frame
    b.tick(64);            // the clamp ceiling
    // Same rng seed path (same petId + same tick count) -> identical result
    // proves the 5-minute dt was clamped to exactly the 64ms ceiling.
    expect(a.state.x).toBeCloseTo(b.state.x, 10);
    expect(a.state.y).toBeCloseTo(b.state.y, 10);
  });
});

describe('contract: comms pulse honesty (no-mount half)', () => {
  test('a pulse cannot exist without two real mounted creatures', () => {
    expect(runtime.notifySquidRoomComms('builder', 'oracle')).toBe(false);
    expect(runtime.notifySquidRoomComms('ghost', 'nobody')).toBe(false);
  });

  test('activity routing rejects unknown pets and junk motion classes', () => {
    expect(runtime.setSquidRoomCreatureActivity('ghost', 'is-active')).toBe(false);
    expect(runtime.ACTIVITY_BY_MOTION_CLASS['is-active']).toBe('working');
    expect(runtime.ACTIVITY_BY_MOTION_CLASS['is-resting']).toBe('resting');
    expect(Object.isFrozen(runtime.ACTIVITY_BY_MOTION_CLASS)).toBe(true);
  });

  test('faceToward (the pulse turn) targets a point for a bounded duration', () => {
    const c = createSquidCreature({ petId: 'oracle' });
    c.faceToward(500, 300, 1600);
    expect(c.state.faceTarget).toBeTruthy();
    expect(c.state.faceTarget.untilMs).toBeGreaterThan(c.state.elapsedMs);
  });
});
