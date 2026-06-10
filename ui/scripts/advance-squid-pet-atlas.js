#!/usr/bin/env node
/**
 * Squid Room pet atlas ADVANCER (step-2 of the S426 art correction).
 *
 * James's direction: keep the v0 look exactly ("I like how they look now"),
 * advance it - white pupils that move "expressively... intelligently", less
 * grain, more polish. This pipeline therefore TRANSFORMS the v0 atlas pixels
 * in place instead of generating new art: it detects the cyan eye capsules in
 * every sampled frame and paints a white pupil inside them, offset per state
 * so the gaze reads as attention (work-focused when running, pondering when
 * waiting, scanning when reviewing, down when failed, up when jumping, settled
 * with occasional saccades when idle). Pupils are clipped to the cyan eye mask
 * so the v0 eye shape - including the lidded running/failed shapes - is never
 * altered.
 *
 * Run under Electron from OUTSIDE ui/ (single-instance lock; copy to temp):
 *   electron.exe <temp-copy>  with env:
 *     SQUID_PET_ATLAS_SRC  default ui/assets/squid-room-pets
 *     SQUID_PET_ATLAS_OUT  default ui/assets/squid-room-pets
 *
 * Atlas contract: 8x9 grid; sampled rows idle=0(6), jumping=4(5),
 * failed=5(8), waiting=6(6), running=7(6), review=8(6). The CSS samples by
 * percentage (background-size 800%/900%), so the de-grain stage may double
 * atlas resolution without any renderer/CSS change.
 *
 * Stages (canonical order when re-running from the v0 atlases):
 *   1. pupils  - white intent-gaze pupils inside the detected eye capsules
 *                (skip with SQUID_PET_ATLAS_PUPILS=0, e.g. when the source
 *                already carries pupils - re-detection would double-paint).
 *   2. degrain - alpha de-fringe + EPX/scale2x upscale (2x), keeps pixel-art
 *                character while halving staircase grain
 *                (skip with SQUID_PET_ATLAS_DEGRAIN=0).
 */

const harness = require('./headless-harness-bootstrap');
harness.init({ name: 'advance-squid-pet-atlas' });

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('os').tmpdir(), `squid-advance-${process.pid}`));

const SRC_DIR = process.env.SQUID_PET_ATLAS_SRC
  || path.join(__dirname, '..', 'assets', 'squid-room-pets');
const OUT_DIR = process.env.SQUID_PET_ATLAS_OUT
  || path.join(__dirname, '..', 'assets', 'squid-room-pets');
const PETS = ['builder-squid', 'oracle-squid'];

