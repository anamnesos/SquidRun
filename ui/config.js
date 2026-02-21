/**
 * Shared configuration for SquidRun
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
  ? '\\\\.\\pipe\\squidrun-terminal'
  : '/tmp/squidrun-terminal.sock';

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

const DEFAULT_PROJECT_ROOT = discoverProjectRoot();
const GLOBAL_STATE_ROOT = os.platform() === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'squidrun')
  : path.join(os.homedir(), '.config', 'squidrun');
const legacyCoordFallbackWarnings = new Set();
let activeProjectRoot = DEFAULT_PROJECT_ROOT;

// Legacy instance working directories (kept for compatibility during migration)
// Active pane cwd resolution now uses project root via resolvePaneCwd().
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'arch'),    // Architect bundle
  '2': path.join(WORKSPACE_PATH, 'instances', 'devops'),  // Builder (legacy dir name kept)
  '3': path.join(WORKSPACE_PATH, 'instances', 'ana'),     // Oracle (legacy dir name kept)
};

// Pane roles for display
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Builder',
  '3': 'Oracle',
};

const PANE_ROLE_BUNDLES = {
  '1': {
    heading: PANE_ROLES['1'],
    members: [
      PANE_ROLES['1'],
      'Data Engineer',
      'Reviewer',
      'Release Manager',
      'UX Researcher',
      'Memory Steward',
    ],
  },
  '2': {
    heading: PANE_ROLES['2'],
    members: [
      'Frontend',
      'Backend',
      'DevOps',
      'SRE',
      'Tester',
      'Validator',
      'Security',
      'Context Optimizer',
    ],
  },
  '3': {
    heading: PANE_ROLES['3'],
    members: [
      'Investigator',
      'Docs',
      'Eval/Benchmark',
    ],
  },
};

// Short names for space-constrained UI elements
const SHORT_AGENT_NAMES = {
  '1': 'Arch',
  '2': 'Builder',
  '3': 'Oracle',
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
  director: 'architect',
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
  director: '1',  // Legacy alias → Architect pane
  builder: '2',
  backend: '2',    // Legacy alias → Builder pane
  infra: '2',      // Legacy alias → Builder pane
  devops: '2',     // Legacy alias → Builder pane
  oracle: '3',
  analyst: '3',    // Legacy alias → Oracle pane
};

const BACKGROUND_BUILDER_OWNER_PANE_ID = '2';
const BACKGROUND_BUILDER_MAX_AGENTS = 3;
const BACKGROUND_BUILDER_SLOT_IDS = ['1', '2', '3'];
const BACKGROUND_BUILDER_ALIAS_TO_PANE = Object.freeze({
  'builder-bg-1': 'bg-2-1',
  'builder-bg-2': 'bg-2-2',
  'builder-bg-3': 'bg-2-3',
});
const BACKGROUND_BUILDER_PANE_TO_ALIAS = Object.freeze({
  'bg-2-1': 'builder-bg-1',
  'bg-2-2': 'builder-bg-2',
  'bg-2-3': 'builder-bg-3',
});
const BACKGROUND_BUILDER_PANE_IDS = Object.freeze(
  BACKGROUND_BUILDER_SLOT_IDS.map((slot) => `bg-${BACKGROUND_BUILDER_OWNER_PANE_ID}-${slot}`)
);

const PANE_IDS = Object.keys(PANE_ROLES);

function normalizeBackgroundBuilderAlias(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return BACKGROUND_BUILDER_ALIAS_TO_PANE[normalized] ? normalized : null;
}

function normalizeBackgroundBuilderPaneId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  return BACKGROUND_BUILDER_PANE_TO_ALIAS[normalized] ? normalized : null;
}

function resolveBackgroundBuilderPaneId(target) {
  const alias = normalizeBackgroundBuilderAlias(target);
  if (alias) return BACKGROUND_BUILDER_ALIAS_TO_PANE[alias];
  return normalizeBackgroundBuilderPaneId(target);
}

function resolveBackgroundBuilderAlias(target) {
  const paneId = resolveBackgroundBuilderPaneId(target);
  if (!paneId) return null;
  return BACKGROUND_BUILDER_PANE_TO_ALIAS[paneId] || null;
}

function isBackgroundBuilderTarget(target) {
  return Boolean(resolveBackgroundBuilderPaneId(target));
}

function normalizeProjectPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function getProjectRoot() {
  return activeProjectRoot;
}

function getSquidrunRoot() {
  return DEFAULT_PROJECT_ROOT;
}

function setProjectRoot(projectRoot) {
  activeProjectRoot = normalizeProjectPath(projectRoot) || DEFAULT_PROJECT_ROOT;
  return activeProjectRoot;
}

function resetProjectRoot() {
  return setProjectRoot(null);
}

function getCoordRoot() {
  return path.join(getProjectRoot(), '.squidrun');
}

function resolvePaneCwd(paneId, options = {}) {
  const id = String(paneId);
  const paneProjects = options.paneProjects && typeof options.paneProjects === 'object'
    ? options.paneProjects
    : null;
  const projectRoot = normalizeProjectPath(
    options.projectRoot
    || options.activeProject
    || options.stateProject
  );

  const paneProject = normalizeProjectPath(paneProjects ? paneProjects[id] : null);
  if (paneProject) {
    return paneProject;
  }

  const isKnownPane = Object.prototype.hasOwnProperty.call(PANE_ROLES, id);
  if (isKnownPane && projectRoot) {
    return projectRoot;
  }

  if (isKnownPane) {
    return getProjectRoot();
  }

  const instanceDirs = options.instanceDirs && typeof options.instanceDirs === 'object'
    ? options.instanceDirs
    : INSTANCE_DIRS;
  return instanceDirs[id] || null;
}

function resolveCoordRoot() {
  const coordRoot = getCoordRoot();
  if (fs.existsSync(coordRoot)) {
    return coordRoot;
  }
  return WORKSPACE_PATH;
}

function getCoordRoots(options = {}) {
  const includeMissing = options.includeMissing === true;
  const includeLegacy = options.includeLegacy !== false;
  const roots = [];
  const coordRoot = getCoordRoot();

  if (includeMissing || fs.existsSync(coordRoot)) {
    roots.push(coordRoot);
  }
  if (includeLegacy && (includeMissing || fs.existsSync(WORKSPACE_PATH))) {
    roots.push(WORKSPACE_PATH);
  }

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function normalizeCoordRelPathForPolicy(relPath = '') {
  return String(relPath || '')
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function shouldBlockLegacyWorkspaceFallback(relPath = '') {
  const normalized = normalizeCoordRelPathForPolicy(relPath);
  if (!normalized) return false;
  if (normalized === 'runtime') return true;
  if (normalized.startsWith('runtime/')) return true;
  if (normalized.endsWith('/evidence-ledger.db') || normalized === 'evidence-ledger.db') return true;
  return false;
}

function resolveCoordPath(relPath, options = {}) {
  const normalizedRelPath = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, path.sep);

  const forWrite = options.forWrite === true;
  const blockLegacyWorkspaceFallback = shouldBlockLegacyWorkspaceFallback(normalizedRelPath);
  const roots = getCoordRoots({ includeMissing: true, includeLegacy: options.includeLegacy !== false });
  const coordRoot = getCoordRoot();

  if (!forWrite) {
    for (const root of roots) {
      if (
        blockLegacyWorkspaceFallback
        && path.resolve(root) === path.resolve(WORKSPACE_PATH)
        && fs.existsSync(coordRoot)
      ) {
        const warningKey = `blocked:${normalizedRelPath}`;
        if (!legacyCoordFallbackWarnings.has(warningKey)) {
          legacyCoordFallbackWarnings.add(warningKey);
          console.warn(
            `[SquidRun][CoordPath] Legacy workspace fallback blocked for "${normalizedRelPath}". Runtime paths must resolve from coord root only.`
          );
        }
        continue;
      }
      const candidate = path.join(root, normalizedRelPath);
      if (fs.existsSync(candidate)) {
        if (
          path.resolve(root) === path.resolve(WORKSPACE_PATH)
          && fs.existsSync(coordRoot)
          && !legacyCoordFallbackWarnings.has(normalizedRelPath)
        ) {
          legacyCoordFallbackWarnings.add(normalizedRelPath);
          console.warn(
            `[SquidRun][CoordPath] Legacy workspace fallback hit for "${normalizedRelPath}" -> "${candidate}".`
          );
        }
        return candidate;
      }
    }
  }

  const root = forWrite ? getCoordRoot() : resolveCoordRoot();
  return path.join(root, normalizedRelPath);
}

function resolveGlobalPath(relPath, options = {}) {
  const normalizedRelPath = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, path.sep);

  const root = path.resolve(GLOBAL_STATE_ROOT);
  fs.mkdirSync(root, { recursive: true });

  const resolved = path.join(root, normalizedRelPath);
  if (options.forWrite === true) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  return resolved;
}

// Trigger file targets - maps filename to target pane IDs
const TRIGGER_TARGETS = {
  // Primary trigger names
  'architect.txt': ['1'],
  'builder.txt': ['2'],
  'oracle.txt': ['3'],

  // Legacy trigger names (all route to current panes)
  'lead.txt': ['1'],
  'devops.txt': ['2'],
  'analyst.txt': ['3'],
  'infra.txt': ['2'],
  'backend.txt': ['2'],
  'orchestrator.txt': ['2'],
  'worker-b.txt': ['2'],
  'investigator.txt': ['3'],

  // Broadcast triggers
  'workers.txt': ['2'],                   // Builder only
  'implementers.txt': ['2'],              // Builder (legacy)
  'all.txt': ['1', '2', '3'],

  // "Others" triggers - send to all EXCEPT the sender
  'others-architect.txt': ['2', '3'],
  'others-builder.txt': ['1', '3'],
  'others-oracle.txt': ['1', '2'],

  // Legacy "others" triggers
  'others-lead.txt': ['2', '3'],
  'others-devops.txt': ['1', '3'],
  'others-analyst.txt': ['1', '2'],
  'others-infra.txt': ['1', '3'],
  'others-backend.txt': ['1', '3'],
  'others-orchestrator.txt': ['1', '3'],
  'others-worker-b.txt': ['1', '3'],
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
  get PROJECT_ROOT() {
    return getProjectRoot();
  },
  get COORD_ROOT() {
    return getCoordRoot();
  },
  GLOBAL_STATE_ROOT,
  PANE_IDS,
  PANE_ROLES,
  PANE_ROLE_BUNDLES,
  SHORT_AGENT_NAMES,
  ROLE_NAMES,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  BACKGROUND_BUILDER_OWNER_PANE_ID,
  BACKGROUND_BUILDER_MAX_AGENTS,
  BACKGROUND_BUILDER_SLOT_IDS,
  BACKGROUND_BUILDER_ALIAS_TO_PANE,
  BACKGROUND_BUILDER_PANE_TO_ALIAS,
  BACKGROUND_BUILDER_PANE_IDS,
  normalizeBackgroundBuilderAlias,
  normalizeBackgroundBuilderPaneId,
  resolveBackgroundBuilderPaneId,
  resolveBackgroundBuilderAlias,
  isBackgroundBuilderTarget,
  TRIGGER_TARGETS,
  evidenceLedgerEnabled,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
  getProjectRoot,
  getSquidrunRoot,
  setProjectRoot,
  resetProjectRoot,
  getCoordRoot,
  resolvePaneCwd,
  resolveCoordRoot,
  getCoordRoots,
  resolveCoordPath,
  resolveGlobalPath,
};
