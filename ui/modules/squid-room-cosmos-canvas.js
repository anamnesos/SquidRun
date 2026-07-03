/**
 * THE PAINTED COSMOS (v3) — canvas night-ocean, hand-authored by Architect.
 *
 * James (S466): "make the background universe something different...
 * massive changes... rethink this." v2 refined CSS gradients; this
 * replaces the medium. Real painterly depth needs real pixels:
 * fBm-noise nebula clouds and a power-law starfield are PAINTED ONCE
 * to offscreen layers, then composited each frame with slow parallax
 * plus a bounded particle pass (rising marine snow, twinkling sparks).
 *
 * PERF LAW (Oracle contract #5 lineage):
 *  - Noise + nebula + stars render exactly ONCE per (load|resize).
 *  - The frame loop does drawImage composites + <= MAX_PARTICLES dots.
 *  - No gradients constructed inside the frame loop. None.
 *  - Loop throttled to ~30fps; paused when the document is hidden.
 *  - Reduced motion: composite a single still frame, no loop.
 *
 * The depth story survives from v2: light surface above, abyss below,
 * stars live in the upper water, the deep belongs to the snow, and the
 * creatures' violet/teal are the only colors the clouds know.
 */

'use strict';

const COSMOS_CANVAS_CLASS = 'cosmos-canvas';
const MAX_PARTICLES = 140;
const FRAME_INTERVAL_MS = 33; // ~30fps — the background breathes, it doesn't race
const NEBULA_SCALE = 1;       // FULL res: scale-up blur read as fog (gate law)

/* ── deterministic PRNG (mulberry32) — same sky for a given seed ── */
function createPrng(seed) {
  let a = seed >>> 0;
  return function prng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── value noise + fBm: the cloud structure ── */
function buildNoiseGrid(prng, size) {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i += 1) grid[i] = prng();
  return grid;
}

function sampleNoise(grid, size, x, y) {
  const xi = Math.floor(x) % size; const yi = Math.floor(y) % size;
  const xf = x - Math.floor(x); const yf = y - Math.floor(y);
  const x2 = (xi + 1) % size; const y2 = (yi + 1) % size;
  const sx = xf * xf * (3 - 2 * xf); const sy = yf * yf * (3 - 2 * yf);
  const a = grid[yi * size + xi]; const b = grid[yi * size + x2];
  const c = grid[y2 * size + xi]; const d = grid[y2 * size + x2];
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(grid, size, x, y, octaves) {
  let value = 0; let amplitude = 0.5; let frequency = 1;
  for (let o = 0; o < octaves; o += 1) {
    value += amplitude * sampleNoise(grid, size, x * frequency, y * frequency);
    amplitude *= 0.5; frequency *= 2;
  }
  return value;
}

/* ── layer painters: each runs ONCE per (load|resize) ── */

function paintBase(ctx, w, h, tokens) {
  // Deep night, uniformly dark. The old light-at-the-top water column WAS
  // the haze James kept seeing (fog-gate: lifted mean luminance across the
  // whole band); depth is now told by star density and cloud placement,
  // not by paling the water. No surface bloom — a pale radial wash is fog
  // by definition.
  const ramp = ctx.createLinearGradient(0, 0, 0, h);
  const rgb = (t) => `rgb(${t[0]}, ${t[1]}, ${t[2]})`;
  ramp.addColorStop(0.0, rgb(tokens['--sr2-abyss-2']));
  ramp.addColorStop(0.5, rgb(tokens['--sr2-abyss-1']));
  ramp.addColorStop(1.0, rgb(tokens['--sr2-abyss-0']));
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, w, h);
}

