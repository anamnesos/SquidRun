'use strict';

const fs = require('fs');
const path = require('path');

const {
  queryCommsJournalEntries,
} = require('../main/comms-journal');
const {
  deriveCurrentLaneSnapshot,
} = require('../main/agent-task-resolution');
const {
  CURRENT_LANE_RELATIVE_PATH,
} = require('./typed-restart-continuity-context-v0');
// ONE shared staleness classifier across read models (3b2f38c6 proved the
// classifier correct; the fixtures were the broken half). Do not re-derive.
const {
  DEFAULT_STALE_AFTER_MS,
  sourceFreshness,
} = require('../main/restart-continuity-resume-manifest');
const {
  buildActiveWorkReconciliation,
} = require('../main/work-item-ledger');

const SCHEMA = 'squidrun.mira_core.live_what_now_answer_v0';
// v2 extends v0: same schema family + entry point, evidence bundle widened
// from 2 sources to 7 with per-source freshness and shape-validated answers.
const VERSION = 2;
const DEFAULT_COMMS_LIMIT = 1000;
const MAX_SUMMARY_CHARS = 180;
const MAX_OBJECTIVE_CHARS = 220;

const EVIDENCE_SOURCE_REFS = Object.freeze({
  current_lane: '.squidrun/handoffs/current-lane.json',
  app_status: '.squidrun/app-status.json',
  task_queue: '.squidrun/runtime/agent-task-queue.json',
  work_items: '.squidrun/runtime/work-items/index.json',
  comms_journal: 'evidence-ledger/comms_journal',
  restart_resume: '.squidrun/handoffs/restart-continuity-resume.json',
  startup_health: '.squidrun/build/startup-health.md',
});

const WHAT_NOW_PATTERNS = Object.freeze([
  /^(?:mira[,:\s-]*)?what\s+now\s*\??$/i,
  /^(?:mira[,:\s-]*)?what(?:'|')?s\s+next\s*\??$/i,
  /\bmira\b[\s\S]{0,80}\bwhat\s+now\b/i,
  /\bwhat\s+now\b[\s\S]{0,80}\bmira\b/i,
  /\bwhat\s+should\s+happen\s+next\b[\s\S]{0,80}\bmira\b/i,
]);

function trimText(value, limit = MAX_SUMMARY_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isMiraLiveWhatNowPrompt(text = '') {
  const normalized = trimText(text, 300);
  if (!normalized) return false;
  return WHAT_NOW_PATTERNS.some((pattern) => pattern.test(normalized));
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toEventTsMs(row = {}) {
  for (const key of ['brokeredAtMs', 'sentAtMs', 'updatedAtMs', 'sourceTimestampMs', 'at_ms']) {
    const numeric = Number(row[key]);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  }
  return 0;
}

function sortRowsAsc(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const delta = toEventTsMs(left) - toEventTsMs(right);
    if (delta !== 0) return delta;
    return String(left.messageId || '').localeCompare(String(right.messageId || ''));
  });
}

function readMaterializedCurrentLane(projectRoot, explicitSnapshot = null) {
  if (explicitSnapshot && typeof explicitSnapshot === 'object' && !Array.isArray(explicitSnapshot)) {
    return explicitSnapshot;
  }
  const currentLanePath = path.join(
    path.resolve(String(projectRoot || process.cwd())),
    CURRENT_LANE_RELATIVE_PATH
  );
  return safeReadJson(currentLanePath);
}

function readLiveCommsRows(options = {}) {
  if (Array.isArray(options.commsRows)) return sortRowsAsc(options.commsRows);
  const reader = typeof options.commsReader === 'function'
    ? options.commsReader
    : queryCommsJournalEntries;
  const filters = {
    sessionId: trimText(options.sessionId, 120) || undefined,
    limit: Math.max(1, Math.min(50000, Number(options.commsLimit) || DEFAULT_COMMS_LIMIT)),
    order: 'asc',
  };
  try {
    const rows = reader(filters, { dbPath: options.evidenceLedgerDbPath });
    return sortRowsAsc(Array.isArray(rows) ? rows : []);
  } catch {
    return [];
  }
}

