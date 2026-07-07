#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(PROJECT_ROOT, 'ui');
const PHASE5_MANIFEST_PATH = path.join(__dirname, 'shell-v2-phase5-both-modes-dead.json');
const SHELL_V2_VISUAL_REFERENCE_PATH = path.join(PROJECT_ROOT, 'workspace', 'specs', 'shell-v2-visual-reference.html');
const DOORBELL_MODULE_PATH = path.join(UI_ROOT, 'modules', 'shell-v2-doorbell.js');
const PROFILE = 'shellv2qa';
const HIDDEN_WAIT_MS = 20000;
const DOORBELL_IDLE_SOAK_MS = 120000;
const SWITCHES = 12;
const ATTACH_TIMEOUT_MS = 60000;
const PANE_TICKS = Object.freeze({
  '2': 'builder',
  '3': 'oracle',
  'trustquote-lead': 'tq-lead',
  'trustquote-schedule-dispatch': 'tq-schedule',
  'trustquote-app': 'tq-app',
  'trustquote-invoice': 'tq-invoice',
});
const TRUSTQUOTE_ARM_PANE_IDS = Object.freeze(
  Object.keys(PANE_TICKS).filter((paneId) => paneId.startsWith('trustquote-'))
);
const KILLED_CONTROLS = Object.freeze([
  { id: 'project-button', selector: '#selectProjectBtn' },
  { id: 'profile-button', selector: '#profileBtn' },
  { id: 'panel-button', selector: '#panelBtn' },
  { id: 'squid-room-button', selector: '#openSquidRoomBtn' },
  { id: 'today-window-button', selector: '#openHumanTimelineBtn' },
  { id: 'mira-lab-button', selector: '#openMiraLabBtn' },
  { id: 'right-panel', selector: '#rightPanel' },
  { id: 'panel-tabs', selector: '.panel-tabs' },
  { id: 'panel-tab-bridge', selector: '.panel-tab[data-tab="bridge"]' },
  { id: 'panel-tab-comms', selector: '.panel-tab[data-tab="comms"]' },
  { id: 'panel-tab-screenshots', selector: '.panel-tab[data-tab="screenshots"]' },
  { id: 'panel-tab-image-gen', selector: '.panel-tab[data-tab="oracle"]' },
  { id: 'panel-tab-voice', selector: '.panel-tab[data-tab="voice"]' },
  { id: 'panel-tab-secrets', selector: '.panel-tab[data-tab="api-keys"]' },
  { id: 'image-gen-pane', selector: '#tab-oracle' },
  { id: 'image-gen-prompt', selector: '#oraclePromptInput' },
  { id: 'image-gen-generate', selector: '#oracleGenerateBtn' },
  { id: 'image-gen-gallery', selector: '#oracleGallery' },
  { id: 'external-notifications-toggle', selector: '#toggleExternalNotificationsEnabled' },
  { id: 'slack-webhook', selector: '#slackWebhookField' },
  { id: 'discord-webhook', selector: '#discordWebhookField' },
  { id: 'smtp-host', selector: '#smtpHostField' },
  { id: 'smtp-password', selector: '#smtpPassField' },
  { id: 'external-test', selector: '#sendExternalTestBtn' },
  { id: 'project-rooms-css', selector: 'link[href$="project-rooms.css"]' },
]);
const FLAG_OFF_REBASED_PRESENT_CONTROLS = Object.freeze(
  KILLED_CONTROLS.filter((entry) => ![
    'external-notifications-toggle',
    'slack-webhook',
    'discord-webhook',
    'smtp-host',
    'smtp-password',
    'external-test',
    'project-rooms-css',
  ].includes(entry.id))
);
const PHASE5_DELETED_SELECTORS = Object.freeze(
  KILLED_CONTROLS.filter((entry) => !FLAG_OFF_REBASED_PRESENT_CONTROLS.some((present) => present.id === entry.id))
);
const SURVIVING_PALETTE_COMMANDS = Object.freeze([
  'shell-v2-switch-project',
  'shell-v2-screenshots-gallery',
  'shell-v2-settings-voice',
  'shell-v2-settings-secrets',
  'open-mira-lab',
  'shutdown',
]);
const PHASE5_DEFERRED_INTACT_FILES = Object.freeze([
  path.join(UI_ROOT, 'modules', 'tabs', 'oracle.js'),
  path.join(UI_ROOT, 'modules', 'image-gen.js'),
]);
const PHASE4_REVIEW_SCREENSHOTS = Object.freeze([
  'phase4-settings-overlay-open',
  'phase4-mira-composer-attachment',
  'phase4-palette-open',
  'phase4-today-copy-affordances',
  'phase4-today-overflow-pill',
]);
const PHASE5_REVIEW_SCREENSHOTS = Object.freeze([
  'flag-off-legacy-intact',
]);
const VISUAL_DOORBELL_REVIEW_SCREENSHOTS = Object.freeze([
  'visual-mira',
  'visual-squid-room',
  'visual-today',
  'visual-doorbell-fired',
  'visual-doorbell-cleared-today',
]);
const SHELL_V2_VISUAL_COMMIT_FILES = Object.freeze([
  'ui/__tests__/evidence-ledger-store.test.js',
  'ui/__tests__/shell-v2-doorbell.test.js',
  'ui/__tests__/shell-v2.test.js',
  'ui/__tests__/shell-v2-today-journal.test.js',
  'ui/modules/main/evidence-ledger-store.js',
  'ui/modules/main/shell-v2-today-journal.js',
  'ui/modules/shell-v2-doorbell.js',
  'ui/modules/shell-v2.js',
  'ui/scripts/shell-v2-gate.js',
  'ui/styles/layout.css',
]);
const SHELL_V2_REFERENCE_TOKENS = Object.freeze([
  '--ink',
  '--ink-2',
  '--ink-3',
  '--ink-4',
  '--line',
  '--line-2',
  '--tx',
  '--tx-dim',
  '--tx-faint',
  '--amber',
  '--amber-dim',
  '--ok',
  '--mono',
  '--serif',
  '--u',
]);
const DOORBELL_FORBIDDEN_TIMER_RE = /setTimeout|setInterval|setImmediate|requestAnimationFrame|Date\.now|performance\.now/g;

function parseArgs(argv) {
  const options = {
    keepOpen: false,
    headed: false,
    cdpPort: 9527,
    cdpPortExplicit: false,
    expectCommit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--keep-open') options.keepOpen = true;
    else if (token === '--headed') options.headed = true;
    else if (token === '--cdp-port') {
      options.cdpPort = Number.parseInt(argv[i + 1], 10);
      options.cdpPortExplicit = true;
      i += 1;
    } else if (token === '--expect-commit') {
      options.expectCommit = String(argv[i + 1] || '').trim() || null;
      i += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    }
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) options.cdpPort = 9527;
  return options;
}

function usage() {
  console.log('Usage: node ui/scripts/shell-v2-gate.js [--keep-open] [--cdp-port <port>] [--expect-commit <sha>]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailableCdpPortPair(preferredPort) {
  const preferred = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 9527;
  for (let port = preferred; port < preferred + 200; port += 2) {
    // The gate reserves the next port for the flag-off probe.
    // Keep the pair stable so evidence paths remain easy to reason about.
    if (await canListenOnPort(port) && await canListenOnPort(port + 1)) return port;
  }
  throw new Error(`No available CDP port pair near ${preferred}`);
}

function readFileIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  } catch {
    return null;
  }
}

function readPhase5Manifest() {
  const parsed = JSON.parse(fs.readFileSync(PHASE5_MANIFEST_PATH, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const deletedFiles = Array.from(new Set(entries.flatMap((entry) => (
    Array.isArray(entry.deletedFiles) ? entry.deletedFiles : []
  )))).sort();
  const residuePatterns = Array.from(new Set(entries.flatMap((entry) => (
    Array.isArray(entry.residuePatterns) ? entry.residuePatterns : []
  )))).sort();
  return { ...parsed, entries, deletedFiles, residuePatterns };
}

function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function readDeletedFilesForCommit(commit) {
  const target = String(commit || '').trim();
  if (!target) return { files: [] };
  const diff = runGit(['diff', '--name-only', '--diff-filter=D', `${target}^`, target]);
  if (diff.status !== 0) {
    return { error: diff.stderr || diff.stdout || 'git diff failed', files: [] };
  }
  return {
    files: diff.stdout.split(/\r?\n/)
      .map(normalizeGitPath)
      .filter(Boolean)
      .sort(),
  };
}

function readDeletedFilesForWorktree() {
  const diff = runGit(['diff', '--name-only', '--diff-filter=D']);
  if (diff.status !== 0) {
    return { error: diff.stderr || diff.stdout || 'git diff failed', files: [] };
  }
  return {
    files: diff.stdout.split(/\r?\n/)
      .map(normalizeGitPath)
      .filter(Boolean)
      .sort(),
  };
}

function readChangedFilesForCommit(commit) {
  const target = String(commit || '').trim();
  if (!target) return { files: [] };
  const diff = runGit(['diff', '--name-only', `${target}^`, target]);
  if (diff.status !== 0) {
    return { error: diff.stderr || diff.stdout || 'git diff failed', files: [] };
  }
  return {
    files: diff.stdout.split(/\r?\n/)
      .map(normalizeGitPath)
      .filter(Boolean)
      .sort(),
  };
}

function sameStringList(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeCssToken(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',');
}

function readShellV2ReferenceTokens() {
  const text = fs.readFileSync(SHELL_V2_VISUAL_REFERENCE_PATH, 'utf8');
  const root = text.match(/:root\s*\{([\s\S]*?)\}/i);
  if (!root) {
    throw new Error(`No :root token block found in ${SHELL_V2_VISUAL_REFERENCE_PATH}`);
  }
  const tokens = {};
  for (const match of root[1].matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = normalizeCssToken(match[2]);
  }
  return tokens;
}

function resolveDoorbellIdleSoakMs(options = {}) {
  if (options.expectCommit) return DOORBELL_IDLE_SOAK_MS;
  const override = Number.parseInt(String(process.env.SHELL_V2_DB4_IDLE_SOAK_MS || ''), 10);
  if (Number.isFinite(override) && override >= 0) return override;
  return DOORBELL_IDLE_SOAK_MS;
}

function buildVisualScopeData(commit) {
  const changed = readChangedFilesForCommit(commit);
  const allowed = new Set(SHELL_V2_VISUAL_COMMIT_FILES);
  const files = (changed.files || []).map(normalizeGitPath).sort();
  const unexpected = files.filter((filePath) => !allowed.has(filePath));
  const expectedSurface = [
    'ui/modules/shell-v2.js',
    'ui/modules/shell-v2-doorbell.js',
    'ui/styles/layout.css',
    'ui/scripts/shell-v2-gate.js',
  ];
  const touchedExpectedSurface = expectedSurface.filter((filePath) => files.includes(filePath));
  const missingExpectedSurface = expectedSurface.filter((filePath) => !files.includes(filePath));
  return {
    ...changed,
    files,
    allowedFiles: [...allowed].sort(),
    unexpected,
    missingExpectedSurface,
    touchedExpectedSurface,
    ok: !changed.error && unexpected.length === 0 && touchedExpectedSurface.length > 0,
  };
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function getFunctionSource(text, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(text);
  if (!match) return '';
  let parenDepth = 0;
  let sawOpenParen = false;
  let bodyStart = -1;
  for (let index = match.index; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') {
      parenDepth += 1;
      sawOpenParen = true;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (sawOpenParen && parenDepth === 0 && char === '{') {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) return '';
  let depth = 0;
  let started = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
      started = true;
    } else if (char === '}') {
      depth -= 1;
      if (started && depth === 0) return text.slice(match.index, index + 1);
    }
  }
  return '';
}

function readDoorbellStaticGateData() {
  const source = fs.readFileSync(DOORBELL_MODULE_PATH, 'utf8');
  const moduleExports = require(DOORBELL_MODULE_PATH);
  const timerHits = [...source.matchAll(DOORBELL_FORBIDDEN_TIMER_RE)].map((match) => ({
    token: match[0],
    line: lineForIndex(source, match.index),
  }));
  let unknownThrow = false;
  let unknownError = '';
  try {
    moduleExports.validateDoorbellEvent?.('not_a_shell_v2_doorbell_event');
  } catch (err) {
    unknownThrow = true;
    unknownError = err?.message || String(err);
  }
  const transitionSource = getFunctionSource(source, 'transitionDoorbell');
  const ensureSource = getFunctionSource(source, 'ensureDoorbellState');
  const writePathSource = `${ensureSource}\n${transitionSource}`;
  const mutationHits = [...source.matchAll(/\b(?:state|doorbell)\.(?:count|sequence|byPane|history)\b\s*(?:=|\.push)/g)]
    .map((match) => ({
      token: match[0],
      line: lineForIndex(source, match.index),
      inDoorbellWritePath: writePathSource.includes(match[0]),
    }));
  const expectedTriggers = ['permission_prompt', 'lead_escalation', 'process_exit'];
  const expectedEvents = [...expectedTriggers, 'doorbell_ack'];
  const expectedCallers = [
    { source: 'pty_permission_prompt_detector', eventName: 'permission_prompt' },
    { source: 'lead_escalation_message_parser', eventName: 'lead_escalation' },
    { source: 'pty_process_exit_handler', eventName: 'process_exit' },
    { source: 'squid_room_tab_ack', eventName: 'doorbell_ack' },
  ];
  return {
    modulePath: DOORBELL_MODULE_PATH,
    timerHits,
    triggerEvents: moduleExports.DOORBELL_TRIGGER_EVENTS || [],
    events: moduleExports.DOORBELL_EVENTS || [],
    callers: moduleExports.DOORBELL_CHOKEPOINT_CALLERS || [],
    unknownThrow,
    unknownError,
    transitionCallsValidator: /validateDoorbellEvent\s*\(/.test(transitionSource),
    mutationHits,
    expectedTriggers,
    expectedEvents,
    expectedCallers,
    db1Ok: unknownThrow
      && sameStringList(moduleExports.DOORBELL_TRIGGER_EVENTS || [], expectedTriggers)
      && sameStringList(moduleExports.DOORBELL_EVENTS || [], expectedEvents)
      && /validateDoorbellEvent\s*\(/.test(transitionSource)
      && mutationHits.every((hit) => hit.inDoorbellWritePath),
    db2Ok: timerHits.length === 0,
    db7Ok: JSON.stringify(moduleExports.DOORBELL_CHOKEPOINT_CALLERS || []) === JSON.stringify(expectedCallers),
  };
}

function scanPhase5Residue(manifest) {
  const excluded = new Set([
    normalizeGitPath(path.relative(PROJECT_ROOT, PHASE5_MANIFEST_PATH)),
    normalizeGitPath(path.relative(PROJECT_ROOT, __filename)),
  ]);
  const deletedFiles = new Set((manifest.deletedFiles || []).map(normalizeGitPath));
  const hits = [];
  for (const pattern of manifest.residuePatterns || []) {
    const result = runGit(['grep', '-n', '-F', '--', pattern, 'HEAD', '--', 'ui']);
    if (result.status !== 0 && result.status !== 1) {
      hits.push({ pattern, error: result.stderr || result.stdout || 'git grep failed' });
      continue;
    }
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^HEAD:([^:]+):(\d+):(.*)$/);
      if (!match) continue;
      const filePath = normalizeGitPath(match[1]);
      if (excluded.has(filePath) || deletedFiles.has(filePath)) continue;
      hits.push({ pattern, filePath, line: Number(match[2]), text: match[3] });
    }
  }
  return hits;
}

function readNewSkippedTests(commit) {
  const args = commit
    ? ['diff', '-U0', `${commit}^`, commit, '--', 'ui/__tests__']
    : ['diff', '-U0', '--', 'ui/__tests__'];
  const diff = runGit(args);
  if (diff.status !== 0) {
    return { error: diff.stderr || diff.stdout || 'git diff failed', hits: [] };
  }
  const hits = [];
  let filePath = '';
  for (const line of diff.stdout.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      filePath = normalizeGitPath(fileMatch[1]);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/\b(?:describe|test|it)\.skip\s*\(/.test(line)) {
      hits.push({ filePath, text: line.slice(1) });
    }
  }
  return { hits };
}

function readCurrentTrackedTestSuites() {
  const files = runGit(['ls-files', 'ui/__tests__/*.test.js']);
  if (files.status !== 0) {
    return { error: files.stderr || files.stdout || 'git ls-files failed', suites: [] };
  }
  return {
    suites: files.stdout.split(/\r?\n/)
      .map(normalizeGitPath)
      .filter(Boolean)
      .sort(),
  };
}

function buildPhase5ManifestGateData(manifest, options) {
  const expectedDeletedFiles = (manifest.deletedFiles || []).map(normalizeGitPath).sort();
  const diskSurvivors = expectedDeletedFiles.filter((relPath) => fs.existsSync(path.join(PROJECT_ROOT, relPath)));
  const trackedProbe = expectedDeletedFiles.length > 0
    ? runGit(['ls-files', '--', ...expectedDeletedFiles])
    : { status: 0, stdout: '', stderr: '' };
  const trackedSurvivors = trackedProbe.status === 0
    ? trackedProbe.stdout.split(/\r?\n/).map(normalizeGitPath).filter(Boolean).sort()
    : [];
  const deletionDiff = options.expectCommit
    ? readDeletedFilesForCommit(options.expectCommit)
    : readDeletedFilesForWorktree();
  const actualDeletedFiles = (deletionDiff.files || []).map(normalizeGitPath).sort();
  const unexpectedDeletedFiles = actualDeletedFiles.filter((filePath) => !expectedDeletedFiles.includes(filePath));
  const missingDeletedFiles = expectedDeletedFiles.filter((filePath) => !actualDeletedFiles.includes(filePath));
  const commitCarriesPhase5Deletes = actualDeletedFiles.some((filePath) => expectedDeletedFiles.includes(filePath));
  const commitDeleteSetOk = commitCarriesPhase5Deletes
    ? sameStringList(actualDeletedFiles, expectedDeletedFiles)
    : unexpectedDeletedFiles.length === 0;
  return {
    expectedDeletedFiles,
    actualDeletedFiles,
    diskSurvivors,
    trackedSurvivors,
    unexpectedDeletedFiles,
    missingDeletedFiles,
    commitCarriesPhase5Deletes,
    commitDeleteSetOk,
    diffError: deletionDiff.error || null,
    trackedProbeError: trackedProbe.status === 0 ? null : (trackedProbe.stderr || trackedProbe.stdout || 'git ls-files failed'),
    exactNameset: !deletionDiff.error
      && trackedProbe.status === 0
      && diskSurvivors.length === 0
      && trackedSurvivors.length === 0
      && commitDeleteSetOk,
  };
}

function buildPhase5JestAccounting(manifest, options) {
  const baseline = manifest.baseline || {};
  const removedSuites = (baseline.deletedSuites || []).map(normalizeGitPath).sort();
  const skipped = readNewSkippedTests(options.expectCommit);
  const current = readCurrentTrackedTestSuites();
  const currentSuites = current.suites || [];
  const currentSet = new Set(currentSuites);
  const removedSuitesAbsent = removedSuites.filter((suite) => !currentSet.has(suite));
  const expectedAfter = Number(baseline.jestSuitesBefore || 0) - removedSuites.length;
  const additiveSuites = currentSuites.filter((suite) => !removedSuites.includes(suite)).length - expectedAfter;
  return {
    before: Number(baseline.jestSuitesBefore || 0),
    after: currentSuites.length,
    expectedAfter,
    additiveSuites: Math.max(0, additiveSuites),
    removedSuites,
    removedSuitesAbsent,
    skippedHits: skipped.hits || [],
    skippedError: skipped.error || null,
    suiteListError: current.error || null,
    ok: !skipped.error
      && !current.error
      && (skipped.hits || []).length === 0
      && removedSuitesAbsent.length === removedSuites.length
      && currentSuites.length >= expectedAfter,
  };
}

function getGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function getTrackedGitStatus() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { ok: false, reason: String(result.stderr || result.stdout || 'git status failed').trim() };
  }
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { ok: true, dirty: lines.length > 0, lines };
}

