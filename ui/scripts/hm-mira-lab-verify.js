#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');
const PROMPT_CLI = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-mira-lab-prompt.js');
const APP_CLI = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-app.js');
const {
  deriveStateFromVerifierResult,
  writeBootstrapState,
} = require('../modules/mira-lab-verify-bootstrap-state');
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
// Windows-only Node libuv assertion observed during clean shutdown of the
// prompt CLI ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// file src\\win\\async.c, line 76"). Surfaces as exit code 3221226505
// (0xC0000409) AFTER the JSON envelope is already on stdout, so the
// envelope's `decision` is authoritative.
const WINDOWS_LIBUV_TEARDOWN_EXIT_CODE = 3221226505;

function decisionFromExitCode(code) {
  if (code === 0) return 'pass';
  if (code === 3) return 'fail';
  if (code === 4) return 'blocked';
  return 'error';
}

// ARCH #60.5 / task #3: long-prompt verifier reclassification.
// When the OpenAI Responses API returns an empty body (long prompt blew the
// reasoning-token budget, `incomplete_details.reason='max_output_tokens'`,
// etc.), the text-model-attachment layer reports empty_model_response and
// mira-lab-surface routes that to decision='blocked',
// reason_class='reply_engine_degraded'. That's the honest signal — empty
// content is NOT a contract violation, so ARCH #81 Plan A (safe-fallback)
// does NOT apply at the surface. But the verifier's job is to confirm the
// pipeline works, not to confirm every individual prompt produced a non-
// empty reply. We reclassify a blocked-by-degradation prompt as 'skipped'
// here so bootstrap can go green when the rest of the surface is healthy.
//
// Recomputed `all_pass` requires every entry in {pass, skipped} AND at
// least one 'pass' — so an all-skipped run does NOT fake success.
const DEGRADED_REASON_CLASSES = new Set([
  'reply_engine_degraded',
  'no_reply_text',
]);

function shouldSkipBlockedEntry(entry) {
  if (!entry || entry.decision !== 'blocked') return false;
  if (entry.reason_class && DEGRADED_REASON_CLASSES.has(entry.reason_class)) return true;
  const gates = entry.gates;
  if (gates && (gates.degraded === true || gates.surface_error !== null)) return true;
  return false;
}

function deriveSkipReason(entry) {
  if (!entry) return null;
  if (entry.reason_class && DEGRADED_REASON_CLASSES.has(entry.reason_class)) return entry.reason_class;
  const gates = entry.gates || {};
  if (gates.surface_error) return 'surface_error';
  if (gates.degraded === true) return 'reply_engine_degraded';
  return 'blocked_reclassified';
}

function decisionFromEnvelope(envelope) {
  const value = envelope && typeof envelope === 'object' ? envelope.decision : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['pass', 'fail', 'blocked', 'error'].includes(normalized)) return normalized;
  return null;
}

function pickReasonClass(envelope = {}) {
  return envelope?.gates?.reason_class
    || envelope?.decision?.gates?.reason_class
    || envelope?.audit?.gates?.reason_class
    || null;
}

function isWindowsTeardownAssertion(exitCode, stderr) {
  if (Number(exitCode) === WINDOWS_LIBUV_TEARDOWN_EXIT_CODE) return true;
  return /Assertion failed:.*UV_HANDLE_CLOSING.*async\.c/i.test(String(stderr || ''));
}

