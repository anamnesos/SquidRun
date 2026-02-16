/**
 * Shared config mock fixture for tests.
 *
 * Instead of copy-pasting PANE_IDS, PANE_ROLES, TRIGGER_TARGETS, etc. into
 * every test file, import from here. When the pane layout changes you only
 * need to update this one file.
 *
 * IMPORTANT: jest.mock() factories are hoisted and cannot reference
 * out-of-scope variables. Use require() inside the factory:
 *
 * Usage — full default mock:
 *   jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);
 *
 * Usage — with overrides:
 *   jest.mock('../config', () => require('./helpers/mock-config').mockCreateConfig({ WORKSPACE_PATH: '/custom' }));
 *
 * Usage — minimal (only WORKSPACE_PATH):
 *   jest.mock('../config', () => require('./helpers/mock-config').mockWorkspaceOnly);
 */

const LEGACY_PANE_CWD_FALLBACK = {
  '1': '/test/legacy-pane-cwd/arch',
  '2': '/test/legacy-pane-cwd/builder',
  '5': '/test/legacy-pane-cwd/oracle',
};

function asPaneProjectPath(paneProjects, paneId) {
  if (!paneProjects || typeof paneProjects !== 'object') return null;
  const candidate = paneProjects[String(paneId)];
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed ? trimmed : null;
}

const mockDefaultConfig = {
  PIPE_PATH: '\\\\.\\pipe\\hivemind-terminal-test',
  WORKSPACE_PATH: '/test/workspace',
  PROJECT_ROOT: '/test',
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Builder',
    '5': 'Oracle',
  },
  SHORT_AGENT_NAMES: {
    '1': 'Arch',
    '2': 'Builder',
    '5': 'Oracle',
    'system': 'Sys',
    'router': 'Rtr',
    'user': 'User',
  },
  ROLE_NAMES: ['architect', 'builder', 'oracle'],
  LEGACY_ROLE_ALIASES: {
    lead: 'architect',
    arch: 'architect',
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
    analyst: 'oracle',
    ana: 'oracle',
    investigator: 'oracle',
  },
  ROLE_ID_MAP: {
    architect: '1',
    builder: '2',
    backend: '2',
    infra: '2',
    devops: '2',
    oracle: '5',
    analyst: '5',
  },
  TRIGGER_TARGETS: {
    'architect.txt': ['1'],
    'builder.txt': ['2'],
    'oracle.txt': ['5'],
    'lead.txt': ['1'],
    'devops.txt': ['2'],
    'analyst.txt': ['5'],
    'infra.txt': ['2'],
    'backend.txt': ['2'],
    'orchestrator.txt': ['2'],
    'worker-b.txt': ['2'],
    'investigator.txt': ['5'],
    'workers.txt': ['2'],
    'implementers.txt': ['2'],
    'all.txt': ['1', '2', '5'],
    'others-architect.txt': ['2', '5'],
    'others-builder.txt': ['1', '5'],
    'others-oracle.txt': ['1', '2'],
    'others-lead.txt': ['2', '5'],
    'others-devops.txt': ['1', '5'],
    'others-analyst.txt': ['1', '2'],
    'others-infra.txt': ['1', '5'],
    'others-backend.txt': ['1', '5'],
    'others-orchestrator.txt': ['1', '5'],
    'others-worker-b.txt': ['1', '5'],
    'others-investigator.txt': ['1', '2'],
  },
  PROTOCOL_ACTIONS: ['spawn', 'write', 'resize', 'kill', 'list', 'attach', 'ping', 'shutdown', 'health'],
  PROTOCOL_EVENTS: ['data', 'exit', 'spawned', 'list', 'attached', 'killed', 'error', 'pong', 'connected', 'shutdown', 'health'],
  resolvePaneCwd: (paneId, options = {}) => {
    const id = String(paneId);
    const paneProjectPath = asPaneProjectPath(options.paneProjects, id);
    if (paneProjectPath) {
      return paneProjectPath;
    }
    if (Object.prototype.hasOwnProperty.call(mockDefaultConfig.PANE_ROLES, id)) {
      return mockDefaultConfig.PROJECT_ROOT;
    }
    const instanceDirs = options.instanceDirs && typeof options.instanceDirs === 'object'
      ? options.instanceDirs
      : LEGACY_PANE_CWD_FALLBACK;
    return instanceDirs[id] || null;
  },
  resolveCoordRoot: () => mockDefaultConfig.WORKSPACE_PATH,
};

/** Minimal mock — only WORKSPACE_PATH (for modules that just need the path) */
const mockWorkspaceOnly = {
  WORKSPACE_PATH: '/test/workspace',
  resolveCoordRoot: () => '/test/workspace',
};

/**
 * Create a config mock with selective overrides.
 * Shallow-merges top-level keys from mockDefaultConfig with your overrides.
 * Note: nested objects (PANE_ROLES, TRIGGER_TARGETS, etc.) are replaced entirely, not deep-merged.
 *
 * @param {Object} overrides - Keys to override in the default config
 * @returns {Object} Merged config object
 */
function mockCreateConfig(overrides = {}) {
  return { ...mockDefaultConfig, ...overrides };
}

module.exports = {
  mockDefaultConfig,
  mockWorkspaceOnly,
  mockCreateConfig,
};