function assertExpectedCommit(options = {}) {
  const expected = String(options.expectCommit || '').trim();
  if (!expected) return { ok: true, skipped: true };
  const head = getGitHead();
  const status = getTrackedGitStatus();
  if (!head) {
    return { ok: false, reason: 'git_head_unavailable', expected, head };
  }
  if (head !== expected) {
    return { ok: false, reason: 'git_head_mismatch', expected, head };
  }
  if (!status.ok) {
    return { ok: false, reason: status.reason || 'git_status_failed', expected, head };
  }
  if (status.dirty) {
    return { ok: false, reason: 'tracked_worktree_dirty', expected, head, dirty: status.lines };
  }
  return { ok: true, expected, head, dirty: [] };
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null;
  }
}

function buffersEqual(left, right) {
  if (left === null && right === null) return true;
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  return left.equals(right);
}

function readPidValue(filePath) {
  const raw = readFileIfPresent(filePath);
  if (!raw) return null;
  const text = raw.toString('utf8').trim();
  if (!text) return null;
  const direct = Number.parseInt(text, 10);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    const parsed = JSON.parse(text);
    const pid = Number.parseInt(parsed?.pid, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function killPidTree(pid) {
  const normalized = Number.parseInt(pid, 10);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(normalized), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(normalized, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

async function closeBrowserFast(browser, timeoutMs = 1500) {
  if (!browser) return;
  const close = typeof browser.close === 'function'
    ? browser.close()
    : Promise.resolve();
  await Promise.race([close, sleep(timeoutMs)]).catch(() => {});
}

async function disconnectBrowserFast(browser, timeoutMs = 1000) {
  if (!browser) return;
  if (typeof browser.disconnect === 'function') {
    await Promise.race([Promise.resolve(browser.disconnect()), sleep(timeoutMs)]).catch(() => {});
    return;
  }
  await closeBrowserFast(browser, timeoutMs);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function writeTickHarness(dataRoot) {
  const scriptPath = path.join(dataRoot, 'tick-harness.js');
  fs.writeFileSync(scriptPath, [
    "'use strict';",
    "const label = String(process.argv[2] || process.env.SQUIDRUN_ROLE || 'pane').toLowerCase();",
    'let tick = 0;',
    "console.log(`${label} model tick-harness ready`);",
    "function emit() { tick += 1; console.log(`${label} tick ${tick}`); }",
    'emit();',
    'setInterval(emit, 1000);',
    '',
  ].join('\n'), 'utf8');
  return scriptPath;
}

function buildTickCommand(scriptPath, label) {
  return `& ${quoteArg(process.execPath)} ${quoteArg(scriptPath)} ${quoteArg(label)}`;
}

function writeQaSettings(dataRoot, tickScriptPath, overrides = {}) {
  const settingsDir = path.join(dataRoot, '.squidrun', `settings-${PROFILE}`);
  ensureDir(settingsDir);
  const paneCommands = {};
  for (const [paneId, label] of Object.entries(PANE_TICKS)) {
    paneCommands[paneId] = buildTickCommand(tickScriptPath, label);
  }
  paneCommands['1'] = buildTickCommand(tickScriptPath, 'mira');
  const payload = {
    autoSpawn: overrides.autoSpawn !== undefined ? Boolean(overrides.autoSpawn) : true,
    autoSync: false,
    notifications: false,
    devTools: false,
    devMode: overrides.devMode === true,
    shellV2Enabled: overrides.shellV2Enabled !== undefined ? Boolean(overrides.shellV2Enabled) : true,
    agentNotify: false,
    watcherEnabled: false,
    allowAllPermissions: false,
    autonomyConsentGiven: true,
    autonomyConsentChoice: 'enabled',
    autonomyConsentUpdatedAt: new Date().toISOString(),
    costAlertEnabled: false,
    dryRun: false,
    hiddenPaneHostsEnabled: false,
    operatingMode: 'developer',
    firmwareInjectionEnabled: false,
    localModelEnabled: false,
    paneProjects: { '1': PROJECT_ROOT, '2': PROJECT_ROOT, '3': PROJECT_ROOT },
    paneCommands,
    templates: [],
    voiceInputEnabled: false,
    voiceAutoSend: false,
    userName: 'Shell V2 QA',
    userExperienceLevel: 'advanced',
    userPreferredStyle: 'direct',
    freshPaneSessionOnNextSpawn: {},
  };
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function writeQaProfile(dataRoot) {
  const profile = {
    name: 'Shell V2 QA',
    experience_level: 'expert',
    communication_style: 'terse',
    domain_expertise: 'SquidRun shell verification',
    notes: 'Generated by shell-v2-gate.js for isolated throwaway verification.',
  };
  fs.writeFileSync(path.join(dataRoot, 'user-profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  const onboardingDir = path.join(dataRoot, '.squidrun');
  ensureDir(onboardingDir);
  fs.writeFileSync(path.join(onboardingDir, 'onboarding-state.json'), JSON.stringify({
    onboarding_complete: true,
    completed_at: new Date().toISOString(),
    user_name: profile.name,
    workspace_path: dataRoot,
    configured_features: ['auto-spawn', 'autonomy-consent', 'autonomy-enabled'],
  }, null, 2), 'utf8');
}

function readPlaywright() {
  try {
    return require('playwright-core');
  } catch (_) {
    return require('playwright');
  }
}

function resolveElectronPath() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !electronPath) {
    throw new Error('electron package did not resolve to an executable path');
  }
  return electronPath;
}

function launchThrowaway({ dataRoot, cdpPort, keepOpen = false, shellV2Env = true }) {
  const env = {
    ...process.env,
    SQUIDRUN_SHELL_V2: shellV2Env ? '1' : '0',
    SQUIDRUN_PROFILE: PROFILE,
    SQUIDRUN_DATA_ROOT: dataRoot,
    SQUIDRUN_CDP_PORT: String(cdpPort),
    SQUIDRUN_SKIP_STARTUP_INJECTION: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const child = spawn(resolveElectronPath(), [UI_ROOT, '--profile', PROFILE], {
    cwd: PROJECT_ROOT,
    env,
    detached: keepOpen === true,
    stdio: keepOpen === true ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (keepOpen === true) child.unref();
  return child;
}

async function waitForFile(filePath, timeoutMs = ATTACH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return filePath;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function connectToThrowaway(cdpPort) {
  const playwright = readPlaywright();
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < ATTACH_TIMEOUT_MS) {
    try {
      const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 3000 });
      return browser;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Failed to connect over CDP: ${lastError?.message || 'timeout'}`);
}

async function findRendererPage(browser) {
  const started = Date.now();
  while (Date.now() - started < ATTACH_TIMEOUT_MS) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (/index\.html/.test(page.url())) return page;
      }
    }
    await sleep(250);
  }
  throw new Error('No renderer index.html page found over CDP');
}

function bindRendererNoiseCapture(page) {
  const noise = [];
  page.on('console', (message) => {
    noise.push({
      type: message.type(),
      text: message.text(),
    });
  });
  page.on('pageerror', (err) => {
    noise.push({
      type: 'pageerror',
      text: err?.message || String(err),
    });
  });
  return noise;
}

function findBadRendererNoise(noise = []) {
  return (Array.isArray(noise) ? noise : []).filter((entry) => (
    /failed to load resource|err_file_not_found|404|cannot find module|module not found|missing module/i
      .test(String(entry?.text || ''))
  ));
}

function makeRecorder() {
  const checks = [];
  return {
    record(id, ok, detail, data = null) {
      const status = ok ? 'PASS' : 'FAIL';
      checks.push({ id, status, ok, detail, data });
      console.log(`${id}: ${status} ${detail}`);
    },
    checks,
  };
}

async function readPhase4KillState(page) {
  return page.evaluate((controls) => {
    const selectorResults = controls.map((control) => ({
      id: control.id,
      selector: control.selector,
      present: Boolean(document.querySelector(control.selector)),
    }));
    const headerActions = document.querySelector('#shellV2HeaderActions, .header-actions');
    const visibleHeaderButtons = [...(headerActions?.querySelectorAll?.('button') || [])]
      .filter((button) => Boolean(button.offsetWidth || button.offsetHeight))
      .map((button) => button.id || button.textContent?.trim() || '');
    const railTabs = [...document.querySelectorAll('[data-shell-v2-tab]')]
      .map((button) => button.dataset.shellV2Tab || button.textContent?.trim() || '');
    const bottomBars = [...document.querySelectorAll('.shell-v2-bottom-bar, .status-bar')];
    const bottomBarDetails = bottomBars.map((bar) => {
      const style = window.getComputedStyle(bar);
      const rect = bar.getBoundingClientRect();
      return {
        id: bar.id || '',
        className: bar.className || '',
        display: style.display,
        visibility: style.visibility,
        hidden: bar.hidden === true,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    const controlLabel = (control) => control.id || control.className || control.textContent?.trim() || control.tagName;
    const miraPane = document.querySelector('.main-pane-container .pane[data-pane-id="1"], .pane[data-pane-id="1"]');
    const miraHeader = miraPane?.querySelector?.('.pane-header');
    const miraVisibleControls = [...(miraHeader?.querySelectorAll?.('button, [role=button], summary, select') || [])]
      .filter((control) => !control.closest?.('.shell-v2-station-menu-panel'))
      .map(controlLabel);
    const miraOverflowControls = [...(miraHeader?.querySelectorAll?.('.shell-v2-station-menu-panel button, .shell-v2-station-menu-panel [role=button], .shell-v2-station-menu-panel summary, .shell-v2-station-menu-panel select') || [])]
      .map(controlLabel);
    return {
      selectorResults,
      missing: selectorResults.filter((entry) => !entry.present),
      present: selectorResults.filter((entry) => entry.present),
      bodyShellV2: document.body?.classList?.contains('shell-v2-enabled') === true,
      settingsOverlay: Boolean(document.querySelector('#shellV2SettingsOverlay')),
      settingsPanel: Boolean(document.querySelector('#settingsPanel')),
      headerActions: visibleHeaderButtons,
      railTabs,
      bottomBarCount: bottomBars.length,
      bottomBarDetails,
      miraVisibleControls,
      miraOverflowControls,
      miraReduced: miraHeader?.dataset?.shellV2Reduced === 'true',
    };
  }, KILLED_CONTROLS);
}

async function readRendererModuleCacheState(page) {
  return page.evaluate(() => {
    try {
      const markers = {
        projectRoomsLoaded: window.__squidrunProjectRoomsLoaded === true,
        oracleTabLoaded: window.__squidrunOracleTabLoaded === true,
      };
      if (typeof require !== 'function' || !require.cache) {
        return { available: false, paths: [], ...markers };
      }
      const paths = Object.keys(require.cache).map((entry) => entry.replace(/\\/g, '/'));
      return {
        available: true,
        projectRoomsLoaded: markers.projectRoomsLoaded || paths.some((entry) => /ui\/modules\/project-rooms\.js$/i.test(entry)),
        oracleTabLoaded: markers.oracleTabLoaded || paths.some((entry) => /ui\/modules\/tabs\/oracle\.js$/i.test(entry)),
        imageGenLoaded: paths.some((entry) => /ui\/modules\/image-gen\.js$/i.test(entry)),
        matchedPaths: paths.filter((entry) => (
          /ui\/modules\/(?:project-rooms|image-gen)\.js$/i.test(entry)
          || /ui\/modules\/tabs\/oracle\.js$/i.test(entry)
        )),
      };
    } catch (err) {
      return { available: false, error: err?.message || String(err), paths: [] };
    }
  });
}

function readPhase5DeferredIntactFiles() {
  return PHASE5_DEFERRED_INTACT_FILES.map((filePath) => ({
    filePath,
    present: fs.existsSync(filePath),
    sha256: sha256File(filePath),
  }));
}

function contiguous(seq) {
  return Array.isArray(seq) && seq.every((value, index) => index === 0 || value === seq[index - 1] + 1);
}

function hasContiguousRun(entry, minLength = 3) {
  return Array.isArray(entry?.seq)
    && entry.seq.length >= minLength
    && contiguous(entry.seq);
}

async function readTicks(page) {
  return page.evaluate(async (paneTicks) => {
    function bestContiguousRun(values) {
      let best = [];
      let current = [];
      for (const value of values) {
        if (!Number.isFinite(value)) continue;
        if (current.length === 0 || value === current[current.length - 1] + 1) {
          current.push(value);
        } else if (value === current[current.length - 1]) {
          continue;
        } else {
          current = [value];
        }
        const bestLast = best.length ? best[best.length - 1] : -Infinity;
        const currentLast = current[current.length - 1];
        if (current.length > best.length || (current.length === best.length && currentLast > bestLast)) {
          best = current.slice();
        }
      }
      return best.slice(-12);
    }

    let snapshot = null;
    try {
      const snapshotFn = window?.squidrun?.daemon?.terminalSnapshot
        || window?.squidrunAPI?.daemon?.terminalSnapshot;
      if (typeof snapshotFn === 'function') {
        const result = await snapshotFn({ timeoutMs: 1500 });
        if (result?.ok && Array.isArray(result.terminals)) {
          snapshot = result;
        }
      }
    } catch (_) {
      snapshot = null;
    }
    const snapshotByPane = new Map((snapshot?.terminals || []).map((terminal) => [String(terminal.paneId), terminal]));
    const out = {};
    for (const [paneId, label] of Object.entries(paneTicks)) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const xterm = terminal?.querySelector?.('.xterm') || terminal;
      const snapshotText = snapshotByPane.get(String(paneId))?.scrollback || '';
      const domText = xterm?.innerText || xterm?.textContent || '';
      const text = snapshotText || domText;
      const matches = [...text.matchAll(new RegExp(`${label} tick (\\d+)`, 'g'))].map((match) => Number(match[1]));
      const seq = bestContiguousRun(matches);
      const rect = xterm?.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      out[paneId] = {
        label,
        source: snapshotText ? 'snapshot' : 'dom',
        last: matches.length ? Math.max(...matches) : null,
        seq,
        rawSeq: matches.slice(-12),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    }
    out.xtermCount = document.querySelectorAll('.xterm').length;
    out.snapshotOk = snapshot?.ok === true;
    return out;
  }, PANE_TICKS);
}

async function waitForInitialTicks(page) {
  await page.waitForFunction(async (paneTicks) => {
    let snapshotByPane = new Map();
    try {
      const snapshotFn = window?.squidrun?.daemon?.terminalSnapshot
        || window?.squidrunAPI?.daemon?.terminalSnapshot;
      if (typeof snapshotFn === 'function') {
        const result = await snapshotFn({ timeoutMs: 1500 });
        if (result?.ok && Array.isArray(result.terminals)) {
          snapshotByPane = new Map(result.terminals.map((terminal) => [String(terminal.paneId), terminal]));
        }
      }
    } catch (_) {
      snapshotByPane = new Map();
    }
    for (const [paneId, label] of Object.entries(paneTicks)) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const snapshotText = snapshotByPane.get(String(paneId))?.scrollback || '';
      const domText = terminal?.innerText || terminal?.textContent || '';
      const text = snapshotText || domText;
      if (!new RegExp(`${label} tick \\d+`, 'g').test(text)) return false;
    }
    return true;
  }, PANE_TICKS, { timeout: 60000 });
}

async function runFlagOffProbe({ dataRoot, cdpPort, recorder, runId }) {
  ensureDir(dataRoot);
  const screenshots = {};
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase5', runId || path.basename(dataRoot));
  ensureDir(screenshotDir);
  const tickScript = writeTickHarness(dataRoot);
  writeQaSettings(dataRoot, tickScript, {
    shellV2Enabled: false,
    devMode: false,
    autoSpawn: false,
  });
  writeQaProfile(dataRoot);
  const qaPortPath = path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'cdp-port.json');
  try {
    fs.rmSync(qaPortPath, { force: true });
  } catch (_) {}

  let child = null;
  let browser = null;
  let noise = [];
  try {
    child = launchThrowaway({ dataRoot, cdpPort, keepOpen: false, shellV2Env: false });
    child.stdout?.on?.('data', (chunk) => process.stdout.write(`[electron flag-off] ${chunk}`));
    child.stderr?.on?.('data', (chunk) => process.stderr.write(`[electron flag-off] ${chunk}`));
    await waitForFile(qaPortPath);
    browser = await connectToThrowaway(cdpPort);
    const page = await findRendererPage(browser);
    noise = bindRendererNoiseCapture(page);
    await page.waitForSelector('#settingsPanel', { timeout: 30000 });
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const flagOffScreenshot = path.join(screenshotDir, 'flag-off-legacy-intact.png');
    await page.screenshot({ path: flagOffScreenshot, fullPage: true });
    screenshots['flag-off-legacy-intact'] = flagOffScreenshot;

    const killState = await readPhase4KillState(page);
    const presentById = new Map(killState.selectorResults.map((entry) => [entry.id, entry.present]));
    const missingRebasedControls = FLAG_OFF_REBASED_PRESENT_CONTROLS
      .filter((entry) => presentById.get(entry.id) !== true)
      .map((entry) => entry.id);
    const unexpectedDeletedControls = PHASE5_DELETED_SELECTORS
      .filter((entry) => presentById.get(entry.id) === true)
      .map((entry) => entry.id);
    const flagOffTabs = killState.selectorResults
      .filter((entry) => entry.id.startsWith('panel-tab-') && entry.present === true)
      .map((entry) => entry.id);
    const k2Ok = killState.bodyShellV2 === false
      && killState.settingsPanel === true
      && missingRebasedControls.length === 0
      && unexpectedDeletedControls.length === 0
      && flagOffTabs.length === 6;
    recorder.record('K2', k2Ok, 'flag-off legacy baseline whole after Phase 5 rebase', {
      ...killState,
      missingRebasedControls,
      unexpectedDeletedControls,
      flagOffTabs,
    });

    const s4 = await page.evaluate(() => {
      const panel = document.querySelector('#settingsPanel');
      const button = document.querySelector('#settingsBtn');
      button?.click?.();
      return {
        settingsPanel: Boolean(panel),
        settingsButton: Boolean(button),
        settingsPanelVisible: panel ? window.getComputedStyle(panel).display !== 'none' : false,
        hasDeletedSettings: Boolean(document.querySelector('#sendExternalTestBtn, #toggleExternalNotificationsEnabled')),
        hasDevices: Boolean(document.querySelector('#pairingInitBtn')),
      };
    });
    recorder.record(
      'S4',
      s4.settingsPanel && s4.settingsButton && s4.hasDevices && s4.hasDeletedSettings === false,
      'flag-off legacy settings panel intact after deleted settings rebase',
      s4
    );

    const modules = await readRendererModuleCacheState(page);
    recorder.record(
      'K5b',
      modules.projectRoomsLoaded === false
        && killState.selectorResults.some((entry) => entry.id === 'image-gen-pane' && entry.present === true)
        && killState.selectorResults.some((entry) => entry.id === 'project-rooms-css' && entry.present === false),
      'flag-off project rooms removed and image-gen surface remains present',
      { modules, imageGenSurfacePresent: killState.selectorResults.filter((entry) => entry.id.startsWith('image-gen')) }
    );

    const noiseBad = findBadRendererNoise(noise);
    recorder.record('N2', noiseBad.length === 0, `flag-off renderer missing-module/404 noise=${noiseBad.length}`, noiseBad);

    recorder.record(
      'K6b',
      killState.bottomBarCount === 1 && killState.railTabs.length === 0,
      `flag-off bottomBars=${killState.bottomBarCount} railTabs=${killState.railTabs.join('/') || 'none'}`,
      killState
    );
  } catch (err) {
    recorder.record('K2', false, err?.message || String(err));
  } finally {
    await closeBrowserFast(browser);
    const daemonPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'daemon.pid'));
    const supervisorPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'supervisor.pid'));
    for (const pid of [child?.pid, daemonPid, supervisorPid]) {
      killPidTree(pid);
    }
    if (child && !child.killed) child.kill();
  }
  return screenshots;
}

async function waitForTickBaseline(page, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readTicks(page);
    const ready = Object.keys(PANE_TICKS).every((paneId) => {
      const value = last?.[paneId]?.last;
      return Number.isFinite(value) && value >= 2 && hasContiguousRun(last[paneId], 2);
    });
    if (ready) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for stable tick baseline: ${JSON.stringify(last)}`);
}

async function clickTab(page, tabId) {
  await page.click(`[data-shell-v2-tab="${tabId}"]`);
  await page.waitForFunction((id) => document.body?.dataset?.shellV2ActiveTab === id, tabId, { timeout: 5000 });
}

async function runSettingsOverlayMechanics(page) {
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-shell-v2-tab]')]
    .map((button) => button.dataset.shellV2Tab)
    .filter(Boolean));
  const results = [];
  for (const tabId of tabs) {
    await clickTab(page, tabId);
    const result = await page.evaluate(() => {
      let focusProbe = document.getElementById('shellV2GateFocusProbe');
      if (!focusProbe) {
        focusProbe = document.createElement('button');
        focusProbe.id = 'shellV2GateFocusProbe';
        focusProbe.type = 'button';
        focusProbe.textContent = 'focus probe';
        document.body.appendChild(focusProbe);
      }
      focusProbe.focus();
      return {
        beforeTab: document.body?.dataset?.shellV2ActiveTab || '',
        beforeFocus: document.activeElement?.id || '',
      };
    });
    await page.keyboard.press('Control+,');
    await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true, null, { timeout: 5000 });
    const open = await page.evaluate(() => ({
      activeTab: document.body?.dataset?.shellV2ActiveTab || '',
      overlayOpen: document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true,
      activeSection: document.querySelector('#shellV2SettingsOverlay')?.dataset?.activeSection || '',
      settingsRailTab: [...document.querySelectorAll('[data-shell-v2-tab]')]
        .some((button) => /settings/i.test(button.textContent || '')),
    }));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') !== true, null, { timeout: 5000 });
    const closed = await page.evaluate(() => ({
      activeTab: document.body?.dataset?.shellV2ActiveTab || '',
      overlayOpen: document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true,
      focusAfterClose: document.activeElement?.id || '',
    }));
    results.push({ tabId, result, open, closed });
  }
  await page.evaluate(() => document.getElementById('shellV2GateFocusProbe')?.remove?.());

  await page.click('#settingsBtn');
  await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true, null, { timeout: 5000 });
  const gearOpen = await page.evaluate(() => ({
    overlayOpen: document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true,
    activeSection: document.querySelector('#shellV2SettingsOverlay')?.dataset?.activeSection || '',
  }));
  await page.keyboard.press('Escape');
  return { tabs, results, gearOpen };
}

async function readSettingsOverlaySections(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#shellV2SettingsOverlay');
    const sectionIds = [...(overlay?.querySelectorAll?.('[data-shell-v2-settings-section]') || [])]
      .map((section) => section.dataset.shellV2SettingsSection);
    const navIds = [...(overlay?.querySelectorAll?.('[data-shell-v2-settings-nav]') || [])]
      .map((button) => button.dataset.shellV2SettingsNav);
    const spotChecks = {
      general: Boolean(overlay?.querySelector?.('#toggleAutoSpawn')),
      permissions: Boolean(overlay?.querySelector?.('#toggleAllowAllPermissions')),
      voice: Boolean(overlay?.querySelector?.('#voiceBrokerPanel')) && Boolean(overlay?.querySelector?.('#toggleVoiceInputEnabled')),
      cost: Boolean(overlay?.querySelector?.('#costAlertThreshold')),
      devices: Boolean(overlay?.querySelector?.('#pairingInitBtn')) && Boolean(overlay?.querySelector?.('#pairedDevicesTable')),
      secrets: Boolean(overlay?.querySelector?.('#apiKeyAnthropic')) && Boolean(overlay?.querySelector?.('#saveApiKeysBtn')),
      profile: Boolean(overlay?.querySelector?.('#profileNameInput')) && Boolean(overlay?.querySelector?.('#profileModalForm')),
    };
    return {
      overlay: Boolean(overlay),
      sectionIds,
      navIds,
      spotChecks,
      deletedSettingsPresent: Boolean(overlay?.querySelector?.('#sendExternalTestBtn, #toggleExternalNotificationsEnabled')),
    };
  });
}

async function runSettingsOverlayStatePreservation(page) {
  await clickTab(page, 'today');
  await page.evaluate(() => {
    const list = document.querySelector('[data-today-list="true"]');
    if (list) list.scrollTop = 64;
    const row = document.querySelector('.shell-v2-today-row:not(.is-expanded) .shell-v2-today-summary')
      || document.querySelector('.shell-v2-today-summary');
    row?.click?.();
  });
  await page.waitForSelector('.shell-v2-today-row.is-expanded', { timeout: 5000 });
  const before = await page.evaluate(() => ({
    activeTab: document.body?.dataset?.shellV2ActiveTab || '',
    expandedCount: document.querySelectorAll('.shell-v2-today-row.is-expanded').length,
    scrollTop: Number(document.querySelector('[data-today-list="true"]')?.scrollTop || 0),
    xtermCount: document.querySelectorAll('.xterm').length,
  }));
  await page.keyboard.press('Control+,');
  await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true, null, { timeout: 5000 });
  await page.waitForTimeout(750);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') !== true, null, { timeout: 5000 });
  const after = await page.evaluate(() => ({
    activeTab: document.body?.dataset?.shellV2ActiveTab || '',
    expandedCount: document.querySelectorAll('.shell-v2-today-row.is-expanded').length,
    scrollTop: Number(document.querySelector('[data-today-list="true"]')?.scrollTop || 0),
    xtermCount: document.querySelectorAll('.xterm').length,
  }));
  return { before, after };
}

async function runScreenshotAffordanceProbe(page) {
  await clickTab(page, 'mira');
  const initial = await page.evaluate(() => ({
    tray: Boolean(document.querySelector('#shellV2MiraAttachmentTray')),
    drawer: Boolean(document.querySelector('#shellV2ScreenshotsDrawer')),
    view: Boolean(document.querySelector('[data-shell-v2-view="mira"]')),
  }));
  await page.evaluate(() => {
    const command = window.__squidrunCommandPalette?.getCommands?.()
      ?.find((entry) => entry.id === 'shell-v2-screenshots-gallery');
    command?.action?.();
  });
  await page.waitForFunction(() => document.querySelector('#shellV2ScreenshotsDrawer')?.classList?.contains('open') === true, null, { timeout: 1500 })
    .catch(async () => {
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('shell-v2-open-screenshots', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('#shellV2ScreenshotsDrawer')?.classList?.contains('open') === true, null, { timeout: 5000 });
    });
  const drawerOpen = await page.evaluate(() => document.querySelector('#shellV2ScreenshotsDrawer')?.classList?.contains('open') === true);

  await ensureMiraAttachmentChip(page);
  const afterDrop = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('[data-shell-v2-mira-attachment="true"]')]
      .map((chip) => ({ text: chip.textContent || '', path: chip.dataset.path || '' })),
  }));
  return { initial, drawerOpen, afterDrop };
}

