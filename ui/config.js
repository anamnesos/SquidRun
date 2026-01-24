/**
 * Hivemind Shared Configuration
 *
 * Centralized config for constants shared between main.js, terminal-daemon.js, etc.
 */

const path = require('path');
const os = require('os');

// Base paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.join(PROJECT_ROOT, 'workspace');

// Named pipe path for daemon communication
const PIPE_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\hivemind-terminal'
  : '/tmp/hivemind-terminal.sock';

// Instance directories - each pane gets its own working directory with role-specific CLAUDE.md
const INSTANCE_DIRS = {
  '1': path.join(WORKSPACE_PATH, 'instances', 'lead'),
  '2': path.join(WORKSPACE_PATH, 'instances', 'worker-a'),
  '3': path.join(WORKSPACE_PATH, 'instances', 'worker-b'),
  '4': path.join(WORKSPACE_PATH, 'instances', 'reviewer'),
};

// Role names for display
const PANE_ROLES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
};

// Trigger file mappings
const TRIGGER_TARGETS = {
  'lead.txt': ['1'],
  'worker-a.txt': ['2'],
  'worker-b.txt': ['3'],
  'reviewer.txt': ['4'],
  'workers.txt': ['2', '3'],
  'all.txt': ['1', '2', '3', '4'],
};

module.exports = {
  PROJECT_ROOT,
  WORKSPACE_PATH,
  PIPE_PATH,
  INSTANCE_DIRS,
  PANE_ROLES,
  TRIGGER_TARGETS,
};
