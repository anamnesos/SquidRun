'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'squidrun.mira_core.typed_restart_continuity_context_v0';
const VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_CHARS = 240;
const MAX_STALE_MARKERS = 4;

const CURRENT_LANE_RELATIVE_PATH = path.join('.squidrun', 'handoffs', 'current-lane.json');
const PRESENCE_STATE_RELATIVE_PATH = path.join('.squidrun', 'state', 'mira-presence-runtime-state.json');
const PRESENCE_SUMMARY_RELATIVE_PATH = path.join('.squidrun', 'handoffs', 'mira-presence-runtime-state-summary.json');

const SOURCE_KINDS = Object.freeze({
  currentLane: 'current_lane_json',
  presenceState: 'mira_presence_runtime_state_json',
  presenceSummary: 'mira_presence_runtime_summary_json',
});

function trimText(value, limit = MAX_TEXT_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 3)).trimEnd() + '...';
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function getMetadataValue(metadata = {}, camelKey, snakeKey = null) {
  if (hasOwn(metadata, camelKey)) return metadata[camelKey];
  if (snakeKey && hasOwn(metadata, snakeKey)) return metadata[snakeKey];
  return undefined;
}

function normalizeMain(value) {
  return trimText(value, 80).toLowerCase();
}

function sessionSuffixStatus(value, { optional = false } = {}) {
  const text = trimText(value, 160).toLowerCase();
  if (!text) {
    return optional
      ? { ok: true, base: '', suffix: null, missing: false }
      : { ok: false, reason: 'missing_session_id', missing: true };
  }
  const parts = text.split(':');
  if (parts.length > 2 || parts.some((part) => part.trim() === '')) {
    return { ok: false, reason: 'ambiguous_session_scope', missing: false };
  }
  const base = parts[0].trim();
  const suffix = parts.length === 2 ? parts[1].trim() : null;
  if (!/^app-session(?:[-_a-z0-9]+)?$/.test(base)) {
    return { ok: false, reason: 'invalid_session_id', missing: false };
  }
  if (suffix && suffix !== 'main') {
    return { ok: false, reason: 'non_main_session_suffix', suffix, missing: false };
  }
  return { ok: true, base, suffix, missing: false };
}

function evaluateScope(metadata = {}) {
  const profileName = normalizeMain(getMetadataValue(metadata, 'profileName', 'profile_name'));
  const windowKey = normalizeMain(getMetadataValue(metadata, 'windowKey', 'window_key'));
  const sourceScope = normalizeMain(getMetadataValue(metadata, 'sourceScope', 'source_scope'));
  const deviceId = trimText(getMetadataValue(metadata, 'deviceId', 'device_id'), 80);
  const activeState = normalizeMain(getMetadataValue(metadata, 'activeState', 'active_state'));
  const visibleIndicatorPresent = getMetadataValue(metadata, 'visibleIndicatorPresent', 'visible_indicator_present');
  const sessionId = getMetadataValue(metadata, 'sessionId', 'session_id');
  const sessionScopeId = getMetadataValue(metadata, 'sessionScopeId', 'session_scope_id');

  const missing = [];
  const invalid = [];
  if (!profileName) missing.push('profileName');
  if (!windowKey) missing.push('windowKey');
  if (!sourceScope) missing.push('sourceScope');
  if (!deviceId) missing.push('deviceId');
  if (!activeState) missing.push('activeState');
  if (visibleIndicatorPresent === undefined) missing.push('visibleIndicatorPresent');
  if (sessionId === undefined || trimText(sessionId, 160) === '') missing.push('sessionId');

  if (profileName && profileName !== 'main') invalid.push('profileName_not_main');
  if (windowKey && windowKey !== 'main') invalid.push('windowKey_not_main');
  if (sourceScope && sourceScope !== 'main') invalid.push('sourceScope_not_main');
  if (deviceId && deviceId !== 'VIGIL') invalid.push('deviceId_not_VIGIL');
  if (activeState && activeState !== 'open') invalid.push('activeState_not_open');
  if (visibleIndicatorPresent !== undefined && visibleIndicatorPresent !== true) {
    invalid.push('visibleIndicatorPresent_not_true');
  }

  const session = sessionSuffixStatus(sessionId);
  if (!session.ok) invalid.push(session.reason);
  const scopedSession = sessionSuffixStatus(sessionScopeId, { optional: true });
  if (!scopedSession.ok) invalid.push(`sessionScopeId_${scopedSession.reason}`);

  return {
    ok: missing.length === 0 && invalid.length === 0,
    decision: missing.length > 0
      ? 'absent_missing_or_ambiguous_scope'
      : (invalid.length > 0 ? 'absent_non_main_or_inactive_scope' : 'scope_ready'),
    missing,
    invalid,
    scope: {
      profileName,
      windowKey,
      sourceScope,
      deviceId,
      activeState,
      visibleIndicatorPresent: visibleIndicatorPresent === true,
      sessionId: session.ok ? session.base : null,
      sessionSuffix: session.ok ? session.suffix : null,
      sessionScopeId: scopedSession.ok && scopedSession.base ? scopedSession.base : null,
      sessionScopeSuffix: scopedSession.ok ? scopedSession.suffix : null,
    },
  };
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, decision: 'missing' };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, decision: 'invalid_shape' };
    }
    return { ok: true, parsed };
  } catch (_) {
    return { ok: false, decision: 'invalid_json' };
  }
}

