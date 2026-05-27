'use strict';

const fs = require('fs');
const path = require('path');

const {
  REQUIRED_BLOCKED_FLAGS,
  buildMiraPresenceRuntimeStateV0,
  readMiraPresenceRuntimeState,
} = require('./mira-presence-runtime-state-v0');
const {
  buildMiraProgressReport,
} = require('./mira-progress-v0');

const CURRENT_LANE_RELATIVE_PATH = path.join('.squidrun', 'handoffs', 'current-lane.json');
const PRESENCE_STATE_SOURCE_REF = path.join('.squidrun', 'state', 'mira-presence-runtime-state.json')
  .replace(/\\/g, '/');

function normalizeText(value, limit = 220) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function readJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = normalizeText(value, 220);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeCurrentLaneSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {
      present: false,
      status: 'missing',
      decision: 'current_lane_missing_or_invalid',
      active_lane_present: false,
      source_ref: null,
      objective: null,
      generated_at: null,
      stale_backlog_markers: [],
    };
  }
  const status = normalizeText(snapshot.status, 40).toLowerCase() || 'unknown';
  const activeLane = status === 'active' && snapshot.activeLane && typeof snapshot.activeLane === 'object'
    ? snapshot.activeLane
    : null;
  const continuity = snapshot.continuity && typeof snapshot.continuity === 'object'
    ? snapshot.continuity
    : {};
  return {
    present: true,
    status,
    decision: activeLane ? 'active_current_lane_loaded' : 'no_active_current_lane',
    active_lane_present: Boolean(activeLane),
    source_ref: activeLane ? normalizeText(activeLane.sourceRef, 80) || null : null,
    objective: activeLane ? normalizeText(activeLane.objective, 220) || null : null,
    generated_at: snapshot.generatedAt || snapshot.generated_at || null,
    stale_backlog_markers: (Array.isArray(continuity.stale_backlog_markers)
      ? continuity.stale_backlog_markers
      : []
    ).map((marker) => normalizeText(marker, 220)).filter(Boolean),
  };
}

function buildProgressSummary(progressReport = {}) {
  const head = progressReport.source_refs?.head || {};
  const proof = progressReport.source_refs?.progress_proof_inputs || {};
  return {
    percent: Number(progressReport.computed_total_percent || 0),
    status: normalizeText(progressReport.status, 40) || 'UNKNOWN',
    head_short_sha: normalizeText(head.short_sha, 40) || null,
    head_committed_at: head.committed_at || null,
    proof_source_ref: normalizeText(proof.source_ref, 160) || null,
    proof_status: normalizeText(proof.status, 40) || null,
    warnings: (Array.isArray(progressReport.warnings) ? progressReport.warnings : [])
      .map((warning) => normalizeText(warning, 160))
      .filter((warning) => warning && warning !== 'presence_state_predates_head'),
  };
}

function buildPresenceReadForRecord(record = {}) {
  return {
    present: true,
    decision: 'durable_state_loaded',
    state: record,
    summary: {
      active_mira_presence_lane: record.active_mira_presence_lane,
      accepted_critique: record.accepted_critique,
      next_product_action: record.next_product_action,
      proof_test_state: record.proof_test_state,
      stale_markers: Array.isArray(record.stale_markers) ? record.stale_markers.slice() : [],
    },
    blocked_status: record.blocked_status || null,
    agency_level: record.agency_level || null,
    interruption_marker: record.interruption_marker || null,
  };
}