async function dispatchMiraImageDrop(page) {
  await page.evaluate(async () => {
    const view = document.querySelector('[data-shell-v2-view="mira"]');
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=');
    const bytes = new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
    const file = new File([bytes], 'phase4-mira-drop.png', { type: 'image/png' });
    let event;
    if (typeof DataTransfer === 'function' && typeof DragEvent === 'function') {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
    } else {
      event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { files: [file] },
        configurable: true,
      });
    }
    view?.dispatchEvent?.(event);
  });
}

async function ensureMiraAttachmentChip(page) {
  const hasChip = await page.evaluate(() => Boolean(document.querySelector('[data-shell-v2-mira-attachment="true"]')));
  if (!hasChip) {
    await dispatchMiraImageDrop(page);
  }
  await page.waitForSelector('[data-shell-v2-mira-attachment="true"]', { state: 'attached', timeout: 10000 });
}

async function runPhase4FlagOnAssertions({ page, recorder, rendererNoise }) {
  const killState = await readPhase4KillState(page);
  recorder.record(
    'K1',
    killState.bodyShellV2 === true
      && killState.settingsOverlay === true
      && killState.selectorResults.every((entry) => entry.present === false)
      && killState.miraReduced === true
      && killState.miraVisibleControls.length <= 3
      && killState.miraOverflowControls.length >= 5,
    'flag-on killed controls absent and Mira header reduced',
    killState
  );

  const overlayMechanics = await runSettingsOverlayMechanics(page);
  const s1Ok = overlayMechanics.results.every((entry) => (
    entry.open.overlayOpen === true
      && entry.closed.overlayOpen === false
      && entry.open.activeTab === entry.result.beforeTab
      && entry.closed.activeTab === entry.result.beforeTab
      && entry.closed.focusAfterClose === entry.result.beforeFocus
      && entry.open.settingsRailTab === false
  )) && overlayMechanics.gearOpen.overlayOpen === true;
  recorder.record('S1', s1Ok, 'settings overlay opens from every tab and gear, Esc restores focus', overlayMechanics);

  const settingsSections = await readSettingsOverlaySections(page);
  const requiredSections = ['general', 'permissions', 'voice', 'cost', 'devices', 'secrets', 'profile'];
  recorder.record(
    'S2',
    settingsSections.overlay === true
      && requiredSections.every((id) => settingsSections.sectionIds.includes(id) && settingsSections.navIds.includes(id))
      && Object.values(settingsSections.spotChecks).every(Boolean)
      && settingsSections.deletedSettingsPresent === false,
    'settings overlay sections and live controls present without deleted settings',
    settingsSections
  );

  const palette = await page.evaluate((requiredIds) => {
    const api = window.__squidrunCommandPalette;
    const commands = typeof api?.getCommands === 'function' ? api.getCommands() : [];
    const smoke = typeof api?.smoke === 'function' ? api.smoke() : [];
    return {
      commandIds: commands.map((command) => command.id),
      smoke,
      missingRequired: requiredIds.filter((id) => !commands.some((command) => command.id === id)),
      deadTargets: smoke.filter((entry) => entry.ok !== true),
      legacyDeadVerbs: commands.filter((command) => ['toggle-friction', 'toggle-panel', 'select-project', 'open-squid-room'].includes(command.id)).map((command) => command.id),
    };
  }, SURVIVING_PALETTE_COMMANDS);
  recorder.record(
    'K3',
    palette.missingRequired.length === 0 && palette.deadTargets.length === 0 && palette.legacyDeadVerbs.length === 0,
    `palette commands=${palette.commandIds.length} deadTargets=${palette.deadTargets.length}`,
    palette
  );

  const screenshots = await runScreenshotAffordanceProbe(page);
  recorder.record(
    'K4',
    screenshots.initial.tray === true
      && screenshots.initial.drawer === true
      && screenshots.drawerOpen === true
      && screenshots.afterDrop.chips.length >= 1,
    'Mira screenshot drawer opens and dropped image becomes attachment chip',
    screenshots
  );

  const modules = await readRendererModuleCacheState(page);
  const intactFiles = readPhase5DeferredIntactFiles();
  const badNoise = findBadRendererNoise(rendererNoise);
  recorder.record(
    'K5',
    modules.projectRoomsLoaded === false
      && modules.oracleTabLoaded === false
      && modules.imageGenLoaded !== true
      && intactFiles.every((entry) => entry.present === true)
      && badNoise.length === 0,
    'flag-on killed modules/css not loaded while deferred files remain intact',
    { modules, intactFiles, badNoise }
  );

  const k6State = await readPhase4KillState(page);
  recorder.record(
    'K6',
    k6State.bottomBarCount === 1
      && k6State.railTabs.includes('mira')
      && k6State.railTabs.includes('squid-room')
      && k6State.railTabs.includes('today')
      && k6State.headerActions.every((entry) => ['settingsBtn', 'fullRestartBtn'].includes(entry)),
    `bottomBars=${k6State.bottomBarCount} rail=${k6State.railTabs.join('/')}`,
    k6State
  );
}

