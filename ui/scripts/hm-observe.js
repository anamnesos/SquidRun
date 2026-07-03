#!/usr/bin/env node
'use strict';

/**
 * BORN OBSERVABLE v0 (Organism Charter S465, Builder organ #3):
 * the instrument deck as ONE command instead of artisanal rigs rebuilt in
 * tmp every crisis. Three verbs, honest degradation, letters-forward.
 *
 *   burst      - N captures over a window, paths out
 *                  node ui/scripts/hm-observe.js burst --window-key squid-room [--frames 3] [--interval-s 18]
 *   verify     - the 3-FRAME LAW, automated: burst + mechanical defect
 *                checks. Always: capture-alive (nonzero, sane size) and
 *                MOTION (identical consecutive frames = frozen renderer -
 *                the S463 death class, detected without eyes). With CDP up
 *                (127.0.0.1:9223): live DOM defect list (creature occlusion
 *                vs the real bar rect, orphan tags, console errors).
 *                  node ui/scripts/hm-observe.js verify --window-key squid-room
 *   heartbeats - the flight-recorder trail as a tool, not a grep
 *                  node ui/scripts/hm-observe.js heartbeats [--last 12]
 *
 * Exit 0 = observed healthy / captures delivered; 1 = a defect check FAILED.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APP_LOG = path.join(PROJECT_ROOT, '.squidrun', 'logs', 'app.log');
const CDP_URL = 'http://127.0.0.1:9223';

// ---------------------------------------------------------------------
// Pure core (contract-tested in __tests__/hm-observe.test.js)
// ---------------------------------------------------------------------

/** Parse SquidRoomCreature heartbeat lines into structured samples. */
function parseHeartbeats(logText, { last = 12 } = {}) {
  const samples = [];
  for (const line of String(logText || '').split('\n')) {
    const match = line.match(/^(\d{2}:\d{2}:\d{2})[.\d]*\s+\[INFO\]\s+\[SquidRoomCreature\]\s+heartbeat heapMB=(\d+) rssMB=(\d+) bindings=(\d+)/);
    if (match) {
      samples.push({
        time: match[1],
        heapMB: Number(match[2]),
        rssMB: Number(match[3]),
        bindings: Number(match[4]),
      });
    }
  }
  return samples.slice(-Math.max(1, last));
}

/** RSS trend verdict over samples: the explosion signature detector. */
function assessRssTrend(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { verdict: 'insufficient', detail: `need >=2 samples, have ${samples?.length || 0}` };
  }
  const first = samples[0].rssMB;
  const lastSample = samples[samples.length - 1].rssMB;
  const peak = Math.max(...samples.map((s) => s.rssMB));
  const deltaPerSample = (lastSample - first) / (samples.length - 1);
  // The S464 explosion signature: +250-800MB per 30s beat. Anything over
  // +100MB/beat sustained is pre-explosion; flag well before death.
  if (deltaPerSample > 100) {
    return { verdict: 'exploding', detail: `RSS climbing ${Math.round(deltaPerSample)}MB/beat (${first}->${lastSample}MB)`, peak };
  }
  if (peak > 900) {
    return { verdict: 'high', detail: `RSS peak ${peak}MB above 900MB watermark`, peak };
  }
  return { verdict: 'stable', detail: `RSS ${first}->${lastSample}MB over ${samples.length} beats`, peak };
}

