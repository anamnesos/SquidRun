#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const { getProjectRoot } = require('../config');

const WITNESSES = Object.freeze(['builder', 'oracle']);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    instance: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--instance' && argv[index + 1]) {
      args.instance = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--timeout-ms' && argv[index + 1]) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) args.timeoutMs = parsed;
      index += 1;
    }
  }
  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function findInstance(registry = {}, instanceId = '') {
  const entries = Array.isArray(registry?.instances) ? registry.instances : [];
  return entries.find((entry) => String(entry?.id || '') === instanceId) || null;
}

function resolveProjectPath(projectRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function loadInstanceConfig(projectRoot, instanceId) {
  const livePath = path.join(projectRoot, '.squidrun', 'operator-registry.json');
  const templatePath = path.join(projectRoot, '.squidrun', 'operator-registry.template.json');
  const live = readJson(livePath, {});
  const template = readJson(templatePath, {});
  const templateInstance = findInstance(template, instanceId) || {};
  const liveInstance = findInstance(live, instanceId) || {};
  const merged = {
    ...templateInstance,
    ...liveInstance,
    notifyPolicy: {
      ...(templateInstance.notifyPolicy || {}),
      ...(liveInstance.notifyPolicy || {}),
    },
  };
  if (!merged.id) {
    throw new Error(`Operator registry instance not found: ${instanceId}`);
  }
  return {
    instance: merged,
    codexInboxPath: resolveProjectPath(projectRoot, merged.codexInbox),
    architectInboxPath: resolveProjectPath(projectRoot, merged.architectInbox),
    coordPath: resolveProjectPath(projectRoot, merged.coordPath || path.dirname(merged.codexInbox || '')),
  };
}

function createAuditId(nowMs = Date.now()) {
  return `align-${Math.floor(nowMs / 1000)}-${crypto.randomBytes(3).toString('hex')}`;
}

function runGit(projectRoot, args, fallback = null) {
  try {
    const output = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return String(output || '').trim();
  } catch {
    return fallback;
  }
}

function countAnomalies(projectRoot, coordPath) {
  const anomaliesPath = path.join(coordPath || path.join(projectRoot, '.squidrun', 'coord'), 'anomalies.jsonl');
  try {
    return fs.readFileSync(anomaliesPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .length;
  } catch {
    return 0;
  }
}

function buildArchitectEntry(projectRoot, instanceConfig, options = {}) {
  const status = runGit(projectRoot, ['status', '--porcelain'], '');
  const dirtyLines = status.split(/\r?\n/).filter((line) => line.trim());
  return {
    identity: 'architect',
    currentOwner: 'architect',
    openTask: options.openTask || 'operator_hub_alignment_audit',
    anomaliesSinceLast: countAnomalies(projectRoot, instanceConfig.coordPath),
    restartRequested: false,
    driftSelfReport: dirtyLines.length > 0 ? 'minor' : 'none',
    git: {
      head: runGit(projectRoot, ['rev-parse', 'HEAD'], null),
      branch: runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], null),
      dirtyTree: dirtyLines.length > 0,
      dirtyCount: dirtyLines.length,
    },
    topPriority: options.topPriority || null,
  };
}

function normalizeWitnessEntry(identity, value = null) {
  if (!value || typeof value !== 'object') {
    return {
      identity: 'absent',
      witness: identity,
      currentOwner: null,
      openTask: null,
      anomaliesSinceLast: 0,
      restartRequested: false,
      driftSelfReport: 'notable',
    };
  }
  const normalizedIdentity = String(value.identity || identity).trim().toLowerCase();
  const drift = String(value.driftSelfReport || 'none').trim().toLowerCase();
  return {
    identity: ['builder', 'oracle'].includes(normalizedIdentity) ? normalizedIdentity : identity,
    currentOwner: String(value.currentOwner || '').trim(),
    openTask: String(value.openTask || '').trim(),
    anomaliesSinceLast: Math.max(0, Number.parseInt(value.anomaliesSinceLast || 0, 10) || 0),
    restartRequested: value.restartRequested === true,
    driftSelfReport: ['none', 'minor', 'notable'].includes(drift) ? drift : 'notable',
  };
}

