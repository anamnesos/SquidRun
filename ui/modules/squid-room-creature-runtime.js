'use strict';

/**
 * Squid Room creature runtime (S463 P1.7): binds procedural creature engines
 * to per-pet canvases and drives ONE shared requestAnimationFrame loop.
 *
 * The engine (squid-room-creature-engine.js) is pure logic; this module owns
 * everything DOM: canvas sizing (DPR-aware), the render loop, visibility
 * pausing, reduced-motion, mapping the room's honest activity classes
 * (is-active / is-settling / is-resting from REAL output age) onto creature
 * behavior, and anchoring the speech/name elements to the creature's head.
 */

const log = require('./logger');
const { createSquidCreature } = require('./squid-room-creature-engine');

const ACTIVITY_BY_MOTION_CLASS = Object.freeze({
  'is-active': 'working',
  'is-settling': 'settling',
  'is-resting': 'resting',
});

// WAVE 3 presence constants: pooled + hard-capped per the perf law (the
// renderer death investigation made zero-per-frame-allocation survival law).
const COMMS_PULSE_THROTTLE_MS = 10000;
const CURRENT_PERIOD_MS = 26000;
const CURRENT_STRENGTH = 3.2;

const HEAD_ANCHOR_THROTTLE_MS = 90;

const mounted = new Map(); // petId -> binding
let rafHandle = null;
let lastFrameAt = 0;
let reducedMotionQuery = null;
// Presence state (all pooled/preallocated - no per-frame objects).
let pointerListenerBound = false;
const pointerState = { x: null, y: null, lastX: null, lastY: null, lastAt: 0, speed: 0 };
let lastCommsPulseAt = 0;
const commsPulse = { active: false, fromPetId: null, toPetId: null, startedAt: 0, durationMs: 1600 };

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!reducedMotionQuery) {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return reducedMotionQuery.matches === true;
}

function resizeBinding(binding) {
  const { canvas, engine } = binding;
  const stage = canvas.parentElement;
  if (!stage) return;
  const width = Math.max(1, stage.clientWidth || 0);
  const height = Math.max(1, stage.clientHeight || 0);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (binding.cssWidth === width && binding.cssHeight === height && binding.dpr === dpr) return;
  // CORONER SUPPORT: every backing-store reallocation is logged. Canvas
  // resize thrash (layout oscillation -> width/height reassigned -> new
  // native backing each time) is the prime suspect for the RSS explosions
  // that survive the gradient fix - this line convicts or acquits it.
  log.info(
    'SquidRoomCreature',
    `canvas resize ${binding.canvas?.dataset?.squidRoomCreature || '?'}: ${binding.cssWidth}x${binding.cssHeight}@${binding.dpr} -> ${width}x${height}@${dpr}`
  );
  binding.cssWidth = width;
  binding.cssHeight = height;
  binding.dpr = dpr;
  // Layout changed: anchor bases are stale (the clipping/detached-bubble
  // regression) - recapture on the next anchor pass.
  binding.speechBase = null;
  binding.nameBase = null;
  // The creature is authored at a fixed body size (~64 units tall); scale it
  // with the stage so it keeps the presence the sprites had (~half the band
  // height) instead of shrinking into a smudge inside a big ocean.
  // Cap tighter now that the ocean is the whole window - a viewport-height
  // stage at 3.4x made kaiju, not pets.
  binding.scale = Math.max(0.8, Math.min(1.6, height / 210));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // Engine simulates in the UNSCALED logical space; the draw transform
  // multiplies dpr * scale, so bounds shrink by the same factor.
  engine.setBounds(width / binding.scale, height / binding.scale);
}

