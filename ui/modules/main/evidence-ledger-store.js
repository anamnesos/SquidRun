/**
 * Evidence Ledger Store
 * Durable append/query store for canonical event envelopes.
 *
 * SQLite Driver Matrix:
 * - Electron runtime (Node 18 in this app): use better-sqlite3.
 * - CLI scripts (system Node 22+): use node:sqlite.
 * Why: node:sqlite is not available in Electron's current bundled Node runtime.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');
const {
  resolveCoordPath,
  evidenceLedgerEnabled: CONFIG_EVIDENCE_LEDGER_ENABLED,
} = require('../../config');
const { prepareEventForStorage } = require('./evidence-ledger-ingest');

function resolveDefaultDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/evidence-ledger.db');
  }
  return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();
const DEFAULT_MAX_ROWS = 2_000_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGGED_DEGRADE_KEYS = new Set();

function logDegradedOnce(level, key, message) {
  if (LOGGED_DEGRADE_KEYS.has(key)) return;
  LOGGED_DEGRADE_KEYS.add(key);
  const logger = (level === 'error') ? log.error : (level === 'info' ? log.info : log.warn);
  logger('EvidenceLedger', message);
}

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS ledger_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_event_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  pane_id TEXT,
  role TEXT,
  ts_ms INTEGER NOT NULL,
  seq INTEGER,
  direction TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT,
  evidence_refs_json TEXT,
  meta_json TEXT,
  ingested_at_ms INTEGER NOT NULL,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS ledger_edges (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  from_event_id TEXT NOT NULL,
  to_event_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(trace_id, from_event_id, to_event_id, edge_type)
);

CREATE TABLE IF NOT EXISTS ledger_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  pane_id TEXT,
  role TEXT,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  status TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ledger_events_trace_ts
  ON ledger_events(trace_id, ts_ms, row_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_type_ts
  ON ledger_events(type, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_stage_ts
  ON ledger_events(stage, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_pane_ts
  ON ledger_events(pane_id, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_parent
  ON ledger_events(parent_event_id);

CREATE INDEX IF NOT EXISTS idx_ledger_edges_trace
  ON ledger_edges(trace_id, created_at_ms);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS ledger_incidents (
  incident_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  session_id TEXT,
  tags_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_updated
  ON ledger_incidents(status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_session
  ON ledger_incidents(session_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS ledger_incident_traces (
  incident_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  linked_by TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (incident_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_traces_trace
  ON ledger_incident_traces(trace_id);

CREATE TABLE IF NOT EXISTS ledger_assertions (
  assertion_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'hypothesis',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  author TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  superseded_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  reasoning TEXT,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_assertions_incident
  ON ledger_assertions(incident_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_assertions_status
  ON ledger_assertions(status, confidence DESC);

CREATE TABLE IF NOT EXISTS ledger_evidence_bindings (
  binding_id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',
  event_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  file_path TEXT,
  file_line INTEGER,
  file_column INTEGER,
  snapshot_hash TEXT,
  log_start_ms INTEGER,
  log_end_ms INTEGER,
  log_source TEXT,
  log_filter_json TEXT,
  query_json TEXT,
  query_result_hash TEXT,
  note TEXT,
  created_at_ms INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bindings_assertion
  ON ledger_evidence_bindings(assertion_id);

CREATE INDEX IF NOT EXISTS idx_bindings_incident
  ON ledger_evidence_bindings(incident_id);

CREATE INDEX IF NOT EXISTS idx_bindings_event
  ON ledger_evidence_bindings(event_id);

CREATE TABLE IF NOT EXISTS ledger_verdicts (
  verdict_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT,
  key_assertion_ids_json TEXT DEFAULT '[]',
  author TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_verdicts_incident_version
  ON ledger_verdicts(incident_id, version DESC);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS ledger_decisions (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  incident_id TEXT,
  tags_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_category_status
  ON ledger_decisions(category, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON ledger_decisions(session_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_status_updated
  ON ledger_decisions(status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS ledger_sessions (
  session_id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'PTY',
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  summary TEXT,
  stats_json TEXT DEFAULT '{}',
  team_json TEXT DEFAULT '{}',
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_number
  ON ledger_sessions(session_number DESC);

CREATE TABLE IF NOT EXISTS ledger_context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_snapshots_session
  ON ledger_context_snapshots(session_id, created_at_ms DESC);
`;

const SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS comms_journal (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  sender_role TEXT,
  target_role TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('ws', 'telegram', 'sms', 'user', 'voice')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at_ms INTEGER,
  brokered_at_ms INTEGER,
  raw_body TEXT,
  body_hash TEXT,
  body_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'brokered', 'routed', 'acked', 'failed')),
  ack_status TEXT,
  error_code TEXT,
  attempt INTEGER,
  metadata_json TEXT DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comms_journal_session_brokered
  ON comms_journal(session_id, brokered_at_ms);

CREATE INDEX IF NOT EXISTS idx_comms_journal_status
  ON comms_journal(status);

CREATE INDEX IF NOT EXISTS idx_comms_journal_sender_brokered
  ON comms_journal(sender_role, brokered_at_ms);
`;

const SCHEMA_V5_SQL = `
CREATE TABLE IF NOT EXISTS telegram_reply_obligations (
  obligation_id TEXT PRIMARY KEY,
  inbound_message_id TEXT NOT NULL UNIQUE,
  chat_id TEXT,
  session_id TEXT,
  pane_id TEXT,
  window_key TEXT,
  profile_name TEXT,
  sender_role TEXT,
  target_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'satisfied', 'expired', 'escalated')),
  opened_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  last_transition_at_ms INTEGER NOT NULL,
  satisfied_at_ms INTEGER,
  satisfied_by_message_id TEXT,
  satisfied_by_row_id INTEGER,
  satisfaction_source TEXT,
  expired_at_ms INTEGER,
  escalated_at_ms INTEGER,
  metadata_json TEXT DEFAULT '{}',
  satisfaction_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_reply_obligations_status_deadline
  ON telegram_reply_obligations(status, deadline_at_ms);

CREATE INDEX IF NOT EXISTS idx_telegram_reply_obligations_session_chat
  ON telegram_reply_obligations(session_id, chat_id, opened_at_ms);

CREATE INDEX IF NOT EXISTS idx_telegram_reply_obligations_inbound
  ON telegram_reply_obligations(inbound_message_id);
`;

const SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS arm_registries (
  registry_id TEXT PRIMARY KEY,
  app_room_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  main_session_id TEXT,
  lead_role TEXT,
  lead_pane_id TEXT,
  route_target TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'blocked')) DEFAULT 'active',
  desired_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at_ms INTEGER,
  metadata_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(app_room_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_arm_registries_room_session
  ON arm_registries(app_room_id, session_id);

CREATE INDEX IF NOT EXISTS idx_arm_registries_status_updated
  ON arm_registries(status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS arm_registry_arms (
  arm_id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL,
  app_room_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  arm_key TEXT NOT NULL,
  role TEXT NOT NULL,
  pane_id TEXT,
  route_target TEXT,
  arm_kind TEXT NOT NULL DEFAULT 'domain',
  display_name TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('desired', 'ready', 'missing', 'disabled')) DEFAULT 'desired',
  data_sources_json TEXT DEFAULT '[]',
  permissions_json TEXT DEFAULT '{}',
  check_in_obligation_json TEXT DEFAULT '{}',
  check_in_deadline_at_ms INTEGER,
  last_proof_refs_json TEXT DEFAULT '[]',
  metadata_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(registry_id, arm_key)
);

CREATE INDEX IF NOT EXISTS idx_arm_registry_arms_registry
  ON arm_registry_arms(registry_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_arm_registry_arms_room_session_role
  ON arm_registry_arms(app_room_id, session_id, role);
`;

const SCHEMA_V7_SQL = `
CREATE TABLE IF NOT EXISTS arm_checkin_proofs (
  checkin_id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  app_room_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  arm_key TEXT NOT NULL,
  role TEXT NOT NULL,
  pane_id TEXT,
  route_target TEXT,
  proof_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')) DEFAULT 'accepted',
  rejected_reason TEXT,
  message_id TEXT,
  comms_row_id INTEGER,
  raw_role_marker TEXT,
  env_json TEXT DEFAULT '{}',
  proof_refs_json TEXT DEFAULT '[]',
  metadata_json TEXT DEFAULT '{}',
  checked_in_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arm_checkin_proofs_registry_status
  ON arm_checkin_proofs(registry_id, status, checked_in_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_arm_checkin_proofs_arm_status
  ON arm_checkin_proofs(arm_id, status, checked_in_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_arm_checkin_proofs_room_session_role
  ON arm_checkin_proofs(app_room_id, session_id, role, checked_in_at_ms DESC);
`;

const SCHEMA_V8_SQL = `
CREATE TABLE IF NOT EXISTS arm_missing_watchdogs (
  watchdog_id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  app_room_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  arm_key TEXT NOT NULL,
  role TEXT NOT NULL,
  pane_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('expected', 'nudged', 'escalated', 'satisfied')) DEFAULT 'expected',
  expected_at_ms INTEGER NOT NULL,
  nudge_due_at_ms INTEGER NOT NULL,
  nudged_at_ms INTEGER,
  escalate_due_at_ms INTEGER,
  escalated_at_ms INTEGER,
  satisfied_at_ms INTEGER,
  last_action_key TEXT,
  last_action_at_ms INTEGER,
  last_error TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(registry_id, arm_id, expected_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_arm_missing_watchdogs_registry_status
  ON arm_missing_watchdogs(registry_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_arm_missing_watchdogs_arm_status
  ON arm_missing_watchdogs(arm_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_arm_missing_watchdogs_due
  ON arm_missing_watchdogs(status, nudge_due_at_ms, escalate_due_at_ms);
`;

const COMMS_CHANNELS = new Set(['ws', 'telegram', 'sms', 'user', 'voice']);
const COMMS_DIRECTIONS = new Set(['inbound', 'outbound']);
const COMMS_STATUS_RANK = Object.freeze({
  recorded: 1,
  brokered: 2,
  routed: 3,
  acked: 4,
  failed: 4,
});
const DEFAULT_TELEGRAM_REPLY_OBLIGATION_WINDOW_MS = 5 * 60 * 1000;
const TELEGRAM_REPLY_OBLIGATION_STATUSES = new Set(['open', 'satisfied', 'expired', 'escalated']);
const TERMINAL_TELEGRAM_REPLY_OBLIGATION_STATUSES = new Set(['satisfied', 'expired', 'escalated']);
const ARM_REGISTRY_STATUSES = new Set(['active', 'retired', 'blocked']);
const ARM_STATUSES = new Set(['desired', 'ready', 'missing', 'disabled']);
const ARM_CHECKIN_STATUSES = new Set(['accepted', 'rejected']);
const IDENTITY_PROOF_KINDS = new Set(['role_check_in', 'startup_check_in', 'manual_check_in']);
const ARM_MISSING_WATCHDOG_STATUSES = new Set(['expected', 'nudged', 'escalated', 'satisfied']);
const DEFAULT_ARM_MISSING_NUDGE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_ARM_MISSING_ESCALATE_AFTER_NUDGE_MS = 4 * 60 * 1000;

function toMs(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function parseJson(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function toOptionalMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function normalizeCommsChannel(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return COMMS_CHANNELS.has(normalized) ? normalized : null;
}

function normalizeCommsDirection(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return COMMS_DIRECTIONS.has(normalized) ? normalized : null;
}

function normalizeCommsStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return Object.prototype.hasOwnProperty.call(COMMS_STATUS_RANK, normalized) ? normalized : null;
}

function statusRank(status) {
  if (!status) return 0;
  return COMMS_STATUS_RANK[status] || 0;
}

function chooseProgressedStatus(currentStatus, nextStatus) {
  if (!nextStatus) return currentStatus || null;
  if (!currentStatus) return nextStatus;
  return statusRank(nextStatus) >= statusRank(currentStatus) ? nextStatus : currentStatus;
}

function toOptionalAttempt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function mergeMetadata(existing, incoming) {
  const left = ensureObject(existing);
  const right = ensureObject(incoming);
  return {
    ...left,
    ...right,
  };
}

function hashBody(rawBody) {
  return crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

function mapCommsRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    rowId: row.row_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    senderRole: row.sender_role,
    targetRole: row.target_role,
    channel: row.channel,
    direction: row.direction,
    sentAtMs: row.sent_at_ms,
    brokeredAtMs: row.brokered_at_ms,
    rawBody: row.raw_body,
    bodyHash: row.body_hash,
    bodyBytes: row.body_bytes,
    status: row.status,
    ackStatus: row.ack_status,
    errorCode: row.error_code,
    attempt: row.attempt,
    metadata: parseJson(row.metadata_json, {}),
    updatedAtMs: row.updated_at_ms,
  };
}

function normalizeTelegramReplyObligationStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (TELEGRAM_REPLY_OBLIGATION_STATUSES.has(normalized)) return normalized;
  if ([
    'pending',
    'pending_telegram_egress',
    'telegram_reply_required_unresolved',
    'telegram_reply_required_agent_alerted',
    'telegram_reply_required_agent_alert_failed',
  ].includes(normalized)) {
    return 'open';
  }
  if ([
    'telegram_reply_requirement_satisfied_by_journal',
    'telegram_reply_requirement_satisfied',
  ].includes(normalized)) {
    return 'satisfied';
  }
  if ([
    'telegram_reply_required_expired_unresolved',
    'telegram_reply_requirement_expired_unresolved',
  ].includes(normalized)) {
    return 'expired';
  }
  if ([
    'telegram_reply_required_phone_escalated',
    'telegram_reply_required_phone_escalated_unresolved',
    'telegram_reply_requirement_phone_escalated_unresolved',
  ].includes(normalized)) {
    return 'escalated';
  }
  return null;
}

function isTerminalTelegramReplyObligationStatus(status) {
  return TERMINAL_TELEGRAM_REPLY_OBLIGATION_STATUSES.has(String(status || '').toLowerCase());
}

function buildTelegramReplyObligationId(inboundMessageId) {
  const digest = crypto.createHash('sha256').update(String(inboundMessageId), 'utf8').digest('hex').slice(0, 16);
  return `telegram-reply-${digest}`;
}

function normalizeArmRegistryStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return ARM_REGISTRY_STATUSES.has(normalized) ? normalized : null;
}

function normalizeArmStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return ARM_STATUSES.has(normalized) ? normalized : null;
}

function normalizeArmCheckinStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return ARM_CHECKIN_STATUSES.has(normalized) ? normalized : null;
}

function normalizeArmMissingWatchdogStatus(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  return ARM_MISSING_WATCHDOG_STATUSES.has(normalized) ? normalized : null;
}

function normalizeArmIdentityProofKind(value) {
  const text = toOptionalString(value, null);
  if (!text) return 'role_check_in';
  const normalized = text.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return normalized || 'role_check_in';
}

function isArmIdentityProofKind(value) {
  return IDENTITY_PROOF_KINDS.has(normalizeArmIdentityProofKind(value));
}

function buildStableHashId(prefix, parts = []) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('\u001f'), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

function normalizeArmKey(value, fallback) {
  const text = toOptionalString(value, null) || toOptionalString(fallback, null);
  if (!text) return null;
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function mapTelegramReplyObligationRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    obligationId: row.obligation_id,
    inboundMessageId: row.inbound_message_id,
    chatId: row.chat_id,
    sessionId: row.session_id,
    paneId: row.pane_id,
    windowKey: row.window_key,
    profileName: row.profile_name,
    senderRole: row.sender_role,
    targetRole: row.target_role,
    status: row.status,
    openedAtMs: row.opened_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    lastTransitionAtMs: row.last_transition_at_ms,
    satisfiedAtMs: row.satisfied_at_ms,
    satisfiedByMessageId: row.satisfied_by_message_id,
    satisfiedByRowId: row.satisfied_by_row_id,
    satisfactionSource: row.satisfaction_source,
    expiredAtMs: row.expired_at_ms,
    escalatedAtMs: row.escalated_at_ms,
    metadata: parseJson(row.metadata_json, {}),
    satisfaction: parseJson(row.satisfaction_json, {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapArmRegistryArmRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    armId: row.arm_id,
    registryId: row.registry_id,
    appRoomId: row.app_room_id,
    sessionId: row.session_id,
    armKey: row.arm_key,
    role: row.role,
    paneId: row.pane_id,
    routeTarget: row.route_target,
    armKind: row.arm_kind,
    displayName: row.display_name,
    required: Number(row.required || 0) === 1,
    status: row.status,
    dataSources: parseJson(row.data_sources_json, []),
    permissions: parseJson(row.permissions_json, {}),
    checkInObligation: parseJson(row.check_in_obligation_json, {}),
    checkInDeadlineAtMs: row.check_in_deadline_at_ms,
    lastProofRefs: parseJson(row.last_proof_refs_json, []),
    metadata: parseJson(row.metadata_json, {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapArmRegistryRow(row, arms = []) {
  if (!row || typeof row !== 'object') return null;
  return {
    registryId: row.registry_id,
    appRoomId: row.app_room_id,
    sessionId: row.session_id,
    mainSessionId: row.main_session_id,
    leadRole: row.lead_role,
    leadPaneId: row.lead_pane_id,
    routeTarget: row.route_target,
    status: row.status,
    desiredCount: row.desired_count,
    readyCount: row.ready_count,
    missingCount: row.missing_count,
    lastEvaluatedAtMs: row.last_evaluated_at_ms,
    metadata: parseJson(row.metadata_json, {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    arms,
  };
}

function mapArmCheckinProofRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    checkinId: row.checkin_id,
    registryId: row.registry_id,
    armId: row.arm_id,
    appRoomId: row.app_room_id,
    sessionId: row.session_id,
    armKey: row.arm_key,
    role: row.role,
    paneId: row.pane_id,
    routeTarget: row.route_target,
    proofKind: row.proof_kind,
    status: row.status,
    rejectedReason: row.rejected_reason,
    messageId: row.message_id,
    commsRowId: row.comms_row_id,
    rawRoleMarker: row.raw_role_marker,
    env: parseJson(row.env_json, {}),
    proofRefs: parseJson(row.proof_refs_json, []),
    metadata: parseJson(row.metadata_json, {}),
    checkedInAtMs: row.checked_in_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapArmMissingWatchdogRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    watchdogId: row.watchdog_id,
    registryId: row.registry_id,
    armId: row.arm_id,
    appRoomId: row.app_room_id,
    sessionId: row.session_id,
    armKey: row.arm_key,
    role: row.role,
    paneId: row.pane_id,
    status: row.status,
    expectedAtMs: row.expected_at_ms,
    nudgeDueAtMs: row.nudge_due_at_ms,
    nudgedAtMs: row.nudged_at_ms,
    escalateDueAtMs: row.escalate_due_at_ms,
    escalatedAtMs: row.escalated_at_ms,
    satisfiedAtMs: row.satisfied_at_ms,
    lastActionKey: row.last_action_key,
    lastActionAtMs: row.last_action_at_ms,
    lastError: row.last_error,
    metadata: parseJson(row.metadata_json, {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function loadSqliteDriver() {
  try {
    // CLI path (Node 22+): prefer built-in sqlite.
     
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      return {
        name: 'node:sqlite',
        create: (filename) => new mod.DatabaseSync(filename),
      };
    }
  } catch {
    // Continue to external driver fallback.
  }

  try {
    // Electron runtime fallback (Node 18): native addon driver.
     
    const BetterSqlite3 = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      create: (filename) => new BetterSqlite3(filename),
    };
  } catch {
    return null;
  }
}

class EvidenceLedgerStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || resolveDefaultDbPath();
    this.maxRows = Math.max(1, Number(options.maxRows) || DEFAULT_MAX_ROWS);
    this.retentionMs = Math.max(1_000, Number(options.retentionMs) || DEFAULT_RETENTION_MS);
    this.sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    this.configEnabled = CONFIG_EVIDENCE_LEDGER_ENABLED !== false;
    this.enabled = this.configEnabled && options.enabled !== false;

    this.db = null;
    this.driverName = null;
    this.available = false;
    this.degradedReason = null;
  }

  init() {
    if (this.isAvailable()) {
      return { ok: true, driver: this.driverName, dbPath: this.dbPath };
    }

    if (!this.enabled) {
      this.degradedReason = 'disabled';
      logDegradedOnce('warn', 'disabled', 'Ledger disabled by config/flag; running in degraded mode');
      return { ok: false, reason: this.degradedReason };
    }

    try {
      const runtimeDir = path.dirname(this.dbPath);
      fs.mkdirSync(runtimeDir, { recursive: true });
    } catch (err) {
      this.degradedReason = `runtime_dir_error:${err.message}`;
      logDegradedOnce('error', 'runtime_dir_error', `Failed to create runtime dir: ${err.message}`);
      return { ok: false, reason: this.degradedReason };
    }

    const driver = loadSqliteDriver();
    if (!driver) {
      this.degradedReason = 'sqlite_driver_unavailable';
      logDegradedOnce('warn', 'sqlite_driver_unavailable', 'SQLite driver unavailable (node:sqlite/better-sqlite3 missing)');
      return { ok: false, reason: this.degradedReason };
    }

    try {
      this.db = driver.create(this.dbPath);
      this.driverName = driver.name;
      log.info('EvidenceLedger', `SQLite driver selected: ${this.driverName} (Node ${process.versions.node})`);
      this._applyPragmas();
      this._migrate();
      this.available = true;
      this.degradedReason = null;
      return { ok: true, driver: this.driverName, dbPath: this.dbPath };
    } catch (err) {
      this.available = false;
      this.db = null;
      this.degradedReason = `open_failed:${err.message}`;
      logDegradedOnce('error', 'open_failed', `Failed to initialize store: ${err.message}`);
      return { ok: false, reason: this.degradedReason };
    }
  }

  _applyPragmas() {
    if (!this.db) return;
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
  }

  _migrate() {
    if (!this.db) return;
    this.db.exec(SCHEMA_V1_SQL);
    this.db.exec(SCHEMA_V2_SQL);
    this.db.exec(SCHEMA_V3_SQL);
    this.db.exec(SCHEMA_V4_SQL);
    this._migrateCommsJournalVoiceChannel();
    this.db.exec(SCHEMA_V4_SQL);
    this.db.exec(SCHEMA_V5_SQL);
    this.db.exec(SCHEMA_V6_SQL);
    this.db.exec(SCHEMA_V7_SQL);
    this.db.exec(SCHEMA_V8_SQL);
  }

  _migrateCommsJournalVoiceChannel() {
    if (!this.db) return;
    const row = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'comms_journal'
    `).get();
    const sql = String(row?.sql || '');
    if (!sql || sql.includes("'voice'")) return;

    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS comms_journal_voice_migration_old;
      ALTER TABLE comms_journal RENAME TO comms_journal_voice_migration_old;
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        sender_role TEXT,
        target_role TEXT,
        channel TEXT NOT NULL CHECK (channel IN ('ws', 'telegram', 'sms', 'user', 'voice')),
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        sent_at_ms INTEGER,
        brokered_at_ms INTEGER,
        raw_body TEXT,
        body_hash TEXT,
        body_bytes INTEGER,
        status TEXT NOT NULL CHECK (status IN ('recorded', 'brokered', 'routed', 'acked', 'failed')),
        ack_status TEXT,
        error_code TEXT,
        attempt INTEGER,
        metadata_json TEXT DEFAULT '{}',
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO comms_journal (
        row_id, message_id, session_id, sender_role, target_role, channel, direction,
        sent_at_ms, brokered_at_ms, raw_body, body_hash, body_bytes, status,
        ack_status, error_code, attempt, metadata_json, updated_at_ms
      )
      SELECT
        row_id, message_id, session_id, sender_role, target_role, channel, direction,
        sent_at_ms, brokered_at_ms, raw_body, body_hash, body_bytes, status,
        ack_status, error_code, attempt, metadata_json, updated_at_ms
      FROM comms_journal_voice_migration_old;
      DROP TABLE comms_journal_voice_migration_old;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  isAvailable() {
    return this.available && Boolean(this.db);
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      driver: this.driverName,
      dbPath: this.dbPath,
      maxRows: this.maxRows,
      retentionMs: this.retentionMs,
      configEnabled: this.configEnabled,
      degradedReason: this.degradedReason,
    };
  }

  appendEvent(event, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const prepared = prepareEventForStorage(event, {
      sessionId: options.sessionId || this.sessionId,
      ingestedAtMs: options.ingestedAtMs,
      nowMs: options.nowMs,
    });

    if (!prepared.validation.valid) {
      return {
        ok: false,
        status: 'invalid',
        errors: prepared.validation.errors,
        eventId: prepared.normalized.eventId,
      };
    }

    const inserted = this._insertPrepared(prepared);
    return {
      ok: true,
      status: inserted ? 'inserted' : 'duplicate',
      inserted,
      eventId: prepared.normalized.eventId,
      traceId: prepared.normalized.traceId,
      edgeCount: prepared.edges.length,
    };
  }

  appendBatch(events, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) {
      return { ok: true, status: 'no_events', requested: 0, inserted: 0, duplicates: 0, invalid: 0 };
    }

    const preparedList = list.map((event) => prepareEventForStorage(event, {
      sessionId: options.sessionId || this.sessionId,
      ingestedAtMs: options.ingestedAtMs,
      nowMs: options.nowMs,
    }));

    let inserted = 0;
    let duplicates = 0;
    let invalid = 0;

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      for (const prepared of preparedList) {
        if (!prepared.validation.valid) {
          invalid += 1;
          continue;
        }
        if (this._insertPrepared(prepared)) {
          inserted += 1;
        } else {
          duplicates += 1;
        }
      }
      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'committed',
        requested: list.length,
        inserted,
        duplicates,
        invalid,
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        error: err.message,
        requested: list.length,
        inserted,
        duplicates,
        invalid,
      };
    }
  }

  _insertPrepared(prepared) {
    const row = prepared.row;
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_events (
        event_id, trace_id, span_id, parent_event_id, correlation_id, causation_id,
        type, stage, source, pane_id, role, ts_ms, seq, direction,
        payload_json, payload_hash, evidence_refs_json, meta_json, ingested_at_ms, session_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    const eventResult = insertEvent.run(
      row.event_id,
      row.trace_id,
      row.span_id,
      row.parent_event_id,
      row.correlation_id,
      row.causation_id,
      row.type,
      row.stage,
      row.source,
      row.pane_id,
      row.role,
      row.ts_ms,
      row.seq,
      row.direction,
      row.payload_json,
      row.payload_hash,
      row.evidence_refs_json,
      row.meta_json,
      row.ingested_at_ms,
      row.session_id
    );

    if (Number(eventResult?.changes || 0) === 0) {
      return false;
    }

    if (prepared.edges.length > 0) {
      const insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO ledger_edges (
          trace_id, from_event_id, to_event_id, edge_type, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const edge of prepared.edges) {
        insertEdge.run(
          edge.trace_id,
          edge.from_event_id,
          edge.to_event_id,
          edge.edge_type,
          edge.created_at_ms
        );
      }
    }

    return true;
  }

  queryTrace(traceId, options = {}) {
    if (!this.isAvailable()) return { traceId, events: [], edges: [] };
    if (typeof traceId !== 'string' || !traceId.trim()) return { traceId, events: [], edges: [] };

    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 1000));
    const includeEdges = options.includeEdges !== false;

    const stmt = this.db.prepare(`
      SELECT * FROM ledger_events
      WHERE trace_id = ?
      ORDER BY ts_ms ASC, row_id ASC
      LIMIT ?
    `);
    const rows = stmt.all(traceId.trim(), limit);
    const events = rows.map((row) => this._mapRowToEvent(row));

    let edges = [];
    if (includeEdges) {
      const edgeStmt = this.db.prepare(`
        SELECT * FROM ledger_edges
        WHERE trace_id = ?
        ORDER BY created_at_ms ASC, edge_id ASC
      `);
      edges = edgeStmt.all(traceId.trim());
    }

    return { traceId: traceId.trim(), events, edges };
  }

  queryEvents(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.traceId) {
      clauses.push('trace_id = ?');
      params.push(String(filters.traceId));
    }
    if (filters.type) {
      clauses.push('type = ?');
      params.push(String(filters.type));
    }
    if (filters.stage) {
      clauses.push('stage = ?');
      params.push(String(filters.stage));
    }
    if (filters.paneId) {
      clauses.push('pane_id = ?');
      params.push(String(filters.paneId));
    }
    if (filters.role) {
      clauses.push('role = ?');
      params.push(String(filters.role));
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('ts_ms >= ?');
      params.push(toMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('ts_ms <= ?');
      params.push(toMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY ts_ms DESC, row_id DESC'
      : 'ORDER BY ts_ms ASC, row_id ASC';
    const limit = Math.max(1, Math.min(10_000, Number(filters.limit) || 500));

    const sql = `
      SELECT * FROM ledger_events
      ${where}
      ${order}
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => this._mapRowToEvent(row));
  }

  queryCommsJournal(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.messageId) {
      clauses.push('message_id = ?');
      params.push(String(filters.messageId));
    }
    if (filters.sessionId) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId));
    }
    if (filters.channel) {
      clauses.push('channel = ?');
      params.push(String(filters.channel).toLowerCase());
    }
    if (filters.direction) {
      clauses.push('direction = ?');
      params.push(String(filters.direction).toLowerCase());
    }
    if (filters.status) {
      clauses.push('status = ?');
      params.push(String(filters.status).toLowerCase());
    }
    if (filters.senderRole) {
      clauses.push('sender_role = ?');
      params.push(String(filters.senderRole).toLowerCase());
    }
    if (filters.targetRole) {
      clauses.push('target_role = ?');
      params.push(String(filters.targetRole).toLowerCase());
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('COALESCE(brokered_at_ms, sent_at_ms, updated_at_ms) >= ?');
      params.push(toMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('COALESCE(brokered_at_ms, sent_at_ms, updated_at_ms) <= ?');
      params.push(toMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY COALESCE(brokered_at_ms, sent_at_ms, updated_at_ms) DESC, row_id DESC'
      : 'ORDER BY COALESCE(brokered_at_ms, sent_at_ms, updated_at_ms) ASC, row_id ASC';
    const limit = Math.max(1, Math.min(50_000, Number(filters.limit) || 5000));

    const sql = `
      SELECT * FROM comms_journal
      ${where}
      ${order}
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => mapCommsRow(row));
  }

  upsertCommsJournal(entry = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const messageId = toOptionalString(entry.messageId || entry.message_id, null);
    if (!messageId) {
      return { ok: false, status: 'invalid', reason: 'message_id_required' };
    }

    const channel = normalizeCommsChannel(entry.channel) || 'ws';
    const direction = normalizeCommsDirection(entry.direction) || 'outbound';
    const incomingStatus = normalizeCommsStatus(entry.status) || 'recorded';

    const rawBody = typeof entry.rawBody === 'string'
      ? entry.rawBody
      : (typeof entry.raw_body === 'string' ? entry.raw_body : '');
    const incomingBodyHash = toOptionalString(entry.bodyHash || entry.body_hash, null);
    const incomingBodyBytes = Number.isFinite(Number(entry.bodyBytes ?? entry.body_bytes))
      ? Math.max(0, Math.floor(Number(entry.bodyBytes ?? entry.body_bytes)))
      : null;

    const incomingMetadata = ensureObject(
      entry.metadata ?? entry.meta ?? entry.metadata_json
    );

    const incoming = {
      messageId,
      sessionId: toOptionalString(entry.sessionId || entry.session_id, null),
      senderRole: toOptionalString(entry.senderRole || entry.sender_role, null),
      targetRole: toOptionalString(entry.targetRole || entry.target_role, null),
      channel,
      direction,
      sentAtMs: toOptionalMs(entry.sentAtMs ?? entry.sent_at_ms),
      brokeredAtMs: toOptionalMs(entry.brokeredAtMs ?? entry.brokered_at_ms),
      rawBody,
      bodyHash: incomingBodyHash,
      bodyBytes: incomingBodyBytes,
      status: incomingStatus,
      ackStatus: toOptionalString(entry.ackStatus || entry.ack_status, null),
      errorCode: toOptionalString(entry.errorCode || entry.error_code, null),
      attempt: toOptionalAttempt(entry.attempt),
      metadata: incomingMetadata,
    };

    const existingRow = this.db.prepare('SELECT * FROM comms_journal WHERE message_id = ?').get(messageId);
    const existing = mapCommsRow(existingRow);

    const mergedRawBody = incoming.rawBody || existing?.rawBody || '';
    const mergedBodyHash = incoming.bodyHash
      || (mergedRawBody ? hashBody(mergedRawBody) : (existing?.bodyHash || null));
    const mergedBodyBytes = Number.isFinite(incoming.bodyBytes)
      ? incoming.bodyBytes
      : (mergedRawBody ? Buffer.byteLength(mergedRawBody, 'utf8') : (existing?.bodyBytes ?? 0));

    const merged = {
      messageId,
      sessionId: incoming.sessionId || existing?.sessionId || null,
      senderRole: incoming.senderRole || existing?.senderRole || null,
      targetRole: incoming.targetRole || existing?.targetRole || null,
      channel: incoming.channel || existing?.channel || 'ws',
      direction: incoming.direction || existing?.direction || 'outbound',
      sentAtMs: (
        Number.isFinite(incoming.sentAtMs) && Number.isFinite(existing?.sentAtMs)
          ? Math.min(incoming.sentAtMs, existing.sentAtMs)
          : (incoming.sentAtMs ?? existing?.sentAtMs ?? null)
      ),
      brokeredAtMs: (
        Number.isFinite(incoming.brokeredAtMs) && Number.isFinite(existing?.brokeredAtMs)
          ? Math.max(incoming.brokeredAtMs, existing.brokeredAtMs)
          : (incoming.brokeredAtMs ?? existing?.brokeredAtMs ?? null)
      ),
      rawBody: mergedRawBody,
      bodyHash: mergedBodyHash,
      bodyBytes: mergedBodyBytes,
      status: chooseProgressedStatus(existing?.status || null, incoming.status) || 'recorded',
      ackStatus: incoming.ackStatus || existing?.ackStatus || null,
      errorCode: incoming.errorCode || existing?.errorCode || null,
      attempt: (
        Number.isFinite(incoming.attempt) && Number.isFinite(existing?.attempt)
          ? Math.max(incoming.attempt, existing.attempt)
          : (incoming.attempt ?? existing?.attempt ?? null)
      ),
      metadata: mergeMetadata(existing?.metadata, incoming.metadata),
      updatedAtMs: nowMs,
    };

    const metadataJson = JSON.stringify(merged.metadata || {});

    try {
      if (!existing) {
        const insert = this.db.prepare(`
          INSERT INTO comms_journal (
            message_id, session_id, sender_role, target_role, channel, direction,
            sent_at_ms, brokered_at_ms, raw_body, body_hash, body_bytes, status,
            ack_status, error_code, attempt, metadata_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run(
          merged.messageId,
          merged.sessionId,
          merged.senderRole,
          merged.targetRole,
          merged.channel,
          merged.direction,
          merged.sentAtMs,
          merged.brokeredAtMs,
          merged.rawBody,
          merged.bodyHash,
          merged.bodyBytes,
          merged.status,
          merged.ackStatus,
          merged.errorCode,
          merged.attempt,
          metadataJson,
          merged.updatedAtMs
        );
        return { ok: true, status: 'inserted', messageId: merged.messageId };
      }

      const update = this.db.prepare(`
        UPDATE comms_journal
        SET
          session_id = ?,
          sender_role = ?,
          target_role = ?,
          channel = ?,
          direction = ?,
          sent_at_ms = ?,
          brokered_at_ms = ?,
          raw_body = ?,
          body_hash = ?,
          body_bytes = ?,
          status = ?,
          ack_status = ?,
          error_code = ?,
          attempt = ?,
          metadata_json = ?,
          updated_at_ms = ?
        WHERE message_id = ?
      `);
      update.run(
        merged.sessionId,
        merged.senderRole,
        merged.targetRole,
        merged.channel,
        merged.direction,
        merged.sentAtMs,
        merged.brokeredAtMs,
        merged.rawBody,
        merged.bodyHash,
        merged.bodyBytes,
        merged.status,
        merged.ackStatus,
        merged.errorCode,
        merged.attempt,
        metadataJson,
        merged.updatedAtMs,
        merged.messageId
      );
      return { ok: true, status: 'updated', messageId: merged.messageId };
    } catch (err) {
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        messageId,
      };
    }
  }

  queryArmRegistryArms(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.registryId) {
      clauses.push('registry_id = ?');
      params.push(String(filters.registryId));
    }
    if (filters.appRoomId || filters.app_room_id) {
      clauses.push('app_room_id = ?');
      params.push(String(filters.appRoomId || filters.app_room_id));
    }
    if (filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id));
    }
    if (filters.role) {
      clauses.push('role = ?');
      params.push(String(filters.role));
    }
    if (filters.armKey || filters.arm_key) {
      clauses.push('arm_key = ?');
      params.push(String(filters.armKey || filters.arm_key));
    }
    if (filters.status) {
      const status = normalizeArmStatus(filters.status);
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY updated_at_ms DESC, arm_key DESC'
      : 'ORDER BY arm_key ASC, updated_at_ms ASC';
    const limit = Math.max(1, Math.min(10_000, Number(filters.limit) || 1000));

    const rows = this.db.prepare(`
      SELECT * FROM arm_registry_arms
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => mapArmRegistryArmRow(row));
  }

  queryArmRegistries(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.registryId || filters.registry_id) {
      clauses.push('registry_id = ?');
      params.push(String(filters.registryId || filters.registry_id));
    }
    if (filters.appRoomId || filters.app_room_id) {
      clauses.push('app_room_id = ?');
      params.push(String(filters.appRoomId || filters.app_room_id));
    }
    if (filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id));
    }
    if (filters.status) {
      const status = normalizeArmRegistryStatus(filters.status);
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY updated_at_ms DESC, registry_id DESC'
      : 'ORDER BY updated_at_ms ASC, registry_id ASC';
    const limit = Math.max(1, Math.min(10_000, Number(filters.limit) || 1000));

    const rows = this.db.prepare(`
      SELECT * FROM arm_registries
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);

    const withArms = filters.withArms !== false;
    return rows.map((row) => {
      const arms = withArms
        ? this.queryArmRegistryArms({ registryId: row.registry_id, limit: 10_000 })
        : [];
      return mapArmRegistryRow(row, arms);
    });
  }

  getArmRegistryManifest(filters = {}) {
    return this.queryArmRegistries({ ...filters, limit: 1 })[0] || null;
  }

  upsertArmRegistryManifest(input = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const appRoomId = toOptionalString(input.appRoomId || input.app_room_id || input.roomId || input.room_id, null);
    const sessionId = toOptionalString(
      input.sessionId || input.session_id || input.sessionScopeId || input.session_scope_id,
      null
    );
    if (!appRoomId) {
      return { ok: false, status: 'invalid', reason: 'app_room_id_required' };
    }
    if (!sessionId) {
      return { ok: false, status: 'invalid', reason: 'session_id_required' };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const existingRow = this.db.prepare(`
      SELECT * FROM arm_registries
      WHERE registry_id = ?
         OR (app_room_id = ? AND session_id = ?)
      LIMIT 1
    `).get(
      toOptionalString(input.registryId || input.registry_id, buildStableHashId('arm-registry', [appRoomId, sessionId])),
      appRoomId,
      sessionId
    );
    const existing = mapArmRegistryRow(existingRow, []);
    const registryId = existing?.registryId
      || toOptionalString(input.registryId || input.registry_id, null)
      || buildStableHashId('arm-registry', [appRoomId, sessionId]);
    const metadata = mergeMetadata(existing?.metadata, ensureObject(input.metadata ?? input.meta ?? input.metadata_json));
    const armsInput = ensureArray(input.arms || input.desiredArms || input.desired_arms);
    const existingArms = this.queryArmRegistryArms({ registryId, limit: 10_000 });
    const existingArmByKey = new Map(existingArms.map((arm) => [arm.armKey, arm]));
    const normalizedArms = [];

    for (const rawArm of armsInput) {
      const arm = ensureObject(rawArm);
      const role = toOptionalString(arm.role, null);
      const armKey = normalizeArmKey(arm.armKey || arm.arm_key || arm.key, role || arm.displayName || arm.display_name);
      if (!armKey || !role) continue;
      const required = arm.required !== false && arm.optional !== true;
      const existingArm = existingArmByKey.get(armKey);
      const preservedReadyStatus = existingArm && ['ready', 'missing'].includes(existingArm.status)
        ? existingArm.status
        : null;
      normalizedArms.push({
        armId: existingArm?.armId || toOptionalString(arm.armId || arm.arm_id, null)
          || buildStableHashId('arm', [registryId, armKey]),
        armKey,
        role,
        paneId: toOptionalString(arm.paneId || arm.pane_id, null),
        routeTarget: toOptionalString(arm.routeTarget || arm.route_target || arm.target, null),
        armKind: toOptionalString(arm.armKind || arm.arm_kind || arm.kind, 'domain') || 'domain',
        displayName: toOptionalString(arm.displayName || arm.display_name || arm.label, null),
        required,
        status: required ? (preservedReadyStatus || 'desired') : 'disabled',
        dataSources: ensureArray(arm.dataSources || arm.data_sources),
        permissions: ensureObject(arm.permissions || arm.permissionModel || arm.permission_model),
        checkInObligation: ensureObject(arm.checkInObligation || arm.check_in_obligation),
        checkInDeadlineAtMs: toOptionalMs(arm.checkInDeadlineAtMs ?? arm.check_in_deadline_at_ms ?? arm.deadlineAtMs),
        lastProofRefs: ensureArray(existingArm?.lastProofRefs),
        metadata: mergeMetadata(existingArm?.metadata, ensureObject(arm.metadata ?? arm.meta)),
      });
    }

    const incomingKeys = new Set(normalizedArms.map((arm) => arm.armKey));
    const replaceArms = options.replaceArms !== false && armsInput.length > 0;
    const countSourceArms = armsInput.length > 0 ? normalizedArms : existingArms;
    const activeRequiredArms = countSourceArms.filter((arm) => arm.required && arm.status !== 'disabled');
    const readyCount = activeRequiredArms.filter((arm) => arm.status === 'ready').length;
    const desiredCount = activeRequiredArms.length;
    const missingCount = Math.max(0, desiredCount - readyCount);
    const registryStatus = normalizeArmRegistryStatus(input.status) || existing?.status || 'active';

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      if (!existing) {
        this.db.prepare(`
          INSERT INTO arm_registries (
            registry_id, app_room_id, session_id, main_session_id, lead_role, lead_pane_id,
            route_target, status, desired_count, ready_count, missing_count,
            last_evaluated_at_ms, metadata_json, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          registryId,
          appRoomId,
          sessionId,
          toOptionalString(input.mainSessionId || input.main_session_id || input.mainSessionScopeId, null),
          toOptionalString(input.leadRole || input.lead_role, null),
          toOptionalString(input.leadPaneId || input.lead_pane_id, null),
          toOptionalString(input.routeTarget || input.route_target, null),
          registryStatus,
          desiredCount,
          readyCount,
          missingCount,
          nowMs,
          JSON.stringify(metadata),
          nowMs,
          nowMs
        );
      } else {
        this.db.prepare(`
          UPDATE arm_registries
          SET
            main_session_id = COALESCE(?, main_session_id),
            lead_role = COALESCE(?, lead_role),
            lead_pane_id = COALESCE(?, lead_pane_id),
            route_target = COALESCE(?, route_target),
            status = ?,
            desired_count = ?,
            ready_count = ?,
            missing_count = ?,
            last_evaluated_at_ms = ?,
            metadata_json = ?,
            updated_at_ms = ?
          WHERE registry_id = ?
        `).run(
          toOptionalString(input.mainSessionId || input.main_session_id || input.mainSessionScopeId, null),
          toOptionalString(input.leadRole || input.lead_role, null),
          toOptionalString(input.leadPaneId || input.lead_pane_id, null),
          toOptionalString(input.routeTarget || input.route_target, null),
          registryStatus,
          desiredCount,
          readyCount,
          missingCount,
          nowMs,
          JSON.stringify(metadata),
          nowMs,
          registryId
        );
      }

      for (const arm of normalizedArms) {
        const existingArm = existingArmByKey.get(arm.armKey);
        if (!existingArm) {
          this.db.prepare(`
            INSERT INTO arm_registry_arms (
              arm_id, registry_id, app_room_id, session_id, arm_key, role, pane_id,
              route_target, arm_kind, display_name, required, status, data_sources_json,
              permissions_json, check_in_obligation_json, check_in_deadline_at_ms,
              last_proof_refs_json, metadata_json, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            arm.armId,
            registryId,
            appRoomId,
            sessionId,
            arm.armKey,
            arm.role,
            arm.paneId,
            arm.routeTarget,
            arm.armKind,
            arm.displayName,
            arm.required ? 1 : 0,
            arm.status,
            JSON.stringify(arm.dataSources),
            JSON.stringify(arm.permissions),
            JSON.stringify(arm.checkInObligation),
            arm.checkInDeadlineAtMs,
            JSON.stringify(arm.lastProofRefs),
            JSON.stringify(arm.metadata),
            nowMs,
            nowMs
          );
          continue;
        }

        this.db.prepare(`
          UPDATE arm_registry_arms
          SET
            role = ?,
            pane_id = COALESCE(?, pane_id),
            route_target = COALESCE(?, route_target),
            arm_kind = ?,
            display_name = COALESCE(?, display_name),
            required = ?,
            status = ?,
            data_sources_json = ?,
            permissions_json = ?,
            check_in_obligation_json = ?,
            check_in_deadline_at_ms = ?,
            last_proof_refs_json = ?,
            metadata_json = ?,
            updated_at_ms = ?
          WHERE arm_id = ?
        `).run(
          arm.role,
          arm.paneId,
          arm.routeTarget,
          arm.armKind,
          arm.displayName,
          arm.required ? 1 : 0,
          arm.status,
          JSON.stringify(arm.dataSources),
          JSON.stringify(arm.permissions),
          JSON.stringify(arm.checkInObligation),
          arm.checkInDeadlineAtMs,
          JSON.stringify(arm.lastProofRefs),
          JSON.stringify(arm.metadata),
          nowMs,
          existingArm.armId
        );
      }

      if (replaceArms) {
        for (const arm of existingArms) {
          if (incomingKeys.has(arm.armKey)) continue;
          this.db.prepare(`
            UPDATE arm_registry_arms
            SET status = 'disabled', required = 0, updated_at_ms = ?
            WHERE arm_id = ?
          `).run(nowMs, arm.armId);
        }
      }

      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: existing ? 'updated' : 'inserted',
        registry: this.getArmRegistryManifest({ registryId }),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        registryId,
      };
    }
  }

  queryArmCheckinProofs(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.checkinId || filters.checkin_id) {
      clauses.push('checkin_id = ?');
      params.push(String(filters.checkinId || filters.checkin_id));
    }
    if (filters.registryId || filters.registry_id) {
      clauses.push('registry_id = ?');
      params.push(String(filters.registryId || filters.registry_id));
    }
    if (filters.armId || filters.arm_id) {
      clauses.push('arm_id = ?');
      params.push(String(filters.armId || filters.arm_id));
    }
    if (filters.appRoomId || filters.app_room_id) {
      clauses.push('app_room_id = ?');
      params.push(String(filters.appRoomId || filters.app_room_id));
    }
    if (filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id));
    }
    if (filters.armKey || filters.arm_key) {
      clauses.push('arm_key = ?');
      params.push(String(filters.armKey || filters.arm_key));
    }
    if (filters.role) {
      clauses.push('role = ?');
      params.push(String(filters.role));
    }
    if (filters.status) {
      const status = normalizeArmCheckinStatus(filters.status);
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'desc').toLowerCase() === 'asc')
      ? 'ORDER BY checked_in_at_ms ASC, checkin_id ASC'
      : 'ORDER BY checked_in_at_ms DESC, checkin_id DESC';
    const limit = Math.max(1, Math.min(50_000, Number(filters.limit) || 5000));

    const rows = this.db.prepare(`
      SELECT * FROM arm_checkin_proofs
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => mapArmCheckinProofRow(row));
  }

  recordArmCheckinProof(input = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const appRoomId = toOptionalString(input.appRoomId || input.app_room_id || input.roomId || input.room_id, null);
    const sessionId = toOptionalString(
      input.sessionId || input.session_id || input.sessionScopeId || input.session_scope_id,
      null
    );
    const registryIdFilter = toOptionalString(input.registryId || input.registry_id, null);
    const registry = this.getArmRegistryManifest(
      registryIdFilter
        ? { registryId: registryIdFilter }
        : {
            ...(appRoomId ? { appRoomId } : {}),
            ...(sessionId ? { sessionId } : {}),
          }
    );
    if (!registry) {
      return { ok: false, status: 'not_found', reason: 'arm_registry_not_found' };
    }

    const env = ensureObject(input.env || input.environment || input.env_json);
    const envRole = toOptionalString(env.SQUIDRUN_ROLE || env.role, null);
    const envPaneId = toOptionalString(env.SQUIDRUN_PANE_ID || env.paneId || env.pane_id, null);
    const envSessionId = toOptionalString(env.SQUIDRUN_SESSION_SCOPE_ID || env.sessionId || env.session_id, null);
    const role = toOptionalString(input.role || input.senderRole || input.sender_role || envRole, null);
    const paneId = toOptionalString(input.paneId || input.pane_id || envPaneId, null);
    const inputArmKey = normalizeArmKey(input.armKey || input.arm_key || input.key, role);
    const proofKind = normalizeArmIdentityProofKind(input.proofKind || input.proof_kind || input.kind);
    const checkedInAtMs = toOptionalMs(input.checkedInAtMs ?? input.checked_in_at_ms ?? input.timestampMs)
      ?? toMs(options.nowMs, Date.now());
    const nowMs = toMs(options.nowMs, Date.now());
    const messageId = toOptionalString(input.messageId || input.message_id, null);
    const commsRowId = toOptionalMs(input.commsRowId ?? input.comms_row_id ?? input.rowId ?? input.row_id);
    const proofRefs = ensureArray(input.proofRefs || input.proof_refs);
    const metadata = ensureObject(input.metadata ?? input.meta);

    const candidates = registry.arms.filter((arm) => {
      if (inputArmKey && arm.armKey !== inputArmKey) return false;
      if (!inputArmKey && role && String(arm.role).toLowerCase() !== String(role).toLowerCase()) return false;
      return true;
    });
    const arm = candidates.find((candidate) => (
      !paneId || !candidate.paneId || String(candidate.paneId).toLowerCase() === String(paneId).toLowerCase()
    )) || candidates[0] || null;
    if (!arm) {
      return { ok: false, status: 'not_found', reason: 'arm_not_found', registryId: registry.registryId };
    }

    const rejectionReasons = [];
    if (!isArmIdentityProofKind(proofKind)) {
      rejectionReasons.push('identity_check_in_required');
    }
    if (!messageId && !Number.isFinite(commsRowId)) {
      rejectionReasons.push('message_or_row_required');
    }
    if (envSessionId && envSessionId !== registry.sessionId) {
      rejectionReasons.push('env_session_mismatch');
    }
    if (sessionId && sessionId !== registry.sessionId) {
      rejectionReasons.push('session_mismatch');
    }
    if (role && String(role).toLowerCase() !== String(arm.role).toLowerCase()) {
      rejectionReasons.push('role_mismatch');
    }
    if (envRole && String(envRole).toLowerCase() !== String(arm.role).toLowerCase()) {
      rejectionReasons.push('env_role_mismatch');
    }
    if (arm.paneId && paneId && String(paneId).toLowerCase() !== String(arm.paneId).toLowerCase()) {
      rejectionReasons.push('pane_mismatch');
    }
    if (arm.paneId && envPaneId && String(envPaneId).toLowerCase() !== String(arm.paneId).toLowerCase()) {
      rejectionReasons.push('env_pane_mismatch');
    }

    const accepted = rejectionReasons.length === 0;
    const status = accepted ? 'accepted' : 'rejected';
    const rejectedReason = accepted ? null : rejectionReasons.join(',');
    const checkinId = toOptionalString(input.checkinId || input.checkin_id, null)
      || buildStableHashId('arm-checkin', [
        registry.registryId,
        arm.armId,
        messageId || commsRowId || checkedInAtMs,
        proofKind,
      ]);

    try {
      this.db.prepare(`
        INSERT INTO arm_checkin_proofs (
          checkin_id, registry_id, arm_id, app_room_id, session_id, arm_key, role,
          pane_id, route_target, proof_kind, status, rejected_reason, message_id,
          comms_row_id, raw_role_marker, env_json, proof_refs_json, metadata_json,
          checked_in_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(checkin_id) DO UPDATE SET
          status = excluded.status,
          rejected_reason = excluded.rejected_reason,
          message_id = COALESCE(excluded.message_id, arm_checkin_proofs.message_id),
          comms_row_id = COALESCE(excluded.comms_row_id, arm_checkin_proofs.comms_row_id),
          raw_role_marker = COALESCE(excluded.raw_role_marker, arm_checkin_proofs.raw_role_marker),
          env_json = excluded.env_json,
          proof_refs_json = excluded.proof_refs_json,
          metadata_json = excluded.metadata_json,
          checked_in_at_ms = excluded.checked_in_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        checkinId,
        registry.registryId,
        arm.armId,
        registry.appRoomId,
        registry.sessionId,
        arm.armKey,
        role || arm.role,
        paneId || arm.paneId || null,
        toOptionalString(input.routeTarget || input.route_target || arm.routeTarget, null),
        proofKind,
        status,
        rejectedReason,
        messageId,
        Number.isFinite(commsRowId) ? commsRowId : null,
        toOptionalString(input.rawRoleMarker || input.raw_role_marker || input.rawMarker, null),
        JSON.stringify(env),
        JSON.stringify(proofRefs),
        JSON.stringify(metadata),
        checkedInAtMs,
        nowMs,
        nowMs
      );

      const proof = this.queryArmCheckinProofs({ checkinId, limit: 1 })[0] || null;
      const evaluation = options.evaluate === false
        ? null
        : this.evaluateArmRegistryReadiness({ registryId: registry.registryId }, { nowMs });
      return {
        ok: accepted,
        status,
        reason: rejectedReason,
        proof,
        evaluation,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        checkinId,
      };
    }
  }

  evaluateArmRegistryReadiness(filters = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }
    const registry = this.getArmRegistryManifest(filters);
    if (!registry) {
      return { ok: false, status: 'not_found', reason: 'arm_registry_not_found' };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const acceptedProofs = this.queryArmCheckinProofs({
      registryId: registry.registryId,
      status: 'accepted',
      limit: 50_000,
    });
    const latestAcceptedByArm = new Map();
    for (const proof of acceptedProofs) {
      const current = latestAcceptedByArm.get(proof.armId);
      if (!current || Number(proof.checkedInAtMs || 0) > Number(current.checkedInAtMs || 0)) {
        latestAcceptedByArm.set(proof.armId, proof);
      }
    }

    let desiredCount = 0;
    let readyCount = 0;
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      for (const arm of registry.arms) {
        if (!arm.required || arm.status === 'disabled') {
          this.db.prepare(`
            UPDATE arm_registry_arms
            SET status = 'disabled', updated_at_ms = ?
            WHERE arm_id = ?
          `).run(nowMs, arm.armId);
          continue;
        }
        desiredCount += 1;
        const proof = latestAcceptedByArm.get(arm.armId);
        const nextStatus = proof ? 'ready' : 'missing';
        if (proof) readyCount += 1;
        this.db.prepare(`
          UPDATE arm_registry_arms
          SET
            status = ?,
            last_proof_refs_json = ?,
            updated_at_ms = ?
          WHERE arm_id = ?
        `).run(
          nextStatus,
          JSON.stringify(proof ? [
            ...ensureArray(proof.proofRefs),
            ...(proof.messageId ? [`hm:${proof.messageId}`] : []),
            ...(Number.isFinite(proof.commsRowId) ? [`comms:${proof.commsRowId}`] : []),
          ] : ensureArray(arm.lastProofRefs)),
          nowMs,
          arm.armId
        );
      }
      const missingCount = Math.max(0, desiredCount - readyCount);
      this.db.prepare(`
        UPDATE arm_registries
        SET
          desired_count = ?,
          ready_count = ?,
          missing_count = ?,
          last_evaluated_at_ms = ?,
          updated_at_ms = ?
        WHERE registry_id = ?
      `).run(
        desiredCount,
        readyCount,
        missingCount,
        nowMs,
        nowMs,
        registry.registryId
      );
      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: missingCount === 0 ? 'ready' : 'missing',
        registry: this.getArmRegistryManifest({ registryId: registry.registryId }),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        registryId: registry.registryId,
      };
    }
  }

  queryArmMissingWatchdogs(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.watchdogId || filters.watchdog_id) {
      clauses.push('watchdog_id = ?');
      params.push(String(filters.watchdogId || filters.watchdog_id));
    }
    if (filters.registryId || filters.registry_id) {
      clauses.push('registry_id = ?');
      params.push(String(filters.registryId || filters.registry_id));
    }
    if (filters.armId || filters.arm_id) {
      clauses.push('arm_id = ?');
      params.push(String(filters.armId || filters.arm_id));
    }
    if (filters.appRoomId || filters.app_room_id) {
      clauses.push('app_room_id = ?');
      params.push(String(filters.appRoomId || filters.app_room_id));
    }
    if (filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id));
    }
    if (filters.armKey || filters.arm_key) {
      clauses.push('arm_key = ?');
      params.push(String(filters.armKey || filters.arm_key));
    }
    const statuses = Array.isArray(filters.statuses)
      ? filters.statuses.map((status) => normalizeArmMissingWatchdogStatus(status)).filter(Boolean)
      : [];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    } else if (filters.status) {
      const status = normalizeArmMissingWatchdogStatus(filters.status);
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY updated_at_ms DESC, watchdog_id DESC'
      : 'ORDER BY expected_at_ms ASC, watchdog_id ASC';
    const limit = Math.max(1, Math.min(50_000, Number(filters.limit) || 5000));

    const rows = this.db.prepare(`
      SELECT * FROM arm_missing_watchdogs
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => mapArmMissingWatchdogRow(row));
  }

  advanceArmMissingWatchdogs(filters = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const nudgeAfterMs = Math.max(1, Number(options.nudgeAfterMs) || DEFAULT_ARM_MISSING_NUDGE_AFTER_MS);
    const escalateAfterNudgeMs = Math.max(
      1,
      Number(options.escalateAfterNudgeMs) || DEFAULT_ARM_MISSING_ESCALATE_AFTER_NUDGE_MS
    );
    const evaluation = options.evaluate === false
      ? null
      : this.evaluateArmRegistryReadiness(filters, { nowMs });
    if (evaluation && evaluation.ok === false) {
      return evaluation;
    }
    const registry = this.getArmRegistryManifest(filters.registryId || filters.registry_id
      ? { registryId: filters.registryId || filters.registry_id }
      : filters);
    if (!registry) {
      return { ok: false, status: 'not_found', reason: 'arm_registry_not_found' };
    }

    const actions = [];
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      for (const arm of registry.arms) {
        const openWatchdogs = this.queryArmMissingWatchdogs({
          registryId: registry.registryId,
          armId: arm.armId,
          statuses: ['expected', 'nudged'],
          order: 'desc',
          limit: 1,
        });
        const openWatchdog = openWatchdogs[0] || null;

        if (!arm.required || arm.status === 'disabled') {
          continue;
        }

        if (arm.status === 'ready') {
          const activeWatchdogs = this.queryArmMissingWatchdogs({
            registryId: registry.registryId,
            armId: arm.armId,
            statuses: ['expected', 'nudged', 'escalated'],
            order: 'desc',
            limit: 50,
          });
          for (const watchdog of activeWatchdogs) {
            if (watchdog.status === 'satisfied') continue;
            this.db.prepare(`
              UPDATE arm_missing_watchdogs
              SET
                status = 'satisfied',
                satisfied_at_ms = COALESCE(satisfied_at_ms, ?),
                last_action_key = ?,
                last_action_at_ms = ?,
                updated_at_ms = ?
              WHERE watchdog_id = ?
            `).run(
              nowMs,
              `satisfied:${watchdog.watchdogId}:${nowMs}`,
              nowMs,
              nowMs,
              watchdog.watchdogId
            );
          }
          continue;
        }

        const escalatedExisting = this.queryArmMissingWatchdogs({
          registryId: registry.registryId,
          armId: arm.armId,
          status: 'escalated',
          order: 'desc',
          limit: 1,
        })[0] || null;
        if (!openWatchdog && escalatedExisting) {
          continue;
        }

        if (!openWatchdog) {
          const watchdogId = buildStableHashId('arm-watchdog', [
            registry.registryId,
            arm.armId,
            nowMs,
          ]);
          const nudgeDueAtMs = nowMs + nudgeAfterMs;
          this.db.prepare(`
            INSERT INTO arm_missing_watchdogs (
              watchdog_id, registry_id, arm_id, app_room_id, session_id, arm_key,
              role, pane_id, status, expected_at_ms, nudge_due_at_ms,
              metadata_json, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expected', ?, ?, ?, ?, ?)
          `).run(
            watchdogId,
            registry.registryId,
            arm.armId,
            registry.appRoomId,
            registry.sessionId,
            arm.armKey,
            arm.role,
            arm.paneId || null,
            nowMs,
            nudgeDueAtMs,
            JSON.stringify({
              source: 'arm_registry_readiness',
              registryStatus: registry.status,
            }),
            nowMs,
            nowMs
          );
          continue;
        }

        if (openWatchdog.status === 'expected' && nowMs >= Number(openWatchdog.nudgeDueAtMs || 0)) {
          const actionKey = `nudge:${openWatchdog.watchdogId}:${openWatchdog.expectedAtMs}`;
          const escalateDueAtMs = nowMs + escalateAfterNudgeMs;
          this.db.prepare(`
            UPDATE arm_missing_watchdogs
            SET
              status = 'nudged',
              nudged_at_ms = COALESCE(nudged_at_ms, ?),
              escalate_due_at_ms = COALESCE(escalate_due_at_ms, ?),
              last_action_key = ?,
              last_action_at_ms = ?,
              updated_at_ms = ?
            WHERE watchdog_id = ? AND status = 'expected'
          `).run(
            nowMs,
            escalateDueAtMs,
            actionKey,
            nowMs,
            nowMs,
            openWatchdog.watchdogId
          );
          actions.push({
            kind: 'nudge',
            actionKey,
            watchdogId: openWatchdog.watchdogId,
            registryId: registry.registryId,
            armId: arm.armId,
            armKey: arm.armKey,
            role: arm.role,
            paneId: arm.paneId || null,
            dueAtMs: nowMs,
            nextDueAtMs: escalateDueAtMs,
          });
          continue;
        }

        if (openWatchdog.status === 'nudged' && nowMs >= Number(openWatchdog.escalateDueAtMs || 0)) {
          const actionKey = `escalate:${openWatchdog.watchdogId}:${openWatchdog.expectedAtMs}`;
          this.db.prepare(`
            UPDATE arm_missing_watchdogs
            SET
              status = 'escalated',
              escalated_at_ms = COALESCE(escalated_at_ms, ?),
              last_action_key = ?,
              last_action_at_ms = ?,
              updated_at_ms = ?
            WHERE watchdog_id = ? AND status = 'nudged'
          `).run(
            nowMs,
            actionKey,
            nowMs,
            nowMs,
            openWatchdog.watchdogId
          );
          actions.push({
            kind: 'escalate',
            actionKey,
            watchdogId: openWatchdog.watchdogId,
            registryId: registry.registryId,
            appRoomId: registry.appRoomId,
            sessionId: registry.sessionId,
            armId: arm.armId,
            armKey: arm.armKey,
            role: arm.role,
            paneId: arm.paneId || null,
            target: 'architect',
            dueAtMs: nowMs,
          });
        }
      }
      this.db.exec('COMMIT;');
      const watchdogs = this.queryArmMissingWatchdogs({
        registryId: registry.registryId,
        limit: 50_000,
      });
      return {
        ok: true,
        status: actions.length > 0 ? 'actions_due' : 'checked',
        registry: this.getArmRegistryManifest({ registryId: registry.registryId }),
        watchdogs,
        actions,
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        registryId: registry.registryId,
      };
    }
  }

  queryTelegramReplyObligations(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.obligationId) {
      clauses.push('obligation_id = ?');
      params.push(String(filters.obligationId));
    }
    if (filters.inboundMessageId || filters.messageId) {
      clauses.push('inbound_message_id = ?');
      params.push(String(filters.inboundMessageId || filters.messageId));
    }
    if (filters.sessionId) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId));
    }
    if (filters.chatId) {
      clauses.push('chat_id = ?');
      params.push(String(filters.chatId));
    }
    if (filters.paneId) {
      clauses.push('pane_id = ?');
      params.push(String(filters.paneId));
    }
    const statuses = Array.isArray(filters.statuses)
      ? filters.statuses.map((status) => normalizeTelegramReplyObligationStatus(status)).filter(Boolean)
      : [];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    } else if (filters.status) {
      const status = normalizeTelegramReplyObligationStatus(filters.status);
      if (status) {
        clauses.push('status = ?');
        params.push(status);
      }
    }
    if (filters.openOnly) {
      clauses.push("status = 'open'");
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('opened_at_ms >= ?');
      params.push(toMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('opened_at_ms <= ?');
      params.push(toMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }
    if (filters.dueByMs !== undefined) {
      clauses.push('deadline_at_ms <= ?');
      params.push(toMs(filters.dueByMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY opened_at_ms DESC, obligation_id DESC'
      : 'ORDER BY opened_at_ms ASC, obligation_id ASC';
    const limit = Math.max(1, Math.min(50_000, Number(filters.limit) || 5000));

    const rows = this.db.prepare(`
      SELECT * FROM telegram_reply_obligations
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => mapTelegramReplyObligationRow(row));
  }

  getTelegramReplyObligation(filters = {}) {
    return this.queryTelegramReplyObligations({ ...filters, limit: 1 })[0] || null;
  }

  upsertTelegramReplyObligation(input = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const inboundMessageId = toOptionalString(
      input.inboundMessageId || input.inbound_message_id || input.messageId || input.message_id,
      null
    );
    if (!inboundMessageId) {
      return { ok: false, status: 'invalid', reason: 'inbound_message_id_required' };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const openedAtMs = toOptionalMs(input.openedAtMs ?? input.opened_at_ms ?? input.createdAtMs ?? input.created_at_ms)
      ?? nowMs;
    const deadlineAtMs = toOptionalMs(input.deadlineAtMs ?? input.deadline_at_ms ?? input.expiresAtMs ?? input.expires_at_ms)
      ?? (openedAtMs + Math.max(1, Number(options.defaultWindowMs) || DEFAULT_TELEGRAM_REPLY_OBLIGATION_WINDOW_MS));
    const obligationId = toOptionalString(input.obligationId || input.obligation_id, null)
      || buildTelegramReplyObligationId(inboundMessageId);
    const incomingStatus = normalizeTelegramReplyObligationStatus(input.status) || 'open';
    const metadata = ensureObject(input.metadata ?? input.meta ?? input.metadata_json);

    try {
      const existingRow = this.db.prepare(`
        SELECT * FROM telegram_reply_obligations
        WHERE inbound_message_id = ? OR obligation_id = ?
        LIMIT 1
      `).get(inboundMessageId, obligationId);
      const existing = mapTelegramReplyObligationRow(existingRow);

      if (!existing) {
        const satisfaction = incomingStatus === 'satisfied'
          ? ensureObject(input.satisfaction ?? input.satisfaction_json)
          : {};
        const statusTimestamp = incomingStatus === 'satisfied'
          ? (toOptionalMs(input.satisfiedAtMs ?? input.satisfied_at_ms) ?? nowMs)
          : null;
        const expiredAtMs = incomingStatus === 'expired'
          ? (toOptionalMs(input.expiredAtMs ?? input.expired_at_ms) ?? nowMs)
          : null;
        const escalatedAtMs = incomingStatus === 'escalated'
          ? (toOptionalMs(input.escalatedAtMs ?? input.escalated_at_ms) ?? nowMs)
          : null;
        this.db.prepare(`
          INSERT INTO telegram_reply_obligations (
            obligation_id, inbound_message_id, chat_id, session_id, pane_id, window_key,
            profile_name, sender_role, target_role, status, opened_at_ms, deadline_at_ms,
            last_transition_at_ms, satisfied_at_ms, satisfied_by_message_id,
            satisfied_by_row_id, satisfaction_source, expired_at_ms, escalated_at_ms,
            metadata_json, satisfaction_json, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          obligationId,
          inboundMessageId,
          toOptionalString(input.chatId ?? input.chat_id ?? input.telegramChatId ?? input.telegram_chat_id, null),
          toOptionalString(input.sessionId ?? input.session_id ?? input.sessionScopeId ?? input.session_scope_id, null),
          toOptionalString(input.paneId ?? input.pane_id, null),
          toOptionalString(input.windowKey ?? input.window_key, null),
          toOptionalString(input.profileName ?? input.profile_name ?? input.profile, null),
          toOptionalString(input.senderRole ?? input.sender_role ?? input.sender, null),
          toOptionalString(input.targetRole ?? input.target_role ?? input.target, null),
          incomingStatus,
          openedAtMs,
          deadlineAtMs,
          nowMs,
          statusTimestamp,
          toOptionalString(input.satisfiedByMessageId ?? input.satisfied_by_message_id ?? input.egressMessageId, null),
          toOptionalMs(input.satisfiedByRowId ?? input.satisfied_by_row_id ?? input.egressRowId),
          toOptionalString(input.satisfactionSource ?? input.satisfaction_source, null),
          expiredAtMs,
          escalatedAtMs,
          JSON.stringify(metadata),
          JSON.stringify(satisfaction),
          nowMs,
          nowMs
        );
        return {
          ok: true,
          status: 'inserted',
          obligation: this.getTelegramReplyObligation({ inboundMessageId }),
        };
      }

      const existingTerminal = isTerminalTelegramReplyObligationStatus(existing.status);
      if (!existingTerminal && incomingStatus === 'satisfied') {
        return this.satisfyTelegramReplyObligation({
          obligationId: existing.obligationId,
          satisfiedAtMs: input.satisfiedAtMs ?? input.satisfied_at_ms,
          satisfiedByMessageId: input.satisfiedByMessageId ?? input.satisfied_by_message_id ?? input.egressMessageId,
          satisfiedByRowId: input.satisfiedByRowId ?? input.satisfied_by_row_id ?? input.egressRowId,
          satisfactionSource: input.satisfactionSource ?? input.satisfaction_source,
          satisfaction: input.satisfaction ?? input.satisfaction_json,
        }, options);
      }
      const mergedStatus = existingTerminal && incomingStatus === 'open'
        ? existing.status
        : (existingTerminal ? existing.status : incomingStatus);
      const mergedOpenedAtMs = Math.min(Number(existing.openedAtMs || openedAtMs), openedAtMs);
      const mergedDeadlineAtMs = Number(existing.deadlineAtMs || 0) > 0
        ? Number(existing.deadlineAtMs)
        : deadlineAtMs;
      const mergedMetadata = mergeMetadata(existing.metadata, metadata);
      this.db.prepare(`
        UPDATE telegram_reply_obligations
        SET
          chat_id = COALESCE(?, chat_id),
          session_id = COALESCE(?, session_id),
          pane_id = COALESCE(?, pane_id),
          window_key = COALESCE(?, window_key),
          profile_name = COALESCE(?, profile_name),
          sender_role = COALESCE(?, sender_role),
          target_role = COALESCE(?, target_role),
          status = ?,
          opened_at_ms = ?,
          deadline_at_ms = ?,
          last_transition_at_ms = CASE WHEN status != ? THEN ? ELSE last_transition_at_ms END,
          metadata_json = ?,
          updated_at_ms = ?
        WHERE obligation_id = ?
      `).run(
        toOptionalString(input.chatId ?? input.chat_id ?? input.telegramChatId ?? input.telegram_chat_id, null),
        toOptionalString(input.sessionId ?? input.session_id ?? input.sessionScopeId ?? input.session_scope_id, null),
        toOptionalString(input.paneId ?? input.pane_id, null),
        toOptionalString(input.windowKey ?? input.window_key, null),
        toOptionalString(input.profileName ?? input.profile_name ?? input.profile, null),
        toOptionalString(input.senderRole ?? input.sender_role ?? input.sender, null),
        toOptionalString(input.targetRole ?? input.target_role ?? input.target, null),
        mergedStatus,
        mergedOpenedAtMs,
        mergedDeadlineAtMs,
        mergedStatus,
        nowMs,
        JSON.stringify(mergedMetadata),
        nowMs,
        existing.obligationId
      );
      return {
        ok: true,
        status: 'updated',
        obligation: this.getTelegramReplyObligation({ obligationId: existing.obligationId }),
      };
    } catch (err) {
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        inboundMessageId,
      };
    }
  }

  satisfyTelegramReplyObligation(input = {}, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }
    const obligationId = toOptionalString(input.obligationId || input.obligation_id, null);
    const inboundMessageId = toOptionalString(
      input.inboundMessageId || input.inbound_message_id || input.messageId || input.message_id,
      null
    );
    const existing = this.getTelegramReplyObligation({
      ...(obligationId ? { obligationId } : {}),
      ...(inboundMessageId ? { inboundMessageId } : {}),
    });
    if (!existing) {
      return { ok: false, status: 'not_found', reason: 'telegram_reply_obligation_not_found' };
    }
    if (existing.status === 'satisfied') {
      return { ok: true, status: 'already_satisfied', obligation: existing };
    }
    if (isTerminalTelegramReplyObligationStatus(existing.status)) {
      return {
        ok: false,
        status: 'terminal_state',
        reason: `telegram_reply_obligation_${existing.status}`,
        obligation: existing,
      };
    }

    const nowMs = toMs(options.nowMs, Date.now());
    const satisfiedAtMs = toOptionalMs(
      input.satisfiedAtMs ?? input.satisfied_at_ms ?? input.egressAtMs ?? input.egress_at_ms
    ) ?? nowMs;
    const satisfaction = ensureObject(input.satisfaction ?? input.satisfaction_json);

    try {
      this.db.prepare(`
        UPDATE telegram_reply_obligations
        SET
          status = 'satisfied',
          satisfied_at_ms = ?,
          satisfied_by_message_id = ?,
          satisfied_by_row_id = ?,
          satisfaction_source = ?,
          satisfaction_json = ?,
          last_transition_at_ms = ?,
          updated_at_ms = ?
        WHERE obligation_id = ? AND status = 'open'
      `).run(
        satisfiedAtMs,
        toOptionalString(input.satisfiedByMessageId ?? input.satisfied_by_message_id ?? input.egressMessageId, null),
        toOptionalMs(input.satisfiedByRowId ?? input.satisfied_by_row_id ?? input.egressRowId),
        toOptionalString(input.satisfactionSource ?? input.satisfaction_source ?? input.source, null),
        JSON.stringify(satisfaction),
        nowMs,
        nowMs,
        existing.obligationId
      );
      const updated = this.getTelegramReplyObligation({ obligationId: existing.obligationId });
      return {
        ok: updated?.status === 'satisfied',
        status: updated?.status === 'satisfied' ? 'satisfied' : 'not_updated',
        obligation: updated,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        obligationId: existing.obligationId,
      };
    }
  }

  expireTelegramReplyObligations(options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }
    const nowMs = toMs(options.nowMs, Date.now());
    const limit = Math.max(1, Math.min(10_000, Number(options.limit) || 1000));
    const filters = {
      status: 'open',
      dueByMs: nowMs,
      order: 'asc',
      limit,
    };
    if (options.sessionId) filters.sessionId = options.sessionId;
    if (options.chatId) filters.chatId = options.chatId;
    const due = this.queryTelegramReplyObligations(filters);
    let expiredCount = 0;
    try {
      for (const obligation of due) {
        const result = this.db.prepare(`
          UPDATE telegram_reply_obligations
          SET
            status = 'expired',
            expired_at_ms = ?,
            last_transition_at_ms = ?,
            updated_at_ms = ?
          WHERE obligation_id = ? AND status = 'open'
        `).run(nowMs, nowMs, nowMs, obligation.obligationId);
        expiredCount += Number(result?.changes || 0);
      }
      return {
        ok: true,
        status: expiredCount > 0 ? 'expired' : 'none_due',
        expiredCount,
        dueCount: due.length,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'db_error',
        reason: err.message,
        expiredCount,
      };
    }
  }

  prune(options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const now = toMs(options.nowMs, Date.now());
    const retentionMs = Math.max(1_000, Number(options.retentionMs) || this.retentionMs);
    const maxRows = Math.max(1, Number(options.maxRows) || this.maxRows);
    const cutoff = now - retentionMs;

    let removedByAge = 0;
    let removedByCap = 0;
    let removedEdges = 0;
    let removedArchivedDecisions = 0;
    let removedSnapshots = 0;

    try {
      this.db.exec('BEGIN IMMEDIATE;');

      const ageDelete = this.db.prepare('DELETE FROM ledger_events WHERE ts_ms < ?');
      const ageResult = ageDelete.run(cutoff);
      removedByAge = Number(ageResult?.changes || 0);

      const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM ledger_events').get();
      const total = Number(countRow?.count || 0);
      if (total > maxRows) {
        const toDrop = total - maxRows;
        const capDelete = this.db.prepare(`
          DELETE FROM ledger_events
          WHERE row_id IN (
            SELECT row_id FROM ledger_events
            ORDER BY row_id ASC
            LIMIT ?
          )
        `);
        const capResult = capDelete.run(toDrop);
        removedByCap = Number(capResult?.changes || 0);
      }

      const edgeCleanup = this.db.prepare(`
        DELETE FROM ledger_edges
        WHERE from_event_id NOT IN (SELECT event_id FROM ledger_events)
           OR to_event_id NOT IN (SELECT event_id FROM ledger_events)
      `);
      const edgeResult = edgeCleanup.run();
      removedEdges = Number(edgeResult?.changes || 0);

      const archivedDecisionCleanup = this.db.prepare(`
        DELETE FROM ledger_decisions
        WHERE status = 'archived'
          AND updated_at_ms < ?
      `);
      const archivedDecisionResult = archivedDecisionCleanup.run(cutoff);
      removedArchivedDecisions = Number(archivedDecisionResult?.changes || 0);

      const snapshotCleanup = this.db.prepare(`
        DELETE FROM ledger_context_snapshots
        WHERE created_at_ms < ?
          AND snapshot_id NOT IN (
            SELECT keep.snapshot_id
            FROM ledger_context_snapshots AS keep
            WHERE keep.snapshot_id = (
              SELECT candidate.snapshot_id
              FROM ledger_context_snapshots AS candidate
              WHERE candidate.session_id = keep.session_id
              ORDER BY candidate.created_at_ms DESC, candidate.snapshot_id DESC
              LIMIT 1
            )
          )
      `);
      const snapshotResult = snapshotCleanup.run(cutoff);
      removedSnapshots = Number(snapshotResult?.changes || 0);

      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'pruned',
        removedByAge,
        removedByCap,
        removedEdges,
        removedArchivedDecisions,
        removedSnapshots,
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        error: err.message,
      };
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn('EvidenceLedger', `Error closing DB: ${err.message}`);
    }
    this.db = null;
    this.available = false;
  }

  _mapRowToEvent(row) {
    return {
      eventId: row.event_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentEventId: row.parent_event_id,
      correlationId: row.correlation_id || row.trace_id,
      causationId: row.causation_id ?? row.parent_event_id ?? null,
      type: row.type,
      stage: row.stage,
      source: row.source,
      paneId: row.pane_id,
      role: row.role,
      ts: row.ts_ms,
      seq: row.seq,
      direction: row.direction,
      payload: parseJson(row.payload_json, {}),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      meta: parseJson(row.meta_json, {}),
      payloadHash: row.payload_hash,
      ingestedAtMs: row.ingested_at_ms,
      sessionId: row.session_id,
      rowId: row.row_id,
    };
  }
}

module.exports = {
  EvidenceLedgerStore,
  DEFAULT_DB_PATH,
  resolveDefaultDbPath,
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_MS,
  DEFAULT_TELEGRAM_REPLY_OBLIGATION_WINDOW_MS,
};
