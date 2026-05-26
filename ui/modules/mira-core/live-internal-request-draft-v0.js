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

const SCHEMA = 'squidrun.mira_core.live_internal_request_draft_v0';
const VERSION = 1;
const DEFAULT_COMMS_LIMIT = 1000;
const MAX_SUMMARY_CHARS = 220;
const MAX_OBJECTIVE_CHARS = 320;

const INTERNAL_REQUEST_DRAFT_PATTERNS = Object.freeze([
  /\binternal[-\s]+request\s+draft\b/i,
  /\bdraft\b[\s\S]{0,80}\b(?:internal|builder|oracle)\b[\s\S]{0,80}\b(?:request|message|draft)\b/i,
  /\b(?:prepare|show|make)\b[\s\S]{0,80}\b(?:builder|oracle)\b[\s\S]{0,80}\b(?:request|message|draft)\b/i,
  /\bask\s+(?:builder|oracle)\b[\s\S]{0,100}\bdraft\b/i,
]);

function trimText(value, limit = MAX_SUMMARY_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function isMiraLiveInternalRequestDraftPrompt(text = '') {
  const normalized = trimText(text, 500);
  if (!normalized) return false;
  return INTERNAL_REQUEST_DRAFT_PATTERNS.some((pattern) => pattern.test(normalized));
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
  return safeReadJson(path.join(
    path.resolve(String(projectRoot || process.cwd())),
    CURRENT_LANE_RELATIVE_PATH
  ));
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

function firstObjectiveSentence(value = '') {
  const text = trimText(value, MAX_OBJECTIVE_CHARS);
  if (!text) return '';
  const match = text.match(/^(.+?[.!?])(?:\s+|$)/);
  return trimText(match ? match[1] : text, MAX_SUMMARY_CHARS).replace(/[.!?]+$/, '');
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
    .filter((item) => item.summary && item.source_ref)
    .slice(0, 3);
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
  const liveActive = liveSnapshot?.status === 'active' && liveSnapshot.activeLane;
  const materializedActive = materializedSnapshot?.status === 'active' && materializedSnapshot.activeLane;
  if (liveActive) {
    return {
      source: 'live_comms_journal',
      snapshot: liveSnapshot,
      extraStaleMarkers: materializedActive ? [] : [
        'Materialized current-lane.json is not active; live comms provide current draft authority.',
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

function chooseTargetAgent(promptText = '', activeLane = null) {
  if (/\boracle\b/i.test(promptText)) return 'oracle';
  if (/\bbuilder\b/i.test(promptText)) return 'builder';
  const targetRole = String(activeLane?.target_role || activeLane?.targetRole || '').toLowerCase();
  if (targetRole === 'oracle' || targetRole === 'builder') return targetRole;
  return 'builder';
}

function titleRole(role) {
  return role === 'oracle' ? 'Oracle' : 'Builder';
}

function countJamesActionLines(text = '') {
  return String(text || '').split(/\r?\n/)
    .filter((line) => /^\s*JAMES ACTION:/i.test(line))
    .length;
}

function buildSourceEvidence(authoritySource, activeLane, recentChanges = []) {
  const evidence = [];
  if (activeLane) {
    evidence.push({
      kind: 'active_current_session_lane',
      source_ref: activeLane.source_ref,
      source_message_id: activeLane.source_message_id,
      summary: trimText(activeLane.objective, MAX_OBJECTIVE_CHARS),
      authority_source: authoritySource,
    });
  }
  for (const change of recentChanges) {
    evidence.push({
      kind: 'recent_completed_change',
      source_ref: change.source_ref || null,
      summary: change.summary,
      authority_source: authoritySource,
    });
  }
  if (evidence.length === 0) {
    evidence.push({
      kind: 'no_active_lane',
      source_ref: null,
      summary: 'No active current-session lane found in live comms/current-lane evidence.',
      authority_source: authoritySource,
    });
  }
  return evidence.slice(0, 4);
}

function buildReason(activeLane, targetAgent) {
  if (!activeLane) {
    return `No active lane is available, so the safest ${titleRole(targetAgent)} draft is a review request for current evidence before any action.`;
  }
  return `Architect delegated ${firstObjectiveSentence(activeLane.objective)}; ${titleRole(targetAgent)} is the reviewable internal target for the next no-dispatch move.`;
}

function buildProposedMessageBody({ targetAgent, activeLane }) {
  const target = titleRole(targetAgent).toUpperCase();
  const sourceRef = activeLane?.source_ref || 'live SquidRun evidence';
  const objective = activeLane?.objective
    ? firstObjectiveSentence(activeLane.objective)
    : 'verify the current SquidRun lane from live evidence before any next move';
  return [
    `(DRAFT TO ${target}) Review/continue from ${sourceRef}: ${objective}`,
    'Keep this as draft-only review work: no hm-send, runtime POST, external action, live route change, credential use, or dispatch.',
    'Return proof that source evidence, target agent, proposed body, reason/trigger, blocked/parked exclusions, and one James-action line are present before any real send is considered.',
  ].join('\n');
}

function buildAnswerText({
  authoritySource,
  sourceEvidence,
  targetAgent,
  proposedMessageBody,
  reason,
  blockedExclusions,
}) {
  const evidenceText = sourceEvidence
    .map((item) => `${item.source_ref || item.kind}: ${item.summary}`)
    .join('; ');
  return [
    'Internal request draft: draft only; not sent.',
    `Source evidence: ${evidenceText} (authority=${authoritySource}).`,
    `Target agent: ${titleRole(targetAgent)}.`,
    `Reason/trigger: ${reason}`,
    'Proposed message body:',
    proposedMessageBody,
    `Blocked/parked exclusions: ${blockedExclusions.join('; ')}.`,
    'JAMES ACTION: NONE',
  ].join('\n');
}

function buildMiraLiveInternalRequestDraftV0(input = {}, options = {}) {
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

  if (!isMiraLiveInternalRequestDraftPrompt(promptText)) {
    return {
      schema: SCHEMA,
      version: VERSION,
      ok: false,
      decision: 'not_internal_request_draft_prompt',
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
    target_role: trimText(authority.snapshot.activeLane.targetRole, 40) || null,
  } : null;
  const recentChanges = normalizeRecentChanges(authority.snapshot);
  const sourceEvidence = buildSourceEvidence(authority.source, activeLane, recentChanges);
  const targetAgent = chooseTargetAgent(promptText, activeLane);
  const proposedMessageBody = buildProposedMessageBody({ targetAgent, activeLane });
  const reason = buildReason(activeLane, targetAgent);
  const blockedExclusions = [
    'parked/prototype/archive scaffolds excluded from authority',
    'New Mira runtime/workbench, voice, curiosity, self-direction, and phase scaffolds excluded',
    'hm-send, runtime POST, external action, dispatch, route change, credentials, deploy, money, and trading blocked',
    ...normalizeStaleMarkers(authority.snapshot, authority.extraStaleMarkers),
  ].slice(0, 6);
  const answerText = buildAnswerText({
    authoritySource: authority.source,
    sourceEvidence,
    targetAgent,
    proposedMessageBody,
    reason,
    blockedExclusions,
  });

  return {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: activeLane ? 'drafted_from_live_evidence' : 'drafted_no_active_lane',
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    answer_text: answerText,
    james_action_line_count: countJamesActionLines(answerText),
    source_evidence: sourceEvidence,
    target_agent: targetAgent,
    proposed_message_body: proposedMessageBody,
    reason_trigger: reason,
    blocked_parked_exclusions: blockedExclusions,
    current_lane: activeLane,
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
      no_hm_send: true,
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_model_call: true,
      no_writes: true,
      draft_only: true,
      read_only_sources: ['.squidrun/handoffs/current-lane.json', 'evidence-ledger/comms_journal'],
    },
  };
}

module.exports = {
  SCHEMA,
  VERSION,
  buildMiraLiveInternalRequestDraftV0,
  countJamesActionLines,
  isMiraLiveInternalRequestDraftPrompt,
};
