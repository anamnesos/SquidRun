#!/usr/bin/env node
/**
 * hm-investigate: Evidence Ledger investigator CLI over WebSocket.
 *
 * Commands:
 *   create-incident
 *   add-hypothesis
 *   bind-evidence
 *   record-verdict
 *   get-summary
 *   list-incidents
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-investigate.js <command> [options]');
  console.log('Commands: create-incident, add-hypothesis, bind-evidence, record-verdict, get-summary, list-incidents');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('Examples:');
  console.log('  node hm-investigate.js create-incident --title "ERR-008: Submit race" --severity high');
  console.log('  node hm-investigate.js add-hypothesis --incident inc_abc --claim "Focus lock" --confidence 0.6 --evidence-event evt_123');
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
    if (value !== true) {
      i += 1;
    }

    if (options.has(key)) {
      const existing = options.get(key);
      if (Array.isArray(existing)) {
        existing.push(value);
        options.set(key, existing);
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

function getOptionArray(options, key) {
  const value = getOption(options, key, null);
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
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

function parseJsonOption(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}

function normalizeCommand(command) {
  const cmd = asString(command).toLowerCase();
  if (cmd === 'add-assertion') return 'add-hypothesis';
  return cmd;
}

function buildPayload(command, options) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  switch (command) {
    case 'create-incident': {
      const tags = [
        ...getOptionArray(options, 'tag').map((tag) => asString(tag)).filter(Boolean),
        ...asString(getOption(options, 'tags', ''), '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ];
      const payload = {
        title: asString(getOption(options, 'title', '')),
        description: asString(getOption(options, 'description', '')),
        severity: asString(getOption(options, 'severity', '')),
        status: asString(getOption(options, 'status', '')),
        createdBy: asString(getOption(options, 'created-by', getOption(options, 'author', '')), ''),
        sessionId: asString(getOption(options, 'session-id', '')),
      };
      if (tags.length > 0) payload.tags = tags;
      const metaJson = getOption(options, 'meta-json');
      if (typeof metaJson === 'string') {
        payload.meta = parseJsonOption(metaJson, '--meta-json');
      }
      return payload;
    }
    case 'add-hypothesis': {
      const payload = {
        incidentId: asString(getOption(options, 'incident', getOption(options, 'incident-id', '')), ''),
        claim: asString(getOption(options, 'claim', '')),
        author: asString(getOption(options, 'author', '')),
        type: asString(getOption(options, 'type', 'hypothesis')),
        reasoning: asString(getOption(options, 'reasoning', '')),
      };
      const confidence = asNumber(getOption(options, 'confidence', null), null);
      if (confidence !== null) payload.confidence = confidence;
      if (getOption(options, 'allow-without-evidence', false) === true) {
        payload.allowWithoutEvidence = true;
      }

      const evidenceBindings = [];
      const evidenceEvent = asString(getOption(options, 'evidence-event', ''), '');
      if (evidenceEvent) {
        evidenceBindings.push({
          kind: 'event_ref',
          eventId: evidenceEvent,
          traceId: asString(getOption(options, 'evidence-trace', ''), '') || undefined,
          relation: asString(getOption(options, 'relation', 'supports'), 'supports'),
        });
      }

      const evidenceJson = getOption(options, 'evidence-json');
      if (typeof evidenceJson === 'string') {
        const parsed = parseJsonOption(evidenceJson, '--evidence-json');
        if (Array.isArray(parsed)) {
          evidenceBindings.push(...parsed);
        } else if (parsed && typeof parsed === 'object') {
          evidenceBindings.push(parsed);
        }
      }

      if (evidenceBindings.length > 0) {
        payload.evidenceBindings = evidenceBindings;
      }
      return payload;
    }
    case 'bind-evidence': {
      const payload = {
        assertionId: asString(getOption(options, 'assertion', getOption(options, 'assertion-id', '')), ''),
        binding: {
          kind: asString(getOption(options, 'kind', ''), ''),
          relation: asString(getOption(options, 'relation', 'supports'), 'supports'),
          eventId: asString(getOption(options, 'event-id', ''), '') || undefined,
          traceId: asString(getOption(options, 'trace-id', ''), '') || undefined,
          spanId: asString(getOption(options, 'span-id', ''), '') || undefined,
          filePath: asString(getOption(options, 'file', ''), '') || undefined,
          fileLine: asNumber(getOption(options, 'line', null), null),
          fileColumn: asNumber(getOption(options, 'column', null), null),
          snapshotHash: asString(getOption(options, 'snapshot-hash', ''), '') || undefined,
          logSource: asString(getOption(options, 'log-source', ''), '') || undefined,
          logStartMs: asNumber(getOption(options, 'log-start', null), null),
          logEndMs: asNumber(getOption(options, 'log-end', null), null),
          note: asString(getOption(options, 'note', ''), '') || undefined,
        },
      };
      const queryJson = getOption(options, 'query-json');
      if (typeof queryJson === 'string') {
        payload.binding.query = parseJsonOption(queryJson, '--query-json');
      }
      const logFilterJson = getOption(options, 'log-filter-json');
      if (typeof logFilterJson === 'string') {
        payload.binding.logFilter = parseJsonOption(logFilterJson, '--log-filter-json');
      }
      return payload;
    }
    case 'record-verdict': {
      const payload = {
        incidentId: asString(getOption(options, 'incident', getOption(options, 'incident-id', '')), ''),
        value: asString(getOption(options, 'value', '')),
        reason: asString(getOption(options, 'reason', '')),
        author: asString(getOption(options, 'author', '')),
      };
      const confidence = asNumber(getOption(options, 'confidence', null), null);
      if (confidence !== null) payload.confidence = confidence;
      const keyAssertions = getOptionArray(options, 'key-assertion')
        .map((value) => asString(value))
        .filter(Boolean);
      if (keyAssertions.length > 0) payload.keyAssertionIds = keyAssertions;
      return payload;
    }
    case 'get-summary': {
      return {
        incidentId: asString(getOption(options, 'incident', getOption(options, 'incident-id', '')), ''),
      };
    }
    case 'list-incidents': {
      const payload = {};
      const status = asString(getOption(options, 'status', ''), '');
      const severity = asString(getOption(options, 'severity', ''), '');
      const order = asString(getOption(options, 'order', ''), '');
      const sessionId = asString(getOption(options, 'session-id', ''), '');
      const limit = asNumber(getOption(options, 'limit', null), null);
      if (status) payload.status = status;
      if (severity) payload.severity = severity;
      if (order) payload.order = order;
      if (sessionId) payload.sessionId = sessionId;
      if (limit !== null) payload.limit = limit;
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

async function run(command, payload, options) {
  const port = Number.isFinite(options.port) ? options.port : DEFAULT_PORT;
  const role = asString(options.role, 'builder') || 'builder';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_RESPONSE_TIMEOUT_MS;
  const requestId = `investigate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'evidence-ledger',
    action: command,
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
    'create-incident',
    'add-hypothesis',
    'bind-evidence',
    'record-verdict',
    'get-summary',
    'list-incidents',
  ]);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  const payload = buildPayload(command, options);
  const response = await run(command, payload, {
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
  console.error(`hm-investigate failed: ${err.message}`);
  process.exit(1);
});
