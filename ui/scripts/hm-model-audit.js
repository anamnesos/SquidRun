#!/usr/bin/env node
'use strict';

/**
 * hm-model-audit: who actually answered? (S468 — born from the router scare)
 *
 * Post-July-1, Anthropic's safety classifier can silently serve Opus 4.8
 * where Fable 5 was expected; the claude.ai webapp shows a notice, Claude
 * Code shows nothing. But every Claude Code session transcript records the
 * SERVING model on each assistant turn — so the blindness is optional.
 * This tool reads the transcripts and answers with numbers instead of vibes.
 * First live run (2026-07-04): July 2 = 2768/2768 Fable, July 3 = 576/576 —
 * zero silent substitutions on this machine; the audition evidence is clean.
 *
 *   node ui/scripts/hm-model-audit.js [--dir <claude-projects-dir>] [--since YYYY-MM-DD] [--per-file]
 *   node ui/scripts/hm-model-audit.js watch [--dir D] [--expect claude-fable-5] [--interval-s 60]
 *
 * watch mode (James, 2026-07-04 04:21: "you don't know when you silently
 * fall back!"): correct — no model can feel its own weights mid-answer.
 * So this shrinks the blind window to one poll interval: tail the
 * transcripts and ALERT (Telegram + stderr) the moment any new turn logs a
 * serving model other than --expect. Lagging detector, minutes -> seconds.
 * The label-independent backstop remains the verdict ledger: it measures
 * OUTPUT quality, which no routing label can fake.
 *
 * Default dir: every *.jsonl under
 *   %USERPROFILE%/.claude/projects/D--projects-squidrun
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Pure: fold transcript lines into { day: { model: count } }. */
function tallyModelsByDay(lines, { since = '' } = {}) {
  const counts = {};
  for (const line of lines) {
    if (!line || !line.includes('"model"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec?.message?.model;
    const day = String(rec?.timestamp || '').slice(0, 10);
    if (!model || !day || day < since) continue;
    counts[day] = counts[day] || {};
    counts[day][model] = (counts[day][model] || 0) + 1;
  }
  return counts;
}

/** Merge b into a (mutates a). */
function mergeTallies(a, b) {
  for (const [day, models] of Object.entries(b)) {
    a[day] = a[day] || {};
    for (const [model, n] of Object.entries(models)) {
      a[day][model] = (a[day][model] || 0) + n;
    }
  }
  return a;
}

function auditDir(dir, { since = '', perFile = false } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const total = {};
  const byFile = {};
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const tally = tallyModelsByDay(text.split('\n'), { since });
    if (perFile && Object.keys(tally).length) byFile[file] = tally;
    mergeTallies(total, tally);
  }
  return { dir, filesScanned: files.length, byDay: total, ...(perFile ? { byFile } : {}) };
}

/** Pure: new offending turns from freshly-appended lines. '<synthetic>'
 * rows are harness bookkeeping, never a served response — ignored. */
function findOffendingTurns(lines, expectModel) {
  const offending = [];
  for (const line of lines) {
    if (!line || !line.includes('"model"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec?.message?.model;
    if (!model || model === '<synthetic>' || model === expectModel) continue;
    offending.push({ model, timestamp: rec?.timestamp || null });
  }
  return offending;
}

function watch(dir, { expect, intervalS, alert }) {
  const offsets = new Map(); // file -> bytes already scanned
  const tick = () => {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    for (const file of files) {
      const full = path.join(dir, file);
      let size;
      try { size = fs.statSync(full).size; } catch { continue; }
      const from = offsets.get(file) ?? size; // first sight: only future turns
      offsets.set(file, size);
      if (size <= from) continue;
      let chunk;
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch { continue; }
      for (const turn of findOffendingTurns(chunk.split('\n'), expect)) {
        alert(`MODEL SUBSTITUTION: ${file} logged ${turn.model} at ${turn.timestamp} (expected ${expect})`);
      }
    }
  };
  tick();
  setInterval(tick, intervalS * 1000);
  console.log(`model watch running: expect=${expect}, interval=${intervalS}s, dir=${dir}`);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };
  const dir = flag('dir')
    || path.join(os.homedir(), '.claude', 'projects', 'D--projects-squidrun');

  if (args[0] === 'watch') {
    const { execFileSync } = require('child_process');
    watch(dir, {
      expect: flag('expect') || 'claude-fable-5',
      intervalS: Number(flag('interval-s')) || 60,
      alert: (message) => {
        console.error(`${new Date().toISOString()} ${message}`);
        try {
          execFileSync(process.execPath, [
            path.join(__dirname, 'hm-send.js'), 'telegram',
            `Model watch: ${message}`, '--role', 'architect',
          ], { timeout: 60000 });
        } catch (err) {
          console.error(`alert send failed: ${err.message}`);
        }
      },
    });
    return;
  }

  const result = auditDir(dir, {
    since: flag('since') || '',
    perFile: args.includes('--per-file'),
  });
  console.log(JSON.stringify(result, null, 2));
  // Human-readable tail: the question people actually ask.
  for (const day of Object.keys(result.byDay).sort()) {
    const models = result.byDay[day];
    const parts = Object.entries(models).map(([m, n]) => `${m}=${n}`).join(' ');
    console.error(`${day}  ${parts}`);
  }
}

if (require.main === module) main();

module.exports = { tallyModelsByDay, mergeTallies, auditDir, findOffendingTurns };
