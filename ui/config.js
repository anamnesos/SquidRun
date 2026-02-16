/**
 * Shared configuration for Hivemind
 * Used by main.js, terminal-daemon.js, and tests
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
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
const COORD_ROOT = path.join(PROJECT_ROOT, '.hivemind');
const legacyCoordFallbackWarnings = new Set();

// Legacy instance working directories (kept for compatibility during migration)
// Active pane cwd resolution now uses project root via resolvePaneCwd().
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'arch'),    // Architect (Director bundle)
  '2': path.join(WORKSPACE_PATH, 'instances', 'devops'),  // Builder (legacy dir name kept)
  '5': path.join(WORKSPACE_PATH, 'instances', 'ana'),     // Oracle (legacy dir name kept)
};

// Pane roles for display
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Builder',
  '5': 'Oracle',
};

// Short names for space-constrained UI elements
const SHORT_AGENT_NAMES = {
  '1': 'Arch',
  '2': 'Builder',
  '5': 'Oracle',
  'system': 'Sys',
  'router': 'Rtr',
  'user': 'User'
};

// Canonical role identifiers (lowercase)
const ROLE_NAMES = ['architect', 'builder', 'oracle'];

// Legacy role aliases -> canonical role id
const LEGACY_ROLE_ALIASES = {
  lead: 'architect',
  arch: 'architect',
  // Builder aliases (legacy DevOps + Infra + Backend names)
  devops: 'builder',
  orchestrator: 'builder',
  infra: 'builder',
  infrastructure: 'builder',
  backend: 'builder',
  'worker-b': 'builder',
  workerb: 'builder',
  'implementer-b': 'builder',
  implementerb: 'builder',
  back: 'builder',
  // Oracle aliases (legacy Analyst / Ana names)
  analyst: 'oracle',
  ana: 'oracle',
  investigator: 'oracle',
};

// Canonical role id -> pane id
const ROLE_ID_MAP = {
  architect: '1',
  builder: '2',
  backend: '2',    // Legacy alias → Builder pane
  infra: '2',      // Legacy alias → Builder pane
  devops: '2',     // Legacy alias → Builder pane
  oracle: '5',
  analyst: '5',    // Legacy alias → Oracle pane
};

const PANE_IDS = Object.keys(PANE_ROLES);

function resolvePaneCwd(paneId, options = {}) {
  const id = String(paneId);
  const paneProjects = options.paneProjects && typeof options.paneProjects === 'object'
    ? options.paneProjects
    : null;

  const paneProject = paneProjects ? paneProjects[id] : null;
  if (typeof paneProject === 'string' && paneProject.trim()) {
    return path.resolve(paneProject.trim());
  }

  if (Object.prototype.hasOwnProperty.call(PANE_ROLES, id)) {
    return PROJECT_ROOT;
  }

  const instanceDirs = options.instanceDirs && typeof options.instanceDirs === 'object'
    ? options.instanceDirs
    : INSTANCE_DIRS;
  return instanceDirs[id] || null;
}

function resolveCoordRoot() {
  if (fs.existsSync(COORD_ROOT)) {
    return COORD_ROOT;
  }
  return WORKSPACE_PATH;
}

function getCoordRoots(options = {}) {
  const includeMissing = options.includeMissing === true;
  const includeLegacy = options.includeLegacy !== false;
  const roots = [];

  if (includeMissing || fs.existsSync(COORD_ROOT)) {
    roots.push(COORD_ROOT);
  }
  if (includeLegacy && (includeMissing || fs.existsSync(WORKSPACE_PATH))) {
    roots.push(WORKSPACE_PATH);
  }

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function resolveCoordPath(relPath, options = {}) {
  const normalizedRelPath = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, path.sep);

  const forWrite = options.forWrite === true;
  const roots = getCoordRoots({ includeMissing: true, includeLegacy: options.includeLegacy !== false });

  if (!forWrite) {
    for (const root of roots) {
      const candidate = path.join(root, normalizedRelPath);
      if (fs.existsSync(candidate)) {
        if (
          path.resolve(root) === path.resolve(WORKSPACE_PATH)
          && fs.existsSync(COORD_ROOT)
          && !legacyCoordFallbackWarnings.has(normalizedRelPath)
        ) {
          legacyCoordFallbackWarnings.add(normalizedRelPath);
          console.warn(
            `[Hivemind][CoordPath] Legacy workspace fallback hit for "${normalizedRelPath}" -> "${candidate}".`
          );
        }
        return candidate;
      }
    }
  }

  const root = resolveCoordRoot();
  return path.join(root, normalizedRelPath);
}

// Trigger file targets - maps filename to target pane IDs
const TRIGGER_TARGETS = {
  // Primary trigger names
  'architect.txt': ['1'],
  'builder.txt': ['2'],
  'oracle.txt': ['5'],

  // Legacy trigger names (all route to current panes)
  'lead.txt': ['1'],
  'devops.txt': ['2'],
  'analyst.txt': ['5'],
  'infra.txt': ['2'],
  'backend.txt': ['2'],
  'orchestrator.txt': ['2'],
  'worker-b.txt': ['2'],
  'investigator.txt': ['5'],

  // Broadcast triggers
  'workers.txt': ['2'],                   // Builder only
  'implementers.txt': ['2'],              // Builder (legacy)
  'all.txt': ['1', '2', '5'],

  // "Others" triggers - send to all EXCEPT the sender
  'others-architect.txt': ['2', '5'],
  'others-builder.txt': ['1', '5'],
  'others-oracle.txt': ['1', '2'],

  // Legacy "others" triggers
  'others-lead.txt': ['2', '5'],
  'others-devops.txt': ['1', '5'],
  'others-analyst.txt': ['1', '2'],
  'others-infra.txt': ['1', '5'],
  'others-backend.txt': ['1', '5'],
  'others-orchestrator.txt': ['1', '5'],
  'others-worker-b.txt': ['1', '5'],
  'others-investigator.txt': ['1', '2'],
};

// Protocol actions (client -> daemon)
const PROTOCOL_ACTIONS = ['spawn', 'write', 'resize', 'kill', 'list', 'attach', 'ping', 'shutdown', 'health'];

// Protocol events (daemon -> client)
const PROTOCOL_EVENTS = ['data', 'exit', 'spawned', 'list', 'attached', 'killed', 'error', 'pong', 'connected', 'shutdown', 'health'];

// Slice 1 evidence ledger gate.
// Default enabled across dev/prod; runtime degrades if DB open fails.
const evidenceLedgerEnabled = envFlagEnabled('HIVEMIND_EVIDENCE_LEDGER_ENABLED', true);

module.exports = {
  PIPE_PATH,
  WORKSPACE_PATH,
  PROJECT_ROOT,
  COORD_ROOT,
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
  getCoordRoots,
  resolveCoordPath,
};
