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
  '2': path.join(WORKSPACE_PATH, 'instances', 'worker-a'),
  '3': path.join(WORKSPACE_PATH, 'instances', 'worker-b'),
  '4': path.join(WORKSPACE_PATH, 'instances', 'reviewer'),
};

// Pane roles for display
const PANE_ROLES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
};

// Trigger file targets - maps filename to target pane IDs
const TRIGGER_TARGETS = {
  'lead.txt': ['1'],
  'worker-a.txt': ['2'],
  'worker-b.txt': ['3'],
  'reviewer.txt': ['4'],
  'workers.txt': ['2', '3'],
  'all.txt': ['1', '2', '3', '4'],
  // "Others" triggers - send to all EXCEPT the sender
  'others-lead.txt': ['2', '3', '4'],      // Lead sends to all others
  'others-worker-a.txt': ['1', '3', '4'],  // Worker A sends to all others
  'others-worker-b.txt': ['1', '2', '4'],  // Worker B sends to all others
  'others-reviewer.txt': ['1', '2', '3'],  // Reviewer sends to all others
};

// Protocol actions (client -> daemon)
const PROTOCOL_ACTIONS = ['spawn', 'write', 'resize', 'kill', 'list', 'attach', 'ping', 'shutdown', 'health'];

// Protocol events (daemon -> client)
const PROTOCOL_EVENTS = ['data', 'exit', 'spawned', 'list', 'attached', 'killed', 'error', 'pong', 'connected', 'shutdown', 'health'];

module.exports = {
  PIPE_PATH,
  WORKSPACE_PATH,
  INSTANCE_DIRS,
  PANE_ROLES,
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
};
