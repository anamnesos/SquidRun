const fs = require('fs');
const os = require('os');
const path = require('path');

// Restart continuity: id-addressed CLI session resume.
//
// An external SquidRun restart is an uncatchable process-tree kill: the in-flight
// CLI process is unrecoverable. To preserve mid-task state we ask the CLI to
// resume its OWN prior conversation on respawn. Resume MUST be keyed by a
// per-pane id, NEVER by cwd: the 3 core panes all run claude in D:\projects\squidrun
// (paneProjects null) and the 4 TrustQuote arms all run codex in D:\projects\TrustQuote,
// so any cwd-scoped "resume most recent" would cross-wire panes/arms.
//
// Per-CLI strategy, VERIFIED against the installed binaries (claude 2.1.170,
// codex-cli 0.139.0) via --help AND an end-to-end --print probe:
//  - claude: `--session-id <uuid>` pins an id at creation; `-r/--resume <uuid>`
//    resumes that id. Id-addressed => shared-cwd-safe. UUID format is REQUIRED
//    ("Invalid session ID. Must be a valid UUID."). `--session-id` only succeeds
//    the first time it creates the id ("...is already in use." on reuse), so
//    create-vs-resume gates on whether the session already exists.
//  - codex: `codex resume <id>` resumes an exact id. Codex still has no
//    pin-at-creation flag and `--last` is cwd-scoped, so --last is forbidden.
//    SquidRun instead captures the runtime's own exact session id from Codex's
//    SessionStart hook, bound to pane/role/profile/cwd/transcript provenance.
//    That discovered id is safe to resume because shared cwd never selects it.
const CLI_RESUME_STRATEGY = {
  claude: 'session-id', // create-or-resume by per-pane UUID
  codex: 'captured-session-id', // exact hook-captured id only; NEVER --last
};

