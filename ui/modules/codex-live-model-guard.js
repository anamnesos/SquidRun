const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAIN_ORACLE_CODEX_POLICY,
  SOURCE_PROJECT_ROOT,
  pathsEqual,
} = require('./codex-seat-model-policy');
const {
  loadValidatedBinding,
} = require('./codex-pane-session-store');

const TRACE_SCHEMA = 'squidrun.codex_live_model_guard_receipt.v1';
const DEFAULT_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const EXACT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_PANE_LAUNCH_ID_PATTERN = /^pl_[0-9a-f]{32}$/i;
const EXACT_APP_GENERATION_PATTERN = /^app-session-[1-9][0-9]*$/i;
const BLOCK_MESSAGE = 'MODEL DRIFT: Oracle is not running on the required Sol/xhigh policy. Work stopped before it could continue.';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value) {
  return normalizeText(value).toLowerCase();
}

function defaultCodexSessionRoot(env = process.env) {
  const codexHome = normalizeText(env.CODEX_HOME);
  return path.resolve(codexHome || path.join(os.homedir(), '.codex'), 'sessions');
}

function isPathInside(candidate, root, platform = process.platform) {
  const candidatePath = path.resolve(candidate);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative === '.') return false;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (platform === 'win32') {
    return candidatePath.toLowerCase().startsWith(`${rootPath.toLowerCase()}${path.sep}`);
  }
  return true;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode;
}

function recordState(record) {
  if (!record || typeof record !== 'object') return null;
  const ordinal = Number(record.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return null;

  if (record.type === 'turn_context') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    return {
      source: 'turn_context',
      ordinal,
      timestamp: normalizeText(record.timestamp) || null,
      turnId: normalizeText(payload.turn_id) || null,
      cwd: normalizeText(payload.cwd) || null,
      model: normalizeIdentity(payload.model),
      effort: normalizeIdentity(
        payload.effort
        || payload.collaboration_mode?.settings?.reasoning_effort
      ),
    };
  }

  if (record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied') {
    const settings = record.payload.thread_settings;
    if (!settings || typeof settings !== 'object') return null;
    return {
      source: 'thread_settings_applied',
      ordinal,
      timestamp: normalizeText(record.timestamp) || null,
      turnId: null,
      cwd: normalizeText(settings.cwd) || null,
      model: normalizeIdentity(settings.model),
      effort: normalizeIdentity(settings.reasoning_effort),
    };
  }

  return null;
}