function buildMiraPresenceCurrentScopeStateV0(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const currentRead = options.presenceRead && typeof options.presenceRead === 'object'
    ? options.presenceRead
    : readMiraPresenceRuntimeState({ projectRoot });
  if (currentRead.present !== true || !currentRead.state) {
    return {
      ok: false,
      decision: 'blocked_missing_durable_presence_state',
      written: false,
      source_refs: { presence_runtime_state: PRESENCE_STATE_SOURCE_REF },
    };
  }

  const blockedStatus = currentRead.state.blocked_status || {};
  const missingBlocked = REQUIRED_BLOCKED_FLAGS.filter((flag) => blockedStatus[flag] !== true);
  if (missingBlocked.length > 0) {
    return {
      ok: false,
      decision: 'blocked_presence_state_missing_required_blockers',
      reasons: missingBlocked.map((flag) => `blocked_status_must_be_true:${flag}`),
      written: false,
      source_refs: { presence_runtime_state: PRESENCE_STATE_SOURCE_REF },
    };
  }

  const currentLanePath = path.join(projectRoot, CURRENT_LANE_RELATIVE_PATH);
  const currentLane = normalizeCurrentLaneSnapshot(
    options.currentLaneSnapshot || readJson(currentLanePath)
  );
  const progressReport = options.progressReport && typeof options.progressReport === 'object'
    ? options.progressReport
    : buildMiraProgressReport({
      projectRoot,
      progressProofPath: options.progressProofPath,
      worktreeState: options.worktreeState,
      head: options.head,
    });
  const progress = buildProgressSummary(progressReport);
  const headText = progress.head_short_sha ? ` at HEAD ${progress.head_short_sha}` : '';
  const currentLaneText = currentLane.active_lane_present
    ? `active current lane ${currentLane.source_ref || 'unknown'}: ${currentLane.objective || 'unspecified'}`
    : `current lane status ${currentLane.status || 'none'}`;

  const staleMarkers = uniqueStrings([
    currentLane.active_lane_present
      ? `current_lane_active:${currentLane.source_ref || 'unknown'}`
      : `current_lane_status:${currentLane.status || 'none'}:no_active_lane`,
    'parked/prototype/archive scaffolds excluded from current-scope authority',
    'voice_transport_blocked_until_contract_tests_pass',
    'a3_a4_arm_authority_blocked',
    ...currentLane.stale_backlog_markers,
    ...progress.warnings.map((warning) => `progress_warning:${warning}`),
  ]);

  const state = {
    active_mira_presence_lane: currentRead.state.active_mira_presence_lane,
    accepted_critique: currentRead.state.accepted_critique,
    next_product_action: `restart/current-scope continuity: surface ${currentLaneText}, computed progress ${progress.percent}% ${progress.status}${headText}, and keep parked/prototype/archive evidence out of route authority.`,
    proof_test_state: `current-scope proof path: progress ${progress.percent}% ${progress.status}${headText}; current_lane ${currentLane.status}; proof artifact ${progress.proof_status || 'unknown'} from ${progress.proof_source_ref || 'missing'}.`,
    stale_markers: staleMarkers,
    blocked_status: {
      live_voice_blocked: true,
      always_on_mic_blocked: true,
      pc_embodiment_blocked: true,
      a3_a4_blocked: true,
    },
    interruption_marker: currentRead.state.interruption_marker || 'none',
    agency_level: currentRead.state.agency_level || 'A0',
  };

  return {
    ok: true,
    decision: 'current_scope_presence_state_built',
    written: false,
    state,
    current_lane: currentLane,
    computed_progress: progress,
    source_refs: {
      presence_runtime_state: PRESENCE_STATE_SOURCE_REF,
      current_lane: CURRENT_LANE_RELATIVE_PATH.replace(/\\/g, '/'),
      progress_proof_inputs: progress.proof_source_ref,
      head: progress.head_short_sha ? `HEAD:${progress.head_short_sha}` : null,
    },
  };
}

function refreshMiraPresenceCurrentScopeStateV0(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const nowIso = options.nowIso || new Date().toISOString();
  const preview = buildMiraPresenceCurrentScopeStateV0({ ...options, projectRoot });
  if (preview.ok !== true) return preview;
  let finalPreview = preview;
  if (!options.progressReport) {
    const dryRecord = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: false,
      nowIso,
      state: preview.state,
    });
    const anticipatedRecord = dryRecord.preview || preview.state;
    const anticipatedProgressReport = buildMiraProgressReport({
      projectRoot,
      progressProofPath: options.progressProofPath,
      worktreeState: options.worktreeState,
      head: options.head,
      presenceRead: buildPresenceReadForRecord(anticipatedRecord),
    });
    finalPreview = buildMiraPresenceCurrentScopeStateV0({
      ...options,
      projectRoot,
      progressReport: anticipatedProgressReport,
    });
    if (finalPreview.ok !== true) return finalPreview;
  }
  const write = buildMiraPresenceRuntimeStateV0({
    projectRoot,
    apply: options.apply === true,
    nowIso,
    state: finalPreview.state,
  });
  return {
    ...finalPreview,
    mode: options.apply === true ? 'apply' : 'dry_run',
    decision: options.apply === true ? write.decision : 'preview_current_scope_presence_state',
    written: write.written === true,
    target_path: write.target_path,
    record: write.record || null,
    preview: write.preview || finalPreview.state,
  };
}

module.exports = {
  CURRENT_LANE_RELATIVE_PATH,
  buildMiraPresenceCurrentScopeStateV0,
  normalizeCurrentLaneSnapshot,
  refreshMiraPresenceCurrentScopeStateV0,
};