async function setTrustQuoteArmExpanded(page, expanded) {
  await page.evaluate((targetExpanded) => {
    const section = document.getElementById('shellV2TrustQuoteSection');
    const currentlyExpanded = section?.dataset?.shellV2Expanded === 'true';
    if (section && currentlyExpanded !== targetExpanded) {
      section.querySelector?.('.shell-v2-arm-section-toggle')?.click();
    }
  }, expanded);
  await page.waitForFunction((targetExpanded) => {
    const section = document.getElementById('shellV2TrustQuoteSection');
    const panel = section?.querySelector?.('.shell-v2-arm-panes');
    const sectionStateOk = section?.dataset?.shellV2Expanded === (targetExpanded ? 'true' : 'false');
    const panelStateOk = targetExpanded
      ? panel?.hidden === false && window.getComputedStyle(panel).display !== 'none'
      : panel?.hidden === true && window.getComputedStyle(panel).display === 'none';
    return sectionStateOk && panelStateOk;
  }, expanded, { timeout: 5000 });
}

async function readTrustQuoteArmPaint(page) {
  return page.evaluate((paneIds) => {
    const out = {};
    for (const paneId of paneIds) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const xterm = terminal?.querySelector?.('.xterm') || terminal;
      const rows = [...(xterm?.querySelectorAll?.('.xterm-rows > div') || [])];
      const rowTexts = rows.map((row) => String(row?.innerText || row?.textContent || ''));
      const paintedRows = rowTexts.filter((text) => /\S/.test(text)).length;
      const rect = xterm?.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      const style = xterm ? window.getComputedStyle(xterm) : null;
      out[paneId] = {
        found: Boolean(xterm),
        rowCount: rows.length,
        paintedRows,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        display: style?.display || '',
        visibility: style?.visibility || '',
        sample: rowTexts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    }
    return out;
  }, TRUSTQUOTE_ARM_PANE_IDS);
}

async function waitForTrustQuoteArmPaint(page, timeoutMs = 15000) {
  const started = Date.now();
  let paint = null;
  while (Date.now() - started < timeoutMs) {
    paint = await readTrustQuoteArmPaint(page);
    const ok = TRUSTQUOTE_ARM_PANE_IDS.every((paneId) => {
      const entry = paint?.[paneId];
      return entry?.found === true
        && entry.paintedRows > 0
        && entry.rect?.w > 20
        && entry.rect?.h > 20
        && entry.display !== 'none'
        && entry.visibility !== 'hidden';
    });
    if (ok) return { ok: true, paint };
    await sleep(250);
  }
  return { ok: false, paint };
}

async function readLeadReportLine(page) {
  return page.evaluate(() => {
    const report = document.querySelector('[data-shell-v2-lead-report="trustquote-lead"]')
      || document.getElementById('shellV2TrustQuoteLeadReport');
    const rect = report?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const style = report ? window.getComputedStyle(report) : null;
    return {
      found: Boolean(report),
      id: report?.id || '',
      dataTarget: report?.dataset?.shellV2LeadReport || '',
      text: report?.textContent || '',
      hidden: report?.hidden === true || style?.display === 'none' || style?.visibility === 'hidden',
      placeholder: report?.dataset?.placeholder === 'true' || report?.getAttribute?.('data-placeholder') === 'true',
      rect: {
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
  });
}

async function capturePhase2Screenshots(page, runId) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase2', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'mira');
  await page.waitForTimeout(250);
  await capture('phase2-mira');

  await clickTab(page, 'squid-room');
  await setTrustQuoteArmExpanded(page, true);
  await page.waitForTimeout(250);
  await capture('phase2-squid-room-expanded');

  await setTrustQuoteArmExpanded(page, false);
  await page.waitForTimeout(250);
  await capture('phase2-squid-room-collapsed');

  await clickTab(page, 'today');
  await page.waitForTimeout(250);
  await capture('phase2-today');

  return screenshots;
}

function buildPhase3TodayRows(nowMs = Date.now()) {
  const day = new Date(nowMs);
  day.setHours(10, 10, 0, 0);
  const base = day.getTime();
  return [
    {
      messageId: 'phase3-today-team',
      sessionId: 'app-session-902',
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: base,
      brokeredAtMs: base + 10,
      rawBody: '[TASK] (Architect): Today populated row from the QA ledger.',
      status: 'routed',
      ackStatus: 'delivered',
      attempt: 1,
      metadata: {},
    },
    {
      messageId: 'phase3-today-james',
      sessionId: 'app-session-902',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      sentAtMs: base - 60000,
      brokeredAtMs: base - 59980,
      rawBody: '[FYI] FULL MSG AT .squidrun/coord/full-agent-messages/phase3-today-james.txt',
      status: 'acked',
      ackStatus: 'telegram_reply_requirement_satisfied',
      attempt: 1,
      metadata: {
        materializedFullPayload: true,
        materializedFullPayloadPath: '.squidrun/coord/full-agent-messages/phase3-today-james.txt',
      },
    },
    {
      messageId: 'phase3-today-system',
      sessionId: 'app-session-901',
      senderRole: 'system',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: base - 120000,
      brokeredAtMs: base - 119980,
      rawBody: '[SYS] Deliberate failed row for status accent verification.',
      status: 'failed',
      ackStatus: 'n/a',
      errorCode: 'qa_intentional_failed_status',
      attempt: 2,
      metadata: {},
    },
  ];
}

function buildPhase4OverflowRows(prefix, nowMs = Date.now(), count = 60, offset = 0) {
  const day = new Date(nowMs);
  day.setHours(11, 20, 0, 0);
  const base = day.getTime() + offset;
  return Array.from({ length: count }, (_entry, index) => ({
    messageId: `${prefix}-overflow-${offset}-${index}`,
    sessionId: `app-session-${930 + Math.floor(index / 12)}`,
    senderRole: index % 5 === 0 ? 'user' : (index % 2 === 0 ? 'builder' : 'oracle'),
    targetRole: index % 5 === 0 ? 'architect' : (index % 2 === 0 ? 'oracle' : 'builder'),
    channel: index % 5 === 0 ? 'telegram' : 'ws',
    direction: index % 2 === 0 ? 'outbound' : 'inbound',
    sentAtMs: base + index * 1000,
    brokeredAtMs: base + index * 1000 + 10,
    rawBody: `[FYI] Phase 4 overflow row ${index + 1} for Today list spill verification.`,
    status: index % 17 === 0 ? 'failed' : 'routed',
    ackStatus: 'delivered',
    attempt: 1,
    metadata: {},
  }));
}

function writePhase3FullMessageFixture(dataRoot) {
  const fullDir = path.join(dataRoot, '.squidrun', 'coord', 'full-agent-messages');
  ensureDir(fullDir);
  const filePath = path.join(fullDir, 'phase3-today-james.txt');
  const body = [
    'SQUIDRUN FULL AGENT MESSAGE',
    `createdAt: ${new Date().toISOString()}`,
    'messageId: phase3-today-james',
    'bytesUtf8: 91',
    '',
    '--- FULL MESSAGE START ---',
    '[FYI] James: this is the materialized QA payload for the Today tab.',
    '--- FULL MESSAGE END ---',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

async function upsertTodayRows(page, rows, options = {}) {
  return page.evaluate(async ({ seedRows, refresh }) => {
    const bridge = window.squidrunAPI || window.squidrun || {};
    const invoke = typeof bridge.invoke === 'function'
      ? bridge.invoke.bind(bridge)
      : (typeof bridge.ipc?.invoke === 'function' ? bridge.ipc.invoke.bind(bridge.ipc) : null);
    if (!invoke) return { ok: false, reason: 'bridge_unavailable' };
    const results = [];
    for (const row of seedRows) {
      results.push(await invoke('evidence-ledger:upsert-comms-journal', row));
    }
    if (refresh !== false) {
      const controller = window.__squidrunShellV2 || document.body?.__squidrunShellV2Controller;
      if (controller && typeof controller.refreshToday === 'function') {
        await controller.refreshToday({ preserveScroll: false });
      }
    }
    return {
      ok: results.every((result) => result?.ok !== false),
      results,
    };
  }, { seedRows: rows, refresh: options.refresh !== false });
}

async function seedPhase3TodayRows(page, dataRoot) {
  writePhase3FullMessageFixture(dataRoot);
  return upsertTodayRows(page, buildPhase3TodayRows());
}

async function readTodayGateState(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.shell-v2-today-row')];
    const chips = [...document.querySelectorAll('.shell-v2-today-chip')].map((chip) => ({
      filter: chip.dataset.todayFilter || '',
      text: chip.textContent || '',
      active: chip.classList.contains('active'),
    }));
    return {
      rowCount: rows.length,
      emptyVisible: Boolean(document.querySelector('.shell-v2-today-empty')),
      expandedCount: document.querySelectorAll('.shell-v2-today-row.is-expanded').length,
      failedAccentCount: document.querySelectorAll('.shell-v2-today-status.is-failed').length,
      fullMeta: document.querySelector('.shell-v2-today-full-meta')?.textContent || '',
      rawExpanded: document.querySelector('.shell-v2-today-raw')?.textContent || '',
      chips,
      activeFilter: chips.find((chip) => chip.active)?.filter || '',
      bodyText: document.body?.innerText || '',
    };
  });
}

async function waitForTodayRowCount(page, count) {
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.shell-v2-today-row').length >= expected
  ), count, { timeout: 10000 });
}

