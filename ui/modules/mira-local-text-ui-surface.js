'use strict';

const path = require('path');

const {
  buildMiraCoreLocalTextSessionV0,
  stableHash,
  validateMiraCoreLocalTextSessionV0Output,
} = require('./mira-core/local-text-session-v0');

const LOCAL_TEXT_UI_CHANNEL = 'mira:local-text-session';
const LOCAL_TEXT_UI_SURFACE_SCHEMA_VERSION = 'squidrun.mira.local_text_ui_surface_v0.phase75.v0';
const LOCAL_TEXT_UI_SURFACE_VERSION = 1;
const DEFAULT_SESSION_ID = 'app-session-ui-local-text';
const DEFAULT_SCOPE = Object.freeze({
  profileName: 'main',
  windowKey: 'main',
  sourceScope: 'main',
  deviceId: 'VIGIL',
});

const ZERO_SIDE_EFFECT_COUNTERS = Object.freeze({
  runtime_authorized: false,
  write_count: 0,
  external_send_count: 0,
  tool_call_count: 0,
  action_count: 0,
  model_call_count: 0,
  network_count: 0,
  growth_write_count: 0,
  transcript_write_count: 0,
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

function normalizeScope(payload = {}) {
  const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
  const profileName = normalizeString(payload.profileName || profile.name, DEFAULT_SCOPE.profileName);
  const windowKey = normalizeString(payload.windowKey || profile.windowKey, DEFAULT_SCOPE.windowKey);
  const sourceScope = normalizeString(payload.sourceScope || payload.source_scope, DEFAULT_SCOPE.sourceScope);
  const deviceId = normalizeString(payload.deviceId || payload.device, DEFAULT_SCOPE.deviceId);
  const sessionId = normalizeString(payload.sessionId || payload.session || profile.sessionScopeId, DEFAULT_SESSION_ID);
  const mainScope = profileName === 'main'
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

function normalizeSessionState(payload = {}, generatedAt) {
  return {
    active_state: normalizeString(payload.activeState || payload.active_state, 'open'),
    visible_indicator_required: true,
    visible_indicator_present: payload.visibleIndicatorPresent !== false
      && payload.visible_indicator_present !== false,
    started_at: normalizeString(payload.startedAt || payload.started_at, generatedAt),
    expires_at: normalizeString(
      payload.expiresAt || payload.expires_at,
      new Date(Date.parse(generatedAt) + 15 * 60 * 1000).toISOString(),
    ),
    revoked_at: payload.revokedAt || payload.revoked_at || null,
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
  return {
    ...clone(ZERO_SIDE_EFFECT_COUNTERS),
    module_call_count: Number(moduleCallCount || 0),
    reply_count: Number(replyCount || 0),
    duplicate_submit_block_count: Number(extra.duplicate_submit_block_count || 0),
    blocked_submit_count: Number(extra.blocked_submit_count || 0),
  };
}

function buildSurfaceRecord({
  generatedAt,
  projectRoot,
  scope,
  sessionState,
  input,
  sessionOutput = null,
  validation = null,
  status,
  decision,
  reasons = [],
  moduleCallCount,
  reply = null,
}) {
  const replyCount = reply ? 1 : 0;
  const record = {
    schema: LOCAL_TEXT_UI_SURFACE_SCHEMA_VERSION,
    version: LOCAL_TEXT_UI_SURFACE_VERSION,
    phase: 75,
    mode: 'local_text_ui_surface_v0',
    generated_at: generatedAt,
    project_path: projectRoot,
    scope,
    session_state: sessionState,
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
      source: 'local_text_session_v0',
    } : {
      count: 0,
      text: null,
      reply_id: null,
      source: 'none',
    },
    checked_output_counters: buildCounters(moduleCallCount, replyCount, {
      blocked_submit_count: decision === 'blocked' ? 1 : 0,
    }),
    manual_enter_websocket_caveat: buildManualEnterWebsocketCaveat(),
    boundary: {
      ui_surface_only: true,
      no_model: true,
      no_tools: true,
      no_actions: true,
      no_writes: true,
      no_growth: true,
      no_transcript_persistence: true,
      no_network: true,
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
  const checks = [
    {
      id: 'explicit-vigil-main-scope',
      ok: surface.scope?.explicit_vigil_main_scope === true
        && surface.scope?.profile === 'main'
        && surface.scope?.windowKey === 'main'
        && surface.scope?.source_scope === 'main'
        && surface.scope?.deviceId === 'VIGIL',
    },
    {
      id: 'visible-active-state',
      ok: surface.visible_active_state?.required === true
        && surface.visible_active_state?.present === true,
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
        ),
    },
    {
      id: 'blocked-result-has-no-fabricated-reply',
      ok: surface.decision !== 'blocked'
        || (
          Number(surface.reply?.count) === 0
          && surface.reply?.text === null
          && surface.reply?.source === 'none'
        ),
    },
    {
      id: 'no-external-effects',
      ok: surface.boundary?.no_model === true
        && surface.boundary?.no_tools === true
        && surface.boundary?.no_actions === true
        && surface.boundary?.no_writes === true
        && surface.boundary?.no_growth === true
        && surface.boundary?.no_transcript_persistence === true
        && surface.boundary?.no_network === true
        && surface.boundary?.runtime_authorized === false
        && Number(surface.checked_output_counters?.write_count) === 0
        && Number(surface.checked_output_counters?.external_send_count) === 0
        && Number(surface.checked_output_counters?.tool_call_count) === 0
        && Number(surface.checked_output_counters?.model_call_count) === 0
        && Number(surface.checked_output_counters?.network_count) === 0,
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
      : 'blocked',
    status: failed.length === 0 && surface.decision === 'accepted'
      ? 'local_text_ui_reply_ready'
      : 'local_text_ui_blocked',
    reasons: [...new Set([...(surface.reasons || []), ...failed.map((check) => check.id)])],
    static_rule_results: checks,
    side_effect_truth: clone(surface.checked_output_counters || {}),
  };
}

function buildBlockedSurface(reason, payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const scope = normalizeScope(payload);
  const sessionState = normalizeSessionState(payload, generatedAt);
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const surface = buildSurfaceRecord({
    generatedAt,
    projectRoot,
    scope,
    sessionState,
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

function buildMiraLocalTextUiSurface(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const scope = normalizeScope(payload);
  const text = localTextFromPayload(payload);
  const sessionState = normalizeSessionState(payload, generatedAt);
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());

  if (text.trim().length === 0) {
    return buildBlockedSurface('blocked_empty_input', payload, options);
  }
  if (scope.explicit_vigil_main_scope !== true) {
    return buildBlockedSurface('blocked_non_main_scope', payload, options);
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
  const reply = validation.ok === true && session.mira_reply?.count === 1
    ? session.mira_reply
    : null;
  const accepted = Boolean(reply);
  const reasons = accepted ? [] : (
    Array.isArray(sessionOutput.validation_report?.reasons)
      ? sessionOutput.validation_report.reasons
      : validation.errors || ['local_text_session_blocked']
  );
  const surface = buildSurfaceRecord({
    generatedAt,
    projectRoot,
    scope,
    sessionState,
    input: text,
    sessionOutput,
    validation,
    status: accepted ? 'reply_ready' : 'blocked_by_local_text_session',
    decision: accepted ? 'accepted' : 'blocked',
    reasons,
    moduleCallCount: 1,
    reply,
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
  buildBlockedSurface,
  buildMiraLocalTextUiSurface,
  loadDefaultContracts,
  validateMiraLocalTextUiSurfaceOutput,
};
