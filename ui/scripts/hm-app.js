#!/usr/bin/env node
/**
 * hm-app: App-level control CLI over WebSocket.
 *
 * Commands:
 *   reload-renderers
 *   restart-telegram-poller
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-app.js <command> [options]');
  console.log('Commands: reload-renderers, restart-telegram-poller, open-mira-lab, open-live-task-audit-sidecar, open-trustquote-workspace, drive-mira-lab');
  console.log('Options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log(`  --port <port>               WebSocket port (default: ${DEFAULT_PORT})`);
  console.log(`  --timeout <ms>              Response timeout (default: ${DEFAULT_RESPONSE_TIMEOUT_MS})`);
  console.log('drive-mira-lab options:');
  console.log('  --prompt <text>             Prompt text to drive into the live Mira Lab renderer');
  console.log('  --pane <architect|builder|oracle>   Pane to receive Mira\'s visible reply envelope');
  console.log('  --speaker-role <role>       Speaker role attached to the prompt (default: james)');
  console.log('  --session-id <id>           Optional Mira Lab session id');
  console.log('  --timeout-ms <ms>           Renderer round-trip timeout (default: 10000)');
  console.log('Examples:');
  console.log('  node hm-app.js reload-renderers');
  console.log('  node hm-app.js open-mira-lab');
  console.log('  node hm-app.js open-live-task-audit-sidecar');
  console.log('  node hm-app.js open-trustquote-workspace');
  console.log('  node hm-app.js drive-mira-lab --prompt "are we still talking?" --pane builder');
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
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeCommand(command) {
  const normalized = asString(command, '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'reload' || normalized === 'reload-renderer') return 'reload-renderers';
  if (normalized === 'restart-telegram' || normalized === 'reload-telegram-poller') return 'restart-telegram-poller';
  if (normalized === 'mira-lab' || normalized === 'open-mira' || normalized === 'mira-lab-open') return 'open-mira-lab';
  if (
    normalized === 'live-task-audit-sidecar'
    || normalized === 'task-audit-sidecar'
    || normalized === 'task-audit'
    || normalized === 'open-task-audit'
  ) return 'open-live-task-audit-sidecar';
  if (normalized === 'trustquote' || normalized === 'open-trustquote' || normalized === 'trustquote-workspace') return 'open-trustquote-workspace';
  if (normalized === 'drive-mira-lab' || normalized === 'mira-lab-drive' || normalized === 'mira-lab-renderer-prompt') return 'mira-lab-renderer-prompt';
  return normalized;
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

async function run(action, options = {}) {
  const port = Number.isFinite(options.port) ? options.port : DEFAULT_PORT;
  const role = asString(options.role, 'builder') || 'builder';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_RESPONSE_TIMEOUT_MS;
  const requestId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = options.payload && typeof options.payload === 'object' ? options.payload : {};

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'app-control',
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

  const allowedCommands = new Set([
    'reload-renderers',
    'restart-telegram-poller',
    'open-mira-lab',
    'open-live-task-audit-sidecar',
    'open-trustquote-workspace',
    'mira-lab-renderer-prompt',
  ]);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  let payload = {};
  if (command === 'mira-lab-renderer-prompt') {
    const prompt = asString(getOption(options, 'prompt', ''), '');
    if (!prompt) {
      console.error('drive-mira-lab requires --prompt <text>');
      process.exit(1);
    }
    payload = {
      prompt,
      requesterPane: asString(getOption(options, 'pane', ''), '') || null,
      speakerRole: asString(getOption(options, 'speaker-role', 'james'), 'james'),
      sessionId: asString(getOption(options, 'session-id', ''), '') || null,
      timeoutMs: asNumber(getOption(options, 'timeout-ms', null), null),
    };
  }

  const response = await run(command, {
    role: asString(getOption(options, 'role', 'builder'), 'builder'),
    port: asNumber(getOption(options, 'port', DEFAULT_PORT), DEFAULT_PORT),
    timeoutMs: asNumber(getOption(options, 'timeout', DEFAULT_RESPONSE_TIMEOUT_MS), DEFAULT_RESPONSE_TIMEOUT_MS),
    payload,
  });

  console.log(JSON.stringify(response?.result || response, null, 2));
  if (response?.ok === false || response?.result?.success === false) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-app failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  normalizeCommand,
  run,
  main,
};
