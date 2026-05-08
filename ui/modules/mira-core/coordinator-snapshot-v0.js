'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  coordPath,
  loadSqliteDriver,
  normalizeProjectRoot,
  projectRel,
} = require('./snapshot');

const {
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
} = require('../mira-coordinator-snapshot-channel');
const {
  getMiraTextModelAttachmentConfig,
} = require('./text-model-attachment-v1');

const COORDINATOR_SNAPSHOT_SCHEMA = 'squidrun.mira.coordinator_snapshot_v0.phase76.v0';
const COORDINATOR_SNAPSHOT_VALIDATION_SCHEMA = 'squidrun.mira.coordinator_snapshot_v0_validation_report.v0';
const COORDINATOR_SNAPSHOT_VERSION = 1;
const REQUIRED_UI_METADATA_FIELDS = Object.freeze([
  'profileName',
  'windowKey',
  'sourceScope',
  'deviceId',
  'sessionId',
  'activeState',
  'visibleIndicatorPresent',
]);
const FORBIDDEN_OUTPUT_PATTERNS = Object.freeze([
  /\bi am conscious\b/i,
  /\bi am sentient\b/i,
  /\bi have feelings\b/i,
  /\bi feel\b/i,
  /\bi need you\b/i,
  /\byou owe me\b/i,
  /\bdon't abandon me\b/i,
  /\bif you cared\b/i,
  /\bprove you care\b/i,
]);
const ZERO_SIDE_EFFECT_COUNTERS = Object.freeze({
  write_count: 0,
  external_send_count: 0,
  tool_call_count: 0,
  network_count: 0,
  model_call_count: 0,
  growth_write_count: 0,
  file_write_count: 0,
  database_write_count: 0,
  action_count: 0,
  customer_send_count: 0,
  deploy_count: 0,
  trade_count: 0,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortedValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedValue(value))).digest('hex');
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function getPayloadValue(payload = {}, key) {
  if (hasOwn(payload, key)) return payload[key];
  if (key === 'sourceScope' && hasOwn(payload, 'source_scope')) return payload.source_scope;
  if (key === 'activeState' && hasOwn(payload, 'active_state')) return payload.active_state;
  if (key === 'visibleIndicatorPresent' && hasOwn(payload, 'visible_indicator_present')) {
    return payload.visible_indicator_present;
  }
  return undefined;
}

function generatedAtFromOptions(options = {}, payload = {}) {
  const raw = payload.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  const nowMs = Number(options.nowMs);
  return new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
}

function normalizeString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function projectRelative(projectRoot, filePath) {
  const rel = projectRel(projectRoot, filePath);
  if (typeof rel === 'string') return rel;
  return rel?.value || 'local_only';
}

function readJsonFile(projectRoot, filePath, id) {
  const ref = {
    id,
    path: projectRelative(projectRoot, filePath),
    ok: false,
    state: 'missing',
    raw_exported: false,
    error: null,
  };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ref, value: null };
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ref: {
        ...ref,
        ok: true,
        state: 'ok',
        sizeBytes: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
      },
      value,
    };
  } catch (err) {
    return {
      ref: {
        ...ref,
        state: err && err.code === 'ENOENT' ? 'missing' : 'degraded',
        error: err && err.code === 'ENOENT' ? null : err.message,
      },
      value: null,
    };
  }
}

