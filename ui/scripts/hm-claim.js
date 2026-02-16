#!/usr/bin/env node
/**
 * hm-claim: Team Memory Claim Graph CLI over WebSocket.
 *
 * Commands:
 *   create
 *   query
 *   search
 *   support / challenge / abstain
 *   consensus / beliefs / contradictions / snapshot
 *   pattern-create / patterns / pattern-activate / pattern-deactivate
 *   guard-create / guards / guard-activate / guard-deactivate
 *   update
 *   deprecate
 */

const WebSocket = require('ws');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function usage() {
  console.log('Usage: node hm-claim.js <command> [options]');
  console.log('Commands: create, query, search, support, challenge, abstain, consensus, beliefs, contradictions, snapshot, pattern-create, patterns, pattern-activate, pattern-deactivate, guard-create, guards, guard-activate, guard-deactivate, update, deprecate');
  console.log('Common options:');
  console.log('  --role <role>               Sender role (default: builder)');
  console.log('  --port <port>               WebSocket port (default: 9900)');
  console.log('  --timeout <ms>              Response timeout (default: 5000)');
  console.log('  --payload-json <json>       Raw payload JSON (advanced)');
  console.log('  --active-only <bool>        Contradictions only: unresolved rows only (default: true)');
  console.log('Examples:');
  console.log('  node hm-claim.js create --statement "Use queue for retries" --type decision --owner builder --scope ui/modules/comms-worker.js');
  console.log('  node hm-claim.js query --scope ui/modules/triggers.js --type negative');
  console.log('  node hm-claim.js search "retry storm" --scope ui/modules/triggers.js --type negative --sessions-back 3');
  console.log('  node hm-claim.js support --id clm_123 --agent builder --reason "Validated in test run"');
  console.log('  node hm-claim.js challenge --id clm_123 --agent oracle --reason "Contradicted by logs"');
  console.log('  node hm-claim.js consensus --id clm_123');
  console.log('  node hm-claim.js snapshot --agent builder --session s_123');
  console.log('  node hm-claim.js contradictions --agent builder --session s_123');
  console.log('  node hm-claim.js contradictions --agent builder --active-only false');
  console.log('  node hm-claim.js pattern-create --type failure --scope ui/modules/triggers.js --agents architect,oracle --frequency 2 --confidence 0.8');
  console.log('  node hm-claim.js patterns --type failure --scope ui/modules/triggers.js');
  console.log('  node hm-claim.js pattern-activate --id pat_123');
  console.log('  node hm-claim.js guard-create --action warn --scope ui/modules/triggers.js --pattern-type failure');
  console.log('  node hm-claim.js guards --scope ui/modules/triggers.js --active true');
  console.log('  node hm-claim.js guard-activate --id grd_123');
  console.log('  node hm-claim.js update --id clm_123 --status contested --by oracle --reason "Contradicted by trace data"');
  console.log('  node hm-claim.js deprecate --id clm_123 --by architect --reason "Superseded by clm_456"');
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
  if (typeof value === 'string' && value.trim().length === 0) return fallback;
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

function parseBooleanOption(options, key, fallback = null) {
  const raw = getOption(options, key, null);
  if (raw === null || raw === undefined) return fallback;
  if (raw === true) return true;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function normalizeCommand(command) {
  const normalized = asString(command).toLowerCase();
  if (normalized === 'list') return 'query';
  if (normalized === 'agree') return 'support';
  if (normalized === 'disagree') return 'challenge';
  if (normalized === 'pattern-query') return 'patterns';
  if (normalized === 'guard-query') return 'guards';
  return normalized;
}

function toAction(command) {
  switch (command) {
    case 'create': return 'create-claim';
    case 'query': return 'query-claims';
    case 'search': return 'search-claims';
    case 'support': return 'record-consensus';
    case 'challenge': return 'record-consensus';
    case 'abstain': return 'record-consensus';
    case 'consensus': return 'get-consensus';
    case 'beliefs': return 'get-agent-beliefs';
    case 'contradictions': return 'get-contradictions';
    case 'snapshot': return 'create-belief-snapshot';
    case 'pattern-create': return 'create-pattern';
    case 'patterns': return 'query-patterns';
    case 'pattern-activate': return 'activate-pattern';
    case 'pattern-deactivate': return 'deactivate-pattern';
    case 'guard-create': return 'create-guard';
    case 'guards': return 'query-guards';
    case 'guard-activate': return 'activate-guard';
    case 'guard-deactivate': return 'deactivate-guard';
    case 'update': return 'update-claim-status';
    case 'deprecate': return 'deprecate-claim';
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function parseScopes(rawValue) {
  if (typeof rawValue !== 'string') return [];
  return rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildQueryPayload(options) {
  const payload = {};
  const scope = asString(getOption(options, 'scope', ''), '');
  const claimType = asString(getOption(options, 'type', getOption(options, 'claim-type', '')), '');
  const status = asString(getOption(options, 'status', ''), '');
  const owner = asString(getOption(options, 'owner', ''), '');
  const session = asString(getOption(options, 'session', ''), '');
  const order = asString(getOption(options, 'order', ''), '');
  const limit = asNumber(getOption(options, 'limit', null), null);
  const sinceMs = asNumber(getOption(options, 'since-ms', null), null);
  const untilMs = asNumber(getOption(options, 'until-ms', null), null);
  const sessionsBack = asNumber(getOption(options, 'sessions-back', getOption(options, 'last-sessions', null)), null);

  const scopesFromScope = parseScopes(asString(getOption(options, 'scope', ''), ''));
  const scopesFromScopes = parseScopes(asString(getOption(options, 'scopes', ''), ''));
  const scopes = [...new Set([...scopesFromScope, ...scopesFromScopes])];

  if (scope) payload.scope = scope;
  if (scopes.length > 0) payload.scopes = scopes;
  if (claimType) payload.claimType = claimType;
  if (status) payload.status = status;
  if (owner) payload.owner = owner;
  if (session) payload.session = session;
  if (order) payload.order = order;
  if (limit !== null) payload.limit = limit;
  if (sinceMs !== null) payload.sinceMs = sinceMs;
  if (untilMs !== null) payload.untilMs = untilMs;
  if (sessionsBack !== null) payload.sessionsBack = sessionsBack;

  return payload;
}

function buildPayload(command, options, positional = []) {
  const payloadJson = getOption(options, 'payload-json');
  if (typeof payloadJson === 'string') {
    return parseJsonOption(payloadJson, '--payload-json');
  }

  switch (command) {
    case 'create': {
      const payload = {
        statement: asString(getOption(options, 'statement', ''), ''),
        claimType: asString(getOption(options, 'type', getOption(options, 'claim-type', 'fact')), 'fact'),
        owner: asString(getOption(options, 'owner', ''), ''),
        session: asString(getOption(options, 'session', ''), ''),
        status: asString(getOption(options, 'status', 'proposed'), 'proposed'),
      };
      const idempotencyKey = asString(getOption(options, 'idempotency-key', ''), '');
      if (idempotencyKey) payload.idempotencyKey = idempotencyKey;

      const confidence = asNumber(getOption(options, 'confidence', null), null);
      if (confidence !== null) payload.confidence = confidence;

      const ttlHours = asNumber(getOption(options, 'ttl-hours', null), null);
      if (ttlHours !== null) payload.ttlHours = ttlHours;

      const scopesFromScope = parseScopes(asString(getOption(options, 'scope', ''), ''));
      const scopesFromScopes = parseScopes(asString(getOption(options, 'scopes', ''), ''));
      const scopes = [...new Set([...scopesFromScope, ...scopesFromScopes])];
      if (scopes.length > 0) payload.scopes = scopes;

      return payload;
    }

    case 'query':
      return buildQueryPayload(options);

    case 'search': {
      const payload = buildQueryPayload(options);
      const positionalText = asString(positional[1], '');
      const text = asString(getOption(options, 'text', positionalText), positionalText);
      if (text) payload.text = text;
      return payload;
    }

    case 'support':
    case 'challenge':
    case 'abstain': {
      const commandToPosition = {
        support: 'agree',
        challenge: 'disagree',
        abstain: 'abstain',
      };
      return {
        claimId: asString(getOption(options, 'id', getOption(options, 'claim-id', '')), ''),
        agent: asString(getOption(options, 'agent', getOption(options, 'by', getOption(options, 'owner', ''))), ''),
        position: commandToPosition[command],
        reason: asString(getOption(options, 'reason', ''), ''),
      };
    }

    case 'consensus':
      return {
        claimId: asString(getOption(options, 'id', getOption(options, 'claim-id', '')), ''),
      };

    case 'beliefs':
      return {
        agent: asString(getOption(options, 'agent', getOption(options, 'owner', '')), ''),
        session: asString(getOption(options, 'session', ''), ''),
        latest: getOption(options, 'latest', true) !== 'false',
        limit: asNumber(getOption(options, 'limit', null), null),
      };

    case 'contradictions': {
      const payload = {
        agent: asString(getOption(options, 'agent', ''), ''),
        session: asString(getOption(options, 'session', ''), ''),
        claimId: asString(getOption(options, 'id', getOption(options, 'claim-id', '')), ''),
        limit: asNumber(getOption(options, 'limit', null), null),
        activeOnly: parseBooleanOption(options, 'active-only', true),
      };
      const sinceMs = asNumber(getOption(options, 'since-ms', null), null);
      const untilMs = asNumber(getOption(options, 'until-ms', null), null);
      if (sinceMs !== null) payload.sinceMs = sinceMs;
      if (untilMs !== null) payload.untilMs = untilMs;
      return payload;
    }

    case 'snapshot':
      return {
        agent: asString(getOption(options, 'agent', getOption(options, 'owner', '')), ''),
        session: asString(getOption(options, 'session', ''), ''),
        maxBeliefs: asNumber(getOption(options, 'max-beliefs', null), null),
      };

    case 'pattern-create': {
      const agents = parseScopes(asString(getOption(options, 'agents', ''), ''));
      return {
        patternType: asString(getOption(options, 'type', getOption(options, 'pattern-type', '')), ''),
        scope: asString(getOption(options, 'scope', ''), ''),
        agents,
        frequency: asNumber(getOption(options, 'frequency', null), null),
        confidence: asNumber(getOption(options, 'confidence', null), null),
        riskScore: asNumber(getOption(options, 'risk-score', null), null),
        resolution: asString(getOption(options, 'resolution', ''), ''),
      };
    }

    case 'patterns':
      return {
        patternType: asString(getOption(options, 'type', getOption(options, 'pattern-type', '')), ''),
        scope: asString(getOption(options, 'scope', ''), ''),
        active: getOption(options, 'active', null) === null
          ? null
          : String(getOption(options, 'active')).toLowerCase() !== 'false',
        sinceMs: asNumber(getOption(options, 'since-ms', null), null),
        untilMs: asNumber(getOption(options, 'until-ms', null), null),
        limit: asNumber(getOption(options, 'limit', null), null),
      };

    case 'pattern-activate':
    case 'pattern-deactivate':
      return {
        patternId: asString(getOption(options, 'id', getOption(options, 'pattern-id', '')), ''),
      };

    case 'guard-create': {
      const payload = {
        action: asString(getOption(options, 'action', 'warn'), 'warn'),
        sourcePattern: asString(getOption(options, 'source-pattern', ''), ''),
        sourceClaim: asString(getOption(options, 'source-claim', ''), ''),
        active: getOption(options, 'active', null) === null
          ? true
          : String(getOption(options, 'active')).toLowerCase() !== 'false',
      };
      const expiresAt = asNumber(getOption(options, 'expires-at', null), null);
      if (expiresAt !== null) payload.expiresAt = expiresAt;

      payload.triggerCondition = {
        scope: asString(getOption(options, 'scope', ''), ''),
        scopes: parseScopes(asString(getOption(options, 'scopes', ''), '')),
        patternType: asString(getOption(options, 'pattern-type', getOption(options, 'type', '')), ''),
        patternId: asString(getOption(options, 'pattern-id', ''), ''),
        eventType: asString(getOption(options, 'event-type', ''), ''),
        textIncludes: asString(getOption(options, 'contains', ''), ''),
        claimType: asString(getOption(options, 'claim-type', ''), ''),
        status: asString(getOption(options, 'status', ''), ''),
        suggestion: asString(getOption(options, 'suggestion', ''), ''),
      };
      return payload;
    }

    case 'guards':
      return {
        action: asString(getOption(options, 'action', ''), ''),
        scope: asString(getOption(options, 'scope', ''), ''),
        patternType: asString(getOption(options, 'pattern-type', getOption(options, 'type', '')), ''),
        eventType: asString(getOption(options, 'event-type', ''), ''),
        sourcePattern: asString(getOption(options, 'source-pattern', ''), ''),
        sourceClaim: asString(getOption(options, 'source-claim', ''), ''),
        active: getOption(options, 'active', null) === null
          ? null
          : String(getOption(options, 'active')).toLowerCase() !== 'false',
        includeExpired: (() => {
          const raw = getOption(options, 'include-expired', false);
          if (raw === true) return true;
          if (typeof raw === 'string') {
            const normalized = raw.trim().toLowerCase();
            return normalized === 'true' || normalized === '1' || normalized === 'yes';
          }
          return false;
        })(),
        limit: asNumber(getOption(options, 'limit', null), null),
      };

    case 'guard-activate':
    case 'guard-deactivate':
      return {
        guardId: asString(getOption(options, 'id', getOption(options, 'guard-id', '')), ''),
      };

    case 'update':
      return {
        claimId: asString(getOption(options, 'id', getOption(options, 'claim-id', '')), ''),
        status: asString(getOption(options, 'status', ''), ''),
        changedBy: asString(getOption(options, 'by', getOption(options, 'changed-by', '')), ''),
        reason: asString(getOption(options, 'reason', ''), ''),
      };

    case 'deprecate':
      return {
        claimId: asString(getOption(options, 'id', getOption(options, 'claim-id', '')), ''),
        changedBy: asString(getOption(options, 'by', getOption(options, 'changed-by', '')), ''),
        reason: asString(getOption(options, 'reason', 'deprecated_by_user'), 'deprecated_by_user'),
      };

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
  const requestId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  const allowedCommands = new Set([
    'create',
    'query',
    'search',
    'support',
    'challenge',
    'abstain',
    'consensus',
    'beliefs',
    'contradictions',
    'snapshot',
    'pattern-create',
    'patterns',
    'pattern-activate',
    'pattern-deactivate',
    'guard-create',
    'guards',
    'guard-activate',
    'guard-deactivate',
    'update',
    'deprecate',
  ]);
  if (!allowedCommands.has(command)) {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  const payload = buildPayload(command, options, positional);
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
  console.error(`hm-claim failed: ${err.message}`);
  process.exit(1);
});
