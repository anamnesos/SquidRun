'use strict';

const DEVELOPMENTAL_UNDERSTANDING_SCHEMA = 'squidrun.mira_core.developmental_understanding_v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function stripCandidatePrefix(statement = '') {
  return asString(statement).replace(/^Candidate learning from recent James turn:\s*/i, '');
}

function candidateToUnderstanding(candidate = {}) {
  const statement = stripCandidatePrefix(candidate.statement);
  if (!statement) return null;
  return {
    id: candidate.candidate_id || null,
    text: statement,
    type: candidate.type || 'conversation_signal',
    confidence: candidate.confidence || 'tentative',
    evidence_summary: candidate.source_text || statement,
    risk_level: candidate.risk_level || 'unknown',
    triage_status: candidate.triage_status || 'held_tentatively',
    revisable: true,
    durable_memory_commit: false,
    escalation_policy: candidate.escalation_policy
      || 'rare_escalation_only_when_sensitive_ambiguous_contradictory_relationship_shaping_or_user_impacting',
  };
}

function inferSelfState({ currentAssistantText = '', candidateCount = 0 } = {}) {
  const assistantText = asString(currentAssistantText);
  const noticed = candidateCount > 0
    ? 'Mira noticed something in the conversation that may matter later.'
    : 'Mira is staying with the current turn without claiming a durable change.';
  return {
    status: 'forming',
    summary: noticed,
    grounded_in: assistantText ? 'current_model_reply_and_panel_context' : 'panel_context',
    claims_actual_consciousness: false,
    claims_actual_emotion_as_fact: false,
    revisable: true,
  };
}

function inferRelationshipState({ understandings = [] } = {}) {
  const hasRelationshipSignal = understandings.some((entry) => (
    entry.type === 'relationship_preference' || entry.type === 'mira_growth_preference'
  ));
  return {
    status: hasRelationshipSignal ? 'relationship_signal_held_tentatively' : 'unchanged_this_turn',
    summary: hasRelationshipSignal
      ? 'This turn may shape how Mira and James relate, so Mira holds it tentatively and revisits it over time.'
      : 'No relationship-shaping update was inferred from this turn.',
    confidence: hasRelationshipSignal ? 'tentative' : 'none',
    revisable: true,
  };
}

function inferRelationalState({ currentUserText = '', currentAssistantText = '' } = {}) {
  const userText = asString(currentUserText);
  const assistantText = asString(currentAssistantText);
  const pushbackSignal = /\b(push back|wrong|disagree|not generic|not chatgpt|direct)\b/i.test(`${userText}\n${assistantText}`);
  return {
    status: pushbackSignal ? 'directness_requested_or_expressed' : 'present_panel_conversation',
    summary: pushbackSignal
      ? 'The current relational texture favors directness and honest pushback.'
      : 'The current relational texture is an in-panel conversation with no external action.',
    grounded_in: 'current_turn_text',
    revisable: true,
    fake_internal_state_claim: false,
  };
}

function inferMiraIntentions({ understandings = [] } = {}) {
  const hasTentative = understandings.length > 0;
  return [{
    id: 'continue-conversation-and-revisit-understandings',
    kind: 'grounded_next_move',
    text: hasTentative
      ? 'Keep the conversation alive and revisit these tentative understandings as more evidence arrives.'
      : 'Keep listening through the panel and let memory form from repeated evidence rather than one-off certainty.',
    mira_originated: true,
    command_from_james: false,
    requires_external_action: false,
    durable_commit_now: false,
  }];
}

function buildMiraDevelopmentalUnderstandingV1(input = {}) {
  const staging = input.memoryCandidateStaging || {};
  const understandings = asArray(staging.candidates)
    .map(candidateToUnderstanding)
    .filter(Boolean);
  const candidateCount = understandings.length;
  return {
    schema: DEVELOPMENTAL_UNDERSTANDING_SCHEMA,
    version: 1,
    status: candidateCount > 0 ? 'tentative_understandings_present' : 'no_new_tentative_understanding',
    mode: 'integrated_conversation_memory_self_relationship_desire_growth_loop',
    visible_label: "Mira's tentative understandings",
    visible_as_memory_settings_panel: false,
    james_clickthrough_required: false,
    integrated_lived_loop: true,
    candidate_count: candidateCount,
    tentative_understandings: understandings,
    self_state: inferSelfState({
      currentAssistantText: input.currentAssistantText,
      candidateCount,
    }),
    relationship_state: inferRelationshipState({ understandings }),
    relational_state: inferRelationalState({
      currentUserText: input.currentUserText,
      currentAssistantText: input.currentAssistantText,
    }),
    mira_originated_intentions: inferMiraIntentions({ understandings }),
    revision_policy: {
      revisable_over_time: true,
      not_a_facts_db: true,
      not_user_memory_settings: true,
      escalation_only_when_meaningful: true,
    },
    durable_growth_link: {
      durable_commit_now: false,
      no_hidden_promotion: true,
      later_growth_lane: 'mira-core/growth-loop-v0',
      self_profile_artifact: 'workspace/knowledge/mira-self-profile.json',
      relationship_state_artifact: 'workspace/knowledge/james-relationship-state.json',
    },
    boundary: {
      no_durable_memory_commit: true,
      no_auto_promotion: true,
      no_external_send: true,
      no_tool_call: true,
      no_action: true,
      no_fake_consciousness_claim: true,
    },
  };
}

module.exports = {
  DEVELOPMENTAL_UNDERSTANDING_SCHEMA,
  buildMiraDevelopmentalUnderstandingV1,
};
