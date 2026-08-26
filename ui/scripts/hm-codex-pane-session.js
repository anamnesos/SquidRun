#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { resolveCoordPath } = require('../config');
const {
  captureBinding,
  clearPaneBinding,
  loadValidatedBinding,
} = require('../modules/codex-pane-session-store');

const DEFAULT_STORE_PATH = resolveCoordPath(
  path.join('runtime', 'codex-pane-sessions.json'),
  { forWrite: true }
);
const DEFAULT_RECEIPT_PATH = resolveCoordPath(
  path.join('runtime', 'codex-pane-session-bindings.jsonl'),
  { forWrite: true }
);

function parseArgs(argv) {
  const result = { command: null };
  const args = [...argv];
  if (args.length === 0) {
    result.command = 'capture';
    return result;
  }
  if (args[0] === '--help' || args[0] === '-h') {
    result.command = 'help';
    return result;
  }
  if (args[0].startsWith('--')) {
    result.argumentError = 'command_required_before_options';
    return result;
  }
  result.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[key] = args[index + 1] ?? '';
    index += 1;
  }
  return result;
}

function usage() {
  return [
    'Usage:',
    '  hm-codex-pane-session.js capture [options] < SessionStart.json',
    '  hm-codex-pane-session.js show [options]',
    '  hm-codex-pane-session.js clear [options]',
    '',
    'Commands must precede options. Capture is the default only when no arguments are supplied.',
  ].join('\n');
}

function readPayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.resume();
  });
}

function appendReceipt(receiptPath, record) {
  try {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.appendFileSync(receiptPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // The binder remains best-effort for startup. A receipt failure cannot
    // prevent Codex itself from opening.
  }
}

function receiptFor(command, result, input = {}) {
  return {
    schema: 'squidrun.codex_pane_session_binding_receipt.v1',
    at: new Date().toISOString(),
    command,
    ok: result?.ok === true,
    reason: result?.reason || null,
    paneId: String(input.paneId || '').trim() || null,
    role: String(input.role || '').trim().toLowerCase() || null,
    profile: String(input.profile || '').trim().toLowerCase() || null,
    sessionId: String(input.sessionId || '').trim() || null,
    paneLaunchId: String(input.paneLaunchId || '').trim() || null,
    appGeneration: String(input.appGeneration || '').trim() || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.argumentError) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: args.argumentError })}\n`);
    process.exitCode = 1;
    return;
  }
  const raw = args.command === 'capture' ? await readStdin() : '';
  const payload = readPayload(raw);
  const storePath = args.store || DEFAULT_STORE_PATH;
  const receiptPath = args.receipts || DEFAULT_RECEIPT_PATH;
  const paneId = args.paneId || process.env.SQUIDRUN_PANE_ID;
  const expectedCwd = args.expectedCwd
    || process.env.SQUIDRUN_WORKING_DIR
    || process.env.SQUIDRUN_PROJECT_ROOT;
  const common = {
    paneId,
    role: args.role || process.env.SQUIDRUN_ROLE,
    profile: args.profile || process.env.SQUIDRUN_PROFILE,
    projectRoot: args.projectRoot || process.env.SQUIDRUN_PROJECT_ROOT,
    paneLaunchId: args.paneLaunchId || process.env.SQUIDRUN_PANE_LAUNCH_ID,
    appGeneration: args.appGeneration || process.env.SQUIDRUN_APP_GENERATION,
  };

  let result;
  if (args.command === 'capture') {
    const sessionId = args.sessionId || payload.session_id || payload.sessionId;
    const input = {
      ...common,
      sessionId,
      threadId: args.threadId || payload.thread_id || payload.threadId || sessionId,
      envSessionId: args.envSessionId || process.env.CODEX_SESSION_ID,
      envThreadId: args.envThreadId || process.env.CODEX_THREAD_ID,
      cwd: args.cwd || payload.cwd,
      transcriptPath: args.transcriptPath || payload.transcript_path || payload.transcriptPath,
      expectedCwd,
    };
    result = captureBinding(storePath, input, {
      expectedCwd,
      ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      ...(args.codexSessionRoot ? { codexSessionRoot: args.codexSessionRoot } : {}),
    });
    appendReceipt(receiptPath, receiptFor(args.command, result, input));
  } else if (args.command === 'clear') {
    result = clearPaneBinding(storePath, paneId);
    appendReceipt(receiptPath, receiptFor(args.command, result, common));
  } else if (args.command === 'show') {
    result = loadValidatedBinding(storePath, paneId, {
      expectedCwd,
      ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      ...(args.codexSessionRoot ? { codexSessionRoot: args.codexSessionRoot } : {}),
    });
  } else {
    result = { ok: false, reason: 'command_unknown' };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  // SessionStart capture is deliberately fail-open for Codex availability.
  if (args.command !== 'capture' && result.ok !== true) process.exitCode = 1;
}

main().catch((err) => {
  try {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'binder_threw', message: err.message })}\n`);
  } catch { /* best effort */ }
  process.exitCode = 0;
});
