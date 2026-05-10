#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');
const PROMPT_CLI = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-mira-lab-prompt.js');
const APP_CLI = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-app.js');
const DEFAULT_PROMPTS = Object.freeze([
  'what are we doing with Mira?',
  'how are you',
  'smaller',
  'the context just failed and I had to clean up manually AGAIN.',
]);
const SCHEMA = 'squidrun.mira_lab_verify.v1';
const PROOF_NOTE = [
  'Each prompt was evaluated in a fresh Node child process via',
  'hm-mira-lab-prompt.js. The running Electron main-process require cache was',
  'NOT invalidated; the renderer IPC path mira:lab-prompt-reply was NOT',
  'exercised. Window open/focus is delivered through the live app-control',
  'WebSocket; the prompt classifier comes from the on-disk module loaded',
  'fresh in each child.',
].join(' ');

function decisionFromExitCode(code) {
  if (code === 0) return 'pass';
  if (code === 3) return 'fail';
  if (code === 4) return 'blocked';
  return 'error';
}

function pickReplyText(envelope = {}) {
  const reply = envelope.reply || envelope.decision?.reply || envelope.outputs?.reply || null;
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply.text === 'string') return reply.text;
  if (typeof envelope.visible_reply === 'string') return envelope.visible_reply;
  return null;
}

function pickReplySource(envelope = {}) {
  return envelope?.reply?.source
    || envelope?.decision?.reply?.source
    || envelope?.source
    || null;
}

function pickGates(envelope = {}) {
  return envelope?.gates
    || envelope?.decision?.gates
    || envelope?.audit?.gates
    || null;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + (err && err.message ? err.message : String(err)) });
    });
  });
}

function defaultSpawnPromptCli({ prompt, sessionId, projectRoot }) {
  return runChild(process.execPath, [
    PROMPT_CLI,
    '--prompt', prompt,
    '--json',
    '--session-id', sessionId,
    '--project-root', projectRoot,
  ], { cwd: projectRoot });
}

function defaultSpawnAppOpen({ port, role }) {
  const args = [APP_CLI, 'open-mira-lab'];
  if (port) args.push('--port', String(port));
  if (role) args.push('--role', role);
  return runChild(process.execPath, args, {});
}

function parseEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // Prompt CLI may print info lines before the final JSON envelope. Walk
    // backwards through the lines, joining trailing lines, until something
    // parses. The envelope is always the last block.
    const lines = text.split(/\r?\n/);
    for (let start = lines.length - 1; start >= 0; start -= 1) {
      const candidate = lines.slice(start).join('\n').trim();
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
      try {
        return JSON.parse(candidate);
      } catch (_inner) {
        // keep walking
      }
    }
    return null;
  }
}

async function runVerification(options = {}) {
  const startedAt = new Date().toISOString();
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const prompts = Array.isArray(options.prompts) && options.prompts.length > 0
    ? options.prompts
    : DEFAULT_PROMPTS;
  const sessionId = options.sessionId
    || `verify-arch33-${Math.floor(Date.now() / 1000)}`;
  const skipWindowOpen = Boolean(options.skipWindowOpen);
  const spawnAppOpen = typeof options.spawnAppOpen === 'function'
    ? options.spawnAppOpen
    : defaultSpawnAppOpen;
  const spawnPromptCli = typeof options.spawnPromptCli === 'function'
    ? options.spawnPromptCli
    : defaultSpawnPromptCli;

  let rendererWindowOpen = {
    attempted: false,
    ok: false,
    status: 'skipped',
    reason: skipWindowOpen ? 'skipped_by_caller' : null,
  };
  if (!skipWindowOpen) {
    const appResult = await spawnAppOpen({ port: options.port, role: options.role || 'builder' });
    let parsed = null;
    try { parsed = JSON.parse(appResult.stdout || 'null'); } catch (_) { parsed = null; }
    rendererWindowOpen = {
      attempted: true,
      ok: appResult.code === 0 && Boolean(parsed?.success ?? parsed?.ok),
      status: parsed?.status || (appResult.code === 0 ? 'opened' : 'open_failed'),
      reason: parsed?.reason || (appResult.code !== 0 ? `app_control_exit_${appResult.code}` : null),
      raw_exit_code: appResult.code,
    };
  }

  const promptResults = [];
  for (const prompt of prompts) {
    const child = await spawnPromptCli({ prompt, sessionId, projectRoot });
    const envelope = parseEnvelope(child.stdout);
    promptResults.push({
      prompt,
      exit_code: child.code,
      decision: decisionFromExitCode(child.code),
      visible_reply: pickReplyText(envelope || {}),
      source: pickReplySource(envelope || {}),
      gates: pickGates(envelope || {}),
      stderr_excerpt: child.stderr ? String(child.stderr).split(/\r?\n/).slice(-3).join('\n') : '',
    });
  }

  const allPass = promptResults.length > 0 && promptResults.every((entry) => entry.decision === 'pass');

  return {
    schema: SCHEMA,
    verifier: 'hm-mira-lab-verify',
    started_at: startedAt,
    session_id: sessionId,
    renderer_window_open: rendererWindowOpen,
    proof_classification: {
      renderer_proof_via_ipc: false,
      fresh_process_proxy_proof: true,
      note: PROOF_NOTE,
    },
    prompts: promptResults,
    all_pass: allPass,
  };
}

function printHelp() {
  process.stdout.write([
    'hm-mira-lab-verify — drive the Mira Lab verification seam.',
    '',
    'Behavior:',
    '  1. Sends app-control open-mira-lab over WS to focus/open the live window',
    '     (no full app restart).',
    '  2. For each prompt, spawns hm-mira-lab-prompt.js as a child process,',
    '     which loads the on-disk classifier fresh.',
    '  3. Aggregates per-prompt {visible_reply, source, gates, decision}',
    '     and labels proof class: renderer_proof_via_ipc=false,',
    '     fresh_process_proxy_proof=true.',
    '',
    'Usage: hm-mira-lab-verify.js [options]',
    'Options:',
    '  --port <port>           WebSocket port for app-control (default 9900).',
    '  --session-id <id>       Lab session id (default verify-arch33-<unix>).',
    '  --skip-window-open      Skip the open-mira-lab call.',
    '  --json                  Only print the result JSON.',
    '  --help                  Show help.',
    '',
  ].join('\n'));
}

async function main(argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  let port = null;
  let sessionId = null;
  let skipWindowOpen = false;
  let jsonOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--port') port = Number.parseInt(args[++i], 10);
    else if (token === '--session-id') sessionId = args[++i];
    else if (token === '--skip-window-open') skipWindowOpen = true;
    else if (token === '--json') jsonOnly = true;
  }

  const result = await runVerification({ port, sessionId, skipWindowOpen });
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result.all_pass ? 0 : 3;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`hm-mira-lab-verify failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PROMPTS,
  PROOF_NOTE,
  SCHEMA,
  decisionFromExitCode,
  pickReplyText,
  pickReplySource,
  pickGates,
  parseEnvelope,
  runVerification,
};