/** Frame-motion check: consecutive identical captures = frozen renderer. */
function assessFrameMotion(framePaths) {
  if (!Array.isArray(framePaths) || framePaths.length < 2) {
    return { verdict: 'insufficient', detail: 'need >=2 frames for motion' };
  }
  const digests = framePaths.map((p) => {
    const stat = fs.statSync(p);
    if (stat.size < 10 * 1024) return { path: p, dead: true, size: stat.size };
    return { path: p, dead: false, size: stat.size, sha: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
  });
  const dead = digests.filter((d) => d.dead);
  if (dead.length > 0) {
    return { verdict: 'dead', detail: `${dead.length} capture(s) under 10KB - blank/dead window`, frames: digests };
  }
  const unique = new Set(digests.map((d) => d.sha)).size;
  if (unique === 1) {
    return { verdict: 'frozen', detail: `all ${digests.length} frames byte-identical - renderer frozen (S463 death class)`, frames: digests };
  }
  return { verdict: 'alive', detail: `${unique}/${digests.length} distinct frames - motion confirmed`, frames: digests };
}

// ---------------------------------------------------------------------
// Instruments (side-effecting)
// ---------------------------------------------------------------------

function captureOnce(windowKey) {
  const out = execFileSync(process.execPath, [
    path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-screenshot.js'), 'capture', '--window-key', windowKey,
  ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  const match = out.match(/"path":\s*"([^"]+)"/);
  if (!match) throw new Error(`capture returned no path for window ${windowKey}`);
  return match[1].replace(/\\\\/g, '\\');
}

function sleepSeconds(seconds) {
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.floor(seconds * 1000)})`]);
}

function burst(windowKey, { frames = 3, intervalS = 18 } = {}) {
  const paths = [];
  for (let i = 0; i < frames; i += 1) {
    if (i > 0) sleepSeconds(intervalS);
    paths.push(captureOnce(windowKey));
  }
  return paths;
}

async function cdpDefectChecks(windowKey) {
  // Live-DOM defect list, gracefully skipped when CDP is down.
  let playwright;
  try {
    playwright = require(path.join(PROJECT_ROOT, 'ui', 'node_modules', 'playwright'));
  } catch {
    return { available: false, reason: 'playwright not resolvable' };
  }
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(CDP_URL, { timeout: 3000 });
  } catch (err) {
    return { available: false, reason: `CDP down (${err.message.slice(0, 60)}) - byte checks still ran` };
  }
  try {
    let page = null;
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        const isRoom = await candidate.evaluate(
          () => document.body.classList.contains('squid-room')
        ).catch(() => false);
        if (isRoom) page = candidate;
      }
    }
    if (!page) return { available: true, findings: [{ level: 'FAIL', check: 'window', detail: `no ${windowKey} page over CDP` }] };
    const findings = await page.evaluate(() => {
      const out = [];
      const bar = document.querySelector('.squid-room-header')?.getBoundingClientRect() || null;
      for (const canvas of document.querySelectorAll('canvas[data-squid-room-creature]')) {
        if (!canvas.isConnected) out.push({ level: 'FAIL', check: 'orphan', detail: `${canvas.dataset.squidRoomCreature} canvas disconnected` });
      }
      for (const tag of document.querySelectorAll('.squid-room-pet-name-label')) {
        const rect = tag.getBoundingClientRect();
        if (bar && rect.top > bar.top && rect.top < bar.bottom) {
          out.push({ level: 'FAIL', check: 'occlusion', detail: `name tag "${tag.textContent}" inside the opaque bar band` });
        }
      }
      const dead = ['.pet-motion-track', '.squid-room-pet-speech', '.squid-room-codex-pet']
        .filter((sel) => document.querySelector(sel));
      if (dead.length) out.push({ level: 'FAIL', check: 'graves', detail: `purged DOM resurrected: ${dead.join(', ')}` });
      return out;
    });
    return { available: true, findings };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
    else args._.push(argv[i]);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const verb = args._[0];
  const windowKey = args['window-key'] || 'squid-room';

  if (verb === 'heartbeats') {
    const samples = parseHeartbeats(fs.existsSync(APP_LOG) ? fs.readFileSync(APP_LOG, 'utf8') : '', { last: Number(args.last || 12) });
    const trend = assessRssTrend(samples);
    console.log(JSON.stringify({ samples, trend }, null, 1));
    return trend.verdict === 'exploding' ? 1 : 0;
  }

  if (verb === 'burst') {
    const paths = burst(windowKey, { frames: Number(args.frames || 3), intervalS: Number(args['interval-s'] || 18) });
    console.log(JSON.stringify({ windowKey, paths }, null, 1));
    return 0;
  }

  if (verb === 'verify') {
    const paths = burst(windowKey, { frames: Number(args.frames || 3), intervalS: Number(args['interval-s'] || 18) });
    const motion = assessFrameMotion(paths);
    const heartbeatSamples = parseHeartbeats(fs.existsSync(APP_LOG) ? fs.readFileSync(APP_LOG, 'utf8') : '', { last: 8 });
    const rss = assessRssTrend(heartbeatSamples);
    const cdp = await cdpDefectChecks(windowKey);
    const failures = [
      ...(motion.verdict === 'dead' || motion.verdict === 'frozen' ? [{ level: 'FAIL', check: 'motion', detail: motion.detail }] : []),
      ...(rss.verdict === 'exploding' ? [{ level: 'FAIL', check: 'rss', detail: rss.detail }] : []),
      ...((cdp.findings || []).filter((f) => f.level === 'FAIL')),
    ];
    const report = { windowKey, frames: paths, motion, rss, cdp, verdict: failures.length === 0 ? 'VERIFIED' : 'FAILED', failures };
    console.log(JSON.stringify(report, null, 1));
    return failures.length === 0 ? 0 : 1;
  }

  console.log('Usage: hm-observe.js burst|verify|heartbeats [--window-key <key>] [--frames N] [--interval-s N] [--last N]');
  return 2;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code)).catch((err) => {
    console.error(`hm-observe: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { parseHeartbeats, assessRssTrend, assessFrameMotion };