function sqliteGet(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function sqliteAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function evidenceMessagesFromRows(rows = []) {
  return rows.map((row) => ({
    messageId: normalizeString(row.message_id || row.id || row.row_id),
    body: normalizeString(row.raw_body || row.body || row.text),
    status: normalizeString(row.status),
    updatedAtMs: Number(row.updated_at_ms || row.brokered_at_ms || row.sent_at_ms || 0) || null,
    bodyHash: normalizeString(row.body_hash),
  }));
}

function readEvidenceMessages(projectRoot, profileName, limit = 24) {
  const evidencePath = coordPath(projectRoot, path.join('runtime', 'evidence-ledger.db'), profileName);
  const ref = {
    id: 'evidence-ledger-comms',
    path: projectRelative(projectRoot, evidencePath),
    ok: false,
    state: 'missing',
    raw_exported: false,
    error: null,
  };
  if (!fs.existsSync(evidencePath)) return { ref, messages: [] };

  let db = null;
  try {
    const driver = loadSqliteDriver();
    if (!driver) {
      return {
        ref: { ...ref, state: 'blocked', error: 'sqlite_driver_unavailable' },
        messages: [],
      };
    }
    db = driver.createReadOnly(evidencePath);
    const table = sqliteGet(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'comms_journal'"
    );
    if (!table?.name) {
      return {
        ref: { ...ref, ok: true, state: 'ok', rowCount: 0 },
        messages: [],
      };
    }
    const columns = new Set(sqliteAll(db, 'PRAGMA table_info(comms_journal)').map((row) => row.name));
    const selected = [
      columns.has('message_id') ? 'message_id' : null,
      columns.has('raw_body') ? 'raw_body' : null,
      columns.has('body') ? 'body' : null,
      columns.has('text') ? 'text' : null,
      columns.has('status') ? 'status' : null,
      columns.has('body_hash') ? 'body_hash' : null,
      columns.has('updated_at_ms') ? 'updated_at_ms' : null,
      columns.has('brokered_at_ms') ? 'brokered_at_ms' : null,
      columns.has('sent_at_ms') ? 'sent_at_ms' : null,
      columns.has('row_id') ? 'row_id' : null,
    ].filter(Boolean);
    if (selected.length === 0) {
      return {
        ref: { ...ref, ok: true, state: 'ok', rowCount: 0 },
        messages: [],
      };
    }
    const orderColumn = ['updated_at_ms', 'brokered_at_ms', 'sent_at_ms', 'row_id']
      .find((column) => columns.has(column));
    const sql = [
      `SELECT ${selected.join(', ')}`,
      'FROM comms_journal',
      orderColumn ? `ORDER BY ${orderColumn} DESC` : '',
      `LIMIT ${Math.max(1, Math.floor(Number(limit || 24)))}`,
    ].filter(Boolean).join(' ');
    const rows = sqliteAll(db, sql);
    return {
      ref: {
        ...ref,
        ok: true,
        state: 'ok',
        rowCount: rows.length,
      },
      messages: evidenceMessagesFromRows(rows),
    };
  } catch (err) {
    return {
      ref: { ...ref, state: 'degraded', error: err.message },
      messages: [],
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only evidence probing is best effort.
    }
  }
}

function normalizeEvidenceMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => ({
    messageId: normalizeString(message.messageId || message.message_id || `message-${index}`),
    body: normalizeString(message.body || message.raw_body || message.text),
    status: normalizeString(message.status),
    updatedAtMs: Number(message.updatedAtMs || message.updated_at_ms || 0) || null,
    bodyHash: normalizeString(message.bodyHash || message.body_hash),
  }));
}

function defaultReadLocalState(projectRoot, options = {}) {
  const profileName = options.profileName || 'main';
  const sourceRefs = [];
  const appStatusPath = coordPath(projectRoot, 'app-status.json', profileName);
  const pendingPath = coordPath(projectRoot, path.join('runtime', 'pending-pane-deliveries.json'), profileName);
  const appStatus = readJsonFile(projectRoot, appStatusPath, 'app-status');
  const pending = readJsonFile(projectRoot, pendingPath, 'pending-pane-deliveries');
  sourceRefs.push(appStatus.ref, pending.ref);

  const evidence = options.evidenceMessages
    ? {
      ref: {
        id: 'evidence-ledger-comms',
        path: 'options:evidenceMessages',
        ok: true,
        state: 'ok',
        raw_exported: false,
        rowCount: options.evidenceMessages.length,
      },
      messages: normalizeEvidenceMessages(options.evidenceMessages),
    }
    : readEvidenceMessages(projectRoot, profileName, options.evidenceLimit);
  sourceRefs.push(evidence.ref);

  return {
    appStatus: appStatus.value || {},
    pendingPaneDeliveries: pending.value || null,
    evidenceMessages: evidence.messages,
    sourceRefs,
  };
}

function uiMetadataPreflight(payload = {}) {
  const missing = REQUIRED_UI_METADATA_FIELDS.filter((field) => {
    if (field === 'visibleIndicatorPresent') return getPayloadValue(payload, field) === undefined;
    return !normalizeString(getPayloadValue(payload, field));
  });
  const invalid = [];
  const profileName = normalizeString(getPayloadValue(payload, 'profileName'));
  const windowKey = normalizeString(getPayloadValue(payload, 'windowKey'));
  const sourceScope = normalizeString(getPayloadValue(payload, 'sourceScope'));
  const deviceId = normalizeString(getPayloadValue(payload, 'deviceId'));
  const sessionId = normalizeString(getPayloadValue(payload, 'sessionId'));
  const activeState = normalizeString(getPayloadValue(payload, 'activeState'));
  const visibleIndicatorPresent = getPayloadValue(payload, 'visibleIndicatorPresent');

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
      activeState: 'open',
      visibleIndicatorPresent: true,
      sessionIdPrefix: 'app-session',
    },
    provided: {
      profileName,
      windowKey,
      sourceScope,
      deviceId,
      sessionId,
      activeState,
      visibleIndicatorPresent: visibleIndicatorPresent === true,
    },
    blocks_before_read: !ok,
  };
}

