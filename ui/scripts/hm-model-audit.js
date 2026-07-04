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
 *   node ui/scripts/hm-model-audit.js watch [--dir D] [--expect MODEL] [--interval-s 60]
 *
 * watch mode (James, 2026-07-04 04:21: "you don't know when you silently
 * fall back!"): correct — no model can feel its own weights mid-answer.
 * So this shrinks the blind window to one poll interval: tail the
 * transcripts and ALERT (Telegram + stderr) the moment any new turn logs a
 * serving model that drifts from the pane's current settings. Lagging detector,
 * minutes -> seconds.
 * The label-independent backstop remains the verdict ledger: it measures
 * OUTPUT quality, which no routing label can fake.
 *
 * Default dir: every *.jsonl under
 *   %USERPROFILE%/.claude/projects/D--projects-squidrun
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectCli,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
} = require('../modules/cli-resume-invocation');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SETTINGS_PATH = path.resolve(__dirname, '..', 'settings.json');
const DEFAULT_PANE_SESSION_IDS_PATH = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'pane-session-ids.json');

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
function modelFamily(model = '') {
  const normalized = normalizeClaudeModelId(model).toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('fable')) return 'fable';
  if (normalized.includes('sonnet')) return 'sonnet';
  return normalized;
}

function modelMatchesExpected(servedModel = '', expectedModel = '') {
  const served = normalizeClaudeModelId(servedModel);
  const expected = normalizeClaudeModelId(expectedModel);
  if (!served || !expected) return false;
  if (served.toLowerCase() === expected.toLowerCase()) return true;

  // UI/settings often use compact Claude aliases such as "opus"; transcripts
  // log the concrete serving id such as "claude-opus-4-8".
  if (/^(?:claude-)?(?:opus|fable|sonnet)$/i.test(expected)) {
    return modelFamily(served) === modelFamily(expected);
  }
  return false;
}

