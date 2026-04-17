#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_AGENT_TARGETS = Object.freeze(['architect', 'oracle']);
const DEFAULT_ALERT_TIMEOUT_MS = 15_000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeTargets(value = DEFAULT_AGENT_TARGETS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(
    raw
      .map((entry) => toText(entry).toLowerCase())
      .filter((entry) => ['architect', 'builder', 'oracle'].includes(entry))
  ));
}

function sendAgentAlert(message, options = {}) {
  const text = toText(message);
  if (!text) {
    return { ok: false, error: 'message_empty', targets: [], results: [] };
  }

  const targets = normalizeTargets(options.targets || DEFAULT_AGENT_TARGETS);
  if (targets.length === 0) {
    return { ok: false, error: 'no_valid_targets', targets: [], results: [] };
  }

  const hmSendScriptPath = path.resolve(
    toText(options.hmSendScriptPath, path.join(__dirname, 'hm-send.js'))
  );
  const cwd = path.resolve(
    toText(options.cwd, process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'))
  );
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_ALERT_TIMEOUT_MS);
  const role = toText(options.role, '');
  const results = [];

  for (const target of targets) {
    const args = [hmSendScriptPath, target, text];
    if (role) {
      args.push('--role', role);
    }
    try {
      const stdout = execFileSync(process.execPath, args, {
        cwd,
        env: options.env || process.env,
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.push({ target, ok: true, stdout: toText(stdout, null) });
    } catch (error) {
      const stderr = toText(error?.stderr, '');
      results.push({
        target,
        ok: false,
        error: stderr || toText(error?.message, 'hm_send_failed'),
      });
    }
  }

  return {
    ok: results.every((entry) => entry.ok === true),
    targets,
    results,
  };
}

module.exports = {
  DEFAULT_AGENT_TARGETS,
  normalizeTargets,
  sendAgentAlert,
};
