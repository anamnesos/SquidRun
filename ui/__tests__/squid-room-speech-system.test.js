'use strict';

const {
  CHAIN_DOT_COUNT,
  SPEECH_INSET_PX,
  chainDotPhase,
  createSquidRoomSpeechSystem,
  layoutChainDots,
  solveSpeechBox,
} = require('../modules/squid-room-speech-system');

// ── Minimal functional fake DOM (house style: no jsdom in this repo). ──
// Gives elements real state (dataset/classList/children/listeners) plus
// configurable offset dims, which the solver tests need and jsdom can't give.
function makeFakeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parent: null,
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    id: '',
    offsetWidth: 300,
    offsetHeight: 90,
    _listeners: {},
    _classes: new Set(),
    classList: null,
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    remove() {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    addEventListener(name, fn) { (el._listeners[name] = el._listeners[name] || []).push(fn); },
    trigger(name) { for (const fn of el._listeners[name] || []) fn({ target: el }); },
    querySelectorAll(sel) {
      const out = [];
      (function walk(node) {
        for (const child of node.children) { out.push(child); walk(child); }
      })(el);
      if (sel === '*') return out;
      return out.filter((n) => `.${n.className}`.includes(sel));
    },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

function makeFakeDocument() {
  const head = makeFakeElement('head');
  const byId = new Map();
  return {
    head,
    createElement: (tag) => makeFakeElement(tag),
    getElementById: (id) => byId.get(id) || null,
    _registerId: (id, el) => byId.set(id, el),
  };
}

const VIEW = { viewportW: 1200, viewportH: 800 };

function contained(box, boxW, boxH, view = VIEW) {
  return box.x >= SPEECH_INSET_PX
    && box.y >= SPEECH_INSET_PX
    && box.x + boxW <= view.viewportW - SPEECH_INSET_PX
    && box.y + boxH <= view.viewportH - SPEECH_INSET_PX;
}

describe('speech viewport solver — offscreen is mathematically impossible', () => {
  const BOX = { boxW: 300, boxH: 90 };

  test('all four viewport corners produce fully-contained boxes', () => {
    const corners = [
      { anchorX: 0, anchorY: 0 },
      { anchorX: VIEW.viewportW, anchorY: 0 },
      { anchorX: 0, anchorY: VIEW.viewportH },
      { anchorX: VIEW.viewportW, anchorY: VIEW.viewportH },
    ];
    for (const corner of corners) {
      const solved = solveSpeechBox({ ...corner, ...BOX, ...VIEW });
      expect(contained(solved, BOX.boxW, BOX.boxH)).toBe(true);
    }
  });

  test('a dense anchor sweep never escapes the inset frame', () => {
    for (let ax = -50; ax <= VIEW.viewportW + 50; ax += 87) {
      for (let ay = -50; ay <= VIEW.viewportH + 50; ay += 73) {
        const solved = solveSpeechBox({ anchorX: ax, anchorY: ay, ...BOX, ...VIEW });
        expect(contained(solved, BOX.boxW, BOX.boxH)).toBe(true);
      }
    }
  });

  test('left-half anchors open rightward, right-half leftward (flip)', () => {
    const left = solveSpeechBox({ anchorX: 200, anchorY: 400, ...BOX, ...VIEW });
    const right = solveSpeechBox({ anchorX: 1000, anchorY: 400, ...BOX, ...VIEW });
    expect(left.opensRight).toBe(true);
    expect(left.x).toBeGreaterThan(200);
    expect(right.opensRight).toBe(false);
    expect(right.x + BOX.boxW).toBeLessThan(1000);
  });

  test('EXPANDED dimensions inherit the same guarantee', () => {
    const expanded = { boxW: 480, boxH: 260 };
    for (const anchor of [{ anchorX: 5, anchorY: 5 }, { anchorX: 1195, anchorY: 795 }]) {
      const solved = solveSpeechBox({ ...anchor, ...expanded, ...VIEW });
      expect(contained(solved, expanded.boxW, expanded.boxH)).toBe(true);
    }
  });

  test('viewport too small to hold the box clamps to inset, never negative', () => {
    const solved = solveSpeechBox({
      anchorX: 60, anchorY: 40, boxW: 500, boxH: 300, viewportW: 320, viewportH: 200,
    });
    expect(solved.x).toBe(SPEECH_INSET_PX);
    expect(solved.y).toBe(SPEECH_INSET_PX);
    expect(solved.contained).toBe(false);
  });
});

describe('bubble chain — pooled, deterministic, mouth-to-box', () => {
  test('dot phases are deterministic (no randomness)', () => {
    for (let i = 0; i < CHAIN_DOT_COUNT; i += 1) {
      expect(chainDotPhase(i)).toBe(chainDotPhase(i));
    }
  });

  test('layout mutates the pooled array in place with finite arc positions', () => {
    const pool = Array.from({ length: CHAIN_DOT_COUNT }, () => ({ x: 0, y: 0, scale: 0 }));
    const before = pool.slice();
    layoutChainDots(pool, 100, 500, 400, 200, 1000, false);
    for (let i = 0; i < pool.length; i += 1) {
      expect(pool[i]).toBe(before[i]); // same objects — zero alloc
      expect(Number.isFinite(pool[i].x)).toBe(true);
      expect(Number.isFinite(pool[i].y)).toBe(true);
      expect(pool[i].scale).toBeGreaterThan(0);
    }
    expect(Math.abs(pool[0].x - 100)).toBeLessThan(Math.abs(pool[0].x - 400));
    const last = pool[pool.length - 1];
    expect(Math.abs(last.x - 400)).toBeLessThan(Math.abs(last.x - 100));
  });

  test('reduced motion removes the per-frame bob (stable positions)', () => {
    const a = Array.from({ length: CHAIN_DOT_COUNT }, () => ({ x: 0, y: 0, scale: 0 }));
    const b = Array.from({ length: CHAIN_DOT_COUNT }, () => ({ x: 0, y: 0, scale: 0 }));
    layoutChainDots(a, 100, 500, 400, 200, 1000, true);
    layoutChainDots(b, 100, 500, 400, 200, 9999, true);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i].x).toBeCloseTo(b[i].x, 6);
      expect(a[i].y).toBeCloseTo(b[i].y, 6);
    }
  });
});

