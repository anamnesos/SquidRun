const ORACLE_PREFIX_RE = /^\s*\(\s*ORACLE\s*#?(\d+)\s*\)\s*:\s*/i;
const VERDICT_RE = /^(?:oracle\s+(?:final\s+)?(?:verdict\s*)?)?(PASS|MODIFY|BLOCK)\b/i;
const VISIBLE_ACK_STATUSES = new Set([
  'delivered.verified',
  'telegram_delivered',
]);
const PENDING_STATUSES = new Set([
  'recorded',
  'brokered',
  'routed',
]);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeRole(value) {
  const text = asString(value).toLowerCase();
  if (!text) return '';
  if (text === '1') return 'architect';
  if (text === '2') return 'builder';
  if (text === '3') return 'oracle';
  if (text === 'main') return 'architect';
  return text;
}

function normalizeStatus(value) {
  return asString(value).toLowerCase();
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function extractBody(row = {}) {
  const raw = row.rawBody ?? row.raw_body ?? row.body ?? row.message ?? row.content ?? '';
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) return '';
  try {
    return JSON.stringify(raw);
  } catch (_) {
    return String(raw);
  }
}

function extractOracleVerdict(body) {
  const text = extractBody({ rawBody: body });
  if (!text.trim()) return null;
  const prefixMatch = text.match(ORACLE_PREFIX_RE);
  const afterPrefix = prefixMatch ? text.slice(prefixMatch[0].length).trim() : text.trim();
  const verdictMatch = afterPrefix.match(VERDICT_RE);
  if (!verdictMatch || !verdictMatch[1]) return null;
  const sequence = prefixMatch?.[1] ? Number(prefixMatch[1]) : null;
  return {
    verdict: verdictMatch[1].toUpperCase(),
    sourceRef: Number.isFinite(sequence) ? `oracle#${sequence}` : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
  };
}

function inferSenderRole(row = {}, body = '') {
  const explicit = normalizeRole(row.senderRole ?? row.sender_role ?? row.fromRole ?? row.from_role);
  if (explicit) return explicit;
  return ORACLE_PREFIX_RE.test(body) ? 'oracle' : '';
}

function isArchitectMainTarget(row = {}) {
  const role = normalizeRole(row.targetRole ?? row.target_role ?? row.toRole ?? row.to_role ?? row.target);
  return !role || role === 'architect';
}

function isVisibilityVerified(row = {}) {
  const metadata = normalizeMetadata(row.metadata);
  const status = normalizeStatus(row.status);
  const ackStatus = normalizeStatus(row.ackStatus ?? row.ack_status ?? metadata.ackStatus ?? metadata.finalOutcome);
  return Boolean(
    row.visible === true
    || row.userVisible === true
    || metadata.visible === true
    || metadata.userVisible === true
    || metadata.deliveryVerified === true
    || metadata.verified === true
    || status === 'acked'
    || VISIBLE_ACK_STATUSES.has(ackStatus)
  );
}

function isVisibilityPending(row = {}) {
  if (isVisibilityVerified(row)) return false;
  const metadata = normalizeMetadata(row.metadata);
  const status = normalizeStatus(row.status);
  const ackStatus = normalizeStatus(row.ackStatus ?? row.ack_status ?? metadata.ackStatus ?? metadata.finalOutcome);
  if (status === 'failed') return false;
  const acceptedUnverified = (
    metadata.deliveryAccepted === true
    && metadata.deliveryVerified !== true
  );
  return Boolean(
    PENDING_STATUSES.has(status)
    || ackStatus.includes('unverified')
    || ackStatus.includes('timeout')
    || acceptedUnverified
  );
}

function classifyOracleVerdictRow(row = {}) {
  const body = extractBody(row);
  const senderRole = inferSenderRole(row, body);
  const targetOk = isArchitectMainTarget(row);
  const verdict = extractOracleVerdict(body);
  const isOracleVerdict = senderRole === 'oracle' && targetOk && Boolean(verdict);
  const visible = isOracleVerdict ? isVisibilityVerified(row) : false;
  const pending = isOracleVerdict ? isVisibilityPending(row) : false;
  return {
    isOracleVerdict,
    pending,
    visible,
    verdict: verdict?.verdict || null,
    sourceRef: verdict?.sourceRef || null,
    sequence: verdict?.sequence || null,
    messageId: row.messageId || row.message_id || null,
    status: normalizeStatus(row.status) || null,
    ackStatus: normalizeStatus(row.ackStatus ?? row.ack_status ?? normalizeMetadata(row.metadata).finalOutcome) || null,
    senderRole,
    targetRole: normalizeRole(row.targetRole ?? row.target_role ?? row.toRole ?? row.to_role ?? row.target) || null,
    body,
  };
}

function bodyPreview(body, limit = 220) {
  const text = asString(body).replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function rowTimestamp(row = {}) {
  const value = Number(row.brokeredAtMs ?? row.sentAtMs ?? row.updatedAtMs ?? row.timestampMs ?? row.ts);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildPendingOracleVerdictPayload(row = {}, options = {}) {
  const classification = classifyOracleVerdictRow(row);
  if (!classification.isOracleVerdict || !classification.pending) return null;
  const messageId = classification.messageId || options.messageId || null;
  const sourceRef = classification.sourceRef || options.sourceRef || null;
  const ackStatus = classification.ackStatus || 'visibility_unverified';
  return {
    kind: 'oracle_verdict_visibility_pending',
    messageId,
    sourceRef,
    verdict: classification.verdict,
    senderRole: 'oracle',
    targetRole: classification.targetRole || 'architect',
    status: classification.status || 'recorded',
    ackStatus,
    sentAtMs: rowTimestamp(row) || options.sentAtMs || Date.now(),
    bodyPreview: bodyPreview(classification.body),
    summary: `Oracle ${classification.verdict} visibility unverified${sourceRef ? ` (${sourceRef})` : ''}: ${ackStatus}`,
  };
}

function collectPendingOracleVerdicts(rows = [], options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 3));
  const seen = new Set();
  const pending = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = buildPendingOracleVerdictPayload(row);
    if (!payload) continue;
    const key = payload.messageId || payload.sourceRef || `${payload.verdict}:${payload.sentAtMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(payload);
    if (pending.length >= limit) break;
  }
  return pending;
}

module.exports = {
  classifyOracleVerdictRow,
  collectPendingOracleVerdicts,
  buildPendingOracleVerdictPayload,
  extractOracleVerdict,
};
