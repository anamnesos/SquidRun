'use strict';

const crypto = require('node:crypto');

const TEAM_ROOM_SCHEMA = 'squidrun.team_room.v1';
const TEAM_ROOM_DB_USER_VERSION = 3;
const DEFAULT_ROOM_ID = 'main';
const DEFAULT_PROFILE_NAME = 'main';
const MAX_MESSAGE_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_METADATA_BYTES = 64 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 12;
const MAX_CONSECUTIVE_AGENT_POSTS = 6;
const SAME_ROOT_COVERAGE_WINDOW_MS = 45_000;
const TEAM_ROOM_PROMPT_INSTRUCTION = 'reply via hm-room or stay silent.';
const TEAM_ROOM_NOTIFICATION_INSTRUCTION = 'Only when James must be buzzed, add --notify: question requires --reason real_question; needs_james or failure requires --reason new_evidence_or_action or material_dissent_or_correction. Ordinary replies omit --notify.';

const MEMBER_KINDS = Object.freeze({
  HUMAN: 'human',
  AGENT: 'agent',
});

const PARTICIPATION_REASONS = Object.freeze({
  DIRECT_ANSWER: 'direct_answer',
  NEW_EVIDENCE_OR_ACTION: 'new_evidence_or_action',
  MATERIAL_DISSENT_OR_CORRECTION: 'material_dissent_or_correction',
  REAL_QUESTION: 'real_question',
  HUMAN_TEXTURE: 'human_texture',
});

const PARTICIPATION_REASON_SET = new Set(Object.values(PARTICIPATION_REASONS));
const NOTIFICATION_CLASSES = Object.freeze({
  FAILURE: 'failure',
  NEEDS_JAMES: 'needs_james',
  QUESTION: 'question',
});
const NOTIFICATION_CLASS_SET = new Set(Object.values(NOTIFICATION_CLASSES));
const ATTENTION_WORTHY_REASON_SET = new Set([
  PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
  PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION,
  PARTICIPATION_REASONS.REAL_QUESTION,
]);
const ROOT_REENTRY_REASON_SET = new Set([
  PARTICIPATION_REASONS.DIRECT_ANSWER,
  PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
  PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION,
]);

const HUMAN_ROOT_AUTOMATIC_REENTRY_REASON_SET = new Set([
  PARTICIPATION_REASONS.DIRECT_ANSWER,
  PARTICIPATION_REASONS.HUMAN_TEXTURE,
  PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION,
  PARTICIPATION_REASONS.REAL_QUESTION,
]);

const ALWAYS_ADDITIVE_REASON_SET = new Set([
  PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION,
  PARTICIPATION_REASONS.REAL_QUESTION,
]);

const SUBSTANCE_STOP_WORDS = new Set([
  'a', 'about', 'actually', 'again', 'agent', 'all', 'also', 'am', 'an', 'and', 'answer',
  'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'could', 'damn', 'did',
  'do', 'does', 'doing', 'evidence', 'for', 'from', 'fuck', 'fucking', 'ha', 'had', 'has',
  'have', 'having', 'he', 'hell', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
  'im', 'in', 'into', 'is', 'it', 'its', 'james', 'just', 'me', 'mine', 'my', 'new',
  'next', 'no', 'not', 'now', 'of', 'officially', 'oh', 'on', 'one', 'or', 'our', 'ours',
  'perfect', 'post', 'really', 'result', 'she', 'so', 'some', 'that', 'thats', 'the',
  'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'thing', 'this', 'those',
  'through', 'to', 'too', 'update', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'whole', 'why', 'will', 'with', 'would', 'yeah', 'yep', 'yes', 'you',
  'your', 'youre', 'yours',
]);

