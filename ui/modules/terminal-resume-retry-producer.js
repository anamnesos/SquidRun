'use strict';

const {
  advanceCodexResumeFailureBuffer,
  decideCodexMissingResumeRecovery,
  decideCodexResumeFailureAuthority,
  isClaudeSessionInUseError,
} = require('./cli-resume-invocation');

const PANE_LAUNCH_ID_PATTERN = /^pl_[a-f0-9]{32}$/u;
const APP_GENERATION_PATTERN = /^app-(?:session-\d+|\d+-\d+)(?:[-:][A-Za-z0-9._-]+)?$/u;
const APP_OWNED_RETRY_REASONS = new Set([
  'claude_session_collision',
  'codex_missing_resume',
]);

function handleClaudeResumeOutput(input = {}, dependencies = {}) {
  const terminal = input.terminal || null;
  const resumeDecision = input.resumeDecision || null;
  if (!terminal
    || input.spawnCommandOnCreate !== true
    || resumeDecision?.cli !== 'claude'
    || !resumeDecision?.sessionId
    || terminal.claudeCollisionRecoveryAttempted === true
    || !isClaudeSessionInUseError(input.data)) {
    return { handled: false, reason: 'claude_collision_not_confirmed' };
  }

  terminal.claudeCollisionRecoveryAttempted = true;
  const remint = typeof dependencies.remintSession === 'function'
    ? dependencies.remintSession(terminal.paneId)
    : null;
  terminal.appOwnedRetryReason = 'claude_session_collision';

  const result = {
    handled: true,
    reason: terminal.appOwnedRetryReason,
    previousSessionId: resumeDecision.sessionId,
    remintedSessionId: remint?.sessionId || null,
  };
  dependencies.onCollision?.(result, terminal);
  // The retry reason is deliberately latched before killProcess. Some PTY
  // implementations can report exit synchronously from kill().
  dependencies.killProcess?.(terminal);
  return result;
}

function captureCodexResumeOutput(input = {}) {
  const terminal = input.terminal || null;
  const resumeDecision = input.resumeDecision || null;
  if (!terminal
    || input.spawnCommandOnCreate !== true
    || resumeDecision?.cli !== 'codex'
    || resumeDecision?.mode !== 'resume'
    || !resumeDecision?.sessionId
    || terminal.codexResumeFailureHandled === true) {
    return { handled: false, failure: null };
  }

  const advanced = advanceCodexResumeFailureBuffer(
    terminal.codexResumeStartupBuffer,
    input.data
  );
  terminal.codexResumeStartupBuffer = advanced.buffer;
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const failure = nowMs <= Number(terminal.codexResumeStartupDeadline)
    ? advanced.failure
    : null;
  if (failure) terminal.codexResumeFailureCandidate = failure;
  return { handled: true, failure };
}

function handleCodexResumeExit(input = {}, dependencies = {}) {
  const terminal = input.terminal || null;
  if (!terminal) return { handled: false, action: 'none', reason: 'terminal_missing' };

  const authority = decideCodexResumeFailureAuthority({
    candidate: terminal.codexResumeFailureCandidate,
    processExited: true,
    exitCode: input.exitCode,
    recoveryAttempted: terminal.codexResumeRecoveryAttempted,
  });
  if (authority.action === 'hold_active_writer') {
    terminal.codexResumeFailureHandled = true;
    dependencies.onActiveWriter?.(authority, terminal);
    return { handled: true, ...authority, retryReason: null };
  }
  if (authority.action !== 'inspect_binding') {
    return { handled: false, ...authority, retryReason: null };
  }

  terminal.codexResumeFailureHandled = true;
  terminal.codexResumeRecoveryAttempted = true;
  const cleared = typeof dependencies.clearBinding === 'function'
    ? dependencies.clearBinding()
    : { ok: false, reason: 'binding_clear_unavailable' };
  const recovery = decideCodexMissingResumeRecovery(cleared);
  if (recovery.action === 'hold_rotated') {
    dependencies.onRotated?.(recovery, terminal);
  } else if (recovery.action === 'retry_cold') {
    terminal.appOwnedRetryReason = 'codex_missing_resume';
    dependencies.onRetryCold?.(recovery, terminal);
  } else {
    dependencies.onRefused?.(recovery, terminal);
  }
  return {
    handled: true,
    action: recovery.action,
    reason: recovery.reason,
    retryReason: terminal.appOwnedRetryReason || null,
    recovery,
  };
}

function buildRetryRequest(terminal = {}, identity = {}) {
  const reason = String(terminal.appOwnedRetryReason || '').trim();
  const paneId = String(terminal.paneId || '').trim();
  const paneLaunchId = String(identity.paneLaunchId || '').trim();
  const appGeneration = String(identity.appGeneration || '').trim();
  const spawnRequestId = String(identity.spawnRequestId || '').trim();
  const pid = Number(identity.pid);
  if (!APP_OWNED_RETRY_REASONS.has(reason)
    || !paneId
    || !PANE_LAUNCH_ID_PATTERN.test(paneLaunchId)
    || !APP_GENERATION_PATTERN.test(appGeneration)
    || !spawnRequestId
    || !Number.isInteger(pid)
    || pid <= 0) {
    return null;
  }
  return {
    ...identity,
    event: 'spawn-retry-requested',
    paneId,
    reason,
    pid,
    paneLaunchId,
    appGeneration,
    spawnRequestId,
  };
}

function emitTerminalExitLifecycle(input = {}) {
  const terminal = input.terminal || {};
  const emit = typeof input.emit === 'function' ? input.emit : () => {};
  const identity = typeof input.identityFor === 'function'
    ? input.identityFor(terminal)
    : {};
  let retryEvent = null;
  if (terminal.appOwnedRetryEmitted !== true) {
    retryEvent = buildRetryRequest(terminal, identity);
    if (retryEvent) {
      terminal.appOwnedRetryEmitted = true;
      emit(retryEvent);
    }
  }
  input.beforeExit?.();
  const exitEvent = {
    ...identity,
    event: 'exit',
    paneId: String(terminal.paneId || ''),
    code: input.exitCode,
  };
  emit(exitEvent);
  return { retryEvent, exitEvent };
}

module.exports = {
  captureCodexResumeOutput,
  emitTerminalExitLifecycle,
  handleClaudeResumeOutput,
  handleCodexResumeExit,
};