function resolveProjectPath(projectRoot, relativePath) {
  const root = path.resolve(String(projectRoot || process.cwd()));
  return path.join(root, relativePath);
}

function sourceAge(generatedAt, nowMs, staleAfterMs) {
  const generatedAtMs = Date.parse(String(generatedAt || ''));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const maxAge = Number.isFinite(Number(staleAfterMs)) ? Math.max(1, Number(staleAfterMs)) : DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(generatedAtMs)) {
    return { generated_at: null, age_ms: null, stale: true, stale_reason: 'missing_generated_at' };
  }
  const ageMs = Math.max(0, Math.floor(now - generatedAtMs));
  return {
    generated_at: new Date(generatedAtMs).toISOString(),
    age_ms: ageMs,
    stale: ageMs > maxAge,
    stale_reason: ageMs > maxAge ? 'older_than_max_age' : null,
  };
}

function normalizeRole(value) {
  const role = trimText(value, 40).toLowerCase();
  return ['architect', 'builder', 'oracle', 'james', 'mira'].includes(role) ? role : (role || null);
}

function projectCurrentLane(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { present: false, decision: 'missing_or_invalid_current_lane' };
  }
  const sessionGuard = sessionSuffixStatus(snapshot.sessionId, { optional: true });
  if (!sessionGuard.ok) {
    return { present: false, decision: sessionGuard.reason };
  }
  if (trimText(snapshot.status, 40).toLowerCase() !== 'active') {
    return { present: false, decision: 'current_lane_not_active' };
  }
  const lane = snapshot.activeLane;
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    return { present: false, decision: 'missing_active_lane' };
  }
  const objective = trimText(lane.objective);
  if (!objective) return { present: false, decision: 'missing_active_lane_objective' };
  const age = sourceAge(snapshot.generatedAt || snapshot.generated_at, options.nowMs, options.staleAfterMs);
  const timestampMs = Number(lane.sourceTimestampMs);
  return {
    present: true,
    decision: age.stale ? 'current_lane_stale' : 'current_lane_ready',
    source_kind: SOURCE_KINDS.currentLane,
    stale: age.stale,
    stale_reason: age.stale_reason,
    generated_at: age.generated_at,
    age_ms: age.age_ms,
    current_lane: {
      session_id: sessionGuard.ok && sessionGuard.base ? sessionGuard.base : null,
      lane_id: trimText(lane.laneId, 160) || null,
      objective,
      kind: trimText(lane.kind, 80) || null,
      status: trimText(lane.status, 40) || null,
      source_message_id: trimText(lane.sourceMessageId, 120) || null,
      source_ref: trimText(lane.sourceRef, 80) || null,
      source_timestamp_iso: Number.isFinite(timestampMs) && timestampMs > 0
        ? new Date(timestampMs).toISOString()
        : null,
      sender_role: normalizeRole(lane.senderRole),
      target_role: normalizeRole(lane.targetRole),
    },
  };
}

function normalizeStaleMarkers(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => trimText(item, 180))
    .filter(Boolean)
    .slice(0, MAX_STALE_MARKERS);
}

function projectPresenceSummary(rawSummary, sourceKind, generatedAt, options = {}) {
  if (!rawSummary || typeof rawSummary !== 'object' || Array.isArray(rawSummary)) {
    return { present: false, decision: 'missing_or_invalid_presence_runtime' };
  }
  const activeLane = trimText(rawSummary.active_mira_presence_lane);
  const nextAction = trimText(rawSummary.next_product_action);
  if (!activeLane && !nextAction) {
    return { present: false, decision: 'missing_presence_runtime_summary_fields' };
  }
  const age = sourceAge(generatedAt, options.nowMs, options.staleAfterMs);
  return {
    present: true,
    decision: age.stale ? 'presence_runtime_stale' : 'presence_runtime_ready',
    source_kind: sourceKind,
    stale: age.stale,
    stale_reason: age.stale_reason,
    generated_at: age.generated_at,
    age_ms: age.age_ms,
    summary: {
      active_mira_presence_lane: activeLane || null,
      accepted_critique: trimText(rawSummary.accepted_critique) || null,
      next_product_action: nextAction || null,
      proof_test_state: trimText(rawSummary.proof_test_state) || null,
      stale_markers: normalizeStaleMarkers(rawSummary.stale_markers),
    },
  };
}