async function capturePhase3TodayScreenshots(page, runId, recorder, dataRoot) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase3', runId);
  const phase4ScreenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase4', runId);
  ensureDir(screenshotDir);
  ensureDir(phase4ScreenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };
  const capturePhase4 = async (name) => {
    const filePath = path.join(phase4ScreenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'today');
  await page.waitForSelector('#shellV2TodayRoot', { timeout: 10000 });
  await page.waitForTimeout(300);
  await capture('phase3-today-empty');
  const emptyState = await readTodayGateState(page);
  recorder.record('T1', emptyState.rowCount === 0 && emptyState.emptyVisible === true, 'Today empty state captured', emptyState);

  const seed = await seedPhase3TodayRows(page, dataRoot);
  recorder.record('T2', seed.ok === true, 'seeded real QA comms_journal rows via IPC', seed);
  await waitForTodayRowCount(page, 3);
  await page.waitForTimeout(250);
  await capture('phase3-today-populated');
  const populatedState = await readTodayGateState(page);
  recorder.record(
    'T3',
    populatedState.rowCount >= 3
      && populatedState.failedAccentCount === 1
      && populatedState.chips.some((chip) => chip.filter === 'james' && /James\s+1/.test(chip.text)),
    'Today populated rows/counts/status accent verified',
    populatedState
  );

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.shell-v2-today-row')]
      .find((candidate) => /James|FULL MSG AT|phase3-today-james/i.test(candidate.innerText || candidate.textContent || ''));
    row?.querySelector?.('.shell-v2-today-summary')?.click();
  });
  await page.waitForSelector('.shell-v2-today-row.is-expanded', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('.shell-v2-today-full-btn')?.click());
  await page.waitForSelector('.shell-v2-today-full-meta', { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase3-today-expanded-row');
  const expandedState = await readTodayGateState(page);
  recorder.record(
    'T4',
    expandedState.expandedCount >= 1
      && /sha\s+[a-f0-9]{12}/i.test(expandedState.fullMeta)
      && /FULL MSG AT/.test(expandedState.rawExpanded),
    'Today expanded row and lazy full-file read verified',
    expandedState
  );

  const copyState = await page.evaluate(async () => {
    window.__shellV2GateClipboardWrites = [];
    window.__shellV2GateCopyEvents = [];
    document.addEventListener('shell-v2-today-copy', (event) => {
      window.__shellV2GateCopyEvents.push(event.detail || {});
    }, { once: false });
    try {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__shellV2GateClipboardWrites.push(String(text || ''));
          },
        },
      });
    } catch (_) {}
    document.querySelector('.shell-v2-today-copy-btn[data-today-copy="copy-body"]')?.click?.();
    document.querySelector('.shell-v2-today-copy-btn[data-today-copy="copy-id"]')?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      buttons: [...document.querySelectorAll('.shell-v2-today-copy-btn')].map((button) => ({
        copy: button.dataset.todayCopy || '',
        state: button.dataset.copyState || '',
        text: button.textContent || '',
      })),
      writes: window.__shellV2GateClipboardWrites || [],
      events: window.__shellV2GateCopyEvents || [],
    };
  });
  recorder.record(
    'T4b',
    copyState.buttons.some((button) => button.copy === 'copy-body')
      && copyState.buttons.some((button) => button.copy === 'copy-id')
      && copyState.events.some((event) => event.label === 'Copy body' && /FULL MSG AT/.test(event.value || '') && event.ok === true)
      && copyState.events.some((event) => event.label === 'Copy id' && event.value === 'phase3-today-james' && event.ok === true),
    'Today expanded row Copy body/Copy id buttons write expected clipboard values',
    copyState
  );
  await page.waitForTimeout(250);
  await capturePhase4('phase4-today-copy-affordances');

  const overlayPreservation = await runSettingsOverlayStatePreservation(page);
  recorder.record(
    'S3',
    overlayPreservation.before.activeTab === 'today'
      && overlayPreservation.after.activeTab === 'today'
      && overlayPreservation.before.expandedCount >= 1
      && overlayPreservation.after.expandedCount >= 1
      && overlayPreservation.before.xtermCount === overlayPreservation.after.xtermCount,
    'settings overlay preserves Today expanded row state and pane DOM count',
    overlayPreservation
  );

  await page.click('[data-today-filter="james"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('.shell-v2-today-row').length === 1
      && document.querySelector('[data-today-filter="james"]')?.classList.contains('active')
  ), null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase3-today-chips-filtered');
  const filteredState = await readTodayGateState(page);
  recorder.record(
    'T5',
    filteredState.rowCount === 1 && filteredState.activeFilter === 'james',
    'Today James chip filter verified',
    filteredState
  );

  await page.click('[data-today-filter="all"]');
  const overflowSeedRows = buildPhase4OverflowRows(runId, Date.now(), 60, 0);
  const overflowSeed = await upsertTodayRows(page, overflowSeedRows);
  await waitForTodayRowCount(page, 50);
  const overflowBefore = await page.evaluate(() => {
    const list = document.querySelector('[data-today-list="true"]');
    if (list) list.scrollTop = Math.max(96, Math.floor((list.scrollHeight - list.clientHeight) / 2));
    return {
      rowCount: document.querySelectorAll('.shell-v2-today-row').length,
      scrollTop: Number(list?.scrollTop || 0),
      scrollHeight: Number(list?.scrollHeight || 0),
      clientHeight: Number(list?.clientHeight || 0),
      pillHidden: document.querySelector('[data-today-new-pill="true"]')?.hidden === true,
    };
  });
  const newRows = buildPhase4OverflowRows(runId, Date.now(), 2, 120000);
  const overflowNewSeed = await upsertTodayRows(page, newRows, { refresh: false });
  const refreshResult = await page.evaluate(async () => {
    const controller = window.__squidrunShellV2 || document.body?.__squidrunShellV2Controller;
    return controller?.refreshToday?.({ preserveScroll: true }) || { ok: false, reason: 'controller_unavailable' };
  });
  await page.waitForFunction(() => document.querySelector('[data-today-new-pill="true"]')?.hidden === false, null, { timeout: 5000 });
  const overflowPending = await page.evaluate(() => {
    const list = document.querySelector('[data-today-list="true"]');
    const pill = document.querySelector('[data-today-new-pill="true"]');
    return {
      rowCount: document.querySelectorAll('.shell-v2-today-row').length,
      scrollTop: Number(list?.scrollTop || 0),
      scrollHeight: Number(list?.scrollHeight || 0),
      clientHeight: Number(list?.clientHeight || 0),
      pillHidden: pill?.hidden === true,
      pillText: pill?.textContent || '',
    };
  });
  await page.waitForTimeout(250);
  await capturePhase4('phase4-today-overflow-pill');
  await page.click('[data-today-new-pill="true"]');
  await page.waitForFunction(() => document.querySelector('[data-today-new-pill="true"]')?.hidden === true, null, { timeout: 5000 });
  const overflowApplied = await page.evaluate(() => {
    const list = document.querySelector('[data-today-list="true"]');
    return {
      rowCount: document.querySelectorAll('.shell-v2-today-row').length,
      scrollTop: Number(list?.scrollTop || 0),
      pillHidden: document.querySelector('[data-today-new-pill="true"]')?.hidden === true,
    };
  });
  recorder.record(
    'T6',
    overflowSeed.ok === true
      && overflowNewSeed.ok === true
      && overflowBefore.scrollHeight > overflowBefore.clientHeight
      && overflowBefore.scrollTop > 0
      && overflowPending.rowCount === overflowBefore.rowCount
      && overflowPending.pillHidden === false
      && /2 new/.test(overflowPending.pillText)
      && overflowPending.scrollTop > 0
      && overflowApplied.rowCount >= overflowBefore.rowCount + 2
      && overflowApplied.scrollTop === 0
      && overflowApplied.pillHidden === true,
    'Today overflow list preserves scroll, shows new-row pill, and applies pending rows on click',
    { overflowSeed, overflowNewSeed, refreshResult, overflowBefore, overflowPending, overflowApplied }
  );

  return screenshots;
}

async function capturePhase4ReviewScreenshots(page, runId) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase4', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'today');
  await page.click('#settingsBtn');
  await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') === true, null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase4-settings-overlay-open');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#shellV2SettingsOverlay')?.classList?.contains('open') !== true, null, { timeout: 5000 });

  await clickTab(page, 'mira');
  await page.evaluate(() => {
    const drawer = document.querySelector('#shellV2ScreenshotsDrawer');
    drawer?.classList?.remove('open');
    drawer?.setAttribute?.('aria-hidden', 'true');
    const palette = document.querySelector('#commandPaletteOverlay');
    palette?.classList?.remove('open');
  });
  await ensureMiraAttachmentChip(page);
  await page.waitForTimeout(250);
  await capture('phase4-mira-composer-attachment');

  await page.keyboard.press('Control+K');
  await page.waitForFunction(() => document.querySelector('#commandPaletteOverlay')?.classList?.contains('open') === true, null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase4-palette-open');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#commandPaletteOverlay')?.classList?.contains('open') !== true, null, { timeout: 5000 });

  return screenshots;
}

