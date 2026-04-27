#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { getProjectRoot, resolveCoordPath } = require('../config');

const VALID_REASONS = new Set([
  'code_change_requires_reload',
  'bus_failures',
  'startup_context_corrupt',
  'supervisor_recovery',
  'james_request',
  'manual_test',
]);
const MAX_CACHED_HL_AGE_MS = 5 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    reason: 'manual_test',
    reasonDetails: '',
    approvalMode: null,
    priority: [],
    openWork: [],
    anticipatedQuestion: [],
    json: false,
    send: true,
    captureHl: true,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--no-send') {
      args.send = false;
      continue;
    }
    if (token === '--skip-hl') {
      args.captureHl = false;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      args.send = false;
      continue;
    }
    if (token === '--reason' && argv[index + 1]) {
      args.reason = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if ((token === '--details' || token === '--reason-details') && argv[index + 1]) {
      args.reasonDetails = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--approval-mode' && argv[index + 1]) {
      args.approvalMode = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--priority' && argv[index + 1]) {
      args.priority.push(String(argv[index + 1]));
      index += 1;
      continue;
    }
    if (token === '--open-work' && argv[index + 1]) {
      args.openWork.push(String(argv[index + 1]));
      index += 1;
      continue;
    }
    if (token === '--qa' && argv[index + 1]) {
      args.anticipatedQuestion.push(parseQuestionAnswer(String(argv[index + 1])));
      index += 1;
    }
  }

  if (!VALID_REASONS.has(args.reason)) {
    throw new Error(`Invalid reason "${args.reason}". Valid: ${Array.from(VALID_REASONS).join(', ')}`);
  }

  return args;
}

function parseQuestionAnswer(value) {
  const split = value.indexOf('=>');
  if (split === -1) return { q: value, a: '' };
  return {
    q: value.slice(0, split).trim(),
    a: value.slice(split + 2).trim(),
  };
}

function runGit(projectRoot, args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch (_) {
    return fallback;
  }
}

function getGitSnapshot(projectRoot) {
  const porcelain = runGit(projectRoot, ['status', '--porcelain'], '');
  return {
    headCommit: runGit(projectRoot, ['rev-parse', 'HEAD'], null),
    branch: runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], null),
    dirtyTree: Boolean(porcelain.trim()),
    uncommittedFiles: porcelain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readSessionId() {
  const status = readJson(resolveCoordPath('app-status.json'), {});
  const session = Number(status?.session);
  return Number.isInteger(session) ? session : null;
}

function md5File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('md5');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function getMemoryChecksums(projectRoot) {
  const candidates = [
    'CLAUDE.md',
    'ROLES.md',
    path.join('.squidrun', 'handoffs', 'session.md'),
    path.join('.squidrun', 'handoffs', 'ai-briefing.md'),
    path.join('.squidrun', 'memory', 'pending-pr.json'),
  ];
  const checksums = {};
  for (const relPath of candidates) {
    const absolutePath = path.join(projectRoot, relPath);
    const checksum = md5File(absolutePath);
    if (checksum) checksums[relPath.replace(/\\/g, '/')] = checksum;
  }
  return checksums;
}

function capture[private-live-ops]Snapshot(projectRoot, enabled = true) {
  if (!enabled) {
    return {
      ok: false,
      skipped: true,
      checkedAt: new Date().toISOString(),
      positions: [],
      error: 'Skipped by --skip-hl.',
    };
  }

  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'hm-defi-status.js');
  const result = spawnSync(process.execPath, [scriptPath, '--json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      SQUIDRUN_LIVE_OPS_CALLER: 'restart-request',
    },
    encoding: 'utf8',
    timeout: 45_000,
  });

  if (result.status !== 0 && !result.stdout) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      positions: [],
      error: String(result.stderr || result.error?.message || 'hm-defi-status failed').trim(),
    };
  }

  const parsed = readJsonFromString(result.stdout);
  if (parsed?.ok) {
    return parsed;
  }

  const cached = readCached[private-live-ops]Snapshot(projectRoot);
  if (cached) {
    return {
      ...cached,
      ok: cached.ageMs <= MAX_CACHED_HL_AGE_MS,
      fallbackReason: parsed?.error || String(result.stderr || result.error?.message || 'hm-defi-status failed').trim(),
    };
  }

  if (!parsed) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      positions: [],
      error: 'hm-defi-status returned invalid JSON',
      raw: result.stdout,
    };
  }
  return parsed;
}

