/**
 * SquidRun Status Strip
 * Maintains compact, read-only state bar indicators.
 */

const log = require('./logger');

// Session start time for duration tracking
let sessionStartTime = Date.now();
let sessionTimerInterval = null;
let ownedWorkSummaryInterval = null;
let initialized = false;
let ownedWorkUnavailableLogged = false;

const OWNED_WORK_SUMMARY_REFRESH_MS = 30000;

function getBridgeInvoke() {
  if (typeof window === 'undefined') return null;

  const candidates = [
    window.squidrun,
    window.squidrunAPI,
    window.api,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate.invoke === 'function') {
      return candidate.invoke.bind(candidate);
    }
    if (candidate && candidate.ipc && typeof candidate.ipc.invoke === 'function') {
      return candidate.ipc.invoke.bind(candidate.ipc);
    }
  }

  return null;
}

function getTotals(summary) {
  return summary?.whatImCarrying?.totals || {};
}

function getAgents(summary) {
  return summary?.whatImCarrying?.agents || {};
}

function toTitleCaseAgent(agentName) {
  const value = String(agentName || '').trim();
  if (!value) return 'Agent';
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function getActiveAgentEntries(summary) {
  return Object.entries(getAgents(summary))
    .filter(([, agentSummary]) => agentSummary && agentSummary.active);
}

function describeActiveItem(agentName, activeItem) {
  const label = toTitleCaseAgent(agentName);
  const subject = activeItem.title
    || activeItem.nextStep
    || activeItem.message
    || activeItem.taskId
    || 'active item';
  return `${label}: ${subject}`;
}

function buildOwnedWorkSummaryText(summary) {
  if (!summary || summary.ok === false) return 'Carrying: unavailable';

  const totals = getTotals(summary);
  const activeEntries = getActiveAgentEntries(summary);
  const parts = [];

  if (activeEntries.length > 0) {
    const [agentName, agentSummary] = activeEntries[0];
    parts.push(describeActiveItem(agentName, agentSummary.active));
    if (activeEntries.length > 1) {
      parts.push(`+${activeEntries.length - 1} active`);
    }
  } else if (totals.carriedCount > 0) {
    parts.push(`${totals.carriedCount} carried`);
  } else {
    parts.push('idle');
  }

  if (totals.blockedCount > 0) {
    parts.push(`${totals.blockedCount} blocked`);
  }
  if (totals.approvalRequiredCount > 0) {
    parts.push(`${totals.approvalRequiredCount} approval`);
  }

  return `Carrying: ${parts.join(' | ')}`;
}

function buildOwnedWorkSummaryTitle(summary) {
  if (!summary || summary.ok === false) return "Owned-work summary unavailable";

  const totals = getTotals(summary);
  const lines = ['What I am carrying for you'];
  const activeEntries = getActiveAgentEntries(summary);

  if (activeEntries.length === 0) {
    lines.push(totals.carriedCount > 0
      ? `${totals.carriedCount} carried item(s)`
      : 'No active carried work');
  }

  for (const [agentName, agentSummary] of activeEntries) {
    const activeItem = agentSummary.active;
    lines.push(describeActiveItem(agentName, activeItem));
    if (activeItem.nextStep) lines.push(`Next: ${activeItem.nextStep}`);
    if (activeItem.blockedReason) lines.push(`Blocked: ${activeItem.blockedReason}`);
    if (activeItem.wakeTrigger) lines.push(`Wake: ${activeItem.wakeTrigger}`);
    if (activeItem.continueAfter) lines.push(`Continue after: ${activeItem.continueAfter}`);
  }

  if (totals.blockedCount > 0) lines.push(`${totals.blockedCount} blocked`);
  if (totals.approvalRequiredCount > 0) {
    lines.push(`${totals.approvalRequiredCount} approval required`);
  }
  if (totals.staleCount > 0) lines.push(`${totals.staleCount} stale`);

  return lines.join('\n');
}

function getOwnedWorkSummaryClass(summary) {
  if (!summary || summary.ok === false) return 'unavailable';

  const totals = getTotals(summary);
  if (totals.blockedCount > 0 || totals.approvalRequiredCount > 0) {
    return 'warn';
  }
  if (totals.activeCount > 0 || totals.carriedCount > 0) {
    return 'active';
  }
  return 'idle';
}

function renderOwnedWorkSummary(summary) {
  const summaryEl = document.getElementById('ownedWorkSummary');
  if (!summaryEl) return;

  const stateClass = getOwnedWorkSummaryClass(summary);
  summaryEl.textContent = buildOwnedWorkSummaryText(summary);
  summaryEl.title = buildOwnedWorkSummaryTitle(summary);
  summaryEl.className = `owned-work-summary ${stateClass}`;
}

async function refreshOwnedWorkSummary() {
  const invoke = getBridgeInvoke();
  if (!invoke) {
    renderOwnedWorkSummary(null);
    return;
  }

  try {
    const summary = await invoke('get-owned-work-summary');
    ownedWorkUnavailableLogged = false;
    renderOwnedWorkSummary(summary);
  } catch (err) {
    renderOwnedWorkSummary(null);
    if (!ownedWorkUnavailableLogged) {
      ownedWorkUnavailableLogged = true;
      log.warn('StatusStrip', 'Owned-work summary unavailable', err?.message || err);
    }
  }
}

/**
 * Update session timer display in X:XX format.
 */
function updateSessionTimer() {
  const timerEl = document.getElementById('sessionTimer');
  if (!timerEl) return;

  const elapsed = Date.now() - sessionStartTime;
  const totalMinutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  timerEl.textContent = `Session: ${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Initialize session timer behavior.
 */
function initStatusStrip() {
  if (initialized) return;
  initialized = true;

  sessionStartTime = Date.now();
  updateSessionTimer();
  refreshOwnedWorkSummary();
  sessionTimerInterval = setInterval(updateSessionTimer, 60000);
  ownedWorkSummaryInterval = setInterval(refreshOwnedWorkSummary, OWNED_WORK_SUMMARY_REFRESH_MS);

  log.info('StatusStrip', 'Initialized');
}

/**
 * Shutdown and clear timer interval.
 */
function shutdownStatusStrip() {
  initialized = false;
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  if (ownedWorkSummaryInterval) {
    clearInterval(ownedWorkSummaryInterval);
    ownedWorkSummaryInterval = null;
  }
}

module.exports = {
  buildOwnedWorkSummaryText,
  buildOwnedWorkSummaryTitle,
  getOwnedWorkSummaryClass,
  initStatusStrip,
  refreshOwnedWorkSummary,
  renderOwnedWorkSummary,
  shutdownStatusStrip,
};
