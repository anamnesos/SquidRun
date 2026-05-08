'use strict';

const crypto = require('crypto');
const {
  normalizeThreadContext,
} = require('./text-model-attachment-v1');

const MEMORY_CANDIDATE_STAGING_SCHEMA = 'squidrun.mira_core.memory_candidate_staging_v1';
const MEMORY_CANDIDATE_MAX_CANDIDATES = 3;
const MEMORY_CANDIDATE_MAX_SOURCE_CHARS = 360;

const CANDIDATE_PATTERNS = Object.freeze([
  {
    type: 'user_preference',
    pattern: /\b(i prefer|i like|i don't like|i want|i need|please remember|remember that|call me)\b/i,
  },
  {
    type: 'relationship_preference',
    pattern: /\b(mira should|i want mira|when we talk|between us|our conversations?|talk to me)\b/i,
  },
  {
    type: 'mira_growth_preference',
    pattern: /\b(push back|disagree|be direct|not generic|not chatgpt|presence|memory candidates?|durable memory)\b/i,
  },
]);

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function truncateSourceText(value) {
  const text = trimText(value);
  return text.length > MEMORY_CANDIDATE_MAX_SOURCE_CHARS
    ? text.slice(0, MEMORY_CANDIDATE_MAX_SOURCE_CHARS).trim()
    : text;
}

function classifyCandidate(text = '') {
  return CANDIDATE_PATTERNS.find((entry) => entry.pattern.test(text)) || null;
}

function triageForCandidateType(type = '') {
  if (type === 'relationship_preference' || type === 'mira_growth_preference') {
    return {
      risk_level: 'relationship_shaping',
      triage_status: 'held_tentatively',
      triage_action: 'hold_and_revisit',
      escalation_policy: 'escalate_to_james_only_if_sensitive_ambiguous_contradictory_or_durable_relationship_shaping',
      auto_accept_allowed: false,
    };
  }
  if (type === 'user_preference') {
    return {
      risk_level: 'user_impacting',
      triage_status: 'held_tentatively',
      triage_action: 'hold_and_revisit',
      escalation_policy: 'escalate_to_james_only_if_ambiguous_contradictory_or_user_impacting',
      auto_accept_allowed: false,
    };
  }
  return {
    risk_level: 'low_operational_context',
    triage_status: 'auto_staged_tentative',
    triage_action: 'auto_stage_under_tested_rules',
    escalation_policy: 'no_james_escalation_unless_later_contradiction_or_user_impact',
    auto_accept_allowed: true,
  };
}

function candidateFromUserTurn(turn, index) {
  const text = truncateSourceText(turn?.text);
  if (!text) return null;
  const match = classifyCandidate(text);
  if (!match) return null;
  const triage = triageForCandidateType(match.type);
  const candidate = {
    candidate_id: `mira-memory-candidate:${stableHash({ text, index, type: match.type }).slice(0, 16)}`,
    type: match.type,
    statement: `Candidate learning from recent James turn: ${text}`,
    source: 'recent_panel_thread_context',
    source_role: 'user',
    source_text: text,
    confidence: 'candidate_only',
    review_required: false,
    mira_revisit_required: true,
    durable_memory_commit: false,
    promotion_status: 'tentative_not_committed',
    ...triage,
    humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
    james_clickthrough_required: false,
    review_owner: 'mira_memory_triage',
  };
  return candidate;
}

function buildMiraMemoryCandidateStagingV1(input = {}) {
  const threadContext = normalizeThreadContext(input.threadContext || {});
  const currentUserText = trimText(input.currentUserText);
  const currentAssistantText = trimText(input.currentAssistantText);
  const candidateTurns = [
    ...threadContext.messages,
    ...(currentUserText ? [{ role: 'user', text: currentUserText }] : []),
  ];
  const seen = new Set();
  const candidates = [];
  for (const [index, turn] of candidateTurns.entries()) {
    if (turn.role !== 'user') continue;
    const candidate = candidateFromUserTurn(turn, index);
    if (!candidate || seen.has(candidate.source_text.toLowerCase())) continue;
    candidates.push(candidate);
    seen.add(candidate.source_text.toLowerCase());
    if (candidates.length >= MEMORY_CANDIDATE_MAX_CANDIDATES) break;
  }
  return {
    schema: MEMORY_CANDIDATE_STAGING_SCHEMA,
    version: 1,
    status: candidates.length > 0 ? 'tentative_understandings_present' : 'no_tentative_understanding',
    candidate_count: candidates.length,
    max_candidates: MEMORY_CANDIDATE_MAX_CANDIDATES,
    candidates,
    source: {
      thread_context_schema: threadContext.schema,
      thread_message_count: threadContext.message_count,
      current_user_text_present: Boolean(currentUserText),
      current_assistant_text_present: Boolean(currentAssistantText),
      bounded: true,
    },
    tentative_understanding: {
      present: true,
      mode: 'in_result_tentative_memory_notes_only',
      visible_label: "Mira's tentative understandings",
      requires_human_or_review_gate: false,
      triage_owner: 'Mira',
      james_clickthrough_required: false,
      visible_as_memory_settings_panel: false,
      humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
      integrated_lived_loop: true,
      durable_memory_commit: false,
      auto_promotion: false,
      hidden_agent_only_promotion_path: false,
    },
    boundary: {
      no_file_write: true,
      no_database_write: true,
      no_durable_memory_commit: true,
      no_auto_promotion: true,
      no_external_send: true,
      no_tool_call: true,
    },
    side_effect_counters: {
      write_count: 0,
      file_write_count: 0,
      database_write_count: 0,
      durable_memory_commit_count: 0,
      promotion_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
    },
  };
}

module.exports = {
  MEMORY_CANDIDATE_MAX_CANDIDATES,
  MEMORY_CANDIDATE_MAX_SOURCE_CHARS,
  MEMORY_CANDIDATE_STAGING_SCHEMA,
  buildMiraMemoryCandidateStagingV1,
};