function sendHmMessage(projectRoot, target, message) {
  const hmSendPath = path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  return spawnSync(process.execPath, [hmSendPath, target, message], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function buildAlignmentQueryMessage(auditId, witness, replyPath) {
  const escapedPath = replyPath.replace(/\\/g, '\\\\');
  return [
    `(ARCH ALIGNMENT_QUERY ${auditId}): Write your self-check JSON to ${replyPath}.`,
    'Schema: {"identity":"builder|oracle","currentOwner":"...","openTask":"...","anomaliesSinceLast":0,"restartRequested":false,"driftSelfReport":"none|minor|notable"}.',
    `PowerShell one-liner: @'{"identity":"${witness}","currentOwner":"${witness}","openTask":"standing_by","anomaliesSinceLast":0,"restartRequested":false,"driftSelfReport":"none"}'@ | Set-Content -LiteralPath "${escapedPath}" -Encoding UTF8`,
  ].join(' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForReplies(replyPaths, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const pollMs = Math.max(25, Number(options.pollMs || 1000));
  const sleepFn = options.sleep || sleep;
  const deadline = Date.now() + timeoutMs;
  const replies = {};
  while (Date.now() <= deadline) {
    for (const [identity, replyPath] of Object.entries(replyPaths)) {
      if (replies[identity]) continue;
      const parsed = readJson(replyPath, null);
      if (parsed) replies[identity] = normalizeWitnessEntry(identity, parsed);
    }
    if (Object.keys(replies).length === Object.keys(replyPaths).length) break;
    if (timeoutMs === 0) break;
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  for (const identity of Object.keys(replyPaths)) {
    if (!replies[identity]) replies[identity] = normalizeWitnessEntry(identity, null);
  }
  return replies;
}

function buildEnvelope(type, from, to, fields = {}, now = new Date()) {
  const prefix = type.split('_')[0] || 'msg';
  return {
    id: `${prefix}-arch-${Math.floor(now.getTime() / 1000)}-${crypto.randomBytes(2).toString('hex')}`,
    createdAt: now.toISOString(),
    type,
    from,
    to,
    priority: 'normal',
    ...fields,
  };
}

async function runAlignmentAudit(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const instanceId = String(options.instance || '').trim();
  if (!instanceId) {
    throw new Error('Missing required --instance <id>');
  }
  const timeoutMs = Math.max(0, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const instanceConfig = loadInstanceConfig(projectRoot, instanceId);
  const auditId = options.auditId || createAuditId(options.nowMs || Date.now());
  const replyDir = path.join(instanceConfig.coordPath, 'alignment-replies');
  fs.mkdirSync(replyDir, { recursive: true });
  const markerPath = path.join(replyDir, `${auditId}.marker.json`);
  fs.writeFileSync(markerPath, `${JSON.stringify({
    auditId,
    instance: instanceId,
    createdAt: new Date(options.nowMs || Date.now()).toISOString(),
    witnesses: WITNESSES,
  }, null, 2)}\n`, 'utf8');
  const replyPaths = Object.fromEntries(
    WITNESSES.map((witness) => [witness, path.join(replyDir, `${auditId}-${witness}.json`)])
  );
  const sendMessage = options.sendHmMessage || sendHmMessage;
  for (const witness of WITNESSES) {
    sendMessage(projectRoot, witness, buildAlignmentQueryMessage(auditId, witness, replyPaths[witness]));
  }
  const architectEntry = buildArchitectEntry(projectRoot, instanceConfig, options);
  const replies = await waitForReplies(replyPaths, {
    timeoutMs,
    pollMs: options.pollMs,
    sleep: options.sleep,
  });
  const entries = [
    architectEntry,
    replies.builder,
    replies.oracle,
  ];
  const envelope = buildEnvelope('alignment_report', 'architect', 'codex', {
    instance: instanceId,
    auditId,
    timeoutMs,
    replyDir,
    architectInboxPath: instanceConfig.architectInboxPath,
    entries,
  }, new Date(options.nowMs || Date.now()));
  appendJsonLine(instanceConfig.codexInboxPath, envelope);
  return {
    ok: true,
    instance: instanceId,
    auditId,
    replyDir,
    codexInboxPath: instanceConfig.codexInboxPath,
    entries,
    envelope,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runAlignmentAudit(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  WITNESSES,
  parseArgs,
  readJson,
  loadInstanceConfig,
  buildArchitectEntry,
  normalizeWitnessEntry,
  buildAlignmentQueryMessage,
  waitForReplies,
  runAlignmentAudit,
  main,
};