function paintNebula(ctx, w, h, prng, tokens) {
  // ASTROPHOTO CLOUDS: a few DEFINED formations, not a wash (fog-gate law).
  // Full-res, domain-warped fBm for filamentary structure; pixels are only
  // computed inside each formation's gaussian window, so the sky between
  // formations stays perfectly dark and the paint stays fast.
  const size = 128;
  const gridA = buildNoiseGrid(prng, size);
  const gridW = buildNoiseGrid(prng, size);
  const image = ctx.createImageData(w, h);
  const data = image.data;
  const formations = [
    // Oracle's violet nebula — upper right corner
    { cx: 0.82, cy: 0.14, rx: 0.30, ry: 0.16, color: tokens['--sr2-violet'], gain: 3.0, threshold: 0.46, seedOff: 0 },
    // Builder's teal nebula — upper left corner
    { cx: 0.14, cy: 0.20, rx: 0.26, ry: 0.14, color: tokens['--sr2-teal'], gain: 2.8, threshold: 0.47, seedOff: 11 },
    // small magenta seam — high center, quiet
    { cx: 0.47, cy: 0.08, rx: 0.14, ry: 0.07, color: tokens['--sr2-magenta'], gain: 2.4, threshold: 0.50, seedOff: 23 },
  ];
  for (const f of formations) {
    const x0 = Math.max(0, Math.floor((f.cx - f.rx) * w));
    const x1 = Math.min(w, Math.ceil((f.cx + f.rx) * w));
    const y0 = Math.max(0, Math.floor((f.cy - f.ry) * h));
    const y1 = Math.min(h, Math.ceil((f.cy + f.ry) * h));
    for (let y = y0; y < y1; y += 1) {
      const v = y / h;
      const dy = (v - f.cy) / f.ry;
      for (let x = x0; x < x1; x += 1) {
        const u = x / w;
        const dx = (u - f.cx) / f.rx;
        const window = Math.exp(-(dx * dx + dy * dy) * 2.2);
        if (window < 0.03) continue;
        // domain warp: filaments instead of blobs
        const wx = fbm(gridW, size, u * 3.1 + f.seedOff, v * 3.1, 3) - 0.5;
        const wy = fbm(gridW, size, u * 3.1 + 40 + f.seedOff, v * 3.1 + 40, 3) - 0.5;
        const n = fbm(gridA, size, (u + wx * 0.35) * 9 + f.seedOff, (v + wy * 0.35) * 9, 6);
        const cloud = Math.pow(Math.max(0, n - f.threshold) * f.gain, 2.1) * window;
        if (cloud <= 0.004) continue;
        const i = (y * w + x) * 4;
        const a = Math.min(220, cloud * 255);
        if (a <= data[i + 3]) continue; // keep the stronger formation's pixel
        data[i] = f.color[0];
        data[i + 1] = f.color[1];
        data[i + 2] = f.color[2];
        data[i + 3] = a;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

function paintStars(ctx, w, h, prng) {
  // Power-law starfield, upper-weighted: the stars belong to the surface.
  const count = Math.round(340 + (w * h) / 8000);
  for (let s = 0; s < count; s += 1) {
    const x = prng() * w;
    // depth bias: squared distribution pushes stars toward the top
    const y = Math.pow(prng(), 1.9) * h * 0.72;
    const mag = Math.pow(prng(), 3); // few bright, many dim
    const r = 0.4 + mag * 1.7;
    const alpha = 0.26 + mag * 0.74;
    const warm = prng();
    const tint = warm > 0.82 ? '255, 236, 214' : warm > 0.6 ? '196, 224, 255' : '236, 242, 255';
    if (mag > 0.82) {
      // the bright few get a soft halo + cross glint, painted here, once
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
      halo.addColorStop(0, `rgba(${tint}, ${alpha * 0.5})`);
      halo.addColorStop(1, `rgba(${tint}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);
      ctx.strokeStyle = `rgba(${tint}, ${alpha * 0.35})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x - r * 5, y); ctx.lineTo(x + r * 5, y);
      ctx.moveTo(x, y - r * 5); ctx.lineTo(x, y + r * 5);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${tint}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintFloorGlow(ctx, w, h, tokens) {
  // The milky sea: bioluminescent teal at the abyss floor.
  const glow = ctx.createRadialGradient(w * 0.5, h * 1.18, h * 0.05, w * 0.5, h * 1.18, h * 0.55);
  const b = tokens['--sr2-biolume'];
  glow.addColorStop(0, `rgba(${b[0]}, ${b[1]}, ${b[2]}, 0.09)`);
  glow.addColorStop(0.5, 'rgba(74, 196, 182, 0.05)');
  glow.addColorStop(1, 'rgba(74, 196, 182, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);
}

/* ── particles: the only per-frame simulation, strictly bounded ── */
function spawnParticle(prng, w, h, initial) {
  const spark = prng() < 0.16; // most are snow; a few are biolume sparks
  return {
    x: prng() * w,
    y: initial ? prng() * h : h + 4,
    r: spark ? 0.9 + prng() * 1.3 : 0.6 + prng() * 1.1,
    vy: -(4 + prng() * 9) / 1000,           // px per ms, rising
    vx: (prng() - 0.35) * 3 / 1000,          // slight sideways drift
    spark,
    phase: prng() * Math.PI * 2,
    tw: 0.5 + prng() * 1.5,                  // twinkle rate
  };
}

/* ── constitution tokens (--sr2-*): CSS custom properties are the source
      of truth; the constitution's signed values are the fallbacks. ── */
const SR2_FALLBACKS = {
  '--sr2-abyss-0': '#010208',
  '--sr2-abyss-1': '#02040c',
  '--sr2-abyss-2': '#04060f',
  '--sr2-teal': '#48bed6',
  '--sr2-violet': '#8a5ce2',
  '--sr2-magenta': '#ba5cb0',
  '--sr2-biolume': '#5eead4',
};

function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readSr2Tokens(doc, win) {
  const out = {};
  let styles = null;
  try {
    styles = win?.getComputedStyle?.(doc.documentElement) || null;
  } catch (_) {}
  for (const [name, fallback] of Object.entries(SR2_FALLBACKS)) {
    const raw = styles?.getPropertyValue?.(name);
    out[name] = hexToRgb(raw && raw.trim() ? raw : fallback) || hexToRgb(fallback);
  }
  return out;
}

function createCosmosCanvasRuntime(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const win = options.window || doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const canvas = options.canvas || doc.querySelector(`.${COSMOS_CANVAS_CLASS}`);
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const seed = Number.isFinite(options.seed) ? options.seed : 0x5eabed;
  const reducedMotion = typeof options.reducedMotion === 'boolean'
    ? options.reducedMotion
    : Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  const state = {
    running: false,
    paintCount: 0,          // contract: increments only on load/resize paints
    particles: [],
    layers: null,
    lastFrameAt: 0,
    rafId: null,
    width: 0,
    height: 0,
    drift: { star: 0, nebula: 0 },
  };

  function makeLayer(w, h, scale = 1) {
    const layer = doc.createElement('canvas');
    layer.width = Math.max(1, Math.round(w * scale));
    layer.height = Math.max(1, Math.round(h * scale));
    return layer;
  }

  function paintLayers() {
    const w = state.width; const h = state.height;
    if (!w || !h) return;
    const prng = createPrng(seed);
    const tokens = readSr2Tokens(doc, win);
    const base = makeLayer(w, h);
    paintBase(base.getContext('2d'), w, h, tokens);
    paintFloorGlow(base.getContext('2d'), w, h, tokens);
    const nebula = makeLayer(w, h, NEBULA_SCALE);
    paintNebula(nebula.getContext('2d'), nebula.width, nebula.height, prng, tokens);
    const stars = makeLayer(w * 1.06, h); // 6% wider than view = parallax room
    paintStars(stars.getContext('2d'), stars.width, h, prng);
    state.layers = { base, nebula, stars };
    state.paintCount += 1;
  }

  function resize() {
    const w = Math.round(win?.innerWidth || canvas.clientWidth || 0);
    const h = Math.round(win?.innerHeight || canvas.clientHeight || 0);
    if (!w || !h) return;
    if (w === state.width && h === state.height && state.layers) return;
    state.width = w; state.height = h;
    canvas.width = w; canvas.height = h;
    paintLayers();
    if (state.particles.length === 0) {
      const prng = createPrng(seed ^ 0x9e3779b9);
      for (let i = 0; i < MAX_PARTICLES; i += 1) state.particles.push(spawnParticle(prng, w, h, true));
    }
    compositeFrame(0);
  }

  function compositeFrame(elapsedMs) {
    const { layers, width: w, height: h } = state;
    if (!layers) return;
    // parallax offsets: the sky drifts slower than anything alive
    state.drift.star = (state.drift.star + elapsedMs * 0.00055) % (layers.stars.width - w || 1);
    state.drift.nebula = (state.drift.nebula + elapsedMs * 0.0011) % (w * 0.5);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(layers.base, 0, 0, w, h);
    // nebula breathes sideways, half-res scaled up
    const nx = -state.drift.nebula * 0.06;
    ctx.globalAlpha = 0.96;
    ctx.drawImage(layers.nebula, nx, 0, w * 1.06, h);
    ctx.globalAlpha = 1;
    ctx.drawImage(layers.stars, -state.drift.star, 0);

    // particle pass — additive, bounded, gradient-free
    const prng = null; // (respawn uses Math-free path below)
    ctx.globalCompositeOperation = 'lighter';
    const particles = state.particles;
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      p.x += p.vx * elapsedMs;
      p.y += p.vy * elapsedMs;
      p.phase += (elapsedMs / 1000) * p.tw;
      if (p.y < -6 || p.x < -6 || p.x > w + 6) {
        // recycle at the floor, deterministic-enough without a PRNG object
        p.x = ((p.x * 31 + i * 17) % w + w) % w;
        p.y = h + 4;
      }
      const twinkle = p.spark ? (0.35 + 0.65 * Math.abs(Math.sin(p.phase))) : (0.55 + 0.2 * Math.sin(p.phase));
      const alpha = (p.spark ? 0.66 : 0.34) * twinkle;
      ctx.fillStyle = p.spark
        ? `rgba(132, 240, 220, ${alpha})`
        : `rgba(190, 222, 232, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    if (!state.running) return;
    const elapsed = state.lastFrameAt ? now - state.lastFrameAt : FRAME_INTERVAL_MS;
    if (elapsed >= FRAME_INTERVAL_MS) {
      state.lastFrameAt = now;
      compositeFrame(Math.min(elapsed, 100));
    }
    state.rafId = win?.requestAnimationFrame ? win.requestAnimationFrame(frame) : null;
  }

  function start() {
    resize();
    if (reducedMotion) { compositeFrame(0); return; } // one still frame, no loop
    if (state.running) return;
    state.running = true;
    state.lastFrameAt = 0;
    state.rafId = win?.requestAnimationFrame ? win.requestAnimationFrame(frame) : null;
  }

  function stop() {
    state.running = false;
    if (state.rafId && win?.cancelAnimationFrame) win.cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  win?.addEventListener?.('resize', resize);
  doc.addEventListener?.('visibilitychange', () => {
    if (doc.hidden) stop();
    else start();
  });

  return {
    start,
    stop,
    resize,
    get paintCount() { return state.paintCount; },
    get particleCount() { return state.particles.length; },
    get running() { return state.running; },
    compositeFrame, // exposed for the mount-harness contracts
  };
}

module.exports = {
  COSMOS_CANVAS_CLASS,
  MAX_PARTICLES,
  createCosmosCanvasRuntime,
  // exported for contracts: the painters must be pure and callable once
  createPrng,
  fbm,
  buildNoiseGrid,
};
