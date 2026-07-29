'use strict';

const DEFAULT_STANDALONE_HANDOFF_TIMEOUT_MS = 10_000;
const DEFAULT_STANDALONE_HANDOFF_RETRY_MS = 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStandaloneLaneExit(options = {}) {
  const getLaneStatus = options.getLaneStatus;
  if (typeof getLaneStatus !== 'function') {
    return {
      ok: false,
      reason: 'standalone_lane_status_unavailable',
    };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : DEFAULT_STANDALONE_HANDOFF_TIMEOUT_MS;
  const retryMs = Number.isFinite(Number(options.retryMs))
    ? Math.max(1, Number(options.retryMs))
    : DEFAULT_STANDALONE_HANDOFF_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  do {
    try {
      lastStatus = await Promise.resolve(getLaneStatus());
    } catch (err) {
      return {
        ok: false,
        reason: 'standalone_lane_status_failed',
        error: err.message,
      };
    }

    if (lastStatus?.identityUnverified === true) {
      return {
        ok: false,
        reason: 'standalone_lane_identity_unverified',
        status: lastStatus,
      };
    }
    if (lastStatus?.processProbeAvailable !== true) {
      return {
        ok: false,
        reason: 'standalone_lane_process_probe_unavailable',
        status: lastStatus,
      };
    }
    const anotherMainWorkerRunning = (
      lastStatus?.anyMainWorkerRunning === true
      || lastStatus?.mainWorkerRunning === true
    );
    if (
      lastStatus?.running !== true
      && lastStatus?.starting !== true
      && !anotherMainWorkerRunning
    ) {
      return {
        ok: true,
        reason: 'standalone_lane_quiescent',
        status: lastStatus,
      };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    ok: false,
    reason: 'standalone_lane_handoff_timeout',
    status: lastStatus,
  };
}

module.exports = {
  DEFAULT_STANDALONE_HANDOFF_RETRY_MS,
  DEFAULT_STANDALONE_HANDOFF_TIMEOUT_MS,
  waitForStandaloneLaneExit,
};
