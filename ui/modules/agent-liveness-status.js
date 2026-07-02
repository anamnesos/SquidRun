'use strict';

/**
 * Agent liveness status (honesty-audit defects #1 + #2): status asserted
 * ONLY from evidence that can expire. Spawn results seed the roster; the
 * liveness poll is the truth; silence past staleAfterMs is amber, and the
 * banner counts what was polled - it never says green because nothing said
 * otherwise. Spec: Builder #46 / Oracle #193, contracts in
 * __tests__/agent-liveness-status.test.js.
 */

/**
 * Shared staleness helper (heartbeat indicator reuses this): a missing or
 * NaN last event is STALE - absence of evidence must never render green.
 * Boundary: exactly staleAfterMs old is still fresh.
 */
function isStale(lastEventMs, nowMs, staleAfterMs) {
  if (!Number.isFinite(lastEventMs)) return true;
  return (Number(nowMs) - lastEventMs) > Number(staleAfterMs);
}

function createLivenessStatus({ staleAfterMs }) {
  const panes = new Map(); // paneId -> { alive: boolean|null, polledAt: number }
  let lastPollAt = NaN;

  function seed(paneIds) {
    for (const id of paneIds || []) {
      const key = String(id);
      if (!panes.has(key)) panes.set(key, { alive: null, polledAt: NaN });
    }
  }

  function recordPoll(paneId, result, nowMs) {
    const key = String(paneId);
    panes.set(key, { alive: result?.alive === true, polledAt: Number(nowMs) });
    lastPollAt = Number(nowMs);
  }

  function report(nowMs) {
    const total = panes.size;
    let live = 0;
    let unpolled = 0;
    const deadPaneIds = [];
    for (const [id, entry] of panes) {
      if (entry.alive === true) live += 1;
      else if (entry.alive === null) unpolled += 1;
      else deadPaneIds.push(id);
    }
    if (unpolled > 0 || total === 0) {
      // Seeding is not evidence: spawn-ok with no confirming poll yet.
      return {
        text: `${live}/${total} agents confirmed (awaiting liveness poll)`,
        tone: 'pending',
        deadPaneIds,
      };
    }
    if (isStale(lastPollAt, nowMs, staleAfterMs)) {
      return {
        text: `${live}/${total} agents live (status stale)`,
        tone: 'stale',
        deadPaneIds,
      };
    }
    if (deadPaneIds.length > 0) {
      return {
        text: `${live}/${total} agents live - pane ${deadPaneIds.join(', ')} down`,
        tone: 'degraded',
        deadPaneIds,
      };
    }
    return { text: `${live}/${total} agents live`, tone: 'ok', deadPaneIds };
  }

  return { seed, recordPoll, report };
}

module.exports = { createLivenessStatus, isStale };
