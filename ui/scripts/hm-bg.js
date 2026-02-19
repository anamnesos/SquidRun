#!/usr/bin/env node
/**
 * hm-bg: Background Builder Agent control CLI over WebSocket.
 *
 * Commands:
 *   spawn [alias|slot]
 *   list
 *   kill <target>
 *   kill-all
 *   map
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-bg.js <command> [args] [options]');
  console.log('Commands: spawn, list, kill, kill-all, map');
  console.log('Options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --alias <builder-bg-N>      Explicit alias (spawn/kill)');
  console.log('  --slot <1|2|3>              Slot number (spawn)');
  console.log('  --target <alias|paneId>     Kill target (kill)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-bg.js spawn');
  console.log('  node hm-bg.js spawn --slot 2');
  console.log('  node hm-bg.js list');
  console.log('  node hm-bg.js kill builder-bg-1');
  console.log('  node hm-bg.js kill bg-2-1');
  console.log('  node hm-bg.js kill-all');
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
  if (normalized === 'ls' || normalized === 'status' || normalized === 'ps') return 'list';
  if (normalized === 'rm' || normalized === 'stop') return 'kill';
  if (normalized === 'killall') return 'kill-all';
  if (normalized === 'targets' || normalized === 'target-map') return 'map';
  return normalized;
}

function toAction(command) {
  switch (command) {
    case 'spawn':
      return 'spawn';
    case 'list':
      return 'list';
    case 'kill':
      return 'kill';
    case 'kill-all':
      return 'kill-all';
    case 'map':
      return 'target-map';
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function normalizeTarget(value) {
  const raw = asString(value, '');
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  if (/^\d+$/.test(lowered)) {
    return `builder-bg-${lowered}`;
  }
  return lowered;
}

function buildPayload(command, positional, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  if (command === 'spawn') {
    const payload = {};
    const slotRaw = asString(getOption(options, 'slot', ''), '');
    if (slotRaw) {
      const parsed = Number.parseInt(slotRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('slot must be a positive integer');
      }
      payload.slot = parsed;
    }

    const aliasOrSlot = normalizeTarget(getOption(options, 'alias', positional[1] || ''));
    if (aliasOrSlot) {
      if (/^builder-bg-\d+$/.test(aliasOrSlot)) {
        payload.alias = aliasOrSlot;
      } else if (/^bg-2-\d+$/.test(aliasOrSlot)) {
        payload.alias = aliasOrSlot.replace(/^bg-2-/, 'builder-bg-');
      } else {
        payload.alias = aliasOrSlot;
      }
    }
    return payload;
  }

  if (command === 'kill') {
    const target = normalizeTarget(getOption(options, 'target', getOption(options, 'alias', positional[1] || '')));
    if (!target) {
      throw new Error('target is required for kill');
    }
    return { target };
  }

  return {};
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
  const requestId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'background-agent',
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

  const allowedCommands = new Set(['spawn', 'list', 'kill', 'kill-all', 'map']);
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
  if (result && typeof result === 'object' && result.ok === false) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-bg failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getOption,
  normalizeCommand,
  toAction,
  buildPayload,
  normalizeTarget,
  run,
  main,
};