function readLatestLiveState(transcriptPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const sessionId = normalizeText(options.sessionId);
  const platform = options.platform || process.platform;
  const codexSessionRoot = path.resolve(
    options.codexSessionRoot || defaultCodexSessionRoot(options.env || process.env)
  );
  const targetPath = path.resolve(normalizeText(transcriptPath));
  if (!targetPath || !sessionId || !EXACT_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, reason: 'transcript_identity_invalid' };
  }
  if (!isPathInside(targetPath, codexSessionRoot, platform)) {
    return { ok: false, reason: 'transcript_outside_codex_session_root' };
  }
  if (!path.basename(targetPath).toLowerCase().includes(sessionId.toLowerCase())) {
    return { ok: false, reason: 'transcript_session_id_mismatch' };
  }

  let descriptor;
  try {
    const before = fsImpl.lstatSync(targetPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, reason: 'transcript_not_regular_file' };
    }
    descriptor = fsImpl.openSync(targetPath, 'r');
    const opened = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened)) {
      return { ok: false, reason: 'transcript_identity_changed_before_read' };
    }

    const maxTailBytes = Math.max(
      64 * 1024,
      Math.min(32 * 1024 * 1024, Number(options.maxTailBytes) || DEFAULT_MAX_TAIL_BYTES)
    );
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      return { ok: false, reason: 'transcript_size_invalid' };
    }
    const length = Math.min(size, maxTailBytes);
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = length > 0 ? fsImpl.readSync(descriptor, buffer, 0, length, offset) : 0;
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after)) {
      return { ok: false, reason: 'transcript_changed_during_read' };
    }

    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const lines = text.split(/\r?\n/);
    let latest = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const state = recordState(parsed);
      if (!state || !state.model || !state.effort || !state.cwd) continue;
      if (!latest || state.ordinal > latest.ordinal) latest = state;
      if (latest === state) break;
    }
    if (!latest) {
      return {
        ok: false,
        reason: offset > 0
          ? 'live_model_state_not_found_in_bounded_tail'
          : 'live_model_state_not_found',
        bytesRead,
      };
    }
    return {
      ok: true,
      state: latest,
      bytesRead,
      transcriptPath: targetPath,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'transcript_read_failed',
      error: error?.code || error?.message || String(error),
    };
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function classifyScope(payload = {}, options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const role = normalizeIdentity(env.SQUIDRUN_ROLE);
  const paneId = normalizeText(env.SQUIDRUN_PANE_ID);
  if (role !== MAIN_ORACLE_CODEX_POLICY.role && paneId !== MAIN_ORACLE_CODEX_POLICY.paneId) {
    return { applicable: false, reason: 'not_main_oracle_seat' };
  }

  const expectedInstallRoot = path.resolve(options.expectedInstallRoot);
  const guardInstallRoot = path.resolve(options.guardInstallRoot || SOURCE_PROJECT_ROOT);
  const profile = normalizeIdentity(env.SQUIDRUN_PROFILE);
  const cwd = normalizeText(payload.cwd);
  if (role !== MAIN_ORACLE_CODEX_POLICY.role
      || paneId !== MAIN_ORACLE_CODEX_POLICY.paneId
      || profile !== MAIN_ORACLE_CODEX_POLICY.profile
      || !pathsEqual(guardInstallRoot, expectedInstallRoot, options.platform)
      || !cwd) {
    return { applicable: true, ok: false, reason: 'oracle_guard_identity_mismatch' };
  }

  const bindingStorePath = path.resolve(
    options.bindingStorePath
    || path.join(expectedInstallRoot, '.squidrun', 'runtime', 'codex-pane-sessions.json')
  );
  const loadedBinding = loadValidatedBinding(bindingStorePath, paneId, {
    expectedCwd: cwd,
    ...(options.codexSessionRoot ? { codexSessionRoot: options.codexSessionRoot } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const sessionId = normalizeText(payload.session_id || payload.sessionId).toLowerCase();
  const transcriptPath = normalizeText(payload.transcript_path || payload.transcriptPath);
  const paneLaunchId = normalizeText(env.SQUIDRUN_PANE_LAUNCH_ID);
  const appGeneration = normalizeText(env.SQUIDRUN_APP_GENERATION);
  const binding = loadedBinding.ok ? loadedBinding.binding : null;
  const continuingMainBinding = Boolean(
    binding
    && sessionId
    && binding.sessionId.toLowerCase() === sessionId
    && transcriptPath
    && pathsEqual(binding.transcriptPath, transcriptPath, options.platform)
  );
  const exactMainBinding = Boolean(
    continuingMainBinding
    && paneLaunchId
    && binding.paneLaunchId === paneLaunchId
    && appGeneration
    && binding.appGeneration === appGeneration
  );
  const dataRoot = normalizeText(env.SQUIDRUN_DATA_ROOT);
  if (exactMainBinding) {
    if (dataRoot && !pathsEqual(dataRoot, expectedInstallRoot, options.platform)) {
      return { applicable: true, ok: false, reason: 'main_oracle_data_root_mismatch' };
    }
    return { applicable: true, ok: true, reason: 'main_oracle_seat', binding };
  }

  const hookEvent = normalizeText(payload.hook_event_name || payload.hookEventName);
  const source = normalizeIdentity(payload.source);
  const refreshMayRace = hookEvent === 'SessionStart'
    && (source === 'resume' || source === 'compact')
    && continuingMainBinding
    && EXACT_PANE_LAUNCH_ID_PATTERN.test(paneLaunchId)
    && EXACT_APP_GENERATION_PATTERN.test(appGeneration);
  if (refreshMayRace) {
    if (dataRoot && !pathsEqual(dataRoot, expectedInstallRoot, options.platform)) {
      return { applicable: true, ok: false, reason: 'main_oracle_data_root_mismatch' };
    }
    return {
      applicable: true,
      ok: true,
      bindingPending: true,
      reason: 'main_oracle_binding_refresh_pending',
      binding,
    };
  }

  if (dataRoot && !pathsEqual(dataRoot, expectedInstallRoot, options.platform)) {
    return { applicable: false, ok: true, reason: 'different_squidrun_install' };
  }

  if (hookEvent === 'SessionStart' && (source === 'startup' || source === 'clear')) {
    return {
      applicable: true,
      ok: true,
      bindingPending: true,
      reason: 'main_oracle_binding_pending_startup',
    };
  }

  return {
    applicable: true,
    ok: false,
    reason: loadedBinding.ok
      ? 'main_oracle_binding_mismatch'
      : loadedBinding.reason === 'binding_absent'
        ? 'main_oracle_binding_absent'
        : `main_oracle_binding_${loadedBinding.reason || 'invalid'}`,
  };
}

function evaluateOracleModelGuard(payload = {}, options = {}) {
  const expectedInstallRoot = normalizeText(options.expectedInstallRoot);
  if (!expectedInstallRoot) {
    return { applicable: true, ok: false, reason: 'expected_install_root_required' };
  }
  const scope = classifyScope(payload, { ...options, expectedInstallRoot });
  if (!scope.applicable) return { applicable: false, ok: true, reason: scope.reason };
  if (!scope.ok) return { applicable: true, ok: false, reason: scope.reason };

  const expectedModel = normalizeIdentity(options.expectedModel || MAIN_ORACLE_CODEX_POLICY.model);
  const expectedEffort = normalizeIdentity(options.expectedEffort || MAIN_ORACLE_CODEX_POLICY.effort);
  const payloadModel = normalizeIdentity(payload.model);
  if (payloadModel !== expectedModel) {
    return {
      applicable: true,
      ok: false,
      reason: 'live_payload_model_mismatch',
      expectedModel,
      expectedEffort,
      payloadModel: payloadModel || null,
    };
  }

  const sessionId = normalizeText(payload.session_id || payload.sessionId);
  const transcriptPath = normalizeText(payload.transcript_path || payload.transcriptPath);
  const live = readLatestLiveState(transcriptPath, {
    ...options,
    sessionId,
  });
  const hookEvent = normalizeText(payload.hook_event_name || payload.hookEventName);
  const source = normalizeIdentity(payload.source);
  if (!live.ok) {
    const initialStartMayAwaitFirstTurn = hookEvent === 'SessionStart'
      && (source === 'startup' || source === 'clear')
      && live.reason === 'live_model_state_not_found';
    if (initialStartMayAwaitFirstTurn) {
      return {
        applicable: true,
        ok: true,
        limited: true,
        bindingPending: scope.bindingPending === true,
        reason: 'startup_model_verified_effort_pending_first_turn',
        expectedModel,
        expectedEffort,
        payloadModel,
      };
    }
    return {
      applicable: true,
      ok: false,
      reason: live.reason,
      expectedModel,
      expectedEffort,
      payloadModel,
      transcriptError: live.error || null,
    };
  }

  const state = live.state;
  if (!pathsEqual(state.cwd, payload.cwd, options.platform)) {
    return {
      applicable: true,
      ok: false,
      reason: 'live_state_cwd_mismatch',
      expectedModel,
      expectedEffort,
      payloadModel,
      state,
    };
  }
  if (state.model !== expectedModel || state.effort !== expectedEffort) {
    return {
      applicable: true,
      ok: false,
      reason: 'live_model_or_effort_mismatch',
      expectedModel,
      expectedEffort,
      payloadModel,
      state,
    };
  }

  const turnId = normalizeText(payload.turn_id || payload.turnId);
  if (turnId && state.source === 'turn_context' && state.turnId !== turnId) {
    return {
      applicable: true,
      ok: false,
      reason: 'live_turn_context_mismatch',
      expectedModel,
      expectedEffort,
      payloadModel,
      state,
      turnId,
    };
  }

  const bindingPending = scope.bindingPending === true;
  return {
    applicable: true,
    ok: true,
    ...(bindingPending ? { limited: true, bindingPending: true } : {}),
    reason: bindingPending ? scope.reason : 'live_model_policy_verified',
    expectedModel,
    expectedEffort,
    payloadModel,
    state,
    bytesRead: live.bytesRead,
  };
}

function hookResponseFor(result, payload = {}) {
  if (result?.ok === true) {
    return normalizeText(payload.hook_event_name) === 'Stop' ? { continue: true } : {};
  }
  const eventName = normalizeText(payload.hook_event_name || payload.hookEventName);
  const reason = `${BLOCK_MESSAGE} (${result?.reason || 'model_drift'})`;
  if (eventName === 'PreToolUse') {
    return {
      systemMessage: reason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  if (eventName === 'UserPromptSubmit') {
    return { decision: 'block', reason, systemMessage: reason };
  }
  return {
    continue: false,
    stopReason: result?.reason || 'model_drift',
    systemMessage: reason,
  };
}

function appendGuardTrace(tracePath, result, payload = {}, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const state = result?.state || null;
  const record = {
    schema: TRACE_SCHEMA,
    at: new Date().toISOString(),
    applicable: result?.applicable === true,
    ok: result?.ok === true,
    limited: result?.limited === true,
    reason: result?.reason || null,
    hookEvent: normalizeText(payload.hook_event_name || payload.hookEventName) || null,
    sessionId: normalizeText(payload.session_id || payload.sessionId) || null,
    turnId: normalizeText(payload.turn_id || payload.turnId) || null,
    expectedModel: result?.expectedModel || options.expectedModel || null,
    expectedEffort: result?.expectedEffort || options.expectedEffort || null,
    payloadModel: result?.payloadModel || normalizeIdentity(payload.model) || null,
    observedModel: state?.model || null,
    observedEffort: state?.effort || null,
    stateSource: state?.source || null,
    stateOrdinal: Number.isSafeInteger(state?.ordinal) ? state.ordinal : null,
    stateTimestamp: state?.timestamp || null,
  };
  try {
    fsImpl.mkdirSync(path.dirname(tracePath), { recursive: true });
    fsImpl.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, 'utf8');
    return { ok: true, record };
  } catch (error) {
    return { ok: false, reason: 'guard_trace_write_failed', error: error?.message || String(error), record };
  }
}

module.exports = {
  TRACE_SCHEMA,
  DEFAULT_MAX_TAIL_BYTES,
  EXACT_SESSION_ID_PATTERN,
  BLOCK_MESSAGE,
  appendGuardTrace,
  classifyScope,
  defaultCodexSessionRoot,
  evaluateOracleModelGuard,
  hookResponseFor,
  readLatestLiveState,
  recordState,
  _internals: {
    isPathInside,
    sameFileIdentity,
  },
};
