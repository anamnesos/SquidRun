#!/usr/bin/env node
'use strict';

const { planPaneMessage } = require('./hm-send-adapter');

function parseArgs(argv = []) {
  const parsed = {
    dryRun: true,
    evidence: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--send') {
      parsed.send = true;
      continue;
    }
    if (token === '--target' && next) {
      parsed.targetRole = next;
      index += 1;
      continue;
    }
    if (token === '--content' && next) {
      parsed.content = next;
      index += 1;
      continue;
    }
    if (token === '--session-id' && next) {
      parsed.sessionId = next;
      index += 1;
      continue;
    }
    if (token === '--message-id' && next) {
      parsed.messageId = next;
      index += 1;
      continue;
    }
    if (token === '--request-id' && next) {
      parsed.requestId = next;
      index += 1;
      continue;
    }
    if (token === '--timestamp-ms' && next) {
      parsed.timestampMs = Number(next);
      index += 1;
      continue;
    }
    if (token === '--evidence-file' && next) {
      parsed.evidence.push({
        kind: 'file',
        path: next,
      });
      index += 1;
      continue;
    }

    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_request' });
  }

  return parsed;
}

function errorPayload(error, overrides = {}) {
  return {
    ok: false,
    error: {
      code: error?.code || overrides.code || 'invalid_request',
      message: error?.message || String(error || 'invalid request'),
      retryable: false,
    },
  };
}

function run(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);

  if (args.send) {
    return {
      statusCode: 1,
      payload: {
        ok: false,
        error: {
          code: 'send_not_supported_v0',
          message: 'Mira hm-send adapter v0 only supports --dry-run planning.',
          retryable: false,
        },
      },
    };
  }

  const plan = planPaneMessage({
    targetRole: args.targetRole,
    content: args.content,
    sessionId: args.sessionId,
    messageId: args.messageId,
    requestId: args.requestId,
    timestampMs: args.timestampMs,
    evidence: args.evidence,
  }, {
    cwd: options.cwd || process.cwd(),
  });

  return {
    statusCode: 0,
    payload: plan,
  };
}

function main() {
  try {
    const result = run(process.argv.slice(2), { cwd: process.cwd() });
    process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
    process.exit(result.statusCode);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  run,
};
