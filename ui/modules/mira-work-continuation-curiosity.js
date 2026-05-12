'use strict';

const {
  buildOwnedWorkContinueCard,
} = require('./owned-work-continue-broker');
const {
  buildOwnedWorkSummary,
} = require('./owned-work-summary');

const MIRA_WORK_CONTINUATION_CURIOSITY_SCHEMA = 'squidrun.mira.work_continuation_curiosity_read_v0';

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function compactNextAction(action = {}) {
  if (!action || typeof action !== 'object') return null;
  return {
    action: trimText(action.action) || null,
    agent: trimText(action.agent) || null,
    task_id: trimText(action.taskId || action.task_id) || null,
    title: trimText(action.title) || null,
    risk_class: trimText(action.riskClass || action.risk_class) || null,
    state: trimText(action.state) || null,
    next_step: trimText(action.nextStep || action.next_step) || null,
    wake_trigger: trimText(action.wakeTrigger || action.wake_trigger) || null,
    source: trimText(action.source) || null,
    resume_command: trimText(action.resumeCommand || action.resume_command) || null,
  };
}

function compactAgentSummaries(agents = {}) {
  return Object.fromEntries(Object.entries(agents).map(([agent, summary]) => [
    agent,
    {
      active_task_id: trimText(summary?.active?.taskId) || null,
      active_title: trimText(summary?.active?.title) || null,
      active_state: trimText(summary?.active?.state) || null,
      active_next_step: trimText(summary?.active?.nextStep) || null,
      pending_count: Number(summary?.pendingCount || 0),
      carried_count: Number(summary?.carriedCount || 0),
      stale_count: Number(summary?.staleCount || 0),
      blocked_count: Number(summary?.blockedCount || 0),
      approval_required_count: Number(summary?.approvalRequiredCount || 0),
    },
  ]));
}

function readMiraWorkContinuationCuriosity(payload = {}, options = {}) {
  const nowMs = Number.isFinite(Number(payload.nowMs ?? options.nowMs))
    ? Number(payload.nowMs ?? options.nowMs)
    : Date.now();
  const queuePath = trimText(payload.queuePath || options.queuePath) || undefined;
  const wakeTrigger = trimText(payload.wakeTrigger || options.wakeTrigger || payload.trigger || options.trigger) || 'post-wake';
  const staleAfterMs = Number(payload.staleAfterMs || options.staleAfterMs) || undefined;
  try {
    const summaryReader = typeof options.summaryReader === 'function'
      ? options.summaryReader
      : buildOwnedWorkSummary;
    const cardReader = typeof options.continueCardReader === 'function'
      ? options.continueCardReader
      : buildOwnedWorkContinueCard;
    const summary = summaryReader({
      queuePath,
      nowMs,
      staleAfterMs,
      profileName: payload.profileName || options.profileName,
    });
    const card = cardReader({
      queuePath,
      nowMs,
      wakeTrigger,
    });
    const totals = summary?.whatImCarrying?.totals || {};
    return {
      schema: MIRA_WORK_CONTINUATION_CURIOSITY_SCHEMA,
      ok: true,
      decision: 'work_continuation_read_only',
      profile_name: summary?.profileName || null,
      queue_path: summary?.queuePath || card?.queuePath || queuePath || null,
      generated_at_ms: nowMs,
      wake_trigger: wakeTrigger,
      totals: {
        active_count: Number(totals.activeCount || 0),
        carried_count: Number(totals.carriedCount || 0),
        stale_count: Number(totals.staleCount || 0),
        blocked_count: Number(totals.blockedCount || 0),
        approval_required_count: Number(totals.approvalRequiredCount || 0),
      },
      agents: compactAgentSummaries(summary?.whatImCarrying?.agents || {}),
      next_action: card?.hasNextAction ? compactNextAction(card.nextAction) : null,
      next_action_reason: card?.hasNextAction ? 'dispatch_ready_owned_work' : trimText(card?.reason) || 'no_dispatch_ready_owned_work',
      due_count: Number(card?.counts?.due || 0),
      held_count: Array.isArray(card?.held) ? card.held.length : 0,
      held_reasons: Array.isArray(card?.held)
        ? Array.from(new Set(card.held.map((item) => trimText(item.holdReason || item.blockedReason)).filter(Boolean))).slice(0, 8)
        : [],
      no_mutation_performed: true,
      consequence_controls: {
        internal_only: true,
        read_only: true,
        queue_mutation_performed: false,
        dispatch_performed: false,
        external_send_performed: false,
        autonomous_apply_performed: false,
      },
    };
  } catch (err) {
    return {
      schema: MIRA_WORK_CONTINUATION_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: trimText(err?.message) || 'work_continuation_unavailable',
      queue_path: queuePath || null,
      no_mutation_performed: true,
      consequence_controls: {
        internal_only: true,
        read_only: true,
        queue_mutation_performed: false,
        dispatch_performed: false,
        external_send_performed: false,
        autonomous_apply_performed: false,
      },
    };
  }
}

module.exports = {
  MIRA_WORK_CONTINUATION_CURIOSITY_SCHEMA,
  compactNextAction,
  readMiraWorkContinuationCuriosity,
};
