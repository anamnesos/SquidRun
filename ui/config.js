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
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'lead'),
  '2': path.join(WORKSPACE_PATH, 'instances', 'orchestrator'),
  '3': path.join(WORKSPACE_PATH, 'instances', 'worker-a'),
  '4': path.join(WORKSPACE_PATH, 'instances', 'worker-b'),
  '5': path.join(WORKSPACE_PATH, 'instances', 'investigator'),
  '6': path.join(WORKSPACE_PATH, 'instances', 'reviewer'),
};

// Pane roles for display
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer',
};

const PANE_IDS = Object.keys(PANE_ROLES);

// Trigger file targets - maps filename to target pane IDs
const TRIGGER_TARGETS = {
  'lead.txt': ['1'],
  'orchestrator.txt': ['2'],
  'worker-a.txt': ['3'],
  'worker-b.txt': ['4'],
  'investigator.txt': ['5'],
  'reviewer.txt': ['6'],
  'workers.txt': ['3', '4', '5'],
  'all.txt': ['1', '2', '3', '4', '5', '6'],
  // "Others" triggers - send to all EXCEPT the sender
  'others-lead.txt': ['2', '3', '4', '5', '6'],          // Architect sends to all others
  'others-orchestrator.txt': ['1', '3', '4', '5', '6'],   // Orchestrator sends to all others
  'others-worker-a.txt': ['1', '2', '4', '5', '6'],       // Implementer A sends to all others
  'others-worker-b.txt': ['1', '2', '3', '5', '6'],       // Implementer B sends to all others
  'others-investigator.txt': ['1', '2', '3', '4', '6'],   // Investigator sends to all others
  'others-reviewer.txt': ['1', '2', '3', '4', '5'],       // Reviewer sends to all others
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
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
};
