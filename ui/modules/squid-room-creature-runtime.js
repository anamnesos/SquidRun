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

const HEAD_ANCHOR_THROTTLE_MS = 90;

const mounted = new Map(); // petId -> binding
let rafHandle = null;
let lastFrameAt = 0;
let reducedMotionQuery = null;

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
  binding.cssWidth = width;
  binding.cssHeight = height;
  binding.dpr = dpr;
  // The creature is authored at a fixed body size (~64 units tall); scale it
  // with the stage so it keeps the presence the sprites had (~half the band
  // height) instead of shrinking into a smudge inside a big ocean.
  binding.scale = Math.max(0.8, Math.min(3.4, height / 210));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // Engine simulates in the UNSCALED logical space; the draw transform
  // multiplies dpr * scale, so bounds shrink by the same factor.
  engine.setBounds(width / binding.scale, height / binding.scale);
}

function anchorHeadElements(binding, nowMs) {
  if (nowMs - binding.lastAnchorAt < HEAD_ANCHOR_THROTTLE_MS) return;
  binding.lastAnchorAt = nowMs;
  const { engine, speechEl, nameEl } = binding;
  // Engine coordinates are logical; the anchor targets CSS pixels.
  const scale = binding.scale || 1;
  const headX = engine.state.x * scale;
  const headY = (engine.state.y - 34) * scale;
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

function renderFrame(nowMs) {
  rafHandle = null;
  const dtMs = lastFrameAt ? Math.min(64, nowMs - lastFrameAt) : 16;
  lastFrameAt = nowMs;

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
    if (binding.frameCounter % 30 === 0) resizeBinding(binding);
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
  if (!doc?.querySelectorAll) return 0;
  let mountedNow = 0;
  for (const canvas of doc.querySelectorAll('canvas[data-squid-room-creature]')) {
    const petId = String(canvas.dataset.squidRoomCreature || '').trim();
    if (!petId) continue;
    const existing = mounted.get(petId);
    if (existing && existing.canvas === canvas) continue;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) continue;
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
    if (existing) {
      // Carry activity across re-renders so behavior does not reset.
      binding.engine.setActivity(existing.engine.state.activity);
    }
    mounted.set(petId, binding);
    mountedNow += 1;
    log.info('SquidRoomCreature', `Mounted procedural creature '${petId}' (${binding.cssWidth}x${binding.cssHeight})`);
  }
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

function unmountSquidRoomCreatures() {
  mounted.clear();
  if (rafHandle != null && typeof window !== 'undefined'
    && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(rafHandle);
  }
  rafHandle = null;
  lastFrameAt = 0;
}

module.exports = {
  ACTIVITY_BY_MOTION_CLASS,
  celebrateSquidRoomCreature,
  mountSquidRoomCreatures,
  setSquidRoomCreatureActivity,
  unmountSquidRoomCreatures,
  _internals: { mounted },
};