function anchorHeadElements(binding, nowMs) {
  if (nowMs - binding.lastAnchorAt < HEAD_ANCHOR_THROTTLE_MS) return;
  binding.lastAnchorAt = nowMs;
  // Bases captured before layout settles produce clipped/detached bubbles -
  // wait ~1s of frames before first capture.
  if (binding.frameCounter < 60) return;
  const { engine, speechEl, nameEl } = binding;
  // Engine coordinates are logical; the anchor targets CSS pixels. The
  // bubble rides ABOVE the crown (crown tip ~ -50 logical + margin).
  const scale = binding.scale || 1;
  const headX = engine.state.x * scale;
  const headY = (engine.state.y - 58) * scale;
  for (const [element, baseKey] of [[speechEl, 'speechBase'], [nameEl, 'nameBase']]) {
    if (!element || !element.isConnected) continue;
    if (!binding[baseKey]) {
      // Capture the element's CSS-resting position once; the anchor then
      // moves it RELATIVE to wherever the stylesheet put it.
      binding[baseKey] = {
        x: element.offsetLeft + element.offsetWidth / 2,
        y: element.offsetTop + element.offsetHeight,
      };
    }
    const base = binding[baseKey];
    const dx = Math.round(headX - base.x);
    const dy = Math.round(headY - base.y);
    element.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

// FLIGHT RECORDER (S463 coroner support): the room's renderer died silently
// after ~19 minutes with no trace. Until the main-side coroner activates at
// the next restart, the render loop logs a memory heartbeat every ~30s -
// if the renderer dies again, the LAST heartbeat in app.log is the autopsy
// (climbing heap = leak; flat heap = external kill/GPU).
let lastHeartbeatAt = 0;
function logMemoryHeartbeat(nowMs) {
  if (nowMs - lastHeartbeatAt < 30000) return;
  lastHeartbeatAt = nowMs;
  try {
    const heap = (typeof performance !== 'undefined' && performance.memory)
      ? Math.round(performance.memory.usedJSHeapSize / 1048576)
      : null;
    const rss = (typeof process !== 'undefined' && typeof process.memoryUsage === 'function')
      ? Math.round(process.memoryUsage().rss / 1048576)
      : null;
    log.info('SquidRoomCreature', `heartbeat heapMB=${heap} rssMB=${rss} bindings=${mounted.size}`);
  } catch (_) { /* heartbeat must never hurt the loop */ }
}

// Document-level pointer tracking (one listener, bound once): the creature
// canvases are pointer-events:none, so awareness reads the pointer at the
// document level and converts to each binding's engine-local space.
function ensurePointerListener() {
  if (pointerListenerBound || typeof document === 'undefined') return;
  pointerListenerBound = true;
  document.addEventListener('mousemove', (event) => {
    const now = Date.now();
    if (pointerState.lastAt) {
      const dt = Math.max(1, now - pointerState.lastAt);
      pointerState.speed = Math.hypot(
        event.clientX - (pointerState.lastX ?? event.clientX),
        event.clientY - (pointerState.lastY ?? event.clientY)
      ) / dt;
    }
    pointerState.lastX = event.clientX;
    pointerState.lastY = event.clientY;
    pointerState.lastAt = now;
    pointerState.x = event.clientX;
    pointerState.y = event.clientY;
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    pointerState.x = null;
    pointerState.y = null;
  }, { passive: true });
}

function feedPointerToBinding(binding) {
  const { canvas, engine } = binding;
  if (pointerState.x == null) {
    engine.setPointer(null, null);
    return;
  }
  const rect = binding.canvasRect;
  if (!rect) return;
  const scale = binding.scale || 1;
  const localX = (pointerState.x - rect.left) / scale;
  const localY = (pointerState.y - rect.top) / scale;
  if (localX < -40 || localY < -40
    || localX > binding.cssWidth / scale + 40 || localY > binding.cssHeight / scale + 40) {
    engine.setPointer(null, null);
    return;
  }
  engine.setPointer(localX, localY, pointerState.speed);
}

function drawCommsPulse(nowMs) {
  if (!commsPulse.active) return;
  const from = mounted.get(commsPulse.fromPetId);
  const to = mounted.get(commsPulse.toPetId);
  const t = (nowMs - commsPulse.startedAt) / commsPulse.durationMs;
  if (!from || !to || t >= 1) {
    commsPulse.active = false;
    return;
  }
  // The pulse travels sender -> receiver, drawn on BOTH canvases in their
  // own coordinate spaces (the water is split across two canvases; each
  // renders the segment of the journey it can see).
  for (const binding of [from, to]) {
    const rect = binding.canvasRect;
    const fromRect = from.canvasRect;
    const toRect = to.canvasRect;
    if (!rect || !fromRect || !toRect) continue;
    const scale = binding.scale || 1;
    // World (viewport) positions of both creatures.
    const worldFromX = fromRect.left + from.engine.state.x * (from.scale || 1);
    const worldFromY = fromRect.top + from.engine.state.y * (from.scale || 1);
    const worldToX = toRect.left + to.engine.state.x * (to.scale || 1);
    const worldToY = toRect.top + to.engine.state.y * (to.scale || 1);
    const pulseWorldX = worldFromX + (worldToX - worldFromX) * t;
    const pulseWorldY = worldFromY + (worldToY - worldFromY) * t;
    const localX = (pulseWorldX - rect.left) / scale;
    const localY = (pulseWorldY - rect.top) / scale;
    const ctx = binding.ctx;
    ctx.save();
    ctx.globalAlpha = 0.55 * Math.sin(Math.PI * t);
    ctx.fillStyle = binding.engine.state.palette.rim;
    ctx.beginPath();
    ctx.arc(localX, localY, 5 + Math.sin(t * 18) * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderFrame(nowMs) {
  rafHandle = null;
  const dtMs = lastFrameAt ? Math.min(64, nowMs - lastFrameAt) : 16;
  lastFrameAt = nowMs;
  logMemoryHeartbeat(nowMs);
  // Shared water current: one slow global sine vector for everything.
  const currentPhase = (nowMs % CURRENT_PERIOD_MS) / CURRENT_PERIOD_MS * Math.PI * 2;
  const currentX = Math.sin(currentPhase) * CURRENT_STRENGTH;
  const currentY = Math.cos(currentPhase * 0.7) * CURRENT_STRENGTH * 0.4;

  const hidden = typeof document !== 'undefined' && document.hidden === true;
  const reduced = prefersReducedMotion();
  let liveBindings = 0;

  for (const [petId, binding] of mounted.entries()) {
    const { canvas, engine } = binding;
    if (!canvas.isConnected) {
      mounted.delete(petId);
      continue;
    }
    liveBindings += 1;
    if (hidden) continue;
    engine.setReducedMotion(reduced);
    binding.frameCounter = (binding.frameCounter || 0) + 1;
    if (binding.frameCounter % 30 === 0) {
      resizeBinding(binding);
      // Viewport rect cached on the same cadence (layout read, not per-frame).
      binding.canvasRect = binding.canvas.getBoundingClientRect();
    }
    if (!reduced) {
      engine.setCurrent(currentX, currentY);
      feedPointerToBinding(binding);
    } else {
      engine.setPointer(null, null);
      engine.setCurrent(0, 0);
    }
    engine.tick(dtMs);
    // Reduced motion: a static pose repainted sparsely.
    if (reduced && binding.frameCounter % 60 !== 1) continue;
    const ctx = binding.ctx;
    const drawScale = binding.dpr * (binding.scale || 1);
    ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);
    ctx.clearRect(0, 0, binding.cssWidth / (binding.scale || 1), binding.cssHeight / (binding.scale || 1));
    engine.draw(ctx);
    anchorHeadElements(binding, nowMs);
  }
  if (!hidden && !reduced) drawCommsPulse(nowMs);

  if (liveBindings > 0) {
    rafHandle = window.requestAnimationFrame(renderFrame);
  } else {
    lastFrameAt = 0;
  }
}

function ensureLoop() {
  if (rafHandle == null && mounted.size > 0 && typeof window !== 'undefined'
    && typeof window.requestAnimationFrame === 'function') {
    rafHandle = window.requestAnimationFrame(renderFrame);
  }
}

/**
 * Idempotently bind engines to every creature canvas in the document.
 * Safe to call on every pet-status refresh: already-bound canvases are
 * skipped; canvases re-created by a shell re-render get fresh bindings.
 */
function mountSquidRoomCreatures(doc = typeof document !== 'undefined' ? document : null) {
  // Prefer this module's OWN document global: in a context-isolated window
  // the page world's document does not cross the bridge usefully, while the
  // preload world (where renderer modules live) sees the real DOM directly.
  const ownDoc = typeof document !== 'undefined' ? document : null;
  const candidates = [doc, ownDoc].filter((candidate) => candidate?.querySelectorAll);
  let resolvedDoc = null;
  let nodeList = [];
  for (const candidate of candidates) {
    let found = [];
    try {
      found = Array.from(candidate.querySelectorAll('canvas[data-squid-room-creature]') || []);
    } catch (err) {
      log.warn('SquidRoomCreature', `querySelectorAll failed on candidate document: ${err?.message || err}`);
      continue;
    }
    if (found.length > 0 || !resolvedDoc) {
      resolvedDoc = candidate;
      nodeList = found;
    }
    if (found.length > 0) break;
  }
  if (!resolvedDoc) return 0;
  if (nodeList.length === 0) {
    if (!mountSquidRoomCreatures._loggedEmpty) {
      mountSquidRoomCreatures._loggedEmpty = true;
      log.warn(
        'SquidRoomCreature',
        `Mount found no creature canvases (docArgUsable=${Boolean(doc?.querySelectorAll)} ownDocUsable=${Boolean(ownDoc?.querySelectorAll)} sameDoc=${doc === ownDoc})`
      );
    }
    return 0;
  }
  let mountedNow = 0;
  for (const canvas of nodeList) {
    const petId = String(
      canvas.dataset?.squidRoomCreature
      || canvas.getAttribute?.('data-squid-room-creature')
      || ''
    ).trim();
    if (!petId) {
      log.warn('SquidRoomCreature', `Mount skip: canvas without pet id (dataset=${typeof canvas.dataset} tag=${canvas.tagName})`);
      continue;
    }
    const existing = mounted.get(petId);
    if (existing && existing.canvas === canvas) continue;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) {
      log.warn('SquidRoomCreature', `Mount skip '${petId}': no 2d context (getContext=${typeof canvas.getContext})`);
      continue;
    }
    const stage = canvas.closest?.('.squid-room-pet-stage') || canvas.parentElement;
    const binding = {
      canvas,
      ctx,
      engine: createSquidCreature({ petId, reducedMotion: prefersReducedMotion() }),
      cssWidth: 0,
      cssHeight: 0,
      dpr: 1,
      scale: 1,
      frameCounter: 0,
      lastAnchorAt: 0,
      speechEl: stage?.querySelector?.('.squid-room-pet-speech') || null,
      nameEl: stage?.querySelector?.('.squid-room-pet-name-label') || null,
      speechBase: null,
      nameBase: null,
    };
    resizeBinding(binding);
    binding.canvasRect = canvas.getBoundingClientRect?.() || null;
    if (existing) {
      // Carry activity across re-renders so behavior does not reset.
      binding.engine.setActivity(existing.engine.state.activity);
    }
    mounted.set(petId, binding);
    mountedNow += 1;
    log.info('SquidRoomCreature', `Mounted procedural creature '${petId}' (${binding.cssWidth}x${binding.cssHeight})`);
  }
  ensurePointerListener();
  ensureLoop();
  return mountedNow;
}

function setSquidRoomCreatureActivity(petId, motionClass) {
  const binding = mounted.get(String(petId || '').trim());
  if (!binding) return false;
  const activity = ACTIVITY_BY_MOTION_CLASS[String(motionClass || '').trim()];
  if (!activity) return false;
  binding.engine.setActivity(activity);
  return true;
}

function celebrateSquidRoomCreature(petId) {
  const binding = mounted.get(String(petId || '').trim());
  if (!binding) return false;
  binding.engine.celebrate();
  return true;
}

/** Click delight: happy wiggle + bubbles. Emotional only - text stays honest. */
function delightSquidRoomCreature(petId) {
  const binding = mounted.get(String(petId || '').trim());
  if (!binding) return false;
  binding.engine.delight();
  return true;
}

/**
 * HONEST comms visualization: called ONLY when a real routed ledger row
 * between the core pair is observed. Throttled; coalesces bursts into one
 * rendered pulse per window. The creatures turn toward each other while the
 * pulse travels sender -> receiver.
 */
function notifySquidRoomComms(fromPetId, toPetId) {
  const now = Date.now();
  if (now - lastCommsPulseAt < COMMS_PULSE_THROTTLE_MS) return false;
  const from = mounted.get(String(fromPetId || '').trim());
  const to = mounted.get(String(toPetId || '').trim());
  if (!from || !to || !from.canvasRect || !to.canvasRect) return false;
  lastCommsPulseAt = now;
  commsPulse.active = true;
  commsPulse.fromPetId = String(fromPetId).trim();
  commsPulse.toPetId = String(toPetId).trim();
  commsPulse.startedAt = typeof performance !== 'undefined' ? performance.now() : now;
  // Each creature turns toward the other, in its own engine-local space.
  const scaleFrom = from.scale || 1;
  const scaleTo = to.scale || 1;
  const toWorldX = to.canvasRect.left + to.engine.state.x * scaleTo;
  const toWorldY = to.canvasRect.top + to.engine.state.y * scaleTo;
  const fromWorldX = from.canvasRect.left + from.engine.state.x * scaleFrom;
  const fromWorldY = from.canvasRect.top + from.engine.state.y * scaleFrom;
  from.engine.faceToward(
    (toWorldX - from.canvasRect.left) / scaleFrom,
    (toWorldY - from.canvasRect.top) / scaleFrom
  );
  to.engine.faceToward(
    (fromWorldX - to.canvasRect.left) / scaleTo,
    (fromWorldY - to.canvasRect.top) / scaleTo
  );
  return true;
}

function unmountSquidRoomCreatures() {
  mounted.clear();
  if (rafHandle != null && typeof window !== 'undefined'
    && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(rafHandle);
  }
  rafHandle = null;
  lastFrameAt = 0;
}

// Debug/test accessor returning PLAIN DATA ONLY: the module surface crosses
// the preload bridge, and non-serializable values (the Map itself) can make
// the whole export unusable in the page world.
function getSquidRoomCreatureDebugState() {
  return [...mounted.entries()].map(([petId, binding]) => ({
    petId,
    cssWidth: binding.cssWidth,
    cssHeight: binding.cssHeight,
    dpr: binding.dpr,
    scale: binding.scale,
    frameCounter: binding.frameCounter,
    canvasConnected: binding.canvas?.isConnected === true,
    activity: binding.engine?.state?.activity || null,
  }));
}

module.exports = {
  ACTIVITY_BY_MOTION_CLASS,
  celebrateSquidRoomCreature,
  delightSquidRoomCreature,
  getSquidRoomCreatureDebugState,
  mountSquidRoomCreatures,
  notifySquidRoomComms,
  setSquidRoomCreatureActivity,
  unmountSquidRoomCreatures,
};
