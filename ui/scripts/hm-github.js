#!/usr/bin/env node
/**
 * hm-github: GitHub workflow CLI over WebSocket.
 *
 * Commands:
 *   status
 *   checks [--ref <ref>]
 *   runs [--branch <name>] [--status <status>] [--limit <n>]
 *   pr <create|list|get|update|merge> ...
 *   issue <create|list|get|close|comment> ...
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-github.js <command> [options]');
  console.log('Commands:');
  console.log('  status');
  console.log('  checks [--ref <ref>]');
  console.log('  runs [--branch <name>] [--status <status>] [--limit <n>]');
  console.log('  pr create --title "..." [--body "..."] [--base main] [--head branch] [--draft]');
  console.log('  pr list [--state open|closed|all] [--head branch] [--base main] [--limit n]');
  console.log('  pr get <number>');
  console.log('  pr update <number> [--title "..."] [--body "..."] [--state open|closed]');
  console.log('  pr merge <number> [--method merge|squash|rebase]');
  console.log('  issue create --title "..." [--body "..."] [--labels bug,feat] [--assignees user1,user2]');
  console.log('  issue list [--state open|closed|all] [--labels bug,feat] [--limit n]');
  console.log('  issue get <number>');
  console.log('  issue close <number>');
  console.log('  issue comment <number> --body "..."');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: devops)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
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
  if (normalized === 'pull-request') return 'pr';
  if (normalized === 'pullrequests') return 'pr';
  if (normalized === 'issues') return 'issue';
  if (normalized === 'check') return 'checks';
  if (normalized === 'run') return 'runs';
  return normalized;
}

function requireValue(value, message) {
  if (!asString(value, '')) {
    throw new Error(message);
  }
  return String(value).trim();
}

function buildRequest(positional, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    const action = requireValue(getOption(options, 'action', positional[0] || ''), '--action is required with --payload-json');
    return {
      action,
      payload: parseJsonOption(payloadJson, '--payload-json'),
    };
  }

  const root = normalizeCommand(positional[0]);
  if (!root) {
    throw new Error('command is required');
  }

  if (root === 'status') {
    return { action: 'status', payload: {} };
  }

  if (root === 'checks') {
    return {
      action: 'getChecks',
      payload: {
        ref: asString(getOption(options, 'ref', 'HEAD'), 'HEAD'),
      },
    };
  }

  if (root === 'runs') {
    const payload = {};
    const branch = asString(getOption(options, 'branch', ''), '');
    const status = asString(getOption(options, 'status', ''), '');
    const limit = asNumber(getOption(options, 'limit', null), null);
    if (branch) payload.branch = branch;
    if (status) payload.status = status;
    if (limit !== null) payload.limit = limit;
    return { action: 'getWorkflowRuns', payload };
  }

  if (root === 'pr') {
    const sub = normalizeCommand(positional[1]);
    if (sub === 'create') {
      const title = requireValue(getOption(options, 'title', ''), 'pr create requires --title');
      const payload = { title };
      const body = asString(getOption(options, 'body', ''), '');
      const base = asString(getOption(options, 'base', ''), '');
      const head = asString(getOption(options, 'head', ''), '');
      if (body) payload.body = body;
      if (base) payload.base = base;
      if (head) payload.head = head;
      if (getOption(options, 'draft', false) === true) payload.draft = true;
      return { action: 'createPR', payload };
    }

    if (sub === 'list') {
      const payload = {};
      const state = asString(getOption(options, 'state', ''), '');
      const base = asString(getOption(options, 'base', ''), '');
      const head = asString(getOption(options, 'head', ''), '');
      const limit = asNumber(getOption(options, 'limit', null), null);
      if (state) payload.state = state;
      if (base) payload.base = base;
      if (head) payload.head = head;
      if (limit !== null) payload.limit = limit;
      return { action: 'listPRs', payload };
    }

    if (sub === 'get') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'pr get requires <number>');
      return { action: 'getPR', payload: { number } };
    }

    if (sub === 'update') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'pr update requires <number>');
      const payload = { number };
      const title = asString(getOption(options, 'title', ''), '');
      const body = asString(getOption(options, 'body', ''), '');
      const state = asString(getOption(options, 'state', ''), '');
      const base = asString(getOption(options, 'base', ''), '');
      if (title) payload.title = title;
      if (body) payload.body = body;
      if (state) payload.state = state;
      if (base) payload.base = base;
      return { action: 'updatePR', payload };
    }

    if (sub === 'merge') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'pr merge requires <number>');
      const payload = { number };
      const method = asString(getOption(options, 'method', ''), '');
      if (method) payload.method = method;
      return { action: 'mergePR', payload };
    }

    throw new Error(`Unsupported pr subcommand: ${sub || '(missing)'}`);
  }

  if (root === 'issue') {
    const sub = normalizeCommand(positional[1]);
    if (sub === 'create') {
      const title = requireValue(getOption(options, 'title', ''), 'issue create requires --title');
      const payload = { title };
      const body = asString(getOption(options, 'body', ''), '');
      const labels = asString(getOption(options, 'labels', ''), '');
      const assignees = asString(getOption(options, 'assignees', ''), '');
      if (body) payload.body = body;
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;
      return { action: 'createIssue', payload };
    }

    if (sub === 'list') {
      const payload = {};
      const state = asString(getOption(options, 'state', ''), '');
      const labels = asString(getOption(options, 'labels', ''), '');
      const limit = asNumber(getOption(options, 'limit', null), null);
      if (state) payload.state = state;
      if (labels) payload.labels = labels;
      if (limit !== null) payload.limit = limit;
      return { action: 'listIssues', payload };
    }

    if (sub === 'get') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'issue get requires <number>');
      return { action: 'getIssue', payload: { number } };
    }

    if (sub === 'close') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'issue close requires <number>');
      return { action: 'closeIssue', payload: { number } };
    }

    if (sub === 'comment') {
      const number = requireValue(positional[2] || getOption(options, 'number', ''), 'issue comment requires <number>');
      const bodyFromPositional = positional.slice(3).join(' ').trim();
      const body = requireValue(
        asString(getOption(options, 'body', bodyFromPositional), ''),
        'issue comment requires --body'
      );
      return { action: 'addIssueComment', payload: { number, body } };
    }

    throw new Error(`Unsupported issue subcommand: ${sub || '(missing)'}`);
  }

  throw new Error(`Unsupported command: ${root}`);
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
  const requestId = `github-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'github',
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
  const { action, payload } = buildRequest(positional, options);
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
    console.error(`hm-github failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getOption,
  normalizeCommand,
  buildRequest,
  run,
  main,
};
