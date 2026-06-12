#!/usr/bin/env node

const {
  appendModelPromptReceipt,
  appendTrustCheckBreadcrumb,
  installModelPromptReceiptHooks,
} = require('../modules/model-prompt-receipt');

function parseArgs(argv) {
  const parsed = {
    command: null,
    runtime: null,
    event: null,
    projectRoot: null,
    trustCheckOnly: false,
  };
  if (argv[0] && !argv[0].startsWith('--')) {
    parsed.command = argv[0];
    argv = argv.slice(1);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime') {
      parsed.runtime = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--event' || arg === '--hook-event') {
      parsed.event = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--project-root') {
      parsed.projectRoot = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--trust-check-only') {
      parsed.trustCheckOnly = true;
    }
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return { prompt: raw };
  }
}

function emitHookResponse(result = {}) {
  const response = {
    hookSpecificOutput: {
      hookEventName: result.hookEventName || undefined,
    },
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'install') {
    const result = installModelPromptReceiptHooks({ projectRoot: args.projectRoot || process.cwd() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);

  if (args.trustCheckOnly) {
    const record = appendTrustCheckBreadcrumb({ payload });
    emitHookResponse({ hookEventName: args.event, record });
    return;
  }

  const result = appendModelPromptReceipt({
    runtime: args.runtime,
    hookEventName: args.event,
    payload,
  });
  emitHookResponse({
    hookEventName: args.event,
    status: result.status,
  });
}

main().catch((err) => {
  process.stderr.write(`[model-prompt-receipt-adapter] ${err.stack || err.message}\n`);
  emitHookResponse({ hookEventName: null, status: 'adapter_error' });
  process.exitCode = 0;
});
