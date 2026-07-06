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
const { createSquidRoomSpeechSystem } = require('./squid-room-speech-system');

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
let rendererWindowHidden = false;
let windowVisibilityUnsubscribe = null;
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

function isRendererHidden() {
  return (typeof document !== 'undefined' && document.hidden === true)
    || rendererWindowHidden === true;
}

function handleWindowVisibility(payload = {}) {
  rendererWindowHidden = payload?.hidden === true
    || payload?.minimized === true
    || payload?.visible === false;
}

function ensureWindowVisibilityListener() {
  if (windowVisibilityUnsubscribe || typeof window === 'undefined') return;
  const bridge = window.squidrun || window.squidrunAPI;
  if (!bridge || typeof bridge.on !== 'function') return;
  try {
    const unsubscribe = bridge.on('window-visibility-changed', handleWindowVisibility);
    windowVisibilityUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : () => {};
  } catch (err) {
    log.warn('SquidRoomCreature', `window visibility listener failed: ${err?.message || err}`);
  }
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
  // Layout changed: the name-tag base is stale - recapture next anchor pass.
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

// SPEECH is ORACLE's subsystem (squid-room-speech-system.js, 15/15 solver
// contracts): viewport-anchored boxes + bubble-chain tails, offscreen
// mathematically impossible. This runtime feeds it anchors + text. The old
// head-anchored speech transform died on wiring (no-orphan rule); only the
// small NAME tag still rides the head.
let speechSystem = null;
const speechAnchors = {}; // pooled - mutated per frame, never reallocated

function ensureSpeechSystem() {
  if (speechSystem || typeof document === 'undefined') return speechSystem;
  const layerEl = document.querySelector('.squid-room-creature-ocean') || document.body;
  if (!layerEl) return null;
  speechSystem = createSquidRoomSpeechSystem({ layerEl, reducedMotion: prefersReducedMotion() });
  return speechSystem;
}

/** Face pipeline entry: forwards honest text to Oracle's speech system. */
function setSquidRoomCreatureSpeech(petId, payload) {
  const system = ensureSpeechSystem();
  if (!system || !payload) return false;
  system.setSpeech(String(petId || '').trim(), payload);
  return true;
}

function updateSpeechAnchor(binding) {
  const rect = binding.canvasRect;
  if (!rect) return;
  const petId = binding.canvas?.dataset?.squidRoomCreature;
  if (!petId) return;
  const scale = binding.scale || 1;
  const state = binding.engine.state;
  const facing = Math.cos(state.heading) >= 0 ? 1 : -1;
  const anchor = speechAnchors[petId] || (speechAnchors[petId] = {
    mouthX: 0, mouthY: 0, headX: 0, headY: 0, facing: 1,
    bodyX: 0, bodyY: 0, bodyW: 0, bodyH: 0,
  });
  anchor.headX = rect.left + state.x * scale;
  anchor.headY = rect.top + (state.y - 30) * scale;
  anchor.mouthX = rect.left + (state.x + facing * 6) * scale;
  anchor.mouthY = rect.top + (state.y + 6) * scale;
  anchor.facing = facing;
  // Body rect for the speech solver's creature avoidance (directive: a box
  // may never cover a creature): mantle + tentacle skirt around the body,
  // EXTENDED over the crown to cover the name tag (audit close: the tag is
  // creature presence - a box parked on "Builder" hides who is speaking).
  // Tag rides at head -42 logical, ~26px tall: top edge moves to -76.
  const bodyHalfW = 58 * scale;
  anchor.bodyX = rect.left + state.x * scale - bodyHalfW;
  anchor.bodyY = rect.top + (state.y - 76) * scale;
  anchor.bodyW = bodyHalfW * 2;
  anchor.bodyH = 164 * scale;
}

function anchorHeadElements(binding, nowMs) {
  if (nowMs - binding.lastAnchorAt < HEAD_ANCHOR_THROTTLE_MS) return;
  binding.lastAnchorAt = nowMs;
  if (binding.frameCounter < 60) return;
  const { engine, nameEl } = binding;
  const scale = binding.scale || 1;
  // Tags hug the crown (audit finding: floating detached) - same tight
  // offset for both creatures, riding the same anchor family as speech.
  const headX = engine.state.x * scale;
  const headY = (engine.state.y - 42) * scale;
  if (!nameEl || !nameEl.isConnected) return;
  // Recapture the CSS resting base every (throttled) pass, ACCUMULATED up
  // the offsetParent chain to the stage: the label's offsetParent is the
  // pet-motion-track (positioned), so raw offsetLeft/Top are TRACK-local
  // while headX/headY are card-local - mixing frames stranded the tags by
  // exactly the track's position (live-CDP diagnosis, session 464).
  let baseX = nameEl.offsetLeft + nameEl.offsetWidth / 2;
  let baseY = nameEl.offsetTop + nameEl.offsetHeight;
  let parent = nameEl.offsetParent;
  let hops = 0;
  while (parent && hops < 4 && !(parent.classList?.contains?.('sr2-pet-water'))) {
    baseX += parent.offsetLeft || 0;
    baseY += parent.offsetTop || 0;
    parent = parent.offsetParent;
    hops += 1;
  }
  binding.nameBase = { x: baseX, y: baseY };
  nameEl.style.transform = `translate(${Math.round(headX - baseX)}px, ${Math.round(headY - baseY)}px)`;
  // FAIL-DARK (constitution V.2): the tag becomes visible only now - after
  // its first real anchor write. A tag with no creature under it (the 0,0
  // ghost) can no longer paint, by construction.
  nameEl.classList?.add?.('is-anchored');
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

  const hidden = isRendererHidden();
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
      // OCCLUSION LAW: measure the REAL opaque section bar and report it in
      // engine-local coordinates - targets avoid it, drifters evacuate it.
      // CUTOFF LAW (Abyssal Cosmos v2): measure the REAL no-go rects each
      // resize pass - chrome strip above, opaque section top below - and
      // report them as engine-local swim insets. The engine adds full-body
      // + name-tag margins and clamps position AND targets.
      const doc = binding.canvas.ownerDocument || document;
      const scale = binding.scale || 1;
      if (binding.canvasRect) {
        const chromeEl = doc.querySelector?.('.header');
        const chromeBottom = chromeEl
          ? chromeEl.getBoundingClientRect().bottom
          : 64; // measured fallback: the window-chrome strip
        const barEl = doc.querySelector?.('.squid-room-header');
        const sectionTop = barEl
          ? barEl.getBoundingClientRect().top
          : binding.canvasRect.bottom;
        const topInset = Math.max(0, (chromeBottom - binding.canvasRect.top) / scale);
        const bottomInset = Math.max(0, (binding.canvasRect.bottom - sectionTop) / scale);
        engine.setSwimInsets(topInset, bottomInset);
        // CUTOFF LAW extends to speech: everything below the section bar is
        // covered by panels, so the speech solver's usable viewport ends
        // there (a box solved half-under Apps-and-Arms is occluded debris).
        const speech = ensureSpeechSystem();
        if (speech && sectionTop > 120 && typeof window !== 'undefined') {
          // 12px breathing room: a box edge KISSING the section bar reads
          // as touching it (Architect margin nit, capture 1783109278088).
          speech.setViewport(window.innerWidth, sectionTop - 12);
        }
      }
    }
    if (!reduced) {
      engine.setCurrent(currentX, currentY);
      feedPointerToBinding(binding);
      // Separation feed: nearest OTHER creature in the shared frame (both
      // cards span the full window at equal scale, so engine-local
      // coordinates are directly comparable).
      let nearest = null;
      let nearestDist = Infinity;
      for (const other of mounted.values()) {
        if (other === binding) continue;
        const os = other.engine?.state;
        if (!os) continue;
        const d = Math.hypot(os.x - engine.state.x, os.y - engine.state.y);
        if (d < nearestDist) { nearestDist = d; nearest = os; }
      }
      if (nearest) engine.setNeighbor(nearest.x, nearest.y);
      else engine.setNeighbor(null, null);
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
    updateSpeechAnchor(binding);
  }
  if (!hidden && !reduced) drawCommsPulse(nowMs);
  // Oracle's speech system steps after all creatures: solver + chains +
  // typewriter advance on frame time (no timers of its own). Its return
  // value is THE TAIL SEAM (organ 7): pooled box-edge attach points that
  // the ribbon overlay consumes in this same tick.
  const speech = ensureSpeechSystem();
  if (speech && !hidden) {
    const boxAnchors = speech.frame(nowMs, speechAnchors);
    if (!reduced) drawRibbons(nowMs, boxAnchors);
  }

  if (liveBindings > 0) {
    rafHandle = window.requestAnimationFrame(renderFrame);
  } else {
    lastFrameAt = 0;
  }
}

