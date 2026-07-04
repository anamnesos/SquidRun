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

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };
  const dir = flag('dir')
    || path.join(os.homedir(), '.claude', 'projects', 'D--projects-squidrun');
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

module.exports = { tallyModelsByDay, mergeTallies, auditDir };