function readJsonFromString(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch (_) {
    return null;
  }
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readCached[private-live-ops]Snapshot(projectRoot) {
  const statePath = path.join(projectRoot, '.squidrun', 'runtime', 'crypto-trading-supervisor-state.json');
  const state = readJson(statePath, null);
  const account = state?.lastResult?.preMarket?.accountSnapshot;
  if (!account) return null;
  const raw = account.raw || {};
  const checkedAt = state.lastProcessedAt || new Date(toNumber(raw?.mainState?.time, Date.now())).toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  const positions = Array.isArray(raw?.mainState?.assetPositions) ? raw.mainState.assetPositions : [];
  return {
    ok: false,
    cached: true,
    checkedAt,
    ageMs: Number.isFinite(checkedAtMs) ? Date.now() - checkedAtMs : null,
    accountValue: toNumber(account.equity, toNumber(raw?.marginSummary?.accountValue, null)),
    withdrawable: toNumber(account.cash, toNumber(raw?.withdrawable, null)),
    positions,
    sourcePath: statePath,
    error: null,
  };
}

function inferApprovalMode(reason, hlSnapshot, explicitMode = null) {
  if (explicitMode) return explicitMode;
  const positions = Array.isArray(hlSnapshot?.positions) ? hlSnapshot.positions : [];
  const unclear = !hlSnapshot?.ok || hlSnapshot?.skipped || Boolean(hlSnapshot?.error);
  if (unclear || positions.length > 0 || reason === 'supervisor_recovery') {
    return 'trading_approval_required';
  }
  return 'non_trading_lower_friction';
}

function buildRequest(projectRoot, args) {
  const sourceSessionId = readSessionId();
  const openedAt = new Date().toISOString();
  const safeStamp = openedAt.replace(/[:.]/g, '-');
  const hlSnapshot = capture[private-live-ops]Snapshot(projectRoot, args.captureHl);
  const requestId = `restart-${sourceSessionId || 'unknown'}-${safeStamp}`;

  return {
    schemaVersion: 1,
    requestId,
    openedAt,
    sourceAgent: 'architect',
    sourceSessionId,
    reason: args.reason,
    reasonDetails: args.reasonDetails,
    git: getGitSnapshot(projectRoot),
    hlSnapshot: {
      checkedAt: hlSnapshot.checkedAt || openedAt,
      ok: Boolean(hlSnapshot.ok),
      skipped: Boolean(hlSnapshot.skipped),
      cached: Boolean(hlSnapshot.cached),
      ageMs: Number.isFinite(Number(hlSnapshot.ageMs)) ? Number(hlSnapshot.ageMs) : null,
      accountValue: Number.isFinite(Number(hlSnapshot.accountValue)) ? Number(hlSnapshot.accountValue) : null,
      withdrawable: Number.isFinite(Number(hlSnapshot.withdrawable)) ? Number(hlSnapshot.withdrawable) : null,
      positions: Array.isArray(hlSnapshot.positions) ? hlSnapshot.positions : [],
      error: hlSnapshot.error || null,
      fallbackReason: hlSnapshot.fallbackReason || null,
    },
    memoryChecksums: getMemoryChecksums(projectRoot),
    topPriorities: args.priority.slice(0, 3),
    openWork: args.openWork.map((title) => ({ title, owner: 'architect', status: 'open' })),
    anticipatedQuestions: args.anticipatedQuestion,
    approvalMode: inferApprovalMode(args.reason, hlSnapshot, args.approvalMode),
  };
}

function writeHandoff(projectRoot, request, handoffPath) {
  const lines = [
    `# Restart Handoff ${request.requestId}`,
    '',
    `- openedAt: ${request.openedAt}`,
    `- sourceSessionId: ${request.sourceSessionId ?? 'unknown'}`,
    `- reason: ${request.reason}`,
    `- approvalMode: ${request.approvalMode}`,
    `- branch: ${request.git.branch || 'unknown'}`,
    `- headCommit: ${request.git.headCommit || 'unknown'}`,
    `- dirtyTree: ${request.git.dirtyTree ? 'yes' : 'no'}`,
    `- hlSnapshot.ok: ${request.hlSnapshot.ok ? 'yes' : 'no'}`,
    `- hlPositionCount: ${request.hlSnapshot.positions.length}`,
    '',
    '## Narrative',
    '',
    request.reasonDetails || '(Architect should fill this section with restart-specific context before execution.)',
    '',
    '## Top Priorities',
    '',
    ...(request.topPriorities.length ? request.topPriorities.map((item) => `- ${item}`) : ['- (none captured)']),
    '',
    '## Open Work',
    '',
    ...(request.openWork.length ? request.openWork.map((item) => `- ${item.title} [${item.owner}/${item.status}]`) : ['- (none captured)']),
    '',
    '## Anticipated Questions',
    '',
    ...(request.anticipatedQuestions.length
      ? request.anticipatedQuestions.map((item) => `- Q: ${item.q}\n  A: ${item.a}`)
      : ['- (none captured)']),
    '',
    '## Clearance Notes',
    '',
    '- New Architect must run `node ui/scripts/hm-restart-verify.js` after restart.',
    '- Codex grades drift results before restart incident closes.',
    '',
  ];
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, `${lines.join('\n')}\n`, 'utf8');
}

function sendArchitectSignal(projectRoot, requestPath) {
  const hmSendPath = path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  const relPath = path.relative(projectRoot, requestPath);
  const message = `(ARCH RESTART REQ): see ${relPath}`;
  try {
    execFileSync(process.execPath, [hmSendPath, 'architect', message, '--role', 'architect', '--timeout', '10000'], {
      cwd: projectRoot,
      env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectRoot = getProjectRoot();
  const request = buildRequest(projectRoot, args);
  const requestPath = resolveCoordPath('coord/restart-request.json', { forWrite: true });
  const handoffPath = resolveCoordPath('coord/restart-handoff.md', { forWrite: true });

  if (!args.dryRun) {
    fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    writeHandoff(projectRoot, request, handoffPath);
  }

  let signal = null;
  if (args.send) {
    signal = sendArchitectSignal(projectRoot, requestPath);
  }

  const result = { ok: true, dryRun: args.dryRun, requestPath, handoffPath, requestId: request.requestId, approvalMode: request.approvalMode, signal };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Restart request captured: ${request.requestId}`);
    console.log(`  request: ${requestPath}`);
    console.log(`  handoff: ${handoffPath}`);
    console.log(`  approvalMode: ${request.approvalMode}`);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error:', error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  getGitSnapshot,
  capture[private-live-ops]Snapshot,
  inferApprovalMode,
  buildRequest,
  main,
};