const SUBSTANCE_ALIASES = Object.freeze({
  aio: 'cooler',
  app: 'mobileapp',
  apps: 'mobileapp',
  attachment: 'photo',
  attachments: 'photo',
  blazing: 'glow',
  came: 'deliver',
  cyan: 'teal',
  delivered: 'deliver',
  display: 'display',
  displays: 'display',
  glowing: 'glow',
  homescreen: 'mobileapp',
  icon: 'mobileapp',
  icons: 'mobileapp',
  image: 'photo',
  images: 'photo',
  lit: 'glow',
  machine: 'rig',
  mobile: 'phone',
  paired: 'pair',
  pairing: 'pair',
  pc: 'rig',
  pcs: 'rig',
  photo: 'photo',
  photos: 'photo',
  picture: 'photo',
  pictures: 'photo',
  pocket: 'phone',
  readable: 'read',
  reading: 'read',
  received: 'deliver',
  rig: 'rig',
  rigs: 'rig',
  rog: 'cooler',
  ryuo: 'cooler',
  screen: 'display',
  screens: 'display',
  sent: 'deliver',
  strimer: 'strimer',
  strimers: 'strimer',
  worked: 'work',
  working: 'work',
  works: 'work',
});

const ROOM_MEMBER_MENTION_ALIASES = Object.freeze({
  architect: Object.freeze(['architect', 'mira']),
  builder: Object.freeze(['builder', 'rook']),
  james: Object.freeze(['james']),
  oracle: Object.freeze(['oracle', 'vera']),
});
const DIRECT_ROOM_MENTION_PATTERN = /(^|[^\p{L}\p{N}_])@(?:architect|builder|james|mira|oracle|rook|vera)\b/iu;

const EXPLICIT_ROOM_SOURCES = new Set([
  'room_cli',
  'room_web',
  'room_electron',
]);

const FORBIDDEN_CLIENT_IDENTITY_FIELDS = Object.freeze([
  'author',
  'authorId',
  'authorType',
  'authorityClass',
  'avatarKey',
  'displayName',
  'memberId',
  'memberKind',
  'paneId',
  'profile',
  'profileName',
  'role',
  'roomId',
  'source',
]);

const FORBIDDEN_METADATA_KEY_PATTERN = /(?:password|passphrase|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|card[_-]?(?:number|no)|cvv|cvc|ssn|social[_-]?security|routing[_-]?number|bank[_-]?account|government[_-]?id)/iu;
const DANGEROUS_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_ROOM_MEMBERS = Object.freeze([
  Object.freeze({
    memberId: 'james',
    roomId: DEFAULT_ROOM_ID,
    profileName: DEFAULT_PROFILE_NAME,
    displayName: 'James',
    memberKind: MEMBER_KINDS.HUMAN,
    role: 'james',
    avatarKey: 'james',
    active: true,
  }),
  Object.freeze({
    memberId: 'architect',
    roomId: DEFAULT_ROOM_ID,
    profileName: DEFAULT_PROFILE_NAME,
    displayName: 'Mira',
    memberKind: MEMBER_KINDS.AGENT,
    role: 'architect',
    paneId: '1',
    avatarKey: 'architect',
    active: true,
  }),
  Object.freeze({
    memberId: 'builder',
    roomId: DEFAULT_ROOM_ID,
    profileName: DEFAULT_PROFILE_NAME,
    displayName: 'Rook',
    memberKind: MEMBER_KINDS.AGENT,
    role: 'builder',
    paneId: '2',
    avatarKey: 'builder',
    active: true,
  }),
  Object.freeze({
    memberId: 'oracle',
    roomId: DEFAULT_ROOM_ID,
    profileName: DEFAULT_PROFILE_NAME,
    displayName: 'Vera',
    memberKind: MEMBER_KINDS.AGENT,
    role: 'oracle',
    paneId: '3',
    avatarKey: 'oracle',
    active: true,
  }),
]);

function resultError(reason, details = null) {
  return details === null
    ? { ok: false, reason }
    : { ok: false, reason, details };
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSafeIdentifier(value, max = 160) {
  const text = toTrimmedString(value);
  return Boolean(text && text.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text));
}

function normalizeMessageKind(value) {
  const kind = toTrimmedString(value || 'text').toLowerCase();
  if (!kind || kind.length > 64 || !/^[a-z][a-z0-9._-]*$/u.test(kind)) return '';
  return kind;
}

function normalizeParticipationReason(value) {
  const reason = toTrimmedString(value).toLowerCase();
  return PARTICIPATION_REASON_SET.has(reason) ? reason : '';
}

