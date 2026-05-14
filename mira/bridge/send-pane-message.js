#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
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

  if (args.send) {
    const execute = options.spawnSync || spawnSync;
    const result = execute(plan.command.executable, plan.command.args, {
      cwd: plan.command.cwd,
      input: plan.command.stdin,
      encoding: 'utf8',
      windowsHide: true,
    });
    const exitCode = Number.isInteger(result?.status) ? result.status : 1;
    return {
      statusCode: exitCode,
      payload: {
        ok: exitCode === 0,
        dryRun: false,
        protocol: plan.protocol,
        message_id: plan.message_id,
        session_id: plan.session_id,
        delivery: {
          status: exitCode === 0 ? 'hm_send_completed' : 'hm_send_failed',
          target_role: plan.delivery.target_role,
          target_pane_id: plan.delivery.target_pane_id,
          channel: 'hm-send',
          transport: 'ui/scripts/hm-send.js',
          exit_code: exitCode,
          signal: result?.signal || null,
        },
        envelope: plan.envelope,
        command: plan.command,
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
        error: result?.error ? String(result.error.message || result.error) : null,
      },
    };
  }

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
