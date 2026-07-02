'use strict';

/**
 * Procedural squid creature engine (S463 P1.7).
 *
 * Replaces the sprite-atlas pets with living, physics-driven creatures while
 * PRESERVING their identity: round mantle, dark robot visor with glowing
 * eyes, Builder=blue / Oracle=purple, bioluminescent vibe.
 *
 * Pure logic + canvas-2D drawing against an injected context: no DOM access
 * at module level, no timers of its own - the host owns requestAnimationFrame
 * and calls tick(dt)/draw(ctx). That keeps the whole engine unit-testable in
 * node and the render loop pausable (document.hidden, reduced motion).
 *
 * Motion model (the "alive" core):
 * - JET PROPULSION: squids move like squids. A jet cycle contracts the mantle
 *   (squash) -> burst of acceleration + bubble puff -> long glide (stretch
 *   decaying to rest) -> drift. Never linear slides.
 * - TENTACLE PHYSICS: 8 verlet chains anchored under the mantle TRAIL the
 *   body, undulate while gliding, splay on braking, stream on darts.
 * - BANKING TURNS: heading eases toward the velocity vector; bank/roll
 *   follows signed turn rate. No paper-flip anywhere.
 * - MICRO-LIFE: mantle breathing at idle, eye blinks + saccades, tentacle
 *   curl when "thinking", eye glow tracks activity.
 *
 * Activity states are HONEST SIGNALS (constitution): the host maps real
 * output age to 'working' | 'settling' | 'resting'; celebrations fire only
 * for real ledger events via celebrate().
 */

const TWO_PI = Math.PI * 2;

const PALETTES = Object.freeze({
  builder: Object.freeze({
    mantleTop: '#5ac8f0',
    mantleMid: '#2f7fd0',
    mantleDeep: '#1b4f96',
    rim: 'rgba(120, 226, 255, 0.85)',
    finMembrane: 'rgba(90, 190, 240, 0.55)',
    tentacle: '#2e6fc0',
    tentacleTip: '#9fdcff',
    visor: '#0a1220',
    visorRim: 'rgba(190, 216, 240, 0.8)',
    eye: '#25f0e2',
    eyeCore: '#eaffff',
    glow: 'rgba(60, 190, 255, 0.34)',
    ink: 'rgba(16, 42, 80, 0.85)',
  }),
  oracle: Object.freeze({
    mantleTop: '#b18ae8',
    mantleMid: '#7e57c8',
    mantleDeep: '#4d2f8c',
    rim: 'rgba(214, 178, 255, 0.85)',
    finMembrane: 'rgba(178, 140, 235, 0.55)',
    tentacle: '#6d4ab8',
    tentacleTip: '#ddc2ff',
    visor: '#100a1e',
    visorRim: 'rgba(214, 198, 240, 0.8)',
    eye: '#7fd8ff',
    eyeCore: '#f4fbff',
    glow: 'rgba(150, 110, 255, 0.32)',
    ink: 'rgba(40, 20, 78, 0.85)',
  }),
});

const ACTIVITY_PROFILES = Object.freeze({
  working: Object.freeze({
    jetIntervalMs: [1100, 2400],
    jetImpulse: [130, 190],
    eyeGlow: 1,
    driftLift: 0,
    retargetEagerness: 1,
    undulation: 1,
    breathing: 0.55,
  }),
  settling: Object.freeze({
    jetIntervalMs: [2600, 5200],
    jetImpulse: [70, 120],
    eyeGlow: 0.72,
    driftLift: 0,
    retargetEagerness: 0.55,
    undulation: 0.7,
    breathing: 0.8,
  }),
  resting: Object.freeze({
    jetIntervalMs: [7000, 14000],
    jetImpulse: [34, 60],
    eyeGlow: 0.42,
    driftLift: 8,
    retargetEagerness: 0.2,
    undulation: 0.4,
    breathing: 1,
  }),
});

const JET_PHASE = Object.freeze({
  DRIFT: 'drift',
  CONTRACT: 'contract',
  BURST: 'burst',
  GLIDE: 'glide',
});

