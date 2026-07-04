#!/usr/bin/env node
'use strict';

/**
 * THE ROOM GATE (S467 remodel charter): "the gate owns done" — executable.
 * Runs every mechanical reveal gate and exits nonzero on any failure:
 *   1. FOG GATE   — burst captures; over the swim band (above the section
 *                   bar): mean luma < MEAN_MAX and fogIndex < FOG_MAX, where
 *                   fogIndex = fraction of pixels in the haze band
 *                   (luma 40..120: too bright to be abyss, too dim to be a
 *                   star — the gray veil James called haze five times).
 *   2. JARGON GATE— last N real messages through the REAL face pipeline
 *                   (renderer.js functions, not copies): no machine
 *                   identifiers on any face.
 *   3. SUITES     — all squid-room jest suites green (includes the v2
 *                   whitelist contract).
 * Usage: node ui/scripts/hm-room-gate.js [--frames 3] [--skip-capture]
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FOG_MAX = 0.18;
const MEAN_MAX = 24;
const SWIM_BAND_FRACTION = 0.40; // top 40% of the window = open water
const JARGON_PATTERNS = [
  [/\bsha256[:=]?\s*[0-9a-f]{8,64}\b/i, 'sha256 hash'],
  [/\b(?=[0-9a-f]{7,40}\b)[a-f]*\d[0-9a-f]*\b/, 'bare hex hash'],
  [/\bhm-\d{10,}-[a-z0-9]+\b/i, 'message id'],
  [/\b[\w-]+\.(?:js|ts|tsx|json|png|md)\b/i, 'filename'],
  [/\b(?:rowId|messageId|deliveryId)\b/i, 'ledger field'],
];

const args = process.argv.slice(2);
const frames = Number(args[args.indexOf('--frames') + 1]) || 3;
const skipCapture = args.includes('--skip-capture');
const results = [];

function gate(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * PRESENCE GATE (court amendment, Builder #62: the court PASSED AN EMPTY
 * ROOM — quality gates measure what renders, never whether). Fail-dark's
 * other half: no render must FAIL when render was promised. Asserts both
 * creatures are visibly painted (their saturated token colors mass above a
 * floor anywhere above the shore), and the shore itself renders (section
 * band brighter than abyss).
 */
async function presenceGate(sharp, shot) {
  const meta = await sharp(shot).metadata();
  const searchH = Math.floor(meta.height * 0.55); // open water: above the shore
  const raw = await sharp(shot).extract({ left: 0, top: 0, width: meta.width, height: searchH }).raw().toBuffer();
  const ch = 3;
  let teal = 0; let violet = 0;
  for (let y = 0; y < searchH; y += 2) {
    for (let x = 0; x < meta.width; x += 2) {
      const i = (y * meta.width + x) * ch;
      const r = raw[i]; const g = raw[i + 1]; const b = raw[i + 2];
      if (b > 140 && g > 120 && r < g - 40) teal += 1;
      else if (r > 90 && b > 140 && g < r - 10) violet += 1;
    }
  }
  const FLOOR = 150; // a creature body at stride-2 is thousands of hits; 150 = unmistakably present
  gate(`presence creatures ${path.basename(shot)}`, teal >= FLOOR && violet >= FLOOR,
    `teal=${teal} violet=${violet} (floor ${FLOOR} each)${teal < FLOOR ? ' — BUILDER MISSING' : ''}${violet < FLOOR ? ' — ORACLE MISSING' : ''}`);
  // Shore: the section band (below 62% height) must render brighter than abyss.
  const shoreTop = Math.floor(meta.height * 0.62);
  const shoreRaw = await sharp(shot)
    .extract({ left: 0, top: shoreTop, width: meta.width, height: Math.min(200, meta.height - shoreTop) })
    .greyscale().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < shoreRaw.length; i += 1) sum += shoreRaw[i];
  const shoreMean = sum / shoreRaw.length;
  gate(`presence shore ${path.basename(shot)}`, shoreMean > 8,
    `shoreMean=${shoreMean.toFixed(1)} (>8; empty void would read ~abyss)`);
}

/**
 * UNDERLAY CHECK (constitution I: NOTHING SEATS ANYTHING — James's exact
 * eye as a court). Finds each creature as the centroid of its saturated
 * token color (teal/violet — glass tint is ~13% glow, far below body
 * saturation), then compares the patch UNDER the body against same-altitude
 * open sky (darkest same-row patch). A smudge = lifted (delta-mean) AND
 * smoothed (variance ratio) — the fifth ghost class, measured.
 */
