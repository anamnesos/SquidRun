#!/usr/bin/env node
/**
 * Squid Room pet atlas generator (pets v2).
 *
 * Draws the Builder/Oracle squid sprite atlases programmatically so the art
 * stays parts-based and trivially tweakable: every frame is composed from
 * parameterized parts (mantle, fins, eyes with look direction + lids,
 * mouth, tentacles with sway phase). Run it under Electron to rasterize:
 *
 *   node_modules/electron/dist/electron(.exe) ui/scripts/generate-squid-pet-atlas.js
 *
 * Output: ui/assets/squid-room-pets/{builder,oracle}-squid.png
 *
 * Atlas contract (renderer.js SQUID_ROOM_PET_*): 8 columns x 9 rows of
 * 192x208 frames; rows used are idle=0, jumping=4, failed=5, waiting=6,
 * running=7, review=8. Rows 1-3 stay transparent.
 *
 * Art rules (Codex Desktop row 69265): solid flat body colors, transparent
 * matte (no white-background bleed), solid white eye whites, expressive eye
 * shapes/look directions for thinking vs working states.
 */

const harness = require('./headless-harness-bootstrap');
harness.init({ name: 'generate-squid-pet-atlas' });

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// NOTE: run this script from OUTSIDE ui/ (copy to a temp dir) — electron.exe
// resolves any path inside ui/ against ui/package.json and silently exits on
// the running app's single-instance lock. Use SQUID_PET_ATLAS_OUT to point
// the output back at ui/assets/squid-room-pets.
const OUTPUT_DIR = process.env.SQUID_PET_ATLAS_OUT
  || path.join(__dirname, '..', 'assets', 'squid-room-pets');

const PALETTES = {
  builder: {
    body: '#2f8fe6',
    bodyDark: '#1d63b4',
    bodyLight: '#62b6f7',
    outline: '#123c73',
    pupil: '#10325c',
    glint: '#9fe8ff',
    cheek: '#1f74c9',
  },
  oracle: {
    body: '#8a5cd9',
    bodyDark: '#5f3aa8',
    bodyLight: '#b18df0',
    outline: '#3c2370',
    pupil: '#2c1656',
    glint: '#e3cdff',
    cheek: '#7448bf',
  },
};