// Deterministic PRNG (mulberry32): replays and tests stay reproducible, and
// nothing in the engine calls Math.random directly.
function createRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return value < min ? min : (value > max ? max : value);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function angleLerp(from, to, t) {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

function normalizeAngle(angle) {
  let normalized = angle % TWO_PI;
  if (normalized > Math.PI) normalized -= TWO_PI;
  if (normalized < -Math.PI) normalized += TWO_PI;
  return normalized;
}

function rangePick(rng, [min, max]) {
  return min + rng() * (max - min);
}

function createTentacle(rng, {
  segments = 9,
  segmentLength = 9,
  spread = 0,
} = {}) {
  const points = [];
  for (let index = 0; index < segments; index += 1) {
    points.push({ x: 0, y: index * segmentLength, px: 0, py: index * segmentLength });
  }
  return {
    points,
    segmentLength,
    spread,
    phase: rng() * TWO_PI,
    curl: 0,
  };
}

function createSquidCreature(options = {}) {
  const petId = options.petId === 'oracle' ? 'oracle' : 'builder';
  const palette = PALETTES[petId];
  const rng = createRng(Number(options.seed) || (petId === 'oracle' ? 1013 : 509));
  const tentacleCount = clamp(Number(options.tentacleCount) || 8, 6, 8);

  const state = {
    petId,
    palette,
    activity: 'settling',
    bounds: { width: 320, height: 220 },
    // Body kinematics.
    x: 160,
    y: 110,
    vx: 0,
    vy: 0,
    heading: -Math.PI / 2,
    bank: 0,
    lean: 0,
    // Jet cycle.
    jetPhase: JET_PHASE.DRIFT,
    jetPhaseMs: 0,
    nextJetInMs: 1800,
    squash: 1,
    breath: 0,
    breathPhase: rng() * TWO_PI,
    // Target wandering.
    targetX: 160,
    targetY: 110,
    // Eyes.
    blink: 0,
    nextBlinkInMs: 2200 + rng() * 2600,
    saccade: { x: 0, y: 0 },
    nextSaccadeInMs: 900,
    eyeGlow: 0.72,
    // Effects.
    bubbles: [],
    inkBursts: [],
    celebrateMs: 0,
    thinkingCurl: 0,
    elapsedMs: 0,
    reducedMotion: options.reducedMotion === true,
    tentacles: Array.from({ length: tentacleCount }, (_, index) => createTentacle(rng, {
      spread: (index - (tentacleCount - 1) / 2) / ((tentacleCount - 1) / 2),
      segments: 9,
      segmentLength: 8 + rng() * 2.4,
    })),
  };

  function profile() {
    return ACTIVITY_PROFILES[state.activity] || ACTIVITY_PROFILES.settling;
  }

  function setBounds(width, height) {
    state.bounds.width = Math.max(80, Number(width) || state.bounds.width);
    state.bounds.height = Math.max(60, Number(height) || state.bounds.height);
    state.x = clamp(state.x, 20, state.bounds.width - 20);
    state.y = clamp(state.y, 20, state.bounds.height - 20);
  }

  function setActivity(activity) {
    if (activity !== 'working' && activity !== 'settling' && activity !== 'resting') return;
    if (state.activity === activity) return;
    state.activity = activity;
    // Re-arm the jet cadence on state change so behavior shifts visibly soon.
    state.nextJetInMs = Math.min(state.nextJetInMs, rangePick(rng, profile().jetIntervalMs) * 0.4);
  }

  function celebrate() {
    state.celebrateMs = 1500;
    state.inkBursts.push({
      x: state.x,
      y: state.y,
      ageMs: 0,
      lifeMs: 1400,
      radius: 6,
      seed: rng() * TWO_PI,
    });
  }

  function pickTarget() {
    const margin = 34;
    const { width, height } = state.bounds;
    const lift = profile().driftLift;
    state.targetX = margin + rng() * (width - margin * 2);
    state.targetY = clamp(
      margin + rng() * (height - margin * 2) + lift,
      margin,
      height - margin * 0.6
    );
  }

  function beginJet() {
    // Aim the jet: heading turns toward the target during CONTRACT.
    state.jetPhase = JET_PHASE.CONTRACT;
    state.jetPhaseMs = 0;
  }

  function spawnJetBubbles(strength) {
    const count = 3 + Math.round(rng() * 3 * strength);
    for (let index = 0; index < count; index += 1) {
      const back = state.heading + Math.PI + (rng() - 0.5) * 0.9;
      state.bubbles.push({
        x: state.x + Math.cos(back) * 16,
        y: state.y + Math.sin(back) * 16,
        vx: Math.cos(back) * (14 + rng() * 22) * 0.4,
        vy: Math.sin(back) * (14 + rng() * 22) * 0.4 - 12,
        radius: 1.2 + rng() * 2.6,
        ageMs: 0,
        lifeMs: 1400 + rng() * 1200,
      });
    }
  }

  function tickJetCycle(dtMs) {
    const prof = profile();
    state.jetPhaseMs += dtMs;
    switch (state.jetPhase) {
      case JET_PHASE.DRIFT: {
        state.nextJetInMs -= dtMs;
        state.squash = lerp(state.squash, 1, 0.04);
        if (state.nextJetInMs <= 0) {
          if (rng() < prof.retargetEagerness) pickTarget();
          beginJet();
        }
        break;
      }
      case JET_PHASE.CONTRACT: {
        const t = clamp(state.jetPhaseMs / 260, 0, 1);
        state.squash = lerp(state.squash, 0.84, 0.28);
        const targetAngle = Math.atan2(state.targetY - state.y, state.targetX - state.x);
        state.heading = angleLerp(state.heading, targetAngle, 0.16);
        if (t >= 1) {
          state.jetPhase = JET_PHASE.BURST;
          state.jetPhaseMs = 0;
          const impulse = rangePick(rng, prof.jetImpulse);
          state.vx += Math.cos(state.heading) * impulse;
          state.vy += Math.sin(state.heading) * impulse;
          spawnJetBubbles(impulse / 160);
        }
        break;
      }
      case JET_PHASE.BURST: {
        state.squash = lerp(state.squash, 1.1, 0.3);
        if (state.jetPhaseMs >= 180) {
          state.jetPhase = JET_PHASE.GLIDE;
          state.jetPhaseMs = 0;
        }
        break;
      }
      case JET_PHASE.GLIDE:
      default: {
        state.squash = lerp(state.squash, 1, 0.02);
        if (state.jetPhaseMs >= 900) {
          state.jetPhase = JET_PHASE.DRIFT;
          state.jetPhaseMs = 0;
          state.nextJetInMs = rangePick(rng, prof.jetIntervalMs);
        }
        break;
      }
    }
  }

  function tickBody(dtMs) {
    const dt = dtMs / 1000;
    // Water drag: gliding decays smoothly toward drift.
    const drag = Math.pow(0.24, dt);
    state.vx *= drag;
    state.vy *= drag;
    // Gentle buoyancy wobble.
    state.vy += Math.sin(state.elapsedMs / 1600 + state.breathPhase) * 1.4 * dt;

    state.x += state.vx * dt;
    state.y += state.vy * dt;

    // Soft wall repulsion keeps the creature inside its water region.
    const margin = 26;
    const { width, height } = state.bounds;
    if (state.x < margin) state.vx += (margin - state.x) * 3.2 * dt * 10;
    if (state.x > width - margin) state.vx -= (state.x - (width - margin)) * 3.2 * dt * 10;
    if (state.y < margin) state.vy += (margin - state.y) * 3.2 * dt * 10;
    if (state.y > height - margin) state.vy -= (state.y - (height - margin)) * 3.2 * dt * 10;
    state.x = clamp(state.x, 8, width - 8);
    state.y = clamp(state.y, 8, height - 8);

    // Banking: nose follows the velocity vector while moving; bank angle
    // follows the signed turn rate and eases out in drift.
    const speed = Math.hypot(state.vx, state.vy);
    if (speed > 6) {
      const velAngle = Math.atan2(state.vy, state.vx);
      const before = state.heading;
      state.heading = angleLerp(state.heading, velAngle, clamp(speed / 140, 0.04, 0.18));
      let turnRate = (state.heading - before);
      if (turnRate > Math.PI) turnRate -= TWO_PI;
      if (turnRate < -Math.PI) turnRate += TWO_PI;
      state.bank = lerp(state.bank, clamp(turnRate * 30, -0.5, 0.5), 0.12);
    } else {
      state.bank = lerp(state.bank, 0, 0.06);
    }

    // Visual lean: the BODY never somersaults - it stays near upright and
    // LEANS into the travel direction (aquarium-creature standard). Full
    // heading rotation made downward swims read upside-down; sin() of the
    // crown-relative angle gives max lean on horizontal travel, zero on pure
    // vertical, and no wrap discontinuity anywhere. The paper-flip stays
    // dead: orientation changes are continuous by construction.
    const leanTarget = 0.6 * Math.sin(normalizeAngle(state.heading + Math.PI / 2));
    state.lean = lerp(state.lean ?? 0, leanTarget, clamp(speed / 200, 0.02, 0.12));

    // Mantle breathing (micro-life) - stronger at rest.
    state.breathPhase += dtMs / 1000;
    state.breath = Math.sin(state.breathPhase * (state.activity === 'resting' ? 1.4 : 2.2))
      * 0.035 * profile().breathing;
  }

  function tickTentacles(dtMs) {
    const dt = clamp(dtMs / 1000, 0.001, 0.05);
    const prof = profile();
    const speed = Math.hypot(state.vx, state.vy);
    const streaming = clamp(speed / 120, 0, 1);
    state.thinkingCurl = lerp(
      state.thinkingCurl,
      state.activity === 'working' && state.jetPhase === JET_PHASE.DRIFT ? 1 : 0,
      0.03
    );

    // Anchors live on the mantle OPENING (the rim under the body): body-local
    // ring at y=+16, spread across x, rotated into world space by the VISUAL
    // lean (the body never somersaults). Tentacles must sprout from under
    // the skirt, never from the crown.
    const bodyRotation = (state.lean || 0) + state.bank;
    const cosR = Math.cos(bodyRotation);
    const sinR = Math.sin(bodyRotation);

    for (const tentacle of state.tentacles) {
      tentacle.phase += dt * (1.6 + streaming * 2.2) * prof.undulation;
      const spreadAngle = bodyRotation + Math.PI / 2 + tentacle.spread * lerp(0.8, 0.25, streaming);
      const localX = tentacle.spread * 17 * state.squash;
      const localY = 16 * (2 - state.squash);
      const anchorX = state.x + localX * cosR - localY * sinR;
      const anchorY = state.y + localX * sinR + localY * cosR;

      const points = tentacle.points;
      // Verlet integrate all but the anchor.
      for (let index = 1; index < points.length; index += 1) {
        const point = points[index];
        const nx = point.x + (point.x - point.px) * 0.9;
        const ny = point.y + (point.y - point.py) * 0.9;
        point.px = point.x;
        point.py = point.y;
        point.x = nx;
        point.y = ny + 14 * dt; // faint sink = water weight
        // Undulation: perpendicular sway along the chain while gliding.
        // Calm amplitudes - tentacles should ripple, never tangle.
        const sway = Math.sin(tentacle.phase + index * 0.5)
          * (0.28 + streaming * 0.7) * prof.undulation
          * (index / points.length);
        point.x += Math.cos(spreadAngle + Math.PI / 2) * sway;
        point.y += Math.sin(spreadAngle + Math.PI / 2) * sway;
        // Fan hold: each arm has a rest line fanning out from its anchor -
        // a soft pull toward it keeps the eight arms ORGANIZED as a loose
        // cone instead of tangling like wet hair. Streaming releases the
        // hold so darts still sweep the arms into a trailing bundle.
        const restX = anchorX + Math.cos(spreadAngle) * index * tentacle.segmentLength * 0.92;
        const restY = anchorY + Math.sin(spreadAngle) * index * tentacle.segmentLength * 0.92;
        // Slightly firmer toward the tips so ends settle instead of fraying.
        const holdStrength = (0.035 + 0.03 * (index / points.length)) * (1 - streaming * 0.8);
        point.x += (restX - point.x) * holdStrength;
        point.y += (restY - point.y) * holdStrength;
        // Thinking curl: tips pull inward slightly.
        if (state.thinkingCurl > 0.05 && index > points.length - 4) {
          point.x += (anchorX - point.x) * 0.012 * state.thinkingCurl;
          point.y += (anchorY - point.y) * 0.012 * state.thinkingCurl;
        }
      }
      points[0].x = anchorX;
      points[0].y = anchorY;
      points[0].px = anchorX;
      points[0].py = anchorY;

      // Distance constraints (2 iterations keeps chains stable and cheap).
      for (let iteration = 0; iteration < 2; iteration += 1) {
        for (let index = 1; index < points.length; index += 1) {
          const prev = points[index - 1];
          const point = points[index];
          const dx = point.x - prev.x;
          const dy = point.y - prev.y;
          const distance = Math.hypot(dx, dy) || 0.0001;
          const diff = (distance - tentacle.segmentLength) / distance;
          const weight = index === 1 ? 1 : 0.5;
          point.x -= dx * diff * weight;
          point.y -= dy * diff * weight;
          if (index > 1) {
            prev.x += dx * diff * 0.5;
            prev.y += dy * diff * 0.5;
          }
        }
      }
      // Hard stretch cap: tentacles are not rubber. Jet bursts teleport the
      // anchor faster than two solver passes absorb, so walk root-to-tip once
      // clamping each segment to <= 120% rest length.
      const maxLength = tentacle.segmentLength * 1.2;
      for (let index = 1; index < points.length; index += 1) {
        const prev = points[index - 1];
        const point = points[index];
        const dx = point.x - prev.x;
        const dy = point.y - prev.y;
        const distance = Math.hypot(dx, dy) || 0.0001;
        if (distance > maxLength) {
          const scale = maxLength / distance;
          point.x = prev.x + dx * scale;
          point.y = prev.y + dy * scale;
        }
      }
    }
  }

  function tickEyes(dtMs) {
    state.eyeGlow = lerp(state.eyeGlow, profile().eyeGlow, 0.04);
    state.nextBlinkInMs -= dtMs;
    if (state.blink > 0) {
      state.blink = Math.max(0, state.blink - dtMs / 130);
    } else if (state.nextBlinkInMs <= 0) {
      state.blink = 1;
      state.nextBlinkInMs = 2400 + rng() * 3800;
    }
    state.nextSaccadeInMs -= dtMs;
    if (state.nextSaccadeInMs <= 0) {
      const speed = Math.hypot(state.vx, state.vy);
      if (speed > 20) {
        // Moving: look along the travel direction.
        state.saccade.x = Math.cos(state.heading) * 1.6;
        state.saccade.y = Math.sin(state.heading) * 1.2;
      } else {
        state.saccade.x = (rng() - 0.5) * 2.6;
        state.saccade.y = (rng() - 0.5) * 1.8;
      }
      state.nextSaccadeInMs = 700 + rng() * 1900;
    }
  }

  function tickEffects(dtMs) {
    for (let index = state.bubbles.length - 1; index >= 0; index -= 1) {
      const bubble = state.bubbles[index];
      bubble.ageMs += dtMs;
      if (bubble.ageMs >= bubble.lifeMs) {
        state.bubbles.splice(index, 1);
        continue;
      }
      const dt = dtMs / 1000;
      bubble.vy -= 26 * dt; // buoyancy
      bubble.x += bubble.vx * dt + Math.sin((bubble.ageMs + bubble.x) / 240) * 0.2;
      bubble.y += bubble.vy * dt;
    }
    if (state.bubbles.length > 48) state.bubbles.splice(0, state.bubbles.length - 48);

    for (let index = state.inkBursts.length - 1; index >= 0; index -= 1) {
      const burst = state.inkBursts[index];
      burst.ageMs += dtMs;
      if (burst.ageMs >= burst.lifeMs) state.inkBursts.splice(index, 1);
    }
    if (state.celebrateMs > 0) state.celebrateMs = Math.max(0, state.celebrateMs - dtMs);
  }

  function tick(dtMs) {
    const clamped = clamp(Number(dtMs) || 16, 1, 64);
    state.elapsedMs += clamped;
    if (state.reducedMotion) {
      // Static pose: breathing only, no travel, no effects accumulation.
      state.breathPhase += clamped / 1000;
      state.breath = Math.sin(state.breathPhase * 1.2) * 0.02;
      tickEyes(clamped);
      return;
    }
    tickJetCycle(clamped);
    tickBody(clamped);
    tickTentacles(clamped);
    tickEyes(clamped);
    tickEffects(clamped);
  }

  // ---------------------------------------------------------------------
  // Drawing (canvas 2D). All coordinates in CSS pixels; the host scales the
  // context for devicePixelRatio.
  // ---------------------------------------------------------------------

  function drawTentacles(ctx) {
    // Tapered ribbons: each segment stroked at its own width, thick at the
    // mantle skirt, fine at the tip - reads as flesh, not wire.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const tentacle of state.tentacles) {
      const points = tentacle.points;
      const gradient = ctx.createLinearGradient(
        points[0].x, points[0].y,
        points[points.length - 1].x, points[points.length - 1].y
      );
      gradient.addColorStop(0, state.palette.tentacle);
      gradient.addColorStop(1, state.palette.tentacleTip);
      ctx.strokeStyle = gradient;
      for (let index = 1; index < points.length; index += 1) {
        const t = index / (points.length - 1);
        ctx.lineWidth = lerp(5.4, 2.1, t);
        ctx.beginPath();
        ctx.moveTo(points[index - 1].x, points[index - 1].y);
        if (index < points.length - 1) {
          const midX = (points[index].x + points[index + 1].x) / 2;
          const midY = (points[index].y + points[index + 1].y) / 2;
          ctx.quadraticCurveTo(points[index].x, points[index].y, midX, midY);
        } else {
          ctx.lineTo(points[index].x, points[index].y);
        }
        ctx.stroke();
      }
    }
  }

  function drawMantle(ctx) {
    const squashX = state.squash;
    const squashY = (2 - state.squash) * (1 + state.breath);
    ctx.save();
    ctx.scale(squashX, squashY);

    // Body glow (bioluminescence).
    const glow = ctx.createRadialGradient(0, -6, 4, 0, -4, 44);
    glow.addColorStop(0, state.palette.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -4, 44, 0, TWO_PI);
    ctx.fill();

    // Mantle: rounded dome, slightly tapered toward the crown.
    const mantle = ctx.createLinearGradient(0, -40, 0, 20);
    mantle.addColorStop(0, state.palette.mantleTop);
    mantle.addColorStop(0.55, state.palette.mantleMid);
    mantle.addColorStop(1, state.palette.mantleDeep);
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.bezierCurveTo(17, -40, 26, -22, 25, -4);
    ctx.bezierCurveTo(24.5, 12, 14, 20, 0, 20.5);
    ctx.bezierCurveTo(-14, 20, -24.5, 12, -25, -4);
    ctx.bezierCurveTo(-26, -22, -17, -40, 0, -42);
    ctx.closePath();
    ctx.fillStyle = mantle;
    ctx.fill();

    // Rim light along the crown.
    ctx.beginPath();
    ctx.moveTo(-14, -34);
    ctx.quadraticCurveTo(0, -44, 14, -34);
    ctx.strokeStyle = state.palette.rim;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Side fins: small waving membranes hugging the upper mantle.
    const finWave = Math.sin(state.elapsedMs / 260) * 3 * (0.4 + Math.hypot(state.vx, state.vy) / 160);
    ctx.globalAlpha = 0.55;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 20, -22);
      ctx.quadraticCurveTo(side * (31 + finWave), -16 + finWave * side * 0.4, side * 22, -6);
      ctx.quadraticCurveTo(side * 26, -14, side * 20, -22);
      ctx.fillStyle = state.palette.finMembrane;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFace(ctx) {
    // Visor: dark rounded window on the mantle front.
    ctx.save();
    ctx.scale(state.squash, (2 - state.squash));
    ctx.beginPath();
    const visorW = 34;
    const visorH = 22;
    const radius = 10;
    ctx.moveTo(-visorW / 2 + radius, -6 - visorH / 2);
    ctx.arcTo(visorW / 2, -6 - visorH / 2, visorW / 2, -6 + visorH / 2, radius);
    ctx.arcTo(visorW / 2, -6 + visorH / 2, -visorW / 2, -6 + visorH / 2, radius);
    ctx.arcTo(-visorW / 2, -6 + visorH / 2, -visorW / 2, -6 - visorH / 2, radius);
    ctx.arcTo(-visorW / 2, -6 - visorH / 2, visorW / 2, -6 - visorH / 2, radius);
    ctx.closePath();
    ctx.fillStyle = state.palette.visor;
    ctx.fill();
    ctx.strokeStyle = state.palette.visorRim;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Eyes: glowing capsules with saccade offset + blink. The blink value
    // decays 1 -> 0; openness makes a V (open -> shut mid-blink -> open).
    const openness = state.blink === 0
      ? 1
      : clamp(Math.abs(2 * state.blink - 1), 0.06, 1);
    for (const side of [-1, 1]) {
      const eyeX = side * 8 + state.saccade.x;
      const eyeY = -6 + state.saccade.y;
      ctx.save();
      ctx.translate(eyeX, eyeY);
      ctx.scale(1, openness);
      const glow = ctx.createRadialGradient(0, 0, 0.6, 0, 0, 7);
      glow.addColorStop(0, state.palette.eyeCore);
      glow.addColorStop(0.45, state.palette.eye);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5 + state.eyeGlow * 0.5;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 6.4, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = state.palette.eyeCore;
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.8, 2.6, 0, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawEffects(ctx) {
    for (const bubble of state.bubbles) {
      const life = 1 - bubble.ageMs / bubble.lifeMs;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, bubble.radius * (0.7 + life * 0.5), 0, TWO_PI);
      ctx.strokeStyle = `rgba(190, 230, 255, ${0.5 * life})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const burst of state.inkBursts) {
      const t = burst.ageMs / burst.lifeMs;
      const radius = burst.radius + t * 52;
      ctx.save();
      ctx.globalAlpha = clamp(0.5 * (1 - t), 0, 0.5);
      for (let blob = 0; blob < 5; blob += 1) {
        const blobAngle = burst.seed + (blob / 5) * TWO_PI;
        const blobDist = radius * (0.4 + 0.25 * Math.sin(burst.seed * 3 + blob * 2 + t * 5));
        ctx.beginPath();
        ctx.arc(
          burst.x + Math.cos(blobAngle) * blobDist,
          burst.y + Math.sin(blobAngle) * blobDist,
          radius * 0.45,
          0,
          TWO_PI
        );
        ctx.fillStyle = state.palette.ink;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function draw(ctx) {
    drawEffects(ctx);
    // Tentacle points live in WORLD space (they trail through the water, not
    // rigidly on the body): paint them first so the mantle sits on top.
    drawTentacles(ctx);
    ctx.save();
    ctx.translate(state.x, state.y);
    // Swim orientation: near-upright body that LEANS into travel plus the
    // banking roll - continuous everywhere, readable everywhere. The face
    // rides the body; at <=~35deg of total lean it never needs rescuing.
    ctx.rotate((state.lean || 0) + state.bank);
    drawMantle(ctx);
    drawFace(ctx);
    ctx.restore();
  }

  return {
    get state() { return state; },
    tick,
    draw,
    setActivity,
    setBounds,
    celebrate,
    setReducedMotion(value) { state.reducedMotion = value === true; },
  };
}

module.exports = {
  ACTIVITY_PROFILES,
  JET_PHASE,
  PALETTES,
  createRng,
  createSquidCreature,
};