describe('speech system — typewriter, identity, honesty', () => {
  function build(options = {}) {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    layerEl.ownerDocument = doc;
    const system = createSquidRoomSpeechSystem({
      layerEl,
      document: doc,
      viewportW: 1200,
      viewportH: 800,
      ...options,
    });
    return { system, layerEl };
  }
  const ANCHORS = { builder: { mouthX: 300, mouthY: 400, headX: 300, headY: 380 } };

  test('renders exactly the text it was given — never generates', () => {
    const { system } = build({ reducedMotion: true });
    system.setSpeech('builder', {
      face: 'Gate passed.', full: 'Gate passed with proof.', raw: 'row 999 raw', rowIdentity: 'r1',
    });
    system.frame(1000, ANCHORS);
    const entry = system._pets.get('builder');
    expect(entry.textEl.textContent).toBe('Gate passed.');
    expect(entry.fullEl.textContent).toBe('Gate passed with proof.');
    expect(entry.rawEl.textContent).toBe('row 999 raw');
    expect(entry.rawEl.dataset.hasRaw).toBe('true');
  });

  test('typewriter advances monotonically at ~35cps and completes exactly', () => {
    const { system } = build();
    const face = 'The quick brown fox jumps over the lazy dog';
    system.setSpeech('builder', { face, rowIdentity: 'r2' });
    system.frame(0, ANCHORS);
    system.frame(1000, ANCHORS); // ~35 chars after 1s
    const entry = system._pets.get('builder');
    const after1s = entry.textEl.textContent.length;
    expect(after1s).toBeGreaterThanOrEqual(30);
    expect(after1s).toBeLessThanOrEqual(38);
    expect(face.startsWith(entry.textEl.textContent)).toBe(true);
    system.frame(5000, ANCHORS);
    expect(entry.textEl.textContent).toBe(face);
    expect(entry.box.dataset.typing).toBe('false');
  });

  test('same rowIdentity never restarts; new identity restarts from zero', () => {
    const { system } = build();
    system.setSpeech('builder', { face: 'first message body', rowIdentity: 'r3' });
    system.frame(0, ANCHORS);
    system.frame(600, ANCHORS);
    const entry = system._pets.get('builder');
    const progress = entry.textEl.textContent.length;
    expect(progress).toBeGreaterThan(0);
    system.setSpeech('builder', { face: 'first message body', rowIdentity: 'r3' });
    expect(entry.textEl.textContent.length).toBe(progress); // untouched
    system.setSpeech('builder', { face: 'second message', rowIdentity: 'r4' });
    expect(entry.textEl.textContent).toBe(''); // restarted
  });

  test('reduced motion reveals instantly (no animation dependency)', () => {
    const { system } = build({ reducedMotion: true });
    system.setSpeech('builder', { face: 'instant text', rowIdentity: 'r5' });
    const entry = system._pets.get('builder');
    expect(entry.textEl.textContent).toBe('instant text');
    expect(entry.box.dataset.typing).toBe('false');
  });

  test('missing anchor fails dark: box hidden, dots hidden, no guessing', () => {
    const { system } = build();
    system.setSpeech('builder', { face: 'talking', rowIdentity: 'r6' });
    system.frame(0, {});
    const entry = system._pets.get('builder');
    expect(entry.box.dataset.visible).toBe('false');
    for (const dot of entry.dots) expect(dot.style.opacity).toBe('0');
  });

  test('DOM nodes are pooled: repeated frames create nothing new', () => {
    const { system, layerEl } = build();
    system.setSpeech('builder', { face: 'pooled nodes', rowIdentity: 'r7' });
    system.frame(0, ANCHORS);
    const nodeCount = layerEl.querySelectorAll('*').length;
    for (let t = 16; t < 2000; t += 16) system.frame(t, ANCHORS);
    expect(layerEl.querySelectorAll('*').length).toBe(nodeCount);
  });

  test('hover expands with full + raw, and the expanded box still solves in-frame', () => {
    const { system } = build({ reducedMotion: true });
    system.setSpeech('builder', {
      face: 'short', full: 'the long full message', raw: 'raw line', rowIdentity: 'r8',
    });
    system.frame(0, ANCHORS);
    const entry = system._pets.get('builder');
    entry.box.trigger('mouseenter');
    expect(entry.box.classList.contains('is-expanded')).toBe(true);
    entry.box.offsetWidth = 480;
    entry.box.offsetHeight = 260;
    system.frame(16, ANCHORS); // re-solves with expanded dims
    const x = Number(String(entry.box.style.transform).match(/translate3d\(([-\d.]+)px/)?.[1]);
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(SPEECH_INSET_PX);
    expect(x + 480).toBeLessThanOrEqual(1200 - SPEECH_INSET_PX);
    entry.box.trigger('mouseleave');
    expect(entry.box.classList.contains('is-expanded')).toBe(false);
  });
});

describe('cross-review fixes — body exclusion + single-frame settle', () => {
  const { solveSpeechBox: solve } = require('../modules/squid-room-speech-system');

  test('mid-viewport anchors never solve into the body pad (given room)', () => {
    for (let ax = 200; ax <= 1000; ax += 160) {
      for (let ay = 200; ay <= 600; ay += 130) {
        const solved = solve({ anchorX: ax, anchorY: ay, boxW: 300, boxH: 90, viewportW: 1200, viewportH: 800 });
        expect(solved.clearsBody).toBe(true);
        const intersects = solved.x < ax + 44 && solved.x + 300 > ax - 44
          && solved.y < ay + 44 && solved.y + 90 > ay - 44;
        expect(intersects).toBe(false);
      }
    }
  });

  test('containment still wins when the viewport cannot clear the body', () => {
    const solved = solve({ anchorX: 160, anchorY: 100, boxW: 500, boxH: 300, viewportW: 320, viewportH: 200 });
    expect(solved.x).toBeGreaterThanOrEqual(16);
    expect(solved.y).toBeGreaterThanOrEqual(16);
  });

  test('a NEW message snaps to its solved spot on first frame (no glide-in)', () => {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    const system = createSquidRoomSpeechSystem({ layerEl, document: doc, viewportW: 1200, viewportH: 800 });
    const anchorsA = { builder: { mouthX: 200, mouthY: 400 } };
    const anchorsB = { builder: { mouthX: 950, mouthY: 300 } };
    system.setSpeech('builder', { face: 'first', rowIdentity: 'ra' });
    system.frame(0, anchorsA);
    system.frame(500, anchorsA);
    system.setSpeech('builder', { face: 'second message', rowIdentity: 'rb' });
    system.frame(516, anchorsB);
    const entry = system._pets.get('builder');
    expect(entry.posX).toBe(entry.targetX); // snapped, not gliding
    expect(entry.posY).toBe(entry.targetY);
  });
});

describe('defect fixes — jargon guard + creature avoidance (Architect row 73875)', () => {
  const { sanitizeSpeechText, solveSpeechBox: solve2 } = require('../modules/squid-room-speech-system');

  test('the face can never speak hashes, paths, or ids — even if upstream regresses', () => {
    expect(sanitizeSpeechText('committed as e4e03749 Free Squid Room creatures'))
      .toBe('committed as Free Squid Room creatures');
    expect(sanitizeSpeechText('proof sha256:9f14760feb2f4b17aec6d056c3f0b941 attached'))
      .toBe('proof attached');
    expect(sanitizeSpeechText('see .squidrun/coord/oracle-verify-2026.md for detail'))
      .toBe('see for detail');
    expect(sanitizeSpeechText('fixed ui/modules/squid-room-speech-system.js today'))
      .toBe('fixed today');
    expect(sanitizeSpeechText('closed wi-squidrun-p17-wave2-anatomy-463 passed'))
      .toBe('closed passed');
  });

  test('the guard strips but NEVER invents: hex-like English words survive, pure jargon goes silent', () => {
    expect(sanitizeSpeechText('the wall was defaced badly')).toBe('the wall was defaced badly');
    expect(sanitizeSpeechText('sha256:aaaaaaaaaaaaaaaa1111')).toBe('');
  });

  test('setSpeech with pure-jargon face stays silent instead of inventing', () => {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    const system = createSquidRoomSpeechSystem({ layerEl, document: doc, viewportW: 1200, viewportH: 800 });
    system.setSpeech('builder', { face: 'sha256:ab12cd34ef56ab12', rowIdentity: 'rj1' });
    const entry = system._pets.get('builder');
    expect(entry.box.dataset.visible).toBe('false');
  });

  test('solver avoids creature body rects when geometry allows', () => {
    const avoid = [{ x: 500, y: 300, w: 120, h: 140 }];
    const solved = solve2({
      anchorX: 560, anchorY: 360, boxW: 300, boxH: 90,
      viewportW: 1200, viewportH: 800, avoidRects: avoid,
    });
    const r = avoid[0];
    const overlaps = solved.x < r.x + r.w && solved.x + 300 > r.x
      && solved.y < r.y + r.h && solved.y + 90 > r.y;
    expect(overlaps).toBe(false);
    expect(solved.clearsBody).toBe(true);
  });

  test('containment still beats avoidance when the room is too small', () => {
    const solved = solve2({
      anchorX: 160, anchorY: 100, boxW: 280, boxH: 160, viewportW: 320, viewportH: 200,
      avoidRects: [{ x: 0, y: 0, w: 320, h: 200 }],
    });
    expect(solved.x).toBeGreaterThanOrEqual(16);
    expect(solved.y).toBeGreaterThanOrEqual(16);
    expect(solved.clearsBody).toBe(false);
  });
});

describe('verify-frame-1 fixes — filename debris + box-vs-box', () => {
  const { sanitizeSpeechText: san } = require('../modules/squid-room-speech-system');

  test('bare filenames strip clean (no "capture-.png" debris)', () => {
    expect(san('as promised, capture-1782981794410.png: both boxes'))
      .toBe('as promised,: both boxes');
    expect(san('see squid-room-speech-system.test.js for contracts'))
      .toBe('see for contracts');
  });

  test('two speaking pets never get overlapping boxes', () => {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    const system = createSquidRoomSpeechSystem({ layerEl, document: doc, viewportW: 1200, viewportH: 800 });
    const anchors = {
      builder: { mouthX: 500, mouthY: 300, bodyX: 440, bodyY: 240, bodyW: 120, bodyH: 140 },
      oracle: { mouthX: 700, mouthY: 300, bodyX: 640, bodyY: 240, bodyW: 120, bodyH: 140 },
    };
    system.setSpeech('builder', { face: 'builder speaking now', rowIdentity: 'bb1' });
    system.setSpeech('oracle', { face: 'oracle speaking now', rowIdentity: 'oo1' });
    system.frame(0, anchors);
    system.frame(100, anchors);
    const b = system._pets.get('builder');
    const o = system._pets.get('oracle');
    const bw = b.box.offsetWidth; const bh = b.box.offsetHeight;
    const ow = o.box.offsetWidth; const oh = o.box.offsetHeight;
    const overlap = b.posX < o.posX + ow && b.posX + bw > o.posX
      && b.posY < o.posY + oh && b.posY + bh > o.posY;
    expect(overlap).toBe(false);
  });
});