// LANDMINE: claude `--fork-session` mints a NEW session id when resuming, which
// would break per-pane id stability. It must NEVER appear in a built invocation.
const FORBIDDEN_CLAUDE_FLAGS = ['--fork-session', '-c', '--continue'];
const CLAUDE_RESUME_FLAG_PATTERN = /(?:^|\s)(?:--session-id|--resume)(?:=|\s+)([^\s"']+)/i;
const CLAUDE_MODEL_FLAG_PATTERN = /(?:^|\s)--model(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i;
const CLAUDE_SESSION_IN_USE_PATTERN = /session(?:\s+id)?[^.\n\r]*already\s+in\s+use|already\s+in\s+use[^.\n\r]*session(?:\s+id)?/i;
const CODEX_RESUME_SUBCOMMAND_PATTERN = /(?:^|\s)resume(?:\s+([^\s"']+))?(?=\s|$)/i;
const EXACT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ACTIVE_WRITER_PATTERN = /already\s+has\s+an\s+active\s+writer|active\s+(?:thread\s+)?writer[^\n\r]*(?:in\s+use|locked)|thread[-\s]writer[^\n\r]*(?:in\s+use|locked)/i;
const CODEX_RESUME_MISSING_PATTERN = /no\s+saved\s+session\s+found\s+with\s+id|no\s+rollout\s+found|failed\s+to\s+resume\s+session[^\n\r]*(?:not\s+found|missing|corrupt|malformed|invalid)/i;

// Identify the resume-relevant CLI from the leading executable token only.
// Does NOT default to any CLI: an unrecognized command returns null.
function detectCli(command = '') {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return null;
  const exe = normalized
    .split(/\s+/)[0]
    .split(/[\\/]/).pop()                 // strip any path prefix
    .replace(/\.(exe|cmd|bat|ps1)$/, ''); // strip windows launcher extension
  if (exe === 'claude') return 'claude';
  if (exe === 'codex') return 'codex';
  return null;
}

function resumeStrategyForCommand(command = '') {
  const cli = detectCli(command);
  if (!cli) return 'none';
  return CLI_RESUME_STRATEGY[cli] || 'none';
}

function decideCodexMissingResumeRecovery(clearResult) {
  if (!clearResult || clearResult.ok !== true) {
    return {
      action: 'refuse',
      reason: clearResult?.reason || 'binding_clear_failed',
    };
  }
  if (clearResult.rotated === true) {
    return {
      action: 'hold_rotated',
      reason: 'binding_rotated_during_recovery',
      currentSessionId: clearResult.currentSessionId || null,
    };
  }
  return {
    action: 'retry_cold',
    reason: clearResult.cleared === true
      ? 'rejected_binding_cleared'
      : 'rejected_binding_already_absent',
  };
}

function decideCodexResumeFailureAuthority(input = {}) {
  const candidate = input.candidate === 'active_writer' || input.candidate === 'missing_or_corrupt'
    ? input.candidate
    : null;
  if (!candidate) return { action: 'none', reason: 'no_resume_failure_candidate' };
  if (input.processExited !== true) {
    return { action: 'observe_only', reason: 'process_still_live', candidate };
  }
  if (!Number.isFinite(Number(input.exitCode)) || Number(input.exitCode) === 0) {
    return { action: 'none', reason: 'resume_process_did_not_fail', candidate };
  }
  if (candidate === 'active_writer') {
    return { action: 'hold_active_writer', reason: 'active_writer', candidate };
  }
  if (input.recoveryAttempted === true) {
    return { action: 'none', reason: 'recovery_already_attempted', candidate };
  }
  return { action: 'inspect_binding', reason: 'failed_resume_process_confirmed', candidate };
}

function extractClaudeSessionIdFromCommand(command = '') {
  const match = String(command || '').match(CLAUDE_RESUME_FLAG_PATTERN);
  return match ? match[1] : null;
}

function hasClaudeResumeFlag(command = '') {
  return Boolean(extractClaudeSessionIdFromCommand(command));
}

function stripClaudeResumeFlags(command = '') {
  return String(command || '')
    .replace(/(?:^|\s)(?:--session-id|--resume)(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCodexResumeSessionIdFromCommand(command = '') {
  if (detectCli(command) !== 'codex') return null;
  const match = String(command || '').match(CODEX_RESUME_SUBCOMMAND_PATTERN);
  return match ? (match[1] || null) : null;
}

function hasCodexResumeSubcommand(command = '') {
  return detectCli(command) === 'codex' && CODEX_RESUME_SUBCOMMAND_PATTERN.test(String(command || ''));
}

function stripCodexResumeSubcommand(command = '') {
  const text = String(command || '').trim();
  if (detectCli(text) !== 'codex') return text;
  const match = CODEX_RESUME_SUBCOMMAND_PATTERN.exec(text);
  if (!match) return text;
  return text.slice(0, match.index).trim() || 'codex';
}

function normalizeClaudeModelId(value = '') {
  const cleaned = String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[\d+(?:;\d+)*m\]/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return '';
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(cleaned) ? cleaned : '';
}

function parseClaudeModelFromCommand(command = '') {
  const match = String(command || '').match(CLAUDE_MODEL_FLAG_PATTERN);
  return match ? normalizeClaudeModelId(match[1] || match[2] || match[3] || '') : '';
}

function readClaudeDefaultModel(options = {}) {
  const explicit = normalizeClaudeModelId(options.preferredModel || options.model || '');
  if (explicit) return explicit;

  const env = options.env || process.env;
  const envModel = normalizeClaudeModelId(
    env.SQUIDRUN_CLAUDE_MODEL
    || env.CLAUDE_CODE_MODEL
    || env.ANTHROPIC_MODEL
    || ''
  );
  if (envModel) return envModel;

  try {
    const settingsPath = options.settingsPath
      || path.join(options.homeDir || os.homedir(), '.claude', 'settings.json');
    if (!settingsPath || !fs.existsSync(settingsPath)) return '';
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return normalizeClaudeModelId(parsed?.model || '');
  } catch {
    return '';
  }
}

function ensureClaudeModelFlag(command = '', options = {}) {
  const text = String(command || '').trim();
  if (!text || detectCli(text) !== 'claude') return text;
  const existing = parseClaudeModelFromCommand(text);
  if (existing) return text;

  const model = readClaudeDefaultModel(options);
  return model ? `${text} --model ${model}` : text;
}

function isClaudeSessionInUseError(output = '') {
  return CLAUDE_SESSION_IN_USE_PATTERN.test(String(output || ''));
}

function classifyCodexResumeFailure(output = '') {
  const text = String(output || '');
  if (CODEX_ACTIVE_WRITER_PATTERN.test(text)) return 'active_writer';
  if (CODEX_RESUME_MISSING_PATTERN.test(text)) return 'missing_or_corrupt';
  return null;
}

function advanceCodexResumeFailureBuffer(previous = '', chunk = '', maxBytes = 8192) {
  const cleanChunk = String(chunk || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 8192;
  const buffer = `${String(previous || '')}${cleanChunk}`.slice(-limit);
  return { buffer, failure: classifyCodexResumeFailure(buffer) };
}

// claude session store layout (verified by probe):
//   ~/.claude/projects/<encodedCwd>/<sessionId>.jsonl
// where encodedCwd replaces drive-colon and path separators with '-'
// (D:\projects\squidrun -> D--projects-squidrun).
function encodeClaudeProjectDir(cwd = '') {
  return String(cwd || '').replace(/[:\\/]/g, '-');
}

function claudeSessionStorePath(cwd, sessionId, options = {}) {
  const home = options.homeDir || os.homedir();
  return path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

function claudeSessionExists(cwd, sessionId, options = {}) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(claudeSessionStorePath(cwd, sessionId, options));
  } catch {
    return false;
  }
}

// Pure resolver. Given the pane command, the pane's stable session id, and
// whether a CLI session for that id already exists, return the flags to APPEND
// to the bare pane command plus a structured decision for logging.
//
// Returns one of (claude): `--resume <uuid>` (exists) | `--session-id <uuid>`
// (create) | '' (no id). Never `--continue`, never `--fork-session`.
// Returns `resume <exact-id>` for a validated Codex binding. Never --last.
// Returns '' for a missing/invalid Codex binding and unknown CLIs.
function resolveResumeAppendFlags({ command, sessionId, sessionExists } = {}) {
  const cli = detectCli(command);
  const strategy = cli ? (CLI_RESUME_STRATEGY[cli] || 'none') : 'none';

  if (strategy === 'session-id') {
    const existingSessionId = extractClaudeSessionIdFromCommand(command);
    if (existingSessionId) {
      return {
        flags: '',
        cli,
        strategy,
        mode: 'already-pinned',
        sessionId: existingSessionId,
        reason: 'claude resume/session flag already present',
      };
    }
    if (!sessionId) {
      return { flags: '', cli, strategy, mode: 'cold', reason: 'no per-pane session id available' };
    }
    if (sessionExists) {
      return { flags: `--resume ${sessionId}`, cli, strategy, mode: 'resume', sessionId };
    }
    return { flags: `--session-id ${sessionId}`, cli, strategy, mode: 'create', sessionId };
  }

  if (strategy === 'captured-session-id') {
    if (hasCodexResumeSubcommand(command)) {
      const explicitSessionId = extractCodexResumeSessionIdFromCommand(command);
      if (!EXACT_SESSION_ID_PATTERN.test(String(explicitSessionId || ''))) {
        return {
          flags: '',
          cli,
          strategy,
          mode: 'unsafe-explicit-resume-refused',
          sessionId: null,
          reason: 'codex explicit resume target is not an exact UUID',
        };
      }
      return {
        flags: '',
        cli,
        strategy,
        mode: 'already-pinned',
        sessionId: explicitSessionId,
        reason: 'codex resume subcommand already present',
      };
    }
    if (!sessionId) {
      return {
        flags: '', cli, strategy, mode: 'cold', reason: 'codex exact pane binding absent',
      };
    }
    if (sessionExists !== true) {
      return {
        flags: '', cli, strategy, mode: 'cold', sessionId,
        reason: 'codex exact pane binding is not locally revalidated',
      };
    }
    return {
      flags: `resume ${sessionId}`,
      cli,
      strategy,
      mode: 'resume',
      sessionId,
    };
  }

  // 'none' — unknown CLI.
  return {
    flags: '',
    cli,
    strategy: 'none',
    mode: 'cold',
    reason: 'unknown CLI: bare command (no resume)',
  };
}

module.exports = {
  CLI_RESUME_STRATEGY,
  FORBIDDEN_CLAUDE_FLAGS,
  CLAUDE_RESUME_FLAG_PATTERN,
  CLAUDE_MODEL_FLAG_PATTERN,
  CODEX_RESUME_SUBCOMMAND_PATTERN,
  CODEX_ACTIVE_WRITER_PATTERN,
  CODEX_RESUME_MISSING_PATTERN,
  EXACT_SESSION_ID_PATTERN,
  detectCli,
  decideCodexMissingResumeRecovery,
  decideCodexResumeFailureAuthority,
  resumeStrategyForCommand,
  extractClaudeSessionIdFromCommand,
  hasClaudeResumeFlag,
  stripClaudeResumeFlags,
  extractCodexResumeSessionIdFromCommand,
  hasCodexResumeSubcommand,
  stripCodexResumeSubcommand,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
  readClaudeDefaultModel,
  ensureClaudeModelFlag,
  isClaudeSessionInUseError,
  classifyCodexResumeFailure,
  advanceCodexResumeFailureBuffer,
  encodeClaudeProjectDir,
  claudeSessionStorePath,
  claudeSessionExists,
  resolveResumeAppendFlags,
};
