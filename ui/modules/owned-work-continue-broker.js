'use strict';

const {
  collectWakeCandidates,
} = require('../scripts/hm-task-queue');

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractJamesActionLines(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^JAMES ACTION:/i.test(line));
}

function classifyJamesActionLine(line = '') {
  const match = String(line || '').trim().match(/^JAMES ACTION:\s*(.+)$/i);
  if (!match) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'missing_james_action_line',
    };
  }

  const value = match[1].trim();
  if (/^NONE$/i.test(value)) {
    return {
      ok: true,
      kind: 'none',
      line: 'JAMES ACTION: NONE',
      requiredAction: null,
    };
  }

  const doThisMatch = value.match(/^DO THIS:\s*(.+)$/i);
  if (doThisMatch && doThisMatch[1].trim()) {
    const requiredAction = doThisMatch[1].trim();
    return {
      ok: true,
      kind: 'do_this',
      line: `JAMES ACTION: DO THIS: ${requiredAction}`,
      requiredAction,
    };
  }

  return {
    ok: false,
    kind: 'invalid',
    reason: 'unknown_james_action',
    line: String(line || '').trim(),
  };
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

function buildMapBackedNextAction(nextStep, trigger) {
  return {
    action: 'continue_map_backed_step',
    title: 'Next map-backed step',
    nextStep: toNonEmptyString(nextStep) || 'Continue to the next map-backed product step.',
    wakeTrigger: toNonEmptyString(trigger) || 'post-commit',
    source: 'mira-system-map',
  };
}

function buildWorkflowContinuationDecision(options = {}) {
  const reportText = toNonEmptyString(options.reportText || options.message || options.text) || '';
  const actionLines = extractJamesActionLines(reportText);
  const trigger = toNonEmptyString(options.trigger) || 'post-commit';
  const generatedAtMs = options.generatedAtMs || Date.now();

  if (actionLines.length !== 1) {
    return {
      ok: false,
      decision: 'internal_report_needs_action_line_fix',
      autoContinue: false,
      jamesActionRequired: false,
      reason: actionLines.length === 0 ? 'missing_james_action_line' : 'multiple_james_action_lines',
      generatedAtMs,
    };
  }

  const action = classifyJamesActionLine(actionLines[0]);
  if (!action.ok) {
    return {
      ok: false,
      decision: 'internal_report_needs_action_line_fix',
      autoContinue: false,
      jamesActionRequired: false,
      reason: action.reason,
      jamesActionLine: action.line || actionLines[0],
      generatedAtMs,
    };
  }

  if (action.kind === 'do_this') {
    return {
      ok: true,
      decision: 'james_action_required',
      autoContinue: false,
      jamesActionRequired: true,
      jamesActionLine: action.line,
      requiredAction: action.requiredAction,
      generatedAtMs,
    };
  }

  const continueCard = options.continueCard && typeof options.continueCard === 'object'
    ? options.continueCard
    : null;
  const nextAction = continueCard?.hasNextAction
    ? continueCard.nextAction
    : buildMapBackedNextAction(options.nextMapBackedStep, trigger);

  return {
    ok: true,
    decision: 'auto_continue_after_internal_gate',
    autoContinue: true,
    jamesActionRequired: false,
    jamesActionLine: action.line,
    internalReviewGateStopsJames: false,
    internalCommitGateStopsJames: false,
    nextAction,
    counts: continueCard?.counts || null,
    generatedAtMs,
  };
}

module.exports = {
  buildWorkflowContinuationDecision,
  buildNextActionCard,
  buildOwnedWorkContinueCard,
  buildResumeCommand,
  classifyJamesActionLine,
  extractJamesActionLines,
  selectNextCandidate,
};