function activeLaneSourceRef(snapshot = {}) {
  return trimText(snapshot.activeLane?.sourceRef, 80)
    || trimText(snapshot.current_lane?.source_ref, 80)
    || null;
}

function activeLaneObjective(snapshot = {}) {
  return trimText(snapshot.activeLane?.objective || snapshot.current_lane?.objective, MAX_OBJECTIVE_CHARS);
}

function firstObjectiveSentence(objective = '') {
  const text = trimText(objective, MAX_OBJECTIVE_CHARS);
  if (!text) return 'No active current lane';
  const match = text.match(/^(.+?[.!?])(?:\s+|$)/);
  return trimText(match ? match[1] : text, MAX_OBJECTIVE_CHARS).replace(/[.!?]+$/, '');
}

function normalizeRecentChanges(snapshot = {}) {
  const continuity = snapshot.continuity && typeof snapshot.continuity === 'object'
    ? snapshot.continuity
    : {};
  return (Array.isArray(continuity.recent_completed_fixes)
    ? continuity.recent_completed_fixes
    : [])
    .map((item) => ({
      source_ref: trimText(item.source_ref, 80) || null,
      summary: trimText(item.summary, MAX_SUMMARY_CHARS),
    }))
    .filter((item) => item.summary)
    .slice(0, 2);
}

function normalizeStaleMarkers(snapshot = {}, extraMarkers = []) {
  const continuity = snapshot.continuity && typeof snapshot.continuity === 'object'
    ? snapshot.continuity
    : {};
  return [
    ...extraMarkers,
    ...(Array.isArray(continuity.stale_backlog_markers)
      ? continuity.stale_backlog_markers
      : []),
  ]
    .map((item) => trimText(item, MAX_SUMMARY_CHARS))
    .filter(Boolean)
    .slice(0, 4);
}

function chooseAuthority(materializedSnapshot = null, liveSnapshot = null) {
  const materializedActive = materializedSnapshot?.status === 'active' && materializedSnapshot.activeLane;
  const liveActive = liveSnapshot?.status === 'active' && liveSnapshot.activeLane;
  if (liveActive) {
    return {
      source: 'live_comms_journal',
      snapshot: liveSnapshot,
      extraStaleMarkers: materializedActive ? [] : [
        'Materialized current-lane.json is not active; live current-session comms provide the newer lane authority.',
      ],
    };
  }
  if (materializedActive) {
    return {
      source: 'current_lane_json',
      snapshot: materializedSnapshot,
      extraStaleMarkers: [],
    };
  }
  return {
    source: 'no_active_lane',
    snapshot: liveSnapshot || materializedSnapshot || {},
    extraStaleMarkers: ['No active lane found in live comms or current-lane.json.'],
  };
}

function countJamesActionLines(text = '') {
  return String(text || '').split(/\r?\n/)
    .filter((line) => /^\s*JAMES ACTION:/i.test(line))
    .length;
}

function formatAge(ageMs) {
  const numeric = Number(ageMs);
  if (!Number.isFinite(numeric) || numeric < 0) return 'age unknown';
  if (numeric < 60_000) return `${Math.max(1, Math.round(numeric / 1000))}s old`;
  if (numeric < 3_600_000) return `${Math.round(numeric / 60_000)}m old`;
  return `${Math.round(numeric / 360_000) / 10}h old`;
}

