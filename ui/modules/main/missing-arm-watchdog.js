const path = require('path');
const { spawnSync } = require('child_process');
const { getProjectRoot } = require('../../config');
const {
  advanceArmMissingWatchdogs,
} = require('./arm-registry');

function resolveProjectRoot(projectRoot = null) {
  return path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
}

function buildMissingArmEscalationMessage(action = {}, result = {}) {
  const registry = result.registry || {};
  return [
    '(ARM WATCHDOG): Missing arm escalation.',
    `room=${action.appRoomId || registry.appRoomId || 'unknown'}`,
    `session=${action.sessionId || registry.sessionId || 'unknown'}`,
    `arm=${action.armKey || 'unknown'}`,
    `role=${action.role || 'unknown'}`,
    `pane=${action.paneId || 'unknown'}`,
    `desired=${registry.desiredCount ?? 'unknown'}`,
    `ready=${registry.readyCount ?? 'unknown'}`,
    `missing=${registry.missingCount ?? 'unknown'}`,
    `watchdog=${action.watchdogId || 'unknown'}`,
  ].join(' ');
}

function defaultSendEscalation(action = {}, result = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const hmSendPath = options.hmSendPath
    ? path.resolve(String(options.hmSendPath))
    : path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  const message = options.message || buildMissingArmEscalationMessage(action, result);
  const send = spawnSync(process.execPath, [hmSendPath, 'architect', '--stdin', '--role', 'system'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
    },
    input: message,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(options.timeoutMs) || 20_000),
    windowsHide: true,
  });
  return {
    ok: send.status === 0,
    status: send.status,
    stdout: send.stdout || '',
    stderr: send.stderr || '',
    message,
    hmSendPath,
  };
}

function tickMissingArmWatchdog(filters = {}, options = {}) {
  const result = advanceArmMissingWatchdogs(filters, options);
  if (!result.ok) return result;

  const sender = typeof options.sendEscalation === 'function'
    ? options.sendEscalation
    : defaultSendEscalation;
  const dispatches = [];
  for (const action of result.actions || []) {
    if (action.kind !== 'escalate') continue;
    if (options.dryRun === true) {
      dispatches.push({
        actionKey: action.actionKey,
        target: 'architect',
        skipped: true,
        reason: 'dry_run',
      });
      continue;
    }
    const dispatch = sender(action, result, options) || {};
    dispatches.push({
      actionKey: action.actionKey,
      target: 'architect',
      ok: dispatch.ok === true,
      status: dispatch.status ?? null,
      stdout: dispatch.stdout || '',
      stderr: dispatch.stderr || dispatch.error || '',
      message: dispatch.message || buildMissingArmEscalationMessage(action, result),
    });
  }

  return {
    ...result,
    dispatches,
  };
}

module.exports = {
  buildMissingArmEscalationMessage,
  defaultSendEscalation,
  tickMissingArmWatchdog,
};
