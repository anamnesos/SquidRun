'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const MIRA_PROGRESS_PROOF_INPUTS_SCHEMA = 'squidrun.mira.progress_proof_inputs.v0';
const DEFAULT_PROGRESS_PROOF_RELATIVE_PATH = path.join(
  '.squidrun',
  'runtime',
  'mira-progress-proof-inputs-v0.json'
);
const VISIBLE_PRESENCE_A0_PROOF_KEY = 'mira-presence-runtime-acceptance.test.js';
const VISIBLE_PRESENCE_A0_TEST_COMMAND = 'npm --prefix ui test -- mira-presence-runtime-acceptance.test.js --runInBand';
const STARTUP_ACCOUNTING_PROOF_KEY = 'startup-ai-briefing.test.js';
const STARTUP_ACCOUNTING_TEST_COMMAND = 'npm --prefix ui test -- --runTestsByPath __tests__/startup-ai-briefing.test.js --runInBand';
const RESTART_VERIFIER_PROOF_KEY = 'hm-restart-verify';
const RESTART_VERIFIER_TEST_COMMAND = 'node ui/scripts/hm-restart-verify.js --no-send --json --timeout-ms 15000';
const LIVE_WHAT_NOW_PROOF_KEY = 'mira-live-what-now-answer-v0.test.js';
const LIVE_WHAT_NOW_TEST_COMMAND = 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-what-now-answer-v0.test.js --runInBand';
const INTERNAL_REQUEST_DRAFT_PROOF_KEY = 'mira-live-internal-request-draft-v0.test.js';
const INTERNAL_REQUEST_DRAFT_TEST_COMMAND = 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-internal-request-draft-v0.test.js --runInBand';
const INTERNAL_HANDOFF_PREVIEW_PROOF_KEY = 'mira-live-internal-handoff-preview-v0.test.js';
const INTERNAL_HANDOFF_PREVIEW_TEST_COMMAND = 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-internal-handoff-preview-v0.test.js --runInBand';
const LOCAL_TEXT_UI_SURFACE_PROOF_KEY = 'mira-local-text-ui-surface.test.js';
const LOCAL_TEXT_UI_SURFACE_TEST_COMMAND = 'npm --prefix ui test -- --runTestsByPath __tests__/mira-local-text-ui-surface.test.js --runInBand';
const DEFAULT_PROGRESS_PROOF_COMMANDS = Object.freeze([
  Object.freeze({
    proof_key: VISIBLE_PRESENCE_A0_PROOF_KEY,
    command: VISIBLE_PRESENCE_A0_TEST_COMMAND,
    pass_reason: 'visible Presence/A0 acceptance harness passed',
    fail_reason: 'visible Presence/A0 acceptance harness failed',
  }),
  Object.freeze({
    proof_key: STARTUP_ACCOUNTING_PROOF_KEY,
    command: STARTUP_ACCOUNTING_TEST_COMMAND,
    pass_reason: 'startup/current-scope accounting harness passed',
    fail_reason: 'startup/current-scope accounting harness failed',
  }),
  Object.freeze({
    proof_key: RESTART_VERIFIER_PROOF_KEY,
    command: RESTART_VERIFIER_TEST_COMMAND,
    pass_reason: 'restart verifier probe passed without send',
    fail_reason: 'restart verifier probe failed',
  }),
  Object.freeze({
    proof_key: LIVE_WHAT_NOW_PROOF_KEY,
    command: LIVE_WHAT_NOW_TEST_COMMAND,
    pass_reason: 'A1 live what-now acceptance harness passed',
    fail_reason: 'A1 live what-now acceptance harness failed',
  }),
  Object.freeze({
    proof_key: INTERNAL_REQUEST_DRAFT_PROOF_KEY,
    command: INTERNAL_REQUEST_DRAFT_TEST_COMMAND,
    pass_reason: 'A2 internal-request draft acceptance harness passed',
    fail_reason: 'A2 internal-request draft acceptance harness failed',
  }),
  Object.freeze({
    proof_key: INTERNAL_HANDOFF_PREVIEW_PROOF_KEY,
    command: INTERNAL_HANDOFF_PREVIEW_TEST_COMMAND,
    pass_reason: 'A2-to-A3 internal handoff preview harness passed',
    fail_reason: 'A2-to-A3 internal handoff preview harness failed',
  }),
  Object.freeze({
    proof_key: LOCAL_TEXT_UI_SURFACE_PROOF_KEY,
    command: LOCAL_TEXT_UI_SURFACE_TEST_COMMAND,
    pass_reason: 'local text surface A1/A2/handoff-preview acceptance harness passed',
    fail_reason: 'local text surface A1/A2/handoff-preview acceptance harness failed',
  }),
]);
const DEFAULT_TIMEOUT_MS = 120_000;