// THE RIBBON TAIL (James's leap, S466): the dotted chain's replacement -
// ONE full-viewport overlay canvas between creatures and boxes drawing a
// curved ribbon mouth -> box-attach per speaking creature. PERF LAW: fixed
// segment count, precomputed alpha ramp, cached colors, pooled point
// scratch - zero per-frame allocations, zero gradient objects.
const RIBBON_SEGMENTS = 24;
const RIBBON_ALPHA_RAMP = (() => {
  const ramp = new Float32Array(RIBBON_SEGMENTS);
  for (let i = 0; i < RIBBON_SEGMENTS; i += 1) {
    const t = i / (RIBBON_SEGMENTS - 1);
    ramp[i] = 0.12 + 0.55 * Math.sin(Math.PI * (0.15 + 0.85 * t)); // fade in from mouth, strong at box
  }
  return ramp;
})();
let ribbonCanvas = null;
let ribbonCtx = null;
const ribbonScratch = { x: 0, y: 0 };

function ensureRibbonOverlay() {
  if (ribbonCtx || typeof document === 'undefined') return ribbonCtx;
  const host = document.querySelector('.squid-room-creature-ocean') || document.body;
  if (!host) return null;
  ribbonCanvas = document.createElement('canvas');
  ribbonCanvas.className = 'sr2-ribbon-overlay';
  ribbonCanvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:3;';
  host.appendChild(ribbonCanvas);
  ribbonCtx = ribbonCanvas.getContext('2d');
  return ribbonCtx;
}

