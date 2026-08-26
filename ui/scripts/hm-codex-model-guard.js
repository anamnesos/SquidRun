#!/usr/bin/env node

const path = require('node:path');

const {
  MAIN_ORACLE_CODEX_POLICY,
  SOURCE_PROJECT_ROOT,
} = require('../modules/codex-seat-model-policy');
const {
  appendGuardTrace,
  evaluateOracleModelGuard,
  hookResponseFor,
} = require('../modules/codex-live-model-guard');
const {
  installOracleModelGuardHooks,
} = require('../modules/codex-model-guard-hooks');

function parseArgs(argv = []) {
  const parsed = { command: 'check' };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) parsed.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    parsed[key] = args[index + 1] || '';
    index += 1;
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('error', () => resolve(''));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.resume();
  });
}

function parsePayload(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function runCheck(args = {}, runtime = {}) {
  const expectedModel = MAIN_ORACLE_CODEX_POLICY.model;
  const expectedEffort = MAIN_ORACLE_CODEX_POLICY.effort;
  const raw = Object.prototype.hasOwnProperty.call(runtime, 'raw')
    ? runtime.raw
    : await readStdin();
  const payload = parsePayload(raw);
  const expectedInstallRootInput = typeof args.expectedInstallRoot === 'string'
    ? args.expectedInstallRoot.trim()
    : '';
  if (!expectedInstallRootInput) {
    const result = {
      applicable: true,
      ok: false,
      reason: 'expected_install_root_required',
    };
    return { payload, result, response: hookResponseFor(result, payload) };
  }
  const expectedInstallRoot = path.resolve(expectedInstallRootInput);
  let result;
  try {
    result = evaluateOracleModelGuard(payload, {
      expectedInstallRoot,
      guardInstallRoot: runtime.guardInstallRoot || SOURCE_PROJECT_ROOT,
      expectedModel,
      expectedEffort,
      env: runtime.env || process.env,
      ...(args.codexSessionRoot ? { codexSessionRoot: args.codexSessionRoot } : {}),
      ...(args.bindingStorePath ? { bindingStorePath: args.bindingStorePath } : {}),
      ...(runtime.fsImpl ? { fsImpl: runtime.fsImpl } : {}),
      ...(runtime.platform ? { platform: runtime.platform } : {}),
    });
  } catch (error) {
    result = {
      applicable: true,
      ok: false,
      reason: 'model_guard_threw',
      error: error?.message || String(error),
    };
  }
  if (result.applicable !== true) {
    return { payload, result, response: hookResponseFor(result, payload) };
  }
  const tracePath = path.resolve(
    args.trace
    || path.join(expectedInstallRoot, '.squidrun', 'runtime', 'oracle-model-guard.jsonl')
  );
  const writeTrace = runtime.appendTrace || appendGuardTrace;
  const trace = writeTrace(tracePath, result, payload, {
    expectedModel,
    expectedEffort,
    ...(runtime.fsImpl ? { fsImpl: runtime.fsImpl } : {}),
  });
  if (result.applicable === true && trace?.ok !== true) {
    result = {
      ...result,
      ok: false,
      reason: 'guard_trace_write_failed',
      priorReason: result.reason || null,
      traceError: trace?.error || null,
    };
  }
  return { payload, result, response: hookResponseFor(result, payload) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'install') {
    const result = installOracleModelGuardHooks({
      installRoot: SOURCE_PROJECT_ROOT,
      ...(args.codexHome ? { codexHome: args.codexHome } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args.command !== 'check') {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'command_unknown' })}\n`);
    process.exitCode = 1;
    return;
  }
  const checked = await runCheck(args);
  process.stdout.write(`${JSON.stringify(checked.response)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const reason = `MODEL DRIFT: Oracle model guard failed closed (${error?.message || String(error)})`;
    process.stdout.write(`${JSON.stringify({
      continue: false,
      stopReason: 'model_guard_threw',
      systemMessage: reason,
    })}\n`);
  });
}

module.exports = {
  main,
  parseArgs,
  parsePayload,
  runCheck,
};
