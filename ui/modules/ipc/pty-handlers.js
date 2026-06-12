/**
 * PTY IPC Handlers (via Daemon)
 * Channels: pty-create, pty-write, pty-write-chunked, send-trusted-enter,
 *           clipboard-paste-text, clipboard-write, input-edit-action, pty-resize, pty-kill, intent-update, spawn-claude,
 *           get-claude-state, get-daemon-terminals
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { resolvePaneCwd, resolveCoordPath } = require('../../config');
const {
  hasCodexDangerouslyBypassFlag,
  hasCodexAskForApprovalFlag,
} = require('../codex-utils');
const {
  resumeStrategyForCommand,
  claudeSessionExists,
  resolveResumeAppendFlags,
  hasClaudeResumeFlag,
  stripClaudeResumeFlags,
  ensureClaudeModelFlag,
} = require('../cli-resume-invocation');
const { ensurePaneSessionId, remintPaneSessionId } = require('../pane-session-id-store');
const { reapClaudeSessionProcesses } = require('../claude-session-process-reaper');
const {
  DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
  DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
} = require('../inject-message-ipc');
const { appendInputShadowLog } = require('../input-shadow-log');
const DEFAULT_CHUNK_SIZE = DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES;
const MIN_CHUNK_SIZE = 64;
const MAX_CHUNK_SIZE = 8192;
const DEFAULT_AUTO_CHUNK_THRESHOLD_BYTES = DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES;
const WRITE_ACK_TIMEOUT_MS = 2500;
const PANE_SESSION_IDS_FILE_PATH = resolveCoordPath(path.join('runtime', 'pane-session-ids.json'), { forWrite: true });
const STARTUP_INJECTION_CLAIM_CHANNEL = 'startup-injection-claim';
const STARTUP_INJECTION_RELEASE_CHANNEL = 'startup-injection-release';
const PANE_RESTART_BEGIN_CHANNEL = 'pane-restart-begin';
const PANE_RESTART_COMPLETE_CHANNEL = 'pane-restart-complete';
const INPUT_EDIT_ACTIONS = Object.freeze({
  undo: 'undo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
});

function sendReturnInputEvent(webContents) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}

function injectTextViaInputEvents(webContents, text) {
  const safeText = typeof text === 'string' ? text : String(text ?? '');
  for (let i = 0; i < safeText.length; i += 1) {
    const ch = safeText[i];
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && safeText[i + 1] === '\n') {
        i += 1;
      }
      sendReturnInputEvent(webContents);
      continue;
    }
    webContents.sendInputEvent({ type: 'char', keyCode: ch });
  }
}

function clampChunkSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, Math.floor(numeric)));
}

function normalizeYieldEveryChunks(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function resolveAutoChunkThresholdBytes() {
  const raw = Number(process.env.SQUIDRUN_PTY_WRITE_AUTO_CHUNK_THRESHOLD_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AUTO_CHUNK_THRESHOLD_BYTES;
  }
  return Math.floor(raw);
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pathSegments(value) {
  return String(value || '').split(/[\\/]+/).filter(Boolean);
}

function isInsideSquidRunPrivateRoot(candidatePath) {
  return pathSegments(path.resolve(candidatePath)).some((segment) => segment.toLowerCase() === '.squidrun');
}

function detectCliFromCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return 'claude';
  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('codex')) return 'codex';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('codex')) return 'codex';
  return 'claude';
}

function applyAutonomyFlagsToAgentCommand(command, settings = {}) {
  let agentCmd = String(command || '').trim();
  if (!agentCmd) return agentCmd;

  const autonomyConsentGiven = settings?.autonomyConsentGiven === true;
  const autonomyEnabled = autonomyConsentGiven && settings?.allowAllPermissions === true;
  if (!autonomyEnabled) return agentCmd;

  if (agentCmd.startsWith('claude') && !agentCmd.includes('--dangerously-skip-permissions')) {
    agentCmd = `${agentCmd} --dangerously-skip-permissions`;
  }
  if (agentCmd.startsWith('codex')) {
    const hasDangerouslyBypass = hasCodexDangerouslyBypassFlag(agentCmd);
    const hasAskForApproval = hasCodexAskForApprovalFlag(agentCmd);
    const hasYolo = agentCmd.includes('--yolo');
    if (!hasDangerouslyBypass && !hasYolo) {
      agentCmd = `${agentCmd} --yolo`;
    }
    if (!agentCmd.includes('--yolo') && !hasCodexDangerouslyBypassFlag(agentCmd)
        && !hasDangerouslyBypass && !hasAskForApproval) {
      agentCmd = `${agentCmd} -a never`;
    }
  }

  return agentCmd;
}

function resolveWindowsClaudeTempDir(cwd, env = process.env) {
  if (process.platform !== 'win32') return null;

  const winPath = path.win32;
  const seen = new Set();
  const candidates = [];
  const explicitTempRoot = toNonEmptyString(env.SQUIDRUN_WINDOWS_TMP)
    || toNonEmptyString(env.SQUIDRUN_TEMP_DIR);
  if (explicitTempRoot) {
    candidates.push(explicitTempRoot);
  }

  const cwdValue = toNonEmptyString(cwd);
  const parsedRoot = cwdValue ? toNonEmptyString(winPath.parse(cwdValue).root) : null;
  const systemDrive = toNonEmptyString(env.SystemDrive) || 'C:';
  const driveRoot = parsedRoot || `${systemDrive}\\`;
  candidates.push(winPath.join(driveRoot, 'squidrun-tmp'));
  candidates.push('C:\\squidrun-tmp');

  for (const candidateRaw of candidates) {
    const candidate = toNonEmptyString(candidateRaw);
    if (!candidate) continue;

    const normalized = winPath.normalize(candidate);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (/\s/.test(normalized)) continue;
    if (isInsideSquidRunPrivateRoot(normalized)) continue;

    try {
      fs.mkdirSync(normalized, { recursive: true });
      return normalized;
    } catch (_) {
      // Try next fallback candidate.
    }
  }

  return null;
}

function hasClaudeSystemPromptFlag(command) {
  return /--system-prompt-file(?:\s|=)/i.test(String(command || ''));
}

function appendResumeFlagsToAgentCommand({
  paneId,
  command,
  cwd,
  idStorePath = PANE_SESSION_IDS_FILE_PATH,
  homeDir = null,
  ensurePaneSessionIdOptions = {},
  remintSessionId = false,
  claudeModel = '',
  claudeModelHomeDir = null,
  claudeModelSettingsPath = null,
  claudeModelEnv = null,
} = {}) {
  const originalCommand = String(command || '').trim();
  const strippedCommand = remintSessionId
    ? stripClaudeResumeFlags(originalCommand)
    : originalCommand;
  const baseCommand = ensureClaudeModelFlag(strippedCommand, {
    preferredModel: claudeModel,
    ...(claudeModelHomeDir ? { homeDir: claudeModelHomeDir } : {}),
    ...(claudeModelSettingsPath ? { settingsPath: claudeModelSettingsPath } : {}),
    ...(claudeModelEnv ? { env: claudeModelEnv } : {}),
  });
  if (!baseCommand) {
    return {
      command: baseCommand,
      decision: { mode: 'cold', reason: 'empty command' },
    };
  }

  if (resumeStrategyForCommand(baseCommand) !== 'session-id') {
    return {
      command: baseCommand,
      decision: resolveResumeAppendFlags({ command: baseCommand }),
    };
  }

  if (hasClaudeResumeFlag(baseCommand)) {
    return {
      command: baseCommand,
      decision: {
        ...resolveResumeAppendFlags({ command: baseCommand }),
        mode: 'already-pinned',
        reason: 'claude resume/session flag already present',
      },
    };
  }

  const { sessionId, generated, previousSessionId, reminted } = remintSessionId
    ? remintPaneSessionId(idStorePath, paneId, ensurePaneSessionIdOptions)
    : ensurePaneSessionId(idStorePath, paneId, ensurePaneSessionIdOptions);
  const sessionExists = claudeSessionExists(cwd, sessionId, {
    ...(homeDir ? { homeDir } : {}),
  });
  const decision = resolveResumeAppendFlags({
    command: baseCommand,
    sessionId,
    sessionExists,
  });
  return {
    command: decision.flags ? `${baseCommand} ${decision.flags}` : baseCommand,
    decision: {
      ...decision,
      cwd,
      idStorePath,
      generated,
      previousSessionId,
      reminted: reminted === true,
    },
  };
}

function createStartupInjectionClaimStore() {
  const claims = new Map();

  return {
    claim(paneId, details = {}) {
      const id = String(paneId || '').trim();
      if (!id) {
        return { ok: false, claimed: false, reason: 'pane_id_required' };
      }

      const existing = claims.get(id);
      if (existing) {
        return {
          ok: true,
          claimed: false,
          reason: 'startup_injection_already_claimed',
          paneId: id,
          claim: { ...existing },
        };
      }

      const claim = {
        claimId: `startup-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        paneId: id,
        claimedAt: Date.now(),
        source: toNonEmptyString(details?.source) || 'unknown',
        modelType: toNonEmptyString(details?.modelType) || null,
        windowKey: toNonEmptyString(details?.windowKey) || null,
        profileName: toNonEmptyString(details?.profileName) || null,
      };
      claims.set(id, claim);
      return {
        ok: true,
        claimed: true,
        paneId: id,
        claim: { ...claim },
      };
    },

    clear(paneId) {
      const id = String(paneId || '').trim();
      if (!id) return false;
      return claims.delete(id);
    },

    release(paneId, claimId) {
      const id = String(paneId || '').trim();
      const releaseClaimId = String(claimId || '').trim();
      if (!id) {
        return { ok: false, released: false, reason: 'pane_id_required' };
      }
      if (!releaseClaimId) {
        return { ok: false, released: false, paneId: id, reason: 'claim_id_required' };
      }

      const existing = claims.get(id);
      if (!existing) {
        return { ok: true, released: false, paneId: id, reason: 'claim_not_found' };
      }
      if (existing.claimId !== releaseClaimId) {
        return {
          ok: false,
          released: false,
          paneId: id,
          reason: 'claim_id_mismatch',
          claim: { ...existing },
        };
      }

      claims.delete(id);
      return {
        ok: true,
        released: true,
        paneId: id,
        claim: { ...existing },
      };
    },

    get(paneId) {
      const claim = claims.get(String(paneId || '').trim());
      return claim ? { ...claim } : null;
    },

    clearAll() {
      claims.clear();
    },
  };
}

function getPaneCommandForRuntime(ctx, paneId) {
  const id = String(paneId);
  const paneCommands = ctx?.currentSettings?.paneCommands || {};
  const command = paneCommands[id];
  return typeof command === 'string' ? command : '';
}

function normalizeKernelMetaForTrace(kernelMeta) {
  if (!kernelMeta || typeof kernelMeta !== 'object') {
    return null;
  }
  const traceId = toNonEmptyString(kernelMeta.traceId)
    || toNonEmptyString(kernelMeta.correlationId)
    || null;
  const parentEventId = toNonEmptyString(kernelMeta.parentEventId)
    || toNonEmptyString(kernelMeta.causationId)
    || null;
  return {
    ...kernelMeta,
    traceId: traceId || undefined,
    correlationId: traceId || undefined,
    parentEventId: parentEventId || undefined,
    causationId: parentEventId || undefined,
  };
}

function isPaneHostSender(event) {
  const frameUrl = String(
    event?.senderFrame?.url
    || (typeof event?.sender?.getURL === 'function' ? event.sender.getURL() : '')
    || ''
  ).toLowerCase();
  return frameUrl.includes('/pane-host.html') || frameUrl.includes('\\pane-host.html');
}

const TERMINAL_FIT_TELEMETRY_MAX_LINES = 300;
let _terminalFitTelemetryPath = null;
function getTerminalFitTelemetryPath() {
  if (!_terminalFitTelemetryPath) {
    _terminalFitTelemetryPath = resolveCoordPath(path.join('runtime', 'terminal-fit-telemetry.jsonl'), { forWrite: true });
  }
  return _terminalFitTelemetryPath;
}

// Bounded append: keep only the last N lines so this diagnostic never grows unbounded
// (no-orphan-artifacts). Bug A's proof reads the tail to assert fit-coherence + redraw outcome.
function appendTerminalFitTelemetry(record) {
  const filePath = getTerminalFitTelemetryPath();
  let lines = [];
  try {
    if (fs.existsSync(filePath)) {
      lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    }
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(record));
  if (lines.length > TERMINAL_FIT_TELEMETRY_MAX_LINES) {
    lines = lines.slice(lines.length - TERMINAL_FIT_TELEMETRY_MAX_LINES);
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildChunkKernelMeta(kernelMeta, chunkIndex) {
  const normalized = normalizeKernelMetaForTrace(kernelMeta);
  if (!normalized) {
    return null;
  }
  const baseEventId = normalized.eventId || `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parentEventId = normalized.parentEventId || normalized.eventId || null;
  return {
    ...normalized,
    eventId: `${baseEventId}-c${chunkIndex + 1}`,
    parentEventId: parentEventId || undefined,
    causationId: parentEventId || undefined,
  };
}

async function writeWithAckIfAvailable(daemonClient, paneId, data, kernelMeta = null) {
  if (!daemonClient) {
    return { success: false, status: 'daemon_missing', error: 'daemonClient not available' };
  }

  if (typeof daemonClient.writeAndWaitAck === 'function') {
    return daemonClient.writeAndWaitAck(paneId, data, kernelMeta, { timeoutMs: WRITE_ACK_TIMEOUT_MS });
  }

  const sent = kernelMeta
    ? daemonClient.write(paneId, data, kernelMeta)
    : daemonClient.write(paneId, data);
  return sent === false
    ? { success: false, status: 'send_failed', error: 'Failed to send write to daemon' }
    : { success: true, status: 'sent_without_ack' };
}

async function writeChunkedText(daemonClient, paneId, fullText, options = {}, kernelMeta = null) {
  const text = String(fullText ?? '');
  const chunkSize = clampChunkSize(options?.chunkSize);
  const yieldEveryChunks = normalizeYieldEveryChunks(options?.yieldEveryChunks);

  let chunkCount = 0;
  if (text.length === 0) {
    const ack = await writeWithAckIfAvailable(
      daemonClient,
      paneId,
      '',
      normalizeKernelMetaForTrace(kernelMeta)
    );
    if (!ack?.success) {
      return {
        success: false,
        chunks: 0,
        chunkSize,
        error: ack?.error || ack?.status || 'chunk write failed',
      };
    }
    return { success: true, chunks: 1, chunkSize };
  }

  for (let offset = 0; offset < text.length; offset += chunkSize) {
    const chunk = text.slice(offset, offset + chunkSize);
    const chunkKernelMeta = buildChunkKernelMeta(kernelMeta, chunkCount);
    const ack = await writeWithAckIfAvailable(daemonClient, paneId, chunk, chunkKernelMeta);
    if (!ack?.success) {
      return {
        success: false,
        chunks: chunkCount,
        chunkSize,
        error: ack?.error || ack?.status || 'chunk write failed',
      };
    }
    chunkCount += 1;

    const hasMore = (offset + chunkSize) < text.length;
    if (hasMore && yieldEveryChunks > 0 && (chunkCount % yieldEveryChunks) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { success: true, chunks: chunkCount, chunkSize };
}

function registerPtyHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPtyHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  const { broadcastClaudeState, recordSessionStart, recordSessionLifecycle, updateIntentState } = deps;
  const getRecoveryManager = () => deps?.recoveryManager || ctx.recoveryManager;
  const getFirmwareManager = () => deps?.firmwareManager || ctx.firmwareManager;
  const getPaneRestartArbiter = () => deps?.paneRestartArbiter || ctx.paneRestartArbiter;
  const normalizeInstalledDeployment = (value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : null
  );
  const getInstalledDeployment = () => (
    normalizeInstalledDeployment(deps?.installedDeployment)
    || normalizeInstalledDeployment(ctx.installedDeployment)
    || null
  );
  const getDaemonClientForPane = (paneId) => {
    if (typeof deps?.getDaemonClientForPane === 'function') {
      const scopedClient = deps.getDaemonClientForPane(paneId);
      if (scopedClient) return scopedClient;
    }
    return ctx.daemonClient;
  };
  const isDeveloperMode = () => String(ctx?.currentSettings?.operatingMode || '').toLowerCase() === 'developer';
  const getPaneProjects = () => {
    const paneProjects = ctx?.currentSettings?.paneProjects;
    return paneProjects && typeof paneProjects === 'object' ? paneProjects : {};
  };
  const getActiveProjectRoot = () => {
    if (isDeveloperMode()) {
      return null;
    }
    try {
      const state = ctx?.watcher?.readState?.();
      const project = typeof state?.project === 'string' ? state.project.trim() : '';
      return project || null;
    } catch (_) {
      return null;
    }
  };
  const isFirmwareEnabled = () => ctx?.currentSettings?.firmwareInjectionEnabled === true;
  const getInstalledPaneDataRoot = () => {
    const deployment = getInstalledDeployment();
    const dataRoot = toNonEmptyString(deployment?.dataRoot);
    return deployment?.active === true && dataRoot ? path.resolve(dataRoot) : null;
  };
  const paneSessionIdsFilePath = deps.paneSessionIdsFilePath || PANE_SESSION_IDS_FILE_PATH;
  const resumeHomeDir = deps.resumeHomeDir || null;
  const claudeModelHomeDir = Object.prototype.hasOwnProperty.call(deps, 'claudeModelHomeDir')
    ? deps.claudeModelHomeDir
    : null;
  const claudeModelSettingsPath = deps.claudeModelSettingsPath || null;
  const claudeModelEnv = deps.claudeModelEnv || null;
  const reapClaudeSessionProcessesForSpawn = typeof deps.reapClaudeSessionProcesses === 'function'
    ? deps.reapClaudeSessionProcesses
    : reapClaudeSessionProcesses;
  const providedStartupInjectionClaims = deps.startupInjectionClaims;
  const startupInjectionClaims = (
    providedStartupInjectionClaims
    && typeof providedStartupInjectionClaims.claim === 'function'
    && typeof providedStartupInjectionClaims.clear === 'function'
  )
    ? providedStartupInjectionClaims
    : createStartupInjectionClaimStore();

  function normalizeRestartLifecycleOptions(options) {
    return options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  }

  async function reapPinnedClaudeSessionBeforeSpawn(paneId, decision = {}, details = {}) {
    if (decision?.cli !== 'claude' || !decision?.sessionId) {
      return { ok: true, skipped: true, reason: 'not_pinned_claude', sessionId: null };
    }
    const mode = String(decision.mode || '');
    if (!['create', 'resume', 'already-pinned'].includes(mode)) {
      return { ok: true, skipped: true, reason: 'not_spawn_pinned_mode', sessionId: decision.sessionId };
    }
    try {
      const result = await Promise.resolve(reapClaudeSessionProcessesForSpawn(decision.sessionId, {
        paneId: String(paneId || ''),
        cwd: details.cwd || decision.cwd || null,
        command: details.command || null,
        source: details.source || 'spawn',
      }));
      const killedCount = Array.isArray(result?.killed) ? result.killed.length : 0;
      const failedCount = Array.isArray(result?.failed) ? result.failed.length : 0;
      if (killedCount > 0 || failedCount > 0) {
        log.info(
          'PTY',
          `[resume] reaped pinned Claude session ${decision.sessionId} for pane ${paneId}: killed=${killedCount} failed=${failedCount}`
        );
      }
      return result || { ok: true, sessionId: decision.sessionId, killed: [] };
    } catch (err) {
      log.warn('PTY', `[resume] pinned Claude reap failed for pane ${paneId} session ${decision.sessionId}: ${err.message}`);
      return { ok: false, sessionId: decision.sessionId, error: err.message };
    }
  }

  function validateRestartLifecycleClaim(event, paneId, options, stage) {
    const lifecycleOptions = normalizeRestartLifecycleOptions(options);
    const restartClaimId = toNonEmptyString(String(lifecycleOptions.restartClaimId || ''));
    const requireRestartClaim = lifecycleOptions.requireRestartClaim === true || Boolean(restartClaimId);
    if (!requireRestartClaim) {
      // Claim-less lifecycle ops are legal only while no restart lease is active
      // for the pane; otherwise a concurrent flow could double-kill/double-spawn
      // around the lease holder (the S425 restart-storm shape).
      const arbiter = getPaneRestartArbiter();
      const activeClaim = arbiter && typeof arbiter.getActiveClaim === 'function'
        ? arbiter.getActiveClaim(paneId)
        : null;
      if (activeClaim) {
        return {
          ok: false,
          restart: false,
          reason: 'restart_in_progress_claim_required',
          paneId,
          stage,
          activeClaimId: activeClaim.claimId,
          options: lifecycleOptions,
        };
      }
      return { ok: true, restart: false, options: lifecycleOptions };
    }
    if (!restartClaimId) {
      return { ok: false, restart: true, reason: 'missing_restart_claim', paneId, stage, options: lifecycleOptions };
    }
    const arbiter = getPaneRestartArbiter();
    if (!arbiter || (typeof arbiter.authorizeOperation !== 'function' && typeof arbiter.validate !== 'function')) {
      return { ok: false, restart: true, reason: 'pane_restart_arbiter_unavailable', paneId, stage, options: lifecycleOptions };
    }
    const check = typeof arbiter.authorizeOperation === 'function'
      ? arbiter.authorizeOperation.bind(arbiter)
      : arbiter.validate.bind(arbiter);
    const result = check({
      paneId,
      claimId: restartClaimId,
      webContents: event?.sender || null,
      stage,
      operation: stage,
    });
    if (!result?.ok) {
      return {
        ok: false,
        restart: true,
        reason: result?.reason || 'restart_claim_denied',
        paneId,
        stage,
        options: lifecycleOptions,
      };
    }
    return { ok: true, restart: true, claim: result.claim, options: lifecycleOptions };
  }

  function restartClaimDeniedResult(validation, stage) {
    const reason = validation?.reason || 'restart_claim_denied';
    log.warn('PTY', `${stage}: refused restart lifecycle operation for pane ${validation?.paneId || 'unknown'} (${reason})`);
    return {
      success: false,
      error: 'restart_claim_denied',
      reason,
      stage,
    };
  }

  function resolveFirmwarePathForPane(paneId) {
    if (!isFirmwareEnabled()) return null;
    const firmwareManager = getFirmwareManager();
    if (!firmwareManager || typeof firmwareManager.ensureFirmwareForPane !== 'function') {
      return null;
    }
    const result = firmwareManager.ensureFirmwareForPane(paneId);
    if (!result?.ok || !result.firmwarePath) {
      return null;
    }
    return result.firmwarePath;
  }

  ipcMain.handle(STARTUP_INJECTION_CLAIM_CHANNEL, (event, payload = {}) => {
    const request = payload && typeof payload === 'object' ? payload : { paneId: payload };
    const result = startupInjectionClaims.claim(request.paneId, request);
    if (result.claimed) {
      log.info(
        'PTY',
        `Startup injection claim granted for pane ${result.paneId} (${result.claim?.source || 'unknown'})`
      );
    } else {
      log.info(
        'PTY',
        `Startup injection claim denied for pane ${String(request.paneId || '').trim() || 'unknown'}: ${result.reason}`
      );
    }
    return result;
  });

  ipcMain.handle(STARTUP_INJECTION_RELEASE_CHANNEL, (event, payload = {}) => {
    const request = payload && typeof payload === 'object' ? payload : { paneId: payload };
    const result = startupInjectionClaims.release(request.paneId, request.claimId);
    if (result.released) {
      log.info(
        'PTY',
        `Startup injection claim released for pane ${result.paneId} (${request.reason || 'unspecified'})`
      );
    } else {
      log.info(
        'PTY',
        `Startup injection claim release skipped for pane ${String(request.paneId || '').trim() || 'unknown'}: ${result.reason}`
      );
    }
    return result;
  });

  ipcMain.handle(PANE_RESTART_BEGIN_CHANNEL, (event, payload = {}) => {
    const request = payload && typeof payload === 'object' ? payload : { paneId: payload };
    const arbiter = getPaneRestartArbiter();
    if (!arbiter || typeof arbiter.begin !== 'function') {
      return { ok: false, granted: false, reason: 'pane_restart_arbiter_unavailable' };
    }
    const result = arbiter.begin({
      paneId: request.paneId,
      source: request.source || 'renderer-restart',
      requestId: request.requestId || null,
      webContents: event?.sender || null,
    });
    if (result.granted) {
      log.info('PTY', `Pane restart claim granted for pane ${result.paneId} (${result.claim?.source || 'unknown'})`);
    } else {
      log.info(
        'PTY',
        `Pane restart claim denied/coalesced for pane ${String(request.paneId || '').trim() || 'unknown'}: ${result.reason || 'not_granted'}`
      );
    }
    return result;
  });

  ipcMain.handle(PANE_RESTART_COMPLETE_CHANNEL, (event, payload = {}) => {
    const request = payload && typeof payload === 'object' ? payload : {};
    const arbiter = getPaneRestartArbiter();
    if (!arbiter || typeof arbiter.complete !== 'function') {
      return { ok: false, completed: false, reason: 'pane_restart_arbiter_unavailable' };
    }
    const result = arbiter.complete({
      paneId: request.paneId,
      claimId: request.claimId,
      status: request.status || null,
      reason: request.reason || null,
      error: request.error || null,
      webContents: event?.sender || null,
    });
    if (result.completed) {
      log.info('PTY', `Pane restart claim completed for pane ${result.paneId} (${request.status || 'unknown'})`);
    } else {
      log.info(
        'PTY',
        `Pane restart claim completion skipped for pane ${String(request.paneId || '').trim() || 'unknown'}: ${result.reason || 'not_completed'}`
      );
    }
    return result;
  });

  ipcMain.handle('pty-create', async (event, paneId, workingDir, options = {}) => {
    const daemonClient = getDaemonClientForPane(paneId);
    if (!daemonClient || !daemonClient.connected) {
      log.error('PTY', 'pty-create: Daemon not connected');
      return { error: 'Daemon not connected' };
    }

    const ptyOptions = options && typeof options === 'object' ? options : {};
    const restartClaim = validateRestartLifecycleClaim(event, paneId, ptyOptions, 'pty-create');
    if (!restartClaim.ok) {
      return restartClaimDeniedResult(restartClaim, 'pty-create');
    }
    const preferWorkingDir = ptyOptions.preferWorkingDir === true;
    const paneRoot = resolvePaneCwd(paneId, {
      paneProjects: getPaneProjects(),
      projectRoot: getActiveProjectRoot(),
    });
    const cwd = preferWorkingDir
      ? (workingDir || paneRoot || process.cwd())
      : (paneRoot || workingDir || process.cwd());
    const explicitPaneCommand = typeof ptyOptions.paneCommand === 'string'
      ? ptyOptions.paneCommand.trim()
      : '';
    let paneCommand = explicitPaneCommand || getPaneCommandForRuntime(ctx, paneId);
    paneCommand = applyAutonomyFlagsToAgentCommand(paneCommand, ctx?.currentSettings || {});
    const spawnCommandOnCreate = ptyOptions.spawnCommandOnCreate === true && Boolean(paneCommand);
    if (spawnCommandOnCreate) {
      const resumeCommand = appendResumeFlagsToAgentCommand({
        paneId,
        command: paneCommand,
        cwd,
        idStorePath: paneSessionIdsFilePath,
        homeDir: resumeHomeDir,
        claudeModel: ctx?.currentSettings?.claudeModel,
        claudeModelHomeDir,
        claudeModelSettingsPath,
        claudeModelEnv,
      });
      paneCommand = resumeCommand.command;
      if (resumeCommand.decision) {
        const decision = resumeCommand.decision;
        log.info(
          'PTY',
          `[resume] pty-create pane ${paneId}: ${decision.mode || 'cold'}${decision.cli ? ` (${decision.cli})` : ''}${decision.sessionId ? ` sessionId=${decision.sessionId}` : ''}${decision.flags ? ` -> ${decision.flags}` : ''}${decision.reason ? ` - ${decision.reason}` : ''}`
        );
        await reapPinnedClaudeSessionBeforeSpawn(paneId, decision, {
          cwd,
          command: paneCommand,
          source: 'pty-create',
        });
      }
    }
    const runtime = detectCliFromCommand(paneCommand);

    let spawnEnv = (ptyOptions.env && typeof ptyOptions.env === 'object')
      ? { ...ptyOptions.env }
      : null;

    const installedPaneDataRoot = getInstalledPaneDataRoot();
    if (installedPaneDataRoot) {
      spawnEnv = { ...(spawnEnv || {}), SQUIDRUN_DATA_ROOT: installedPaneDataRoot };
    }

    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE || '';
      if (userProfile && !userProfile.includes('~')) {
        const longTemp = path.join(userProfile, 'AppData', 'Local', 'Temp');
        spawnEnv = { ...(spawnEnv || {}), TEMP: longTemp, TMP: longTemp };
      }

      if (runtime === 'claude') {
        const compatTemp = resolveWindowsClaudeTempDir(cwd);
        if (compatTemp) {
          spawnEnv = {
            ...(spawnEnv || {}),
            TEMP: compatTemp,
            TMP: compatTemp,
            TMPDIR: compatTemp,
          };
        }
      }
    }

    if (runtime === 'gemini') {
      try {
        const firmwarePath = resolveFirmwarePathForPane(paneId);
        if (firmwarePath) {
          spawnEnv = spawnEnv || {};
          spawnEnv.GEMINI_SYSTEM_MD = firmwarePath;
        }
      } catch (err) {
        log.warn('Firmware', `Failed to resolve Gemini firmware for pane ${paneId}: ${err.message}`);
      }
    }

    startupInjectionClaims.clear(paneId);

    const spawnOptions = { paneCommand };
    if (spawnCommandOnCreate) {
      spawnOptions.spawnCommandOnCreate = true;
    }
    if (spawnEnv) {
      daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, null, spawnEnv, spawnOptions);
    } else {
      daemonClient.spawn(paneId, cwd, ctx.currentSettings.dryRun, null, null, spawnOptions);
    }
    return { paneId, cwd, dryRun: ctx.currentSettings.dryRun, paneCommand, spawnCommandOnCreate };
  });

  ipcMain.handle('pty-write', async (event, paneId, data, kernelMeta = null) => {
    appendInputShadowLog({
      paneId,
      source: 'ipc-handler',
      byteLen: Buffer.byteLength(String(data ?? ''), 'utf8'),
      text: data,
    });

    const daemonClient = getDaemonClientForPane(paneId);
    if (!daemonClient || !daemonClient.connected) {
      return { success: false, error: 'daemon_not_connected' };
    }
    try {
      const text = String(data ?? '');
      const autoChunkThresholdBytes = resolveAutoChunkThresholdBytes();
      const payloadBytes = Buffer.byteLength(text, 'utf8');
      if (payloadBytes >= autoChunkThresholdBytes && payloadBytes > 0) {
        const chunkedResult = await writeChunkedText(
          daemonClient,
          paneId,
          text,
          { chunkSize: DEFAULT_CHUNK_SIZE, yieldEveryChunks: 1 },
          kernelMeta
        );
        if (!chunkedResult?.success) {
          return {
            success: false,
            error: chunkedResult?.error || 'daemon_write_failed',
          };
        }
        return {
          success: true,
          chunked: true,
          chunks: chunkedResult.chunks,
          chunkSize: chunkedResult.chunkSize,
        };
      }

      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      const accepted = kernelMeta
        ? daemonClient.write(paneId, text, normalizedKernelMeta || kernelMeta)
        : daemonClient.write(paneId, text);
      if (!accepted) {
        return { success: false, error: 'daemon_write_failed' };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || 'daemon_write_failed' };
    }
  });

  ipcMain.handle('pty-write-chunked', async (event, paneId, fullText, options = {}, kernelMeta = null) => {
    const daemonClient = getDaemonClientForPane(paneId);
    if (!daemonClient || !daemonClient.connected) {
      return;
    }

    return writeChunkedText(daemonClient, paneId, fullText, options, kernelMeta);
  });

  ipcMain.handle('pty-pause', (event, paneId) => {
    const daemonClient = getDaemonClientForPane(paneId);
    if (daemonClient && daemonClient.connected) {
      daemonClient.pause(paneId);
    }
  });

  ipcMain.handle('pty-resume', (event, paneId) => {
    const daemonClient = getDaemonClientForPane(paneId);
    if (daemonClient && daemonClient.connected) {
      daemonClient.resume(paneId);
    }
  });

  ipcMain.handle('interrupt-pane', (event, paneId) => {
    const daemonClient = getDaemonClientForPane(paneId);
    if (!daemonClient || !daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }
    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }
    try {
      const writeAccepted = daemonClient.write(paneId, '\x03');
      if (writeAccepted === false) {
        return { success: false, error: 'daemon_write_failed' };
      }
    } catch (err) {
      return { success: false, error: err?.message || 'daemon_write_failed' };
    }
    log.info('PTY', `Interrupt sent to pane ${paneId}`);
    return { success: true };
  });

  // Send trusted keyboard Enter via Electron's native input API
  ipcMain.handle('send-trusted-enter', async () => {
    if (!ctx.mainWindow || !ctx.mainWindow.webContents) {
      return { success: false, error: 'mainWindow not available' };
    }
    try {
      if (typeof ctx.mainWindow.focus === 'function') {
        ctx.mainWindow.focus();
      }
      if (typeof ctx.mainWindow.webContents.focus === 'function') {
        ctx.mainWindow.webContents.focus();
      }
      sendReturnInputEvent(ctx.mainWindow.webContents);
      return { success: true };
    } catch (err) {
      log.error('PTY', 'send-trusted-enter failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Compatibility path for legacy callers.
  // Uses direct input insertion to avoid mutating global clipboard state.
  ipcMain.handle('clipboard-paste-text', async (_event, text) => {
    const webContents = ctx.mainWindow?.webContents;
    if (!webContents) {
      return { success: false, method: null, insertedLength: 0, error: 'mainWindow not available' };
    }

    const safeText = typeof text === 'string' ? text : String(text ?? '');
    if (safeText.length === 0) {
      return { success: true, method: 'noop', insertedLength: 0 };
    }

    try {
      if (typeof ctx.mainWindow.focus === 'function') {
        ctx.mainWindow.focus();
      }
      if (typeof webContents.focus === 'function') {
        webContents.focus();
      }
    } catch (_) {}

    try {
      if (typeof webContents.insertText === 'function') {
        await Promise.resolve(webContents.insertText(safeText));
        return { success: true, method: 'insertText', insertedLength: safeText.length };
      }

      if (typeof webContents.sendInputEvent === 'function') {
        injectTextViaInputEvents(webContents, safeText);
        return { success: true, method: 'sendInputEvent', insertedLength: safeText.length, fallback: true };
      }

      return { success: false, method: null, insertedLength: 0, error: 'No text injection method available' };
    } catch (err) {
      log.error('PTY', 'clipboard-paste-text failed:', err);
      return { success: false, method: null, insertedLength: 0, error: err.message };
    }
  });

  ipcMain.handle('clipboard-write', async (event, text) => {
    const { clipboard } = require('electron');
    try {
      const safeText = typeof text === 'string' ? text : String(text ?? '');
      clipboard.writeText(safeText);
      return { success: true };
    } catch (err) {
      log.error('PTY', 'clipboard-write failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('input-edit-action', async (event, action) => {
    const webContents = ctx.mainWindow?.webContents;
    if (!webContents) {
      return { success: false, error: 'mainWindow not available' };
    }

    const normalizedAction = String(action || '').trim();
    const method = INPUT_EDIT_ACTIONS[normalizedAction];
    if (!method || typeof webContents[method] !== 'function') {
      return { success: false, error: 'unsupported_action' };
    }

    try {
      webContents[method]();
      return { success: true };
    } catch (err) {
      log.error('PTY', `input-edit-action failed (${normalizedAction}):`, err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('pty-resize', (event, paneId, cols, rows, kernelMeta = null) => {
    // Hidden pane hosts are mirror windows and must not own PTY geometry.
    // Only the visible renderer should drive resize to avoid cursor/wrap drift.
    if (isPaneHostSender(event)) {
      log.warn('PTY', `Ignored pane-host resize for pane ${paneId} (${cols}x${rows})`);
      return { ignored: true, reason: 'pane_host_resize_blocked' };
    }

    const daemonClient = getDaemonClientForPane(paneId);
    if (daemonClient && daemonClient.connected) {
      const normalizedKernelMeta = normalizeKernelMetaForTrace(kernelMeta);
      if (kernelMeta) {
        daemonClient.resize(paneId, cols, rows, normalizedKernelMeta || kernelMeta);
      } else {
        daemonClient.resize(paneId, cols, rows);
      }
    }
    return { ignored: false };
  });

  // Bug A: renderer-side fit-coherence + redraw paint-outcome telemetry for the
  // post-burst settle redraw. Pane-host mirrors must not write geometry telemetry.
  ipcMain.handle('terminal-fit-telemetry', (event, payload = {}) => {
    if (isPaneHostSender(event)) {
      return { ignored: true, reason: 'pane_host_telemetry_blocked' };
    }
    const paneId = payload && payload.paneId != null ? String(payload.paneId) : '';
    if (!paneId) {
      return { ignored: true, reason: 'missing_pane_id' };
    }
    try {
      appendTerminalFitTelemetry({
        paneId,
        operation: typeof payload.operation === 'string' ? payload.operation : 'settle_redraw',
        ts: Number(payload.ts) || Date.now(),
        xtermCols: payload.xtermCols ?? null,
        xtermRows: payload.xtermRows ?? null,
        proposedCols: payload.proposedCols ?? null,
        proposedRows: payload.proposedRows ?? null,
        appliedCols: payload.appliedCols ?? null,
        appliedRows: payload.appliedRows ?? null,
        coherent: payload.coherent === true,
        quietSettle: payload.quietSettle === true,
        painted: payload.painted === true,
        beforeSignature: typeof payload.beforeSignature === 'string' ? payload.beforeSignature : null,
        afterSignature: typeof payload.afterSignature === 'string' ? payload.afterSignature : null,
      });
      return { ok: true };
    } catch (err) {
      log.warn('PTY', `terminal-fit-telemetry write failed: ${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('pty-kill', (event, paneId, options = {}) => {
    const killOptions = normalizeRestartLifecycleOptions(options);
    const restartClaim = validateRestartLifecycleClaim(event, paneId, killOptions, 'pty-kill');
    if (!restartClaim.ok) {
      return restartClaimDeniedResult(restartClaim, 'pty-kill');
    }
    startupInjectionClaims.clear(paneId);
    const daemonClient = getDaemonClientForPane(paneId);
    if (daemonClient && daemonClient.connected) {
      const recoveryManager = getRecoveryManager();
      if (paneId && recoveryManager?.markExpectedExit) {
        recoveryManager.markExpectedExit(
          paneId,
          restartClaim.restart ? (killOptions.expectedExitReason || 'restart') : 'manual-kill'
        );
      }
      daemonClient.kill(paneId);
    }
    return { success: true, paneId, restarted: restartClaim.restart === true };
  });

  ipcMain.handle('intent-update', async (event, payload = {}) => {
    if (typeof updateIntentState !== 'function') {
      return { ok: false, reason: 'intent_update_unavailable' };
    }
    return updateIntentState(payload);
  });

  ipcMain.handle('spawn-claude', async (event, paneId, _workingDir, options = {}) => {
    const spawnOptions = normalizeRestartLifecycleOptions(options);
    const restartClaim = validateRestartLifecycleClaim(event, paneId, spawnOptions, 'spawn-claude');
    if (!restartClaim.ok) {
      return restartClaimDeniedResult(restartClaim, 'spawn-claude');
    }
    // Dry-run mode - simulate without spawning real agents
    if (ctx.currentSettings.dryRun) {
      ctx.agentRunning.set(paneId, 'running');
      broadcastClaudeState();
      return { success: true, command: null, dryRun: true };
    }

    const daemonClient = getDaemonClientForPane(paneId);
    if (!daemonClient || !daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    ctx.agentRunning.set(paneId, 'starting');
    broadcastClaudeState();
    recordSessionStart(paneId);
    if (typeof recordSessionLifecycle === 'function') {
      await Promise.resolve(recordSessionLifecycle({
        paneId,
        status: 'started',
        reason: 'spawn_requested',
      }));
    }

    const paneCommands = ctx.currentSettings.paneCommands || {};
    let agentCmd = (paneCommands[paneId] || 'claude').trim();
    if (!agentCmd) agentCmd = 'claude';
    const runtime = detectCliFromCommand(agentCmd);

    if (isFirmwareEnabled()) {
      const firmwareManager = getFirmwareManager();
      if (firmwareManager) {
        try {
          if (runtime === 'claude') {
            const firmwarePath = resolveFirmwarePathForPane(paneId);
            if (firmwarePath && !hasClaudeSystemPromptFlag(agentCmd)) {
              agentCmd = `${agentCmd} --system-prompt-file "${firmwarePath}"`;
            }
          } else if (runtime === 'codex' && typeof firmwareManager.applyCodexOverrideForPane === 'function') {
            firmwareManager.applyCodexOverrideForPane(paneId);
          }
        } catch (err) {
          log.warn('Firmware', `Failed firmware preparation for pane ${paneId}: ${err.message}`);
        }
      }
    }

    agentCmd = applyAutonomyFlagsToAgentCommand(agentCmd, ctx?.currentSettings || {});

    const workDir = resolvePaneCwd(paneId, {
      paneProjects: getPaneProjects(),
      projectRoot: getActiveProjectRoot(),
    }) || process.cwd();
    const resumeCommand = appendResumeFlagsToAgentCommand({
      paneId,
      command: agentCmd,
      cwd: workDir,
      idStorePath: paneSessionIdsFilePath,
      homeDir: resumeHomeDir,
      claudeModel: ctx?.currentSettings?.claudeModel,
      claudeModelHomeDir,
      claudeModelSettingsPath,
      claudeModelEnv,
      remintSessionId: spawnOptions.remintClaudeSessionId === true,
    });
    agentCmd = resumeCommand.command;
    if (resumeCommand.decision) {
      const decision = resumeCommand.decision;
      log.info(
        'PTY',
        `[resume] spawn-claude pane ${paneId}: ${decision.mode || 'cold'}${decision.cli ? ` (${decision.cli})` : ''}${decision.sessionId ? ` sessionId=${decision.sessionId}` : ''}${decision.flags ? ` -> ${decision.flags}` : ''}${decision.reason ? ` - ${decision.reason}` : ''}`
      );
      await reapPinnedClaudeSessionBeforeSpawn(paneId, decision, {
        cwd: workDir,
        command: agentCmd,
        source: spawnOptions.remintClaudeSessionId === true ? 'spawn-claude-remint' : 'spawn-claude',
      });
    }

    return {
      success: true,
      command: agentCmd,
      remintedClaudeSessionId: resumeCommand.decision?.reminted === true,
      previousClaudeSessionId: resumeCommand.decision?.previousSessionId || null,
      claudeSessionId: resumeCommand.decision?.sessionId || null,
    };
  });

  ipcMain.handle('get-claude-state', () => {
    return Object.fromEntries(ctx.agentRunning);
  });

  ipcMain.handle('get-daemon-terminals', (event, options = {}) => {
    const windowKey = String(options?.windowKey || '').trim().toLowerCase();
    const paneId = String(options?.paneId || (windowKey === 'trustquote' ? 'trustquote-builder' : '')).trim();
    const daemonClient = paneId ? getDaemonClientForPane(paneId) : ctx.daemonClient;
    if (daemonClient) {
      return daemonClient.getTerminals();
    }
    return [];
  });
}

function unregisterPtyHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('pty-create');
    ipcMain.removeHandler('pty-write');
    ipcMain.removeHandler('pty-write-chunked');
    ipcMain.removeHandler('pty-pause');
    ipcMain.removeHandler('pty-resume');
    ipcMain.removeHandler('interrupt-pane');
    ipcMain.removeHandler('send-trusted-enter');
    ipcMain.removeHandler('clipboard-paste-text');
    ipcMain.removeHandler('clipboard-write');
    ipcMain.removeHandler('input-edit-action');
    ipcMain.removeHandler('pty-resize');
    ipcMain.removeHandler('terminal-fit-telemetry');
    ipcMain.removeHandler('pty-kill');
    ipcMain.removeHandler('intent-update');
    ipcMain.removeHandler(STARTUP_INJECTION_CLAIM_CHANNEL);
    ipcMain.removeHandler(STARTUP_INJECTION_RELEASE_CHANNEL);
    ipcMain.removeHandler(PANE_RESTART_BEGIN_CHANNEL);
    ipcMain.removeHandler(PANE_RESTART_COMPLETE_CHANNEL);
    ipcMain.removeHandler('spawn-claude');
    ipcMain.removeHandler('get-claude-state');
    ipcMain.removeHandler('get-daemon-terminals');
  }
}

registerPtyHandlers.unregister = unregisterPtyHandlers;

module.exports = {
  registerPtyHandlers,
  _internals: {
    isInsideSquidRunPrivateRoot,
    resolveWindowsClaudeTempDir,
    hasClaudeResumeFlag,
    appendResumeFlagsToAgentCommand,
    createStartupInjectionClaimStore,
    appendTerminalFitTelemetry,
    getTerminalFitTelemetryPath,
  },
};
