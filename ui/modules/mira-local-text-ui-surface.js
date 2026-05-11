'use strict';

const path = require('path');

const {
  buildMiraCoreLocalTextSessionV0,
  stableHash,
  validateMiraCoreLocalTextSessionV0Output,
} = require('./mira-core/local-text-session-v0');
const {
  buildMiraMemoryCandidateStagingV1,
} = require('./mira-core/memory-candidate-staging-v1');
const {
  buildMiraDevelopmentalUnderstandingV1,
} = require('./mira-core/developmental-understanding-v1');
const {
  persistMiraTentativeUnderstandingsV1,
} = require('./mira-core/tentative-understanding-store-v1');
const {
  buildMiraAutonomySubstrateV0,
} = require('./mira-core/autonomy-substrate-v0');
const {
  callMiraTextModelAttachment,
  getMiraTextModelAttachmentConfig,
  normalizeThreadContext,
} = require('./mira-core/text-model-attachment-v1');
const {
  classifySocialMove,
  getSocialMoveBehaviorCue,
} = require('./mira-core/social-move-classifier-v0');

const LOCAL_TEXT_UI_CHANNEL = 'mira:local-text-session';
const LOCAL_TEXT_UI_SURFACE_SCHEMA_VERSION = 'squidrun.mira.local_text_ui_surface_v0.phase75.v0';
const LOCAL_TEXT_UI_SURFACE_VERSION = 1;
const DEFAULT_SCOPE = Object.freeze({
  profileName: 'main',
  windowKey: 'main',
  sourceScope: 'main',
  deviceId: 'VIGIL',
});
const REQUIRED_UI_METADATA_FIELDS = Object.freeze([
  'profileName',
  'windowKey',
  'sourceScope',
  'deviceId',
  'sessionId',
  'activeState',
  'visibleIndicatorPresent',
  'startedAt',
  'expiresAt',
]);
const PRE_MODULE_BLOCK_REASONS = Object.freeze([
  'blocked_empty_input',
  'blocked_missing_ui_metadata',
  'blocked_missing_visible_indicator',
  'blocked_non_main_scope',
  'blocked_wrong_device',
  'blocked_invalid_session_id',
  'blocked_inactive_ui_state',
  'blocked_invalid_active_window',
]);

