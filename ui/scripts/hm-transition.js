#!/usr/bin/env node
/**
 * hm-transition: Transition Ledger query CLI over WebSocket.
 *
 * Commands:
 *   list
 *   get
 *   stats
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-transition.js <command> [options]');
  console.log('Commands: list, get, stats');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: devops)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-transition.js list --limit 20 --include-closed true');
  console.log('  node hm-transition.js get --id tr-173991990-12');
  console.log('  node hm-transition.js get --correlation corr-abc --pane 2');
  console.log('  node hm-transition.js stats');
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
    options.set(key, value);
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function asBoolean(value, fallback = null) {
  if (typeof value === 'boolean') return value;
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
  if (normalized === 'list-transitions') return 'list';
  if (normalized === 'get-by-id' || normalized === 'get-by-correlation') return 'get';
  if (normalized === 'get-stats') return 'stats';
  return normalized;
}

function toAction(command, payload = {}) {
  if (command === 'list') return 'list';
  if (command === 'stats') return 'getStats';
  if (command === 'get') {
    if (payload.transitionId) return 'getById';
    return 'getByCorrelation';
  }
  throw new Error(`Unsupported command: ${command}`);
}

function buildPayload(command, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  if (command === 'list') {
    const payload = {};
    const includeClosed = asBoolean(getOption(options, 'include-closed', null), null);
    const paneId = asString(getOption(options, 'pane', getOption(options, 'pane-id', '')), '');
    const phase = asString(getOption(options, 'phase', ''), '');
    const intentType = asString(getOption(options, 'intent', getOption(options, 'intent-type', '')), '');
    const reasonCode = asString(getOption(options, 'reason', getOption(options, 'reason-code', '')), '');
    const limit = asNumber(getOption(options, 'limit', null), null);
    const since = asNumber(getOption(options, 'since', null), null);
    const until = asNumber(getOption(options, 'until', null), null);

    if (includeClosed !== null) payload.includeClosed = includeClosed;
    if (paneId) payload.paneId = paneId;
    if (phase) payload.phase = phase;
    if (intentType) payload.intentType = intentType;
    if (reasonCode) payload.reasonCode = reasonCode;
    if (limit !== null) payload.limit = limit;
    if (since !== null) payload.since = since;
    if (until !== null) payload.until = until;
    return payload;
  }

  if (command === 'get') {
    const payload = {};
    const transitionId = asString(getOption(options, 'id', getOption(options, 'transition-id', '')), '');
    const correlationId = asString(getOption(options, 'correlation', getOption(options, 'correlation-id', '')), '');
    const paneId = asString(getOption(options, 'pane', getOption(options, 'pane-id', '')), '');
    const includeClosed = asBoolean(getOption(options, 'include-closed', null), null);

    if (transitionId) {
      payload.transitionId = transitionId;
      return payload;
    }
    if (correlationId) {
      payload.correlationId = correlationId;
      if (paneId) payload.paneId = paneId;
      if (includeClosed !== null) payload.includeClosed = includeClosed;
      return payload;
    }
    throw new Error('get command requires --id <transitionId> or --correlation <correlationId>');
  }

  if (command === 'stats') {
    return {};
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
  const role = asString(options.role, 'devops') || 'devops';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_RESPONSE_TIMEOUT_MS;
  const requestId = `transition-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'transition-ledger',
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

  const allowedCommands = new Set(['list', 'get', 'stats']);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  const payload = buildPayload(command, options);
  const action = toAction(command, payload);
  const response = await run(action, payload, {
    role: asString(getOption(options, 'role', 'devops'), 'devops'),
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
    console.error(`hm-transition failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getOption,
  normalizeCommand,
  toAction,
  buildPayload,
  run,
  main,
};