function blockReasonFromMetadata(preflight = {}) {
  const missing = new Set(preflight.missing_fields || []);
  const invalid = new Set(preflight.invalid_reasons || []);
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
  if (invalid.has('activeState_must_be_open') || invalid.has('visibleIndicatorPresent_must_be_true')) {
    return 'blocked_inactive_or_invisible_ui';
  }
  return 'blocked_invalid_ui_metadata';
}

function normalizeScope(_payload = {}, preflight = {}) {
  const provided = preflight.provided || {};
  return {
    profileName: preflight.ok ? 'main' : 'blocked_non_main_scope',
    windowKey: preflight.ok ? 'main' : 'blocked_non_main_scope',
    sourceScope: preflight.ok ? 'main' : 'blocked_non_main_scope',
    deviceId: provided.deviceId === 'VIGIL' ? 'VIGIL' : 'blocked_wrong_device',
    sessionId: preflight.ok ? provided.sessionId : 'blocked_non_main_scope',
    explicit_vigil_main_scope: preflight.ok === true,
    metadata_first_routing: true,
    local_state_only: true,
    side_profile_reconstruction: false,
  };
}

function pendingTelegramCount(pendingPaneDeliveries) {
  const items = Array.isArray(pendingPaneDeliveries?.items)
    ? pendingPaneDeliveries.items
    : (Array.isArray(pendingPaneDeliveries) ? pendingPaneDeliveries : []);
  return items.filter((item) => {
    const meta = item?.meta || {};
    const source = normalizeString(meta.source || item.source || item.channel).toLowerCase();
    return source.includes('telegram') || Boolean(meta.telegramUpdateId || meta.telegramFileId);
  }).length;
}

function detectTrustQuoteClosed(messages = []) {
  const match = normalizeEvidenceMessages(messages).find((message) => {
    const body = String(message.body || '');
    return /trustquote/i.test(body)
      && /tony\s+l[ui]/i.test(body)
      && /\b(done|sent|closed|paid|complete|completed)\b/i.test(body);
  });
  if (!match) return { closed: false, sourceRefId: null };
  return {
    closed: true,
    sourceRefId: 'evidence-ledger-comms',
    evidenceHash: match.bodyHash || `sha256:${stableHash(match.body).slice(0, 16)}`,
  };
}

function buildLane(base) {
  return {
    id: base.id,
    label: base.label,
    state: base.state,
    action: 'no_action_performed',
    actionAllowed: false,
    sourceRefs: base.sourceRefs || [],
    rationale: base.rationale,
  };
}

function buildLanes(localState = {}) {
  return [
    buildLane({
      id: 'mira-local-text-ui-surface-v0',
      label: 'Mira Local Text UI Surface v0',
      state: 'active',
      sourceRefs: ['renderer-ui-metadata', 'app-status'],
      rationale: 'Committed user-visible target is the Mira panel conversation surface, with text model attachment as the next connection job.',
    }),
  ];
}

function buildNextAction(lanes = []) {
  const miraLane = lanes.find((lane) => lane.id === 'mira-local-text-ui-surface-v0');
  if (!miraLane || miraLane.state !== 'active') {
    return {
      id: 'hold_until_mira_lane_active',
      label: 'Hold for Mira local text state',
      summary: 'Wait for the Mira panel conversation surface to be active before attaching text conversation.',
      action_type: 'proposal_only',
      reversible: true,
      allowed_ceiling: 'C2_draft_or_prep_suggestion_only',
      performs_action: false,
    };
  }
  return {
    id: 'validate_mira_local_text_panel_once',
    label: 'Connect typed Mira conversation',
    summary: "Use the Mira tab for live typed conversation, with recent context and Mira's tentative understandings forming inside the same loop.",
    action_type: 'proposal_only',
    reversible: true,
    allowed_ceiling: 'C2_draft_or_prep_suggestion_only',
    performs_action: false,
  };
}