function readJsonEvidenceSource(sourceId, absolutePath, nowMs, staleAfterMs) {
  const payload = safeReadJson(absolutePath);
  if (!payload) {
    return {
      source_ref: EVIDENCE_SOURCE_REFS[sourceId],
      present: false,
      generated_at: null,
      age_ms: null,
      stale: true,
      stale_reason: 'source_missing',
      payload: null,
    };
  }
  const generatedAt = payload.generatedAt || payload.generated_at
    || payload.updatedAt || payload.updated_at
    || payload.lastUpdated || payload.last_updated
    || null;
  const freshness = sourceFreshness(sourceId, generatedAt, nowMs, staleAfterMs);
  return {
    source_ref: EVIDENCE_SOURCE_REFS[sourceId],
    present: true,
    generated_at: freshness.generated_at,
    age_ms: freshness.age_ms,
    stale: freshness.stale,
    stale_reason: freshness.stale_reason,
    payload,
  };
}

function readStartupHealthSource(absolutePath, nowMs, staleAfterMs) {
  let text = null;
  try {
    if (absolutePath && fs.existsSync(absolutePath)) {
      text = fs.readFileSync(absolutePath, 'utf8');
    }
  } catch {
    text = null;
  }
  if (!text) {
    return {
      source_ref: EVIDENCE_SOURCE_REFS.startup_health,
      present: false,
      generated_at: null,
      age_ms: null,
      stale: true,
      stale_reason: 'source_missing',
      overall: null,
      score: null,
      warnings: [],
    };
  }
  const overallMatch = text.match(/^-\s*Overall:\s*([A-Z]+)\s*\(score=(\d+)\/100\)/m);
  const generatedMatch = text.match(/^-\s*Generated:\s*(\S+)/m);
  const warnings = [];
  for (const match of text.matchAll(/^-\s*Warnings?:\s*(.+)$/gm)) {
    const line = trimText(match[1], MAX_SUMMARY_CHARS);
    if (line && !/^none\b/i.test(line)) warnings.push(line);
  }
  const blockersMatch = text.match(/^-\s*Blockers?:\s*(.+)$/m);
  if (blockersMatch && !/^none\b/i.test(blockersMatch[1].trim())) {
    warnings.unshift(`Blockers: ${trimText(blockersMatch[1], MAX_SUMMARY_CHARS)}`);
  }
  // Startup health is written once per boot; its age is informational, judged
  // against the session length rather than the default lane threshold.
  const freshness = sourceFreshness('startup_health', generatedMatch?.[1] || null, nowMs, Math.max(staleAfterMs, 24 * 60 * 60 * 1000));
  return {
    source_ref: EVIDENCE_SOURCE_REFS.startup_health,
    present: true,
    generated_at: freshness.generated_at,
    age_ms: freshness.age_ms,
    stale: freshness.stale,
    stale_reason: freshness.stale_reason,
    overall: overallMatch ? overallMatch[1] : null,
    score: overallMatch ? Number(overallMatch[2]) : null,
    warnings: warnings.slice(0, 4),
  };
}

function summarizeQueueCandidates(queuePayload = {}) {
  const agents = queuePayload?.agents && typeof queuePayload.agents === 'object' ? queuePayload.agents : {};
  const candidates = [];
  for (const [agent, bucket] of Object.entries(agents)) {
    if (bucket?.active && typeof bucket.active === 'object') {
      candidates.push({
        taskId: trimText(bucket.active.taskId, 80) || null,
        owner: trimText(agent, 24),
        state: 'active',
        title: trimText(bucket.active.title || bucket.active.message, MAX_SUMMARY_CHARS) || null,
      });
    }
    for (const task of Array.isArray(bucket?.pending) ? bucket.pending.slice(0, 2) : []) {
      candidates.push({
        taskId: trimText(task.taskId, 80) || null,
        owner: trimText(agent, 24),
        state: 'queued',
        title: trimText(task.title || task.message, MAX_SUMMARY_CHARS) || null,
      });
    }
  }
  return candidates.slice(0, 6);
}

