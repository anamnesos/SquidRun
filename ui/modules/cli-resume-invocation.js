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
//  - codex: `codex resume <id>` can resume by id, BUT codex has NO pin-at-creation
//    flag (no --session-id analog) and `codex resume --last` is cwd-scoped. With 4
//    arms sharing one cwd, --last collides all four onto one session. The only
//    per-arm-correct path is discover-then-persist by session CONTENT, which is
//    too fragile for v1 (re-introduces the collision at discovery time). So codex
//    arms stay COLD by design.
//
// REVISIT codex-arm resume IF codex adds pin/name-at-creation OR we add
// content-based session disambiguation.
const CLI_RESUME_STRATEGY = {
  claude: 'session-id', // create-or-resume by per-pane UUID
  codex: 'none',        // cold-start by design (no pin-at-creation + shared cwd)
};

// LANDMINE: claude `--fork-session` mints a NEW session id when resuming, which
// would break per-pane id stability. It must NEVER appear in a built invocation.
const FORBIDDEN_CLAUDE_FLAGS = ['--fork-session', '-c', '--continue'];
const CLAUDE_RESUME_FLAG_PATTERN = /(?:^|\s)(?:--session-id|--resume)(?:=|\s+)([^\s"']+)/i;
const CLAUDE_MODEL_FLAG_PATTERN = /(?:^|\s)--model(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i;
const CLAUDE_SESSION_IN_USE_PATTERN = /session(?:\s+id)?[^.\n\r]*already\s+in\s+use|already\s+in\s+use[^.\n\r]*session(?:\s+id)?/i;

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
// Returns '' for codex (cold by design) and unknown CLIs.
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

  // 'none' — codex arms (shared-cwd cross-wire risk) or unknown CLI.
  return {
    flags: '',
    cli,
    strategy: 'none',
    mode: 'cold',
    reason: cli === 'codex'
      ? 'codex: no pin-at-creation + shared cwd -> cold-start by design, see ARCHITECTURE'
      : 'unknown CLI: bare command (no resume)',
  };
}

module.exports = {
  CLI_RESUME_STRATEGY,
  FORBIDDEN_CLAUDE_FLAGS,
  CLAUDE_RESUME_FLAG_PATTERN,
  CLAUDE_MODEL_FLAG_PATTERN,
  detectCli,
  resumeStrategyForCommand,
  extractClaudeSessionIdFromCommand,
  hasClaudeResumeFlag,
  stripClaudeResumeFlags,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
  readClaudeDefaultModel,
  ensureClaudeModelFlag,
  isClaudeSessionInUseError,
  encodeClaudeProjectDir,
  claudeSessionStorePath,
  claudeSessionExists,
  resolveResumeAppendFlags,
};
