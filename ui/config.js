/**
 * Shared configuration for Hivemind
 * Used by main.js, terminal-daemon.js, and tests
 */

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function envFlagEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(normalized)) return true;
  return defaultValue;
}

// Named pipe path (Windows) or Unix socket
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\hivemind-terminal'
  : '/tmp/hivemind-terminal.sock';

// Workspace paths
const WORKSPACE_PATH = path.join(__dirname, '..', 'workspace');
const PROJECT_ROOT_FALLBACK = path.resolve(path.join(WORKSPACE_PATH, '..'));
const PROJECT_ROOT_DISCOVERY_CWD = path.resolve(path.join(__dirname, '..'));

function discoverProjectRoot(startDir = PROJECT_ROOT_DISCOVERY_CWD) {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const resolved = String(output || '').trim();
    if (resolved) return path.resolve(resolved);
  } catch (_) {
    // Fall back when git is unavailable or cwd is not in a git worktree.
  }
  return PROJECT_ROOT_FALLBACK;
}

const PROJECT_ROOT = discoverProjectRoot();

// Legacy instance working directories (kept for compatibility during migration)
// Active pane cwd resolution now uses project root via resolvePaneCwd().
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'arch'),   // Architect (+ Frontend/Reviewer as internal teammates)
  '2': path.join(WORKSPACE_PATH, 'instances', 'devops'), // DevOps (Infra + Backend combined)
  '5': path.join(WORKSPACE_PATH, 'instances', 'ana'),    // Analyst
};

// Pane roles for display - UPDATED role names
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'DevOps',
  '5': 'Analyst',
};

// Short names for space-constrained UI elements
const SHORT_AGENT_NAMES = {
  '1': 'Arch',
  '2': 'DevOps',
  '5': 'Ana',
  'system': 'Sys',
  'router': 'Rtr',
  'user': 'User'
};

// Canonical role identifiers (lowercase)
const ROLE_NAMES = ['architect', 'devops', 'analyst'];

// Legacy role aliases -> canonical role id
const LEGACY_ROLE_ALIASES = {
  lead: 'architect',
  orchestrator: 'devops',
  infra: 'devops',
  infrastructure: 'devops',
  backend: 'devops',
  'worker-b': 'devops',
  workerb: 'devops',
  'implementer-b': 'devops',
  implementerb: 'devops',
  back: 'devops',
  investigator: 'analyst',
  ana: 'analyst',
  arch: 'architect'
};

// Canonical role id -> pane id
const ROLE_ID_MAP = {
  architect: '1',
  devops: '2',
  backend: '2',    // Legacy alias → DevOps pane
  infra: '2',      // Legacy alias → DevOps pane
  analyst: '5',
};

const PANE_IDS = Object.keys(PANE_ROLES);

function resolvePaneCwd(paneId, options = {}) {
  const id = String(paneId);
  if (Object.prototype.hasOwnProperty.call(PANE_ROLES, id)) {
    return PROJECT_ROOT;
  }

  const instanceDirs = options.instanceDirs && typeof options.instanceDirs === 'object'
    ? options.instanceDirs
    : INSTANCE_DIRS;
  return instanceDirs[id] || null;
}

function resolveCoordRoot() {
  return WORKSPACE_PATH;
}

// Trigger file targets - maps filename to target pane IDs
// TRANSITION: Both old and new names work during migration period
const TRIGGER_TARGETS = {
  // Primary trigger names
  'architect.txt': ['1'],
  'devops.txt': ['2'],
  'analyst.txt': ['5'],

  // Legacy trigger names (all route to current panes)
  'lead.txt': ['1'],
  'infra.txt': ['2'],
  'backend.txt': ['2'],
  'orchestrator.txt': ['2'],
  'worker-b.txt': ['2'],
  'investigator.txt': ['5'],

  // Broadcast triggers
  'workers.txt': ['2'],                   // DevOps only
  'implementers.txt': ['2'],              // DevOps (was Infra + Backend, now same pane)
  'all.txt': ['1', '2', '5'],

  // "Others" triggers - send to all EXCEPT the sender
  'others-architect.txt': ['2', '5'],
  'others-devops.txt': ['1', '5'],
  'others-analyst.txt': ['1', '2'],

  // Legacy "others" triggers
  'others-lead.txt': ['2', '5'],
  'others-infra.txt': ['1', '5'],
  'others-backend.txt': ['1', '5'],
  'others-orchestrator.txt': ['1', '5'],
  'others-worker-b.txt': ['1', '5'],
  'others-investigator.txt': ['1', '2'],
};

// Protocol actions (client -> daemon)
const PROTOCOL_ACTIONS = ['spawn', 'write', 'resize', 'kill', 'list', 'attach', 'ping', 'shutdown', 'health', 'codex-exec'];

// Protocol events (daemon -> client)
const PROTOCOL_EVENTS = ['data', 'exit', 'spawned', 'list', 'attached', 'killed', 'error', 'pong', 'connected', 'shutdown', 'health', 'codex-exec-result'];

// Slice 1 evidence ledger gate.
// Default enabled across dev/prod; runtime degrades if DB open fails.
const evidenceLedgerEnabled = envFlagEnabled('HIVEMIND_EVIDENCE_LEDGER_ENABLED', true);

module.exports = {
  PIPE_PATH,
  WORKSPACE_PATH,
  PROJECT_ROOT,
  INSTANCE_DIRS,
  PANE_IDS,
  PANE_ROLES,
  SHORT_AGENT_NAMES,
  ROLE_NAMES,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  TRIGGER_TARGETS,
  evidenceLedgerEnabled,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
  resolvePaneCwd,
  resolveCoordRoot,
};