// The full drawing program runs inside a renderer because we need canvas.
// It is serialized as text; keep it dependency-free.
const DRAW_SCRIPT = `(async (palettes) => {
  const FRAME_W = 192;
  const FRAME_H = 208;
  const COLS = 8;
  const ROWS = 9;

  function drawSquidFrame(ctx, p, f) {
    // f: { bob, lean, squash, finFlap, sway, eyeDirX, eyeDirY, lid, lidTilt,
    //      browAngle, mouth, mouthOpen, tentacleLift, blink }
    const cx = FRAME_W / 2;
    const baseY = 96 + (f.bob || 0);
    const lean = f.lean || 0;
    const squash = 1 + (f.squash || 0);

    ctx.save();
    ctx.translate(cx, baseY);
    ctx.rotate(lean);
    ctx.scale(2 - squash, squash);

    // --- tentacles (behind body): 6 chunky curved arms ---
    const tentacleTopY = 34;
    for (let i = 0; i < 6; i += 1) {
      const t = (i - 2.5) / 2.5; // -1..1
      const rootX = t * 32;
      const sway = Math.sin((f.sway || 0) + i * 0.9) * 6;
      const lift = (f.tentacleLift || 0) * (1 - Math.abs(t) * 0.4);
      const len = 50 - Math.abs(t) * 8;
      const endX = rootX + t * 16 + sway;
      const endY = tentacleTopY + len - lift;
      ctx.strokeStyle = p.bodyDark;
      ctx.lineWidth = 19 - Math.abs(t) * 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(rootX, tentacleTopY);
      ctx.quadraticCurveTo(rootX + sway * 0.6, tentacleTopY + len * 0.55, endX, endY);
      ctx.stroke();
      ctx.strokeStyle = p.body;
      ctx.lineWidth = ctx.lineWidth - 5;
      ctx.beginPath();
      ctx.moveTo(rootX, tentacleTopY);
      ctx.quadraticCurveTo(rootX + sway * 0.6, tentacleTopY + len * 0.55, endX, endY);
      ctx.stroke();
    }

    // --- side fins (peeking past the mantle) ---
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * 52, -46);
      ctx.rotate(side * (0.7 + (f.finFlap || 0)));
      ctx.fillStyle = p.outline;
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.body;
      ctx.beginPath();
      ctx.ellipse(-1, 1, 25, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- mantle (head/body): soft-pointed squid crown, flat tones ---
    ctx.fillStyle = p.outline;
    ctx.beginPath();
    ctx.moveTo(0, -94);
    ctx.bezierCurveTo(34, -86, 58, -30, 52, 16);
    ctx.bezierCurveTo(46, 44, -46, 44, -52, 16);
    ctx.bezierCurveTo(-58, -30, -34, -86, 0, -94);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.body;
    ctx.beginPath();
    ctx.moveTo(0, -89);
    ctx.bezierCurveTo(31, -81, 53, -29, 47, 14);
    ctx.bezierCurveTo(42, 39, -42, 39, -47, 14);
    ctx.bezierCurveTo(-53, -29, -31, -81, 0, -89);
    ctx.closePath();
    ctx.fill();
    // flat top sheen
    ctx.fillStyle = p.bodyLight;
    ctx.beginPath();
    ctx.ellipse(-14, -58, 18, 11, -0.5, 0, Math.PI * 2);
    ctx.fill();
    // flat lower rim
    ctx.fillStyle = p.bodyDark;
    ctx.beginPath();
    ctx.ellipse(0, 28, 44, 12, 0, 0, Math.PI);
    ctx.fill();

    // cheeks
    ctx.fillStyle = p.cheek;
    ctx.beginPath();
    ctx.ellipse(-30, 0, 7, 4, 0, 0, Math.PI * 2);
    ctx.ellipse(30, 0, 7, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- eyes: solid white sclera + directed pupil + parametric lids ---
    const eyeY = -22;
    const eyeRX = 16;
    const eyeRY = f.blink ? 2.5 : 19;
    const dirX = (f.eyeDirX || 0) * 7;
    const dirY = (f.eyeDirY || 0) * 8;
    for (const side of [-1, 1]) {
      const ex = side * 21;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = p.outline;
      ctx.stroke();
      if (!f.blink) {
        ctx.clip();
        ctx.fillStyle = p.pupil;
        ctx.beginPath();
        ctx.ellipse(ex + dirX, eyeY + dirY, 7.5, 9.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(ex + dirX - 2.5, eyeY + dirY - 3.5, 2.6, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.glint;
        ctx.beginPath();
        ctx.ellipse(ex + dirX + 3, eyeY + dirY + 3, 1.6, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
        // lids: drop from the top, tilt for emotion (sad out-down, focused flat)
        const lid = Math.max(0, Math.min(1, f.lid || 0));
        if (lid > 0) {
          ctx.fillStyle = p.body;
          ctx.save();
          ctx.translate(ex, eyeY - eyeRY);
          ctx.rotate(side * (f.lidTilt || 0));
          ctx.fillRect(-eyeRX - 4, -6, (eyeRX + 4) * 2, 6 + lid * eyeRY * 2);
          ctx.restore();
        }
      }
      ctx.restore();
      // brows
      if (f.browAngle) {
        ctx.strokeStyle = p.outline;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.save();
        ctx.translate(side * 21, eyeY - 26);
        ctx.rotate(side * f.browAngle);
        ctx.beginPath();
        ctx.moveTo(-11, 0);
        ctx.lineTo(11, 0);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- mouth ---
    ctx.strokeStyle = p.outline;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    const mouthY = 14;
    if (f.mouthOpen) {
      ctx.fillStyle = p.outline;
      ctx.beginPath();
      ctx.ellipse(0, mouthY, 6.5, 5 + f.mouthOpen * 4, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const curve = (f.mouth ?? 1) * 6; // +smile / 0 flat / -frown
      ctx.beginPath();
      ctx.moveTo(-9, mouthY);
      ctx.quadraticCurveTo(0, mouthY + curve, 9, mouthY);
      ctx.stroke();
    }

    ctx.restore();
  }

  // The renderer holds each row's LAST sampled frame for an extended duration
  // (makeSquidRoomPetFrames lastFrameDurationMs), so that frame must read as a
  // rest/settle pose - damp the motion params, keep the expression.
  function settleHoldPose(params) {
    return {
      ...params,
      bob: (params.bob || 0) * 0.2,
      squash: (params.squash || 0) * 0.3,
      finFlap: (params.finFlap || 0) * 0.3,
      tentacleLift: (params.tentacleLift || 0) * 0.5,
      blink: false,
    };
  }

  function frameParams(state, i, count) {
    const ph = (i / count) * Math.PI * 2;
    if (i === count - 1) {
      return settleHoldPose(rawFrameParams(state, i, count, ph));
    }
    return rawFrameParams(state, i, count, ph);
  }

  function rawFrameParams(state, i, count, ph) {
    if (state === 'idle') {
      return {
        bob: Math.sin(ph) * 4,
        sway: ph,
        finFlap: Math.sin(ph) * 0.12,
        eyeDirX: 0,
        eyeDirY: 0.1,
        blink: i === 3,
        mouth: 1,
        squash: Math.sin(ph) * 0.02,
      };
    }
    if (state === 'jumping') {
      const rise = Math.sin((i / (count - 1)) * Math.PI);
      return {
        bob: -rise * 26,
        squash: 0.04 + rise * 0.08,
        sway: ph,
        tentacleLift: rise * 22,
        finFlap: rise * 0.5,
        eyeDirX: 0,
        eyeDirY: -0.7,
        mouthOpen: 0.4 + rise * 0.6,
      };
    }
    if (state === 'failed') {
      const sag = Math.min(1, i / 3);
      return {
        bob: 8 + sag * 6 + Math.sin(ph) * 1.5,
        squash: -0.05 * sag,
        sway: ph * 0.4,
        finFlap: -0.25,
        eyeDirX: 0,
        eyeDirY: 0.85,
        lid: 0.45 + sag * 0.15,
        lidTilt: -0.35,
        mouth: -1,
        browAngle: -0.3,
      };
    }
    if (state === 'waiting') {
      // thinking: up-glance, slow sway, one tap cycle
      return {
        bob: Math.sin(ph) * 3,
        sway: ph * 0.7,
        finFlap: Math.sin(ph) * 0.08,
        eyeDirX: -0.7,
        eyeDirY: -0.75,
        lid: 0.18,
        mouth: 0,
        tentacleLift: i % 3 === 0 ? 8 : 0,
      };
    }
    if (state === 'running') {
      // working: leaned in, focused straight-down-forward, determined brows
      return {
        bob: Math.sin(ph * 2) * 3,
        lean: 0.1,
        sway: ph * 2,
        finFlap: Math.sin(ph * 2) * 0.35,
        eyeDirX: 0.25,
        eyeDirY: 0.55,
        lid: 0.3,
        lidTilt: 0.18,
        browAngle: 0.28,
        mouth: 0.4,
        tentacleLift: 6 + Math.sin(ph * 2) * 5,
      };
    }
    if (state === 'review') {
      // scanning: pupils sweep left -> right with scrutiny lids
      const sweep = (i / (count - 1)) * 2 - 1;
      return {
        bob: Math.sin(ph) * 2,
        sway: ph * 0.5,
        eyeDirX: sweep,
        eyeDirY: 0.15,
        lid: 0.32,
        mouth: 0,
        finFlap: 0.05,
      };
    }
    return {};
  }

  const STATE_ROWS = [
    ['idle', 0, 6],
    ['jumping', 4, 5],
    ['failed', 5, 8],
    ['waiting', 6, 6],
    ['running', 7, 6],
    ['review', 8, 6],
  ];

  const out = {};
  for (const [petId, palette] of Object.entries(palettes)) {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W * COLS;
    canvas.height = FRAME_H * ROWS;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [state, row, count] of STATE_ROWS) {
      for (let i = 0; i < count; i += 1) {
        ctx.save();
        ctx.translate(i * FRAME_W, row * FRAME_H);
        ctx.beginPath();
        ctx.rect(0, 0, FRAME_W, FRAME_H);
        ctx.clip();
        drawSquidFrame(ctx, palette, frameParams(state, i, count));
        ctx.restore();
      }
    }
    out[petId] = canvas.toDataURL('image/png');
  }
  return out;
})`;

const DEBUG_LOG = process.env.SQUID_PET_ATLAS_LOG || null;
function debugLog(line) {
  if (!DEBUG_LOG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* best effort */ }
}

async function main() {
  debugLog('main start');
  app.disableHardwareAcceleration();
  await app.whenReady();
  debugLog('app ready');
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('about:blank');
  debugLog('blank loaded');
  const result = await win.webContents.executeJavaScript(
    `${DRAW_SCRIPT}(${JSON.stringify(PALETTES)})`,
    true
  );
  debugLog(`draw done: ${Object.keys(result || {}).join(',')}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [petId, dataUrl] of Object.entries(result)) {
    const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    const outPath = path.join(OUTPUT_DIR, `${petId}-squid.png`);
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    console.log(`wrote ${outPath} (${Buffer.byteLength(base64, 'base64')} bytes)`);
  }
  app.quit();
}

// Note: under Electron's loader require.main is not this module, so run
// unconditionally when an app object is available.
main().catch((err) => {
  debugLog(`FAILED: ${err?.stack || err}`);
  console.error('generate-squid-pet-atlas failed:', err);
  app.exit(1);
});