async function runVisualConformanceAssertions({ page, recorder, runId }) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-visual-doorbell', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'today');
  await page.waitForSelector('.shell-v2-today-status.is-failed', { timeout: 10000 });

  const referenceTokens = readShellV2ReferenceTokens();
  const liveTokens = await page.evaluate((tokens) => {
    const style = window.getComputedStyle(document.documentElement);
    const out = {};
    tokens.forEach((token) => {
      out[token] = String(style.getPropertyValue(token) || '').trim();
    });
    return out;
  }, SHELL_V2_REFERENCE_TOKENS);
  const tokenMismatches = SHELL_V2_REFERENCE_TOKENS
    .filter((token) => normalizeCssToken(referenceTokens[token]) !== normalizeCssToken(liveTokens[token]))
    .map((token) => ({
      token,
      reference: referenceTokens[token] || '',
      live: liveTokens[token] || '',
      referenceNormalized: normalizeCssToken(referenceTokens[token]),
      liveNormalized: normalizeCssToken(liveTokens[token]),
    }));
  recorder.record(
    'VP1',
    tokenMismatches.length === 0,
    `reference token mismatches=${tokenMismatches.length}`,
    { referencePath: SHELL_V2_VISUAL_REFERENCE_PATH, referenceTokens, liveTokens, tokenMismatches }
  );

  const hueSweep = await page.evaluate(() => {
    const selectors = [
      'body.shell-v2-enabled',
      '.header',
      '#shellV2TabRail',
      '.shell-v2-tab',
      '.shell-v2-tab-doorbell-badge',
      '.shell-v2-view',
      '.shell-v2-core-strip',
      '.shell-v2-station',
      '.pane',
      '.pane-header',
      '.pane-terminal',
      '.shell-v2-arm-section',
      '.shell-v2-arm-section-header',
      '.shell-v2-arm-section-toggle',
      '.shell-v2-arm-panes',
      '.shell-v2-arm-pane',
      '.shell-v2-today-root',
      '.shell-v2-today-chip',
      '.shell-v2-today-search',
      '.shell-v2-today-row',
      '.shell-v2-today-summary',
      '.shell-v2-today-tag',
      '.shell-v2-today-status',
      '.shell-v2-today-full-error',
      '.shell-v2-bottom-bar',
      '.command-bar',
      '.command-input',
      '.voice-btn',
      '.send-btn',
      '.mira-live-reply',
      '.cli-badge',
    ];
    const props = [
      'color',
      'backgroundColor',
      'borderTopColor',
      'borderRightColor',
      'borderBottomColor',
      'borderLeftColor',
      'outlineColor',
    ];
    const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    const exactAllowed = new Set([
      '232,163,61',
      '26,18,6',
      '230,221,205',
      '159,184,168',
      '200,210,220',
      '122,135,148',
      '74,85,96',
      '10,14,20',
      '13,18,25',
      '17,24,35',
      '22,31,44',
      '8,11,16',
      '6,9,14',
      '255,255,255',
      '0,0,0',
    ]);
    function splitNumbers(value) {
      return String(value || '')
        .trim()
        .replace(/\s*\/\s*/g, ',')
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
    }
    function parseColor(value) {
      const text = String(value || '').trim();
      if (!text || text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const rgb = text.match(/^rgba?\((.+)\)$/i);
      if (rgb) {
        const parts = splitNumbers(rgb[1]);
        return {
          r: Math.round(Number(parts[0]) || 0),
          g: Math.round(Number(parts[1]) || 0),
          b: Math.round(Number(parts[2]) || 0),
          a: parts[3] === undefined ? 1 : Number(parts[3]),
        };
      }
      const srgb = text.match(/^color\(srgb\s+(.+)\)$/i);
      if (srgb) {
        const parts = splitNumbers(srgb[1]);
        return {
          r: Math.round((Number(parts[0]) || 0) * 255),
          g: Math.round((Number(parts[1]) || 0) * 255),
          b: Math.round((Number(parts[2]) || 0) * 255),
          a: parts[3] === undefined ? 1 : Number(parts[3]),
        };
      }
      return null;
    }
    function rgbToHsl({ r, g, b }) {
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const l = (max + min) / 2;
      if (max === min) return { h: 0, s: 0, l };
      const d = max - min;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      return { h: h * 60, s, l };
    }
    function isAllowed(color, element) {
      if (!color || color.a <= 0.04) return true;
      const key = `${color.r},${color.g},${color.b}`;
      if (exactAllowed.has(key)) return true;
      const hsl = rgbToHsl(color);
      if (hsl.l <= 0.16 || hsl.s <= 0.24) return true;
      if (hsl.h >= 30 && hsl.h <= 44 && hsl.s >= 0.25) return true;
      return false;
    }
    const violations = [];
    const samples = [];
    elements.forEach((element) => {
      const style = window.getComputedStyle(element);
      props.forEach((prop) => {
        const value = style[prop];
        const color = parseColor(value);
        if (!color) return;
        const sample = {
          selector: element.id ? `#${element.id}` : `.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
          prop,
          value,
          color,
        };
        samples.push(sample);
        if (!isAllowed(color, element)) violations.push(sample);
      });
    });
    const failedStatuses = [...document.querySelectorAll('.shell-v2-today-status.is-failed')].map((element) => {
      const style = window.getComputedStyle(element);
      return {
        text: element.textContent || '',
        color: style.color || '',
        sampled: samples.some((sample) => sample.prop === 'color' && sample.value === style.color),
      };
    });
    return {
      checked: samples.length,
      violations: violations.slice(0, 80),
      todayFailedStatusCount: failedStatuses.length,
      failedStatuses,
    };
  });
  recorder.record(
    'VP2',
    hueSweep.violations.length === 0 && hueSweep.todayFailedStatusCount >= 1,
    `computed non-reference hue violations=${hueSweep.violations.length} failedRows=${hueSweep.todayFailedStatusCount}`,
    hueSweep
  );

  await clickTab(page, 'squid-room');
  await setTrustQuoteArmExpanded(page, false);
  await page.waitForTimeout(250);
  const collapsed = await page.evaluate(() => {
    const section = document.getElementById('shellV2TrustQuoteSection');
    const header = section?.querySelector?.('.shell-v2-arm-section-header');
    const panel = section?.querySelector?.('.shell-v2-arm-panes');
    const sectionRect = section?.getBoundingClientRect?.() || { height: 0, width: 0 };
    const headerRect = header?.getBoundingClientRect?.() || { height: 0, width: 0 };
    const u = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--u')) || 0;
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    const separators = [...document.querySelectorAll('.shell-v2-station-separator')].map((element) => ({
      text: element.textContent || '',
      ariaHidden: element.getAttribute('aria-hidden') || '',
      className: element.className || '',
    }));
    return {
      sectionFound: Boolean(section),
      collapsed: section?.classList?.contains('is-collapsed') === true,
      sectionHeight: Math.round(sectionRect.height),
      headerHeight: Math.round(headerRect.height),
      u,
      overage: Math.round(sectionRect.height - headerRect.height),
      panelHidden: panel?.hidden === true,
      panelDisplay: panelStyle?.display || '',
      panelVisible: panel?.hidden !== true && panelStyle?.display !== 'none',
      separators,
    };
  });
  await capture('visual-squid-room');
  const separatorOk = collapsed.separators.length >= 2
    && collapsed.separators.every((entry) => entry.text === '·' && entry.ariaHidden === 'true');
  recorder.record(
    'VP3',
    collapsed.sectionFound === true
      && collapsed.collapsed === true
      && collapsed.sectionHeight <= collapsed.headerHeight + collapsed.u
      && collapsed.panelHidden === true
      && collapsed.panelDisplay === 'none'
      && collapsed.panelVisible === false
      && separatorOk,
    `collapsed overage=${collapsed.overage}px separators=${collapsed.separators.length}`,
    collapsed
  );

  const readMotion = async () => page.evaluate(() => {
    function splitCssList(value) {
      const out = [];
      let current = '';
      let depth = 0;
      for (const char of String(value || '')) {
        if (char === '(') depth += 1;
        if (char === ')') depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) {
          out.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      if (current.trim()) out.push(current.trim());
      return out;
    }
    function durationMs(value) {
      const text = String(value || '').trim();
      if (!text || text === '0s' || text === '0ms') return 0;
      if (text.endsWith('ms')) return Number.parseFloat(text) || 0;
      if (text.endsWith('s')) return (Number.parseFloat(text) || 0) * 1000;
      return Number.parseFloat(text) || 0;
    }
    const selectors = [
      '.shell-v2-tab',
      '.shell-v2-view',
      '.pane-header',
      '.command-input',
      '.shell-v2-today-summary',
      '.shell-v2-today-chip',
      '.shell-v2-today-new-pill',
      '.shell-v2-arm-section-toggle',
      '.shell-v2-station-menu-trigger',
      '.shell-v2-header-actions button',
    ];
    const elements = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
    const samples = elements.map((element) => {
      const style = window.getComputedStyle(element);
      const transitionDurations = splitCssList(style.transitionDuration).map(durationMs);
      const animationDurations = splitCssList(style.animationDuration).map(durationMs);
      return {
        selector: element.id ? `#${element.id}` : `.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        maxTransitionMs: Math.max(0, ...transitionDurations),
        maxAnimationMs: Math.max(0, ...animationDurations),
      };
    });
    const easingValues = [...new Set(samples
      .map((sample) => sample.transitionTimingFunction)
      .filter((value) => value && value !== 'ease' && value !== 'initial'))];
    const badDuration = samples.filter((sample) => sample.maxTransitionMs > 150 || sample.maxAnimationMs > 150);
    const activeAnimations = samples.filter((sample) => sample.animationName && sample.animationName !== 'none' && sample.maxAnimationMs > 0);
    return { samples, easingValues, badDuration, activeAnimations };
  });
  const motion = await readMotion();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const reducedMotion = await readMotion();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  recorder.record(
    'VP4',
    motion.badDuration.length === 0
      && motion.activeAnimations.length === 0
      && motion.easingValues.every((value) => /^linear(?:,\s*linear)*$/.test(value))
      && reducedMotion.samples.every((sample) => sample.maxTransitionMs === 0 && sample.maxAnimationMs === 0),
    `motion max<=150 bad=${motion.badDuration.length} reducedNonzero=${reducedMotion.samples.filter((sample) => sample.maxTransitionMs || sample.maxAnimationMs).length}`,
    { motion, reducedMotion }
  );

  await clickTab(page, 'mira');
  await page.waitForTimeout(250);
  await capture('visual-mira');
  await clickTab(page, 'today');
  await page.waitForTimeout(250);
  await capture('visual-today');
  const structure = await page.evaluate(() => {
    const rectOf = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect?.() || { width: 0, height: 0, x: 0, y: 0 };
      return {
        found: Boolean(element),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      };
    };
    const parseRgb = (value) => {
      const text = String(value || '').trim();
      const match = text.match(/^rgba?\(([^)]+)\)$/i);
      if (!match) return null;
      const parts = match[1].split(/[,\s/]+/).map((part) => part.trim()).filter(Boolean);
      return {
        r: Math.round(Number(parts[0]) || 0),
        g: Math.round(Number(parts[1]) || 0),
        b: Math.round(Number(parts[2]) || 0),
        a: parts[3] === undefined ? 1 : Number(parts[3]),
      };
    };
    const isAmberish = (value) => {
      const color = parseRgb(value);
      if (!color || color.a <= 0.04) return false;
      const rn = color.r / 255;
      const gn = color.g / 255;
      const bn = color.b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      if (max === min) return false;
      const d = max - min;
      const l = (max + min) / 2;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      return h >= 30 && h <= 44 && s >= 0.25 && l > 0.16;
    };
    return {
      header: rectOf('.header'),
      rail: rectOf('#shellV2TabRail'),
      bottomBar: rectOf('.status-bar.shell-v2-bottom-bar'),
      activeViews: [...document.querySelectorAll('.shell-v2-view[data-shell-v2-active="true"]')]
        .map((view) => view.dataset.shellV2View || ''),
      bodyTab: document.body?.dataset?.shellV2ActiveTab || '',
      squidRoomTab: (() => {
        const tab = document.querySelector('[data-shell-v2-tab="squid-room"]');
        const label = tab?.querySelector?.('.shell-v2-tab-label');
        const tabRect = tab?.getBoundingClientRect?.() || { width: 0, height: 0 };
        const labelRect = label?.getBoundingClientRect?.() || { width: 0, height: 0 };
        const style = label ? window.getComputedStyle(label) : null;
        return {
          found: Boolean(tab && label),
          text: label?.textContent || '',
          whiteSpace: style?.whiteSpace || '',
          tabWidth: Math.round(tabRect.width),
          labelWidth: Math.round(labelRect.width),
          labelHeight: Math.round(labelRect.height),
          noWrap: Boolean(label)
            && style?.whiteSpace === 'nowrap'
            && Math.round(labelRect.height) <= 18
            && Math.round(labelRect.width) <= Math.round(tabRect.width),
        };
      })(),
      stationChips: [...document.querySelectorAll('.shell-v2-station-chip')].map((chip) => ({
        text: chip.textContent || '',
        hasCliBadge: Boolean(chip.querySelector('.cli-badge')),
        hasBareAmpersand: /(^|\s)&(\s|$)/.test(chip.textContent || ''),
      })),
      idleStationBorders: [...document.querySelectorAll('.shell-v2-station.pane:not(.focused)')].map((pane) => {
        const style = window.getComputedStyle(pane);
        return {
          paneId: pane.dataset?.paneId || '',
          borderTopColor: style.borderTopColor,
          amberish: isAmberish(style.borderTopColor),
        };
      }),
    };
  });
  const mysteryStationChips = structure.stationChips.filter((chip) => chip.hasCliBadge || chip.hasBareAmpersand);
  const idleAccentBorders = structure.idleStationBorders.filter((entry) => entry.amberish);
  recorder.record(
    'VP5',
    structure.header.height === 44
      && structure.rail.height === 44
      && structure.bottomBar.height === 30
      && structure.activeViews.length === 1
      && structure.bodyTab === 'today'
      && structure.squidRoomTab.noWrap === true
      && mysteryStationChips.length === 0
      && idleAccentBorders.length === 0,
    `rail=${structure.rail.height}px bottom=${structure.bottomBar.height}px active=${structure.bodyTab} squidNoWrap=${structure.squidRoomTab.noWrap === true} mysteryChips=${mysteryStationChips.length} idleAccentBorders=${idleAccentBorders.length}`,
    { ...structure, mysteryStationChips, idleAccentBorders }
  );

  return screenshots;
}

async function queryDoorbellJournalRows(page) {
  return page.evaluate(async () => {
    const bridge = window.squidrunAPI || window.squidrun || {};
    const invoke = typeof bridge.invoke === 'function'
      ? bridge.invoke.bind(bridge)
      : (typeof bridge.ipc?.invoke === 'function' ? bridge.ipc.invoke.bind(bridge.ipc) : null);
    if (!invoke) return { ok: false, reason: 'invoke_unavailable', rows: [] };
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dayStartMs = now.getTime();
    const result = await invoke('evidence-ledger:query-comms-journal', {
      sinceMs: dayStartMs,
      untilMs: dayStartMs + 24 * 60 * 60 * 1000 - 1,
      order: 'asc',
      limit: 5000,
    });
    const sourceRows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    const rows = sourceRows
      .filter((row) => (
        /\[DOORBELL\]/.test(String(row.rawBody || row.raw_body || ''))
        || row.metadata?.shellV2Doorbell === true
      ))
      .map((row) => ({
        rowId: row.rowId ?? row.row_id ?? null,
        messageId: row.messageId ?? row.message_id ?? '',
        rawBody: row.rawBody ?? row.raw_body ?? '',
        senderRole: row.senderRole ?? row.sender_role ?? '',
        targetRole: row.targetRole ?? row.target_role ?? '',
        channel: row.channel ?? '',
        status: row.status ?? '',
        metadata: row.metadata || {},
      }));
    return { ok: Array.isArray(result) || result?.ok === true, rows };
  });
}

async function waitForDoorbellJournalRows(page, minCount, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await queryDoorbellJournalRows(page);
    if (last.ok === true && last.rows.length >= minCount) return last;
    await sleep(250);
  }
  return last || { ok: false, reason: 'timeout', rows: [] };
}

async function readDoorbellDomState(page) {
  return page.evaluate(() => {
    const badge = document.querySelector('[data-shell-v2-doorbell-badge="squid-room"]');
    const markedHeaders = [...document.querySelectorAll('.pane-header.shell-v2-doorbell-on')].map((header) => {
      const pane = header.closest?.('.pane');
      return {
        paneId: pane?.dataset?.paneId || '',
        eventName: header.getAttribute('data-shell-v2-doorbell-event') || '',
        text: header.textContent || '',
      };
    });
    const slots = [...document.querySelectorAll('[data-shell-v2-doorbell-slot="true"]')].map((slot) => ({
      paneId: slot.dataset.paneId || '',
      eventName: slot.dataset.doorbellEvent || '',
      text: slot.textContent || '',
      visible: Boolean(slot.offsetWidth || slot.offsetHeight),
    }));
    return {
      activeTab: document.body?.dataset?.shellV2ActiveTab || '',
      badgeFound: Boolean(badge),
      badgeHidden: badge?.hidden === true || window.getComputedStyle(badge).display === 'none',
      badgeOn: badge?.classList?.contains('on') === true,
      badgeText: badge?.textContent || '',
      markedHeaders,
      slots,
    };
  });
}