function normalizeRoomNotificationClass(value) {
  const notificationClass = toTrimmedString(value).toLowerCase();
  return NOTIFICATION_CLASS_SET.has(notificationClass) ? notificationClass : '';
}

function isRoomNotificationClassAllowed(notificationClass, participationReason) {
  if (notificationClass === NOTIFICATION_CLASSES.QUESTION) {
    return participationReason === PARTICIPATION_REASONS.REAL_QUESTION;
  }
  if ([NOTIFICATION_CLASSES.NEEDS_JAMES, NOTIFICATION_CLASSES.FAILURE].includes(notificationClass)) {
    return [
      PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION,
    ].includes(participationReason);
  }
  return false;
}

/**
 * Origin-independent notification policy for James's room client.
 *
 * This deliberately fails quiet: only a trusted agent message carrying both
 * an attention-worthy participation reason and an explicit compatible
 * notification class may badge or ping another member. Direct answers and
 * human texture remain in-room conversation, not notification noise. Push
 * transport, permissions, and subscription lifecycle belong to the secure
 * origin and are not part of this classifier.
 */
function classifyRoomMessageAttention(message = {}, viewer = {}) {
  const viewerMemberId = toTrimmedString(viewer.memberId).toLowerCase();
  const authorMemberId = toTrimmedString(message.authorId || message.author?.memberId).toLowerCase();
  const authorMemberKind = toTrimmedString(message.author?.memberKind || message.authorMemberKind).toLowerCase();
  const participationReason = normalizeParticipationReason(message.participationReason);
  const notificationClass = normalizeRoomNotificationClass(
    message.notificationClass || message.metadata?.notificationClass
  );

  const quiet = (reason) => ({
    level: 'quiet',
    shouldBadge: false,
    shouldNotify: false,
    reason,
  });

  if (!viewerMemberId) return quiet('viewer_member_required');
  if (!authorMemberId) return quiet('author_member_required');
  if (authorMemberId === viewerMemberId) return quiet('own_message');
  if (authorMemberKind !== MEMBER_KINDS.AGENT) return quiet('non_agent_message');
  if (!participationReason) return quiet('participation_reason_invalid');
  if (!notificationClass) return quiet('notification_not_requested');
  if (!isRoomNotificationClassAllowed(notificationClass, participationReason)) {
    return quiet('notification_class_reason_mismatch');
  }
  if (!ATTENTION_WORTHY_REASON_SET.has(participationReason)) {
    return quiet(`reason_${participationReason}`);
  }

  return {
    level: 'ping',
    shouldBadge: true,
    shouldNotify: true,
    notificationClass,
    reason: `reason_${participationReason}`,
  };
}

function normalizeSubstanceToken(value) {
  let token = String(value || '').toLowerCase();
  if (!token) return '';
  if (SUBSTANCE_ALIASES[token]) return SUBSTANCE_ALIASES[token];
  if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith('ed')) token = token.slice(0, -2);
  else if (token.length > 4 && token.endsWith('s')) token = token.slice(0, -1);
  return SUBSTANCE_ALIASES[token] || token;
}

function extractSubstanceTokens(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bhome\s+screen\b/gu, ' homescreen ')
    .replace(/°/gu, '');
  const tokens = text.match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(tokens
    .map(normalizeSubstanceToken)
    .filter((token) => token && !SUBSTANCE_STOP_WORDS.has(token))
    .filter((token) => token.length >= 2 || /^\d+$/u.test(token)))];
}

function hasDirectRoomMention(value) {
  return DIRECT_ROOM_MENTION_PATTERN.test(String(value || ''));
}