function drawRibbons(nowMs, boxAnchors) {
  const ctx = ensureRibbonOverlay();
  if (!ctx) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (ribbonCanvas.width !== Math.round(vw * dpr) || ribbonCanvas.height !== Math.round(vh * dpr)) {
    ribbonCanvas.width = Math.round(vw * dpr);
    ribbonCanvas.height = Math.round(vh * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  if (!boxAnchors) return;
  const flowPhase = (nowMs % 2600) / 2600;
  for (const petId in boxAnchors) {
    const box = boxAnchors[petId];
    const mouth = speechAnchors[petId];
    if (!box || box.visible !== true || !mouth) continue;
    // Curved path: control points sag toward the water between mouth and box.
    const mx = mouth.mouthX;
    const my = mouth.mouthY;
    const bx = box.attachX;
    const by = box.attachY;
    const c1x = mx + (bx - mx) * 0.3;
    const c1y = my + Math.max(18, Math.abs(bx - mx) * 0.08);
    const c2x = mx + (bx - mx) * 0.7;
    const c2y = by + Math.max(12, Math.abs(bx - mx) * 0.05);
    ctx.strokeStyle = box.color || '#7ad7ff';
    ctx.lineCap = 'round';
    let prevX = mx;
    let prevY = my;
    for (let i = 1; i < RIBBON_SEGMENTS; i += 1) {
      const t = i / (RIBBON_SEGMENTS - 1);
      const u = 1 - t;
      // Cubic bezier point (pooled scratch, no allocation).
      ribbonScratch.x = u * u * u * mx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx;
      ribbonScratch.y = u * u * u * my + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by;
      // Flow: a brightness wave travels mouth -> box along the ramp.
      const flow = 0.75 + 0.25 * Math.sin((t - flowPhase) * Math.PI * 4);
      ctx.globalAlpha = RIBBON_ALPHA_RAMP[i] * flow;
      ctx.lineWidth = 3.4 - 1.6 * t;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(ribbonScratch.x, ribbonScratch.y);
      ctx.stroke();
      prevX = ribbonScratch.x;
      prevY = ribbonScratch.y;
    }
  }
  ctx.globalAlpha = 1;
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
    const stage = canvas.closest?.('.sr2-pet-water') || canvas.parentElement;
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
      nameEl: stage?.querySelector?.('.sr2-name-tag') || null,
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
  ensureWindowVisibilityListener();
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
  rendererWindowHidden = false;
  if (typeof windowVisibilityUnsubscribe === 'function') {
    try { windowVisibilityUnsubscribe(); } catch (_) {}
  }
  windowVisibilityUnsubscribe = null;
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
  setSquidRoomCreatureSpeech,
  unmountSquidRoomCreatures,
};