function readPresenceRuntimeSource(projectRoot, options = {}) {
  const summaryPath = resolveProjectPath(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH);
  const summaryRead = safeReadJson(summaryPath);
  if (summaryRead.ok) {
    const parsed = summaryRead.parsed;
    const context = parsed.context && typeof parsed.context === 'object' ? parsed.context : {};
    if (
      parsed.surface === 'backstage_internal_only'
      && parsed.visible_injection_allowed === false
      && context.present === true
      && context.surface === 'backstage_internal_only'
      && context.visible_injection_allowed === false
    ) {
      const projected = projectPresenceSummary(
        context.summary,
        SOURCE_KINDS.presenceSummary,
        parsed.generated_at || parsed.generatedAt,
        options
      );
      if (projected.present) return projected;
    }
  }

  const statePath = resolveProjectPath(projectRoot, PRESENCE_STATE_RELATIVE_PATH);
  const stateRead = safeReadJson(statePath);
  if (!stateRead.ok) {
    return { present: false, decision: 'presence_runtime_missing' };
  }
  const parsed = stateRead.parsed;
  if (parsed.surface !== 'backstage_internal_only') {
    return { present: false, decision: 'presence_runtime_wrong_surface' };
  }
  return projectPresenceSummary(
    parsed,
    SOURCE_KINDS.presenceState,
    parsed.generated_at || parsed.generatedAt,
    options
  );
}

function absentContext(decision, scopeGate = null, extra = {}) {
  return {
    schema: SCHEMA_VERSION,
    version: VERSION,
    present: false,
    decision,
    read_only: true,
    visible_injection_allowed: false,
    boundary: {
      structured_sources_only: true,
      no_startup_prose: true,
      no_recent_comms: true,
      no_whole_snapshots: true,
      no_writes: true,
    },
    scope_gate: scopeGate,
    current_lane: null,
    mira_presence_runtime: null,
    stale: false,
    ...extra,
  };
}

function buildTypedRestartContinuityContextV0(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const scopeGate = evaluateScope(options.metadata || {});
  if (!scopeGate.ok) {
    return absentContext(scopeGate.decision, scopeGate);
  }

  const currentLanePath = resolveProjectPath(projectRoot, CURRENT_LANE_RELATIVE_PATH);
  const currentLaneRead = safeReadJson(currentLanePath);
  const currentLane = currentLaneRead.ok
    ? projectCurrentLane(currentLaneRead.parsed, options)
    : { present: false, decision: 'current_lane_missing' };
  const presenceRuntime = readPresenceRuntimeSource(projectRoot, options);

  if (!currentLane.present && !presenceRuntime.present) {
    return absentContext('absent_no_structured_restart_context', scopeGate, {
      source_status: {
        current_lane: { present: false, decision: currentLane.decision, source_kind: SOURCE_KINDS.currentLane },
        mira_presence_runtime: { present: false, decision: presenceRuntime.decision },
      },
    });
  }

  const stale = Boolean(currentLane.present && currentLane.stale)
    || Boolean(presenceRuntime.present && presenceRuntime.stale);
  return {
    schema: SCHEMA_VERSION,
    version: VERSION,
    present: true,
    decision: stale ? 'structured_restart_context_stale' : 'structured_restart_context_ready',
    read_only: true,
    visible_injection_allowed: false,
    boundary: {
      structured_sources_only: true,
      no_startup_prose: true,
      no_recent_comms: true,
      no_whole_snapshots: true,
      no_writes: true,
    },
    scope_gate: scopeGate,
    source_status: {
      current_lane: {
        present: currentLane.present === true,
        decision: currentLane.decision,
        source_kind: SOURCE_KINDS.currentLane,
        stale: currentLane.present === true ? currentLane.stale === true : null,
      },
      mira_presence_runtime: {
        present: presenceRuntime.present === true,
        decision: presenceRuntime.decision,
        source_kind: presenceRuntime.source_kind || null,
        stale: presenceRuntime.present === true ? presenceRuntime.stale === true : null,
      },
    },
    current_lane: currentLane.present ? currentLane.current_lane : null,
    mira_presence_runtime: presenceRuntime.present ? presenceRuntime.summary : null,
    stale,
    stale_sources: [
      currentLane.present && currentLane.stale ? 'current_lane' : null,
      presenceRuntime.present && presenceRuntime.stale ? 'mira_presence_runtime' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  SCHEMA_VERSION,
  VERSION,
  DEFAULT_STALE_AFTER_MS,
  CURRENT_LANE_RELATIVE_PATH,
  PRESENCE_STATE_RELATIVE_PATH,
  PRESENCE_SUMMARY_RELATIVE_PATH,
  SOURCE_KINDS,
  buildTypedRestartContinuityContextV0,
  evaluateScope,
  projectCurrentLane,
  projectPresenceSummary,
};
