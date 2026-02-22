'use strict';

const INVOKE_CHANNELS = Object.freeze([
  'apply-rollback',
  'clear-activity-log',
  'clear-friction',
  'clipboard-paste-text',
  'clipboard-write',
  'contract-promotion:approve',
  'contract-promotion:list',
  'contract-promotion:reject',
  'delete-friction',
  'delete-screenshot',
  'daemon-is-process-running',
  'evidence-ledger:query-comms-journal',
  'full-restart',
  'get-activity-log',
  'get-all-pane-projects',
  'get-app-status',
  'get-api-keys',
  'get-claims',
  'get-daemon-runtime-config',
  'get-feature-capabilities',
  'get-pane-commands',
  'get-process-output',
  'get-project',
  'get-screenshot-path',
  'get-settings',
  'get-shared-context-path',
  'get-state',
  'get-task-list',
  'git-status',
  'graph-nodes-by-type',
  'graph-query',
  'graph-record-concept',
  'graph-related',
  'graph-save',
  'graph-stats',
  'graph-visualize',
  'input-edit-action',
  'intent-update',
  'interrupt-pane',
  'kill-process',
  'list-friction',
  'list-processes',
  'list-screenshots',
  'notify-external-test',
  'oracle:deleteImage',
  'oracle:generateImage',
  'oracle:listImages',
  'pane-host-dispatch-enter',
  'pane-host-inject',
  'pty-create',
  'pty-kill',
  'pty-pause',
  'pty-resize',
  'pty-resume',
  'pty-write',
  'pty-write-chunked',
  'read-friction',
  'read-shared-context',
  'release-agent',
  'route-task-input',
  'save-screenshot',
  'clear-project-context',
  'select-pane-project',
  'select-project',
  'send-trusted-enter',
  'set-project-context',
  'set-api-keys',
  'set-setting',
  'spawn-claude',
  'spawn-process',
  'switch-pane-model',
  'update-task-status',
  'voice:transcribe',
  'workflow-apply-template',
  'workflow-delete',
  'workflow-duplicate',
  'workflow-export-file',
  'workflow-generate-plan',
  'workflow-get-node-types',
  'workflow-get-templates',
  'workflow-import-file',
  'workflow-list',
  'workflow-load',
  'workflow-save',
  'workflow-validate',
  'write-shared-context',
]);

const SEND_CHANNELS = Object.freeze([
  'pane-host-ready',
  'trigger-delivery-ack',
  'trigger-delivery-outcome',
]);

const ON_CHANNELS = Object.freeze([
  'activity-logged',
  'agent-stuck-detected',
  'auto-handoff',
  'auto-trigger',
  'claude-state-changed',
  'completion-detected',
  'conflict-resolved',
  'cost-alert',
  'daemon-connected',
  'daemon-disconnected',
  'daemon-reconnected',
  'feature-capabilities-updated',
  'file-conflict',
  'global-escape-pressed',
  'heartbeat-state-changed',
  'inject-message',
  'kernel:bridge-event',
  'kernel:bridge-stats',
  'nudge-pane',
  'oracle:image-generated',
  'pane-cli-identity',
  'pane-enter',
  'pane-host:inject-message',
  'pane-host:prime-scrollback',
  'pane-host:pty-data',
  'pane-host:pty-exit',
  'pane-model-changed',
  'project-changed',
  'project-warning',
  'restart-all-panes',
  'restart-pane',
  'rollback-available',
  'rollback-cleared',
  'sync-file-changed',
  'sync-triggered',
  'task-handoff',
  'task-list-updated',
  'unstick-pane',
  'watchdog-alert',
]);

const DYNAMIC_ON_CHANNEL_PATTERNS = Object.freeze([
  /^pty-data-[A-Za-z0-9_-]+$/,
  /^pty-exit-[A-Za-z0-9_-]+$/,
]);

const INVOKE_CHANNEL_SET = new Set(INVOKE_CHANNELS);
const SEND_CHANNEL_SET = new Set(SEND_CHANNELS);
const ON_CHANNEL_SET = new Set(ON_CHANNELS);

function isValidChannel(channel) {
  return typeof channel === 'string' && channel.length > 0;
}

function matchesDynamicOnChannel(channel) {
  if (!isValidChannel(channel)) return false;
  return DYNAMIC_ON_CHANNEL_PATTERNS.some((pattern) => pattern.test(channel));
}

function isAllowedInvokeChannel(channel) {
  return isValidChannel(channel) && INVOKE_CHANNEL_SET.has(channel);
}

function isAllowedSendChannel(channel) {
  return isValidChannel(channel) && SEND_CHANNEL_SET.has(channel);
}

function isAllowedOnChannel(channel) {
  return (isValidChannel(channel) && ON_CHANNEL_SET.has(channel)) || matchesDynamicOnChannel(channel);
}

module.exports = {
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  ON_CHANNELS,
  DYNAMIC_ON_CHANNEL_PATTERNS,
  isAllowedInvokeChannel,
  isAllowedSendChannel,
  isAllowedOnChannel,
};
