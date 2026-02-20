#!/usr/bin/env node
/**
 * hm-pane: Pane control CLI over WebSocket.
 *
 * Commands:
 *   enter <paneId>
 *   interrupt <paneId>
 *   restart <paneId>
 *   nudge <paneId> [message]
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-pane.js <command> <paneId> [message] [options]');
  console.log('Commands: enter, interrupt, restart, nudge');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-pane.js enter 1');
  console.log('  node hm-pane.js interrupt 2');
  console.log('  node hm-pane.js restart 3');
  console.log('  node hm-pane.js nudge 2 "Status check?"');
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

function parseJsonOption(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}

function normalizeCommand(command) {
  const normalized = asString(command).toLowerCase();
  if (normalized === 'ctrl-c') return 'interrupt';
  if (normalized === 'kill') return 'interrupt';
  if (normalized === 'enter-pane') return 'enter';
  if (normalized === 'nudge-pane' || normalized === 'nudge-agent') return 'nudge';
  return normalized;
}

function toAction(command) {
  switch (command) {
    case 'enter':
    case 'interrupt':
    case 'restart':
    case 'nudge':
      return command;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function buildPayload(command, positional, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  const paneId = asString(getOption(options, 'pane', positional[1] || ''), '');
  if (!paneId) {
    throw new Error('paneId is required');
  }

  const payload = { paneId };
  if (command === 'nudge') {
    const messageFromPositional = positional.slice(2).join(' ').trim();
    const message = asString(getOption(options, 'message', messageFromPositional), '');
    if (message) payload.message = message;
  }
  return payload;
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
  const requestId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'pane-control',
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

  const allowedCommands = new Set(['enter', 'interrupt', 'restart', 'nudge']);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  const payload = buildPayload(command, positional, options);
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
  if (result && typeof result === 'object' && result.success === false) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-pane failed: ${err.message}`);
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
