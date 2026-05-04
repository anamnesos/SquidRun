'use strict';

const {
  VALID_AGENTS,
  readQueue,
} = require('../scripts/hm-task-queue');
const { getActiveProfile } = require('../config');

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

function toPositiveMs(value, fallback = DEFAULT_STALE_AFTER_MS) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTaskForSummary(task = {}, nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  if (!task || typeof task !== 'object') return null;
  const lastAdvancedAt = Number(task.lastAdvancedAt || 0);
  const ageMs = Number.isFinite(lastAdvancedAt) && lastAdvancedAt > 0
    ? Math.max(0, nowMs - lastAdvancedAt)
    : null;
  const stale = ageMs !== null && ageMs > staleAfterMs;
  return {
    taskId: toNonEmptyString(task.taskId) || null,
    title: toNonEmptyString(task.title) || null,
    state: toNonEmptyString(task.state || task.status) || 'queued',
    riskClass: toNonEmptyString(task.riskClass) || 'caution',
    nextStep: toNonEmptyString(task.nextStep) || null,
    blockedReason: toNonEmptyString(task.blockedReason) || null,
    wakeTrigger: toNonEmptyString(task.wakeTrigger) || null,
    continueAfter: toNonEmptyString(task.continueAfter) || null,
    restartPersistence: task.restartPersistence !== false,
    source: toNonEmptyString(task.source) || null,
    lastAdvancedAt: lastAdvancedAt > 0 ? lastAdvancedAt : null,
    ageMs,
    stale,
    handoffSummary: toNonEmptyString(task.handoffSummary) || null,
  };
}

function isCarriedState(task = {}) {
  return ['queued', 'active', 'blocked', 'waiting'].includes(String(task.state || task.status || '').toLowerCase());
}

function summarizeAgentBucket(bucket = {}, nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const pending = Array.isArray(bucket.pending) ? bucket.pending : [];
  const activeRaw = bucket.active || null;
  const carried = [
    ...(activeRaw ? [activeRaw] : []),
    ...pending,
  ].filter(isCarriedState);
  const active = normalizeTaskForSummary(activeRaw, nowMs, staleAfterMs);
  const staleCount = carried.filter((task) => normalizeTaskForSummary(task, nowMs, staleAfterMs)?.stale).length;
  const blockedCount = carried.filter((task) => String(task.state || task.status || '').toLowerCase() === 'blocked').length;
  const approvalRequiredCount = carried.filter((task) => task.riskClass === 'approval_required').length;

  return {
    active,
    pendingCount: pending.length,
    historyCount: Array.isArray(bucket.history) ? bucket.history.length : 0,
    carriedCount: carried.length,
    staleCount,
    blockedCount,
    approvalRequiredCount,
  };
}

function buildOwnedWorkSummary(options = {}) {
  const staleAfterMs = toPositiveMs(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const profileName = toNonEmptyString(options.profileName) || getActiveProfile?.() || 'main';
  const queuePath = options.queuePath || undefined;
  const { state, queuePath: resolvedQueuePath } = readQueue(queuePath);
  const agents = {};
  const totals = {
    activeCount: 0,
    carriedCount: 0,
    staleCount: 0,
    blockedCount: 0,
    approvalRequiredCount: 0,
  };

  for (const agent of VALID_AGENTS) {
    const summary = summarizeAgentBucket(state.agents?.[agent], nowMs, staleAfterMs);
    agents[agent] = summary;
    if (summary.active) totals.activeCount += 1;
    totals.carriedCount += summary.carriedCount;
    totals.staleCount += summary.staleCount;
    totals.blockedCount += summary.blockedCount;
    totals.approvalRequiredCount += summary.approvalRequiredCount;
  }

  return {
    ok: true,
    profileName,
    queuePath: resolvedQueuePath || null,
    updatedAt: state.updatedAt || null,
    staleAfterMs,
    generatedAtMs: nowMs,
    whatImCarrying: {
      profileName,
      agents,
      totals,
    },
  };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  normalizeTaskForSummary,
  summarizeAgentBucket,
  buildOwnedWorkSummary,
};
