'use strict';

const ROOM_ENVELOPE_VERSION = 'squidrun.room-envelope.v0';
const MAIN_ROOM_ID = 'main';
const TRUSTQUOTE_ROOM_ID = 'trustquote';
const TRUSTQUOTE_PROJECT_PATH = 'D:/projects/TrustQuote';
const TRUSTED_INTERNAL_TARGETS = new Set(['architect', 'builder', 'oracle']);
const TRUSTQUOTE_ROOM_VISIBILITIES = new Set(['room_internal', 'cross_room_summary']);

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseMaybeJsonObject(value) {
  if (!value || typeof value !== 'string') return asObject(value);
  try {
    return asObject(JSON.parse(value));
  } catch (_) {
    return {};
  }
}

function normalizeRoomId(value) {
  const normalized = toText(value, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (normalized === MAIN_ROOM_ID || normalized === TRUSTQUOTE_ROOM_ID) return normalized;
  return null;
}

function normalizeInternalRole(value) {
  const normalized = toText(value, '').toLowerCase();
  if (normalized === 'arch') return 'architect';
  return TRUSTED_INTERNAL_TARGETS.has(normalized) ? normalized : null;
}

function normalizePathForMetadata(value) {
  const text = toText(value, '');
  if (!text) return null;
  return text.replace(/\\/g, '/');
}

function normalizeProjectToken(value) {
  return toText(value, '').replace(/\\/g, '/').toLowerCase();
}

function projectMetadataCandidates(metadata = {}) {
  const source = asObject(metadata);
  return [
    asObject(source.project),
    asObject(source.envelope?.project),
  ].filter((project) => Object.keys(project).length > 0);
}

function projectMetadataMatchesName(project = {}, roomOrProjectName = '') {
  const expected = normalizeProjectToken(roomOrProjectName);
  if (!expected) return false;
  const name = normalizeProjectToken(project.name);
  const projectPath = normalizeProjectToken(project.path || project.projectPath || project.project_path);
  return name === expected
    || projectPath === expected
    || projectPath.endsWith(`/${expected}`);
}

function metadataIndicatesTrustQuoteProject(metadata = {}) {
  return projectMetadataCandidates(metadata)
    .some((project) => projectMetadataMatchesName(project, TRUSTQUOTE_ROOM_ID));
}

function metadataIndicatesTrustedMainProject(metadata = {}) {
  return projectMetadataCandidates(metadata)
    .some((project) => projectMetadataMatchesName(project, 'squidrun'));
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toText(entry, ''))
    .filter(Boolean)
    .slice(0, 12);
}