async function runDoorbellBehaviorAssertions({ page, recorder, runId, idleSoakMs = DOORBELL_IDLE_SOAK_MS }) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-visual-doorbell', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'squid-room');
  await setTrustQuoteArmExpanded(page, true);
  const idleBeforeRows = await queryDoorbellJournalRows(page);
  const idleBeforeDom = await readDoorbellDomState(page);
  await sleep(idleSoakMs);
  const idleAfterRows = await queryDoorbellJournalRows(page);
  const idleAfterDom = await readDoorbellDomState(page);
  recorder.record(
    'DB4',
    idleBeforeRows.ok === true
      && idleAfterRows.ok === true
      && idleBeforeRows.rows.length === 0
      && idleAfterRows.rows.length === 0
      && idleBeforeDom.badgeHidden === true
      && idleAfterDom.badgeHidden === true
      && idleAfterDom.badgeOn === false,
    `idle soak ${idleSoakMs}ms doorbellRows=${idleAfterRows.rows.length} badge=${idleAfterDom.badgeText || 'hidden'}`,
    { idleBeforeRows, idleBeforeDom, idleAfterRows, idleAfterDom, idleSoakMs }
  );

  const requiredFireEvents = ['permission_prompt', 'lead_escalation', 'process_exit'];
  const fireResults = await page.evaluate(() => {
    const results = [];
    const record = (name, detail) => {
      try {
        document.dispatchEvent(new CustomEvent('shell-v2-doorbell-source-probe', {
          bubbles: true,
          detail,
        }));
        const entry = { name, ok: true, detail };
        results.push(entry);
        return entry;
      } catch (err) {
        const entry = { name, ok: false, error: err?.message || String(err) };
        results.push(entry);
        return entry;
      }
    };

    const probeEnabled = document.body?.dataset?.shellV2DoorbellSourceProbe === 'enabled';
    if (!probeEnabled) {
      return {
        ok: false,
        reason: 'doorbell_source_probe_unavailable',
        expectedMinimumCount: 3,
        results,
      };
    }

    record('pty_permission_prompt_detector', {
      eventName: 'permission_prompt',
      paneId: '2',
      data: 'Permission prompt: approve this command',
    });
    record('lead_escalation_message_parser', {
      eventName: 'lead_escalation',
      panes: ['trustquote-lead'],
      rawBody: '[LEAD ESCALATION] QA fixture',
    });
    record('pty_process_exit_handler', {
      eventName: 'process_exit',
      paneId: '3',
      code: 17,
    });

    return {
      ok: results.every((result) => result.ok === true),
      expectedMinimumCount: 3,
      results,
    };
  });
  const expectedBadgeCount = Number(fireResults.expectedMinimumCount || requiredFireEvents.length);
  const firedWait = await page.waitForFunction((expected) => {
      const badge = document.querySelector('[data-shell-v2-doorbell-badge="squid-room"]');
      const count = Number.parseInt(badge?.textContent || '0', 10);
      return badge && badge.hidden !== true && count >= expected && badge.classList.contains('on');
    }, expectedBadgeCount, { timeout: 10000 })
      .then(() => ({ ok: true, expectedBadgeCount }))
      .catch((err) => ({ ok: false, expectedBadgeCount, reason: err?.message || String(err) }));
  const firedDom = await readDoorbellDomState(page);
  const firedRows = await waitForDoorbellJournalRows(page, expectedBadgeCount, 20000);
  await capture('visual-doorbell-fired');
  const firedEvents = new Set(firedRows.rows.map((row) => row.metadata?.doorbellEvent || ''));
  const markedPaneIds = new Set(firedDom.markedHeaders.map((entry) => entry.paneId));
  const firedBadgeCount = Number.parseInt(firedDom.badgeText || '0', 10);
  const db5Ok = fireResults.ok === true
    && firedWait.ok === true
    && firedBadgeCount >= expectedBadgeCount
    && firedDom.badgeHidden === false
    && requiredFireEvents.every((eventName) => firedEvents.has(eventName))
    && ['2', 'trustquote-lead', '3'].every((paneId) => markedPaneIds.has(paneId));
  recorder.record(
    'DB5',
    db5Ok,
    `badge=${firedDom.badgeText || 'hidden'} events=${[...firedEvents].join('/')}`,
    { fireResults, firedWait, expectedBadgeCount, firedDom, firedRows }
  );
  if (!db5Ok) return screenshots;

  const ackVisit = await page.evaluate(() => {
    const before = document.body?.dataset?.shellV2ActiveTab || '';
    document.querySelector('[data-shell-v2-tab="mira"]')?.click?.();
    const afterMira = document.body?.dataset?.shellV2ActiveTab || '';
    document.querySelector('[data-shell-v2-tab="squid-room"]')?.click?.();
    const afterSquidRoom = document.body?.dataset?.shellV2ActiveTab || '';
    return {
      before,
      afterMira,
      afterSquidRoom,
      miraFound: Boolean(document.querySelector('[data-shell-v2-tab="mira"]')),
      squidRoomFound: Boolean(document.querySelector('[data-shell-v2-tab="squid-room"]')),
    };
  });
  const ackWait = await page.waitForFunction(() => {
    const badge = document.querySelector('[data-shell-v2-doorbell-badge="squid-room"]');
    return badge && (badge.hidden === true || window.getComputedStyle(badge).display === 'none') && badge.textContent === '';
  }, null, { timeout: 10000 })
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, reason: err?.message || String(err) }));
  const clearedDom = await readDoorbellDomState(page);
  const clearedRows = await waitForDoorbellJournalRows(page, 4);
  await page.waitForTimeout(1000);
  const afterAckQuietRows = await queryDoorbellJournalRows(page);
  const ackRows = clearedRows.rows.filter((row) => row.metadata?.doorbellEvent === 'doorbell_ack');
  const db6Ok = ackWait.ok === true
    && clearedDom.badgeHidden === true
    && clearedDom.badgeText === ''
    && clearedDom.markedHeaders.length === 0
    && ackRows.length >= 1
    && afterAckQuietRows.rows.length === clearedRows.rows.length;
  recorder.record(
    'DB6',
    db6Ok,
    `ackRows=${ackRows.length} rowsAfterQuiet=${afterAckQuietRows.rows.length}`,
    { ackVisit, ackWait, clearedDom, clearedRows, afterAckQuietRows }
  );
  if (!db6Ok) return screenshots;

  await clickTab(page, 'today');
  const todayReset = await page.evaluate(async () => {
    const controller = [
      window.__squidrunShellV2,
      document.defaultView?.__squidrunShellV2,
      document.body?.__squidrunShellV2Controller,
    ].find((candidate) => typeof candidate?.refreshToday === 'function');
    const search = document.querySelector('[data-today-search="true"]');
    const searchBefore = search?.value || '';
    if (search) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('[data-today-filter="all"]')?.click?.();
    let refreshResult;
    if (controller) {
      refreshResult = await controller.refreshToday({ preserveScroll: false });
    } else {
      document.dispatchEvent(new CustomEvent('shell-v2-refresh-today', {
        bubbles: true,
        detail: { preserveScroll: false },
      }));
      refreshResult = { ok: true, method: 'dom_event' };
    }
    if (search && search.value) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('[data-today-filter="all"]')?.click?.();
    const pill = document.querySelector('[data-today-new-pill="true"]');
    const pillBeforeClick = {
      found: Boolean(pill),
      hidden: pill?.hidden === true,
      text: pill?.textContent || '',
    };
    if (pill && pill.hidden !== true) pill.click?.();
    const list = document.querySelector('[data-today-list="true"]');
    if (list) list.scrollTop = 0;
    return {
      refreshResult,
      searchBefore,
      searchAfter: search?.value || '',
      activeFilter: [...document.querySelectorAll('[data-today-filter]')]
        .find((chip) => chip.classList.contains('active'))?.dataset?.todayFilter || '',
      pillBeforeClick,
      pillAfterClick: {
        hidden: pill?.hidden === true,
        text: pill?.textContent || '',
      },
      rowCount: document.querySelectorAll('.shell-v2-today-row').length,
    };
  });
  await page.waitForFunction(() => document.body?.dataset?.shellV2ActiveTab === 'today', null, { timeout: 5000 });
  const todayAckWait = await page.waitForFunction(() => {
    const text = `${document.body?.innerText || ''}\n${document.body?.textContent || ''}`;
    return /doorbell[_ ]ack/i.test(text);
  }, null, { timeout: 10000 })
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, reason: err?.message || String(err) }));
  const todayAckRender = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.shell-v2-today-row')].map((row) => ({
      rowId: row.dataset.todayRowId || '',
      kind: row.dataset.todayKind || '',
      status: row.dataset.status || '',
      text: row.textContent || '',
      hasDoorbellAck: /doorbell[_ ]ack/i.test(row.textContent || ''),
    }));
    const activeFilter = [...document.querySelectorAll('[data-today-filter]')]
      .find((chip) => chip.classList.contains('active'))?.dataset?.todayFilter || '';
    const search = document.querySelector('[data-today-search="true"]');
    const pill = document.querySelector('[data-today-new-pill="true"]');
    return {
      activeFilter,
      search: search?.value || '',
      pillHidden: pill?.hidden === true,
      pillText: pill?.textContent || '',
      rowCount: rows.length,
      ackVisible: rows.some((row) => row.hasDoorbellAck),
      ackRows: rows.filter((row) => row.hasDoorbellAck),
      firstRows: rows.slice(0, 5),
    };
  });
  await page.waitForTimeout(250);
  await capture('visual-doorbell-cleared-today');

  const allRows = afterAckQuietRows.rows;
  const expectedEvents = ['permission_prompt', 'lead_escalation', 'process_exit', 'doorbell_ack'];
  const rowEvents = allRows.map((row) => row.metadata?.doorbellEvent || '');
  const receiptRowsOk = allRows.every((row) => (
    row.senderRole === 'system'
      && row.channel === 'system'
      && row.status === 'recorded'
      && row.metadata?.source === 'shell-v2-doorbell'
      && row.metadata?.scope === 'main'
      && row.metadata?.windowKey === 'main'
      && expectedEvents.includes(row.metadata?.doorbellEvent)
      && String(row.metadata?.paneId || '').length > 0
  ));
  recorder.record(
    'DB3',
    allRows.length >= expectedEvents.length
      && expectedEvents.every((eventName) => rowEvents.includes(eventName))
      && receiptRowsOk === true
      && todayAckWait.ok === true
      && todayAckRender.ackVisible === true,
    `receipted rows=${allRows.length} events=${rowEvents.join('/')} todayAckVisible=${todayAckRender.ackVisible === true}`,
    { allRows, expectedEvents, todayReset, todayAckWait, todayAckRender }
  );

  return screenshots;
}

function mirrorScreenshots(screenshots = {}) {
  const mirrorDir = path.join(PROJECT_ROOT, '.squidrun', 'screenshots', 'shell-v2');
  ensureDir(mirrorDir);
  const mirrors = {};
  for (const [name, source] of Object.entries(screenshots)) {
    if (!source || !fs.existsSync(source)) continue;
    const mirror = path.join(mirrorDir, `${name}.png`);
    fs.copyFileSync(source, mirror);
    const sourceSha256 = sha256File(source);
    const mirrorSha256 = sha256File(mirror);
    mirrors[name] = {
      source,
      mirror,
      sourceSha256,
      mirrorSha256,
      byteCopy: Boolean(sourceSha256 && sourceSha256 === mirrorSha256),
    };
  }
  return mirrors;
}