function buildWhatNowEvidenceBundle(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs)) && Number(options.staleAfterMs) > 0
    ? Number(options.staleAfterMs)
    : DEFAULT_STALE_AFTER_MS;
  const overrides = options.evidenceOverrides && typeof options.evidenceOverrides === 'object'
    ? options.evidenceOverrides
    : {};
  const sourcePath = (relRef) => path.join(projectRoot, ...relRef.split('/'));

  const currentLaneRaw = overrides.current_lane !== undefined
    ? overrides.current_lane
    : safeReadJson(path.join(projectRoot, CURRENT_LANE_RELATIVE_PATH));
  const currentLaneFreshness = currentLaneRaw
    ? sourceFreshness('current_lane', currentLaneRaw.generatedAt || currentLaneRaw.generated_at, nowMs, staleAfterMs)
    : null;
  const currentLane = {
    source_ref: EVIDENCE_SOURCE_REFS.current_lane,
    present: Boolean(currentLaneRaw),
    generated_at: currentLaneFreshness?.generated_at || null,
    age_ms: currentLaneFreshness?.age_ms ?? null,
    stale: currentLaneRaw ? currentLaneFreshness.stale : true,
    stale_reason: currentLaneRaw ? currentLaneFreshness.stale_reason : 'source_missing',
    payload: currentLaneRaw,
  };

  const appStatus = overrides.app_status !== undefined
    ? { source_ref: EVIDENCE_SOURCE_REFS.app_status, present: Boolean(overrides.app_status), ...(overrides.app_status ? { ...sourceFreshnessFromPayload('app_status', overrides.app_status, nowMs, staleAfterMs), payload: overrides.app_status } : { generated_at: null, age_ms: null, stale: true, stale_reason: 'source_missing', payload: null }) }
    : readJsonEvidenceSource('app_status', sourcePath(EVIDENCE_SOURCE_REFS.app_status), nowMs, staleAfterMs);

  const taskQueue = overrides.task_queue !== undefined
    ? { source_ref: EVIDENCE_SOURCE_REFS.task_queue, present: Boolean(overrides.task_queue), ...(overrides.task_queue ? { ...sourceFreshnessFromPayload('task_queue', overrides.task_queue, nowMs, staleAfterMs), payload: overrides.task_queue } : { generated_at: null, age_ms: null, stale: true, stale_reason: 'source_missing', payload: null }) }
    : readJsonEvidenceSource('task_queue', sourcePath(EVIDENCE_SOURCE_REFS.task_queue), nowMs, staleAfterMs);
  taskQueue.candidates = taskQueue.payload ? summarizeQueueCandidates(taskQueue.payload) : [];
  // HARD RULE (existing guardrail, restated in code): queue candidates never
  // create lane authority - they may only be OFFERED as labeled next moves.
  taskQueue.creates_lane_authority = false;

  const workItems = overrides.work_items !== undefined
    ? { source_ref: EVIDENCE_SOURCE_REFS.work_items, present: Boolean(overrides.work_items), ...(overrides.work_items ? { ...sourceFreshnessFromPayload('work_items', overrides.work_items, nowMs, staleAfterMs), payload: overrides.work_items } : { generated_at: null, age_ms: null, stale: true, stale_reason: 'source_missing', payload: null }) }
    : readJsonEvidenceSource('work_items', sourcePath(EVIDENCE_SOURCE_REFS.work_items), nowMs, staleAfterMs);
  if (overrides.workItemReconciliation !== undefined) {
    workItems.reconciliation = overrides.workItemReconciliation;
  } else if (workItems.present) {
    // Reuse the existing reconciliation (work-item-ledger), never re-derive -
    // but only when this projectRoot actually has a work-item index, so a
    // sandboxed root cannot pick up live-repo state through config fallback.
    try {
      workItems.reconciliation = buildActiveWorkReconciliation({ projectRoot, nowMs });
    } catch {
      workItems.reconciliation = null;
    }
  } else {
    workItems.reconciliation = null;
  }

  const restartResume = overrides.restart_resume !== undefined
    ? { source_ref: EVIDENCE_SOURCE_REFS.restart_resume, present: Boolean(overrides.restart_resume), ...(overrides.restart_resume ? { ...sourceFreshnessFromPayload('restart_resume', overrides.restart_resume, nowMs, staleAfterMs), payload: overrides.restart_resume } : { generated_at: null, age_ms: null, stale: true, stale_reason: 'source_missing', payload: null }) }
    : readJsonEvidenceSource('restart_resume', sourcePath(EVIDENCE_SOURCE_REFS.restart_resume), nowMs, staleAfterMs);

  const startupHealth = overrides.startup_health !== undefined
    ? { source_ref: EVIDENCE_SOURCE_REFS.startup_health, present: Boolean(overrides.startup_health), generated_at: null, age_ms: null, stale: false, stale_reason: null, overall: overrides.startup_health?.overall ?? null, score: overrides.startup_health?.score ?? null, warnings: overrides.startup_health?.warnings || [] }
    : readStartupHealthSource(sourcePath(EVIDENCE_SOURCE_REFS.startup_health), nowMs, staleAfterMs);

  return {
    nowMs,
    staleAfterMs,
    sources: {
      current_lane: currentLane,
      app_status: appStatus,
      task_queue: taskQueue,
      work_items: workItems,
      comms_journal: null, // filled by the caller, which owns the rows
      restart_resume: restartResume,
      startup_health: startupHealth,
    },
  };
}

