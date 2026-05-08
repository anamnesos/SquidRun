'use strict';

const {
  collectWakeCandidates,
} = require('../scripts/hm-task-queue');

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isCandidateActionable(candidate = {}) {
  return candidate.dispatchReady !== false
    && ['safe', 'caution'].includes(String(candidate.riskClass || '').toLowerCase());
}

function rankCandidate(candidate = {}) {
  const riskRank = candidate.riskClass === 'safe' ? 0 : 1;
  const stateRank = candidate.state === 'waiting' ? 0 : candidate.state === 'blocked' ? 1 : 2;
  return (riskRank * 10) + stateRank;
}

function selectNextCandidate(candidates = []) {
  return candidates
    .filter(isCandidateActionable)
    .sort((left, right) => rankCandidate(left) - rankCandidate(right))[0] || null;
}

function buildResumeCommand(candidate = {}, trigger = 'post-wake') {
  const parts = [
    'node',
    'ui/scripts/hm-task-queue.js',
    'wake',
    '--dispatch',
  ];
  if (candidate.agent) parts.push('--agent', candidate.agent);
  if (trigger) parts.push('--trigger', trigger);
  return parts.join(' ');
}

function buildNextActionCard(scan = {}) {
  const candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
  const held = Array.isArray(scan.held) ? scan.held : [];
  const candidate = selectNextCandidate(candidates);
  const trigger = toNonEmptyString(scan.trigger) || 'post-wake';
  const blockedCount = candidates.filter((item) => item.dispatchReady === false).length + held.length;

  if (!candidate) {
    return {
      ok: true,
      hasNextAction: false,
      reason: candidates.length || held.length ? 'no_dispatch_ready_owned_work' : 'no_due_owned_work',
      trigger,
      generatedAtMs: scan.generatedAtMs || Date.now(),
      counts: {
        due: candidates.length,
        blocked: blockedCount,
        approvalRequired: held.length,
      },
      held,
    };
  }

  return {
    ok: true,
    hasNextAction: true,
    trigger,
    generatedAtMs: scan.generatedAtMs || Date.now(),
    nextAction: {
      action: 'continue_owned_work',
      agent: candidate.agent,
      taskId: candidate.taskId,
      title: candidate.title || candidate.message || 'Owned work',
      riskClass: candidate.riskClass || 'caution',
      state: candidate.state || 'queued',
      nextStep: candidate.nextStep || 'Resume the bounded next step.',
      wakeTrigger: candidate.wakeTrigger || trigger,
      source: candidate.source || null,
      prompt: candidate.prompt || null,
      resumeCommand: buildResumeCommand(candidate, trigger),
    },
    counts: {
      due: candidates.length,
      blocked: blockedCount,
      approvalRequired: held.length,
    },
    held,
  };
}

function buildOwnedWorkContinueCard(options = {}) {
  const collector = typeof options.collectWakeCandidates === 'function'
    ? options.collectWakeCandidates
    : collectWakeCandidates;
  const scan = collector({
    agent: options.agent,
    queuePath: options.queuePath,
    wakeTrigger: options.wakeTrigger || options.trigger || 'post-wake',
    nowMs: options.nowMs || options.now,
  });
  return {
    ...buildNextActionCard(scan),
    queuePath: scan.queuePath || options.queuePath || null,
  };
}

module.exports = {
  buildNextActionCard,
  buildOwnedWorkContinueCard,
  buildResumeCommand,
  selectNextCandidate,
};
