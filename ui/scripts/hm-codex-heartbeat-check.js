#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getProjectRoot } = require('../config');

const DEFAULT_INSTANCE_ID = 'james-main';
const DEFAULT_CODEX_HEARTBEAT_STALE_MINUTES = 10;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    instance: DEFAULT_INSTANCE_ID,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--instance' && argv[index + 1]) {
      args.instance = String(argv[index + 1]).trim() || DEFAULT_INSTANCE_ID;
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

function findInstance(registry = {}, instanceId = DEFAULT_INSTANCE_ID) {
  const entries = Array.isArray(registry?.instances) ? registry.instances : [];
  return entries.find((entry) => String(entry?.id || '') === instanceId) || null;
}

function resolveProjectPath(projectRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function loadInstanceConfig(projectRoot, instanceId = DEFAULT_INSTANCE_ID) {
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
    codexHeartbeatPath: resolveProjectPath(projectRoot, merged.codexHeartbeatPath),
    staleMinutes: Number(merged.notifyPolicy?.codexHeartbeatStaleMinutes)
      || DEFAULT_CODEX_HEARTBEAT_STALE_MINUTES,
    registryPaths: {
      live: livePath,
      template: templatePath,
    },
  };
}

function evaluateHeartbeat(projectRoot, instanceId = DEFAULT_INSTANCE_ID, nowMs = Date.now()) {
  const config = loadInstanceConfig(projectRoot, instanceId);
  const heartbeatPath = config.codexHeartbeatPath;
  const thresholdMs = config.staleMinutes * 60 * 1000;
  const heartbeat = heartbeatPath ? readJson(heartbeatPath, null) : null;
  const ts = heartbeat?.ts
    || heartbeat?.timestampUtc
    || heartbeat?.updatedAt
    || heartbeat?.checkedAt
    || heartbeat?.lastTick?.currentTimeIso
    || null;
  const tsMs = Date.parse(String(ts || ''));
  const ageMinutes = Number.isFinite(tsMs)
    ? Number(((nowMs - tsMs) / 60_000).toFixed(2))
    : null;
  const fresh = Boolean(
    heartbeat
    && Number.isFinite(tsMs)
    && (nowMs - tsMs) <= thresholdMs
  );
  let reason = 'fresh';
  if (!heartbeat) reason = 'missing_heartbeat';
  else if (!Number.isFinite(tsMs)) reason = 'invalid_timestamp';
  else if (!fresh) reason = 'stale_heartbeat';
  return {
    ok: fresh,
    reason,
    instance: instanceId,
    heartbeatPath,
    staleMinutes: config.staleMinutes,
    ageMinutes,
    ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : ts,
    heartbeat,
  };
}

function runNodeScript(scriptPath, args = [], options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 30_000,
  });
}

function notifyStaleHeartbeat(projectRoot, result, options = {}) {
  const runScript = options.runNodeScript || runNodeScript;
  const details = {
    instance: result.instance,
    ageMinutes: result.ageMinutes,
    thresholdMinutes: result.staleMinutes,
    heartbeatPath: result.heartbeatPath,
    reason: result.reason,
    ts: result.ts || null,
  };
  const anomalyPath = path.join(projectRoot, 'ui', 'scripts', 'hm-anomaly.js');
  const hmSendPath = path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  const message = `Codex heartbeat stale for ${result.instance}: ${result.reason}, age=${result.ageMinutes ?? 'unknown'}m, threshold=${result.staleMinutes}m.`;
  runScript(anomalyPath, [
    'type=codex_heartbeat_stale',
    'src=architect',
    'sev=high',
    `details=${JSON.stringify(details)}`,
    '--json',
  ], { cwd: projectRoot });
  runScript(hmSendPath, ['telegram', message], { cwd: projectRoot, timeoutMs: 45_000 });
}

function runCheck(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const instanceId = options.instance || DEFAULT_INSTANCE_ID;
  const result = evaluateHeartbeat(projectRoot, instanceId, options.nowMs || Date.now());
  if (!result.ok) {
    notifyStaleHeartbeat(projectRoot, result, options);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runCheck(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_INSTANCE_ID,
  parseArgs,
  readJson,
  loadInstanceConfig,
  evaluateHeartbeat,
  notifyStaleHeartbeat,
  runCheck,
  main,
};