async function underlayCheck(sharp, shot) {
  const meta = await sharp(shot).metadata();
  const bandH = Math.floor(meta.height * SWIM_BAND_FRACTION);
  const raw = await sharp(shot).extract({ left: 0, top: 0, width: meta.width, height: bandH }).raw().toBuffer();
  const ch = 3;
  const masses = { teal: { x: 0, y: 0, n: 0 }, violet: { x: 0, y: 0, n: 0 } };
  for (let y = 0; y < bandH; y += 2) {
    for (let x = 0; x < meta.width; x += 2) {
      const i = (y * meta.width + x) * ch;
      const r = raw[i]; const g = raw[i + 1]; const b = raw[i + 2];
      if (b > 140 && g > 120 && r < g - 40) { masses.teal.x += x; masses.teal.y += y; masses.teal.n += 1; }
      else if (r > 90 && b > 140 && g < r - 10) { masses.violet.x += x; masses.violet.y += y; masses.violet.n += 1; }
    }
  }
  const patchStats = (cx, cy, w, h) => {
    let sum = 0; let n = 0; const vals = [];
    for (let y = Math.max(0, cy); y < Math.min(bandH, cy + h); y += 1) {
      for (let x = Math.max(0, cx); x < Math.min(meta.width, cx + w); x += 1) {
        const i = (y * meta.width + x) * ch;
        const luma = (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
        sum += luma; n += 1; vals.push(luma);
      }
    }
    const mean = n ? sum / n : 0;
    const variance = n ? vals.reduce((a, v) => a + Math.abs(v - mean), 0) / n : 0;
    return { mean, variance };
  };
  for (const [name, m] of Object.entries(masses)) {
    if (m.n < 60) continue; // creature not in band (below waterline etc.)
    const cx = Math.round(m.x / m.n); const cy = Math.round(m.y / m.n);
    const under = patchStats(cx - 45, cy + 55, 90, 34);
    // open-sky reference: darkest same-altitude patch among candidates
    let sky = null;
    for (const off of [-420, -300, 300, 420]) {
      const s = patchStats(cx + off - 45, cy + 55, 90, 34);
      if (s.mean > 0 && (!sky || s.mean < sky.mean)) sky = s;
    }
    if (!sky) continue;
    const dMean = under.mean - sky.mean;
    const smoothed = under.variance < sky.variance * 0.7;
    const smudge = dMean > 6 && smoothed;
    gate(`underlay ${name} ${path.basename(shot)}`, !smudge,
      `dMean=${dMean.toFixed(1)} underVar=${under.variance.toFixed(1)} skyVar=${sky.variance.toFixed(1)}${smudge ? ' — SEATED GHOST' : ''}`);
    if (smudge) return;
  }
}

async function fogGate() {
  if (skipCapture) return gate('fog', true, 'skipped by flag');
  let sharp;
  try { sharp = require(path.join(ROOT, 'ui', 'node_modules', 'sharp')); } catch {
    return gate('fog', false, 'sharp unavailable — cannot measure, cannot pass (no evidence, no green)');
  }
  const shots = [];
  for (let i = 0; i < frames; i += 1) {
    const out = execFileSync('node', [path.join(ROOT, 'ui/scripts/hm-screenshot.js'), 'capture', '--window-key', 'squid-room', '--run-id', `room-gate-f${i}`], { cwd: ROOT, encoding: 'utf8' });
    const m = out.match(/"path":\s*"([^"]+)"/);
    if (m) shots.push(m[1].replace(/\\\\/g, '\\'));
    if (i < frames - 1) execSync('node -e "setTimeout(()=>{}, 4000)"');
  }
  if (!shots.length) return gate('fog', false, 'no captures');
  for (const shot of shots) {
    const img = sharp(shot).greyscale();
    const meta = await img.metadata();
    const bandH = Math.floor(meta.height * SWIM_BAND_FRACTION);
    const raw = await sharp(shot).extract({ left: 0, top: 0, width: meta.width, height: bandH }).greyscale().raw().toBuffer();
    let sum = 0; let haze = 0;
    for (let i = 0; i < raw.length; i += 1) {
      sum += raw[i];
      if (raw[i] >= 40 && raw[i] <= 120) haze += 1;
    }
    const mean = sum / raw.length;
    const fogIndex = haze / raw.length;
    const ok = fogIndex < FOG_MAX && mean < MEAN_MAX;
    gate(`fog ${path.basename(shot)}`, ok, `fogIndex=${fogIndex.toFixed(3)} (<${FOG_MAX}) mean=${mean.toFixed(1)} (<${MEAN_MAX})`);
    if (!ok) return;
    await presenceGate(sharp, shot);
    await underlayCheck(sharp, shot);
  }
}

function jargonGate() {
  const history = execFileSync('node', [path.join(ROOT, 'ui/scripts/hm-comms.js'), 'history', '--limit', '14'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).slice(2); // drop the freshest 2 (this gate's own run may appear)
  const src = fs.readFileSync(path.join(ROOT, 'ui/renderer.js'), 'utf8');
  const noiseFn = src.match(/function stripSquidRoomMessageNoise[\s\S]*?\n}/)[0];
  const jargonFn = src.match(/function stripSquidRoomFaceJargon[\s\S]*?\n}/)[0];
  const fns = new Function(
    'function stripSquidRoomAnsi(v){return String(v||"").replace(/\\u001b\\[[0-9;]*m/g,"");}'
    + noiseFn + jargonFn + '; return { stripSquidRoomMessageNoise, stripSquidRoomFaceJargon };'
  )();
  const leaks = [];
  for (const line of history) {
    const body = line.replace(/^[\d-]+ [\d:.]+ \S+\s+->\s+\S+\s+/, '');
    const raw = fns.stripSquidRoomFaceJargon(fns.stripSquidRoomMessageNoise(body));
    const face = (raw.split(/(?<=[.!?])\s+/)[0] || raw).slice(0, 128);
    for (const [re, label] of JARGON_PATTERNS) {
      if (re.test(face)) { leaks.push(`${label}: "${face.slice(0, 60)}"`); break; }
    }
  }
  gate('jargon', leaks.length === 0, leaks.length ? leaks[0] + ` (+${leaks.length - 1} more)` : `${history.length} real faces clean`);
}

function suitesGate() {
  try {
    execSync('npx jest squid-room --runInBand --silent --forceExit', { cwd: path.join(ROOT, 'ui'), stdio: 'pipe' });
    gate('suites', true, 'all squid-room suites green (incl. v2 whitelist)');
  } catch (e) {
    gate('suites', false, String(e.stdout || e.message).slice(-200));
  }
}

(async () => {
  await fogGate();
  jargonGate();
  suitesGate();
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `\nROOM GATE: FAIL (${failed.length})` : '\nROOM GATE: PASS');
  process.exit(failed.length ? 1 : 0);
})();