const PASS_STATUSES = new Set(['pass', 'passed', 'green', 'ok']);
const FAIL_STATUSES = new Set(['fail', 'failed', 'red', 'blocked']);
const STALE_STATUSES = new Set(['stale', 'degraded']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || key === 'canonical_hash') continue;
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function sha256Text(text = '') {
  return `sha256:${crypto.createHash('sha256').update(String(text || '')).digest('hex')}`;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (PASS_STATUSES.has(status)) return 'PASS';
  if (FAIL_STATUSES.has(status)) return 'FAIL';
  if (STALE_STATUSES.has(status)) return 'STALE';
  if (status === 'unknown' || status === 'missing') return 'UNKNOWN';
  return status ? status.toUpperCase() : 'UNKNOWN';
}

function resolveProjectRoot(options = {}) {
  return path.resolve(String(options.projectRoot || process.cwd()));
}

function normalizeRelative(projectRoot, filePath) {
  if (!filePath) return null;
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') ? relative : filePath.replace(/\\/g, '/');
}

function resolveDefaultProgressProofPath(projectRoot) {
  return path.join(projectRoot, DEFAULT_PROGRESS_PROOF_RELATIVE_PATH);
}

function resolveProgressProofPath(options = {}) {
  if (options.progressProofPath || options.proofPath) {
    return path.resolve(String(options.progressProofPath || options.proofPath));
  }
  return resolveDefaultProgressProofPath(resolveProjectRoot(options));
}

function normalizeHeadMetadata(head = {}) {
  if (!head || typeof head !== 'object') {
    return {
      present: false,
      source_kind: 'missing_head_metadata',
      full_sha: null,
      short_sha: null,
      committed_at: null,
      committed_at_ms: null,
      subject: null,
    };
  }
  const committedAtMs = Date.parse(String(head.committed_at || head.committedAt || ''));
  const fullSha = head.full_sha || head.fullSha || head.sha || null;
  const shortSha = head.short_sha || head.shortSha || (fullSha ? String(fullSha).slice(0, 8) : null);
  return {
    present: head.present !== false && Boolean(fullSha || shortSha || Number.isFinite(committedAtMs)),
    source_kind: head.source_kind || head.sourceKind || 'provided_head_metadata',
    full_sha: fullSha,
    short_sha: shortSha,
    committed_at: Number.isFinite(committedAtMs) ? new Date(committedAtMs).toISOString() : null,
    committed_at_ms: Number.isFinite(committedAtMs) ? committedAtMs : null,
    subject: head.subject || null,
  };
}

