'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');
const {
  ACTIVE_STATES,
  buildActiveWorkReconciliation,
  listWorkItems,
  resolveIndexPath,
  resolveItemPath,
  writeJsonAtomic,
} = require('./work-item-ledger');
const {
  collectWakeCandidates,
  readQueue,
} = require('../../scripts/hm-task-queue');

const SCHEMA = 'squidrun.restart_continuity_resume_manifest.v0';
const STARTUP_BLOCK_SCHEMA = 'squidrun.startup_ai_briefing.restart_continuity_resume.v0';
const VERSION = 1;
const DEFAULT_ARTIFACT_RELATIVE_PATH = path.join('handoffs', 'restart-continuity-resume.json');
const DEFAULT_CURRENT_LANE_RELATIVE_PATH = path.join('handoffs', 'current-lane.json');
const DEFAULT_TASK_QUEUE_RELATIVE_PATH = path.join('runtime', 'agent-task-queue.json');
const DEFAULT_APP_STATUS_RELATIVE_PATH = 'app-status.json';
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const AGENTS = ['architect', 'builder', 'oracle'];

function toText(value, fallback = '') {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function trimText(value, limit = 240) {
  const text = toText(value);
  if (!text || text.length <= limit) return text || null;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function toIso(value, fallbackMs = Date.now()) {
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const text = toText(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function toTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeToken(value, fallback = null) {
  const text = toText(value);
  if (!text) return fallback;
  const normalized = text.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeAgent(value) {
  const role = normalizeToken(value, null);
  return AGENTS.includes(role) ? role : null;
}

function uniqueStrings(values = []) {
  const out = [];
  const input = Array.isArray(values) ? values : [values];
  for (const value of input) {
    const text = toText(value);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
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

function resolveProjectRoot(options = {}) {
  return path.resolve(String(options.projectRoot || getProjectRoot?.() || process.cwd()));
}

function resolveCoordFile(relativePath, options = {}) {
  if (options[`${relativePath}Path`]) return path.resolve(String(options[`${relativePath}Path`]));
  if (typeof resolveCoordPath === 'function') return resolveCoordPath(relativePath, { forWrite: true });
  return path.join(resolveProjectRoot(options), '.squidrun', relativePath);
}

function resolveManifestPath(options = {}) {
  if (options.restartContinuityResumePath) return path.resolve(String(options.restartContinuityResumePath));
  return resolveCoordFile(DEFAULT_ARTIFACT_RELATIVE_PATH, options);
}

function resolveCurrentLanePath(options = {}) {
  if (options.currentLanePath) return path.resolve(String(options.currentLanePath));
  return resolveCoordFile(DEFAULT_CURRENT_LANE_RELATIVE_PATH, options);
}

function resolveTaskQueuePath(options = {}) {
  if (options.queuePath) return path.resolve(String(options.queuePath));
  return resolveCoordFile(DEFAULT_TASK_QUEUE_RELATIVE_PATH, options);
}

function resolveAppStatusPath(options = {}) {
  if (options.appStatusPath) return path.resolve(String(options.appStatusPath));
  return resolveCoordFile(DEFAULT_APP_STATUS_RELATIVE_PATH, options);
}

function relativeSourceRef(filePath, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const relative = path.relative(projectRoot, path.resolve(String(filePath || '')));
  const normalized = relative.replace(/\\/g, '/');
  if (!normalized.startsWith('..') && normalized !== '') return normalized;
  return String(filePath || '').replace(/\\/g, '/');
}

function hashFile(filePath, options = {}) {
  const ref = relativeSourceRef(filePath, options);
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        source_ref: ref,
        present: false,
        sha256: null,
        bytes: 0,
        mtime_ms: null,
      };
    }
    const bytes = fs.readFileSync(filePath);
    const stat = fs.statSync(filePath);
    return {
      source_ref: ref,
      present: true,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.length,
      mtime_ms: Math.floor(stat.mtimeMs),
    };
  } catch (err) {
    return {
      source_ref: ref,
      present: false,
      sha256: null,
      bytes: 0,
      mtime_ms: null,
      error: err?.message || String(err || 'hash_failed'),
    };
  }
}

function resolveNowMs(options = {}) {
  const numeric = Number(options.nowMs || options.now);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(options.now || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function getGitHead(options = {}) {
  const supplied = options.head || options.gitHead || options.currentLaneSnapshot?.head;
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
    const shortSha = trimText(supplied.short_sha || supplied.shortSha || supplied.sha, 80);
    const committedAt = toText(supplied.committed_at || supplied.committedAt, null);
    const subject = trimText(supplied.subject, 180);
    const hasMetadata = Boolean(shortSha || committedAt || subject);
    const present = supplied.present === false ? false : (supplied.present === true || hasMetadata);
    return {
      source_kind: toText(supplied.source_kind || supplied.sourceKind, 'git_head'),
      present,
      short_sha: shortSha,
      committed_at: committedAt,
      subject,
      stale_reason: present ? null : (supplied.stale_reason || supplied.staleReason || 'head_metadata_not_supplied'),
    };
  }
  return {
    source_kind: 'git_head',
    present: false,
    short_sha: null,
    committed_at: null,
    subject: null,
    stale_reason: 'head_metadata_not_supplied',
  };
}

function sessionSuffix(value) {
  const text = toText(value).toLowerCase();
  if (!text) return null;
  const colon = text.match(/^app-session-\d+:([a-z0-9_.-]+)$/);
  if (colon) return colon[1] || null;
  const hyphen = text.match(/^app-session-\d+-([a-z][a-z0-9_.-]*)$/);
  if (hyphen) return hyphen[1] || null;
  return null;
}

function normalizeAppSessionId(value) {
  const text = toText(value);
  if (!text) return null;
  const numeric = text.match(/^\d+$/);
  if (numeric) return `app-session-${Number.parseInt(text, 10)}`;
  const prefixedNumber = text.match(/^app-session-(\d+)$/i);
  if (prefixedNumber) return `app-session-${Number.parseInt(prefixedNumber[1], 10)}`;
  return text;
}

function normalizeMainScope(value, fallback = 'main') {
  return normalizeToken(value, fallback) || fallback;
}

function readSessionId(options = {}) {
  const explicit = normalizeAppSessionId(options.sessionId || options.currentSessionId || options.sessionScopeId);
  if (explicit) return explicit;
  const appStatus = readJson(resolveAppStatusPath(options));
  return normalizeAppSessionId(
    appStatus?.session_id
    || appStatus?.sessionId
    || appStatus?.session
    || (appStatus?.sessionNumber ? `app-session-${appStatus.sessionNumber}` : ''),
    null
  );
}

function evaluateScope(options = {}) {
  const profileName = normalizeMainScope(options.profileName || options.profile, 'main');
  const windowKey = normalizeMainScope(options.windowKey || options.window || profileName, profileName);
  const sourceScope = normalizeMainScope(options.sourceScope || options.scope || profileName, profileName);
  const sessionId = readSessionId(options);
  const sessionScopeId = toText(options.sessionScopeId || sessionId, null);
  const suffix = sessionSuffix(sessionScopeId || sessionId);
  const invalid = [];
  if (profileName !== 'main') invalid.push('profile_not_main');
  if (windowKey !== 'main') invalid.push('window_not_main');
  if (sourceScope !== 'main') invalid.push('source_scope_not_main');
  if (suffix && suffix !== 'main') invalid.push('session_scope_not_main');
  return {
    ok: invalid.length === 0,
    decision: invalid.length === 0 ? 'main_scope_ready' : 'non_main_scope_rejected',
    profileName,
    windowKey,
    sourceScope,
    sessionId,
    sessionScopeId,
    sessionScopeSuffix: suffix,
    invalid,
  };
}

function sourceFreshness(sourceId, generatedAt, nowMs, staleAfterMs) {
  const generatedAtMs = toTimestampMs(generatedAt);
  if (!generatedAtMs) {
    return {
      source_id: sourceId,
      generated_at: null,
      age_ms: null,
      stale: true,
      stale_reason: 'missing_generated_at',
    };
  }
  const ageMs = Math.max(0, Math.floor(nowMs - generatedAtMs));
  return {
    source_id: sourceId,
    generated_at: new Date(generatedAtMs).toISOString(),
    age_ms: ageMs,
    stale: ageMs > staleAfterMs,
    stale_reason: ageMs > staleAfterMs ? 'older_than_stale_after_ms' : null,
  };
}

function snapshotScopeKey(snapshot = {}) {
  const lane = snapshot?.activeLane && typeof snapshot.activeLane === 'object' ? snapshot.activeLane : {};
  const profile = normalizeMainScope(snapshot.profileName || snapshot.profile || lane.profileName || lane.profile, 'main');
  const windowKey = normalizeMainScope(snapshot.windowKey || snapshot.window || lane.windowKey || lane.window, profile);
  const suffix = sessionSuffix(snapshot.sessionScopeId || snapshot.sessionId || lane.sessionScopeId || lane.sessionId);
  if (profile !== 'main') return profile;
  if (windowKey !== 'main') return windowKey;
  if (suffix && suffix !== 'main') return suffix;
  return 'main';
}

function readCurrentLane(options = {}) {
  const currentLanePath = resolveCurrentLanePath(options);
  const snapshot = options.currentLaneSnapshot && typeof options.currentLaneSnapshot === 'object'
    ? options.currentLaneSnapshot
    : readJson(currentLanePath);
  if (!snapshot) {
    return {
      path: currentLanePath,
      snapshot: null,
      rejected: false,
      decision: 'current_lane_missing',
    };
  }
  const scope = snapshotScopeKey(snapshot);
  if (scope !== 'main') {
    return {
      path: currentLanePath,
      snapshot: null,
      rejected: true,
      rejectedScope: scope,
      decision: 'current_lane_non_main_scope_rejected',
    };
  }
  const expectedSessionId = normalizeAppSessionId(options.sessionId || options.currentSessionId || options.sessionScopeId);
  const snapshotSessionId = normalizeAppSessionId(snapshot.sessionId || snapshot.session_id);
  if (expectedSessionId && !snapshotSessionId) {
    return {
      path: currentLanePath,
      snapshot: null,
      rejected: true,
      rejectedScope: 'missing_session',
      decision: 'current_lane_session_missing_rejected',
    };
  }
  if (expectedSessionId && snapshotSessionId !== expectedSessionId) {
    return {
      path: currentLanePath,
      snapshot: null,
      rejected: true,
      rejectedScope: snapshotSessionId,
      decision: 'current_lane_session_mismatch_rejected',
    };
  }
  return {
    path: currentLanePath,
    snapshot,
    rejected: false,
    decision: 'current_lane_loaded',
  };
}

function buildWorkItemIndexEntryMap(options = {}) {
  const parsed = readJson(resolveIndexPath({
    workItemRoot: options.workItemRoot,
    nowMs: options.nowMs,
  }));
  const entries = new Map();
  for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
    const id = normalizeToken(entry?.id, null);
    if (!id) continue;
    entries.set(id, entry);
  }
  return entries;
}

function rawSessionId(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const session = raw.session && typeof raw.session === 'object' ? raw.session.id : raw.session;
  return normalizeAppSessionId(session || raw.sessionId);
}

function workItemFilePath(id, indexEntry = null, options = {}) {
  const entryPath = toText(indexEntry?.path, null);
  if (entryPath) return path.resolve(entryPath);
  try {
    return resolveItemPath(id, {
      workItemRoot: options.workItemRoot,
      nowMs: options.nowMs,
    });
  } catch (_) {
    return null;
  }
}

function buildWorkItemSessionEvidenceMap(listed = {}, options = {}) {
  const indexEntries = buildWorkItemIndexEntryMap(options);
  const evidence = new Map();
  for (const item of Array.isArray(listed.items) ? listed.items : []) {
    const id = normalizeToken(item?.id, null);
    if (!id) continue;
    const indexEntry = indexEntries.get(id);
    const filePath = workItemFilePath(id, indexEntry, options);
    const raw = filePath ? readJson(filePath) : null;
    const rawSession = rawSessionId(raw);
    if (rawSession) {
      evidence.set(id, {
        sessionId: rawSession,
        source: 'raw_work_item_file',
      });
      continue;
    }
    if (indexEntry && Object.prototype.hasOwnProperty.call(indexEntry, 'sessionId')) {
      evidence.set(id, {
        sessionId: normalizeAppSessionId(indexEntry.sessionId),
        source: 'work_item_index',
      });
      continue;
    }
    evidence.set(id, {
      sessionId: null,
      source: 'missing_explicit_session',
    });
  }
  return evidence;
}

function workItemMatchesScope(item = {}, scope = {}, sessionEvidence = new Map()) {
  const profile = normalizeMainScope(item.profile, 'main');
  const windowKey = normalizeMainScope(item.window?.key || profile, profile);
  if (profile !== scope.profileName || windowKey !== scope.windowKey) return false;
  const expectedSession = toText(scope.sessionId, null);
  const itemSession = sessionEvidence.get(normalizeToken(item.id, null))?.sessionId || null;
  if (expectedSession && itemSession !== expectedSession) return false;
  return true;
}

function scopeWorkItemList(listed = {}, scope = {}, sessionEvidence = new Map()) {
  const items = Array.isArray(listed.items) ? listed.items : [];
  return items.filter((item) => !ACTIVE_STATES.has(item.state) || workItemMatchesScope(item, scope, sessionEvidence));
}

function activeWorkItems(listed = {}, scope = {}, sessionEvidence = new Map()) {
  return (Array.isArray(listed.items) ? listed.items : [])
    .filter((item) => ACTIVE_STATES.has(item.state))
    .filter((item) => workItemMatchesScope(item, scope, sessionEvidence))
    .sort((left, right) => toTimestampMs(right.updatedAt) - toTimestampMs(left.updatedAt));
}

function normalizeArtifactRefs(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((artifact) => ({
      ref: trimText(artifact?.ref, 160),
      path: trimText(artifact?.path, 240),
      hash: trimText(artifact?.hash, 120),
      kind: trimText(artifact?.kind, 80),
      summary: trimText(artifact?.summary, 180),
    }))
    .filter((artifact) => artifact.ref || artifact.path || artifact.hash || artifact.summary)
    .slice(0, 8);
}

function summarizeProofState(item = {}) {
  const proofState = item.proofState && typeof item.proofState === 'object' ? item.proofState : {};
  return {
    status: trimText(proofState.status || item.state, 80),
    missing_required_proofs: Array.isArray(proofState.missingRequiredProofs)
      ? proofState.missingRequiredProofs.map((proof) => trimText(proof, 80)).filter(Boolean)
      : [],
    attached_count: Array.isArray(item.proofs) ? item.proofs.length : 0,
  };
}

function dispatchPreviewForCandidate(candidate = {}) {
  const risk = normalizeToken(candidate.riskClass, 'caution');
  if (risk === 'approval_required') {
    return {
      action: 'hold_for_review',
      eligible: false,
      reason: candidate.holdReason || candidate.blockedReason || 'approval_required',
    };
  }
  if (candidate.dispatchReady === false) {
    return {
      action: 'hold_for_review',
      eligible: false,
      reason: candidate.holdReason || 'not_dispatch_ready',
    };
  }
  if (risk === 'safe' || risk === 'caution') {
    return {
      action: 'auto_dispatch_candidate',
      eligible: true,
      reason: 'preview_only_phase_1_not_dispatched',
    };
  }
  return {
    action: 'no_action',
    eligible: false,
    reason: 'unsupported_risk_class',
  };
}

function buildWorkItemCandidate(item = {}, authority) {
  const ownerRoles = uniqueStrings(item.ownerRoles).map(normalizeAgent).filter(Boolean);
  const agents = ownerRoles.length ? ownerRoles : ['builder'];
  return agents.map((agent) => ({
    id: `work-item:${item.id}:${agent}`,
    kind: 'typed_active_work_item',
    agent,
    workItemId: item.id,
    taskId: null,
    state: item.state,
    title: trimText(item.objective, 160),
    objective: trimText(item.objective, 240),
    nextStep: item.state === 'blocked'
      ? trimText(item.closure?.reason || item.objective, 220)
      : trimText(item.objective, 220),
    riskClass: item.riskClass || 'caution',
    restartPersistence: true,
    currentLaneAuthority: authority === 'typed_active_work_item',
    authority,
    sourceRefs: uniqueStrings([item.id, ...(item.sourceMessageIds || [])]),
    proofState: summarizeProofState(item),
    artifactRefs: normalizeArtifactRefs(item.artifactRefs),
    dispatchEligibility: {
      action: 'preview_only',
      eligible: false,
      reason: 'typed_work_item_already_active',
    },
    action: 'preview_only',
    previewOnly: true,
  }));
}

function buildCurrentLaneCandidate(activeLane = {}) {
  const agents = uniqueStrings(activeLane.ownerRoles || activeLane.targetRole || activeLane.target_role || [])
    .map(normalizeAgent)
    .filter(Boolean);
  const targetAgents = agents.length ? agents : [normalizeAgent(activeLane.targetRole) || 'builder'];
  return targetAgents.map((agent) => ({
    id: `current-lane:${activeLane.laneId || activeLane.sourceRef || agent}`,
    kind: 'current_lane_fallback',
    agent,
    workItemId: trimText(activeLane.workItemId, 120),
    taskId: null,
    state: trimText(activeLane.status, 80) || 'active',
    title: trimText(activeLane.objective, 160),
    objective: trimText(activeLane.objective, 240),
    nextStep: trimText(activeLane.objective, 220),
    riskClass: trimText(activeLane.riskClass, 80) || 'caution',
    restartPersistence: true,
    currentLaneAuthority: true,
    authority: 'current_lane_fallback',
    sourceRefs: uniqueStrings([activeLane.sourceRef, activeLane.sourceMessageId, activeLane.laneId]),
    dispatchEligibility: {
      action: 'preview_only',
      eligible: false,
      reason: 'current_lane_already_active',
    },
    action: 'preview_only',
    previewOnly: true,
  }));
}

function buildQueueActiveCandidates(queueState = {}) {
  const candidates = [];
  for (const agent of AGENTS) {
    const task = queueState.agents?.[agent]?.active;
    if (!task) continue;
    candidates.push({
      id: `queue-active:${agent}:${task.taskId}`,
      kind: 'owned_work_active',
      agent,
      workItemId: null,
      taskId: trimText(task.taskId, 120),
      state: trimText(task.state || task.status, 80) || 'active',
      title: trimText(task.title || task.message, 160),
      objective: trimText(task.title || task.message, 240),
      nextStep: trimText(task.nextStep, 220),
      riskClass: task.riskClass || 'caution',
      restartPersistence: task.restartPersistence !== false,
      currentLaneAuthority: false,
      authority: 'owned_work_queue_active_no_current_lane_authority',
      sourceRefs: uniqueStrings([task.source, task.taskId]),
      blockedReason: trimText(task.blockedReason, 180),
      dispatchEligibility: {
        action: 'preview_only',
        eligible: false,
        reason: 'owned_work_already_active',
      },
      action: 'preview_only',
      previewOnly: true,
    });
  }
  return candidates;
}

function buildQueueWakeCandidates(wakeScan = {}) {
  const due = Array.isArray(wakeScan.candidates) ? wakeScan.candidates : [];
  const held = Array.isArray(wakeScan.held) ? wakeScan.held : [];
  return [...due, ...held].map((candidate) => {
    const preview = dispatchPreviewForCandidate(candidate);
    return {
      id: `queue-candidate:${candidate.agent}:${candidate.taskId}`,
      kind: 'owned_work_resume_candidate',
      agent: normalizeAgent(candidate.agent) || 'builder',
      workItemId: null,
      taskId: trimText(candidate.taskId, 120),
      state: trimText(candidate.state, 80) || 'queued',
      title: trimText(candidate.title || candidate.message, 160),
      objective: trimText(candidate.title || candidate.message, 240),
      nextStep: trimText(candidate.nextStep, 220),
      riskClass: candidate.riskClass || 'caution',
      restartPersistence: candidate.restartPersistence !== false,
      currentLaneAuthority: false,
      authority: 'owned_work_queue_candidate_no_current_lane_authority',
      sourceRefs: uniqueStrings([candidate.source, candidate.taskId]),
      blockedReason: trimText(candidate.blockedReason, 180),
      holdReason: trimText(candidate.holdReason, 180),
      dispatchEligibility: preview,
      action: preview.action,
      previewOnly: true,
    };
  });
}

function rankAction(action) {
  if (action === 'auto_dispatch_candidate') return 3;
  if (action === 'preview_only') return 2;
  if (action === 'hold_for_review') return 1;
  return 0;
}

function buildPerArm(candidates = []) {
  const perArm = {};
  for (const agent of AGENTS) {
    const items = candidates.filter((candidate) => candidate.agent === agent);
    const action = items
      .map((candidate) => candidate.action || 'no_action')
      .sort((left, right) => rankAction(right) - rankAction(left))[0] || 'no_action';
    perArm[agent] = {
      agent,
      action,
      previewOnly: true,
      dispatchEligibility: {
        eligible: action === 'auto_dispatch_candidate',
        reason: action === 'auto_dispatch_candidate'
          ? 'preview_only_phase_1_not_dispatched'
          : (items[0]?.dispatchEligibility?.reason || 'no_resume_candidate'),
      },
      candidateCount: items.length,
      candidates: items,
    };
  }
  return perArm;
}

function buildAuthority(activeItems, currentLane) {
  const activeLane = currentLane?.snapshot?.activeLane && typeof currentLane.snapshot.activeLane === 'object'
    ? currentLane.snapshot.activeLane
    : null;
  if (activeItems.length > 0) {
    return {
      decision: 'typed_active_work_item',
      current_lane_authority: 'typed_active_work_item',
      active_work_item_id: activeItems[0].id,
      active_lane_present: true,
      queue_candidates_create_current_lane: false,
    };
  }
  if (currentLane?.snapshot?.status === 'active' && activeLane) {
    return {
      decision: 'current_lane_fallback',
      current_lane_authority: 'current_lane_fallback',
      active_work_item_id: null,
      active_lane_present: true,
      queue_candidates_create_current_lane: false,
    };
  }
  return {
    decision: 'none',
    current_lane_authority: 'none',
    active_work_item_id: null,
    active_lane_present: false,
    queue_candidates_create_current_lane: false,
  };
}

function summarizeActiveWorkReconciliation(reconciliation = {}) {
  const currentLaneActive = reconciliation.currentLaneActive && typeof reconciliation.currentLaneActive === 'object'
    ? reconciliation.currentLaneActive
    : {};
  const activeLane = currentLaneActive.activeLane && typeof currentLaneActive.activeLane === 'object'
    ? currentLaneActive.activeLane
    : null;
  return {
    schema: reconciliation.schema || null,
    version: reconciliation.version || null,
    generatedAt: reconciliation.generatedAt || null,
    status: reconciliation.status || null,
    authority: reconciliation.authority || null,
    chosenAuthority: reconciliation.chosenAuthority || null,
    activeWorkItemId: reconciliation.activeWorkItemId || null,
    activeWorkItemIds: uniqueStrings(reconciliation.activeWorkItemIds),
    queueActiveIds: uniqueStrings(reconciliation.queueActiveIds),
    currentLaneActive: {
      source: currentLaneActive.source || null,
      status: currentLaneActive.status || null,
      activeLane: activeLane ? {
        laneId: activeLane.laneId || null,
        workItemId: activeLane.workItemId || null,
        sourceRef: activeLane.sourceRef || null,
        sourceMessageId: activeLane.sourceMessageId || null,
        kind: activeLane.kind || null,
        objective: trimText(activeLane.objective, 180),
      } : null,
    },
    conflictMarkers: uniqueStrings(reconciliation.conflictMarkers),
    staleMarkers: uniqueStrings(reconciliation.staleMarkers),
    warnings: uniqueStrings(reconciliation.warnings),
  };
}

function buildSourceRefs(options, sources) {
  const refs = {
    app_status: {
      ...hashFile(sources.appStatusPath, options),
      session_id: sources.sessionId || null,
    },
    work_item_index: {
      ...hashFile(sources.workItemIndexPath, options),
      updated_at: sources.workItemIndexUpdatedAt || null,
    },
    task_queue: {
      ...hashFile(sources.queuePath, options),
      updated_at: sources.queueUpdatedAt || null,
    },
    current_lane: {
      ...hashFile(sources.currentLanePath, options),
      generated_at: sources.currentLaneGeneratedAt || null,
      status: sources.currentLaneStatus || null,
    },
  };
  return refs;
}

function collectStaleMarkers({ sourceRefs, currentLane, listed, queueState, nowMs, staleAfterMs }) {
  const markers = [];
  for (const [id, ref] of Object.entries(sourceRefs || {})) {
    if (!ref.present) markers.push(`source_missing:${id}`);
  }
  if (currentLane?.rejected) markers.push(`current_lane_scope_rejected:${currentLane.rejectedScope || 'non_main'}`);
  if (listed?.brokenState) markers.push(`typed_work_item_index_broken:${listed.brokenState.reason || 'unknown'}`);
  if (Array.isArray(listed?.staleMarkers)) markers.push(...listed.staleMarkers);

  const freshness = [
    sourceFreshness('current_lane', currentLane?.snapshot?.generatedAt || currentLane?.snapshot?.generated_at, nowMs, staleAfterMs),
    sourceFreshness('task_queue', queueState?.updatedAt, nowMs, staleAfterMs),
    sourceFreshness('work_item_index', listed?.updatedAt, nowMs, staleAfterMs),
  ];
  for (const item of freshness) {
    if (item.stale) markers.push(`source_stale:${item.source_id}:${item.stale_reason}`);
  }
  return {
    staleMarkers: uniqueStrings(markers),
    freshness,
  };
}

function buildRejectedManifest(scope, options = {}) {
  const nowMs = resolveNowMs(options);
  return {
    schema: SCHEMA,
    version: VERSION,
    generatedAt: toIso(nowMs),
    status: 'rejected',
    decision: scope.decision,
    previewOnly: true,
    sendSurface: {
      available: false,
      dispatchWired: false,
      builderHasSendCapability: false,
    },
    scope,
    authority: {
      decision: 'none',
      current_lane_authority: 'none',
      active_work_item_id: null,
      active_lane_present: false,
      queue_candidates_create_current_lane: false,
    },
    staleMarkers: scope.invalid || [],
    source_refs: {},
    resumeCandidates: [],
    perArm: buildPerArm([]),
    counts: {
      resumeCandidates: 0,
      autoDispatchCandidates: 0,
      heldForReview: 0,
      previewOnly: 0,
    },
  };
}

function buildRestartContinuityResumeManifest(options = {}) {
  const nowMs = resolveNowMs(options);
  const staleAfterMs = Math.max(1, Number(options.staleAfterMs) || DEFAULT_STALE_AFTER_MS);
  const scope = evaluateScope(options);
  if (!scope.ok) return buildRejectedManifest(scope, options);
  const head = getGitHead(options);

  const appStatusPath = resolveAppStatusPath(options);
  const currentLane = readCurrentLane({
    ...options,
    sessionId: scope.sessionId,
  });
  const currentLanePath = currentLane.path || resolveCurrentLanePath(options);
  const queuePath = resolveTaskQueuePath(options);
  const workItemIndexPath = resolveIndexPath({
    workItemRoot: options.workItemRoot,
    nowMs,
  });

  const listed = typeof options.listWorkItems === 'function'
    ? options.listWorkItems(options)
    : listWorkItems({
      ...options,
      nowMs,
      sessionId: scope.sessionId,
      profileName: scope.profileName,
      windowKey: scope.windowKey,
    });
  const workItemSessionEvidence = buildWorkItemSessionEvidenceMap(listed, {
    ...options,
    nowMs,
  });
  const scopedListResult = {
    ...listed,
    items: scopeWorkItemList(listed, scope, workItemSessionEvidence),
  };
  const scopedActiveItems = activeWorkItems(scopedListResult, scope, workItemSessionEvidence);
  const reconciliation = buildActiveWorkReconciliation({
    ...options,
    nowMs,
    listResult: scopedListResult,
    sessionId: scope.sessionId,
    profileName: scope.profileName,
    windowKey: scope.windowKey,
    currentLanePath,
    queuePath,
  });

  const { state: queueState } = readQueue(queuePath);
  const wakeScan = collectWakeCandidates({
    queuePath,
    nowMs,
    wakeTrigger: options.wakeTrigger || 'post-wake',
  });
  const authority = buildAuthority(scopedActiveItems, currentLane);

  const activeWorkCandidates = scopedActiveItems.flatMap((item) => buildWorkItemCandidate(item, authority.decision));
  const currentLaneCandidates = authority.decision === 'current_lane_fallback'
    ? buildCurrentLaneCandidate(currentLane.snapshot.activeLane)
    : [];
  const queueActiveCandidates = buildQueueActiveCandidates(queueState);
  const queueWakeCandidates = buildQueueWakeCandidates(wakeScan);
  const resumeCandidates = [
    ...activeWorkCandidates,
    ...currentLaneCandidates,
    ...queueActiveCandidates,
    ...queueWakeCandidates,
  ];

  const sourceRefs = buildSourceRefs(options, {
    appStatusPath,
    currentLanePath,
    queuePath,
    workItemIndexPath,
    sessionId: scope.sessionId,
    workItemIndexUpdatedAt: listed.updatedAt || null,
    queueUpdatedAt: queueState.updatedAt || null,
    currentLaneGeneratedAt: currentLane.snapshot?.generatedAt || currentLane.snapshot?.generated_at || null,
    currentLaneStatus: currentLane.snapshot?.status || null,
  });
  const stale = collectStaleMarkers({
    sourceRefs,
    currentLane,
    listed,
    queueState,
    nowMs,
    staleAfterMs,
  });
  if (head.present === false) {
    stale.staleMarkers = uniqueStrings([
      ...stale.staleMarkers,
      `source_missing:head_metadata:${head.stale_reason || 'not_supplied'}`,
    ]);
  }

  return {
    schema: SCHEMA,
    version: VERSION,
    generatedAt: toIso(nowMs),
    status: 'ready',
    decision: 'preview_only_read_model',
    previewOnly: true,
    artifact: {
      source_ref: relativeSourceRef(resolveManifestPath(options), options),
      persists_across_restart: true,
      regenerated_from_typed_sources: true,
    },
    sendSurface: {
      available: false,
      dispatchWired: false,
      builderHasSendCapability: false,
    },
    guardrails: {
      no_startup_prose: true,
      no_raw_body: true,
      no_whole_snapshots: true,
      no_hidden_sends: true,
      queue_candidates_do_not_create_current_lane_authority: true,
      dead_or_wedged_panes_require_watchdog_before_dispatch: true,
    },
    scope,
    head,
    authority,
    activeWorkReconciliation: summarizeActiveWorkReconciliation(reconciliation),
    source_refs: sourceRefs,
    source_freshness: stale.freshness,
    staleMarkers: stale.staleMarkers,
    resumeCandidates,
    perArm: buildPerArm(resumeCandidates),
    counts: {
      resumeCandidates: resumeCandidates.length,
      autoDispatchCandidates: resumeCandidates.filter((candidate) => candidate.action === 'auto_dispatch_candidate').length,
      heldForReview: resumeCandidates.filter((candidate) => candidate.action === 'hold_for_review').length,
      previewOnly: resumeCandidates.filter((candidate) => candidate.action === 'preview_only').length,
      noActionArms: AGENTS.filter((agent) => !resumeCandidates.some((candidate) => candidate.agent === agent)).length,
    },
  };
}

function writeRestartContinuityResumeManifest(options = {}) {
  const manifest = buildRestartContinuityResumeManifest(options);
  if (manifest.status === 'rejected') {
    return {
      ok: false,
      reason: manifest.decision,
      manifest,
      outputPath: null,
      wrote: false,
    };
  }
  const outputPath = resolveManifestPath(options);
  writeJsonAtomic(outputPath, manifest);
  return {
    ok: true,
    outputPath,
    wrote: true,
    manifest,
  };
}

function buildRestartContinuityResumeStartupPayload(manifest = {}, options = {}) {
  if (!manifest || manifest.status !== 'ready') return null;
  return {
    schema: STARTUP_BLOCK_SCHEMA,
    status: manifest.status,
    decision: manifest.decision,
    preview_only: true,
    artifact_source_ref: manifest.artifact?.source_ref || relativeSourceRef(resolveManifestPath(options), options),
    generated_at: manifest.generatedAt,
    head: manifest.head,
    scope: manifest.scope,
    authority: manifest.authority,
    counts: manifest.counts,
    stale_markers: manifest.staleMarkers,
    source_refs: manifest.source_refs,
    per_arm: manifest.perArm,
    guardrails: manifest.guardrails,
  };
}

function formatRestartContinuityResumeBlock(manifest = {}, options = {}) {
  const payload = buildRestartContinuityResumeStartupPayload(manifest, options);
  if (!payload) return '';
  return [
    '## Restart Continuity Resume (machine-readable)',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function writeAndFormatRestartContinuityResumeBlock(options = {}) {
  try {
    const result = writeRestartContinuityResumeManifest(options);
    if (!result.ok) return '';
    return formatRestartContinuityResumeBlock(result.manifest, options);
  } catch (_) {
    return '';
  }
}

module.exports = {
  DEFAULT_ARTIFACT_RELATIVE_PATH,
  DEFAULT_STALE_AFTER_MS,
  SCHEMA,
  STARTUP_BLOCK_SCHEMA,
  buildRestartContinuityResumeManifest,
  buildRestartContinuityResumeStartupPayload,
  evaluateScope,
  formatRestartContinuityResumeBlock,
  resolveManifestPath,
  // Shared per-source staleness classifier (proven correct in 3b2f38c6's
  // root-cause): other read models (live what-now) reuse it instead of
  // re-deriving a second, possibly divergent classifier.
  sourceFreshness,
  writeAndFormatRestartContinuityResumeBlock,
  writeRestartContinuityResumeManifest,
};
