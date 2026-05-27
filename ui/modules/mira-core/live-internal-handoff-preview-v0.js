'use strict';

const path = require('path');

const {
  buildMiraLiveInternalRequestDraftV0,
  countJamesActionLines,
} = require('./live-internal-request-draft-v0');
const {
  buildMiraProgressReport,
} = require('./mira-progress-v0');

const SCHEMA = 'squidrun.mira_core.live_internal_handoff_preview_v0';
const VERSION = 1;

const HANDOFF_PREVIEW_PATTERNS = Object.freeze([
  /\b(?:handoff|hand-off)\b[\s\S]{0,120}\b(?:preview|plan|approval|approve|send command|dispatch payload)\b/i,
  /\bapproval[-\s]+ready\b[\s\S]{0,120}\b(?:handoff|internal|builder|oracle)\b/i,
  /\b(?:a2[-\s]*to[-\s]*a3|A2[-\s]*to[-\s]*A3)\b[\s\S]{0,120}\b(?:handoff|preview|plan)\b/i,
  /\b(?:prepare|show|make)\b[\s\S]{0,80}\b(?:builder|oracle)\b[\s\S]{0,80}\b(?:handoff|send command|dispatch payload)\b/i,
]);

function trimText(value, limit = 260) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isMiraLiveInternalHandoffPreviewPrompt(text = '') {
  const normalized = trimText(text, 500);
  if (!normalized) return false;
  return HANDOFF_PREVIEW_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeTargetAgent(value = '') {
  const target = String(value || '').trim().toLowerCase();
  return target === 'oracle' ? 'oracle' : 'builder';
}

function titleRole(role) {
  return normalizeTargetAgent(role) === 'oracle' ? 'Oracle' : 'Builder';
}

function buildDraftPrompt(promptText = '') {
  if (/\boracle\b/i.test(promptText)) return 'draft an Oracle request message';
  if (/\bbuilder\b/i.test(promptText)) return 'draft internal request to Builder';
  return 'draft internal request';
}

function buildProgressEvidence(progressReport = {}) {
  const head = progressReport.source_refs?.head || {};
  const proof = progressReport.source_refs?.progress_proof_inputs || {};
  const restart = Array.isArray(progressReport.categories)
    ? progressReport.categories.find((category) => category.id === 'restart_current_scope_continuity')
    : null;
  const team = Array.isArray(progressReport.categories)
    ? progressReport.categories.find((category) => category.id === 'team_coordination_arms')
    : null;
  return {
    percent: Number(progressReport.computed_total_percent || 0),
    status: trimText(progressReport.status, 40) || 'UNKNOWN',
    warnings: Array.isArray(progressReport.warnings) ? progressReport.warnings.map((item) => trimText(item, 120)).filter(Boolean) : [],
    head_short_sha: trimText(head.short_sha, 40) || null,
    head_committed_at: head.committed_at || null,
    proof_source_ref: trimText(proof.source_ref, 160) || null,
    proof_status: trimText(proof.status, 40) || null,
    restart_current_scope: restart ? {
      computed_percent: Number(restart.computed_percent || 0),
      status: trimText(restart.status, 40) || null,
    } : null,
    team_coordination_arms: team ? {
      computed_percent: Number(team.computed_percent || 0),
      status: trimText(team.status, 40) || null,
      blocker_markers: Array.isArray(team.blocker_markers) ? team.blocker_markers.slice(0, 4) : [],
    } : null,
  };
}

function buildCommandPreview(targetAgent, draftBody) {
  return [
    "@'",
    String(draftBody || '').trim(),
    "'@ | node ui/scripts/hm-send.js " + normalizeTargetAgent(targetAgent) + ' --stdin',
  ].join('\n');
}

function buildDispatchPayloadPreview(targetAgent, draftBody) {
  return {
    command: 'node',
    args: ['ui/scripts/hm-send.js', normalizeTargetAgent(targetAgent), '--stdin'],
    stdin: String(draftBody || '').trim(),
    cwd: '<project-root>',
    requires_explicit_approval: true,
    preview_only: true,
  };
}

function summarizeEvidence(draft, progress) {
  const evidence = Array.isArray(draft.source_evidence) ? draft.source_evidence.slice(0, 3) : [];
  evidence.push({
    kind: 'computed_progress',
    source_ref: progress.head_short_sha ? `HEAD:${progress.head_short_sha}` : null,
    summary: `Mira computed progress ${progress.percent}% ${progress.status}; restart/current-scope ${progress.restart_current_scope?.computed_percent ?? 'unknown'}% ${progress.restart_current_scope?.status || 'UNKNOWN'}`,
    authority_source: 'hm-mira-progress',
  });
  if (progress.proof_source_ref) {
    evidence.push({
      kind: 'progress_proof_inputs',
      source_ref: progress.proof_source_ref,
      summary: `progress proof inputs ${progress.proof_status || 'unknown'}`,
      authority_source: 'hm-mira-progress',
    });
  }
  return evidence.slice(0, 5);
}

function buildWhyTarget(draft, progress) {
  const target = titleRole(draft.target_agent);
  const laneText = draft.current_lane?.source_ref
    ? `${draft.current_lane.source_ref} delegated ${trimText(draft.current_lane.objective, 180)}`
    : 'live current evidence did not expose an active lane';
  const teamStatus = progress.team_coordination_arms
    ? `Team Coordination Arms is ${progress.team_coordination_arms.computed_percent}% ${progress.team_coordination_arms.status}`
    : 'Team Coordination Arms still needs proof';
  return `${laneText}; ${target} is the preview target because the existing A2 draft selected ${target}, and ${teamStatus} without A3/A4 authority.`;
}

function buildRiskExclusions(draft, progress, approvalFlagPresent) {
  const markers = [
    'preview-only: no hm-send executed',
    'no runtime POST, external action, route change, credential use, deploy, money, or trading',
    'parked/prototype/archive scaffolds excluded from authority',
    'A3/A4 arm authority remains blocked; this is a reviewable handoff preview only',
    approvalFlagPresent
      ? 'approval flag observed, but dispatch path is not enabled in this lane'
      : 'approval flag absent; dispatch is blocked',
  ];
  for (const marker of draft.blocked_parked_exclusions || []) markers.push(marker);
  for (const marker of progress.team_coordination_arms?.blocker_markers || []) markers.push(marker);
  for (const warning of progress.warnings || []) markers.push(`progress warning: ${warning}`);
  return Array.from(new Set(markers.map((item) => trimText(item, 220)).filter(Boolean))).slice(0, 9);
}

function buildAnswerText({
  evidence,
  targetAgent,
  draftBody,
  whyTarget,
  commandPreview,
  dispatchPayloadPreview,
  riskExclusions,
  progress,
}) {
  const evidenceText = evidence
    .map((item) => `${item.source_ref || item.kind}: ${item.summary}`)
    .join('; ');
  return [
    'Approved internal handoff preview: approval-ready, not sent.',
    `Source evidence: ${evidenceText}.`,
    `Progress: ${progress.percent}% ${progress.status}${progress.head_short_sha ? ` at HEAD ${progress.head_short_sha}` : ''}.`,
    `Target agent: ${titleRole(targetAgent)}.`,
    `Why this target: ${whyTarget}`,
    'Draft body:',
    draftBody,
    'Send command preview:',
    commandPreview,
    `Dispatch payload preview: ${JSON.stringify(dispatchPayloadPreview)}`,
    `Risk/blocked exclusions: ${riskExclusions.join('; ')}.`,
    'JAMES ACTION: REVIEW OR EDIT BEFORE ANY SEND',
  ].join('\n');
}

function buildZeroCounters() {
  return {
    hm_send_count: 0,
    send_count: 0,
    external_send_count: 0,
    runtime_post_count: 0,
    model_call_count: 0,
    network_count: 0,
    write_count: 0,
    action_count: 0,
    dispatch_count: 0,
  };
}

function approvalFlagPresent(input = {}, options = {}) {
  return input.approvalApproved === true
    || input.approval_approved === true
    || input.dispatchApproved === true
    || input.dispatch_approved === true
    || options.approvalApproved === true
    || options.dispatchApproved === true
    || options.approval?.approved === true;
}

function buildMiraLiveInternalHandoffPreviewV0(input = {}, options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || input.projectRoot || process.cwd()));
  const promptText = input.promptText || input.text || '';
  const nowMs = Number.isFinite(Number(options.nowMs || input.nowMs))
    ? Number(options.nowMs || input.nowMs)
    : Date.now();

  if (!isMiraLiveInternalHandoffPreviewPrompt(promptText)) {
    return {
      schema: SCHEMA,
      version: VERSION,
      ok: false,
      decision: 'not_internal_handoff_preview_prompt',
      read_only: true,
    };
  }

  const draft = buildMiraLiveInternalRequestDraftV0({
    ...input,
    promptText: buildDraftPrompt(promptText),
    projectRoot,
    nowMs,
  }, {
    ...options,
    projectRoot,
    nowMs,
  });
  if (draft.ok !== true) {
    return {
      schema: SCHEMA,
      version: VERSION,
      ok: false,
      decision: 'blocked_no_reviewable_internal_request_draft',
      read_only: true,
      draft_decision: draft.decision || null,
      no_effects: buildZeroCounters(),
    };
  }

  const progressReport = options.progressReport && typeof options.progressReport === 'object'
    ? options.progressReport
    : buildMiraProgressReport({
      projectRoot,
      progressProofPath: options.progressProofPath,
      head: options.head,
      worktreeState: options.worktreeState,
    });
  const progress = buildProgressEvidence(progressReport);
  const targetAgent = normalizeTargetAgent(draft.target_agent);
  const draftBody = draft.proposed_message_body;
  const commandPreview = buildCommandPreview(targetAgent, draftBody);
  const dispatchPayloadPreview = buildDispatchPayloadPreview(targetAgent, draftBody);
  const flagPresent = approvalFlagPresent(input, options);
  const whyTarget = buildWhyTarget(draft, progress);
  const riskExclusions = buildRiskExclusions(draft, progress, flagPresent);
  const evidence = summarizeEvidence(draft, progress);
  const answerText = buildAnswerText({
    evidence,
    targetAgent,
    draftBody,
    whyTarget,
    commandPreview,
    dispatchPayloadPreview,
    riskExclusions,
    progress,
  });

  return {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: flagPresent
      ? 'approval_flag_seen_preview_only_dispatch_not_enabled'
      : 'preview_ready_no_dispatch',
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    answer_text: answerText,
    james_action_line_count: countJamesActionLines(answerText),
    source_evidence: evidence,
    target_agent: targetAgent,
    draft_body: draftBody,
    why_this_target: whyTarget,
    send_command_preview: commandPreview,
    dispatch_payload_preview: dispatchPayloadPreview,
    risk_blocked_exclusions: riskExclusions,
    progress,
    current_lane: draft.current_lane,
    internal_request_draft: {
      decision: draft.decision,
      source_status: draft.source_status,
      source_evidence: draft.source_evidence,
      proposed_message_body: draft.proposed_message_body,
      no_effects: draft.no_effects,
    },
    approval_gate: {
      required_before_dispatch: true,
      flag_present: flagPresent,
      dispatch_enabled: false,
      dispatch_path_tested: false,
      decision: flagPresent
        ? 'flag_present_but_dispatch_path_not_enabled'
        : 'approval_required_preview_only',
    },
    no_effects: {
      ...buildZeroCounters(),
      preview_only: true,
      draft_only: true,
      no_hm_send: true,
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_model_call: true,
      no_writes: true,
    },
  };
}

module.exports = {
  SCHEMA,
  VERSION,
  buildMiraLiveInternalHandoffPreviewV0,
  isMiraLiveInternalHandoffPreviewPrompt,
};