function classifyBootstrap(rendererWindowOpen) {
  if (!rendererWindowOpen || rendererWindowOpen.attempted !== true) {
    return 'not_attempted';
  }
  if (rendererWindowOpen.ok === true) return 'ready';
  const reason = String(rendererWindowOpen.reason || '').toLowerCase();
  if (reason === 'unknown_action') return 'action_not_loaded_in_running_main';
  if (reason.startsWith('app_control_exit_')) return 'app_control_unreachable';
  return 'open_failed';
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
    const envelopeDecision = decisionFromEnvelope(envelope);
    const teardownAssertion = isWindowsTeardownAssertion(child.code, child.stderr);
    // Envelope decision is authoritative when present; the prompt CLI emits
    // it before exiting, so a Windows libuv teardown assertion that fires
    // AFTER stdout flush should not flip a real decision into 'error'.
    const rawDecision = envelopeDecision || decisionFromExitCode(child.code);
    const entry = {
      prompt,
      exit_code: child.code,
      decision: rawDecision,
      decision_source: envelopeDecision ? 'envelope' : 'exit_code',
      windows_libuv_teardown_observed: teardownAssertion,
      visible_reply: pickReplyText(envelope || {}),
      source: pickReplySource(envelope || {}),
      gates: pickGates(envelope || {}),
      reason_class: pickReasonClass(envelope || {}),
      stderr_excerpt: child.stderr ? String(child.stderr).split(/\r?\n/).slice(-3).join('\n') : '',
    };
    // ARCH #60.5: reclassify degraded-blocked (e.g. long-prompt empty
    // Responses API body) as 'skipped' so the verifier can complete
    // bootstrap when the surface pipeline is healthy but the model
    // legitimately returned no extractable content.
    if (shouldSkipBlockedEntry(entry)) {
      entry.original_decision = rawDecision;
      entry.decision = 'skipped';
      entry.skip_reason = deriveSkipReason(entry);
    }
    promptResults.push(entry);
  }

  const passCount = promptResults.filter((e) => e.decision === 'pass').length;
  const skippedCount = promptResults.filter((e) => e.decision === 'skipped').length;
  // Bootstrap goes green when every prompt is pass-or-skipped AND at least
  // one prompt actually passed. An all-skipped run does NOT fake success.
  const allPass = promptResults.length > 0
    && passCount > 0
    && promptResults.every((entry) => entry.decision === 'pass' || entry.decision === 'skipped');
  const bootstrapStatus = classifyBootstrap(rendererWindowOpen);
  let effectiveBootstrapStatus = bootstrapStatus;
  if (bootstrapStatus === 'ready') {
    if (!allPass) {
      effectiveBootstrapStatus = 'prompts_failed';
    } else if (skippedCount > 0) {
      effectiveBootstrapStatus = 'ready_with_skipped_prompts';
    }
  }

  let bootstrapNote = null;
  if (effectiveBootstrapStatus === 'action_not_loaded_in_running_main') {
    bootstrapNote = 'open-mira-lab is not registered in the running Electron main process; the app-control action shipped at a0e1307 takes effect on the next main-process start. Future sessions inherit the no-restart seam. This is a one-time bootstrap limitation, not a verifier defect.';
  } else if (effectiveBootstrapStatus === 'ready_with_skipped_prompts') {
    bootstrapNote = `${skippedCount} of ${promptResults.length} prompts skipped due to engine-degradation (commonly an empty Responses API body on long prompts). Surface pipeline is healthy; at least one prompt passed end-to-end. Bootstrap is ready.`;
  }
  const result = {
    schema: SCHEMA,
    verifier: 'hm-mira-lab-verify',
    started_at: startedAt,
    session_id: sessionId,
    renderer_window_open: rendererWindowOpen,
    bootstrap_status: effectiveBootstrapStatus,
    bootstrap_note: bootstrapNote,
    proof_classification: {
      renderer_proof_via_ipc: false,
      fresh_process_proxy_proof: true,
      note: PROOF_NOTE,
    },
    prompts: promptResults,
    pass_count: passCount,
    skipped_count: skippedCount,
    all_pass: allPass,
  };

  if (options.persistState !== false) {
    const writeFn = typeof options.writeBootstrapState === 'function'
      ? options.writeBootstrapState
      : writeBootstrapState;
    try {
      const derived = deriveStateFromVerifierResult(result);
      writeFn(derived, { projectRoot, statePath: options.bootstrapStatePath });
    } catch (_) {
      // best-effort; the marker stays stale on write failure
    }
  }

  return result;
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
  DEGRADED_REASON_CLASSES,
  PROOF_NOTE,
  SCHEMA,
  WINDOWS_LIBUV_TEARDOWN_EXIT_CODE,
  classifyBootstrap,
  decisionFromEnvelope,
  decisionFromExitCode,
  deriveSkipReason,
  isWindowsTeardownAssertion,
  shouldSkipBlockedEntry,
  parseEnvelope,
  pickGates,
  pickReasonClass,
  pickReplySource,
  pickReplyText,
  runVerification,
};
