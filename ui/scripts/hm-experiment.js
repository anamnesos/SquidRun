#!/usr/bin/env node
/**
 * hm-experiment: Experiment Engine CLI over WebSocket.
 *
 * Commands:
 *   run
 *   get
 *   list
 *   attach
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-experiment.js <command> [options]');
  console.log('Commands: run, get, list, attach');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-experiment.js run --profile jest-suite --claim-id clm_123 --requested-by builder');
  console.log('  node hm-experiment.js get --run-id exp_123');
  console.log('  node hm-experiment.js list --status attach_pending --limit 20');
  console.log('  node hm-experiment.js attach --run-id exp_123 --claim-id clm_123 --relation supports --added-by builder');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;

    if (options.has(key)) {
      const existing = options.get(key);
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        options.set(key, [existing, value]);
      }
    } else {
      options.set(key, value);
    }
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function getOptionList(options, key) {
  if (!options.has(key)) return [];
  const raw = options.get(key);
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function asBoolean(value, fallback = null) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function parseJsonOption(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}

function normalizeCommand(command) {
  const normalized = asString(command).toLowerCase();
  if (normalized === 'create') return 'run';
  if (normalized === 'run-experiment') return 'run';
  if (normalized === 'get-experiment') return 'get';
  if (normalized === 'list-experiments') return 'list';
  if (normalized === 'attach-to-claim') return 'attach';
  return normalized;
}

function toAction(command) {
  if (command === 'run') return 'run-experiment';
  if (command === 'get') return 'get-experiment';
  if (command === 'list') return 'list-experiments';
  if (command === 'attach') return 'attach-to-claim';
  throw new Error(`Unsupported command: ${command}`);
}

function parseArgEntries(options) {
  const entries = getOptionList(options, 'arg')
    .map((entry) => asString(entry, ''))
    .filter(Boolean);
  const args = {};
  for (const entry of entries) {
    const splitIndex = entry.indexOf('=');
    if (splitIndex <= 0) {
      throw new Error(`Invalid --arg value "${entry}". Expected key=value.`);
    }
    const key = entry.slice(0, splitIndex).trim();
    const value = entry.slice(splitIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid --arg value "${entry}". Expected key=value.`);
    }
    args[key] = value;
  }
  return args;
}

function parseEnvAllowlist(options) {
  const rawCsv = asString(getOption(options, 'env-allowlist', ''), '');
  const csvValues = rawCsv
    ? rawCsv.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const repeated = getOptionList(options, 'env')
    .map((item) => asString(item, ''))
    .filter(Boolean);
  return [...new Set([...csvValues, ...repeated])];
}

function buildRunPayload(options) {
  const payload = {
    profileId: asString(getOption(options, 'profile', getOption(options, 'profile-id', '')), ''),
    claimId: asString(getOption(options, 'claim-id', ''), ''),
    relation: asString(getOption(options, 'relation', ''), ''),
    requestedBy: asString(
      getOption(options, 'requested-by', getOption(options, 'by', getOption(options, 'agent', getOption(options, 'owner', '')))),
      ''
    ),
    session: asString(getOption(options, 'session', ''), ''),
    idempotencyKey: asString(getOption(options, 'idempotency-key', ''), ''),
    guardContext: null,
    input: {
      args: {},
      envAllowlist: [],
    },
  };

  const repoPath = asString(getOption(options, 'repo-path', ''), '');
  if (repoPath) payload.input.repoPath = repoPath;

  const timeoutMs = asNumber(getOption(options, 'timeout-ms', null), null);
  if (timeoutMs !== null) payload.timeoutMs = timeoutMs;

  const outputCapBytes = asNumber(getOption(options, 'output-cap-bytes', null), null);
  if (outputCapBytes !== null) payload.outputCapBytes = outputCapBytes;

  const redactionRulesJson = asString(getOption(options, 'redaction-rules-json', ''), '');
  if (redactionRulesJson) {
    payload.redactionRules = parseJsonOption(redactionRulesJson, '--redaction-rules-json');
  }

  const argsJson = asString(getOption(options, 'args-json', ''), '');
  if (argsJson) {
    payload.input.args = parseJsonOption(argsJson, '--args-json');
  } else {
    payload.input.args = parseArgEntries(options);
  }

  const envAllowlist = parseEnvAllowlist(options);
  if (envAllowlist.length > 0) {
    payload.input.envAllowlist = envAllowlist;
  }

  const guardId = asString(getOption(options, 'guard-id', ''), '');
  const guardAction = asString(getOption(options, 'guard-action', ''), '');
  const guardBlocking = asBoolean(getOption(options, 'guard-blocking', null), null);
  if (guardId || guardAction || guardBlocking !== null) {
    payload.guardContext = {
      guardId: guardId || null,
      action: guardAction || null,
      blocking: guardBlocking === true,
    };
  }

  return payload;
}

function buildPayload(command, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  if (command === 'run') {
    return buildRunPayload(options);
  }
  if (command === 'get') {
    return {
      runId: asString(getOption(options, 'run-id', getOption(options, 'id', '')), ''),
    };
  }
  if (command === 'list') {
    const payload = {
      status: asString(getOption(options, 'status', ''), ''),
      profileId: asString(getOption(options, 'profile', getOption(options, 'profile-id', '')), ''),
      claimId: asString(getOption(options, 'claim-id', ''), ''),
      guardId: asString(getOption(options, 'guard-id', ''), ''),
      cursor: asString(getOption(options, 'cursor', ''), ''),
      limit: asNumber(getOption(options, 'limit', null), null),
      sinceMs: asNumber(getOption(options, 'since-ms', null), null),
      untilMs: asNumber(getOption(options, 'until-ms', null), null),
    };
    return payload;
  }
  if (command === 'attach') {
    return {
      runId: asString(getOption(options, 'run-id', getOption(options, 'id', '')), ''),
      claimId: asString(getOption(options, 'claim-id', ''), ''),
      relation: asString(getOption(options, 'relation', ''), ''),
      addedBy: asString(getOption(options, 'added-by', getOption(options, 'by', getOption(options, 'agent', ''))), ''),
      summary: asString(getOption(options, 'summary', ''), ''),
    };
  }
  throw new Error(`Unsupported command: ${command}`);
}

function waitForMatch(ws, predicate, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutLabel || 'Timed out waiting for socket response'));
    }, timeoutMs);

    const onMessage = (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before response'));
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // no-op
      }
      resolve();
    }, 250);
    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function run(action, payload, options) {
  const port = Number.isFinite(options.port) ? options.port : DEFAULT_PORT;
  const role = asString(options.role, 'builder') || 'builder';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_RESPONSE_TIMEOUT_MS;
  const requestId = `experiment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'team-memory',
    action,
    payload,
    requestId,
  }));

  const response = await waitForMatch(
    ws,
    (msg) => msg.type === 'response' && msg.requestId === requestId,
    timeoutMs,
    `Response timeout after ${timeoutMs}ms`
  );

  await closeSocket(ws);
  return response;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const { positional, options } = parseArgs(argv);
  const command = normalizeCommand(positional[0]);
  if (!command) {
    usage();
    process.exit(1);
  }

  const allowedCommands = new Set(['run', 'get', 'list', 'attach']);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  const payload = buildPayload(command, options);
  const response = await run(toAction(command), payload, {
    role: asString(getOption(options, 'role', 'builder'), 'builder'),
    port: asNumber(getOption(options, 'port', DEFAULT_PORT), DEFAULT_PORT),
    timeoutMs: asNumber(getOption(options, 'timeout', DEFAULT_RESPONSE_TIMEOUT_MS), DEFAULT_RESPONSE_TIMEOUT_MS),
  });

  const result = response?.result;
  console.log(JSON.stringify(result, null, 2));

  if (response?.ok === false) {
    process.exit(1);
  }
  if (result && typeof result === 'object' && result.ok === false) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-experiment failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getOption,
  normalizeCommand,
  toAction,
  buildPayload,
  buildRunPayload,
  run,
  main,
};
