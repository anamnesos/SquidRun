'use strict';

/**
 * Runtime mount harness (S465, Oracle #201 residual gap): a fake DOM +
 * canvas + rAF surface complete enough to MOUNT the creature runtime and
 * step frames deterministically - the missing test surface for throttle
 * coalescing, hidden-tab render-skip, and every future runtime-layer
 * contract. House pattern: node-env fakes, no jsdom.
 */

function createFake2dContext() {
  const gradient = { addColorStop() {} };
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    beginPath: noop,
    closePath: noop,
    arc: noop,
    ellipse: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    rect: noop,
    roundRect: noop,
    setLineDash: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillRect: noop,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    createConicGradient: () => gradient,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
  };
}

function createFakeElement(tag, { width = 780, height = 420 } = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    classList: {
      classes: new Set(),
      add(...names) { names.forEach((n) => this.classes.add(n)); },
      remove(...names) { names.forEach((n) => this.classes.delete(n)); },
      contains(name) { return this.classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
    },
    isConnected: true,
    clientWidth: width,
    clientHeight: height,
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 60,
    offsetHeight: 20,
    offsetParent: null,
    parentElement: null,
    ownerDocument: null,
    width: 0,
    height: 0,
    getContext: () => el._ctx || (el._ctx = createFake2dContext()),
    getBoundingClientRect: () => ({
      left: el._rectLeft || 0,
      top: el._rectTop || 0,
      right: (el._rectLeft || 0) + width,
      bottom: (el._rectTop || 0) + height,
      width,
      height,
      x: el._rectLeft || 0,
      y: el._rectTop || 0,
    }),
    getAttribute: (name) => el._attrs?.[name] ?? null,
    setAttribute: (name, value) => { (el._attrs = el._attrs || {})[name] = String(value); },
    appendChild: (child) => { el.children.push(child); child.parentElement = el; return child; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noopListener,
    removeEventListener: noopListener,
    remove: () => { el.isConnected = false; },
  };
  return el;
}
function noopListener() {}

/**
 * Mounts the runtime against fake pets and returns deterministic controls.
 * Installs global window/document for the module's lifetime in this test
 * file - callers own cleanup via harness.destroy() in afterAll.
 */
function createMountedRoom({ petIds = ['builder', 'oracle'], stageWidth = 780, stageHeight = 420 } = {}) {
  const listeners = new Map();
  const rafQueue = [];
  let now = 0;

  const canvases = petIds.map((petId, index) => {
    const stage = createFakeElement('div', { width: stageWidth, height: stageHeight });
    stage.classList.add('squid-room-pet-stage');
    const canvas = createFakeElement('canvas', { width: stageWidth, height: stageHeight });
    canvas.dataset.squidRoomCreature = petId;
    canvas._rectLeft = index * (stageWidth + 40);
    canvas._rectTop = 0;
    stage.appendChild(canvas);
    const nameEl = createFakeElement('span');
    nameEl.textContent = petId;
    stage.querySelector = (sel) => (String(sel).includes('name-label') ? nameEl : null);
    canvas.closest = (sel) => (String(sel).includes('pet-stage') ? stage : null);
    return canvas;
  });

  const doc = {
    body: createFakeElement('body'),
    hidden: false,
    createElement: (tag) => createFakeElement(tag),
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).includes('data-squid-room-creature') ? canvases : []),
    addEventListener: (type, handler) => listeners.set(`doc:${type}`, handler),
    removeEventListener: noopListener,
  };
  canvases.forEach((canvas) => { canvas.ownerDocument = doc; });

  const addBridgeListener = (channel, handler) => {
    const key = `bridge:${channel}`;
    listeners.set(key, handler);
    return () => listeners.delete(key);
  };

  const win = {
    matchMedia: () => ({ matches: false, addEventListener: noopListener, addListener: noopListener }),
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: noopListener,
    setTimeout,
    clearTimeout,
    squidrun: { on: addBridgeListener },
    squidrunAPI: { on: addBridgeListener },
  };

  const previous = { window: global.window, document: global.document, performance: global.performance };
  global.window = win;
  global.document = doc;

  return {
    doc,
    canvases,
    listeners,
    /** Advance N frames at dtMs each; returns final timestamp. */
    step(frames = 1, dtMs = 16) {
      for (let i = 0; i < frames; i += 1) {
        now += dtMs;
        const fn = rafQueue.shift();
        if (!fn) break;
        fn(now);
      }
      return now;
    },
    get pendingFrames() { return rafQueue.length; },
    setHidden(hidden) { doc.hidden = hidden === true; },
    fireDocEvent(type, event) { listeners.get(`doc:${type}`)?.(event); },
    fireBridgeEvent(channel, payload) { listeners.get(`bridge:${channel}`)?.(payload); },
    destroy() {
      global.window = previous.window;
      global.document = previous.document;
      global.performance = previous.performance;
    },
  };
}

module.exports = { createMountedRoom, createFake2dContext, createFakeElement };
