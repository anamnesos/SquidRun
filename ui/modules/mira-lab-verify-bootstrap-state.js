'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 'squidrun.mira_lab_verify.bootstrap.v1';
const DEFAULT_RELATIVE_PATH = path.join('runtime', 'mira-lab-verify-bootstrap.json');
const READY = 'ready';
const STALE_STATUSES = Object.freeze([
  'unknown',
  'not_attempted',
  'action_not_loaded_in_running_main',
  'app_control_unreachable',
  'open_failed',
]);

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveStatePath(options = {}) {
  if (options.statePath) return path.resolve(String(options.statePath));
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  return path.join(projectRoot, '.squidrun', DEFAULT_RELATIVE_PATH);
}

function defaultStaleState() {
  return {
    schema: SCHEMA,
    bootstrap_status: 'unknown',
    prompt_path_status: 'unknown',
    last_verified_at: null,
    last_run: null,
  };
}

function readBootstrapState(options = {}) {
  const statePath = resolveStatePath(options);
  if (!fs.existsSync(statePath)) return defaultStaleState();
  try {
    const raw = String(fs.readFileSync(statePath, 'utf8') || '');
    if (!raw.trim()) return defaultStaleState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultStaleState();
    return {
      schema: trimText(parsed.schema) || SCHEMA,
      bootstrap_status: trimText(parsed.bootstrap_status) || 'unknown',
      prompt_path_status: trimText(parsed.prompt_path_status) || 'unknown',
      last_verified_at: trimText(parsed.last_verified_at) || null,
      last_run: parsed.last_run && typeof parsed.last_run === 'object' ? parsed.last_run : null,
    };
  } catch (_) {
    return defaultStaleState();
  }
}

function writeBootstrapState(state, options = {}) {
  const statePath = resolveStatePath(options);
  const payload = {
    schema: SCHEMA,
    bootstrap_status: trimText(state?.bootstrap_status) || 'unknown',
    prompt_path_status: trimText(state?.prompt_path_status) || 'unknown',
    last_verified_at: trimText(state?.last_verified_at) || new Date().toISOString(),
    last_run: state?.last_run && typeof state.last_run === 'object' ? state.last_run : null,
  };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, statePath);
    return { ok: true, statePath, payload };
  } catch (err) {
    return { ok: false, statePath, error: err && err.message ? err.message : String(err) };
  }
}

function deriveStateFromVerifierResult(verifierResult = {}) {
  const promptsArray = Array.isArray(verifierResult.prompts) ? verifierResult.prompts : [];
  const allPromptsPass = promptsArray.length > 0 && promptsArray.every((entry) => entry && entry.decision === 'pass');
  const promptPathStatus = allPromptsPass ? 'complete' : 'incomplete';
  const bootstrapStatus = trimText(verifierResult.bootstrap_status) || 'unknown';
  const rendererOk = Boolean(verifierResult?.renderer_window_open?.ok);
  return {
    schema: SCHEMA,
    bootstrap_status: bootstrapStatus,
    prompt_path_status: promptPathStatus,
    last_verified_at: trimText(verifierResult.started_at) || new Date().toISOString(),
    last_run: {
      session_id: trimText(verifierResult.session_id) || null,
      all_pass: Boolean(verifierResult.all_pass),
      renderer_window_open_ok: rendererOk,
      windows_libuv_teardown_observed: promptsArray.some((entry) => entry && entry.windows_libuv_teardown_observed === true),
    },
  };
}

function isStaleBootstrapState(state) {
  if (!state || typeof state !== 'object') return true;
  const status = trimText(state.bootstrap_status).toLowerCase();
  if (!status) return true;
  if (status === READY) return false;
  return STALE_STATUSES.includes(status) || status !== READY;
}

function formatStartupStaleMarker(state) {
  if (!isStaleBootstrapState(state)) return '';
  const status = trimText(state?.bootstrap_status) || 'unknown';
  const promptPath = trimText(state?.prompt_path_status) || 'unknown';
  const lastVerifiedAt = trimText(state?.last_verified_at) || 'never';
  const promptPathLabel = promptPath === 'complete' ? 'PASS' : promptPath.toUpperCase();
  const headingScope = promptPath === 'complete' ? '(window-open only)' : '(prompt-path and window-open)';
  return [
    `## Mira Lab Verifier Bootstrap: stale ${headingScope}`,
    '',
    `- prompt_path: ${promptPathLabel}; window_open bootstrap stale (status=${status}, last_verified_at=${lastVerifiedAt}).`,
    '- After next main-process start, run: `node ui/scripts/hm-mira-lab-verify.js --session-id verify-post-restart-mira-lab --json`.',
    '- Expected post-restart proof: bootstrap_status=ready, renderer_window_open.ok=true, all_pass=true.',
    '- This block clears automatically when the verifier records bootstrap_status=ready.',
  ].join('\n');
}

module.exports = {
  DEFAULT_RELATIVE_PATH,
  READY,
  SCHEMA,
  STALE_STATUSES,
  defaultStaleState,
  deriveStateFromVerifierResult,
  formatStartupStaleMarker,
  isStaleBootstrapState,
  readBootstrapState,
  resolveStatePath,
  writeBootstrapState,
};
