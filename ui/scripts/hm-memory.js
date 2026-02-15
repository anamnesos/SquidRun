#!/usr/bin/env node
/**
 * hm-memory: Evidence Ledger decision-memory CLI over WebSocket.
 *
 * Commands:
 *   record
 *   directives
 *   context
 *   session-start
 *   session-end
 *   search
 *   completions
 *   roadmap
 *   snapshot
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-memory.js <command> [options]');
  console.log('Commands: record, directives, context, session-start, session-end, search, completions, roadmap, snapshot');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-memory.js record --category directive --title "Always use Opus for teammates" --author user');
  console.log('  node hm-memory.js directives');
  console.log('  node hm-memory.js context');
  console.log('  node hm-memory.js session-start --number 115 --mode PTY');
  console.log('  node hm-memory.js session-end --session s_115 --summary "Completed Slice 3"');
  console.log('  node hm-memory.js search --query "opus"');
  console.log('  node hm-memory.js completions --limit 10');
  console.log('  node hm-memory.js roadmap');
  console.log('  node hm-memory.js snapshot --session s_114');
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

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
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
  const cmd = asString(command).toLowerCase();
  if (cmd === 'record-decision') return 'record';
  if (cmd === 'get-context') return 'context';
  if (cmd === 'sessionstart') return 'session-start';
  if (cmd === 'sessionend') return 'session-end';
  return cmd;
}

function toAction(command) {
  switch (command) {
    case 'record': return 'record-decision';
    case 'directives': return 'get-directives';
    case 'context': return 'get-context';
    case 'session-start': return 'record-session-start';
    case 'session-end': return 'record-session-end';
    case 'search': return 'search-decisions';
    case 'completions': return 'get-completions';
    case 'roadmap': return 'get-roadmap';
    case 'snapshot': return 'snapshot-context';
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function buildPayload(command, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  switch (command) {
    case 'record': {
      const payload = {
        category: asString(getOption(options, 'category', '')),
        title: asString(getOption(options, 'title', '')),
        body: asString(getOption(options, 'body', '')),
        author: asString(getOption(options, 'author', '')),
        status: asString(getOption(options, 'status', '')),
        sessionId: asString(getOption(options, 'session', getOption(options, 'session-id', '')), ''),
        incidentId: asString(getOption(options, 'incident', getOption(options, 'incident-id', '')), ''),
      };
      const tagsRaw = asString(getOption(options, 'tags', ''), '');
      if (tagsRaw) {
        payload.tags = tagsRaw.split(',').map((item) => item.trim()).filter(Boolean);
      }
      const metaJson = getOption(options, 'meta-json');
      if (typeof metaJson === 'string') {
        payload.meta = parseJsonOption(metaJson, '--meta-json');
      }
      const nowMs = asNumber(getOption(options, 'now-ms', null), null);
      if (nowMs !== null) payload.nowMs = nowMs;
      return payload;
    }
    case 'directives': {
      const limit = asNumber(getOption(options, 'limit', null), null);
      return limit !== null ? { limit } : {};
    }
    case 'context': {
      const payload = {};
      const preferSnapshot = getOption(options, 'prefer-snapshot', false) === true;
      if (preferSnapshot) payload.preferSnapshot = true;
      const sessionId = asString(getOption(options, 'session', getOption(options, 'session-id', '')), '');
      if (sessionId) payload.sessionId = sessionId;
      return payload;
    }
    case 'session-start': {
      const payload = {
        sessionNumber: asNumber(getOption(options, 'number', getOption(options, 'session-number', null)), null),
        sessionId: asString(getOption(options, 'session', getOption(options, 'session-id', '')), ''),
        mode: asString(getOption(options, 'mode', ''), ''),
        summary: asString(getOption(options, 'summary', ''), ''),
      };
      const startedAtMs = asNumber(getOption(options, 'started-at-ms', null), null);
      if (startedAtMs !== null) payload.startedAtMs = startedAtMs;
      const statsJson = getOption(options, 'stats-json');
      if (typeof statsJson === 'string') payload.stats = parseJsonOption(statsJson, '--stats-json');
      const teamJson = getOption(options, 'team-json');
      if (typeof teamJson === 'string') payload.team = parseJsonOption(teamJson, '--team-json');
      const metaJson = getOption(options, 'meta-json');
      if (typeof metaJson === 'string') payload.meta = parseJsonOption(metaJson, '--meta-json');
      return payload;
    }
    case 'session-end': {
      const payload = {
        sessionId: asString(getOption(options, 'session', getOption(options, 'session-id', '')), ''),
        summary: asString(getOption(options, 'summary', ''), ''),
      };
      const endedAtMs = asNumber(getOption(options, 'ended-at-ms', null), null);
      if (endedAtMs !== null) payload.endedAtMs = endedAtMs;
      const statsJson = getOption(options, 'stats-json');
      if (typeof statsJson === 'string') payload.stats = parseJsonOption(statsJson, '--stats-json');
      const teamJson = getOption(options, 'team-json');
      if (typeof teamJson === 'string') payload.team = parseJsonOption(teamJson, '--team-json');
      const metaJson = getOption(options, 'meta-json');
      if (typeof metaJson === 'string') payload.meta = parseJsonOption(metaJson, '--meta-json');
      return payload;
    }
    case 'search': {
      const payload = {
        query: asString(getOption(options, 'query', '')),
      };
      const category = asString(getOption(options, 'category', ''), '');
      const status = asString(getOption(options, 'status', ''), '');
      const author = asString(getOption(options, 'author', ''), '');
      const limit = asNumber(getOption(options, 'limit', null), null);
      if (category) payload.category = category;
      if (status) payload.status = status;
      if (author) payload.author = author;
      if (limit !== null) payload.limit = limit;
      return payload;
    }
    case 'completions':
    case 'roadmap': {
      const limit = asNumber(getOption(options, 'limit', null), null);
      return limit !== null ? { limit } : {};
    }
    case 'snapshot': {
      const payload = {
        sessionId: asString(getOption(options, 'session', getOption(options, 'session-id', '')), ''),
        trigger: asString(getOption(options, 'trigger', 'manual'), 'manual'),
      };
      const contentJson = getOption(options, 'content-json');
      if (typeof contentJson === 'string') {
        payload.content = parseJsonOption(contentJson, '--content-json');
      }
      const nowMs = asNumber(getOption(options, 'now-ms', null), null);
      if (nowMs !== null) payload.nowMs = nowMs;
      return payload;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
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
  const requestId = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'evidence-ledger',
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
    'record',
    'directives',
    'context',
    'session-start',
    'session-end',
    'search',
    'completions',
    'roadmap',
    'snapshot',
  ]);
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
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok') && result.ok === false) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`hm-memory failed: ${err.message}`);
  process.exit(1);
});
