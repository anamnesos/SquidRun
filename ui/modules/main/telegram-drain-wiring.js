/**
 * The seams that connect the Telegram ingress drain to the running app.
 *
 * These live outside squidrun-app.js deliberately. Each one is a small decision
 * with a sharp failure mode — a runtime named wrongly, an unreadable store
 * reported as an outage, a health snapshot that never leaves the process — and
 * each is worth testing without constructing an Electron app.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * A stable id for one process's run of the drain. Proof is correlated against
 * it, so a receipt written for a previous generation's delivery of the same
 * updateId cannot retire a delivery this generation is still waiting on. It
 * must NOT survive the process; one that did would defeat the point.
 */
function makeDrainGeneration(pid, nowMs) {
  return `tg-gen-${pid}-${nowMs}`;
}

/**
 * WHICH CLI is actually in the pane, named honestly or not at all.
 *
 * The existing codex check answers a boolean, and its false branch is
 * 'non-codex' — which is not a runtime. Handing that to a capability probe asks
 * whether a runtime called "non-codex" produces receipts; nothing does, so
 * every route would wedge at once. Anything unrecognised returns null, which
 * the probe reports as unprovable-and-say-so rather than guessing.
 */
function resolvePaneRuntimeFromCommand(command) {
  const normalized = String(command || '').toLowerCase();
  if (!normalized.trim()) return null;
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('claude')) return 'claude';
  return null;
}

/**
 * Publish the backlog snapshot where a health check in ANOTHER PROCESS can read
 * it. The 8.6-hour wedge was known to the drain the whole time; the knowledge
 * never left its own log lines, and startup health had no way to ask. An
 * in-memory field would reproduce that exactly.
 */
function writeBacklogHealth(input = {}) {
  const { statePath, routeKey, backlog, nowMs } = input;
  if (!statePath || !routeKey || !backlog || typeof backlog !== 'object') {
    return { ok: false, reason: 'missing_backlog' };
  }
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object') existing = parsed;
  } catch {
    // Absent or unreadable: start a fresh document rather than refuse to
    // report. Losing an older route's line is recoverable; publishing nothing
    // is the exact failure this file exists to prevent.
    existing = {};
  }
  const routes = (existing.routes && typeof existing.routes === 'object') ? existing.routes : {};
  routes[routeKey] = { ...backlog, observedAtMs: nowMs };
  const payload = { schema: 'telegramBacklogHealth.v0', updatedAtMs: nowMs, routes };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, statePath, routes };
}

module.exports = {
  makeDrainGeneration,
  resolvePaneRuntimeFromCommand,
  writeBacklogHealth,
};
