'use strict';

const { stripAnsi } = require('../ansi');

const DEFAULT_CONFIG = Object.freeze({
  startupGraceMs: 60 * 1000,
  maxColdSpawnAgeMs: 10 * 60 * 1000,
  sampleIntervalMs: 500,
  blankSustainMs: 2 * 1000,
  confirmSamples: 3,
  recentOutputMs: 2 * 1000,
  outcomeTimeoutMs: 5 * 1000,
  rawTailChars: 64 * 1024,
  minRawBytes: 512,
  minEraseOps: 8,
  minCursorOps: 2,
  minClearOpsPerKb: 1,
});

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function countMatches(value, pattern) {
  return (String(value || '').match(pattern) || []).length;
}

function analyzeColdSpawnOutput(value = '') {
  const raw = typeof value === 'string' ? value : String(value || '');
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const eraseLineOps = countMatches(raw, /\u001b\[(?:[012]?K)/g);
  const eraseDisplayOps = countMatches(raw, /\u001b\[(?:[012]?J)/g);
  const cursorOps = countMatches(raw, /\u001b\[(?:H|[0-9]+(?:;[0-9]+)?H)/g);
  const clearOps = eraseLineOps + eraseDisplayOps + cursorOps;
  const visibleText = stripAnsi(raw)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  const kb = Math.max(1, rawBytes / 1024);

  return {
    rawBytes,
    eraseLineOps,
    eraseDisplayOps,
    cursorOps,
    clearOps,
    clearOpsPerKb: clearOps / kb,
    visibleChars: visibleText.length,
  };
}

function outputLooksLikeClearScreenStorm(analysis = {}, config = DEFAULT_CONFIG) {
  return Boolean(
    analysis.rawBytes >= config.minRawBytes
    && (analysis.eraseLineOps + analysis.eraseDisplayOps) >= config.minEraseOps
    && analysis.cursorOps >= config.minCursorOps
    && analysis.clearOpsPerKb >= config.minClearOpsPerKb
  );
}

function normalizeSurface(value = null) {
  const surface = value && typeof value === 'object' ? value : {};
  const visibleText = typeof surface.visibleText === 'string'
    ? surface.visibleText
    : '';
  const visibleChars = Number.isFinite(Number(surface.visibleChars))
    ? Number(surface.visibleChars)
    : visibleText.replace(/\s/g, '').length;
  return {
    ready: surface.ready === true,
    reason: String(surface.reason || (surface.ready === true ? 'ready' : 'renderer_unavailable')),
    visibleText,
    visibleChars,
    cols: toFiniteNumber(surface.cols, null),
    rows: toFiniteNumber(surface.rows, null),
    width: toFiniteNumber(surface.width, null),
    height: toFiniteNumber(surface.height, null),
  };
}

function createPaneState(paneId, metadata, nowMs) {
  return {
    paneId: String(paneId),
    source: String(metadata?.source || 'unknown'),
    startedAtMs: toFiniteNumber(metadata?.startedAtMs, nowMs),
    armedAtMs: nowMs,
    ptyAlive: metadata?.ptyAlive !== false,
    rawTail: '',
    firstOutputAtMs: 0,
    lastOutputAtMs: 0,
    blankClearSinceMs: 0,
    blankClearSamples: 0,
    attempted: false,
    attemptCount: 0,
    actionAtMs: 0,
    actionAccepted: false,
    finished: false,
    lastHoldReason: null,
    sampleTimer: null,
    outcome: null,
  };
}

function createColdSpawnBlankRecoveryController(options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...((options.config && typeof options.config === 'object') ? options.config : {}),
  };
  const states = new Map();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const sampleSurface = typeof options.sampleSurface === 'function'
    ? options.sampleSurface
    : () => ({ ready: false, reason: 'surface_sampler_unavailable' });
  const isCodexPane = typeof options.isCodexPane === 'function'
    ? options.isCodexPane
    : () => false;
  const getInputBlockReason = typeof options.getInputBlockReason === 'function'
    ? options.getInputBlockReason
    : () => null;
  const sendRecovery = typeof options.sendRecovery === 'function'
    ? options.sendRecovery
    : async () => false;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  function emit(phase, state, details = {}) {
    onEvent({
      phase,
      paneId: state.paneId,
      source: state.source,
      timestampMs: now(),
      attempt: state.attemptCount,
      ...details,
    });
  }

  function clearSampleTimer(state) {
    if (!state?.sampleTimer) return;
    clearTimer(state.sampleTimer);
    state.sampleTimer = null;
  }

  function scheduleEvaluation(state, delayMs = config.sampleIntervalMs) {
    if (!state || state.finished || state.sampleTimer) return;
    const delay = Math.max(0, toFiniteNumber(delayMs, config.sampleIntervalMs));
    state.sampleTimer = setTimer(() => {
      state.sampleTimer = null;
      void evaluate(state.paneId);
    }, delay);
  }

  function finish(state, status, details = {}) {
    if (!state || state.finished) return;
    clearSampleTimer(state);
    state.finished = true;
    state.outcome = status;
    emit('outcome', state, {
      status,
      actionLatencyMs: state.actionAtMs ? Math.max(0, now() - state.actionAtMs) : null,
      ...details,
    });
  }

  function hold(state, reason, details = {}) {
    if (state.lastHoldReason === reason) return;
    state.lastHoldReason = reason;
    emit('held', state, { reason, ...details });
  }

  function resetBlankConfirmation(state) {
    state.blankClearSinceMs = 0;
    state.blankClearSamples = 0;
  }

  async function dispatchRecovery(state, evidence) {
    state.attempted = true;
    state.attemptCount += 1;
    state.actionAtMs = now();
    emit('detected', state, { evidence });
    emit('action', state, {
      method: 'nudgePane_enter',
      maxAttempts: 1,
      evidence,
    });

    try {
      const result = await sendRecovery(state.paneId, {
        reason: 'alive_blank_cold_spawn',
        evidence,
      });
      const failed = result === false || result?.ok === false || result?.success === false;
      if (failed) {
        finish(state, 'action_failed', { result: result || null });
        return;
      }
      state.actionAccepted = true;
      scheduleEvaluation(state, config.sampleIntervalMs);
    } catch (err) {
      finish(state, 'action_failed', { error: err?.message || String(err) });
    }
  }

  async function evaluate(paneId) {
    const state = states.get(String(paneId));
    if (!state || state.finished) return;
    const nowMs = now();
    const coldSpawnAgeMs = Math.max(0, nowMs - state.startedAtMs);

    if (!state.ptyAlive) {
      if (state.attempted) {
        finish(state, 'pty_exited_after_action');
      }
      return;
    }

    if (coldSpawnAgeMs > config.maxColdSpawnAgeMs) {
      if (state.attempted) {
        finish(state, 'unverified_timeout', { reason: 'cold_spawn_window_expired' });
      } else {
        state.finished = true;
        state.outcome = 'cold_spawn_window_expired';
        emit('expired', state, { coldSpawnAgeMs });
      }
      return;
    }

    let surface;
    try {
      surface = normalizeSurface(sampleSurface(state.paneId));
    } catch (err) {
      surface = normalizeSurface({ ready: false, reason: `surface_sample_failed:${err?.message || err}` });
    }

    if (state.attempted) {
      if (surface.ready && surface.visibleChars > 0) {
        finish(state, 'recovered', {
          visibleChars: surface.visibleChars,
          cols: surface.cols,
          rows: surface.rows,
        });
        return;
      }
      if (nowMs - state.actionAtMs >= config.outcomeTimeoutMs) {
        finish(state, 'unverified_timeout', {
          surfaceReason: surface.reason,
          surfaceReady: surface.ready,
          visibleChars: surface.visibleChars,
        });
        return;
      }
      scheduleEvaluation(state, config.sampleIntervalMs);
      return;
    }

    if (!isCodexPane(state.paneId)) {
      hold(state, 'not_codex');
      return;
    }

    if (coldSpawnAgeMs < config.startupGraceMs) {
      scheduleEvaluation(
        state,
        Math.max(config.sampleIntervalMs, config.startupGraceMs - coldSpawnAgeMs)
      );
      return;
    }

    const outputAgeMs = state.lastOutputAtMs
      ? Math.max(0, nowMs - state.lastOutputAtMs)
      : Number.POSITIVE_INFINITY;
    if (outputAgeMs > config.recentOutputMs) {
      resetBlankConfirmation(state);
      state.lastHoldReason = null;
      return;
    }

    if (!surface.ready) {
      resetBlankConfirmation(state);
      hold(state, surface.reason || 'renderer_unavailable');
      scheduleEvaluation(state, config.sampleIntervalMs);
      return;
    }

    const outputAnalysis = analyzeColdSpawnOutput(state.rawTail);
    const clearStorm = outputLooksLikeClearScreenStorm(outputAnalysis, config);
    if (surface.visibleChars > 0) {
      resetBlankConfirmation(state);
      state.lastHoldReason = null;
      clearSampleTimer(state);
      state.finished = true;
      state.outcome = 'visible_frame_observed';
      emit('healthy', state, { visibleChars: surface.visibleChars });
      return;
    }
    if (!clearStorm) {
      resetBlankConfirmation(state);
      state.lastHoldReason = null;
      scheduleEvaluation(state, config.sampleIntervalMs);
      return;
    }

    state.blankClearSinceMs = state.blankClearSinceMs || nowMs;
    state.blankClearSamples += 1;
    const blankDurationMs = Math.max(0, nowMs - state.blankClearSinceMs);
    if (
      state.blankClearSamples < config.confirmSamples
      || blankDurationMs < config.blankSustainMs
    ) {
      scheduleEvaluation(state, config.sampleIntervalMs);
      return;
    }

    const inputBlockReason = getInputBlockReason(state.paneId);
    if (inputBlockReason) {
      hold(state, String(inputBlockReason), {
        blankDurationMs,
        blankClearSamples: state.blankClearSamples,
      });
      scheduleEvaluation(state, config.sampleIntervalMs);
      return;
    }

    const evidence = {
      coldSpawnAgeMs,
      outputAgeMs,
      blankDurationMs,
      blankClearSamples: state.blankClearSamples,
      surface: {
        cols: surface.cols,
        rows: surface.rows,
        width: surface.width,
        height: surface.height,
        visibleChars: surface.visibleChars,
      },
      output: outputAnalysis,
    };
    await dispatchRecovery(state, evidence);
  }

  function arm(paneId, metadata = {}) {
    const id = String(paneId || '').trim();
    if (!id) return null;
    dispose(id);
    const state = createPaneState(id, metadata, now());
    states.set(id, state);
    return state;
  }

  function disarm(paneId, reason = 'user_terminal_input', details = {}) {
    const state = states.get(String(paneId));
    if (!state || state.finished) return false;
    clearSampleTimer(state);
    state.finished = true;
    state.outcome = 'disarmed_user_input';
    emit('disarmed', state, {
      reason: String(reason || 'user_terminal_input'),
      ...details,
    });
    return true;
  }

  function observeOutput(paneId, data) {
    const state = states.get(String(paneId));
    if (!state || state.finished || state.attempted && !state.actionAccepted) return false;
    const text = typeof data === 'string' ? data : String(data || '');
    if (!text) return false;
    const nowMs = now();
    state.ptyAlive = true;
    state.firstOutputAtMs = state.firstOutputAtMs || nowMs;
    state.lastOutputAtMs = nowMs;
    state.rawTail = `${state.rawTail}${text}`.slice(-config.rawTailChars);
    scheduleEvaluation(state, config.sampleIntervalMs);
    return true;
  }

  function markPtyExited(paneId) {
    const state = states.get(String(paneId));
    if (!state || state.finished) return false;
    state.ptyAlive = false;
    clearSampleTimer(state);
    if (state.attempted) {
      finish(state, 'pty_exited_after_action');
    } else {
      state.finished = true;
      state.outcome = 'dead_pty';
      hold(state, 'dead_pty');
    }
    return true;
  }

  function dispose(paneId) {
    const id = String(paneId || '').trim();
    if (!id) return false;
    const state = states.get(id);
    if (!state) return false;
    clearSampleTimer(state);
    states.delete(id);
    return true;
  }

  function getState(paneId) {
    return states.get(String(paneId)) || null;
  }

  return {
    arm,
    disarm,
    dispose,
    evaluate,
    getState,
    markPtyExited,
    observeOutput,
    states,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  analyzeColdSpawnOutput,
  createColdSpawnBlankRecoveryController,
  normalizeSurface,
  outputLooksLikeClearScreenStorm,
};