function scanModelTurns(lines, expectModel) {
  const turns = [];
  for (const line of lines) {
    if (!line || !line.includes('"model"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec?.message?.model;
    if (!model || model === '<synthetic>') continue;
    turns.push({
      model,
      timestamp: rec?.timestamp || null,
      offending: !modelMatchesExpected(model, expectModel),
    });
  }
  return turns;
}

function findOffendingTurns(lines, expectModel) {
  return scanModelTurns(lines, expectModel)
    .filter((turn) => turn.offending)
    .map(({ model, timestamp }) => ({ model, timestamp }));
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sessionIdFromTranscriptFile(file = '') {
  return path.basename(String(file || '')).replace(/\.jsonl$/i, '');
}

function findPaneIdForSession(sessionId = '', paneSessionIds = {}) {
  const panes = paneSessionIds?.panes && typeof paneSessionIds.panes === 'object'
    ? paneSessionIds.panes
    : {};
  for (const [paneId, id] of Object.entries(panes)) {
    if (String(id || '') === String(sessionId || '')) return String(paneId);
  }
  return '';
}

function expectedModelFromPaneSettings(settings = {}, paneId = '') {
  const paneCommands = settings?.paneCommands && typeof settings.paneCommands === 'object'
    ? settings.paneCommands
    : {};
  const command = String(paneCommands[String(paneId)] || '').trim();
  if (detectCli(command) !== 'claude') {
    return { expectedModel: '', source: command ? 'non-claude-pane-command' : 'missing-pane-command' };
  }

  const commandModel = parseClaudeModelFromCommand(command);
  if (commandModel) return { expectedModel: commandModel, source: 'pane-command' };

  const settingsModel = normalizeClaudeModelId(settings?.claudeModel || '');
  if (settingsModel) return { expectedModel: settingsModel, source: 'settings-claudeModel' };

  return { expectedModel: '', source: 'missing-claude-model' };
}

function resolveExpectedModelForTranscript(file, options = {}) {
  const explicit = normalizeClaudeModelId(options.explicitExpect || options.expect || '');
  if (explicit) return { expectedModel: explicit, paneId: '', source: 'explicit-expect' };

  const settings = options.settings || {};
  const paneSessionIds = options.paneSessionIds || {};
  const sessionId = sessionIdFromTranscriptFile(file);
  const paneId = findPaneIdForSession(sessionId, paneSessionIds);
  if (!paneId) return { expectedModel: '', paneId: '', source: 'unmapped-session' };

  return {
    ...expectedModelFromPaneSettings(settings, paneId),
    paneId,
  };
}

function findOffendingTurnsForTranscript(file, lines, options = {}) {
  const expected = resolveExpectedModelForTranscript(file, options);
  if (!expected.expectedModel) return [];
  return findOffendingTurns(lines, expected.expectedModel).map((turn) => ({
    file,
    ...turn,
    expectedModel: expected.expectedModel,
    paneId: expected.paneId,
    source: expected.source,
  }));
}

function createStateChangeAlertFilter() {
  const stateByFile = new Map();
  return (turn = {}) => {
    const file = String(turn.file || '');
    const expectedModel = normalizeClaudeModelId(turn.expectedModel || '');
    const model = normalizeClaudeModelId(turn.model || '');
    if (!file || !expectedModel || !model) return false;

    if (modelMatchesExpected(model, expectedModel)) {
      stateByFile.set(file, null);
      return false;
    }

    const state = `${expectedModel}=>${model}`;
    if (stateByFile.get(file) === state) return false;
    stateByFile.set(file, state);
    return true;
  };
}

function loadWatchContext(options = {}) {
  return {
    explicitExpect: options.expect || '',
    settings: readJsonFile(options.settingsPath || DEFAULT_SETTINGS_PATH) || {},
    paneSessionIds: readJsonFile(options.paneSessionIdsPath || DEFAULT_PANE_SESSION_IDS_PATH) || {},
  };
}

function watch(dir, {
  expect = '',
  intervalS,
  alert,
  settingsPath = DEFAULT_SETTINGS_PATH,
  paneSessionIdsPath = DEFAULT_PANE_SESSION_IDS_PATH,
}) {
  const offsets = new Map(); // file -> bytes already scanned
  const shouldAlert = createStateChangeAlertFilter();
  const tick = () => {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
    const watchContext = loadWatchContext({ expect, settingsPath, paneSessionIdsPath });
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
      const expected = resolveExpectedModelForTranscript(file, watchContext);
      if (!expected.expectedModel) continue;
      for (const turn of scanModelTurns(chunk.split('\n'), expected.expectedModel)) {
        const event = {
          file,
          model: turn.model,
          timestamp: turn.timestamp,
          expectedModel: expected.expectedModel,
          paneId: expected.paneId,
          source: expected.source,
        };
        if (!shouldAlert(event)) continue;
        const paneNote = event.paneId ? ` pane ${event.paneId}` : '';
        alert(`MODEL SUBSTITUTION: ${file}${paneNote} logged ${event.model} at ${event.timestamp} (expected ${event.expectedModel} from ${event.source})`);
      }
    }
  };
  tick();
  setInterval(tick, intervalS * 1000);
  const expectLabel = expect ? `explicit:${expect}` : `settings:${settingsPath}`;
  console.log(`model watch running: expect=${expectLabel}, interval=${intervalS}s, dir=${dir}`);
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
      expect: flag('expect') || '',
      intervalS: Number(flag('interval-s')) || 60,
      settingsPath: flag('settings') || DEFAULT_SETTINGS_PATH,
      paneSessionIdsPath: flag('pane-session-ids') || DEFAULT_PANE_SESSION_IDS_PATH,
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

module.exports = {
  tallyModelsByDay,
  mergeTallies,
  auditDir,
  modelFamily,
  modelMatchesExpected,
  scanModelTurns,
  findOffendingTurns,
  sessionIdFromTranscriptFile,
  findPaneIdForSession,
  expectedModelFromPaneSettings,
  resolveExpectedModelForTranscript,
  findOffendingTurnsForTranscript,
  createStateChangeAlertFilter,
  loadWatchContext,
};