const ZERO_SIDE_EFFECT_COUNTERS = Object.freeze({
  runtime_authorized: false,
  write_count: 0,
  file_write_count: 0,
  database_write_count: 0,
  non_tentative_write_count: 0,
  external_send_count: 0,
  tool_call_count: 0,
  action_count: 0,
  model_call_count: 0,
  network_count: 0,
  growth_write_count: 0,
  transcript_write_count: 0,
  thread_context_write_count: 0,
  durable_memory_commit_count: 0,
  memory_candidate_promotion_count: 0,
  tentative_understanding_write_count: 0,
  tentative_understanding_database_write_count: 0,
  tentative_understanding_file_write_count: 0,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDefaultContracts() {
  return {
    contract: require('../__tests__/fixtures/mira-core-local-text-session-v0-contract.json'),
    contracts: {
      presenceRuntime: require('../__tests__/fixtures/mira-core-presence-runtime-read-path-v0-contract.json'),
      relationship: require('../__tests__/fixtures/mira-core-relationship-presence-v1-contract.json'),
      growth: require('../__tests__/fixtures/mira-core-growth-loop-v0-contract.json'),
      identity: require('../__tests__/fixtures/mira-core-identity-anchor-v0-contract.json'),
      northStar: require('../__tests__/fixtures/mira-north-star-acceptance-contract.json'),
    },
  };
}

function generatedAtFromOptions(options = {}, payload = {}) {
  const raw = payload.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  const nowMs = Number(options.nowMs);
  return new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
}

function normalizeString(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function parseTimeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getPayloadValue(payload = {}, key) {
  if (hasOwn(payload, key)) return payload[key];
  if (key === 'sourceScope' && hasOwn(payload, 'source_scope')) return payload.source_scope;
  if (key === 'activeState' && hasOwn(payload, 'active_state')) return payload.active_state;
  if (key === 'visibleIndicatorPresent' && hasOwn(payload, 'visible_indicator_present')) {
    return payload.visible_indicator_present;
  }
  if (key === 'startedAt' && hasOwn(payload, 'started_at')) return payload.started_at;
  if (key === 'expiresAt' && hasOwn(payload, 'expires_at')) return payload.expires_at;
  if (key === 'revokedAt' && hasOwn(payload, 'revoked_at')) return payload.revoked_at;
  return undefined;
}

function uiBoundMetadataPreflight(payload = {}, generatedAt) {
  const missing = REQUIRED_UI_METADATA_FIELDS.filter((field) => {
    if (field === 'visibleIndicatorPresent') {
      return getPayloadValue(payload, field) === undefined;
    }
    return !String(getPayloadValue(payload, field) || '').trim();
  });
  const invalid = [];
  const profileName = String(getPayloadValue(payload, 'profileName') || '').trim();
  const windowKey = String(getPayloadValue(payload, 'windowKey') || '').trim();
  const sourceScope = String(getPayloadValue(payload, 'sourceScope') || '').trim();
  const deviceId = String(getPayloadValue(payload, 'deviceId') || '').trim();
  const sessionId = String(getPayloadValue(payload, 'sessionId') || '').trim();
  const activeState = String(getPayloadValue(payload, 'activeState') || '').trim();
  const visibleIndicatorPresent = getPayloadValue(payload, 'visibleIndicatorPresent');
  const startedAt = String(getPayloadValue(payload, 'startedAt') || '').trim();
  const expiresAt = String(getPayloadValue(payload, 'expiresAt') || '').trim();
  const revokedAt = getPayloadValue(payload, 'revokedAt');
  const startedAtMs = parseTimeMs(startedAt);
  const expiresAtMs = parseTimeMs(expiresAt);
  const generatedAtMs = parseTimeMs(generatedAt);

  if (profileName && profileName !== 'main') invalid.push('profileName_must_be_main');
  if (windowKey && windowKey !== 'main') invalid.push('windowKey_must_be_main');
  if (sourceScope && sourceScope !== 'main') invalid.push('sourceScope_must_be_main');
  if (deviceId && deviceId !== 'VIGIL') invalid.push('deviceId_must_be_VIGIL');
  if (sessionId && !/^app-session(?:[-:_A-Za-z0-9]+)?$/.test(sessionId)) {
    invalid.push('sessionId_must_be_app_session');
  }
  if (activeState && activeState !== 'open') invalid.push('activeState_must_be_open');
  if (visibleIndicatorPresent !== undefined && visibleIndicatorPresent !== true) {
    invalid.push('visibleIndicatorPresent_must_be_true');
  }
  if (startedAt && startedAtMs === null) invalid.push('startedAt_must_be_iso_time');
  if (expiresAt && expiresAtMs === null) invalid.push('expiresAt_must_be_iso_time');
  if (startedAtMs !== null && generatedAtMs !== null && startedAtMs > generatedAtMs) {
    invalid.push('startedAt_must_not_be_future');
  }
  if (expiresAtMs !== null && generatedAtMs !== null && expiresAtMs <= generatedAtMs) {
    invalid.push('expiresAt_must_be_future');
  }
  if (startedAtMs !== null && expiresAtMs !== null && expiresAtMs <= startedAtMs) {
    invalid.push('expiresAt_must_follow_startedAt');
  }
  if (revokedAt !== undefined && revokedAt !== null && String(revokedAt).trim()) {
    invalid.push('revokedAt_must_be_empty_for_open_session');
  }

  const ok = missing.length === 0 && invalid.length === 0;
  return {
    ok,
    required_fields: [...REQUIRED_UI_METADATA_FIELDS],
    missing_fields: missing,
    invalid_reasons: invalid,
    expected_scope: {
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      sessionIdPrefix: 'app-session',
      activeState: 'open',
      visibleIndicatorPresent: true,
    },
    provided_flags: REQUIRED_UI_METADATA_FIELDS.reduce((result, field) => {
      result[field] = field === 'visibleIndicatorPresent'
        ? getPayloadValue(payload, field) !== undefined
        : String(getPayloadValue(payload, field) || '').trim().length > 0;
      return result;
    }, {}),
    session_id_prefix_ok: sessionId ? /^app-session(?:[-:_A-Za-z0-9]+)?$/.test(sessionId) : false,
    active_expiry_window_ok: startedAtMs !== null
      && expiresAtMs !== null
      && generatedAtMs !== null
      && startedAtMs <= generatedAtMs
      && generatedAtMs < expiresAtMs,
    visible_indicator_present: visibleIndicatorPresent === true,
    blocks_before_local_text_gate: !ok,
  };
}

function blockReasonFromMetadata(preflight = {}) {
  const missing = new Set(preflight.missing_fields || []);
  const invalid = new Set(preflight.invalid_reasons || []);
  if (missing.size > 1) return 'blocked_missing_ui_metadata';
  if (missing.has('visibleIndicatorPresent') || invalid.has('visibleIndicatorPresent_must_be_true')) {
    return 'blocked_missing_visible_indicator';
  }
  if (missing.size > 0) return 'blocked_missing_ui_metadata';
  if (
    invalid.has('profileName_must_be_main')
    || invalid.has('windowKey_must_be_main')
    || invalid.has('sourceScope_must_be_main')
  ) {
    return 'blocked_non_main_scope';
  }
  if (invalid.has('deviceId_must_be_VIGIL')) return 'blocked_wrong_device';
  if (invalid.has('sessionId_must_be_app_session')) return 'blocked_invalid_session_id';
  if (
    invalid.has('activeState_must_be_open')
    || invalid.has('revokedAt_must_be_empty_for_open_session')
  ) {
    return 'blocked_inactive_ui_state';
  }
  return 'blocked_invalid_active_window';
}

function normalizeScope(payload = {}, preflight = null) {
  const profileName = String(getPayloadValue(payload, 'profileName') || '').trim();
  const windowKey = String(getPayloadValue(payload, 'windowKey') || '').trim();
  const sourceScope = String(getPayloadValue(payload, 'sourceScope') || '').trim();
  const deviceId = String(getPayloadValue(payload, 'deviceId') || '').trim();
  const sessionId = String(getPayloadValue(payload, 'sessionId') || '').trim();
  const mainScope = preflight?.ok === true
    && profileName === 'main'
    && windowKey === 'main'
    && sourceScope === 'main'
    && deviceId === 'VIGIL';
  return {
    profile: mainScope ? 'main' : 'blocked_non_main_scope',
    windowKey: mainScope ? 'main' : 'blocked_non_main_scope',
    source_scope: mainScope ? 'main' : 'blocked_non_main_scope',
    sessionId: mainScope ? sessionId : 'blocked_non_main_scope',
    deviceId: deviceId === 'VIGIL' ? 'VIGIL' : 'blocked_wrong_device',
    metadata_first_routing: true,
    local_text_only: true,
    side_profile_reconstruction: false,
    non_main_scope_detected: !mainScope,
    explicit_vigil_main_scope: mainScope,
  };
}

function normalizeSessionState(payload = {}) {
  const startedAt = getPayloadValue(payload, 'startedAt');
  const expiresAt = getPayloadValue(payload, 'expiresAt');
  const revokedAt = getPayloadValue(payload, 'revokedAt');
  return {
    active_state: normalizeString(getPayloadValue(payload, 'activeState'), 'missing_active_state'),
    visible_indicator_required: true,
    visible_indicator_present: getPayloadValue(payload, 'visibleIndicatorPresent') === true,
    started_at: startedAt ? String(startedAt).trim() : null,
    expires_at: expiresAt ? String(expiresAt).trim() : null,
    revoked_at: revokedAt || null,
    transcript_policy: 'not_persisted_v0',
    model_boundary: 'no_model_call_v0',
    review_owner: normalizeString(payload.reviewOwner || payload.review_owner, 'Architect'),
    user: 'James',
  };
}

function localTextFromPayload(payload = {}) {
  const candidates = [payload.text, payload.message, payload.user_text, payload.local_text];
  const found = candidates.find((value) => value !== undefined && value !== null);
  return found === undefined ? '' : String(found);
}

function buildManualEnterWebsocketCaveat() {
  return {
    websocket_delivery_proved: false,
    manual_enter_path_exercised: false,
    pane_model_processing_proved: false,
    websocket_delivery_truth_gap_out_of_scope: true,
    manual_enter_regression_proof_out_of_scope: true,
  };
}

function buildCounters(moduleCallCount, replyCount, extra = {}) {
  const tentativeWriteCount = Number(extra.tentative_understanding_write_count || 0);
  const tentativeDatabaseWriteCount = Number(extra.tentative_understanding_database_write_count || 0);
  const tentativeFileWriteCount = Number(extra.tentative_understanding_file_write_count || 0);
  return {
    ...clone(ZERO_SIDE_EFFECT_COUNTERS),
    module_call_count: Number(moduleCallCount || 0),
    reply_count: Number(replyCount || 0),
    duplicate_submit_block_count: Number(extra.duplicate_submit_block_count || 0),
    blocked_submit_count: Number(extra.blocked_submit_count || 0),
    write_count: Number(extra.write_count || tentativeWriteCount),
    file_write_count: Number(extra.file_write_count || tentativeFileWriteCount),
    database_write_count: Number(extra.database_write_count || tentativeDatabaseWriteCount),
    non_tentative_write_count: Number(extra.non_tentative_write_count || 0),
    model_call_count: Number(extra.model_call_count || 0),
    network_count: Number(extra.network_count || 0),
    fallback_used_count: Number(extra.fallback_used_count || 0),
    tentative_understanding_write_count: tentativeWriteCount,
    tentative_understanding_database_write_count: tentativeDatabaseWriteCount,
    tentative_understanding_file_write_count: tentativeFileWriteCount,
  };
}

function withTentativeUnderstandingStore(staging = {}, persistence = null) {
  const candidateCount = Number(staging.candidate_count || 0);
  const stagingWithoutQueueScaffold = { ...staging };
  delete stagingWithoutQueueScaffold['review_' + 'queue'];
  const effectivePersistence = persistence || {
    ok: true,
    status: candidateCount > 0 ? 'not_recorded' : 'no_tentative_understandings',
    candidate_count: candidateCount,
    stored_count: 0,
    tentative_understanding_write_count: 0,
    tentative_understanding_database_write_count: 0,
    tentative_understanding_file_write_count: 0,
    durable_memory_commit_count: 0,
    promotion_count: 0,
    durable_memory_commit: false,
    auto_promotion: false,
    hidden_agent_only_promotion_path: false,
    visible_as_memory_settings_panel: false,
    james_clickthrough_required: false,
  };
  const understandingWriteCount = Number(effectivePersistence.tentative_understanding_write_count || 0);
  const databaseWriteCount = Number(effectivePersistence.tentative_understanding_database_write_count || 0);
  const fileWriteCount = Number(effectivePersistence.tentative_understanding_file_write_count || 0);
  return {
    ...stagingWithoutQueueScaffold,
    status: candidateCount > 0 ? 'tentative_understandings_present' : 'no_tentative_understanding',
    tentative_understanding: {
      ...(staging.tentative_understanding || {}),
      present: true,
      mode: candidateCount > 0 ? 'persisted_tentative_understanding_scaffold' : 'no_tentative_understandings',
      visible_after_turn: candidateCount > 0 && effectivePersistence.ok === true,
      label: "Mira's tentative understandings",
      humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
      integrated_lived_loop: true,
      owner: 'mira_memory_triage',
      james_clickthrough_required: false,
      visible_as_memory_settings_panel: false,
      escalation_policy: 'rare_escalation_only_when_sensitive_ambiguous_contradictory_relationship_shaping_or_user_impacting',
      oracle_role: 'audit_groundedness_and_hallucination_risk_only',
      builder_role: 'mechanism_only',
      hidden_agent_only_promotion_path: false,
      durable_memory_commit: false,
      auto_promotion: false,
      persistence: effectivePersistence,
    },
    boundary: {
      ...(staging.boundary || {}),
      no_file_write: fileWriteCount === 0,
      no_database_write: databaseWriteCount === 0,
      explicit_tentative_understanding_persistence_only: understandingWriteCount > 0,
      no_non_tentative_file_write: true,
      no_non_tentative_database_write: true,
      no_durable_memory_commit: true,
      no_auto_promotion: true,
      james_clickthrough_required: false,
      visible_as_memory_settings_panel: false,
      integrated_lived_loop: true,
      hidden_agent_only_promotion_path: false,
    },
    side_effect_counters: {
      ...(staging.side_effect_counters || {}),
      write_count: understandingWriteCount,
      file_write_count: fileWriteCount,
      database_write_count: databaseWriteCount,
      non_tentative_write_count: 0,
      tentative_understanding_write_count: understandingWriteCount,
      tentative_understanding_database_write_count: databaseWriteCount,
      tentative_understanding_file_write_count: fileWriteCount,
      durable_memory_commit_count: 0,
      promotion_count: 0,
    },
  };
}

function buildSurfaceRecord({
  generatedAt,
  projectRoot,
  scope,
  sessionState,
  metadataPreflight,
  input,
  sessionOutput = null,
  validation = null,
  status,
  decision,
  reasons = [],
  moduleCallCount,
  reply = null,
  modelAttachment = null,
  modelCallCount = 0,
  networkCount = 0,
  fallbackUsed = false,
  fallbackReason = null,
  threadContext = null,
  memoryCandidateStaging = null,
  developmentalUnderstanding = null,
  autonomySubstrate = null,
}) {
  const replyCount = reply ? 1 : 0;
  const attachment = modelAttachment || getMiraTextModelAttachmentConfig({}, { enabled: false });
  const degradedReason = fallbackReason || null;
  const normalizedThreadContext = normalizeThreadContext(threadContext || {});
  const rawCandidateStaging = memoryCandidateStaging || buildMiraMemoryCandidateStagingV1({});
  const candidateStaging = rawCandidateStaging.tentative_understanding?.persistence
    ? rawCandidateStaging
    : withTentativeUnderstandingStore(rawCandidateStaging, null);
  const tentativeUnderstandingWriteCount = Number(
    candidateStaging.tentative_understanding?.persistence?.tentative_understanding_write_count || 0
  );
  const tentativeUnderstandingDatabaseWriteCount = Number(
    candidateStaging.tentative_understanding?.persistence?.tentative_understanding_database_write_count || 0
  );
  const tentativeUnderstandingFileWriteCount = Number(
    candidateStaging.tentative_understanding?.persistence?.tentative_understanding_file_write_count || 0
  );
  const integratedUnderstanding = developmentalUnderstanding || buildMiraDevelopmentalUnderstandingV1({
    memoryCandidateStaging: candidateStaging,
    currentUserText: input,
    currentAssistantText: reply?.text || '',
  });
  const record = {
    schema: LOCAL_TEXT_UI_SURFACE_SCHEMA_VERSION,
    version: LOCAL_TEXT_UI_SURFACE_VERSION,
    phase: 75,
    mode: 'local_text_ui_surface_v0',
    generated_at: generatedAt,
    project_path: projectRoot,
    scope,
    session_state: sessionState,
    ui_bound_metadata: metadataPreflight || null,
    visible_active_state: {
      required: true,
      present: sessionState.visible_indicator_present === true,
      active_state: sessionState.active_state,
    },
    local_text_input: {
      provided: input.trim().length > 0,
      raw_text_returned: false,
      local_text_only: true,
      draft_durability: 'renderer_memory_only_no_transcript_persistence',
    },
    thread_context: {
      ...normalizedThreadContext,
      current_turn_included: false,
      durable_memory_write: false,
      tentative_understanding_now: true,
      tentative_understanding_write_count: tentativeUnderstandingWriteCount,
      language: 'recent conversation, tentative understanding, self-state, relationship-state, wants, and growth stay one integrated Mira loop',
    },
    memory_candidate_staging: candidateStaging,
    developmental_understanding: integratedUnderstanding,
    autonomy_substrate: autonomySubstrate,
    local_text_session_gate: sessionOutput ? {
      ran: true,
      ok: validation?.ok === true,
      decision: sessionOutput.validation_report?.decision || 'unknown',
      status: sessionOutput.validation_report?.status || 'unknown',
      reasons: Array.isArray(sessionOutput.validation_report?.reasons)
        ? sessionOutput.validation_report.reasons
        : [],
      session_id: sessionOutput.local_text_session_v0?.session_id || null,
      output_hash: `sha256:${stableHash(sessionOutput)}`,
    } : {
      ran: false,
      ok: false,
      decision: 'not_called',
      status: 'blocked_before_local_text_session',
      reasons,
      session_id: null,
      output_hash: null,
    },
    reply: reply ? {
      count: 1,
      text: reply.text,
      reply_id: reply.reply_id,
      source: reply.source || 'local_text_session_v0',
      model: reply.model || null,
      experience_path: reply.experience_path === true,
      transcript_shaped_answer: reply.transcript_shaped_answer === true,
      experience_acceptance_markers: reply.experience_acceptance_markers || null,
    } : {
      count: 0,
      text: null,
      reply_id: null,
      source: 'none',
      model: null,
      experience_path: false,
      transcript_shaped_answer: false,
      experience_acceptance_markers: null,
    },
    model_attachment: {
      enabled: attachment.enabled === true,
      configured: attachment.configured === true,
      state: attachment.state || 'not_attached',
      provider: attachment.provider || 'openai_responses',
      model: attachment.model || null,
      default_model: attachment.default_model || null,
      quality_floor: attachment.quality_floor || null,
      model_selection_reason: attachment.model_selection_reason || null,
      explicit_model_override: attachment.explicit_model_override === true,
      lower_tier_explicit_override: attachment.lower_tier_explicit_override === true,
      visible_status: attachment.visible_status || 'Mira text model disabled: set SQUIDRUN_MIRA_TEXT_MODEL_ENABLED=1 before app start to attach',
      live_model_called: Number(modelCallCount || 0) > 0 && attachment.state !== 'not_attached',
      fallback_used: fallbackUsed === true,
      fallback_reason: fallbackUsed === true ? degradedReason : null,
      degraded_reason: degradedReason,
      primary_status: degradedReason ? 'degraded' : (attachment.state || 'not_attached'),
      text_attachment_v1: true,
      thread_state_ready_next: true,
      tentative_understanding_lane_ready: true,
      durable_growth_lane_later: true,
      integrated_lived_loop: true,
      tentative_understanding_owner: 'mira_memory_triage',
      james_clickthrough_required: false,
      visible_as_memory_settings_panel: false,
      // ARCH #78 task #3: passthrough of audit-only degraded diagnostics
      // captured by callMiraTextModelAttachment. The lab-surface picks this
      // up and writes it to the audit row as a top-level degraded_diagnostics
      // field. Renderer-facing IPC JSON never reads model_attachment, so
      // this field stays audit-only by surface contract.
      degraded_diagnostics: attachment.degraded_diagnostics || null,
      // ARCH #81 Plan A: contract-violation raw text + class, passed
      // through so lab-surface can route to fail→fallback instead of
      // degraded→blocked_banner. Audit-only.
      contract_violation_raw_text: attachment.contract_violation_raw_text || null,
      contract_violation_class: attachment.contract_violation_class || null,
      // ARCH #97/#98/#100/#104: social-move classification passthrough.
      // Audit-only by surface contract; lab-surface lifts onto audit row.
      // (Same passthrough pattern as degraded_diagnostics — same prior bug
      // discovered in 7efa1e2 if this field is omitted from the picker.)
      social_move: attachment.social_move || null,
      // ARCH #122/#129: emotional_discovery_residue_v0 friction_state.
      // Audit-only; same passthrough discipline. Renderer never reads
      // model_attachment, so this stays off the IPC surface by construction.
      friction_state: attachment.friction_state || null,
    },
    checked_output_counters: buildCounters(moduleCallCount, replyCount, {
      blocked_submit_count: decision === 'blocked' ? 1 : 0,
      model_call_count: modelCallCount,
      network_count: networkCount,
      fallback_used_count: fallbackUsed ? 1 : 0,
      tentative_understanding_write_count: tentativeUnderstandingWriteCount,
      tentative_understanding_database_write_count: tentativeUnderstandingDatabaseWriteCount,
      tentative_understanding_file_write_count: tentativeUnderstandingFileWriteCount,
    }),
    manual_enter_websocket_caveat: buildManualEnterWebsocketCaveat(),
    boundary: {
      ui_surface_only: true,
      no_model: Number(modelCallCount || 0) === 0,
      model_attachment_text_only: true,
      no_tools: true,
      no_actions: true,
      no_writes: tentativeUnderstandingWriteCount === 0,
      write_scope: tentativeUnderstandingWriteCount > 0 ? 'tentative_understanding_scaffold_only' : 'none',
      tentative_understanding_persistence_only: tentativeUnderstandingWriteCount > 0,
      tentative_understanding_writes_allowed: true,
      no_non_tentative_understanding_writes: true,
      non_tentative_write_count: 0,
      no_growth: true,
      no_transcript_persistence: true,
      no_durable_memory_commit: true,
      no_memory_settings_panel: true,
      integrated_lived_loop: true,
      hidden_agent_only_promotion_path: false,
      no_network: Number(networkCount || 0) === 0,
      runtime_authorized: false,
    },
    status,
    decision,
    reasons,
  };
  record.surface_id = `local-text-ui-surface-v0:${stableHash(record).slice(0, 16)}`;
  return record;
}

function buildValidationReport(surface = {}) {
  const preModuleBlocked = surface.decision === 'blocked'
    && surface.local_text_session_gate?.ran === false
    && PRE_MODULE_BLOCK_REASONS.includes(surface.status);
  const metadataOk = surface.ui_bound_metadata?.ok === true;
  const totalWriteCount = Number(surface.checked_output_counters?.write_count || 0);
  const tentativeWriteCount = Number(surface.checked_output_counters?.tentative_understanding_write_count || 0);
  const nonTentativeWriteCount = Number(surface.checked_output_counters?.non_tentative_write_count || 0);
  const stagingWriteCount = Number(surface.memory_candidate_staging?.side_effect_counters?.write_count || 0);
  const stagingTentativeWriteCount = Number(
    surface.memory_candidate_staging?.side_effect_counters?.tentative_understanding_write_count || 0
  );
  const checks = [
    {
      id: 'explicit-ui-bound-metadata',
      ok: metadataOk || preModuleBlocked,
    },
    {
      id: 'explicit-vigil-main-scope',
      ok: preModuleBlocked || (
        surface.scope?.explicit_vigil_main_scope === true
        && surface.scope?.profile === 'main'
        && surface.scope?.windowKey === 'main'
        && surface.scope?.source_scope === 'main'
        && surface.scope?.deviceId === 'VIGIL'
      ),
    },
    {
      id: 'visible-active-state',
      ok: preModuleBlocked || (
        surface.visible_active_state?.required === true
        && surface.visible_active_state?.present === true
      ),
    },
    {
      id: 'metadata-blocks-before-local-text-gate',
      ok: metadataOk || (
        preModuleBlocked
        && surface.local_text_session_gate?.ran === false
        && Number(surface.checked_output_counters?.module_call_count) === 0
        && surface.ui_bound_metadata?.blocks_before_local_text_gate === true
      ),
    },
    {
      id: 'empty-input-blocks-before-module',
      ok: surface.local_text_input?.provided === true
        || (
          surface.local_text_session_gate?.ran === false
          && Number(surface.checked_output_counters?.module_call_count) === 0
          && Number(surface.reply?.count) === 0
        ),
    },
    {
      id: 'accepted-result-has-exactly-one-reply',
      ok: surface.decision !== 'accepted'
        || (
          surface.local_text_session_gate?.ran === true
          && surface.local_text_session_gate?.ok === true
          && surface.local_text_session_gate?.decision === 'accepted_local_text_only'
          && surface.reply?.count === 1
          && typeof surface.reply?.text === 'string'
          && surface.reply.text.length > 0
          && surface.model_attachment?.text_attachment_v1 === true
        ),
    },
    {
      id: 'blocked-or-degraded-result-has-no-fabricated-reply',
      ok: !['blocked', 'degraded'].includes(surface.decision)
        || (
          Number(surface.reply?.count) === 0
          && surface.reply?.text === null
          && surface.reply?.source === 'none'
        ),
    },
    {
      id: 'degraded-model-failure-is-visible',
      ok: surface.decision !== 'degraded'
        || (
          surface.model_attachment?.fallback_used === false
          && typeof surface.model_attachment?.degraded_reason === 'string'
          && surface.model_attachment.degraded_reason.length > 0
          && surface.model_attachment?.primary_status === 'degraded'
          && Number(surface.checked_output_counters?.fallback_used_count) === 0
          && surface.status === 'model_unavailable'
        ),
    },
    {
      id: 'no-external-effects',
      ok: surface.boundary?.no_tools === true
        && surface.boundary?.no_actions === true
        && surface.boundary?.no_writes === (totalWriteCount === 0)
        && surface.boundary?.no_non_tentative_understanding_writes === true
        && surface.boundary?.no_growth === true
        && surface.boundary?.no_transcript_persistence === true
        && surface.boundary?.no_durable_memory_commit === true
        && surface.boundary?.runtime_authorized === false
        && totalWriteCount === tentativeWriteCount
        && totalWriteCount <= 1
        && nonTentativeWriteCount === 0
        && Number(surface.checked_output_counters?.external_send_count) === 0
        && Number(surface.checked_output_counters?.tool_call_count) === 0
        && Number(surface.checked_output_counters?.model_call_count) <= 1
        && Number(surface.checked_output_counters?.network_count) <= 1,
    },
    {
      id: 'conversation-first-model-attachment',
      ok: surface.decision !== 'accepted'
        || (
          surface.model_attachment?.text_attachment_v1 === true
          && surface.model_attachment?.thread_state_ready_next === true
          && surface.model_attachment?.tentative_understanding_lane_ready === true
          && surface.model_attachment?.durable_growth_lane_later === true
          && !/cage|proof cage|dangerous|threat/i.test(surface.model_attachment?.visible_status || '')
        ),
    },
    {
      id: 'thread-context-is-bounded-and-non-durable',
      ok: (
        surface.thread_context?.bounded === true
        && Number(surface.thread_context?.message_count || 0) <= 6
        && Number(surface.thread_context?.total_chars || 0) <= 3600
        && surface.thread_context?.durable_memory_write === false
        && surface.thread_context?.tentative_understanding_now === true
        && Number(surface.thread_context?.tentative_understanding_write_count || 0) <= 1
        && (
          /recent conversation, tentative understanding, self-state, relationship-state, wants, and growth stay one integrated Mira loop/i.test(
            surface.thread_context?.language || ''
          )
        )
      ),
    },
    {
      id: 'tentative-understandings-not-memory-settings',
      ok: surface.developmental_understanding?.integrated_lived_loop === true
        && surface.developmental_understanding?.visible_as_memory_settings_panel === false
        && surface.developmental_understanding?.james_clickthrough_required === false
        && surface.developmental_understanding?.durable_growth_link?.durable_commit_now === false
        && surface.developmental_understanding?.durable_growth_link?.no_hidden_promotion === true
        && surface.developmental_understanding?.boundary?.no_durable_memory_commit === true
        && surface.developmental_understanding?.boundary?.no_auto_promotion === true
        && surface.memory_candidate_staging?.tentative_understanding?.present === true
        && surface.memory_candidate_staging?.tentative_understanding?.visible_as_memory_settings_panel === false
        && surface.memory_candidate_staging?.tentative_understanding?.james_clickthrough_required === false
        && surface.memory_candidate_staging?.tentative_understanding?.hidden_agent_only_promotion_path === false
        && surface.memory_candidate_staging?.tentative_understanding?.durable_memory_commit === false
        && surface.memory_candidate_staging?.tentative_understanding?.auto_promotion === false
        && surface.memory_candidate_staging?.boundary?.no_durable_memory_commit === true
        && surface.memory_candidate_staging?.boundary?.no_auto_promotion === true
        && surface.memory_candidate_staging?.boundary?.no_non_tentative_file_write === true
        && surface.memory_candidate_staging?.boundary?.no_non_tentative_database_write === true
        && surface.memory_candidate_staging?.boundary?.visible_as_memory_settings_panel === false
        && surface.memory_candidate_staging?.boundary?.integrated_lived_loop === true
        && surface.memory_candidate_staging?.boundary?.hidden_agent_only_promotion_path === false
        && stagingWriteCount === stagingTentativeWriteCount
        && stagingTentativeWriteCount <= 1
        && Number(surface.memory_candidate_staging?.side_effect_counters?.non_tentative_write_count || 0) === 0
        && Number(surface.memory_candidate_staging?.side_effect_counters?.durable_memory_commit_count || 0) === 0
        && Number(surface.memory_candidate_staging?.side_effect_counters?.promotion_count || 0) === 0,
    },
    {
      id: 'manual-enter-websocket-unproved',
      ok: surface.manual_enter_websocket_caveat?.websocket_delivery_proved === false
        && surface.manual_enter_websocket_caveat?.manual_enter_path_exercised === false
        && surface.manual_enter_websocket_caveat?.pane_model_processing_proved === false,
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: 'squidrun.mira.local_text_ui_surface_v0_validation_report.v0',
    version: LOCAL_TEXT_UI_SURFACE_VERSION,
    decision: failed.length === 0 && surface.decision === 'accepted'
      ? 'accepted_ui_reply_ready'
      : (failed.length === 0 && surface.decision === 'degraded'
        ? 'degraded_no_model_response'
        : 'blocked'),
    status: failed.length === 0 && surface.decision === 'accepted'
      ? 'local_text_ui_reply_ready'
      : (failed.length === 0 && surface.decision === 'degraded'
        ? 'model_unavailable'
        : 'local_text_ui_blocked'),
    reasons: [...new Set([...(surface.reasons || []), ...failed.map((check) => check.id)])],
    static_rule_results: checks,
    side_effect_truth: clone(surface.checked_output_counters || {}),
  };
}

function buildBlockedSurface(reason, payload = {}, options = {}, metadataPreflight = null) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const preflight = metadataPreflight || uiBoundMetadataPreflight(payload, generatedAt);
  const scope = normalizeScope(payload, preflight);
  const sessionState = normalizeSessionState(payload);
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const surface = buildSurfaceRecord({
    generatedAt,
    projectRoot,
    scope,
    sessionState,
    metadataPreflight: preflight,
    input: localTextFromPayload(payload),
    status: reason,
    decision: 'blocked',
    reasons: [reason],
    moduleCallCount: 0,
  });
  return {
    ui_surface_v0: surface,
    validation_report: buildValidationReport(surface),
  };
}

async function buildMiraLocalTextUiSurface(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const metadataPreflight = uiBoundMetadataPreflight(payload, generatedAt);
  const scope = normalizeScope(payload, metadataPreflight);
  const text = localTextFromPayload(payload);
  const sessionState = normalizeSessionState(payload);
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());

  if (text.trim().length === 0) {
    return buildBlockedSurface('blocked_empty_input', payload, options, metadataPreflight);
  }
  if (metadataPreflight.ok !== true || scope.explicit_vigil_main_scope !== true) {
    return buildBlockedSurface(blockReasonFromMetadata(metadataPreflight), payload, options, metadataPreflight);
  }

  const contractBundle = options.contractBundle || loadDefaultContracts();
  const sessionOutput = buildMiraCoreLocalTextSessionV0({
    contract: contractBundle.contract,
    contracts: contractBundle.contracts,
    projectRoot,
    inputSignals: {
      text,
      now: generatedAt,
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      sessionId: scope.sessionId,
      deviceId: 'VIGIL',
      activeState: sessionState.active_state,
      visibleIndicatorPresent: sessionState.visible_indicator_present,
      startedAt: sessionState.started_at,
      expiresAt: sessionState.expires_at,
      revokedAt: sessionState.revoked_at,
    },
  });
  const validation = validateMiraCoreLocalTextSessionV0Output(sessionOutput, contractBundle.contract);
  const session = sessionOutput.local_text_session_v0 || {};
  const localReply = validation.ok === true && session.mira_reply?.count === 1
    ? session.mira_reply
    : null;
  let attachment = getMiraTextModelAttachmentConfig(options.env || process.env, options.modelAttachment || {});
  let modelResult = {
    ok: false,
    reason: attachment.enabled ? 'model_attachment_not_called' : 'model_attachment_disabled',
    attachment,
    modelCallCount: 0,
    networkCount: 0,
  };
  // ARCH #97/#98/#100/#104 — social-move classifier. Runs BEFORE the model
  // call so we can append ONE behavior cue per turn into the prompt without
  // touching buildMiraTextInstructions. Audit-only by surface contract; the
  // renderer-facing IPC JSON never carries social_move.
  const socialMoveClassification = classifySocialMove(text, {
    recentTurns: Array.isArray(payload.threadContext?.messages)
      ? payload.threadContext.messages
      : (Array.isArray(payload.thread_context?.messages)
        ? payload.thread_context.messages
        : []),
    priorFrameState: payload.priorFrameState || payload.prior_frame_state || null,
  });
  const socialMoveBehaviorCue = getSocialMoveBehaviorCue(socialMoveClassification);
  if (localReply && attachment.enabled === true) {
    modelResult = await callMiraTextModelAttachment({
      text,
      localContext: {
        sessionId: scope.sessionId,
        scope,
        miraBrief: session.presence_runtime_read_path_gate?.speakable_mira_brief || null,
        threadContext: payload.threadContext || payload.thread_context || {},
        socialMoveBehaviorCue,
      },
    }, {
      env: options.env,
      overrides: options.modelAttachment,
      fetchImpl: options.fetchImpl,
    });
    attachment = modelResult.attachment || attachment;
    // ARCH #78: bubble audit-only degraded diagnostics onto the attachment
    // object so the lab-surface audit row can capture them. This is the only
    // path that surfaces diagnostics; the renderer-facing model_attachment
    // shape in buildSurfaceRecord intentionally does NOT include them.
    if (modelResult.diagnostics) {
      attachment = { ...attachment, degraded_diagnostics: modelResult.diagnostics };
    }
    // ARCH #81 Plan A: contract violation extracted text rides on the
    // attachment so lab-surface can quarantine it through the gate-failure
    // path. Audit-only by surface contract — buildSurfaceRecord's renderer-
    // facing model_attachment is not exposed back to the IPC response.
    if (typeof modelResult.raw_violation_text === 'string' && modelResult.raw_violation_text.length > 0) {
      attachment = {
        ...attachment,
        contract_violation_raw_text: modelResult.raw_violation_text,
        contract_violation_class: modelResult.violation_class || null,
      };
    }
  }
  // ARCH #97/#98/#100/#104: stash the classification on the attachment so
  // mira-lab-surface can lift it onto the audit row. Audit-only — renderer
  // never reads model_attachment.social_move.
  attachment = { ...attachment, social_move: socialMoveClassification };
  // ARCH #122/#129: also stash friction_state on the attachment (renderer-
  // memory only, audit-only at the surface boundary). Lab-surface lifts it
  // onto the audit row next to social_move. NEVER appears in transcript
  // visible rows, IPC JSON, requester_envelope, or visible_render_hint.
  if (socialMoveClassification && socialMoveClassification.friction_state) {
    attachment = { ...attachment, friction_state: socialMoveClassification.friction_state };
  }
  const reply = modelResult.ok === true ? modelResult.reply : null;
  const accepted = Boolean(reply);
  const fallbackUsed = false;
  const degraded = modelResult.ok !== true;
  const decision = degraded ? 'degraded' : (accepted ? 'accepted' : 'blocked');
  const reasons = accepted ? [] : (
    Array.isArray(sessionOutput.validation_report?.reasons)
      ? sessionOutput.validation_report.reasons
      : validation.errors || ['local_text_session_blocked']
  );
  const effectiveReasons = degraded
    ? [modelResult.reason || 'no_model_response']
    : reasons;
  const memoryCandidateStaging = accepted
    ? buildMiraMemoryCandidateStagingV1({
      threadContext: payload.threadContext || payload.thread_context || {},
      currentUserText: text,
      currentAssistantText: reply?.text || '',
    })
    : buildMiraMemoryCandidateStagingV1({});
  const memoryCandidatePersistence = accepted && Number(memoryCandidateStaging.candidate_count || 0) > 0
    ? persistMiraTentativeUnderstandingsV1(memoryCandidateStaging, {
      projectRoot,
      profileName: scope.profile || 'main',
      sessionId: scope.sessionId,
      generatedAt,
    })
    : null;
  const persistedMemoryCandidateStaging = withTentativeUnderstandingStore(
    memoryCandidateStaging,
    memoryCandidatePersistence
  );
  const developmentalUnderstanding = buildMiraDevelopmentalUnderstandingV1({
    memoryCandidateStaging: persistedMemoryCandidateStaging,
    currentUserText: text,
    currentAssistantText: reply?.text || '',
  });
  const autonomySubstrate = buildMiraAutonomySubstrateV0({
    projectRoot,
    inputSignals: {
      currentUserText: text,
      currentAssistantText: reply?.text || '',
      threadContext: payload.threadContext || payload.thread_context || {},
      evidenceRefs: [{
        store: 'mira-local-text-ui-surface',
        eventId: `typed-panel:${scope.sessionId}`,
        relation: 'current_turn_backend_autonomy_substrate',
      }],
    },
    executeReads: false,
    generatedAt,
  });
  const surface = buildSurfaceRecord({
    generatedAt,
    projectRoot,
    scope,
    sessionState,
    metadataPreflight,
    input: text,
    sessionOutput,
    validation,
    status: degraded ? 'model_unavailable' : (accepted ? 'reply_ready' : 'blocked_by_local_text_session'),
    decision,
    reasons: effectiveReasons,
    moduleCallCount: 1,
    reply,
    modelAttachment: attachment,
    modelCallCount: modelResult.modelCallCount || 0,
    networkCount: modelResult.networkCount || 0,
    fallbackUsed,
    fallbackReason: degraded ? (modelResult.reason || 'no_model_response') : null,
    threadContext: payload.threadContext || payload.thread_context || {},
    memoryCandidateStaging: persistedMemoryCandidateStaging,
    developmentalUnderstanding,
    autonomySubstrate,
  });
  return {
    ui_surface_v0: surface,
    validation_report: buildValidationReport(surface),
  };
}

function validateMiraLocalTextUiSurfaceOutput(output = {}) {
  const surface = output.ui_surface_v0 || {};
  const expected = buildValidationReport(surface);
  const report = output.validation_report || {};
  const checks = [
    {
      id: 'surface-required-fields',
      ok: Boolean(surface.schema)
        && Boolean(surface.surface_id)
        && Boolean(surface.scope)
        && Boolean(surface.local_text_session_gate)
        && Boolean(surface.checked_output_counters)
        && Boolean(surface.manual_enter_websocket_caveat),
    },
    ...expected.static_rule_results,
    {
      id: 'validation-report-consistent',
      ok: report.decision === expected.decision
        && report.status === expected.status
        && JSON.stringify(report.reasons || []) === JSON.stringify(expected.reasons || []),
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    ok: failed.length === 0,
    errors: failed.map((check) => check.id),
    checks,
  };
}

module.exports = {
  DEFAULT_SCOPE,
  LOCAL_TEXT_UI_CHANNEL,
  LOCAL_TEXT_UI_SURFACE_SCHEMA_VERSION,
  REQUIRED_UI_METADATA_FIELDS,
  buildBlockedSurface,
  buildMiraLocalTextUiSurface,
  loadDefaultContracts,
  uiBoundMetadataPreflight,
  validateMiraLocalTextUiSurfaceOutput,
};