function readGitHeadMetadata(projectRoot = process.cwd()) {
  try {
    const stdout = execFileSync(
      'git',
      ['show', '-s', '--format=%H%n%h%n%cI%n%s', 'HEAD'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const [fullSha, shortSha, committedAt, ...subjectParts] = String(stdout || '').trim().split(/\r?\n/);
    return normalizeHeadMetadata({
      present: Boolean(shortSha || fullSha),
      source_kind: 'git_head',
      full_sha: fullSha || null,
      short_sha: shortSha || null,
      committed_at: committedAt || null,
      subject: subjectParts.join('\n').trim() || null,
    });
  } catch (error) {
    return {
      present: false,
      source_kind: 'git_head',
      decision: 'head_metadata_unavailable',
      error: error && error.message ? error.message : String(error),
      full_sha: null,
      short_sha: null,
      committed_at: null,
      committed_at_ms: null,
      subject: null,
    };
  }
}

function summarizePorcelainStatus(stdout = '') {
  const lines = String(stdout || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const byCode = {};
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    byCode[code] = (byCode[code] || 0) + 1;
    if (code === '??') {
      untracked += 1;
      continue;
    }
    if (code[0] && code[0] !== ' ') staged += 1;
    if (code[1] && code[1] !== ' ') unstaged += 1;
  }
  return {
    dirty_count: lines.length,
    staged_count: staged,
    unstaged_count: unstaged,
    untracked_count: untracked,
    by_code: byCode,
  };
}

function normalizeWorktreeState(worktree = {}) {
  if (!worktree || typeof worktree !== 'object') {
    return {
      present: false,
      source_kind: 'missing_worktree_metadata',
      clean: null,
      dirty_count: null,
      summary: null,
      status_sha256: null,
    };
  }
  const summary = worktree.summary && typeof worktree.summary === 'object'
    ? worktree.summary
    : {};
  const dirtyCount = Number.isFinite(Number(worktree.dirty_count))
    ? Number(worktree.dirty_count)
    : (Number.isFinite(Number(summary.dirty_count)) ? Number(summary.dirty_count) : null);
  const clean = typeof worktree.clean === 'boolean'
    ? worktree.clean
    : (Number.isFinite(dirtyCount) ? dirtyCount === 0 : null);
  return {
    present: worktree.present !== false,
    source_kind: worktree.source_kind || worktree.sourceKind || 'provided_worktree_metadata',
    clean,
    dirty_count: dirtyCount,
    summary: Object.keys(summary).length > 0 ? summary : null,
    status_sha256: worktree.status_sha256 || worktree.statusSha256 || null,
  };
}

function readGitWorktreeState(projectRoot = process.cwd()) {
  try {
    const stdout = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const summary = summarizePorcelainStatus(stdout);
    return normalizeWorktreeState({
      present: true,
      source_kind: 'git_status_porcelain_v1',
      clean: summary.dirty_count === 0,
      dirty_count: summary.dirty_count,
      summary,
      status_sha256: sha256Text(stdout),
    });
  } catch (error) {
    return {
      present: false,
      source_kind: 'git_status_porcelain_v1',
      clean: null,
      dirty_count: null,
      summary: null,
      status_sha256: null,
      decision: 'worktree_status_unavailable',
      error: error && error.message ? error.message : String(error),
    };
  }
}

function headsMatch(proofHead = {}, currentHead = {}) {
  const proof = normalizeHeadMetadata(proofHead);
  const current = normalizeHeadMetadata(currentHead);
  if (!current.present) return { status: 'UNKNOWN', reason: 'current_head_metadata_unavailable' };
  if (!proof.present) return { status: 'UNKNOWN', reason: 'proof_head_metadata_missing' };

  if (proof.full_sha && current.full_sha) {
    return proof.full_sha === current.full_sha
      ? { status: 'PASS', reason: 'proof_head_matches_current_head' }
      : { status: 'STALE', reason: 'proof_head_mismatch' };
  }
  if (proof.short_sha && current.short_sha) {
    return proof.short_sha === current.short_sha
      ? { status: 'PASS', reason: 'proof_head_matches_current_head' }
      : { status: 'STALE', reason: 'proof_head_mismatch' };
  }
  if (Number.isFinite(proof.committed_at_ms) && Number.isFinite(current.committed_at_ms)) {
    return proof.committed_at_ms === current.committed_at_ms
      ? { status: 'PASS', reason: 'proof_head_commit_time_matches_current_head' }
      : { status: 'STALE', reason: 'proof_head_commit_time_mismatch' };
  }
  return { status: 'UNKNOWN', reason: 'proof_head_metadata_incomparable' };
}

function worktreesAllowPass(proofWorktree = {}, currentWorktree = {}) {
  const proof = normalizeWorktreeState(proofWorktree);
  const current = normalizeWorktreeState(currentWorktree);
  if (!proof.present || typeof proof.clean !== 'boolean') {
    return { status: 'UNKNOWN', reason: 'proof_worktree_metadata_missing' };
  }
  if (!current.present || typeof current.clean !== 'boolean') {
    return { status: 'UNKNOWN', reason: 'current_worktree_metadata_unavailable' };
  }
  if (proof.clean !== true) return { status: 'STALE', reason: 'proof_worktree_dirty' };
  if (current.clean !== true) return { status: 'STALE', reason: 'current_worktree_dirty' };
  return { status: 'PASS', reason: 'proof_and_current_worktree_clean' };
}

function summarizeOutput(text = '', maxChars = 1200) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function defaultRunCommand(command, projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const stdout = execSync(command, {
      cwd: projectRoot,
      env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error?.status) ? error.status : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
    };
  }
}

function normalizeProofCommands(commands = []) {
  return (Array.isArray(commands) ? commands : [])
    .map((entry) => {
      const proofKey = String(entry?.proof_key || entry?.proofKey || '').trim();
      const command = String(entry?.command || '').trim();
      if (!proofKey || !command) return null;
      return {
        proof_key: proofKey,
        command,
        pass_reason: entry.pass_reason || entry.passReason || `${proofKey} passed`,
        fail_reason: entry.fail_reason || entry.failReason || `${proofKey} failed`,
      };
    })
    .filter(Boolean);
}

function buildProgressProofArtifact(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const generatedAt = options.generatedAt
    || new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const runner = typeof options.runner === 'function'
    ? options.runner
    : (cmd, root) => defaultRunCommand(cmd, root, timeoutMs);
  const currentHead = normalizeHeadMetadata(options.head || readGitHeadMetadata(projectRoot));
  const currentWorktree = normalizeWorktreeState(options.worktreeState || readGitWorktreeState(projectRoot));
  const proofCommands = normalizeProofCommands(options.proofCommands || DEFAULT_PROGRESS_PROOF_COMMANDS);
  const proofs = {};

  for (const proofCommand of proofCommands) {
    const run = runner(proofCommand.command, projectRoot, {
      timeoutMs,
      proofKey: proofCommand.proof_key,
    });
    const status = run && run.ok === true ? 'PASS' : 'FAIL';
    proofs[proofCommand.proof_key] = {
      status,
      generated_at: generatedAt,
      proof_key: proofCommand.proof_key,
      command: proofCommand.command,
      source_ref: proofCommand.command,
      reason: status === 'PASS' ? proofCommand.pass_reason : proofCommand.fail_reason,
      head: currentHead,
      worktree: currentWorktree,
      exit_code: Number.isInteger(run?.exitCode) ? run.exitCode : (status === 'PASS' ? 0 : 1),
      stdout_excerpt: summarizeOutput(run?.stdout || ''),
      stderr_excerpt: summarizeOutput(run?.stderr || ''),
    };
  }

  const artifact = {
    schema: MIRA_PROGRESS_PROOF_INPUTS_SCHEMA,
    version: 1,
    generated_at: generatedAt,
    source_kind: 'generated_progress_proof_artifact',
    head: currentHead,
    worktree: currentWorktree,
    proofs,
  };
  artifact.canonical_hash = stableHash(artifact);
  return artifact;
}

function buildVisiblePresenceProofArtifact(options = {}) {
  return buildProgressProofArtifact({
    ...options,
    proofCommands: [{
      proof_key: VISIBLE_PRESENCE_A0_PROOF_KEY,
      command: options.command || VISIBLE_PRESENCE_A0_TEST_COMMAND,
      pass_reason: 'visible Presence/A0 acceptance harness passed',
      fail_reason: 'visible Presence/A0 acceptance harness failed',
    }],
  });
}

function writeProgressProofArtifact(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const proofPath = resolveProgressProofPath({ ...options, projectRoot });
  const artifact = buildProgressProofArtifact({ ...options, projectRoot });
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return {
    ok: Object.values(artifact.proofs || {}).every((proof) => proof.status === 'PASS'),
    proofPath,
    source_ref: normalizeRelative(projectRoot, proofPath),
    artifact,
  };
}

function writeVisiblePresenceProofArtifact(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const proofPath = resolveProgressProofPath({ ...options, projectRoot });
  const artifact = buildVisiblePresenceProofArtifact({ ...options, projectRoot });
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return {
    ok: artifact.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY].status === 'PASS',
    proofPath,
    source_ref: normalizeRelative(projectRoot, proofPath),
    artifact,
  };
}

