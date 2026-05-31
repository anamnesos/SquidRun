#!/usr/bin/env node
'use strict';

const {
  attachProof,
  closeWorkItem,
  openWorkItem,
  requestCodexVisual,
  statusWorkItems,
} = require('../modules/main/work-item-ledger');

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
  return { command: positional[0] || 'status', positional: positional.slice(1), options };
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
    workItemRoot: getOption(options, 'work-item-root', 'root'),
    now: getOption(options, 'now'),
    sessionId: getOption(options, 'session', 'session-id'),
    profileName: getOption(options, 'profile'),
    windowKey: getOption(options, 'window', 'window-key'),
    projectPath: getOption(options, 'project-path'),
    projectName: getOption(options, 'project-name'),
    queuePath: getOption(options, 'queue-path', 'agent-task-queue-path'),
    currentLanePath: getOption(options, 'current-lane-path'),
  };
}

function openInput(options = {}) {
  return {
    id: getOption(options, 'id'),
    session: getOption(options, 'session', 'session-id'),
    profile: getOption(options, 'profile'),
    projectName: getOption(options, 'project-name'),
    projectPath: getOption(options, 'project-path'),
    window: getOption(options, 'window', 'window-key'),
    sourceMessageIds: getOption(options, 'source-message-id', 'source-message-ids'),
    objective: getOption(options, 'objective'),
    ownerRoles: getOption(options, 'owner-role', 'owner-roles'),
    scopeIn: getOption(options, 'scope-in'),
    scopeOut: getOption(options, 'scope-out'),
    sideEffectCaps: getOption(options, 'side-effect-cap', 'side-effect-caps'),
    riskClass: getOption(options, 'risk-class'),
    prodGateProfile: getOption(options, 'prod-gate-profile'),
    routeHealthRequirement: parseJsonOption(getOption(options, 'route-health-json'), null)
      || getOption(options, 'require-route-health'),
    requiredProof: getOption(options, 'required-proof', 'required-proofs'),
    state: getOption(options, 'state'),
    now: getOption(options, 'now'),
  };
}

function attachProofInput(options = {}) {
  return {
    id: getOption(options, 'id', 'work-item-id'),
    role: getOption(options, 'role', 'proof-role'),
    ref: getOption(options, 'ref', 'artifact-ref'),
    path: getOption(options, 'path', 'artifact-path'),
    hash: getOption(options, 'hash', 'sha256'),
    kind: getOption(options, 'kind'),
    summary: getOption(options, 'summary'),
    visualRequestId: getOption(options, 'visual-request-id', 'request-id'),
    responseRef: getOption(options, 'response-ref', 'response-artifact-ref'),
    responsePath: getOption(options, 'response-path', 'response-artifact-path'),
    responseHash: getOption(options, 'response-hash', 'response-sha256'),
    responseSummary: getOption(options, 'response-summary'),
    metadata: parseJsonOption(getOption(options, 'metadata-json'), {}),
    now: getOption(options, 'now'),
  };
}

function visualRequestInput(options = {}) {
  return {
    id: getOption(options, 'id', 'work-item-id'),
    requestId: getOption(options, 'request-id'),
    route: getOption(options, 'route'),
    url: getOption(options, 'url'),
    viewport: getOption(options, 'viewport'),
    viewportMatrix: parseJsonOption(getOption(options, 'viewport-matrix-json'), null),
    invariants: getOption(options, 'invariant', 'invariants'),
    consoleExpectation: getOption(options, 'console-expectation'),
    devBadgeExpectation: getOption(options, 'dev-badge-expectation'),
    overflowExpectation: getOption(options, 'overflow-expectation'),
    noSideEffectCaps: getOption(options, 'no-side-effect-cap', 'no-side-effect-caps'),
    requestedArtifactRefs: getOption(options, 'requested-artifact', 'requested-artifacts'),
    now: getOption(options, 'now'),
  };
}

function closeInput(options = {}) {
  return {
    id: getOption(options, 'id', 'work-item-id'),
    verdict: getOption(options, 'verdict'),
    state: getOption(options, 'state'),
    reason: getOption(options, 'reason'),
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
      'node ui/scripts/hm-work-item.js open --objective <text> [--id <id>] [--owner-role builder] [--required-proof builder_code]',
      'node ui/scripts/hm-work-item.js status [--id <id>]',
      'node ui/scripts/hm-work-item.js attach-proof --id <id> --role <builder_code|oracle_verify|codex_browser|prod_gate> [--ref <artifact>] [--hash sha256:...] [--visual-request-id <id>] [--response-ref <artifact>]',
      'node ui/scripts/hm-work-item.js request-codex-visual --id <id> (--route <path>|--url <url>) [--viewport mobile:390x844] [--invariant <text>]',
      'node ui/scripts/hm-work-item.js close --id <id> --verdict <passed|failed|blocked|canceled> [--reason <text>]',
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
  if (normalized === 'open') {
    result = openWorkItem(openInput(options), commonOptions(options));
  } else if (normalized === 'status') {
    result = statusWorkItems({ id: getOption(options, 'id', 'work-item-id') }, commonOptions(options));
  } else if (normalized === 'attach-proof') {
    result = attachProof(attachProofInput(options), commonOptions(options));
  } else if (normalized === 'request-codex-visual') {
    result = requestCodexVisual(visualRequestInput(options), commonOptions(options));
  } else if (normalized === 'close') {
    result = closeWorkItem(closeInput(options), commonOptions(options));
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
  attachProofInput,
  closeInput,
  commonOptions,
  main,
  openInput,
  parseArgs,
  requestCodexVisual,
  visualRequestInput,
};