function sourceFreshnessFromPayload(sourceId, payload, nowMs, staleAfterMs) {
  const generatedAt = payload.generatedAt || payload.generated_at
    || payload.updatedAt || payload.updated_at
    || payload.lastUpdated || payload.last_updated
    || null;
  const freshness = sourceFreshness(sourceId, generatedAt, nowMs, staleAfterMs);
  return {
    generated_at: freshness.generated_at,
    age_ms: freshness.age_ms,
    stale: freshness.stale,
    stale_reason: freshness.stale_reason,
  };
}

function collectEvidenceStaleMarkers(sources = {}) {
  const markers = [];
  for (const [id, source] of Object.entries(sources)) {
    if (!source) continue;
    if (!source.present) {
      markers.push(`source_missing:${id}`);
      continue;
    }
    if (source.stale) {
      markers.push(`source_stale:${id}:${source.stale_reason || 'unknown'}`);
    }
  }
  return markers;
}

// Decide the next move from evidence, in authority order: lane continuity ->
// resume candidates -> queue candidates (labeled, never lane authority). A
// stale source may be mentioned but never decides `next`.
function deriveNextMove(sources = {}) {
  const lane = sources.current_lane;
  const continuityNext = lane?.present && !lane.stale
    ? trimText(lane.payload?.continuity?.next_action, MAX_SUMMARY_CHARS)
    : '';
  if (continuityNext) {
    return {
      kind: 'lane_continuity',
      text: continuityNext,
      whose_move: 'lane-owner',
      source_ref: EVIDENCE_SOURCE_REFS.current_lane,
    };
  }
  const resume = sources.restart_resume;
  const resumeCandidate = resume?.present && !resume.stale
    ? (Array.isArray(resume.payload?.resumeCandidates) ? resume.payload.resumeCandidates[0] : null)
    : null;
  if (resumeCandidate) {
    return {
      kind: 'resume_candidate',
      text: trimText(resumeCandidate.title || resumeCandidate.message || resumeCandidate.taskId, MAX_SUMMARY_CHARS),
      whose_move: trimText(resumeCandidate.owner, 24) || 'builder',
      source_ref: EVIDENCE_SOURCE_REFS.restart_resume,
    };
  }
  const queue = sources.task_queue;
  const queueCandidate = queue?.present && !queue.stale
    ? (queue.candidates || [])[0]
    : null;
  if (queueCandidate) {
    return {
      kind: 'queue_candidate',
      text: trimText(queueCandidate.title || queueCandidate.taskId, MAX_SUMMARY_CHARS),
      whose_move: queueCandidate.owner || 'unassigned',
      source_ref: EVIDENCE_SOURCE_REFS.task_queue,
      creates_lane_authority: false,
    };
  }
  return {
    kind: 'none',
    text: 'No live source names a next action.',
    whose_move: null,
    source_ref: null,
  };
}