function readProgressProofArtifact(proofPath) {
  try {
    if (!proofPath || !fs.existsSync(proofPath)) {
      return { ok: false, status: 'missing', proofPath };
    }
    const artifact = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      return { ok: false, status: 'invalid_json_shape', proofPath };
    }
    if (artifact.schema !== MIRA_PROGRESS_PROOF_INPUTS_SCHEMA) {
      return { ok: false, status: 'schema_mismatch', proofPath, artifact };
    }
    return { ok: true, status: 'loaded', proofPath, artifact };
  } catch (error) {
    return {
      ok: false,
      status: 'invalid_json',
      proofPath,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function materializeProofEntry({ key, entry, artifact, currentHead, currentWorktree, projectRoot, proofPath }) {
  const rawStatus = normalizeStatus(entry?.status || entry?.result || entry?.outcome);
  const sourceRef = normalizeRelative(projectRoot, proofPath);
  const command = entry?.command || entry?.source_ref || entry?.sourceRef || key;
  const base = {
    key,
    status: rawStatus,
    source_ref: sourceRef,
    command,
    generated_at: entry?.generated_at || entry?.generatedAt || artifact.generated_at || null,
    reason: entry?.reason || null,
    artifact_schema: artifact.schema,
    artifact_hash: artifact.canonical_hash || null,
    artifact_head: entry?.head || artifact.head || null,
    artifact_worktree: entry?.worktree || artifact.worktree || null,
    current_head: normalizeHeadMetadata(currentHead),
    current_worktree: normalizeWorktreeState(currentWorktree),
  };

  if (rawStatus !== 'PASS') {
    return {
      ...base,
      status: rawStatus,
      reason: base.reason || `proof artifact reported ${rawStatus}`,
    };
  }

  const freshness = headsMatch(entry?.head || artifact.head, currentHead);
  if (freshness.status !== 'PASS') {
    return {
      ...base,
      status: freshness.status,
      reason: freshness.reason,
    };
  }
  const worktreeFreshness = worktreesAllowPass(entry?.worktree || artifact.worktree, currentWorktree);
  return {
    ...base,
    status: worktreeFreshness.status,
    reason: worktreeFreshness.status === 'PASS'
      ? (base.reason || 'proof artifact matches current HEAD and clean worktree')
      : worktreeFreshness.reason,
  };
}

function readDefaultProgressProofInputs(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const proofPath = resolveProgressProofPath({ ...options, projectRoot });
  const sourceRef = normalizeRelative(projectRoot, proofPath);
  const read = readProgressProofArtifact(proofPath);
  const currentHead = normalizeHeadMetadata(options.head || readGitHeadMetadata(projectRoot));
  const currentWorktree = normalizeWorktreeState(options.worktreeState || readGitWorktreeState(projectRoot));

  if (!read.ok) {
    return {
      present: false,
      status: read.status,
      source_ref: sourceRef,
      proofPath,
      inputSignals: {},
      warnings: read.status === 'missing' ? [] : [`progress_proof_inputs_${read.status}`],
    };
  }

  const proofs = {};
  const artifactProofs = read.artifact.proofs && typeof read.artifact.proofs === 'object'
    ? read.artifact.proofs
    : {};
  for (const [key, entry] of Object.entries(artifactProofs)) {
    proofs[key] = materializeProofEntry({
      key,
      entry,
      artifact: read.artifact,
      currentHead,
      currentWorktree,
      projectRoot,
      proofPath,
    });
  }

  const warnings = Array.from(new Set(Object.values(proofs)
    .filter((entry) => ['STALE', 'UNKNOWN'].includes(entry.status) && entry.reason)
    .map((entry) => entry.reason)));

  return {
    present: true,
    status: 'loaded',
    source_ref: sourceRef,
    proofPath,
    artifact: read.artifact,
    inputSignals: { proofs },
    warnings,
  };
}

module.exports = {
  DEFAULT_PROGRESS_PROOF_COMMANDS,
  DEFAULT_PROGRESS_PROOF_RELATIVE_PATH,
  DEFAULT_TIMEOUT_MS,
  INTERNAL_HANDOFF_PREVIEW_PROOF_KEY,
  INTERNAL_HANDOFF_PREVIEW_TEST_COMMAND,
  INTERNAL_REQUEST_DRAFT_PROOF_KEY,
  INTERNAL_REQUEST_DRAFT_TEST_COMMAND,
  LIVE_WHAT_NOW_PROOF_KEY,
  LIVE_WHAT_NOW_TEST_COMMAND,
  LOCAL_TEXT_UI_SURFACE_PROOF_KEY,
  LOCAL_TEXT_UI_SURFACE_TEST_COMMAND,
  MIRA_PROGRESS_PROOF_INPUTS_SCHEMA,
  RESTART_VERIFIER_PROOF_KEY,
  RESTART_VERIFIER_TEST_COMMAND,
  STARTUP_ACCOUNTING_PROOF_KEY,
  STARTUP_ACCOUNTING_TEST_COMMAND,
  VISIBLE_PRESENCE_A0_PROOF_KEY,
  VISIBLE_PRESENCE_A0_TEST_COMMAND,
  buildProgressProofArtifact,
  buildVisiblePresenceProofArtifact,
  headsMatch,
  normalizeHeadMetadata,
  normalizeWorktreeState,
  readDefaultProgressProofInputs,
  readGitHeadMetadata,
  readGitWorktreeState,
  readProgressProofArtifact,
  resolveDefaultProgressProofPath,
  resolveProgressProofPath,
  stableHash,
  summarizePorcelainStatus,
  worktreesAllowPass,
  writeProgressProofArtifact,
  writeVisiblePresenceProofArtifact,
};
