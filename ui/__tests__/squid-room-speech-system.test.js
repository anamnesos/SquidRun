'use strict';

const {
  SPEECH_INSET_PX,
  createSquidRoomSpeechSystem,
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

describe('day-mandate fixes — least-harm fallback + husk removal', () => {
  const mod = require('../modules/squid-room-speech-system');

  test('blocked-everywhere geometry parks on OWN body, never the other creature', () => {
    // Two bodies flanking the anchor so every quadrant candidate intersects
    // something; own body weight 1 vs other 3 must pull the box onto own.
    const own = { x: 500, y: 300, w: 400, h: 400, weight: 1 };
    const other = { x: 100, y: 100, w: 1000, h: 700, weight: 3 };
    const solved = mod.solveSpeechBox({
      anchorX: 700, anchorY: 500, boxW: 300, boxH: 90,
      viewportW: 1200, viewportH: 800, avoidRects: [other, own],
    });
    const overlapArea = (r) => {
      const ox = Math.min(solved.x + 300, r.x + r.w) - Math.max(solved.x, r.x);
      const oy = Math.min(solved.y + 90, r.y + r.h) - Math.max(solved.y, r.y);
      return Math.max(0, ox) * Math.max(0, oy);
    };
    // Weighted harm of the chosen spot must be no worse than any of the four
    // naive quadrant candidates (the old blind-first behavior).
    expect(solved.clearsBody).toBe(false);
    expect(overlapArea(own) * 1 + overlapArea(other) * 3)
      .toBeLessThanOrEqual(300 * 90 * 3);
    expect(overlapArea(other)).toBeLessThan(300 * 90); // never fully on the other
  });

  test('husk removal drops slash-number runs and letter-less parens', () => {
    expect(mod.sanitizeSpeechText('verified (captures / 133332 / 153552, 55s span) done'))
      .toBe('verified (captures, 55s span) done');
    expect(mod.sanitizeSpeechText('checked ( 12345 / 67890 ) fine')).toBe('checked fine');
    expect(mod.sanitizeSpeechText('suites 18/18 green, 3/4 quadrants'))
      .toBe('suites 18/18 green, 3/4 quadrants'); // small legit ratios survive
  });
});

test('shell-escape artifacts become plain apostrophes on the face', () => {
  const { sanitizeSpeechText } = require('../modules/squid-room-speech-system');
  const escaped = "the label" + String.fromCharCode(39, 92, 39, 39) + "s offsets were stale";
  expect(sanitizeSpeechText(escaped)).toBe("the label's offsets were stale");
});

describe('polish lane — hysteresis, asymmetric yield, flowing tails (James 10:49)', () => {
  function build2() {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    return createSquidRoomSpeechSystem({ layerEl, document: doc, viewportW: 1600, viewportH: 900 });
  }
  const mkAnchor = (x, y) => ({ mouthX: x, mouthY: y, bodyX: x - 60, bodyY: y - 50, bodyW: 120, bodyH: 140 });

  test('sub-deadband anchor wiggle never re-solves: the box has weight', () => {
    const sys = build2();
    sys.setSpeech('builder', { face: 'weighted box', rowIdentity: 'h1' });
    sys.frame(0, { builder: mkAnchor(400, 400) });
    const e = sys._pets.get('builder');
    const t0x = e.targetX; const t0y = e.targetY;
    // 120 frames of +/-10px wiggle (inside the 28px deadband)
    for (let f = 1; f <= 120; f += 1) {
      const wob = (f % 2 ? 10 : -10);
      sys.frame(f * 16, { builder: mkAnchor(400 + wob, 400 + wob) });
      expect(e.targetX).toBe(t0x);
      expect(e.targetY).toBe(t0y);
    }
  });

  test('two colliding boxes settle: junior yields, senior stands, no thrash', () => {
    const sys = build2();
    sys.setSpeech('builder', { face: 'senior box message', rowIdentity: 'h2' });
    sys.setSpeech('oracle', { face: 'junior box message', rowIdentity: 'h3' });
    const anchors = { builder: mkAnchor(700, 400), oracle: mkAnchor(760, 400) };
    const b = sys._pets.get('builder');
    const o = sys._pets.get('oracle');
    for (let f = 0; f <= 60; f += 1) sys.frame(f * 16, anchors);
    const bT = { x: b.targetX, y: b.targetY };
    const oT = { x: o.targetX, y: o.targetY };
    // 120 more frames with static anchors: targets must be FROZEN (no oscillation)
    for (let f = 61; f <= 180; f += 1) {
      sys.frame(f * 16, anchors);
      expect(b.targetX).toBe(bT.x); expect(b.targetY).toBe(bT.y);
      expect(o.targetX).toBe(oT.x); expect(o.targetY).toBe(oT.y);
    }
    // and the settled boxes do not overlap each other
    const bw = b.box.offsetWidth, bh = b.box.offsetHeight;
    const ow = o.box.offsetWidth, oh = o.box.offsetHeight;
    const overlap = b.posX < o.posX + ow && b.posX + bw > o.posX
      && b.posY < o.posY + oh && b.posY + bh > o.posY;
    expect(overlap).toBe(false);
  });

  test('facing flip does not teleport the chain base: smoothed mouth is bounded per frame', () => {
    const sys = build2();
    sys.setSpeech('builder', { face: 'flip test', rowIdentity: 'h4' });
    sys.frame(0, { builder: mkAnchor(400, 400) });
    sys.frame(16, { builder: mkAnchor(400, 400) });
    const e = sys._pets.get('builder');
    const before = e.mouthSX;
    // facing flip: raw mouth jumps 20px instantly
    sys.frame(32, { builder: mkAnchor(420, 400) });
    expect(Math.abs(e.mouthSX - before)).toBeLessThan(8); // absorbed, not teleported
  });

});

describe('rethink lane — glass skin lifecycle + ribbon seam (Builder #57)', () => {
  const { SPEECH_GLOW } = require('../modules/squid-room-speech-system');
  function build3(opts = {}) {
    const doc = makeFakeDocument();
    const layerEl = makeFakeElement('div');
    return createSquidRoomSpeechSystem({ layerEl, document: doc, viewportW: 1600, viewportH: 900, ...opts });
  }
  const A = { builder: { mouthX: 400, mouthY: 400 }, oracle: { mouthX: 1100, mouthY: 400 } };

  test('frame() returns the typed seam: attach point on the box edge, speaker color, pooled identity', () => {
    const sys = build3();
    sys.setSpeech('builder', { face: 'seam test message', rowIdentity: 's1' });
    const out1 = sys.frame(0, A);
    const e = sys._pets.get('builder');
    const a = out1.builder;
    expect(a.visible).toBe(true);
    expect(a.color).toBe(SPEECH_GLOW.builder);
    expect(a.attachX).toBeGreaterThanOrEqual(e.posX);
    expect(a.attachX).toBeLessThanOrEqual(e.posX + e.box.offsetWidth);
    expect([e.posY, e.posY + e.box.offsetHeight]).toContain(a.attachY); // on top or bottom edge
    const out2 = sys.frame(16, A);
    expect(out2.builder).toBe(out1.builder); // pooled — zero per-frame alloc
  });

  test('seam goes dark with the box: fail-dark anchor loss -> visible false same frame', () => {
    const sys = build3();
    sys.setSpeech('builder', { face: 'dark test', rowIdentity: 's2' });
    sys.frame(0, A);
    const out = sys.frame(16, {}); // anchors gone
    expect(out.builder.visible).toBe(false);
  });

  test('entrance blooms from the mouth-side corner: data-anim + opens attrs set', () => {
    const sys = build3();
    sys.setSpeech('builder', { face: 'enter test', rowIdentity: 's3' });
    const e = sys._pets.get('builder');
    expect(e.box.dataset.anim).toBe('enter');
    sys.frame(0, A);
    expect(['true', 'false']).toContain(e.box.dataset.opensRight);
    expect(['true', 'false']).toContain(e.box.dataset.opensBelow);
  });

  test('exit dissolves then hides: anim=exit, seam dark immediately, hidden after the dissolve', () => {
    const sys = build3();
    sys.setSpeech('builder', { face: 'exit test', rowIdentity: 's4' });
    sys.frame(0, A);
    sys.setSpeech('builder', { face: '', rowIdentity: 's5' }); // message ends
    const e = sys._pets.get('builder');
    expect(e.box.dataset.anim).toBe('exit');
    const mid = sys.frame(100, A); // mid-dissolve: still rendered, seam dark
    expect(e.box.dataset.visible).toBe('true');
    expect(mid.builder.visible).toBe(false);
    sys.frame(400, A); // past EXIT_DISSOLVE_MS
    expect(e.box.dataset.visible).toBe('false');
    expect(e.visible).toBe(false);
  });

  test('reduced motion: no enter/exit animation, instant hide (accessibility honesty)', () => {
    const sys = build3({ reducedMotion: true });
    sys.setSpeech('builder', { face: 'rm test', rowIdentity: 's6' });
    const e = sys._pets.get('builder');
    expect(e.box.dataset.anim).toBe('');
    sys.frame(0, A);
    sys.setSpeech('builder', { face: '', rowIdentity: 's7' });
    expect(e.box.dataset.visible).toBe('false'); // instant, no dissolve
  });

  test('shell carries the skin, box carries position: text still renders through the shell', () => {
    const sys = build3({ reducedMotion: true });
    sys.setSpeech('builder', { face: 'shell test', rowIdentity: 's8' });
    sys.frame(0, A);
    const e = sys._pets.get('builder');
    expect(e.textEl.textContent).toBe('shell test');
    expect(e.box.children.length).toBe(1); // exactly the shell between box and content
  });
});

describe('window audit fixes — headers are not speech, debris never renders', () => {
  const { sanitizeSpeechText: san2 } = require('../modules/squid-room-speech-system');

  test('agent-ref headers with em-dash tails strip; the honest verb survives', () => {
    expect(san2('Resting: (ORACLE #204 — RETHINK LANE SHIPPED, live): All five items in one pass'))
      .toBe('Resting: All five items in one pass');
    expect(san2('(BUILDER #57 - THE TAIL SEAM, one message per protocol): Ribbon accepted, and one geometry correction'))
      .toBe('Ribbon accepted, and one geometry correction');
  });
});