function hasRoomMemberMention(value, memberId) {
  const member = toTrimmedString(memberId).toLowerCase();
  if (!isSafeIdentifier(member, 64)) return false;
  const aliases = ROOM_MEMBER_MENTION_ALIASES[member] || [member];
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}\\b`, 'iu').test(String(value || ''));
  });
}

function classifySameRootCoverage(input = {}) {
  const priorPosts = (Array.isArray(input.priorPosts) ? input.priorPosts : [])
    .filter((post) => post && typeof post === 'object');
  const participationReason = normalizeParticipationReason(input.participationReason);
  if (priorPosts.length === 0) return { covered: false, reason: 'no_prior_agent_post' };
  if (ALWAYS_ADDITIVE_REASON_SET.has(participationReason)) {
    return { covered: false, reason: 'protected_additive_reason' };
  }
  if (hasDirectRoomMention(input.body)
    || hasRoomMemberMention(input.activatedBody, input.memberId)) {
    return { covered: false, reason: 'direct_mention' };
  }
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    return { covered: false, reason: 'attachments_are_additive' };
  }

  const mostRecent = priorPosts[0];
  if (participationReason === PARTICIPATION_REASONS.HUMAN_TEXTURE) {
    return {
      covered: true,
      reason: 'social_beat_already_covered',
      coveredByAgentId: mostRecent.authorId,
      coveredByMessageId: mostRecent.messageId,
      coverageRatio: 1,
    };
  }

  const candidateBody = String(input.body || '');
  if (participationReason !== PARTICIPATION_REASONS.DIRECT_ANSWER) {
    return { covered: false, reason: 'reason_class_is_additive' };
  }
  if (candidateBody.length > 200 || candidateBody.includes('?')) {
    return { covered: false, reason: 'not_a_trivial_answer' };
  }

  const candidateTokens = extractSubstanceTokens(candidateBody);
  const contextTokens = new Set();
  for (const prior of priorPosts) {
    for (const token of extractSubstanceTokens(prior.body)) contextTokens.add(token);
  }
  const matchedTokens = candidateTokens.filter((token) => contextTokens.has(token));
  const coverageRatio = candidateTokens.length === 0 ? 1 : matchedTokens.length / candidateTokens.length;
  const covered = candidateTokens.length === 0
    || matchedTokens.length === candidateTokens.length;
  if (!covered) {
    return { covered: false, reason: 'new_substance', coverageRatio };
  }

  let bestPrior = mostRecent;
  let bestOverlap = -1;
  for (const prior of priorPosts) {
    const priorTokens = new Set(extractSubstanceTokens(prior.body));
    const overlap = candidateTokens.filter((token) => priorTokens.has(token)).length;
    if (overlap > bestOverlap) {
      bestPrior = prior;
      bestOverlap = overlap;
    }
  }
  return {
    covered: true,
    reason: candidateTokens.length === 0 ? 'low_substance_already_covered' : 'substance_already_covered',
    coveredByAgentId: bestPrior.authorId,
    coveredByMessageId: bestPrior.messageId,
    coverageRatio,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeJsonValue(value, state, keyPath = '$', depth = 0) {
  if (depth > 12) return resultError('room_message_metadata_too_deep', { path: keyPath });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value }
      : resultError('room_message_metadata_number_invalid', { path: keyPath });
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) return resultError('room_message_metadata_cycle', { path: keyPath });
    state.seen.add(value);
    const normalized = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = normalizeJsonValue(value[index], state, `${keyPath}[${index}]`, depth + 1);
      if (!item.ok) return item;
      normalized.push(item.value);
    }
    state.seen.delete(value);
    return { ok: true, value: normalized };
  }
  if (!value || typeof value !== 'object') {
    return resultError('room_message_metadata_value_invalid', { path: keyPath });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return resultError('room_message_metadata_object_invalid', { path: keyPath });
  }
  if (state.seen.has(value)) return resultError('room_message_metadata_cycle', { path: keyPath });
  state.seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value)) {
    if (!key || key.length > 128 || DANGEROUS_METADATA_KEYS.has(key)) {
      return resultError('room_message_metadata_key_invalid', { path: `${keyPath}.${key}` });
    }
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) {
      return resultError('room_sensitive_metadata_forbidden', { path: `${keyPath}.${key}` });
    }
    const item = normalizeJsonValue(value[key], state, `${keyPath}.${key}`, depth + 1);
    if (!item.ok) return item;
    normalized[key] = item.value;
  }
  state.seen.delete(value);
  return { ok: true, value: normalized };
}

function normalizeMessageMetadata(value) {
  if (value === undefined) return { ok: true, metadata: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return resultError('room_message_metadata_invalid');
  }
  const normalized = normalizeJsonValue(value, { seen: new Set() });
  if (!normalized.ok) return normalized;
  if (Buffer.byteLength(canonicalJson(normalized.value), 'utf8') > MAX_MESSAGE_METADATA_BYTES) {
    return resultError('room_message_metadata_too_large');
  }
  return { ok: true, metadata: normalized.value };
}

function luhnValid(candidate) {
  const digits = String(candidate || '').replace(/[ -]/gu, '');
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function findHighRiskSecret(body) {
  const text = String(body || '');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) return 'private_key';
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(text)) return 'aws_access_key';
  if (/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u.test(text)) return 'api_key';
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/iu.test(text)) return 'bearer_token';
  if (/\b\d{3}-\d{2}-\d{4}\b/u.test(text)) return 'government_id';
  const cardCandidates = text.match(/(?:\d[ -]?){13,19}/gu) || [];
  if (cardCandidates.some(luhnValid)) return 'payment_card';
  return null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function validateTrustedIdentity(identity = {}) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return resultError('trusted_identity_required');
  }
  const memberId = toTrimmedString(identity.memberId).toLowerCase();
  const roomId = toTrimmedString(identity.roomId || DEFAULT_ROOM_ID).toLowerCase();
  const profileName = toTrimmedString(identity.profileName || DEFAULT_PROFILE_NAME).toLowerCase();
  const memberKind = toTrimmedString(identity.memberKind).toLowerCase();
  const role = toTrimmedString(identity.role).toLowerCase();
  const paneId = identity.paneId === undefined || identity.paneId === null
    ? null
    : toTrimmedString(identity.paneId);
  const source = toTrimmedString(identity.source).toLowerCase();

  if (!isSafeIdentifier(memberId)) return resultError('trusted_member_id_invalid');
  if (!isSafeIdentifier(roomId)) return resultError('trusted_room_id_invalid');
  if (!isSafeIdentifier(profileName)) return resultError('trusted_profile_invalid');
  if (![MEMBER_KINDS.HUMAN, MEMBER_KINDS.AGENT].includes(memberKind)) {
    return resultError('trusted_member_kind_invalid');
  }
  if (!isSafeIdentifier(role, 64)) return resultError('trusted_role_invalid');
  if (memberKind === MEMBER_KINDS.AGENT && !isSafeIdentifier(paneId, 32)) {
    return resultError('trusted_agent_pane_id_required');
  }
  if (!EXPLICIT_ROOM_SOURCES.has(source)) return resultError('trusted_room_source_invalid');

  return {
    ok: true,
    identity: {
      memberId,
      roomId,
      profileName,
      memberKind,
      role,
      paneId,
      source,
      authorityClass: memberKind === MEMBER_KINDS.HUMAN ? 'human_user' : 'room_member_agent',
    },
  };
}

function findForbiddenClientIdentityField(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return FORBIDDEN_CLIENT_IDENTITY_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(payload, field)) || null;
}

function normalizeAttachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) return null;
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    const id = toTrimmedString(item);
    if (!isSafeIdentifier(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function normalizeClientPost(payload = {}, identity = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return resultError('room_post_payload_required');
  }
  const forbiddenField = findForbiddenClientIdentityField(payload);
  if (forbiddenField) {
    return resultError('client_identity_field_forbidden', { field: forbiddenField });
  }
  const trusted = validateTrustedIdentity(identity);
  if (!trusted.ok) return trusted;

  const kind = normalizeMessageKind(payload.kind);
  if (!kind) return resultError('room_message_kind_invalid');
  const body = typeof payload.body === 'string' ? payload.body.replace(/\r\n/gu, '\n') : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BODY_BYTES) {
    return resultError('room_message_body_too_large');
  }
  const attachmentIds = normalizeAttachmentIds(payload.attachmentIds);
  if (attachmentIds === null) return resultError('room_attachment_ids_invalid');
  if (!body.trim() && attachmentIds.length === 0) return resultError('room_message_empty');
  const highRiskSecret = findHighRiskSecret(body);
  if (highRiskSecret) return resultError('room_sensitive_content_forbidden', { kind: highRiskSecret });

  const clientNonce = toTrimmedString(payload.clientNonce);
  if (!isSafeIdentifier(clientNonce)) return resultError('room_client_nonce_invalid');
  const replyToMessageId = payload.replyToMessageId === undefined || payload.replyToMessageId === null
    ? null
    : toTrimmedString(payload.replyToMessageId);
  if (replyToMessageId !== null && !isSafeIdentifier(replyToMessageId)) {
    return resultError('room_reply_to_invalid');
  }
  const causalActivationId = payload.causalActivationId === undefined || payload.causalActivationId === null
    ? null
    : toTrimmedString(payload.causalActivationId);
  if (causalActivationId !== null && !isSafeIdentifier(causalActivationId)) {
    return resultError('room_causal_activation_invalid');
  }
  if (payload.agentInitiatedRoot !== undefined && typeof payload.agentInitiatedRoot !== 'boolean') {
    return resultError('room_agent_initiated_root_invalid');
  }
  const agentInitiatedRoot = payload.agentInitiatedRoot === true;

  const participationReason = normalizeParticipationReason(payload.participationReason);
  if (trusted.identity.memberKind === MEMBER_KINDS.AGENT && !participationReason) {
    return resultError('agent_participation_reason_required', {
      allowed: [...PARTICIPATION_REASON_SET],
    });
  }
  if (trusted.identity.memberKind === MEMBER_KINDS.HUMAN && payload.participationReason !== undefined) {
    return resultError('human_participation_reason_forbidden');
  }
  if (trusted.identity.memberKind === MEMBER_KINDS.HUMAN && payload.agentInitiatedRoot !== undefined) {
    return resultError('human_agent_initiated_root_forbidden');
  }
  const notificationClass = normalizeRoomNotificationClass(payload.notificationClass);
  if (payload.notificationClass !== undefined && !notificationClass) {
    return resultError('room_notification_class_invalid', { allowed: [...NOTIFICATION_CLASS_SET] });
  }
  if (trusted.identity.memberKind === MEMBER_KINDS.HUMAN && notificationClass) {
    return resultError('human_notification_class_forbidden');
  }
  if (notificationClass && !isRoomNotificationClassAllowed(notificationClass, participationReason)) {
    return resultError('room_notification_class_reason_mismatch');
  }
  const rootReentry = payload.rootReentry === true;
  if (rootReentry && !ROOT_REENTRY_REASON_SET.has(participationReason)) {
    return resultError('room_root_reentry_reason_invalid');
  }
  if (agentInitiatedRoot && (replyToMessageId || causalActivationId || rootReentry)) {
    return resultError('room_agent_initiated_root_causality_invalid');
  }

  const normalizedMetadata = normalizeMessageMetadata(payload.metadata);
  if (!normalizedMetadata.ok) return normalizedMetadata;

  const post = {
    schema: TEAM_ROOM_SCHEMA,
    kind,
    body,
    clientNonce,
    attachmentIds,
    replyToMessageId,
    causalActivationId,
    agentInitiatedRoot,
    participationReason: participationReason || null,
    rootReentry,
    metadata: notificationClass
      ? { ...normalizedMetadata.metadata, notificationClass }
      : normalizedMetadata.metadata,
  };
  post.contentHash = sha256(canonicalJson(post));
  return { ok: true, identity: trusted.identity, post };
}

function deriveActivationTargets(author, members = DEFAULT_ROOM_MEMBERS) {
  const authorId = toTrimmedString(author?.memberId).toLowerCase();
  return (Array.isArray(members) ? members : [])
    .filter((member) => member && member.active !== false)
    .filter((member) => member.memberKind === MEMBER_KINDS.AGENT)
    .filter((member) => toTrimmedString(member.profileName || DEFAULT_PROFILE_NAME).toLowerCase()
      === toTrimmedString(author?.profileName || DEFAULT_PROFILE_NAME).toLowerCase())
    .filter((member) => toTrimmedString(member.roomId || DEFAULT_ROOM_ID).toLowerCase()
      === toTrimmedString(author?.roomId || DEFAULT_ROOM_ID).toLowerCase())
    .filter((member) => toTrimmedString(member.memberId).toLowerCase() !== authorId)
    .map((member) => toTrimmedString(member.memberId).toLowerCase());
}

function buildActivationPrompt(input = {}) {
  const messageId = toTrimmedString(input.messageId);
  const authorId = toTrimmedString(input.authorId);
  const rootMessageId = toTrimmedString(input.rootMessageId || messageId);
  // Pane injection on some Windows CLI paths can silently drop typographic
  // punctuation. A lost en dash turns a range such as "2–3" into "23", which
  // changes the meaning of the message. Keep the canonical Room body exact in
  // storage, but make the derived agent prompt transport-safe and unambiguous.
  const body = typeof input.body === 'string'
    ? input.body
      .replace(/[\u2010\u2011\u2012\u2013\u2015\u2212]/gu, '-')
      .replace(/\u2014/gu, ' -- ')
      .replace(/[\u2018\u2019]/gu, "'")
      .replace(/[\u201c\u201d]/gu, '"')
      .replace(/\u2026/gu, '...')
      .replace(/[\u00a0\u202f]/gu, ' ')
    : '';
  if (!isSafeIdentifier(messageId) || !isSafeIdentifier(authorId) || !isSafeIdentifier(rootMessageId)) {
    return resultError('room_activation_prompt_identity_invalid');
  }
  const attachmentRefs = Array.isArray(input.attachments) ? input.attachments : [];
  const attachmentLines = attachmentRefs.map((attachment, index) => {
    const id = toTrimmedString(attachment?.attachmentId);
    const mime = toTrimmedString(attachment?.mimeType) || 'application/octet-stream';
    const bytes = Number.isFinite(Number(attachment?.bytes)) ? Math.max(0, Math.floor(Number(attachment.bytes))) : 0;
    const digest = toTrimmedString(attachment?.sha256).toLowerCase();
    const localPath = toTrimmedString(attachment?.localPath);
    return `${index + 1}. id=${id} mime=${mime} bytes=${bytes} sha256=${digest} path=${localPath}`;
  });
  const lines = [
    `[TEAM ROOM messageId=${messageId} author=${authorId} root=${rootMessageId}]`,
    'Read this as a team member. Post only for a direct answer, new evidence/action, material dissent/correction, a real question, or human texture worth sharing.',
    body,
  ];
  if (attachmentLines.length > 0) lines.push('Attachments:', ...attachmentLines);
  lines.push(TEAM_ROOM_NOTIFICATION_INSTRUCTION);
  lines.push(TEAM_ROOM_PROMPT_INSTRUCTION);
  return {
    ok: true,
    prompt: lines.filter((line) => line !== '').join('\n'),
    envelope: {
      schema: TEAM_ROOM_SCHEMA,
      roomMessageId: messageId,
      authorId,
      replyToMessageId: toTrimmedString(input.replyToMessageId) || null,
      rootMessageId,
      attachments: attachmentRefs,
      instruction: TEAM_ROOM_PROMPT_INSTRUCTION,
    },
  };
}

module.exports = {
  DEFAULT_PROFILE_NAME,
  DEFAULT_ROOM_ID,
  DEFAULT_ROOM_MEMBERS,
  EXPLICIT_ROOM_SOURCES,
  FORBIDDEN_CLIENT_IDENTITY_FIELDS,
  HUMAN_ROOT_AUTOMATIC_REENTRY_REASON_SET,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONSECUTIVE_AGENT_POSTS,
  MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_METADATA_BYTES,
  MEMBER_KINDS,
  NOTIFICATION_CLASSES,
  PARTICIPATION_REASONS,
  ROOT_REENTRY_REASON_SET,
  SAME_ROOT_COVERAGE_WINDOW_MS,
  TEAM_ROOM_DB_USER_VERSION,
  TEAM_ROOM_NOTIFICATION_INSTRUCTION,
  TEAM_ROOM_PROMPT_INSTRUCTION,
  TEAM_ROOM_SCHEMA,
  buildActivationPrompt,
  canonicalJson,
  classifyRoomMessageAttention,
  classifySameRootCoverage,
  deriveActivationTargets,
  extractSubstanceTokens,
  findForbiddenClientIdentityField,
  findHighRiskSecret,
  isSafeIdentifier,
  isRoomNotificationClassAllowed,
  normalizeClientPost,
  normalizeMessageKind,
  normalizeMessageMetadata,
  normalizeParticipationReason,
  normalizeRoomNotificationClass,
  sha256,
  validateTrustedIdentity,
};
