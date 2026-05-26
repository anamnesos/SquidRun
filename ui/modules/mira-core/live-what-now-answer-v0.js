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

const SCHEMA = 'squidrun.mira_core.live_what_now_answer_v0';
const VERSION = 1;
const DEFAULT_COMMS_LIMIT = 1000;
const MAX_SUMMARY_CHARS = 180;
const MAX_OBJECTIVE_CHARS = 220;

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

function formatRecentChanges(changes = []) {
  if (changes.length === 0) return 'Recent changes: none found in current live evidence.';
  return `Recent changes: ${changes.map((item) => (
    item.source_ref ? `${item.summary} (${item.source_ref})` : item.summary
  )).join('; ')}.`;
}

function countJamesActionLines(text = '') {
  return String(text || '').split(/\r?\n/)
    .filter((line) => /^\s*JAMES ACTION:/i.test(line))
    .length;
}

function buildAnswerText({ authoritySource, activeLane, recentChanges }) {
  const laneObjective = firstObjectiveSentence(activeLane?.objective);
  const sourceRef = activeLane?.source_ref ? ` ${activeLane.source_ref}` : '';
  const status = activeLane?.status || 'none';
  return [
    `Current lane: ${laneObjective} (${status}${sourceRef}; source=${authoritySource}).`,
    formatRecentChanges(recentChanges),
    'Authority: live SquidRun current-lane/comms evidence decides this answer; parked, prototype, archive, voice, curiosity, New Mira runtime, and phase-scaffold evidence is excluded from next-move authority.',
    'Next internal move: Builder proves this read-only what-now surface, then Oracle reviews it; no send, runtime POST, or external action is authorized.',
    'JAMES ACTION: NONE',
  ].join('\n');
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
  const staleMarkers = normalizeStaleMarkers(authority.snapshot, authority.extraStaleMarkers);
  const answerText = buildAnswerText({
    authoritySource: authority.source,
    activeLane,
    recentChanges,
  });

  return {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: activeLane ? 'answered_from_live_evidence' : 'answered_no_active_lane',
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    answer_text: answerText,
    james_action_line_count: countJamesActionLines(answerText),
    current_lane: activeLane,
    recent_changes: recentChanges,
    stale_or_parked_exclusions: [
      'parked/prototype/archive scaffolds excluded from next-move authority',
      'New Mira runtime/workbench/bridge prototypes excluded from live authority',
      'voice/curiosity/self-direction transition paths excluded from live authority',
      ...staleMarkers,
    ].slice(0, 6),
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
    },
    no_effects: {
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_writes: true,
      read_only_sources: ['.squidrun/handoffs/current-lane.json', 'evidence-ledger/comms_journal'],
    },
  };
}

module.exports = {
  SCHEMA,
  VERSION,
  buildMiraLiveWhatNowAnswerV0,
  countJamesActionLines,
  isMiraLiveWhatNowPrompt,
};