// Answer-shape validator: the runtime rules that separate a PASS answer from
// vibes. Used by the builder as a self-check and by the harness with
// deliberately broken answers (the five failing cases).
function validateLiveWhatNowAnswer(answer = {}, evidence = {}) {
  const violations = [];
  const knownRefs = new Set(
    Object.values(evidence.sources || {})
      .filter(Boolean)
      .map((source) => source.source_ref)
      .filter(Boolean)
  );

  const happening = Array.isArray(answer.happening) ? answer.happening : [];
  if (happening.length < 1 || happening.length > 3) {
    violations.push('happening_line_count_out_of_range');
  }
  for (const line of happening) {
    if (!line || !trimText(line.text)) {
      violations.push('happening_line_empty');
      continue;
    }
    if (!line.source_ref || !knownRefs.has(line.source_ref)) {
      violations.push(`unsourced_claim:${trimText(line.text, 60)}`);
    }
  }

  const next = answer.next && typeof answer.next === 'object' ? answer.next : null;
  if (!next) {
    violations.push('next_missing');
  } else if (next.kind !== 'none' && next.proposed_by !== 'mira') {
    if (!next.source_ref || !knownRefs.has(next.source_ref)) {
      violations.push('invented_next_action');
    } else {
      const sourceEntry = Object.values(evidence.sources || {})
        .filter(Boolean)
        .find((source) => source.source_ref === next.source_ref);
      if (sourceEntry?.stale) {
        violations.push(`stale_source_as_authority:${next.source_ref}`);
      }
    }
  }

  const actionLines = countJamesActionLines(answer.answer_text || '');
  if (actionLines !== 1) {
    violations.push(`james_action_line_count:${actionLines}`);
  }

  const health = evidence.sources?.startup_health;
  const healthWarnings = Array.isArray(health?.warnings) ? health.warnings : [];
  const healthNeedsSurface = Boolean(health?.present
    && (healthWarnings.length > 0 || (health.overall && health.overall !== 'PASS' && health.overall !== 'OK')));
  if (healthNeedsSurface && !/health/i.test(answer.answer_text || '')) {
    violations.push('health_warning_suppressed');
  }

  return { ok: violations.length === 0, violations };
}

function buildAnswerTextV2({ happening, next, staleMarkers, health, jamesActionLine }) {
  const lines = happening.map((line) => `${line.text} (${line.source_ref}, ${formatAge(line.age_ms)})`);
  if (health?.present && (health.overall && health.overall !== 'PASS')) {
    const warningText = (health.warnings || [])[0];
    lines.push(`Health: ${health.overall}${Number.isFinite(health.score) ? ` ${health.score}/100` : ''}${warningText ? ` - ${warningText}` : ''} (${EVIDENCE_SOURCE_REFS.startup_health}, ${formatAge(health.age_ms)})`);
  }
  if (staleMarkers.length > 0) {
    lines.push(`Stale: ${staleMarkers.slice(0, 3).join('; ')}`);
  }
  const whose = next.whose_move ? `${next.whose_move}: ` : '';
  lines.push(`Next: ${whose}${next.text}${next.source_ref ? ` (${next.source_ref})` : ''}`);
  lines.push(jamesActionLine);
  return lines.join('\n');
}

