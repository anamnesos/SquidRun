/**
 * Shared configuration for Hivemind
 * Used by main.js, terminal-daemon.js, and tests
 */

const path = require('path');
const os = require('os');

// Named pipe path (Windows) or Unix socket
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\hivemind-terminal'
  : '/tmp/hivemind-terminal.sock';

// Workspace paths
const WORKSPACE_PATH = path.join(__dirname, '..', 'workspace');

// Instance working directories (role injection)
// UPDATED: Short folder names matching role abbreviations
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'arch'),   // Architect
  '2': path.join(WORKSPACE_PATH, 'instances', 'infra'),  // Infra
  '3': path.join(WORKSPACE_PATH, 'instances', 'front'),  // Frontend
  '4': path.join(WORKSPACE_PATH, 'instances', 'back'),   // Backend
  '5': path.join(WORKSPACE_PATH, 'instances', 'ana'),    // Analyst
  '6': path.join(WORKSPACE_PATH, 'instances', 'rev'),    // Reviewer
};

// Pane roles for display - UPDATED role names
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Infra',
  '3': 'Frontend',
  '4': 'Backend',
  '5': 'Analyst',
  '6': 'Reviewer',
};

// Canonical role identifiers (lowercase)
const ROLE_NAMES = ['architect', 'infra', 'frontend', 'backend', 'analyst', 'reviewer'];

// Legacy role aliases -> canonical role id
const LEGACY_ROLE_ALIASES = {
  lead: 'architect',
  orchestrator: 'infra',
  'worker-a': 'frontend',
  workera: 'frontend',
  'implementer-a': 'frontend',
  implementera: 'frontend',
  'worker-b': 'backend',
  workerb: 'backend',
  'implementer-b': 'backend',
  implementerb: 'backend',
  investigator: 'analyst',
};

// Canonical role id -> pane id
const ROLE_ID_MAP = {
  architect: '1',
  infra: '2',
  frontend: '3',
  backend: '4',
  analyst: '5',
  reviewer: '6',
};

const PANE_IDS = Object.keys(PANE_ROLES);

// Trigger file targets - maps filename to target pane IDs
// TRANSITION: Both old and new names work during migration period
const TRIGGER_TARGETS = {
  // NEW trigger names (primary)
  'architect.txt': ['1'],
  'infra.txt': ['2'],
  'frontend.txt': ['3'],
  'backend.txt': ['4'],
  'analyst.txt': ['5'],
  'reviewer.txt': ['6'],

  // OLD trigger names (deprecated, remove after transition)
  'lead.txt': ['1'],           // -> architect.txt
  'orchestrator.txt': ['2'],   // -> infra.txt
  'worker-a.txt': ['3'],       // -> frontend.txt
  'worker-b.txt': ['4'],       // -> backend.txt
  'investigator.txt': ['5'],   // -> analyst.txt

  // Broadcast triggers
  'workers.txt': ['3', '4'],              // Frontend + Backend
  'implementers.txt': ['2', '3', '4'],    // Infra + Frontend + Backend
  'all.txt': ['1', '2', '3', '4', '5', '6'],

  // "Others" triggers - send to all EXCEPT the sender (NEW names)
  'others-architect.txt': ['2', '3', '4', '5', '6'],
  'others-infra.txt': ['1', '3', '4', '5', '6'],
  'others-frontend.txt': ['1', '2', '4', '5', '6'],
  'others-backend.txt': ['1', '2', '3', '5', '6'],
  'others-analyst.txt': ['1', '2', '3', '4', '6'],
  'others-reviewer.txt': ['1', '2', '3', '4', '5'],

  // "Others" triggers (OLD names - deprecated)
  'others-lead.txt': ['2', '3', '4', '5', '6'],
  'others-orchestrator.txt': ['1', '3', '4', '5', '6'],
  'others-worker-a.txt': ['1', '2', '4', '5', '6'],
  'others-worker-b.txt': ['1', '2', '3', '5', '6'],
  'others-investigator.txt': ['1', '2', '3', '4', '6'],
};

// Protocol actions (client -> daemon)
const PROTOCOL_ACTIONS = ['spawn', 'write', 'resize', 'kill', 'list', 'attach', 'ping', 'shutdown', 'health', 'codex-exec'];

// Protocol events (daemon -> client)
const PROTOCOL_EVENTS = ['data', 'exit', 'spawned', 'list', 'attached', 'killed', 'error', 'pong', 'connected', 'shutdown', 'health'];

module.exports = {
  PIPE_PATH,
  WORKSPACE_PATH,
  INSTANCE_DIRS,
  PANE_IDS,
  PANE_ROLES,
  ROLE_NAMES,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
};
