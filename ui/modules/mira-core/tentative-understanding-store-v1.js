'use strict';

const { CognitiveMemoryStore } = require('../cognitive-memory-store');

const MIRA_TENTATIVE_UNDERSTANDING_STORE_SCHEMA = 'squidrun.mira_core.tentative_understanding_store_v1';
const MIRA_TENTATIVE_UNDERSTANDING_CATEGORY = 'mira_tentative_understanding';
const MIRA_TENTATIVE_UNDERSTANDING_DOMAIN = 'mira_relationship_presence';
const TENTATIVE_PROMOTION_STATUS = 'tentative_not_committed';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function safeParseJson(raw, fallback = {}) {
  try {
    if (raw === undefined || raw === null || raw === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function triageForCandidate(candidate = {}) {
  const type = asString(candidate.type, '');
  if (type === 'relationship_preference' || type === 'mira_growth_preference') {
    return {
      risk_level: 'relationship_shaping',
      triage_status: 'held_tentatively',
      triage_action: 'hold_and_revisit',
      escalation_policy: 'rare_escalation_if_sensitive_ambiguous_contradictory_or_relationship_shaping',
      auto_accept_allowed: false,
      james_clickthrough_required: false,
    };
  }
  if (type === 'user_preference') {
    return {
      risk_level: 'user_impacting',
      triage_status: 'held_tentatively',
      triage_action: 'hold_and_revisit',
      escalation_policy: 'rare_escalation_if_ambiguous_contradictory_or_user_impacting',
      auto_accept_allowed: false,
      james_clickthrough_required: false,
    };
  }
  return {
    risk_level: 'low_operational_context',
    triage_status: 'auto_staged_tentative',
    triage_action: 'auto_stage_under_tested_rules',
    escalation_policy: 'no_escalation_unless_later_contradiction_or_user_impact',
    auto_accept_allowed: true,
    james_clickthrough_required: false,
  };
}

function normalizeCandidate(candidate = {}) {
  const statement = asString(candidate.statement);
  if (!statement) return null;
  const candidateId = asString(candidate.candidate_id || candidate.id, '');
  const triage = triageForCandidate(candidate);
  return {
    ...candidate,
    ...triage,
    candidate_id: candidateId || `mira-understanding:${Buffer.from(statement).toString('base64url').slice(0, 24)}`,
    statement,
    understanding_status: 'tentative',
    confidence: candidate.confidence || 'tentative',
    durable_memory_commit: false,
    promotion_status: TENTATIVE_PROMOTION_STATUS,
    humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
  };
}

function candidatesFromStaging(staging = {}) {
  return asArray(staging.candidates)
    .map(normalizeCandidate)
    .filter(Boolean);
}

function candidateToMemoryPr(candidate = {}, options = {}) {
  const sourceTrace = [
    'mira-local-text',
    asString(options.sessionId, 'app-session'),
    candidate.candidate_id,
  ].join(':');
  return {
    pr_id: candidate.candidate_id.replace(/^mira-memory-candidate:/, 'mira-understanding:'),
    category: MIRA_TENTATIVE_UNDERSTANDING_CATEGORY,
    statement: candidate.statement,
    confidence_score: 0.5,
    review_count: 0,
    status: 'pending',
    domain: MIRA_TENTATIVE_UNDERSTANDING_DOMAIN,
    proposed_by: 'mira_typed_conversation',
    source_trace: sourceTrace,
    source_payload: {
      schema: MIRA_TENTATIVE_UNDERSTANDING_STORE_SCHEMA,
      candidate_id: candidate.candidate_id,
      type: candidate.type || null,
      source: candidate.source || null,
      source_role: candidate.source_role || null,
      source_text: candidate.source_text || null,
      evidence_summary: candidate.source_text || candidate.statement,
      understanding_status: 'tentative',
      confidence: candidate.confidence || 'tentative',
      risk_level: candidate.risk_level,
      triage_status: candidate.triage_status,
      triage_action: candidate.triage_action,
      escalation_policy: candidate.escalation_policy,
      auto_accept_allowed: candidate.auto_accept_allowed === true,
      durable_memory_commit: false,
      promotion_status: TENTATIVE_PROMOTION_STATUS,
      auto_promotion: false,
      session_id: asString(options.sessionId, null),
      generated_at: asString(options.generatedAt, null),
      surface_id: asString(options.surfaceId, null),
      visible_label: "Mira's tentative understandings",
      owner: 'mira_memory_triage',
      james_clickthrough_required: false,
      oracle_role: 'audit_groundedness_and_hallucination_risk_only',
      builder_role: 'mechanism_only',
      hidden_agent_only_promotion_path: false,
      visible_as_memory_settings_panel: false,
      humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
    },
  };
}

function normalizeStoreRow(row = {}) {
  const sourcePayload = safeParseJson(row.source_payload_json, row.source_payload || {});
  return {
    pr_id: row.pr_id,
    candidate_id: sourcePayload.candidate_id || row.pr_id,
    statement: row.statement,
    category: row.category,
    domain: row.domain,
    status: row.status || 'pending',
    understanding_status: sourcePayload.understanding_status || 'tentative',
    confidence: sourcePayload.confidence || 'tentative',
    risk_level: sourcePayload.risk_level || 'unknown',
    triage_status: sourcePayload.triage_status || 'held_tentatively',
    triage_action: sourcePayload.triage_action || 'hold_and_revisit',
    escalation_policy: sourcePayload.escalation_policy || 'rare_escalation_if_sensitive_ambiguous_contradictory_or_user_impacting',
    auto_accept_allowed: sourcePayload.auto_accept_allowed === true,
    durable_memory_commit: sourcePayload.durable_memory_commit === true,
    promotion_status: sourcePayload.promotion_status || TENTATIVE_PROMOTION_STATUS,
    auto_promotion: sourcePayload.auto_promotion === true,
    owner: sourcePayload.owner || 'mira_memory_triage',
    james_clickthrough_required: sourcePayload.james_clickthrough_required === true,
    visible_as_memory_settings_panel: sourcePayload.visible_as_memory_settings_panel === true,
    hidden_agent_only_promotion_path: sourcePayload.hidden_agent_only_promotion_path === true,
    source_trace: row.source_trace || null,
    source_payload: sourcePayload,
    created_at_ms: row.created_at_ms || null,
    updated_at_ms: row.updated_at_ms || null,
  };
}

function basePersistenceResult(overrides = {}) {
  return {
    schema: MIRA_TENTATIVE_UNDERSTANDING_STORE_SCHEMA,
    version: 1,
    ok: true,
    mode: 'internal_cognitive_memory_pr_scaffold',
    status: 'no_tentative_understandings',
    candidate_count: 0,
    stored_count: 0,
    internal_scaffold: true,
    visible_as_memory_settings_panel: false,
    owner: 'mira_memory_triage',
    james_clickthrough_required: false,
    durable_memory_commit: false,
    promotion_status: TENTATIVE_PROMOTION_STATUS,
    auto_promotion: false,
    hidden_agent_only_promotion_path: false,
    tentative_understanding_write_count: 0,
    tentative_understanding_database_write_count: 0,
    tentative_understanding_file_write_count: 0,
    durable_memory_commit_count: 0,
    promotion_count: 0,
    staged_pr_ids: [],
    merged_pr_ids: [],
    pending_count: 0,
    pending_pr_path: null,
    db_path: null,
    persisted_understandings: [],
    ...overrides,
  };
}

function persistMiraTentativeUnderstandingsV1(staging = {}, options = {}) {
  const candidates = candidatesFromStaging(staging);
  if (candidates.length === 0) {
    return basePersistenceResult();
  }

  const store = options.store || new CognitiveMemoryStore({
    projectRoot: options.projectRoot,
    profileName: options.profileName || 'main',
  });
  const ownsStore = !options.store;
  try {
    const prCandidates = candidates.map((candidate) => candidateToMemoryPr(candidate, options));
    const staged = store.stageMemoryPRs(prCandidates, options.stageOptions || {});
    const ids = [...staged.staged, ...staged.merged];
    const persistedRows = typeof store.getMemoryPRsByIds === 'function'
      ? store.getMemoryPRsByIds(ids)
      : [];
    return basePersistenceResult({
      ok: true,
      status: 'tentative_understandings_recorded',
      candidate_count: candidates.length,
      stored_count: ids.length,
      tentative_understanding_write_count: 1,
      tentative_understanding_database_write_count: 1,
      tentative_understanding_file_write_count: 1,
      staged_pr_ids: staged.staged,
      merged_pr_ids: staged.merged,
      pending_count: staged.pendingCount,
      pending_pr_path: store.pendingPrPath || null,
      db_path: store.dbPath || null,
      persisted_understandings: persistedRows.map(normalizeStoreRow),
    });
  } catch (err) {
    return basePersistenceResult({
      ok: false,
      status: 'tentative_understanding_store_failed',
      candidate_count: candidates.length,
      reason: err?.message || String(err),
      pending_pr_path: store.pendingPrPath || null,
      db_path: store.dbPath || null,
    });
  } finally {
    if (ownsStore && typeof store.close === 'function') {
      try { store.close(); } catch {}
    }
  }
}

function readMiraTentativeUnderstandingsV1(options = {}) {
  const store = options.store || new CognitiveMemoryStore({
    projectRoot: options.projectRoot,
    profileName: options.profileName || 'main',
  });
  const ownsStore = !options.store;
  try {
    const rows = store.listPendingPRs({
      status: options.status || 'pending',
      limit: options.limit || 100,
    });
    const items = rows
      .map(normalizeStoreRow)
      .filter((row) => row.category === MIRA_TENTATIVE_UNDERSTANDING_CATEGORY);
    return {
      schema: MIRA_TENTATIVE_UNDERSTANDING_STORE_SCHEMA,
      version: 1,
      ok: true,
      mode: 'internal_cognitive_memory_pr_scaffold',
      pending_pr_path: store.pendingPrPath || null,
      db_path: store.dbPath || null,
      count: items.length,
      items,
    };
  } finally {
    if (ownsStore && typeof store.close === 'function') {
      try { store.close(); } catch {}
    }
  }
}

module.exports = {
  MIRA_TENTATIVE_UNDERSTANDING_CATEGORY,
  MIRA_TENTATIVE_UNDERSTANDING_DOMAIN,
  MIRA_TENTATIVE_UNDERSTANDING_STORE_SCHEMA,
  TENTATIVE_PROMOTION_STATUS,
  candidateToMemoryPr,
  persistMiraTentativeUnderstandingsV1,
  readMiraTentativeUnderstandingsV1,
  triageForCandidate,
};