function hashRoomBody(body = '') {
  const text = String(body || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `room-body-v0:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function hasTrustQuoteText(row = {}) {
  return /\btrustquote\b/i.test(toText(row.rawBody || row.body || row.content, ''));
}

function hasTrustQuoteRoomText(row = {}) {
  return /\btrustquote\b[\s\S]{0,80}\broom\b/i.test(toText(row.rawBody || row.body || row.content, ''))
    || /\broom\b[\s\S]{0,80}\btrustquote\b/i.test(toText(row.rawBody || row.body || row.content, ''));
}

function extractMetadata(rowOrMetadata = {}) {
  const source = asObject(rowOrMetadata);
  if (source.metadata || source.meta || source.metadata_json) {
    return {
      ...parseMaybeJsonObject(source.metadata_json),
      ...asObject(source.metadata),
      ...asObject(source.meta),
    };
  }
  return parseMaybeJsonObject(rowOrMetadata);
}

function extractRoomMetadata(metadata = {}) {
  const source = extractMetadata(metadata);
  const room = {
    ...asObject(source.room),
    ...asObject(source.roomEnvelope),
    ...asObject(source.room_envelope),
  };
  const directRoomId = source.roomId || source.room_id || source.sourceRoomId || source.source_room_id;
  if (directRoomId && !room.id && !room.sourceRoomId && !room.source_room_id) {
    room.id = directRoomId;
  }
  return room;
}

function buildTrustQuoteRoomEnvelope(input = {}) {
  const body = toText(input.body || input.rawBody || input.content, '');
  const targetRole = normalizeInternalRole(input.targetRole || input.target_role || 'architect') || 'architect';
  const visibility = TRUSTQUOTE_ROOM_VISIBILITIES.has(toText(input.visibility, 'cross_room_summary'))
    ? toText(input.visibility, 'cross_room_summary')
    : 'cross_room_summary';
  const sessionScopeId = toText(input.sessionScopeId || input.session_scope_id, null);

  return {
    version: ROOM_ENVELOPE_VERSION,
    room: {
      id: TRUSTQUOTE_ROOM_ID,
      sourceRoomId: TRUSTQUOTE_ROOM_ID,
      sourceWindowKey: TRUSTQUOTE_ROOM_ID,
      sourceProjectPath: normalizePathForMetadata(input.sourceProjectPath || input.source_project_path || TRUSTQUOTE_PROJECT_PATH),
      targetRoomId: MAIN_ROOM_ID,
      targetRole,
      visibility,
      sessionScopeId,
      bodyHash: toText(input.bodyHash || input.body_hash, '') || hashRoomBody(body),
      sourceRefs: normalizeSourceRefs(input.sourceRefs || input.source_refs),
      dispatch: 'preview_only',
    },
  };
}

function normalizeTrustQuoteRoomEnvelope(rowOrMetadata = {}) {
  const metadata = extractMetadata(rowOrMetadata);
  const room = extractRoomMetadata(metadata);
  const sourceRoomId = normalizeRoomId(
    room.sourceRoomId
      || room.source_room_id
      || room.id
      || room.roomId
      || room.room_id
      || metadata.windowKey
      || metadata.window_key
      || metadata.profile
  );
  const rawSourceRoom = toText(
    room.sourceRoomId
      || room.source_room_id
      || room.id
      || room.roomId
      || room.room_id
      || metadata.windowKey
      || metadata.window_key
      || metadata.profile,
    ''
  );

  if (!sourceRoomId) {
    return {
      ok: false,
      status: rawSourceRoom ? 'unsupported_room_metadata' : 'missing_room_metadata',
      roomId: rawSourceRoom || null,
      visibleInMain: true,
      canAffectMainCurrentLane: false,
      reason: rawSourceRoom ? 'unsupported_room_metadata_non_authoritative' : 'missing_room_metadata_non_authoritative',
    };
  }

  if (sourceRoomId !== TRUSTQUOTE_ROOM_ID) {
    return {
      ok: false,
      status: 'not_trustquote_room',
      roomId: sourceRoomId,
      visibleInMain: sourceRoomId !== MAIN_ROOM_ID,
      canAffectMainCurrentLane: sourceRoomId === MAIN_ROOM_ID,
      reason: sourceRoomId === MAIN_ROOM_ID ? 'main_room_metadata' : 'other_room_non_authoritative',
    };
  }

  const targetRoomId = normalizeRoomId(room.targetRoomId || room.target_room_id || room.targetRoom || room.target_room || MAIN_ROOM_ID);
  const targetRole = normalizeInternalRole(room.targetRole || room.target_role || metadata.targetRole || metadata.target_role);
  const visibility = TRUSTQUOTE_ROOM_VISIBILITIES.has(toText(room.visibility, 'cross_room_summary'))
    ? toText(room.visibility, 'cross_room_summary')
    : 'cross_room_summary';

  return {
    ok: true,
    status: 'trustquote_room_envelope',
    version: toText(metadata.version || metadata.roomEnvelopeVersion || metadata.room_envelope_version, ROOM_ENVELOPE_VERSION),
    roomId: TRUSTQUOTE_ROOM_ID,
    sourceRoomId: TRUSTQUOTE_ROOM_ID,
    sourceWindowKey: toText(room.sourceWindowKey || room.source_window_key || metadata.windowKey || metadata.window_key, TRUSTQUOTE_ROOM_ID),
    sourceProjectPath: normalizePathForMetadata(room.sourceProjectPath || room.source_project_path),
    targetRoomId: targetRoomId || MAIN_ROOM_ID,
    targetRole,
    visibility,
    sessionScopeId: toText(room.sessionScopeId || room.session_scope_id || metadata.sessionScopeId || metadata.session_scope_id, null),
    bodyHash: toText(room.bodyHash || room.body_hash, null),
    sourceRefs: normalizeSourceRefs(room.sourceRefs || room.source_refs),
    visibleInMain: true,
    canAffectMainCurrentLane: false,
    reason: 'trustquote_room_preview_only',
  };
}

function canUseCommsRowAsMainLaneAuthority(row = {}) {
  const metadata = extractMetadata(row);
  const room = extractRoomMetadata(metadata);
  const hasExplicitRoom = Object.keys(room).length > 0
    || Boolean(metadata.roomId || metadata.room_id || metadata.sourceRoomId || metadata.source_room_id);
  const roomStatus = normalizeTrustQuoteRoomEnvelope(metadata);
  if (roomStatus.ok && roomStatus.roomId === TRUSTQUOTE_ROOM_ID) return false;
  if (hasExplicitRoom && roomStatus.roomId !== MAIN_ROOM_ID) return false;
  if (metadataIndicatesTrustQuoteProject(metadata)) return false;

  const windowKey = toText(metadata.windowKey || metadata.window_key || metadata.profile || metadata.profileName || metadata.profile_name, '').toLowerCase();
  if (windowKey === TRUSTQUOTE_ROOM_ID) return false;

  const sessionScopeId = toText(metadata.sessionScopeId || metadata.session_scope_id || row.sessionId || row.session_id, '').toLowerCase();
  if (sessionScopeId.split(':').pop() === TRUSTQUOTE_ROOM_ID) return false;

  if (!hasExplicitRoom && hasTrustQuoteRoomText(row) && !metadataIndicatesTrustedMainProject(metadata)) return false;

  return true;
}

function normalizeTrustQuoteRoomCommsRow(row = {}) {
  const envelope = normalizeTrustQuoteRoomEnvelope(row);
  const timestampMs = Number(row.brokeredAtMs || row.sentAtMs || row.updatedAtMs || row.timestampMs || 0) || 0;
  const visibleBecauseText = hasTrustQuoteText(row);
  const visible = envelope.ok || envelope.visibleInMain || visibleBecauseText;
  if (!visible) return null;

  return {
    messageId: toText(row.messageId || row.message_id, null),
    sessionId: toText(row.sessionId || row.session_id, null),
    senderRole: normalizeInternalRole(row.senderRole || row.sender_role) || toText(row.senderRole || row.sender_role, null),
    targetRole: normalizeInternalRole(row.targetRole || row.target_role) || toText(row.targetRole || row.target_role, null),
    timestampMs,
    rawBody: toText(row.rawBody || row.raw_body || row.body, ''),
    envelope,
    visibleInMain: true,
    canAffectMainCurrentLane: false,
    authorityReason: envelope.reason || 'trustquote_room_activity_non_authoritative',
  };
}

function queryTrustQuoteRoomRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeTrustQuoteRoomCommsRow(row))
    .filter(Boolean)
    .sort((left, right) => right.timestampMs - left.timestampMs);
}

function buildTrustQuoteReadiness(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const pathExists = typeof options.pathExists === 'function'
    ? options.pathExists(projectPath)
    : null;
  const rows = queryTrustQuoteRoomRows(options.commsRows || []);
  const validRows = rows.filter((row) => row.envelope.ok);
  const nonAuthoritativeRows = rows.filter((row) => row.canAffectMainCurrentLane !== true);

  return {
    roomId: TRUSTQUOTE_ROOM_ID,
    status: 'preview_only',
    projectPath,
    projectPathStatus: pathExists === true ? 'present' : (pathExists === false ? 'missing' : 'unchecked'),
    transport: 'existing_comms_journal_metadata',
    envelopeVersion: ROOM_ENVELOPE_VERSION,
    validRoomRowCount: validRows.length,
    visibleNonAuthoritativeRowCount: nonAuthoritativeRows.length,
    canLaunchAgents: false,
    canMutateMainProjectContext: false,
    canAffectMainCurrentLane: false,
    canDispatchExternalAction: false,
    blockers: [
      'explicit_room_launch_not_approved',
      'main_lane_authority_disabled',
      'cross_room_publish_requires_review',
    ],
  };
}

function buildTrustQuoteReadinessCard(options = {}) {
  const readiness = buildTrustQuoteReadiness(options);
  return {
    id: TRUSTQUOTE_ROOM_ID,
    label: 'TrustQuote',
    status: 'PREVIEW',
    authority: 'preview',
    title: 'TrustQuote readiness',
    summary: 'Future TrustQuote room for Builder/Oracle work, product map, and workflow knowledge.',
    details: [
      `Attach target: ${readiness.projectPath}`,
      `Transport: ${readiness.transport}`,
      'Main lane authority: disabled',
      'Cross-room publish: review required',
    ],
    jamesAction: 'JAMES ACTION: NONE',
    readiness,
  };
}

module.exports = {
  MAIN_ROOM_ID,
  ROOM_ENVELOPE_VERSION,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_ROOM_ID,
  buildTrustQuoteReadiness,
  buildTrustQuoteReadinessCard,
  buildTrustQuoteRoomEnvelope,
  canUseCommsRowAsMainLaneAuthority,
  hashRoomBody,
  normalizeTrustQuoteRoomCommsRow,
  normalizeTrustQuoteRoomEnvelope,
  queryTrustQuoteRoomRows,
};
