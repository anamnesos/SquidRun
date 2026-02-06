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
// Short folder names - prestart script ensures folders exist with these names
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'arch'),   // Architect (+ Frontend/Reviewer as internal teammates)
  '2': path.join(WORKSPACE_PATH, 'instances', 'infra'),  // Infra
  '4': path.join(WORKSPACE_PATH, 'instances', 'back'),   // Backend
  '5': path.join(WORKSPACE_PATH, 'instances', 'ana'),    // Analyst
};

// Pane roles for display - UPDATED role names
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Infra',
  '4': 'Backend',
  '5': 'Analyst',
};

// Short names for space-constrained UI elements
const SHORT_AGENT_NAMES = {
  '1': 'Arch',
  '2': 'Infra',
  '4': 'Back',
  '5': 'Ana',
  'system': 'Sys',
  'router': 'Rtr',
  'user': 'User'
};

// Canonical role identifiers (lowercase)
const ROLE_NAMES = ['architect', 'infra', 'backend', 'analyst'];

// Legacy role aliases -> canonical role id
const LEGACY_ROLE_ALIASES = {
  lead: 'architect',
  orchestrator: 'infra',
  'worker-b': 'backend',
  workerb: 'backend',
  'implementer-b': 'backend',
  implementerb: 'backend',
  investigator: 'analyst',
  ana: 'analyst',
  back: 'backend',
  arch: 'architect'
};

// Canonical role id -> pane id
const ROLE_ID_MAP = {
  architect: '1',
  infra: '2',
  backend: '4',
  analyst: '5',
};

const PANE_IDS = Object.keys(PANE_ROLES);

// Trigger file targets - maps filename to target pane IDs
// TRANSITION: Both old and new names work during migration period
const TRIGGER_TARGETS = {
  // Primary trigger names
  'architect.txt': ['1'],
  'infra.txt': ['2'],
  'backend.txt': ['4'],
  'analyst.txt': ['5'],

  // Legacy trigger names (deprecated, kept for compatibility)
  'lead.txt': ['1'],
  'orchestrator.txt': ['2'],
  'worker-b.txt': ['4'],
  'investigator.txt': ['5'],

  // Broadcast triggers
  'workers.txt': ['4'],                   // Backend only (Frontend is now internal)
  'implementers.txt': ['2', '4'],         // Infra + Backend
  'all.txt': ['1', '2', '4', '5'],

  // "Others" triggers - send to all EXCEPT the sender
  'others-architect.txt': ['2', '4', '5'],
  'others-infra.txt': ['1', '4', '5'],
  'others-backend.txt': ['1', '2', '5'],
  'others-analyst.txt': ['1', '2', '4'],

  // Legacy "others" triggers
  'others-lead.txt': ['2', '4', '5'],
  'others-orchestrator.txt': ['1', '4', '5'],
  'others-worker-b.txt': ['1', '2', '5'],
  'others-investigator.txt': ['1', '2', '4'],
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
  SHORT_AGENT_NAMES,
  ROLE_NAMES,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
};