async function runAssertions({ page, sharedPortBefore, sharedPortPath, recorder }) {
  const url = new URL(page.url());
  if (url.searchParams.get('profileName') !== PROFILE) {
    throw new Error(`Refusing to probe non-QA renderer: ${page.url()}`);
  }
  await page.waitForSelector('body.shell-v2-enabled', { timeout: 30000 });
  await clickTab(page, 'squid-room');
  await waitForInitialTicks(page);

  const e1 = await page.evaluate(() => {
    const core = document.getElementById('shellV2CoreStrip');
    const stations = [...(core?.querySelectorAll('.side-panes-container > .pane') || [])]
      .filter((pane) => ['2', '3'].includes(String(pane.dataset?.paneId || '')));
    return {
      expandCount: stations.reduce((sum, pane) => sum + pane.querySelectorAll('.pane-action-btn.expand-btn').length, 0),
      visibleControlCounts: stations.map((pane) => {
        const controls = [...pane.querySelectorAll('.pane-header button, .pane-header [role=button], .pane-header summary')];
        return controls.filter((control) => (
          !control.closest?.('.shell-v2-station-menu-panel, .squid-room-pane-menu-panel')
          && Boolean(control.offsetWidth || control.offsetHeight)
        )).length;
      }),
      stationCount: stations.length,
    };
  });
  recorder.record(
    'E1',
    e1.stationCount === 2 && e1.expandCount === 0 && e1.visibleControlCounts.every((count) => count <= 3),
    `expandCount=${e1.expandCount} visibleControls=${e1.visibleControlCounts.join('/')}`,
    e1
  );

  const e2Tabs = [];
  for (const tabId of ['mira', 'squid-room', 'today']) {
    await clickTab(page, tabId);
    e2Tabs.push(await page.evaluate((activeTab) => {
      const bars = [...document.querySelectorAll('.shell-v2-bottom-bar')];
      const bar = bars[0] || null;
      const style = bar ? getComputedStyle(bar) : null;
      const rect = bar?.getBoundingClientRect?.() || { height: 0 };
      return {
        activeTab,
        barCount: bars.length,
        display: style?.display || '',
        height: rect.height,
        staleShortcut: /Ctrl\+1-4 to focus pane/i.test(bar?.textContent || ''),
      };
    }, tabId));
  }
  let keyOwnerOk = true;
  const keyResults = [];
  for (const [key, expectedTab] of [['1', 'mira'], ['2', 'squid-room'], ['3', 'today']]) {
    await page.keyboard.press(`Control+${key}`);
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        activeTab: document.body?.dataset?.shellV2ActiveTab || '',
        paneFocused: Boolean(active?.closest?.('.pane-terminal, .xterm, .xterm-helper-textarea')),
        activeTag: active?.tagName || '',
        activeId: active?.id || '',
      };
    });
    result.key = key;
    keyResults.push(result);
    if (result.activeTab !== expectedTab || result.paneFocused) keyOwnerOk = false;
  }
  let altPaneOk = true;
  const altPaneResults = [];
  for (const [key, expectedPane, expectedTab] of [['1', '1', 'mira'], ['2', '2', 'squid-room'], ['3', '3', 'squid-room']]) {
    await page.keyboard.press(`Alt+${key}`);
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const active = document.activeElement;
      const focusedPane = document.querySelector('.pane.focused');
      return {
        activeTab: document.body?.dataset?.shellV2ActiveTab || '',
        focusedPaneId: focusedPane?.dataset?.paneId || '',
        activePaneId: active?.closest?.('.pane')?.dataset?.paneId || '',
        activeTag: active?.tagName || '',
        activeId: active?.id || '',
      };
    });
    result.key = key;
    altPaneResults.push(result);
    if (result.activeTab !== expectedTab || result.focusedPaneId !== expectedPane) altPaneOk = false;
  }
  const e2BarsOk = e2Tabs.every((entry) => entry.barCount === 1 && entry.display !== 'none' && entry.height > 0 && !entry.staleShortcut);
  recorder.record('E2', e2BarsOk && keyOwnerOk && altPaneOk, `bars=${e2BarsOk} keyOwner=${keyOwnerOk} altPane=${altPaneOk}`, { e2Tabs, keyResults, altPaneResults });

  await clickTab(page, 'squid-room');
  await page.evaluate(() => {
    window.__shellV2Gate = { tagged: new WeakSet() };
    document.querySelectorAll('.xterm').forEach((element) => window.__shellV2Gate.tagged.add(element));
  });
  const baseline = await waitForTickBaseline(page);
  const started = Date.now();
  await clickTab(page, 'mira');
  await sleep(HIDDEN_WAIT_MS);
  await clickTab(page, 'squid-room');
  await page.waitForTimeout(600);
  const afterHidden = await readTicks(page);
  const elapsed = (Date.now() - started) / 1000;
  const tickContinuity = Object.keys(PANE_TICKS).every((paneId) => {
    const before = baseline[paneId]?.last;
    const after = afterHidden[paneId]?.last;
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    const delta = after - before;
    return delta >= elapsed - 5 && delta <= elapsed + 5 && hasContiguousRun(afterHidden[paneId]);
  });
  recorder.record('C2', tickContinuity, `hidden=${elapsed.toFixed(1)}s`, { baseline, afterHidden });

  for (let i = 0; i < SWITCHES; i += 1) {
    await clickTab(page, 'mira');
    await page.waitForTimeout(120);
    await clickTab(page, 'squid-room');
    await page.waitForTimeout(200);
  }
  const identity = await page.evaluate(() => {
    const elements = [...document.querySelectorAll('.xterm')];
    return {
      count: elements.length,
      survived: elements.map((element) => window.__shellV2Gate.tagged.has(element)),
    };
  });
  recorder.record(
    'C4',
    identity.count === baseline.xtermCount && identity.survived.every(Boolean),
    `xterms=${identity.count} survived=${identity.survived.filter(Boolean).length}`,
    identity
  );

  const post = await readTicks(page);
  const c1 = Object.keys(PANE_TICKS).every((paneId) => {
    const previous = afterHidden[paneId]?.last;
    const current = post[paneId]?.last;
    return Number.isFinite(previous) && Number.isFinite(current) && current >= previous && hasContiguousRun(post[paneId]);
  });
  recorder.record('C1', c1, 'ticks still advancing after switch churn', post);

  const c3 = ['2', '3'].every((paneId) => post[paneId].rect.w > 100 && post[paneId].rect.h > 60);
  recorder.record('C3', c3, `builder=${JSON.stringify(post['2'].rect)} oracle=${JSON.stringify(post['3'].rect)}`, post);

  const c5 = await page.evaluate(() => {
    const readState = () => {
      const core = document.getElementById('shellV2CoreStrip');
      return {
        bodyOn: document.body.dataset.shellV2CoreExpanded === 'true',
        bodyOff: document.body.dataset.shellV2CoreExpanded === 'false',
        classOn: core?.classList?.contains('shell-v2-core-expanded') === true,
        classOff: core?.classList?.contains('shell-v2-core-expanded') === false,
      };
    };
    const dispatchToggle = (expanded) => {
      let event;
      if (typeof CustomEvent === 'function') {
        event = new CustomEvent('shell-v2-toggle-core-expanded', {
          bubbles: true,
          detail: { expanded },
        });
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('shell-v2-toggle-core-expanded', true, false, { expanded });
      }
      document.dispatchEvent(event);
      return readState();
    };
    const controller = window.__squidrunShellV2
      || document.defaultView?.__squidrunShellV2
      || document.body?.__squidrunShellV2Controller;
    if (controller && typeof controller.toggleCoreExpanded === 'function') {
      const on = controller.toggleCoreExpanded(true);
      const onState = readState();
      const off = controller.toggleCoreExpanded(false);
      const offState = readState();
      return {
        ok: on === true && off === false && onState.bodyOn && onState.classOn && offState.bodyOff && offState.classOff,
        method: 'controller',
        on,
        off,
        onState,
        offState,
      };
    }
    const onState = dispatchToggle(true);
    const offState = dispatchToggle(false);
    return {
      ok: onState.bodyOn && onState.classOn && offState.bodyOff && offState.classOff,
      method: 'event',
      onState,
      offState,
    };
  });
  recorder.record('C5', c5.ok === true, c5.ok ? 'container expand toggled' : (c5.reason || 'container expand failed'), c5);

  const e4 = await page.evaluate(() => {
    const builder = document.querySelector('#terminal-2 .xterm') || document.getElementById('terminal-2');
    const oracle = document.querySelector('#terminal-3 .xterm') || document.getElementById('terminal-3');
    const b = builder?.getBoundingClientRect?.() || { y: 0 };
    const o = oracle?.getBoundingClientRect?.() || { y: 9999 };
    return { builderY: Math.round(b.y), oracleY: Math.round(o.y), delta: Math.abs(b.y - o.y) };
  });
  recorder.record('E4', e4.delta < 20, `builder.y=${e4.builderY} oracle.y=${e4.oracleY}`, e4);

  const sharedPortAfter = readFileIfPresent(sharedPortPath);
  recorder.record('E3', buffersEqual(sharedPortBefore, sharedPortAfter), 'shared cdp-port.json byte-compare unchanged', {
    sharedPortPath,
    beforeBytes: sharedPortBefore ? sharedPortBefore.length : 0,
    afterBytes: sharedPortAfter ? sharedPortAfter.length : 0,
  });

  const e5Ok = recorder.checks
    .filter((check) => ['C1', 'C2', 'C3', 'C4', 'C5'].includes(check.id))
    .every((check) => check.ok);
  recorder.record('E5', e5Ok, 'C1-C5 regression criteria');

  await setTrustQuoteArmExpanded(page, false);
  await page.waitForTimeout(250);
  await setTrustQuoteArmExpanded(page, true);
  const armPaint = await waitForTrustQuoteArmPaint(page);
  recorder.record(
    'E6a',
    armPaint.ok === true,
    `paintedRows=${TRUSTQUOTE_ARM_PANE_IDS.map((paneId) => armPaint.paint?.[paneId]?.paintedRows || 0).join('/')}`,
    armPaint.paint
  );

  const leadReport = await readLeadReportLine(page);
  recorder.record(
    'E6b',
    leadReport.found === true
      && leadReport.dataTarget === 'trustquote-lead'
      && leadReport.placeholder !== true,
    `found=${leadReport.found} dataTarget=${leadReport.dataTarget || 'none'} textBytes=${Buffer.byteLength(leadReport.text || '', 'utf8')}`,
    leadReport
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const requestedCdpPort = options.cdpPort;
  if (options.cdpPortExplicit !== true) {
    options.cdpPort = await findAvailableCdpPortPair(options.cdpPort);
  }

  const runId = `shell-v2-gate-${Date.now()}`;
  const dataRoot = path.join(PROJECT_ROOT, '.squidrun', 'tmp', runId);
  ensureDir(dataRoot);
  const gitHead = getGitHead();
  const commitCheck = assertExpectedCommit(options);
  const tickScript = writeTickHarness(dataRoot);
  writeQaSettings(dataRoot, tickScript, { shellV2Enabled: true, devMode: true, autoSpawn: true });
  writeQaProfile(dataRoot);

  const sharedPortPath = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'cdp-port.json');
  const sharedPortBefore = readFileIfPresent(sharedPortPath);
  const qaPortPath = path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'cdp-port.json');
  const verdictPath = path.join(dataRoot, 'shell-v2-gate-verdict.json');
  const recorder = makeRecorder();
  const phase5Manifest = readPhase5Manifest();
  if (requestedCdpPort !== options.cdpPort) {
    recorder.record('CDP', true, `default CDP port ${requestedCdpPort} occupied; using ${options.cdpPort}`, {
      requestedCdpPort,
      cdpPort: options.cdpPort,
      flagOffCdpPort: options.cdpPort + 1,
    });
  }

  let child = null;
  let browser = null;
  let screenshots = {};
  let screenshotMirrors = {};
  let rendererNoise = [];
  try {
    if (options.expectCommit) {
      recorder.record(
        'G0',
        commitCheck.ok === true,
        commitCheck.ok ? `HEAD matches ${commitCheck.head}` : (commitCheck.reason || 'commit check failed'),
        commitCheck
      );
      if (!commitCheck.ok) throw new Error(`expect-commit failed: ${commitCheck.reason || 'unknown'}`);
    }

    const manifestGate = buildPhase5ManifestGateData(phase5Manifest, options);
    recorder.record(
      'D1',
      manifestGate.exactNameset === true,
      `Phase 5 deleted files absent=${manifestGate.exactNameset} commitCarriesDeletes=${manifestGate.commitCarriesPhase5Deletes}`,
      {
        manifestPath: PHASE5_MANIFEST_PATH,
        entries: phase5Manifest.entries.map((entry) => ({
          id: entry.id,
          architectSignoff: entry.architectSignoff,
          preDeleteConsumerGrep: entry.preDeleteConsumerGrep,
          deletedFiles: entry.deletedFiles,
          removedRuntimeSurfaces: entry.removedRuntimeSurfaces,
        })),
        ...manifestGate,
      }
    );

    const jestAccounting = buildPhase5JestAccounting(phase5Manifest, options);
    recorder.record(
      'D4',
      jestAccounting.ok === true,
      `Jest suites ${jestAccounting.before}->${jestAccounting.after}, removed=${jestAccounting.removedSuites.length}, newSkipped=${jestAccounting.skippedHits.length}`,
      jestAccounting
    );

    if (options.expectCommit) {
      const residueHits = scanPhase5Residue(phase5Manifest);
      recorder.record(
        'D5',
        residueHits.length === 0,
        `Phase 5 residue grep hits=${residueHits.length}`,
        { residuePatterns: phase5Manifest.residuePatterns, residueHits }
      );

      const visualScope = buildVisualScopeData(options.expectCommit);
      recorder.record(
        'VP6',
        visualScope.ok === true,
        `visual commit files=${visualScope.files.length} unexpected=${visualScope.unexpected.length}`,
        visualScope
      );
    }

    const doorbellStatic = readDoorbellStaticGateData();
    recorder.record(
      'DB1',
      doorbellStatic.db1Ok === true,
      `doorbell events=${doorbellStatic.events.join('/')} unknownThrow=${doorbellStatic.unknownThrow}`,
      doorbellStatic
    );
    recorder.record(
      'DB2',
      doorbellStatic.db2Ok === true,
      `doorbell forbidden timer hits=${doorbellStatic.timerHits.length}`,
      doorbellStatic
    );
    recorder.record(
      'DB7',
      doorbellStatic.db7Ok === true,
      `doorbell chokepoints=${doorbellStatic.callers.map((entry) => `${entry.source}:${entry.eventName}`).join('/')}`,
      doorbellStatic
    );

    screenshots = {
      ...screenshots,
      ...await runFlagOffProbe({
        dataRoot: path.join(dataRoot, 'flag-off'),
        cdpPort: options.cdpPort + 1,
        recorder,
        runId,
      }),
    };

    try {
      fs.rmSync(qaPortPath, { force: true });
    } catch (_) {}
    child = launchThrowaway({ dataRoot, cdpPort: options.cdpPort, keepOpen: options.keepOpen });
    child.stdout?.on?.('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
    child.stderr?.on?.('data', (chunk) => process.stderr.write(`[electron] ${chunk}`));
    await waitForFile(qaPortPath);
    browser = await connectToThrowaway(options.cdpPort);
    const page = await findRendererPage(browser);
    rendererNoise = bindRendererNoiseCapture(page);
    await runAssertions({ page, sharedPortBefore, sharedPortPath, recorder });
    await runPhase4FlagOnAssertions({ page, recorder, rendererNoise });
    screenshots = {
      ...screenshots,
      ...await capturePhase2Screenshots(page, runId),
      ...await capturePhase3TodayScreenshots(page, runId, recorder, dataRoot),
      ...await runVisualConformanceAssertions({ page, recorder, runId }),
      ...await capturePhase4ReviewScreenshots(page, runId),
      ...await runDoorbellBehaviorAssertions({
        page,
        recorder,
        runId,
        idleSoakMs: resolveDoorbellIdleSoakMs(options),
      }),
    };
    const missingPhase4Screenshots = PHASE4_REVIEW_SCREENSHOTS.filter((name) => !screenshots[name] || !fs.existsSync(screenshots[name]));
    const wrongPhase4Paths = PHASE4_REVIEW_SCREENSHOTS
      .filter((name) => screenshots[name] && !screenshots[name].includes(`${path.sep}shell-v2-phase4${path.sep}`));
    const missingPhase5Screenshots = PHASE5_REVIEW_SCREENSHOTS.filter((name) => !screenshots[name] || !fs.existsSync(screenshots[name]));
    const wrongPhase5Paths = PHASE5_REVIEW_SCREENSHOTS
      .filter((name) => screenshots[name] && !screenshots[name].includes(`${path.sep}shell-v2-phase5${path.sep}`));
    const missingVisualDoorbellScreenshots = VISUAL_DOORBELL_REVIEW_SCREENSHOTS.filter((name) => !screenshots[name] || !fs.existsSync(screenshots[name]));
    const wrongVisualDoorbellPaths = VISUAL_DOORBELL_REVIEW_SCREENSHOTS
      .filter((name) => screenshots[name] && !screenshots[name].includes(`${path.sep}shell-v2-visual-doorbell${path.sep}`));
    recorder.record(
      'V1',
      missingPhase4Screenshots.length === 0
        && wrongPhase4Paths.length === 0
        && missingPhase5Screenshots.length === 0
        && wrongPhase5Paths.length === 0
        && missingVisualDoorbellScreenshots.length === 0
        && wrongVisualDoorbellPaths.length === 0,
      'Phase 4/5/visual-doorbell review screenshots captured under coord paths',
      {
        requiredPhase4: PHASE4_REVIEW_SCREENSHOTS,
        requiredPhase5: PHASE5_REVIEW_SCREENSHOTS,
        requiredVisualDoorbell: VISUAL_DOORBELL_REVIEW_SCREENSHOTS,
        missingPhase4Screenshots,
        wrongPhase4Paths,
        missingPhase5Screenshots,
        wrongPhase5Paths,
        missingVisualDoorbellScreenshots,
        wrongVisualDoorbellPaths,
        screenshots,
      }
    );
    screenshotMirrors = mirrorScreenshots(screenshots);
    const mirrorOk = Object.keys(screenshots).length > 0
      && Object.keys(screenshots).every((name) => screenshotMirrors[name]?.byteCopy === true);
    if (!mirrorOk) {
      recorder.record('GATE', false, 'screenshot mirror byte-copy failed', { screenshots, screenshotMirrors });
    }
  } catch (err) {
    recorder.record('GATE', false, err?.message || String(err));
  } finally {
    const ok = recorder.checks.length > 0 && recorder.checks.every((check) => check.ok);
    const verdict = {
      ok,
      profile: PROFILE,
      gitHead,
      keepOpen: options.keepOpen === true,
      expectCommit: options.expectCommit,
      commitCheck,
      dataRoot,
      qaPortPath,
      sharedPortPath,
      rendererNoise,
      screenshots,
      screenshotMirrors,
      checks: recorder.checks,
      wroteAt: new Date().toISOString(),
    };
    fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2), 'utf8');
    console.log(`VERDICT_JSON ${verdictPath}`);
    if (!options.keepOpen) {
      await closeBrowserFast(browser);
      const daemonPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'daemon.pid'));
      const supervisorPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'supervisor.pid'));
      for (const pid of [child?.pid, daemonPid, supervisorPid]) {
        killPidTree(pid);
      }
      if (child && !child.killed) child.kill();
    } else {
      console.log(`KEEP_OPEN pid=${child?.pid || ''} cdp=http://127.0.0.1:${options.cdpPort}`);
      await disconnectBrowserFast(browser);
    }
    if (!ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
