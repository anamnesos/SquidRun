#!/usr/bin/env node
'use strict';

const {
  ackCodexAttentionRequest,
  completeCodexAttentionRequest,
  createCodexAttentionRequest,
  listCodexAttentionRequests,
  loadCodexAttentionRequest,
} = require('../modules/main/codex-attention-bridge');

function setOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  } else {
    options[key] = value;
  }
}

function parseArgs(argv = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      setOption(options, token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      setOption(options, key, true);
      continue;
    }
    setOption(options, key, next);
    index += 1;
  }
  return { command: positional[0] || 'list', positional: positional.slice(1), options };
}

function getOption(options, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) return options[key];
  }
  return null;
}

function parseJsonOption(value, fallback = null) {
  if (!value || value === true) return fallback;
  try {
    return JSON.parse(String(Array.isArray(value) ? value[value.length - 1] : value));
  } catch (_) {
    return fallback;
  }
}

function commonOptions(options = {}) {
  return {
    bridgeRoot: getOption(options, 'bridge-root', 'root'),
    workItemRoot: getOption(options, 'work-item-root'),
    now: getOption(options, 'now'),
    sessionId: getOption(options, 'session', 'session-id'),
    profileName: getOption(options, 'profile'),
    windowKey: getOption(options, 'window', 'window-key'),
  };
}

function createInput(options = {}) {
  return {
    id: getOption(options, 'id', 'request-id'),
    work_item_id: getOption(options, 'work-item-id', 'work_item_id'),
    requested_by: getOption(options, 'requested-by', 'requested_by', 'by'),
    reason: getOption(options, 'reason'),
    surface: getOption(options, 'surface'),
    url: getOption(options, 'url'),
    route: getOption(options, 'route'),
    window: getOption(options, 'target-window', 'target-window-key'),
    checklist: getOption(options, 'checklist', 'check'),
    proof_role: getOption(options, 'proof-role', 'proof_role'),
    priority: getOption(options, 'priority'),
    correlation_id: getOption(options, 'correlation-id', 'correlation_id'),
    viewport: getOption(options, 'viewport'),
    viewportMatrix: parseJsonOption(getOption(options, 'viewport-matrix-json'), null),
    no_side_effect_caps: getOption(options, 'no-side-effect-cap', 'no-side-effect-caps'),
    requested_artifact_refs: getOption(options, 'requested-artifact', 'requested-artifacts'),
    consoleExpectation: getOption(options, 'console-expectation'),
    devBadgeExpectation: getOption(options, 'dev-badge-expectation'),
    overflowExpectation: getOption(options, 'overflow-expectation'),
    workItemVisualRequest: getOption(options, 'no-work-item-visual-request') === true ? false : undefined,
    now: getOption(options, 'now'),
  };
}

function listInput(options = {}) {
  return {
    all: getOption(options, 'all') === true,
    status: getOption(options, 'status'),
  };
}

function ackInput(options = {}) {
  return {
    id: getOption(options, 'id', 'request-id'),
    acknowledged_by: getOption(options, 'acknowledged-by', 'by'),
    now: getOption(options, 'now'),
  };
}

function completeInput(options = {}) {
  return {
    id: getOption(options, 'id', 'request-id'),
    result: getOption(options, 'result', 'verdict'),
    completed_by: getOption(options, 'completed-by', 'by'),
    proof_ref: getOption(options, 'proof-ref', 'ref'),
    proof_path: getOption(options, 'proof-path', 'path'),
    proof_hash: getOption(options, 'proof-hash', 'hash', 'sha256'),
    summary: getOption(options, 'summary'),
    notes: getOption(options, 'notes'),
    artifact: getOption(options, 'artifact', 'artifacts'),
    hashes: getOption(options, 'hashes'),
    no_side_effects_observed: getOption(options, 'side-effects-observed') === false ? false : undefined,
    attachWorkItemProof: getOption(options, 'no-attach-work-item-proof') === true ? false : undefined,
    now: getOption(options, 'now'),
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function usage() {
  return {
    ok: true,
    usage: [
      'node ui/scripts/hm-codex-attention.js create --requested-by architect --reason <text> (--url <url>|--route <path>|--target-window <key>) [--work-item-id <id>] [--check <text>]',
      'node ui/scripts/hm-codex-attention.js list [--all] [--status requested]',
      'node ui/scripts/hm-codex-attention.js status --id <request-id>',
      'node ui/scripts/hm-codex-attention.js ack --id <request-id> [--by codex]',
      'node ui/scripts/hm-codex-attention.js complete --id <request-id> --result <pass|fail|blocked> [--proof-ref <artifact>] [--proof-path <path>]',
    ],
  };
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const normalized = String(command || '').toLowerCase();
  if (normalized === 'help' || normalized === '--help' || normalized === '-h') {
    printJson(usage());
    return 0;
  }

  let result;
  if (normalized === 'create' || normalized === 'open') {
    result = createCodexAttentionRequest(createInput(options), commonOptions(options));
  } else if (normalized === 'list' || normalized === 'poll') {
    result = listCodexAttentionRequests(listInput(options), commonOptions(options));
  } else if (normalized === 'status' || normalized === 'get') {
    result = loadCodexAttentionRequest(getOption(options, 'id', 'request-id'), commonOptions(options));
  } else if (normalized === 'ack' || normalized === 'acknowledge') {
    result = ackCodexAttentionRequest(ackInput(options), commonOptions(options));
  } else if (normalized === 'complete' || normalized === 'close') {
    result = completeCodexAttentionRequest(completeInput(options), commonOptions(options));
  } else {
    result = { ok: false, reason: 'unknown_command', command: normalized, ...usage() };
  }
  printJson(result);
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    printJson({ ok: false, reason: err.message || String(err) });
    process.exitCode = 1;
  }
}

module.exports = {
  ackInput,
  commonOptions,
  completeInput,
  createInput,
  listInput,
  main,
  parseArgs,
};
