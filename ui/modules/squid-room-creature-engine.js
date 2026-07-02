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
    mantleTop: '#6ab0f0',
    mantleMid: '#3a7bd6',
    mantleDeep: '#1b4f96',
    rim: 'rgba(120, 226, 255, 0.85)',
    finMembrane: 'rgba(90, 190, 240, 0.55)',
    tentacle: '#3d7ed8',
    tentacleTip: '#9fdcff',
    outline: '#132b4d',
    visor: '#0a1220',
    visorRim: 'rgba(190, 216, 240, 0.8)',
    eye: '#25f0e2',
    eyeCore: '#eaffff',
    eyeSparkle: true,
    glow: 'rgba(60, 190, 255, 0.34)',
    ink: 'rgba(16, 42, 80, 0.85)',
  }),
  oracle: Object.freeze({
    mantleTop: '#b18ae8',
    mantleMid: '#7e57c8',
    mantleDeep: '#4d2f8c',
    rim: 'rgba(214, 178, 255, 0.85)',
    finMembrane: 'rgba(178, 140, 235, 0.55)',
    tentacle: '#8a63d6',
    tentacleTip: '#ddc2ff',
    outline: '#2a1852',
    visor: '#100a1e',
    visorRim: 'rgba(214, 198, 240, 0.8)',
    eye: '#7fd8ff',
    eyeCore: '#f4fbff',
    eyeSparkle: true,
    spots: 'rgba(72, 44, 128, 0.4)',
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
  segments = 6,
  segmentLength = 5,
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
  // Six arms: the sprite shows six distinct sausages across the rim - eight
  // thick arms on this rim width fuse into a solid sheet no fan can open.
  const tentacleCount = clamp(Number(options.tentacleCount) || 6, 5, 8);

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
    // WAVE 2 CHARACTER SHEET (the pixel sprite's proportions): mantle is
    // ~66% of body mass, the arm skirt SHORT and STUBBY (~32% of height) -
    // 5 segments x ~5.2 units per arm, hanging as a cohesive skirt.
    // FAT STUBBY CONES (art direction pass-9): short chains, finger-chunky
    // at the base, blunt light tips - plush toy legs, not streamers.
    tentacles: Array.from({ length: tentacleCount }, (_, index) => createTentacle(rng, {
      spread: (index - (tentacleCount - 1) / 2) / ((tentacleCount - 1) / 2),
      segments: 5,
      segmentLength: 4.4 + rng() * 0.5,
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
    // Lean scales with SPEED: a resting creature hangs upright (the sprite's
    // pose), a darting one tilts into travel.
    const leanTarget = 0.6
      * Math.sin(normalizeAngle(state.heading + Math.PI / 2))
      * clamp(speed / 60, 0, 1);
    state.lean = lerp(state.lean ?? 0, leanTarget, clamp(speed / 200, 0.03, 0.12));

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
      // Splayed skirt fan of DISTINCT fat little arms. SIGN MATTERS: canvas
      // angles run clockwise, so a rightward splay (spread=+1) is PI/2
      // MINUS the fan angle - the PLUS form points every arm's rest line at
      // the OPPOSITE side and the hold pinches the skirt into a beard (the
      // pass-4..7 fused-cone bug, caught by tip-position instrumentation).
      const spreadAngle = bodyRotation + Math.PI / 2 - tentacle.spread * lerp(0.5, 0.18, streaming);
      const localX = tentacle.spread * 21 * state.squash;
      const localY = 15 * (2 - state.squash);
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
        // Undulation: gentle skirt flutter - stubby arms ripple subtly.
        const sway = Math.sin(tentacle.phase + index * 0.5)
          * (0.16 + streaming * 0.4) * prof.undulation
          * (index / points.length);
        point.x += Math.cos(spreadAngle + Math.PI / 2) * sway;
        point.y += Math.sin(spreadAngle + Math.PI / 2) * sway;
        // Fan hold: each arm has a rest line fanning out from its anchor -
        // a soft pull toward it keeps the eight arms ORGANIZED as a loose
        // cone instead of tangling like wet hair. Streaming releases the
        // hold so darts still sweep the arms into a trailing bundle.
        // Rest line BOWS outward along the chain (fan angle grows toward the
        // tip): each arm curves like the sprite's little banana sausages
        // instead of pointing straight.
        const bowAngle = spreadAngle
          - tentacle.spread * 0.5 * (index / points.length)
          * lerp(1, 0.3, streaming);
        const restX = anchorX + Math.cos(bowAngle) * index * tentacle.segmentLength * 0.92;
        const restY = anchorY + Math.sin(bowAngle) * index * tentacle.segmentLength * 0.92;
        // Firm hold keeps the skirt cohesive; streaming releases it a little
        // so darts read as a cute skirt flutter.
        const holdStrength = (0.05 + 0.035 * (index / points.length)) * (1 - streaming * 0.6);
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
    // CHARACTER SHEET arms: short, THICK, round-tipped - each roughly 1/5 of
    // the mantle width at its base, overlapping neighbors into a cohesive
    // plush skirt. Flat cel tones, no thin lines anywhere.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Two-row skirt like the sprite: BACK arms in the deep tone first, FRONT
    // arms in the main tone on top - overlapping thick arms stay READABLE as
    // separate arms instead of fusing into a mitten.
    // Each arm = OUTLINE pass (the sprite's pixel-art separator) then color
    // on top. The final segment is drawn in the LIGHT tip color so the blunt
    // rounded END of the arm itself is the tip - no separate bead-spheres.
    const strokeArm = (tentacle, colorMain, colorTip, widthRoot, widthTip) => {
      const points = tentacle.points;
      for (let index = 1; index < points.length; index += 1) {
        const t = index / (points.length - 1);
        ctx.strokeStyle = (colorTip && index === points.length - 1) ? colorTip : colorMain;
        ctx.lineWidth = lerp(widthRoot, widthTip, t);
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
    };
    const drawArm = (tentacle, color) => {
      strokeArm(tentacle, state.palette.outline, null, 14 + 2.6, 7 + 2.2);
      strokeArm(tentacle, color, state.palette.tentacleTip, 14, 7);
    };
    for (let index = 0; index < state.tentacles.length; index += 1) {
      if (index % 2 === 0) drawArm(state.tentacles[index], state.palette.mantleDeep);
    }
    for (let index = 0; index < state.tentacles.length; index += 1) {
      if (index % 2 === 1) drawArm(state.tentacles[index], state.palette.tentacle);
    }
  }

  // Chunky mantle path (CHARACTER SHEET: big, round, slightly wider than
  // tall). Reused for fill and for clipping the cel-shade bands.
  function traceMantlePath(ctx) {
    // ONION-CHUBBY dome with the sprite's soft POINTED CROWN: widest at the
    // fin line (slightly below mid), rounding tightly into the skirt rim.
    ctx.beginPath();
    ctx.moveTo(0, -44);
    ctx.bezierCurveTo(8, -43, 16, -36, 21, -28);
    ctx.bezierCurveTo(30, -18, 34.5, -11, 34.5, -2);
    ctx.bezierCurveTo(35, 10, 20, 17.5, 0, 18);
    ctx.bezierCurveTo(-20, 17.5, -35, 10, -34.5, -2);
    ctx.bezierCurveTo(-34.5, -11, -30, -18, -21, -28);
    ctx.bezierCurveTo(-16, -36, -8, -43, 0, -44);
    ctx.closePath();
  }

  function drawMantle(ctx) {
    const squashX = state.squash;
    const squashY = (2 - state.squash) * (1 + state.breath);
    ctx.save();
    ctx.scale(squashX, squashY);

    // Body glow (bioluminescence) - soft, behind the body.
    const glow = ctx.createRadialGradient(0, -6, 4, 0, -4, 46);
    glow.addColorStop(0, state.palette.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -4, 46, 0, TWO_PI);
    ctx.fill();

    // Cel shading, sprite-style: flat mid tone base, flat light cap, flat
    // deep under-band. No airbrush gradient anywhere.
    // Cartoon outline first (sprite charm), then the cel fills over it.
    traceMantlePath(ctx);
    ctx.strokeStyle = state.palette.outline;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    traceMantlePath(ctx);
    ctx.fillStyle = state.palette.mantleMid;
    ctx.fill();
    ctx.save();
    traceMantlePath(ctx);
    ctx.clip();
    // Light cap: upper third.
    ctx.fillStyle = state.palette.mantleTop;
    ctx.beginPath();
    ctx.ellipse(0, -27, 26, 17, 0, 0, TWO_PI);
    ctx.fill();
    // Deep band: lower rim where the skirt hangs.
    ctx.fillStyle = state.palette.mantleDeep;
    ctx.beginPath();
    ctx.ellipse(0, 20, 36, 9, 0, 0, TWO_PI);
    ctx.fill();
    // Mottled spots (oracle charm): a few soft darker freckles, cel-flat,
    // deterministic positions.
    if (state.palette.spots) {
      ctx.fillStyle = state.palette.spots;
      for (const [sx, sy, sr] of [[-15, -20, 3], [11, -25, 2.4], [19, -9, 2.8], [-22, -4, 2.2], [4, -13, 1.8]]) {
        ctx.beginPath();
        ctx.ellipse(sx, sy, sr, sr * 0.8, 0, 0, TWO_PI);
        ctx.fill();
      }
    }
    ctx.restore();

    // Rim light along the crown - chunky, not a hairline.
    ctx.beginPath();
    ctx.moveTo(-13, -33);
    ctx.quadraticCurveTo(0, -45, 13, -33);
    ctx.strokeStyle = state.palette.rim;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Small round side fins hugging the upper mantle.
    const finWave = Math.sin(state.elapsedMs / 260) * 2.4 * (0.4 + Math.hypot(state.vx, state.vy) / 160);
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = state.palette.finMembrane;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 34, -3 + finWave * side * 0.3, 9.5, 6.5 + Math.abs(finWave) * 0.4, side * 0.35, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFace(ctx) {
    // Visor: the SOUL - big dark rounded window, ~60% of the mantle width,
    // centered on the face. Chunky rim, sprite-faithful.
    ctx.save();
    ctx.scale(state.squash, (2 - state.squash));
    ctx.beginPath();
    // Big visor at MOUTH LEVEL - the reference faces occupy the bottom half
    // of the mantle (art direction pass-3: +18% size, dropped low).
    const visorW = 45;
    const visorH = 30;
    const visorY = 1;
    const radius = 14;
    ctx.moveTo(-visorW / 2 + radius, visorY - visorH / 2);
    ctx.arcTo(visorW / 2, visorY - visorH / 2, visorW / 2, visorY + visorH / 2, radius);
    ctx.arcTo(visorW / 2, visorY + visorH / 2, -visorW / 2, visorY + visorH / 2, radius);
    ctx.arcTo(-visorW / 2, visorY + visorH / 2, -visorW / 2, visorY - visorH / 2, radius);
    ctx.arcTo(-visorW / 2, visorY - visorH / 2, visorW / 2, visorY - visorH / 2, radius);
    ctx.closePath();
    ctx.fillStyle = state.palette.visor;
    ctx.fill();
    ctx.strokeStyle = state.palette.visorRim;
    ctx.lineWidth = 2.2;
    ctx.globalAlpha = 0.75;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Eyes: BIG glowing capsules (the sprite's charm) with saccade offset,
    // blink, and a slight squash while jetting (free cuteness per the
    // character sheet). Blink decays 1 -> 0; openness makes a V.
    const openness = state.blink === 0
      ? 1
      : clamp(Math.abs(2 * state.blink - 1), 0.06, 1);
    const jetSquash = lerp(1, state.squash, 0.6);
    for (const side of [-1, 1]) {
      const eyeX = side * 10.5 + state.saccade.x;
      const eyeY = visorY + state.saccade.y;
      ctx.save();
      ctx.translate(eyeX, eyeY);
      ctx.scale(1, openness * jetSquash);
      const glow = ctx.createRadialGradient(0, 0, 0.8, 0, 0, 9);
      glow.addColorStop(0, state.palette.eyeCore);
      glow.addColorStop(0.45, state.palette.eye);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5 + state.eyeGlow * 0.5;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 8.2, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Tall pill core - the sprite's signature eye shape.
      ctx.fillStyle = state.palette.eyeCore;
      ctx.beginPath();
      ctx.ellipse(0, 0, 2.3, 4.6, 0, 0, TWO_PI);
      ctx.fill();
      // Sparkle highlights (wet, alive - the sprite's charm). Offset onto
      // the colored glow EDGE - centered on the white core they vanish.
      if (state.palette.eyeSparkle) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(-3, -3.4, 1.15, 0, TWO_PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(2.8, 2.2, 0.6, 0, TWO_PI);
        ctx.fill();
      }
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
    // Under-glow: soft bioluminescent pool beneath the creature that seats
    // it in the water (the grounding the CSS contact-shadow used to give).
    ctx.save();
    ctx.globalAlpha = 0.5 + state.eyeGlow * 0.3;
    const underGlow = ctx.createRadialGradient(state.x, state.y + 30, 2, state.x, state.y + 30, 34);
    underGlow.addColorStop(0, state.palette.glow);
    underGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = underGlow;
    ctx.beginPath();
    ctx.ellipse(state.x, state.y + 30, 34, 14, 0, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
    // Sprite-faithful layering: MANTLE behind, ARMS hanging in front of the
    // lower rim (world space - they trail through the water), FACE on top so
    // the arm roots tuck under the visor's chin exactly like the reference.
    const bodyRotation = (state.lean || 0) + state.bank;
    ctx.save();
    ctx.translate(state.x, state.y);
    // Swim orientation: near-upright body that LEANS into travel plus the
    // banking roll - continuous everywhere, readable everywhere.
    ctx.rotate(bodyRotation);
    drawMantle(ctx);
    ctx.restore();
    drawTentacles(ctx);
    ctx.save();
    ctx.translate(state.x, state.y);
    ctx.rotate(bodyRotation);
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
