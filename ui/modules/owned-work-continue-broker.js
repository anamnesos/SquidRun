'use strict';

const {
  collectWakeCandidates,
  VALID_AGENTS,
} = require('../scripts/hm-task-queue');
const { getActiveProfile } = require('../config');

const DEFAULT_TRIGGER = 'post-wake';
const SAFE_CONTINUE_RISKS = new Set(['safe', 'caution']);

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toTimestampMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  return fallback;
}

function quoteCliArg(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9._:/\\-]+$/.test(text)) return text;
  return `"${text.replace(/(["`$\\])/g, '\\$1')}"`;
}

function buildResumeCommand(candidate = {}) {
  const parts = [
    'node',
    'ui/scripts/hm-task-queue.js',
    'continue',
    '--agent',
    candidate.agent,
  ];
  if (candidate.taskId) {
    parts.push('--task-id', candidate.taskId);
  }
  if (candidate.nextStep) {
    parts.push('--next-step', candidate.nextStep);
  }
  if (candidate.handoffSummary) {
    parts.push('--handoff-summary', candidate.handoffSummary);
  }
  return parts.map(quoteCliArg).join(' ');
}

function summarizeCandidate(candidate = {}) {
  const title = toNonEmptyString(candidate.title)
    || toNonEmptyString(candidate.message)
    || toNonEmptyString(candidate.taskId)
    || 'owned work';
  const nextStep = toNonEmptyString(candidate.nextStep)
    || toNonEmptyString(candidate.handoffSummary)
    || 'Resume the bounded next step from the owned-work queue.';
  return `${candidate.agent || 'agent'} can continue "${title}" next: ${nextStep}`;
}

function normalizeCandidateCard(candidate = {}, options = {}) {
  const card = {
    kind: 'owned_work_continue',
    profileName: toNonEmptyString(options.profileName) || null,
    trigger: toNonEmptyString(options.trigger) || DEFAULT_TRIGGER,
    agent: candidate.agent || null,
    taskId: candidate.taskId || null,
    title: toNonEmptyString(candidate.title) || null,
    message: toNonEmptyString(candidate.message) || null,
    state: toNonEmptyString(candidate.state) || 'queued',
    riskClass: toNonEmptyString(candidate.riskClass) || 'caution',
    nextStep: toNonEmptyString(candidate.nextStep) || null,
    blockedReason: toNonEmptyString(candidate.blockedReason) || null,
    wakeTrigger: toNonEmptyString(candidate.wakeTrigger) || null,
    continueAfter: toNonEmptyString(candidate.continueAfter) || null,
    source: toNonEmptyString(candidate.source) || null,
    handoffSummary: toNonEmptyString(candidate.handoffSummary) || null,
    prompt: toNonEmptyString(candidate.prompt) || null,
    dispatchReady: candidate.dispatchReady !== false,
    holdReason: toNonEmptyString(candidate.holdReason) || null,
  };
  card.summary = summarizeCandidate(card);
  card.resumeCommand = buildResumeCommand(card);
  return card;
}

function sortCandidates(candidates = []) {
  const agentRank = new Map(Array.from(VALID_AGENTS).map((agent, index) => [agent, index]));
  const riskRank = new Map([['safe', 0], ['caution', 1]]);
  return [...candidates].sort((a, b) => {
    const aReady = a.dispatchReady === false ? 1 : 0;
    const bReady = b.dispatchReady === false ? 1 : 0;
    if (aReady !== bReady) return aReady - bReady;
    const riskDelta = (riskRank.get(a.riskClass) ?? 9) - (riskRank.get(b.riskClass) ?? 9);
    if (riskDelta !== 0) return riskDelta;
    return (agentRank.get(a.agent) ?? 9) - (agentRank.get(b.agent) ?? 9);
  });
}

function buildContinueBrokerPlan(options = {}) {
  const nowMs = toTimestampMs(options.nowMs || options.now, Date.now());
  const trigger = toNonEmptyString(options.trigger || options.wakeTrigger) || DEFAULT_TRIGGER;
  const profileName = toNonEmptyString(options.profileName) || getActiveProfile?.() || 'main';
  const scan = collectWakeCandidates({
    queuePath: options.queuePath,
    agent: options.agent,
    wakeTrigger: trigger,
    nowMs,
  });
  const readyCandidates = sortCandidates((scan.candidates || []).filter((candidate) => (
    candidate.dispatchReady !== false
    && SAFE_CONTINUE_RISKS.has(candidate.riskClass)
  )));
  const waitingCandidates = sortCandidates((scan.candidates || []).filter((candidate) => (
    candidate.dispatchReady === false
    && SAFE_CONTINUE_RISKS.has(candidate.riskClass)
  )));
  const held = (scan.held || []).map((candidate) => normalizeCandidateCard(candidate, { profileName, trigger }));
  const nextAction = readyCandidates[0]
    ? normalizeCandidateCard(readyCandidates[0], { profileName, trigger })
    : null;
  const waiting = waitingCandidates.map((candidate) => normalizeCandidateCard(candidate, { profileName, trigger }));
  const reason = nextAction
    ? 'continue_ready'
    : (held.length > 0 ? 'only_held_work' : (waiting.length > 0 ? 'work_waiting_on_active_task' : 'no_due_work'));

  return {
    ok: true,
    profileName,
    queuePath: scan.queuePath || null,
    trigger,
    generatedAtMs: nowMs,
    reason,
    nextAction,
    counts: {
      ready: readyCandidates.length,
      waiting: waiting.length,
      held: held.length,
      totalCandidates: (scan.candidates || []).length,
    },
    waiting,
    held,
  };
}

function formatContinueBrokerPlan(plan = {}) {
  if (!plan?.ok) return `owned-work continue broker unavailable: ${plan?.reason || 'unknown'}`;
  if (plan.nextAction) {
    return [
      `Next owned-work action: ${plan.nextAction.summary}`,
      `Risk: ${plan.nextAction.riskClass}`,
      `Resume command: ${plan.nextAction.resumeCommand}`,
    ].join('\n');
  }
  if (plan.held?.length) {
    return `No autonomous continuation. Held ${plan.held.length} approval-required item(s).`;
  }
  if (plan.waiting?.length) {
    return `No free continuation. ${plan.waiting.length} item(s) wait behind active work.`;
  }
  return 'No due owned-work continuation right now.';
}

module.exports = {
  DEFAULT_TRIGGER,
  buildContinueBrokerPlan,
  buildResumeCommand,
  formatContinueBrokerPlan,
  normalizeCandidateCard,
};