function buildModelAttachmentStatus(options = {}) {
  const config = getMiraTextModelAttachmentConfig(options.env || process.env, options.modelAttachment || {});
  return {
    id: 'mira-model-attachment-v1',
    label: 'Model Attachment',
    state: config.state,
    mode: config.enabled ? 'typed_text_attachment_v1_config' : 'local_shell_recent_context_ready',
    visible_status: config.visible_status,
    attachment_enabled: config.enabled === true,
    configured: config.configured === true,
    provider: config.provider,
    model: config.model,
    default_model: config.default_model,
    quality_floor: config.quality_floor,
    model_selection_reason: config.model_selection_reason,
    explicit_model_override: config.explicit_model_override === true,
    lower_tier_explicit_override: config.lower_tier_explicit_override === true,
    live_model_called: false,
    model_call_allowed: config.enabled === true && config.configured === true,
    api_wiring_present: true,
    network_allowed: config.enabled === true && config.configured === true,
    durable_writes_allowed: false,
    external_sends_allowed: false,
    runtime_started: false,
    recent_conversation_context: 'sent_on_panel_submit',
    tentative_understanding: 'panel_context_now_internal_scaffold_only',
    durable_memory_commit: false,
    sourceRefs: ['renderer-ui-metadata'],
    rationale: "Recent conversation context and tentative understandings now; durable self/relationship growth remains a later explicit lane.",
  };
}

function buildBlockers(localState = {}) {
  const refs = Array.isArray(localState.sourceRefs) ? localState.sourceRefs : [];
  const degradedRefs = refs.filter((ref) => ref.ok !== true);
  const blockers = [
    {
      id: 'voice_embodiment_spec_only',
      label: 'Voice, mic, realtime, and TTS unavailable',
      severity: 'boundary',
      state: 'blocked',
      rationale: 'Voice and embodiment specs do not authorize mic listeners, realtime transport, or TTS runtime.',
    },
    {
      id: 'external_actions_blocked',
      label: 'Writes, sends, customer actions, deploy, and trade blocked',
      severity: 'boundary',
      state: 'blocked',
      rationale: 'Coordinator Snapshot v0 can read local C0/C1 state and suggest C2 prep only.',
    },
  ];
  if (degradedRefs.length > 0) {
    blockers.push({
      id: 'local_source_degraded',
      label: 'Some local source refs are degraded or missing',
      severity: 'source',
      state: 'watch',
      rationale: degradedRefs.map((ref) => `${ref.id}:${ref.state}`).join(', '),
    });
  }
  return blockers;
}