const TRANSFORM = `(async (input) => {
  const FRAME_W = 192;
  const FRAME_H = 208;

  // Sampled rows + per-frame gaze offsets (native pixels; eye is ~6px wide).
  // Intent over drift: steady focus while working, pondering while waiting,
  // sweep while reviewing, settle on each row's hold frame.
  const GAZE = {
    0: { count: 6, offsets: [[0, 0], [0, 0], [1, 0], [0, 0], [-1, 0], [0, 0]] },          // idle: settled + saccades
    4: { count: 5, offsets: [[0, -1], [0, -2], [0, -2], [0, -1], [0, 0]] },               // jumping: up, settle on land
    5: { count: 8, offsets: [[0, 1], [0, 1], [0, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 1]] }, // failed: downcast
    6: { count: 6, offsets: [[-1, -1], [-1, -1], [0, -2], [1, -1], [-1, -1], [0, -1]] },  // waiting: pondering glances
    7: { count: 6, offsets: [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1]] },           // running: locked on the work
    8: { count: 6, offsets: [[-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [0, 0]] },         // review: deliberate L-to-R scan
  };

  function isEyeCyan(r, g, b, a) {
    // Eye glow across both pets (builder teal #19e8e0, oracle ice #70e0f8):
    // green AND blue both very high, red bounded. Both body palettes cap
    // below g=200 (builder sheen is blue-dominant with g<=199, oracle
    // lavender peaks around g=160), so this separates eyes from body without
    // per-pet tuning; the large crown sheen is rejected by the bbox filter.
    return a > 200 && g >= 200 && b >= 200 && r <= 170;
  }

  function findEyeClusters(data, x0, y0) {
    const w = FRAME_W;
    const h = FRAME_H;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = ((y0 + y) * input.width + (x0 + x)) * 4;
        if (isEyeCyan(data[p], data[p + 1], data[p + 2], data[p + 3])) mask[y * w + x] = 1;
      }
    }
    // Connected components (4-neighbour flood fill).
    const labels = new Int32Array(w * h).fill(-1);
    const clusters = [];
    const stack = [];
    for (let i = 0; i < w * h; i += 1) {
      if (!mask[i] || labels[i] !== -1) continue;
      const id = clusters.length;
      const cluster = { count: 0, minX: w, maxX: 0, minY: h, maxY: 0, pixels: [] };
      stack.push(i);
      labels[i] = id;
      while (stack.length) {
        const j = stack.pop();
        const jx = j % w;
        const jy = (j / w) | 0;
        cluster.count += 1;
        cluster.pixels.push(j);
        if (jx < cluster.minX) cluster.minX = jx;
        if (jx > cluster.maxX) cluster.maxX = jx;
        if (jy < cluster.minY) cluster.minY = jy;
        if (jy > cluster.maxY) cluster.maxY = jy;
        for (const n of [j - 1, j + 1, j - w, j + w]) {
          if (n < 0 || n >= w * h) continue;
          if (Math.abs((n % w) - jx) > 1) continue;
          if (mask[n] && labels[n] === -1) { labels[n] = id; stack.push(n); }
        }
      }
      clusters.push(cluster);
    }
    // The two largest EYE-SHAPED clusters in the upper 60% of the frame:
    // compact capsules, not body-sized sheens.
    return clusters
      .filter((c) => c.count >= 8 && c.count <= 400
        && (c.maxX - c.minX + 1) <= 24 && (c.maxY - c.minY + 1) <= 28
        && c.minY < h * 0.6)
      .sort((a, b) => b.count - a.count)
      .slice(0, 2)
      .sort((a, b) => a.minX - b.minX);
  }

  function paintPupil(data, x0, y0, cluster, dx, dy) {
    const w = FRAME_W;
    const inCluster = new Set(cluster.pixels);
    const cx = (cluster.minX + cluster.maxX) / 2 + dx;
    const cy = (cluster.minY + cluster.maxY) / 2 + dy;
    const rx = Math.max(1.6, (cluster.maxX - cluster.minX + 1) * 0.42);
    const ry = Math.max(2.0, (cluster.maxY - cluster.minY + 1) * 0.40);
    for (const j of cluster.pixels) {
      const jx = j % w;
      const jy = (j / w) | 0;
      const nx = (jx - cx) / rx;
      const ny = (jy - cy) / ry;
      if (nx * nx + ny * ny <= 1) {
        const p = ((y0 + jy) * input.width + (x0 + jx)) * 4;
        data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
      }
    }
    // unused guard to keep the cluster set referenced for future shading work
    return inCluster.size;
  }

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = input.dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  input.width = img.width;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const report = [];
  if (input.pupils !== false) {
    for (const [rowKey, spec] of Object.entries(GAZE)) {
      const row = Number(rowKey);
      for (let col = 0; col < spec.count; col += 1) {
        const x0 = col * FRAME_W;
        const y0 = row * FRAME_H;
        const eyes = findEyeClusters(data, x0, y0);
        if (eyes.length < 2) {
          report.push('row ' + row + ' col ' + col + ': eyes=' + eyes.length + ' SKIPPED');
          continue;
        }
        const [dx, dy] = spec.offsets[col] || [0, 0];
        for (const eye of eyes) paintPupil(data, x0, y0, eye, dx, dy);
        report.push('row ' + row + ' col ' + col + ': ok dx=' + dx + ' dy=' + dy
          + ' sizes=' + eyes.map((e) => e.count).join('/'));
      }
    }
    ctx.putImageData(imageData, 0, 0);
  } else {
    report.push('pupils: skipped (SQUID_PET_ATLAS_PUPILS=0)');
  }

  if (input.degrain === false) {
    return { dataUrl: canvas.toDataURL('image/png'), report };
  }

  // --- de-grain stage: alpha de-fringe + EPX (scale2x) upscale ---
  const s = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3];
    if (a > 0 && a < 70) s[i + 3] = 0;
    else if (a >= 200 && a < 255) s[i + 3] = 255;
  }
  const w = canvas.width;
  const h = canvas.height;
  const W = w * 2;
  const H = h * 2;
  const out = new Uint8ClampedArray(W * H * 4);
  const px = (x, y) => {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    const p = (y * w + x) * 4;
    return ((s[p] << 24) >>> 0) | (s[p + 1] << 16) | (s[p + 2] << 8) | s[p + 3];
  };
  const putPx = (x, y, v) => {
    const p = (y * W + x) * 4;
    out[p] = (v >>> 24) & 255;
    out[p + 1] = (v >>> 16) & 255;
    out[p + 2] = (v >>> 8) & 255;
    out[p + 3] = v & 255;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const E = px(x, y);
      const B = px(x, y - 1);
      const D = px(x - 1, y);
      const F = px(x + 1, y);
      const Hh = px(x, y + 1);
      let E0 = E;
      let E1 = E;
      let E2 = E;
      let E3 = E;
      if (B !== Hh && D !== F) {
        E0 = D === B ? D : E;
        E1 = B === F ? F : E;
        E2 = D === Hh ? D : E;
        E3 = Hh === F ? F : E;
      }
      putPx(x * 2, y * 2, E0);
      putPx(x * 2 + 1, y * 2, E1);
      putPx(x * 2, y * 2 + 1, E2);
      putPx(x * 2 + 1, y * 2 + 1, E3);
    }
  }
  const upscaled = document.createElement('canvas');
  upscaled.width = W;
  upscaled.height = H;
  upscaled.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  report.push('degrain: alpha-defringed + EPX 2x -> ' + W + 'x' + H);
  return { dataUrl: upscaled.toDataURL('image/png'), report };
})`;

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 320, height: 240, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pupils = process.env.SQUID_PET_ATLAS_PUPILS !== '0';
  const degrain = process.env.SQUID_PET_ATLAS_DEGRAIN !== '0';
  for (const pet of PETS) {
    const srcPath = path.join(SRC_DIR, `${pet}.png`);
    const dataUrl = `data:image/png;base64,${fs.readFileSync(srcPath).toString('base64')}`;
    const result = await win.webContents.executeJavaScript(
      `${TRANSFORM}(${JSON.stringify({ dataUrl, pupils, degrain })})`,
      true
    );
    const outPath = path.join(OUT_DIR, `${pet}.png`);
    fs.writeFileSync(outPath, Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log(`${pet}: ${result.report.filter((line) => line.includes('ok')).length} frames painted, ${result.report.filter((line) => line.includes('SKIP')).length} skipped`);
    for (const line of result.report) console.log('  ', line);
  }
  app.quit();
}

main().catch((err) => {
  console.error('advance-squid-pet-atlas failed:', err);
  app.exit(1);
});
