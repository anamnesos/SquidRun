'use strict';

/**
 * Contracts for THE PAINTED COSMOS (squid-room-cosmos-canvas.js).
 * House pattern: node-env fakes (mount-harness lineage), no jsdom.
 *
 * The laws under test:
 *  1. PAINT-ONCE: nebula/star/base painting happens exactly once per
 *     (load|resize) — never in the frame loop.
 *  2. NO PER-FRAME GRADIENTS: the frame loop constructs ZERO gradients
 *     (Oracle perf-law lineage).
 *  3. PARTICLE BOUND: the particle pool never exceeds MAX_PARTICLES and
 *     never grows across frames (recycled, not respawned).
 *  4. REDUCED MOTION: one still composite, no running loop.
 *  5. DETERMINISM: same seed, same sky (prng + fbm pure).
 */

const {
  MAX_PARTICLES,
  createCosmosCanvasRuntime,
  createPrng,
  buildNoiseGrid,
  fbm,
} = require('../modules/squid-room-cosmos-canvas');
const { createFake2dContext } = require('./helpers/squid-room-mount-harness');

function createInstrumented2dContext() {
  const ctx = createFake2dContext();
  ctx.gradientCalls = 0;
  const gradient = { addColorStop() {} };
  ctx.createLinearGradient = () => { ctx.gradientCalls += 1; return gradient; };
  ctx.createRadialGradient = () => { ctx.gradientCalls += 1; return gradient; };
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.putImageData = () => {};
  ctx.drawImage = () => {};
  ctx.globalCompositeOperation = 'source-over';
  return ctx;
}

function createFakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 500,
    _ctx: null,
    getContext() { return this._ctx || (this._ctx = createInstrumented2dContext()); },
  };
  return canvas;
}

function createFakeEnv({ width = 800, height = 500 } = {}) {
  const canvas = createFakeCanvas();
  const listeners = new Map();
  const doc = {
    hidden: false,
    createElement: () => createFakeCanvas(),
    addEventListener: (type, handler) => listeners.set(`doc:${type}`, handler),
    querySelector: () => canvas,
  };
  const addBridgeListener = (channel, handler) => {
    listeners.set(`bridge:${channel}`, handler);
    return () => listeners.delete(`bridge:${channel}`);
  };
  const win = {
    innerWidth: width,
    innerHeight: height,
    rafCallbacks: [],
    requestAnimationFrame(cb) { this.rafCallbacks.push(cb); return this.rafCallbacks.length; },
    cancelAnimationFrame() {},
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    squidrun: { on: addBridgeListener },
  };
  return {
    canvas,
    doc,
    win,
    fireBridgeEvent(channel, payload) {
      listeners.get(`bridge:${channel}`)?.(payload);
    },
  };
}

describe('squid-room cosmos canvas contracts', () => {
  test('paint-once law: layers paint once at start, once more per real resize', () => {
    const { canvas, doc, win } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: false, seed: 7 });
    runtime.start();
    expect(runtime.paintCount).toBe(1);

    // frames do not repaint
    for (let i = 0; i < 25; i += 1) runtime.compositeFrame(33);
    expect(runtime.paintCount).toBe(1);

    // same-size resize is a no-op
    runtime.resize();
    expect(runtime.paintCount).toBe(1);

    // a real resize repaints exactly once
    win.innerWidth = 1200; win.innerHeight = 700;
    runtime.resize();
    expect(runtime.paintCount).toBe(2);
  });

  test('perf law: the frame loop constructs zero gradients', () => {
    const { canvas, doc, win } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: false, seed: 7 });
    runtime.start();
    const ctx = canvas.getContext();
    const gradientsAfterPaint = ctx.gradientCalls; // main ctx should build none even at paint (layers own theirs)
    for (let i = 0; i < 40; i += 1) runtime.compositeFrame(33);
    expect(ctx.gradientCalls).toBe(gradientsAfterPaint);
  });

  test('particle bound: pool capped at MAX_PARTICLES and never grows', () => {
    const { canvas, doc, win } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: false, seed: 7 });
    runtime.start();
    expect(runtime.particleCount).toBeLessThanOrEqual(MAX_PARTICLES);
    const before = runtime.particleCount;
    for (let i = 0; i < 400; i += 1) runtime.compositeFrame(33); // ~13s simulated: many recycles
    expect(runtime.particleCount).toBe(before);
  });

  test('reduced motion: one still composite, loop never runs', () => {
    const { canvas, doc, win } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: true, seed: 7 });
    runtime.start();
    expect(runtime.paintCount).toBe(1);   // it painted the sky
    expect(runtime.running).toBe(false);  // it did not start a loop
    expect(win.rafCallbacks.length).toBe(0);
  });

  test('window visibility event pauses and resumes the animation loop', () => {
    const { canvas, doc, win, fireBridgeEvent } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: false, seed: 7 });
    runtime.start();
    expect(runtime.running).toBe(true);

    fireBridgeEvent('window-visibility-changed', { hidden: true, reason: 'minimize' });
    expect(runtime.running).toBe(false);

    fireBridgeEvent('window-visibility-changed', { hidden: false, visible: true, reason: 'restore' });
    expect(runtime.running).toBe(true);
  });

  test('determinism: same seed produces the same sky math', () => {
    const a = createPrng(42); const b = createPrng(42);
    for (let i = 0; i < 50; i += 1) expect(a()).toBe(b());
    const gridA = buildNoiseGrid(createPrng(9), 32);
    const gridB = buildNoiseGrid(createPrng(9), 32);
    expect(fbm(gridA, 32, 1.37, 2.11, 5)).toBe(fbm(gridB, 32, 1.37, 2.11, 5));
  });
});

describe('backplate contract (v4: assets over runtime art)', () => {
  test('setBackplate is exactly one counted repaint, cover-drawn', () => {
    const { canvas, doc, win } = createFakeEnv();
    const runtime = createCosmosCanvasRuntime({ document: doc, window: win, canvas, reducedMotion: false, seed: 7 });
    runtime.start();
    expect(runtime.paintCount).toBe(1);
    const fakePlate = { width: 2560, height: 1440 };
    runtime.setBackplate(fakePlate);
    expect(runtime.paintCount).toBe(2);   // one repaint, counted
    for (let i = 0; i < 20; i += 1) runtime.compositeFrame(33);
    expect(runtime.paintCount).toBe(2);   // never again per frame
  });
});