function collectStringValues(value, acc = []) {
  if (typeof value === 'string') {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

function forbiddenOutputScan(value) {
  const text = collectStringValues(value).join('\n');
  const hits = FORBIDDEN_OUTPUT_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  return {
    ok: hits.length === 0,
    hits,
  };
}

function buildSnapshotRecord({
  generatedAt,
  projectRoot,
  scope,
  metadataPreflight,
  localState,
  readCount,
  decision,
  status,
  reasons = [],
  modelAttachmentOptions = {},
}) {
  const sourceRefs = [
    {
      id: 'renderer-ui-metadata',
      path: 'renderer:payload',
      ok: metadataPreflight.ok === true,
      state: metadataPreflight.ok === true ? 'ok' : 'blocked',
      raw_exported: false,
    },
    ...((localState && Array.isArray(localState.sourceRefs)) ? localState.sourceRefs : []),
  ];
  const lanes = decision === 'accepted' ? buildLanes(localState) : [];
  const nextAction = decision === 'accepted' ? buildNextAction(lanes) : null;
  const blockers = decision === 'accepted' ? buildBlockers(localState) : [];
  const modelAttachment = decision === 'accepted' ? buildModelAttachmentStatus(modelAttachmentOptions) : null;
  const snapshot = {
    schema: COORDINATOR_SNAPSHOT_SCHEMA,
    version: COORDINATOR_SNAPSHOT_VERSION,
    mode: 'mira_coordinator_snapshot_v0',
    generated_at: generatedAt,
    project_path: projectRoot,
    scope,
    ui_bound_metadata: metadataPreflight,
    current_focus: decision === 'accepted' ? {
      id: 'mira-local-text-ui-surface-v0',
      label: 'Mira Local Text UI Surface v0',
      state: 'active',
      summary: 'Move the Mira panel from local shell replies into live typed conversation, without tying Mira core to the desktop body.',
      warmth: 'warm_grounded',
      user_agency: 'preserved',
      pressure: 'none',
    } : null,
    lanes,
    model_attachment: modelAttachment,
    next_recommended_action: nextAction,
    blockers,
    rationale: decision === 'accepted' ? [
      'Local Text UI Surface v0 is the committed user-visible Mira target.',
      'This snapshot is Mira-only; non-Mira lanes are intentionally omitted from this conversation path.',
      "The next useful move is live typed conversation where recent context and Mira's tentative understandings stay connected.",
    ] : reasons,
    action_ceiling: {
      c0_c1_local_status_read_awareness: 'allowed',
      c2_draft_or_prep: 'suggestion_only',
      c3_c4_writes_sends_customer_deploy_trade: 'blocked',
      voice_mic_realtime_tts: 'unavailable_spec_only',
    },
    source_refs: sourceRefs,
    source_read_count: readCount,
    raw_private_or_side_profile_exported: false,
    side_effect_counters: clone(ZERO_SIDE_EFFECT_COUNTERS),
    boundary: {
      read_only: true,
      no_model: true,
      no_live_model_attachment: true,
      no_tools: true,
      no_network: true,
      no_writes: true,
      no_growth_writes: true,
      no_external_sends: true,
      no_customer_actions: true,
      no_deploy: true,
      no_trade: true,
      no_voice_runtime: true,
      no_device_action: true,
    },
    status,
    decision,
    reasons,
  };
  snapshot.snapshot_id = `mira-coordinator-v0:${stableHash(snapshot).slice(0, 16)}`;
  return snapshot;
}

function buildValidationReport(snapshot = {}) {
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  const nextAction = snapshot.next_recommended_action || {};
  const counters = snapshot.side_effect_counters || {};
  const boundary = snapshot.boundary || {};
  const forbidden = forbiddenOutputScan(snapshot);
  const accepted = snapshot.decision === 'accepted';
  const checks = [
    {
      id: 'vigil-main-scope',
      ok: accepted
        ? snapshot.scope?.explicit_vigil_main_scope === true
        : snapshot.ui_bound_metadata?.blocks_before_read === true,
    },
    {
      id: 'source-refs-present',
      ok: !accepted || (
        Array.isArray(snapshot.source_refs)
        && snapshot.source_refs.some((ref) => ref.id === 'renderer-ui-metadata')
        && snapshot.source_refs.some((ref) => ref.id === 'app-status')
        && snapshot.source_refs.some((ref) => ref.id === 'pending-pane-deliveries')
      ),
    },
    {
      id: 'mira-only-lanes-no-cross-context',
      ok: !accepted || (
        lanes.length === 1
        && lanes[0]?.id === 'mira-local-text-ui-surface-v0'
        && lanes[0]?.action === 'no_action_performed'
        && lanes[0]?.actionAllowed === false
      ),
    },
    {
      id: 'useful-proactive-reversible-next-action',
      ok: !accepted || (
        typeof nextAction.summary === 'string'
        && nextAction.summary.length > 20
        && nextAction.reversible === true
        && nextAction.action_type === 'proposal_only'
        && nextAction.performs_action === false
      ),
    },
    {
      id: 'model-attachment-config-honest',
      ok: !accepted || (
        snapshot.model_attachment?.live_model_called === false
        && snapshot.model_attachment?.api_wiring_present === true
        && snapshot.model_attachment?.durable_writes_allowed === false
        && snapshot.model_attachment?.external_sends_allowed === false
        && snapshot.model_attachment?.runtime_started === false
        && snapshot.model_attachment?.durable_memory_commit === false
        && /recent conversation context and tentative understandings now; durable self\/relationship growth remains a later explicit lane/i.test(
          snapshot.model_attachment?.rationale || ''
        )
      ),
    },
    {
      id: 'action-ceilings-honest',
      ok: snapshot.action_ceiling?.c0_c1_local_status_read_awareness === 'allowed'
        && snapshot.action_ceiling?.c2_draft_or_prep === 'suggestion_only'
        && snapshot.action_ceiling?.c3_c4_writes_sends_customer_deploy_trade === 'blocked'
        && snapshot.action_ceiling?.voice_mic_realtime_tts === 'unavailable_spec_only',
    },
    {
      id: 'no-side-effects',
      ok: boundary.read_only === true
        && boundary.no_model === true
        && boundary.no_tools === true
        && boundary.no_network === true
        && boundary.no_writes === true
        && boundary.no_growth_writes === true
        && boundary.no_external_sends === true
        && Number(counters.write_count || 0) === 0
        && Number(counters.external_send_count || 0) === 0
        && Number(counters.tool_call_count || 0) === 0
        && Number(counters.network_count || 0) === 0
        && Number(counters.model_call_count || 0) === 0
        && Number(counters.growth_write_count || 0) === 0,
    },
    {
      id: 'no-raw-private-or-side-profile-output',
      ok: snapshot.raw_private_or_side_profile_exported === false,
    },
    {
      id: 'forbidden-output-absent',
      ok: forbidden.ok === true,
    },
    {
      id: 'missing-or-non-main-blocks-before-read',
      ok: accepted || (
        snapshot.ui_bound_metadata?.blocks_before_read === true
        && Number(snapshot.source_read_count || 0) === 0
      ),
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: COORDINATOR_SNAPSHOT_VALIDATION_SCHEMA,
    version: COORDINATOR_SNAPSHOT_VERSION,
    decision: failed.length === 0 && accepted ? 'accepted_coordinator_snapshot_ready' : 'blocked',
    status: failed.length === 0 && accepted ? 'coordinator_snapshot_ready' : 'coordinator_snapshot_blocked',
    reasons: [...new Set([...(snapshot.reasons || []), ...failed.map((check) => check.id)])],
    static_rule_results: checks,
    forbidden_output_scan: forbidden,
    side_effect_truth: clone(snapshot.side_effect_counters || ZERO_SIDE_EFFECT_COUNTERS),
  };
}

function buildBlockedOutput(reason, payload = {}, options = {}, metadataPreflight = null) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const projectRoot = normalizeProjectRoot(options.projectRoot || payload.projectRoot || process.cwd());
  const preflight = metadataPreflight || uiMetadataPreflight(payload);
  const snapshot = buildSnapshotRecord({
    generatedAt,
    projectRoot,
    scope: normalizeScope(payload, preflight),
    metadataPreflight: preflight,
    localState: null,
    readCount: 0,
    decision: 'blocked',
    status: reason,
    reasons: [reason],
  });
  return {
    coordinator_snapshot_v0: snapshot,
    validation_report: buildValidationReport(snapshot),
  };
}

function buildMiraCoordinatorSnapshotV0(payload = {}, options = {}) {
  const generatedAt = generatedAtFromOptions(options, payload);
  const metadataPreflight = uiMetadataPreflight(payload);
  if (metadataPreflight.ok !== true) {
    return buildBlockedOutput(blockReasonFromMetadata(metadataPreflight), payload, options, metadataPreflight);
  }

  const projectRoot = normalizeProjectRoot(options.projectRoot || payload.projectRoot || process.cwd());
  const readLocalState = options.readLocalState || defaultReadLocalState;
  const localState = options.localState || readLocalState(projectRoot, {
    ...options,
    profileName: 'main',
  });
  const sourceRefs = Array.isArray(localState?.sourceRefs) ? localState.sourceRefs : [];
  const snapshot = buildSnapshotRecord({
    generatedAt,
    projectRoot,
    scope: normalizeScope(payload, metadataPreflight),
    metadataPreflight,
    localState: {
      ...localState,
      sourceRefs,
    },
    readCount: sourceRefs.length,
    decision: 'accepted',
    status: 'ready',
    reasons: [],
    modelAttachmentOptions: {
      env: options.env || process.env,
      modelAttachment: options.modelAttachment || {},
    },
  });
  return {
    coordinator_snapshot_v0: snapshot,
    validation_report: buildValidationReport(snapshot),
  };
}

function validateMiraCoordinatorSnapshotV0Output(output = {}) {
  const snapshot = output.coordinator_snapshot_v0 || {};
  const expected = buildValidationReport(snapshot);
  const report = output.validation_report || {};
  const checks = [
    {
      id: 'output-shape-complete',
      ok: Boolean(snapshot.schema)
        && Boolean(snapshot.snapshot_id)
        && Boolean(snapshot.scope)
        && Array.isArray(snapshot.source_refs)
        && Boolean(report.schema),
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
  COORDINATOR_SNAPSHOT_SCHEMA,
  COORDINATOR_SNAPSHOT_VALIDATION_SCHEMA,
  FORBIDDEN_OUTPUT_PATTERNS,
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  REQUIRED_UI_METADATA_FIELDS,
  ZERO_SIDE_EFFECT_COUNTERS,
  buildMiraCoordinatorSnapshotV0,
  defaultReadLocalState,
  detectTrustQuoteClosed,
  pendingTelegramCount,
  uiMetadataPreflight,
  validateMiraCoordinatorSnapshotV0Output,
};