function buildMiraLiveWhatNowAnswerV0(input = {}, options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || input.projectRoot || process.cwd()));
  const promptText = input.promptText || input.text || '';
  const sessionId = trimText(
    input.sessionId
    || input.metadata?.sessionId
    || input.metadata?.session_id
    || options.sessionId,
    120
  ) || null;
  const nowMs = Number.isFinite(Number(options.nowMs || input.nowMs))
    ? Number(options.nowMs || input.nowMs)
    : Date.now();

  if (!isMiraLiveWhatNowPrompt(promptText)) {
    return {
      schema: SCHEMA,
      version: VERSION,
      ok: false,
      decision: 'not_what_now_prompt',
      read_only: true,
    };
  }

  const materializedSnapshot = readMaterializedCurrentLane(projectRoot, options.currentLaneSnapshot);
  const liveRows = readLiveCommsRows({
    commsRows: options.commsRows,
    commsReader: options.commsReader,
    evidenceLedgerDbPath: options.evidenceLedgerDbPath,
    commsLimit: options.commsLimit,
    sessionId: sessionId || materializedSnapshot?.sessionId || null,
  });
  const liveSnapshot = liveRows.length > 0
    ? deriveCurrentLaneSnapshot(liveRows, {
      sessionId: sessionId || materializedSnapshot?.sessionId || null,
      nowMs,
    })
    : null;
  const authority = chooseAuthority(materializedSnapshot, liveSnapshot);
  const activeLane = authority.snapshot?.activeLane ? {
    objective: activeLaneObjective(authority.snapshot),
    status: trimText(authority.snapshot.activeLane.status, 40) || authority.snapshot.status || 'active',
    source_ref: activeLaneSourceRef(authority.snapshot),
    source_message_id: trimText(authority.snapshot.activeLane.sourceMessageId, 120) || null,
  } : null;
  const recentChanges = normalizeRecentChanges(authority.snapshot);
  const laneStaleMarkers = normalizeStaleMarkers(authority.snapshot, authority.extraStaleMarkers);

  // v2 evidence bundle: the five sources beyond v0's two, plus per-source
  // freshness for everything (current-lane reuses the snapshot already read).
  const evidence = buildWhatNowEvidenceBundle({
    projectRoot,
    nowMs,
    staleAfterMs: options.staleAfterMs,
    evidenceOverrides: {
      ...(options.evidenceOverrides || {}),
      ...(options.currentLaneSnapshot !== undefined ? { current_lane: options.currentLaneSnapshot } : {}),
    },
  });
  const lastRow = liveRows.length > 0 ? liveRows[liveRows.length - 1] : null;
  const lastRowTsMs = lastRow ? toEventTsMs(lastRow) : 0;
  evidence.sources.comms_journal = {
    source_ref: EVIDENCE_SOURCE_REFS.comms_journal,
    present: liveRows.length > 0,
    generated_at: lastRowTsMs > 0 ? new Date(lastRowTsMs).toISOString() : null,
    age_ms: lastRowTsMs > 0 ? Math.max(0, nowMs - lastRowTsMs) : null,
    stale: liveRows.length === 0,
    stale_reason: liveRows.length === 0 ? 'source_missing' : null,
    row_count: liveRows.length,
  };

  const appStatus = evidence.sources.app_status;
  const sessionLabel = appStatus.present
    ? `Session ${trimText(appStatus.payload?.session, 24) || 'unknown'}`
    : 'Session unknown (app-status missing)';
  const missingPanes = Array.isArray(appStatus.payload?.paneHost?.missingPanes)
    ? appStatus.payload.paneHost.missingPanes
    : [];
  const degraded = appStatus.payload?.paneHost?.degraded === true;
  const paneText = appStatus.present
    ? (missingPanes.length > 0 || degraded
      ? `panes degraded${missingPanes.length > 0 ? ` (missing: ${missingPanes.join(', ')})` : ''}`
      : 'panes ready')
    : 'pane state unknown';

  const happening = [];
  happening.push({
    text: `${sessionLabel}, ${paneText}`,
    source_ref: EVIDENCE_SOURCE_REFS.app_status,
    age_ms: appStatus.age_ms,
  });
  happening.push({
    text: activeLane
      ? `Lane: ${firstObjectiveSentence(activeLane.objective)} (${activeLane.status})`
      : 'No active lane',
    source_ref: authority.source === 'live_comms_journal'
      ? EVIDENCE_SOURCE_REFS.comms_journal
      : EVIDENCE_SOURCE_REFS.current_lane,
    age_ms: authority.source === 'live_comms_journal'
      ? evidence.sources.comms_journal.age_ms
      : evidence.sources.current_lane.age_ms,
  });
  const reconciliation = evidence.sources.work_items?.reconciliation;
  const activeWorkItemId = trimText(reconciliation?.activeWorkItemId, 80);
  if (activeWorkItemId) {
    happening.push({
      text: `In flight: work item ${activeWorkItemId} (${trimText(reconciliation.status, 24) || 'OK'})`,
      source_ref: EVIDENCE_SOURCE_REFS.work_items,
      age_ms: evidence.sources.work_items.age_ms,
    });
  } else if (recentChanges.length > 0) {
    happening.push({
      text: `Recent: ${recentChanges[0].summary}`,
      source_ref: authority.source === 'live_comms_journal'
        ? EVIDENCE_SOURCE_REFS.comms_journal
        : EVIDENCE_SOURCE_REFS.current_lane,
      age_ms: authority.source === 'live_comms_journal'
        ? evidence.sources.comms_journal.age_ms
        : evidence.sources.current_lane.age_ms,
    });
  }

  const next = deriveNextMove(evidence.sources);
  const evidenceStaleMarkers = collectEvidenceStaleMarkers(evidence.sources);
  const staleMarkers = [...evidenceStaleMarkers, ...laneStaleMarkers].slice(0, 6);
  const health = evidence.sources.startup_health;
  const jamesActionLine = health?.present && health.overall === 'FAIL'
    ? `JAMES ACTION: startup health is FAIL${(health.warnings || [])[0] ? ` - ${(health.warnings || [])[0]}` : ''}`
    : 'JAMES ACTION: NONE';

  const answerText = buildAnswerTextV2({
    happening,
    next,
    staleMarkers,
    health,
    jamesActionLine,
  });

  const answer = {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: activeLane ? 'answered_from_live_evidence' : 'answered_no_active_lane',
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    answer_text: answerText,
    james_action_line_count: countJamesActionLines(answerText),
    happening,
    next,
    stale_markers: staleMarkers,
    health: health ? {
      present: health.present,
      overall: health.overall,
      score: health.score,
      warnings: health.warnings || [],
    } : null,
    current_lane: activeLane,
    recent_changes: recentChanges,
    stale_or_parked_exclusions: [
      'parked/prototype/archive scaffolds excluded from next-move authority',
      'New Mira runtime/workbench/bridge prototypes excluded from live authority',
      'voice/curiosity/self-direction transition paths excluded from live authority',
      ...laneStaleMarkers,
    ].slice(0, 6),
    source_refs: Object.values(evidence.sources)
      .filter(Boolean)
      .map((source) => ({
        source_ref: source.source_ref,
        present: source.present,
        generated_at: source.generated_at,
        age_ms: source.age_ms,
        stale: source.stale,
        stale_reason: source.stale_reason || null,
      })),
    source_status: {
      authority_source: authority.source,
      current_lane_json: {
        present: Boolean(materializedSnapshot),
        status: trimText(materializedSnapshot?.status, 40) || null,
        source_ref: activeLaneSourceRef(materializedSnapshot || {}),
      },
      live_comms_journal: {
        present: liveRows.length > 0,
        row_count: liveRows.length,
        status: trimText(liveSnapshot?.status, 40) || null,
        source_ref: activeLaneSourceRef(liveSnapshot || {}),
      },
      queue_candidates_create_current_lane: false,
    },
    no_effects: {
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_writes: true,
      read_only_sources: Object.values(EVIDENCE_SOURCE_REFS),
    },
  };
  answer.shape_check = validateLiveWhatNowAnswer(answer, evidence);
  return answer;
}

module.exports = {
  EVIDENCE_SOURCE_REFS,
  SCHEMA,
  VERSION,
  buildMiraLiveWhatNowAnswerV0,
  buildWhatNowEvidenceBundle,
  countJamesActionLines,
  isMiraLiveWhatNowPrompt,
  validateLiveWhatNowAnswer,
};
