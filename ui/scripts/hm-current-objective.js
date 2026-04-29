#!/usr/bin/env node
'use strict';

/**
 * hm-current-objective — keep the team anchored to the active objective.
 *
 * This is intentionally small: a JSON state file, schema checks for each lane,
 * stale residual detection, and file-first wake entries via hm-inbox-append.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCoordPath } = require('../config');

const REQUIRED_LANE_FIELDS = [
  'currentReality',
  'nextAction',
  'owner',
  'evidencePath',
  'stopCondition',
];

const DEFAULT_STATE_PATH = resolveCoordPath('coord/current-objective-state.json', { forWrite: true });
const DEFAULT_LOG_PATH = resolveCoordPath('coord/current-objective-wake-log.jsonl', { forWrite: true });
const INBOX_APPEND_PATH = path.join(__dirname, 'hm-inbox-append.js');
const DEFAULT_STALE_MINUTES = 30;

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    command: argv[0] || 'status',
    statePath: DEFAULT_STATE_PATH,
    logPath: DEFAULT_LOG_PATH,
    json: false,
    wake: false,
    staleMinutes: DEFAULT_STALE_MINUTES,
    lane: '',
    owner: '',
    currentReality: '',
    nextAction: '',
    evidencePath: '',
    stopCondition: '',
    status: '',
    objective: '',
    summary: '',
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--json') opts.json = true;
    else if (token === '--wake') opts.wake = true;
    else if (token === '--state') opts.statePath = path.resolve(argv[++index]);
    else if (token === '--log') opts.logPath = path.resolve(argv[++index]);
    else if (token === '--stale-minutes') opts.staleMinutes = Number(argv[++index]) || opts.staleMinutes;
    else if (token === '--lane') opts.lane = String(argv[++index] || '').trim();
    else if (token === '--owner') opts.owner = String(argv[++index] || '').trim().toLowerCase();
    else if (token === '--current-reality') opts.currentReality = String(argv[++index] || '').trim();
    else if (token === '--next-action') opts.nextAction = String(argv[++index] || '').trim();
    else if (token === '--evidence-path') opts.evidencePath = String(argv[++index] || '').trim();
    else if (token === '--stop-condition') opts.stopCondition = String(argv[++index] || '').trim();
    else if (token === '--status') opts.status = String(argv[++index] || '').trim().toLowerCase();
    else if (token === '--objective') opts.objective = String(argv[++index] || '').trim();
    else if (token === '--summary') opts.summary = String(argv[++index] || '').trim();
    else if (token === '-h' || token === '--help') opts.help = true;
  }

  return opts;
}

function usage() {
  console.log(`hm-current-objective — active objective + wake-loop guard

Commands:
  init --objective <text> [--summary <text>]
  update-lane --lane <id> --owner <agent> --current-reality <text> --next-action <text> --evidence-path <path> --stop-condition <text> [--status active|closed|blocked]
  status [--json]
  check [--wake] [--stale-minutes 30] [--json]

Lane rule: every active lane needs currentReality, nextAction, owner, evidencePath, stopCondition.`);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function makeInitialState(opts) {
  const now = new Date().toISOString();
  return {
    objective: opts.objective || 'Operate the coordination wake loop so agents continue from residuals without James re-prompting.',
    summary: opts.summary || 'Focus wake-loop/current objective; receivables parked by James.',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    parkedTopics: [
      {
        topic: 'TrustQuote receivables outbound',
        reason: 'James parked customer-facing receivables; long-time clients require his call.',
      },
    ],
    lanes: {},
  };
}

function loadState(filePath) {
  return readJson(filePath, null);
}

function saveState(filePath, state) {
  state.updatedAt = new Date().toISOString();
  writeJson(filePath, state);
}

function requireState(filePath) {
  const state = loadState(filePath);
  if (!state) {
    throw new Error(`current objective state not found at ${filePath}; run init first`);
  }
  if (!state.lanes || typeof state.lanes !== 'object') state.lanes = {};
  return state;
}

function updateLane(opts) {
  if (!opts.lane) throw new Error('--lane is required');
  const state = requireState(opts.statePath);
  const prior = state.lanes[opts.lane] || {};
  const now = new Date().toISOString();
  state.lanes[opts.lane] = {
    ...prior,
    id: opts.lane,
    status: opts.status || prior.status || 'active',
    owner: opts.owner || prior.owner || '',
    currentReality: opts.currentReality || prior.currentReality || '',
    nextAction: opts.nextAction || prior.nextAction || '',
    evidencePath: opts.evidencePath || prior.evidencePath || '',
    stopCondition: opts.stopCondition || prior.stopCondition || '',
    updatedAt: now,
  };
  saveState(opts.statePath, state);
  return { ok: true, statePath: opts.statePath, lane: state.lanes[opts.lane] };
}

function missingFields(lane) {
  return REQUIRED_LANE_FIELDS.filter((field) => !String(lane[field] || '').trim());
}

function minutesSince(value, nowMs = Date.now()) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return Infinity;
  return Math.max(0, (nowMs - parsed) / 60000);
}

function checkState(state, opts) {
  const staleMinutes = Math.max(1, Number(opts.staleMinutes) || DEFAULT_STALE_MINUTES);
  const findings = [];
  const lanes = Object.values(state.lanes || {});

  if (!state.objective || !String(state.objective).trim()) {
    findings.push({
      severity: 'high',
      type: 'missing_objective',
      owner: 'architect',
      summary: 'Current objective is missing.',
      evidencePath: opts.statePath,
    });
  }

  for (const lane of lanes) {
    const status = String(lane.status || 'active').toLowerCase();
    if (status === 'closed') continue;
    const missing = missingFields(lane);
    if (missing.length > 0) {
      findings.push({
        severity: 'high',
        type: 'lane_missing_required_fields',
        lane: lane.id || 'unknown',
        owner: lane.owner || 'architect',
        missing,
        summary: `Lane ${lane.id || 'unknown'} is missing: ${missing.join(', ')}`,
        evidencePath: opts.statePath,
      });
      continue;
    }
    const ageMinutes = minutesSince(lane.updatedAt);
    if (status === 'active' && ageMinutes > staleMinutes) {
      findings.push({
        severity: 'normal',
        type: 'lane_stale',
        lane: lane.id,
        owner: lane.owner,
        ageMinutes: Math.round(ageMinutes * 10) / 10,
        summary: `Lane ${lane.id} has not moved for ${Math.round(ageMinutes)}m; continue, close with evidence, or name blocker.`,
        evidencePath: lane.evidencePath || opts.statePath,
      });
    }
    if (status === 'blocked') {
      findings.push({
        severity: 'normal',
        type: 'lane_blocked',
        lane: lane.id,
        owner: lane.owner,
        summary: `Lane ${lane.id} is blocked; responsible owner should name next external decision or unblock path.`,
        evidencePath: lane.evidencePath || opts.statePath,
      });
    }
  }

  return {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    statePath: opts.statePath,
    objective: state.objective,
    laneCount: lanes.length,
    findings,
  };
}

function appendWake(result, opts) {
  const woken = [];
  for (const finding of result.findings) {
    const owner = String(finding.owner || '').trim().toLowerCase();
    if (!owner || owner === 'codex') continue;
    const args = [
      INBOX_APPEND_PATH,
      owner,
      '--from',
      'builder',
      '--kind',
      'wake',
      '--priority',
      finding.severity === 'high' ? 'urgent' : 'normal',
      '--path',
      finding.evidencePath || opts.statePath,
      '--summary',
      finding.summary,
    ];
    const child = spawnSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });
    const ok = child.status === 0;
    woken.push({ owner, ok, summary: finding.summary, stderr: child.stderr || '' });
    appendJsonLine(opts.logPath, {
      ts: new Date().toISOString(),
      finding,
      owner,
      ok,
      stdout: child.stdout || '',
      stderr: child.stderr || '',
    });
  }
  return woken;
}

function renderStatus(state) {
  const lines = [
    `Objective: ${state.objective || '(missing)'}`,
    `Status: ${state.status || 'unknown'}`,
    `Summary: ${state.summary || ''}`,
    '',
    'Lanes:',
  ];
  const lanes = Object.values(state.lanes || {});
  if (lanes.length === 0) lines.push('  (none)');
  for (const lane of lanes) {
    lines.push(`  ${lane.id}: ${lane.status || 'active'} owner=${lane.owner || '?'} updated=${lane.updatedAt || '-'}`);
    lines.push(`    reality: ${lane.currentReality || ''}`);
    lines.push(`    next: ${lane.nextAction || ''}`);
    lines.push(`    evidence: ${lane.evidencePath || ''}`);
    lines.push(`    stop: ${lane.stopCondition || ''}`);
  }
  return lines.join('\n');
}

function renderCheck(result) {
  if (result.ok) {
    return `current objective OK (${result.laneCount} lane${result.laneCount === 1 ? '' : 's'})`;
  }
  return result.findings
    .map((finding) => `${finding.severity.toUpperCase()} ${finding.type}: ${finding.summary}`)
    .join('\n');
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return { ok: true };
  }

  if (opts.command === 'init') {
    const state = makeInitialState(opts);
    saveState(opts.statePath, state);
    if (opts.json) console.log(JSON.stringify({ ok: true, state }, null, 2));
    else console.log(`initialized ${opts.statePath}`);
    return { ok: true, state };
  }

  if (opts.command === 'update-lane') {
    const result = updateLane(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`updated lane ${result.lane.id}`);
    return result;
  }

  const state = requireState(opts.statePath);
  if (opts.command === 'status') {
    if (opts.json) console.log(JSON.stringify({ ok: true, state }, null, 2));
    else console.log(renderStatus(state));
    return { ok: true, state };
  }

  if (opts.command === 'check') {
    const result = checkState(state, opts);
    if (opts.wake && !result.ok) {
      result.woken = appendWake(result, opts);
    }
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderCheck(result));
    return result;
  }

  throw new Error(`unknown command: ${opts.command}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`hm-current-objective error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_LANE_FIELDS,
  DEFAULT_STATE_PATH,
  parseArgs,
  makeInitialState,
  updateLane,
  checkState,
  missingFields,
  main,
};
