'use strict';

const {
  ACTIVITY_PROFILES,
  JET_PHASE,
  PALETTES,
  createRng,
  createSquidCreature,
} = require('../modules/squid-room-creature-engine');

function runMs(creature, ms, step = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    creature.tick(step);
  }
}

describe('squid room creature engine (P1.7)', () => {
  test('deterministic rng: same seed, same stream', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let index = 0; index < 20; index += 1) {
      expect(a()).toBe(b());
    }
  });

  test('identity: builder is blue-family, oracle is purple-family', () => {
    expect(PALETTES.builder.mantleMid).toMatch(/^#3a7bd6$/i);
    expect(PALETTES.oracle.mantleMid).toMatch(/^#7e57c8$/i);
    const builder = createSquidCreature({ petId: 'builder' });
    const oracle = createSquidCreature({ petId: 'oracle' });
    expect(builder.state.palette).toBe(PALETTES.builder);
    expect(oracle.state.palette).toBe(PALETTES.oracle);
  });

  test('jet propulsion: movement happens in bursts, never a constant slide', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 7 });
    creature.setBounds(400, 260);
    creature.setActivity('working');

    const speeds = [];
    for (let elapsed = 0; elapsed < 12000; elapsed += 16) {
      creature.tick(16);
      speeds.push(Math.hypot(creature.state.vx, creature.state.vy));
    }
    const peak = Math.max(...speeds);
    const calmSamples = speeds.filter((speed) => speed < peak * 0.2).length;
    // A jetting creature spends real time both fast and near-still.
    expect(peak).toBeGreaterThan(40);
    expect(calmSamples).toBeGreaterThan(speeds.length * 0.2);
  });

  test('the jet cycle squashes then stretches the mantle', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 3 });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    let minSquash = 1;
    let maxSquash = 1;
    for (let elapsed = 0; elapsed < 15000; elapsed += 16) {
      creature.tick(16);
      minSquash = Math.min(minSquash, creature.state.squash);
      maxSquash = Math.max(maxSquash, creature.state.squash);
    }
    expect(minSquash).toBeLessThan(0.92); // contraction
    expect(maxSquash).toBeGreaterThan(1.03); // burst stretch
  });

  test('creature stays inside its bounds under long simulation', () => {
    const creature = createSquidCreature({ petId: 'oracle', seed: 11 });
    creature.setBounds(320, 200);
    creature.setActivity('working');
    for (let elapsed = 0; elapsed < 60000; elapsed += 16) {
      creature.tick(16);
      expect(creature.state.x).toBeGreaterThanOrEqual(0);
      expect(creature.state.x).toBeLessThanOrEqual(320);
      expect(creature.state.y).toBeGreaterThanOrEqual(0);
      expect(creature.state.y).toBeLessThanOrEqual(200);
    }
  });

  test('tentacle chains keep their segment lengths (verlet constraints hold)', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 5 });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    runMs(creature, 8000);
    for (const tentacle of creature.state.tentacles) {
      for (let index = 1; index < tentacle.points.length; index += 1) {
        const prev = tentacle.points[index - 1];
        const point = tentacle.points[index];
        const distance = Math.hypot(point.x - prev.x, point.y - prev.y);
        // Constraint solver tolerance: within 35% of rest length.
        expect(distance).toBeGreaterThan(tentacle.segmentLength * 0.65);
        expect(distance).toBeLessThan(tentacle.segmentLength * 1.35);
      }
    }
  });

  test('separation spring breaks exact same-coordinate overlap deterministically', () => {
    const builder = createSquidCreature({ petId: 'builder', seed: 101 });
    const oracle = createSquidCreature({ petId: 'oracle', seed: 202 });
    builder.setBounds(400, 260);
    oracle.setBounds(400, 260);

    expect(builder.state.x).toBe(oracle.state.x);
    expect(builder.state.y).toBe(oracle.state.y);

    builder.setNeighbor(oracle.state.x, oracle.state.y);
    oracle.setNeighbor(builder.state.x, builder.state.y);
    builder.tick(16);
    oracle.tick(16);

    expect(builder.state.vx).toBeGreaterThan(0);
    expect(oracle.state.vx).toBeLessThan(0);
  });

  test('banking: heading follows the velocity vector while moving', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 13 });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    let checked = 0;
    for (let elapsed = 0; elapsed < 20000; elapsed += 16) {
      creature.tick(16);
      const speed = Math.hypot(creature.state.vx, creature.state.vy);
      if (speed > 60) {
        const velAngle = Math.atan2(creature.state.vy, creature.state.vx);
        let delta = Math.abs(creature.state.heading - velAngle) % (Math.PI * 2);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        expect(delta).toBeLessThan(Math.PI / 2); // nose within 90deg of travel
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('activity drives behavior honestly: working jets more than resting', () => {
    const measure = (activity) => {
      const creature = createSquidCreature({ petId: 'builder', seed: 21 });
      creature.setBounds(400, 260);
      creature.setActivity(activity);
      let travel = 0;
      let lastX = creature.state.x;
      let lastY = creature.state.y;
      for (let elapsed = 0; elapsed < 30000; elapsed += 16) {
        creature.tick(16);
        travel += Math.hypot(creature.state.x - lastX, creature.state.y - lastY);
        lastX = creature.state.x;
        lastY = creature.state.y;
      }
      return travel;
    };
    const working = measure('working');
    const resting = measure('resting');
    expect(working).toBeGreaterThan(resting * 2);
  });

  test('eye glow tracks activity profile', () => {
    const creature = createSquidCreature({ petId: 'oracle', seed: 9 });
    creature.setActivity('working');
    runMs(creature, 4000);
    const workingGlow = creature.state.eyeGlow;
    creature.setActivity('resting');
    runMs(creature, 6000);
    expect(workingGlow).toBeGreaterThan(0.9);
    expect(creature.state.eyeGlow).toBeLessThan(0.6);
    expect(ACTIVITY_PROFILES.working.eyeGlow).toBeGreaterThan(ACTIVITY_PROFILES.resting.eyeGlow);
  });

  test('celebrate() spawns an ink burst that decays and never accumulates', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 15 });
    creature.celebrate();
    expect(creature.state.inkBursts.length).toBe(1);
    runMs(creature, 2500);
    expect(creature.state.inkBursts.length).toBe(0);
  });

  test('jet bursts emit bubbles and the pool is capped', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 17 });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    let sawBubbles = false;
    for (let elapsed = 0; elapsed < 20000; elapsed += 16) {
      creature.tick(16);
      if (creature.state.bubbles.length > 0) sawBubbles = true;
      expect(creature.state.bubbles.length).toBeLessThanOrEqual(48);
    }
    expect(sawBubbles).toBe(true);
  });

  test('reduced motion: no travel, no effects - breathing and eyes only', () => {
    const creature = createSquidCreature({ petId: 'builder', seed: 19, reducedMotion: true });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    const startX = creature.state.x;
    const startY = creature.state.y;
    runMs(creature, 10000);
    expect(creature.state.x).toBe(startX);
    expect(creature.state.y).toBe(startY);
    expect(creature.state.bubbles.length).toBe(0);
    expect(creature.state.jetPhase).toBe(JET_PHASE.DRIFT);
  });

  test('draw() renders through a mock 2D context without throwing', () => {
    const creature = createSquidCreature({ petId: 'oracle', seed: 23 });
    creature.setBounds(400, 260);
    creature.setActivity('working');
    runMs(creature, 3000);
    creature.celebrate();
    runMs(creature, 200);

    const gradient = { addColorStop: jest.fn() };
    const calls = { ops: 0 };
    const ctx = new Proxy({}, {
      get(target, prop) {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => gradient;
        }
        return (...args) => { calls.ops += 1; return undefined; };
      },
      set() { return true; },
    });
    expect(() => creature.draw(ctx)).not.toThrow();
    expect(calls.ops).toBeGreaterThan(50);
  });
});
