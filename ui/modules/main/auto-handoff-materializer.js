const fs = require('fs');
const path = require('path');
const {
  WORKSPACE_PATH,
  resolveCoordPath,
} = require('../../config');
const {
  queryCommsJournalEntries,
} = require('./comms-journal');
const { executeTeamMemoryOperation } = require('../team-memory/runtime');
const {
  parseSessionNumber,
  querySessionSummariesFromMemory,
  readFallbackSummary,
} = require('../../scripts/hm-session-summary');

const HANDOFFS_RELATIVE_DIR = 'handoffs';
const SESSION_HANDOFF_FILE = 'session.md';
const LEGACY_PANE_HANDOFFS = ['1.md', '2.md', '3.md'];
const DEFAULT_QUERY_LIMIT = 5000;
const DEFAULT_SESSION_HISTORY_LIMIT = 3;
const DEFAULT_RECENT_LIMIT = 250;
const DEFAULT_TAGGED_LIMIT = 120;
const DEFAULT_CROSS_SESSION_LIMIT = 120;
const DEFAULT_FAILURE_LIMIT = 80;
const DEFAULT_PENDING_LIMIT = 80;
const PREVIEW_LIMIT = 180;
const CLAIM_STATEMENT_LIMIT = 100;
const PENDING_DELIVERY_STATUSES = new Set(['recorded', 'routed']);
const UNRESOLVED_CLAIMS_MAX = 10;
const UNRESOLVED_STATUS_ORDER = ['contested', 'pending_proof', 'proposed'];
const UNRESOLVED_STATUS_SET = new Set(UNRESOLVED_STATUS_ORDER);
const CROSS_SESSION_TAGS = new Set(['DECISION', 'TASK', 'FINDING', 'BLOCKER']);
const DIGEST_TAGS = new Set(['DECISION', 'FINDING']);
const DIGEST_SESSION_LIMIT = 10;
const CROSS_SESSION_AGE_LIMIT = DIGEST_SESSION_LIMIT;
const DIGEST_HIGHLIGHT_LIMIT = 4;
const TAG_PATTERN = /^(DECISION|TASK|FINDING|BLOCKER)\s*:\s*(.+)$/i;
const KNOWN_TAG_PREFIX_PATTERNS = [
  /^\[[^\]]+\]\s*/,
  /^\([^)]+#\d+\)\s*:\s*/i,
  /^[-*]\s+/,
];
const TRANSPORT_ARTIFACT_CLAIM_PATTERNS = [
  /^(delivered|broadcast|routed)[._-]?(verified|unverified)$/i,
  /\bdelivered[._-]?verified\b/i,
  /\binitializing session\b/i,
  /\bsession started\b/i,
];
const LEGACY_BOOTSTRAP_SESSION_ID_PATTERN = /^app-\d+-\d+$/i;
const SESSION_BOOTSTRAP_NOISE_PATTERNS = [
  /^\((?:architect|builder|oracle)\s+#\d+\):\s+.+\bonline\.\s+standing by\.?$/i,
  /^\((?:architect|builder|oracle)\s+#\d+\):\s+standing by(?: for tasking)?\.?$/i,
  /^\((?:architect|builder|oracle)\s+#\d+\):\s+copy\.\s+clean session(?:,\s+no pending work)?\.\s+stand by(?: for tasking)?\.?$/i,
  /^\((?:architect|builder|oracle)\s+#\d+\):\s+clean session(?:,\s+no pending work)?\.\s+stand by(?: for tasking)?\.?$/i,
];

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeAppSessionScopeId(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase();
  const appSessionMatch = normalized.match(/^app-session-(\d+)/);
  if (appSessionMatch) {
    const sessionNumber = Number.parseInt(appSessionMatch[1], 10);
    if (Number.isInteger(sessionNumber) && sessionNumber > 0) {
      return `app-session-${sessionNumber}`;
    }
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    const sessionNumber = Number.parseInt(normalized, 10);
    if (Number.isInteger(sessionNumber) && sessionNumber > 0) {
      return `app-session-${sessionNumber}`;
    }
  }
  return null;
}

function isLegacyBootstrapSessionId(value) {
  return LEGACY_BOOTSTRAP_SESSION_ID_PATTERN.test(String(value || '').trim());
}

function resolveCurrentSessionScopeIdFromAppStatus() {
  if (typeof resolveCoordPath !== 'function') return null;
  const appStatusPath = resolveCoordPath('app-status.json');
  const appStatus = readJsonFileSafe(appStatusPath);
  if (!appStatus || typeof appStatus !== 'object') return null;
  const fromNumber = normalizeAppSessionScopeId(appStatus.session ?? appStatus.sessionNumber);
  if (fromNumber) return fromNumber;
  return normalizeAppSessionScopeId(appStatus.session_id ?? appStatus.sessionId);
}

function resolveEffectiveSessionScopeId(requestedSessionId, options = {}) {
  const requested = toOptionalString(requestedSessionId, null);
  const normalizedRequestedScope = normalizeAppSessionScopeId(requested);
  if (normalizedRequestedScope) return normalizedRequestedScope;

  if (requested && !isLegacyBootstrapSessionId(requested)) {
    return requested;
  }

  const currentScopeRaw = typeof options.resolveCurrentSessionScopeId === 'function'
    ? options.resolveCurrentSessionScopeId()
    : resolveCurrentSessionScopeIdFromAppStatus();
  const currentScope = normalizeAppSessionScopeId(currentScopeRaw);
  if (currentScope) return currentScope;

  return requested;
}

function toEventTsMs(row) {
  const candidates = [
    row?.brokeredAtMs,
    row?.sentAtMs,
    row?.updatedAtMs,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }
  return 0;
}

function toIso(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '-';
  try {
    return new Date(numeric).toISOString();
  } catch {
    return '-';
  }
}

function normalizeInline(text, limit = PREVIEW_LIMIT) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '-';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function escapeMarkdownCell(value) {
  return String(value || '-').replace(/\|/g, '\\|');
}

function safeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function stripKnownTagPrefixes(line) {
  let normalized = String(line || '').trim();
  if (!normalized) return '';
  for (let i = 0; i < 6; i += 1) {
    let changed = false;
    for (const pattern of KNOWN_TAG_PREFIX_PATTERNS) {
      const next = normalized.replace(pattern, '');
      if (next !== normalized) {
        normalized = next.trimStart();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return normalized;
}

function extractTraceId(row) {
  const metadata = safeJsonObject(row?.metadata);
  const traceContext = safeJsonObject(metadata.traceContext);
  return (
    toOptionalString(metadata.traceId)
    || toOptionalString(metadata.trace_id)
    || toOptionalString(metadata.correlationId)
    || toOptionalString(metadata.correlation_id)
    || toOptionalString(traceContext.traceId)
    || toOptionalString(traceContext.trace_id)
    || '-'
  );
}

function extractTag(rawBody) {
  const lines = String(rawBody || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const normalizedLine = stripKnownTagPrefixes(line);
    const match = normalizedLine.match(TAG_PATTERN);
    if (!match) continue;
    const detail = normalizeInline(match[2] || '');
    if (!detail || detail === '-') continue;
    return {
      tag: String(match[1] || '').toUpperCase(),
      detail,
    };
  }
  return null;
}

function formatCounts(counts, keys) {
  return keys.map((key) => `${key}=${counts[key] || 0}`).join(', ');
}

function normalizeDeliveryToken(value) {
  return toOptionalString(value, '').toLowerCase();
}

function hasFailureDeliverySignal(ackStatus = '', errorCode = null) {
  if (toOptionalString(errorCode, null)) return true;
  return (
    ackStatus.includes('fail')
    || ackStatus.includes('error')
    || ackStatus.includes('timeout')
    || ackStatus.includes('rejected')
  );
}

function hasPendingDeliverySignal(ackStatus = '') {
  return (
    ackStatus.includes('pending')
    || ackStatus.includes('queue')
    || ackStatus.includes('unverified')
    || ackStatus.includes('accepted')
    || ackStatus.includes('routed')
    || ackStatus.includes('processing')
    || ackStatus.includes('inflight')
  );
}

function truncateClaimStatement(value, limit = CLAIM_STATEMENT_LIMIT) {
  return normalizeInline(value, Math.max(1, Number(limit) || CLAIM_STATEMENT_LIMIT));
}

function formatConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return Number(numeric.toFixed(2)).toString();
}

function isTransportArtifactClaimStatement(statement) {
  const normalized = toOptionalString(statement, '').toLowerCase();
  if (!normalized) return false;
  return TRANSPORT_ARTIFACT_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isTestNoiseRow(row = {}) {
  return String(row?.senderRole || '').toLowerCase() === 'cli'
    && String(row?.rawBody || '').startsWith('(TEST ');
}

function isMeaningfulHandoffRow(row = {}) {
  const body = toOptionalString(row?.rawBody, '');
  if (!body) return false;
  if (isTestNoiseRow(row)) return false;
  return !SESSION_BOOTSTRAP_NOISE_PATTERNS.some((pattern) => pattern.test(body));
}

function filterMeaningfulRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isMeaningfulHandoffRow(row));
}

function groupRowsBySession(rows = []) {
  const groups = new Map();
  for (const row of sortByEventTsAsc(Array.isArray(rows) ? rows : [])) {
    const sessionId = toOptionalString(row?.sessionId, null);
    if (!sessionId) continue;
    if (!groups.has(sessionId)) {
      groups.set(sessionId, []);
    }
    groups.get(sessionId).push(row);
  }
  return groups;
}

function selectSourceSessionRows(currentSessionId, currentRows = [], allRows = []) {
  const normalizedCurrentSessionId = toOptionalString(currentSessionId, null);
  const currentSessionRows = Array.isArray(currentRows) ? currentRows : [];
  const currentMeaningfulRows = filterMeaningfulRows(currentSessionRows);
  if (currentMeaningfulRows.length > 0) {
    return {
      sessionId: normalizedCurrentSessionId,
      rows: currentSessionRows,
      meaningfulRows: currentMeaningfulRows,
      usedFallback: false,
      fallbackSessionId: null,
      fallbackRows: [],
      fallbackMeaningfulRows: [],
      fallbackLatestTsMs: 0,
    };
  }

  const groups = groupRowsBySession(allRows);
  const candidates = [];
  for (const [sessionId, sessionRows] of groups.entries()) {
    if (!sessionId || sessionId === normalizedCurrentSessionId) continue;
    const meaningfulRows = filterMeaningfulRows(sessionRows);
    if (meaningfulRows.length === 0) continue;
    const latestTsMs = sessionRows.reduce((max, row) => Math.max(max, toEventTsMs(row)), 0);
    candidates.push({
      sessionId,
      rows: sessionRows,
      meaningfulRows,
      latestTsMs,
    });
  }

  candidates.sort((left, right) => {
    if (left.latestTsMs !== right.latestTsMs) return right.latestTsMs - left.latestTsMs;
    return left.sessionId.localeCompare(right.sessionId);
  });

  const fallback = candidates[0];
  if (!fallback) {
    return {
      sessionId: normalizedCurrentSessionId,
      rows: currentSessionRows,
      meaningfulRows: currentMeaningfulRows,
      usedFallback: false,
      fallbackSessionId: null,
      fallbackRows: [],
      fallbackMeaningfulRows: [],
      fallbackLatestTsMs: 0,
    };
  }

  return {
    sessionId: normalizedCurrentSessionId,
    rows: currentSessionRows,
    meaningfulRows: currentMeaningfulRows,
    usedFallback: true,
    fallbackSessionId: fallback.sessionId,
    fallbackRows: fallback.rows,
    fallbackMeaningfulRows: fallback.meaningfulRows,
    fallbackLatestTsMs: fallback.latestTsMs,
  };
}

function normalizePriorSessionSummary(summary = {}) {
  const content = toOptionalString(summary?.content, null);
  if (!content) return null;
  const sessionNumber = parseSessionNumber(summary?.sessionNumber);
  const createdAtMs = Number.isFinite(Number(summary?.createdAtMs))
    ? Math.max(0, Math.floor(Number(summary.createdAtMs)))
    : 0;
  return {
    nodeId: toOptionalString(summary?.nodeId, null) || `summary-${sessionNumber || 'unknown'}-${createdAtMs || 'fallback'}`,
    content,
    sessionNumber,
    createdAtMs,
  };
}

function gatherPriorSessionSummaries(limit = 3, options = {}) {
  const maxResults = Math.max(1, Math.min(20, Number(limit) || DEFAULT_SESSION_HISTORY_LIMIT));
  const queryFn = typeof options.querySessionSummariesFromMemory === 'function'
    ? options.querySessionSummariesFromMemory
    : querySessionSummariesFromMemory;
  const fallbackFn = typeof options.readFallbackSummary === 'function'
    ? options.readFallbackSummary
    : readFallbackSummary;

  let summaries = [];
  try {
    const queriedSummaries = queryFn(maxResults, {
      cognitiveMemoryApi: options.cognitiveMemoryApi,
    });
    summaries = Array.isArray(queriedSummaries) ? queriedSummaries : [];
  } catch {
    summaries = [];
  }

  const normalized = summaries
    .map((summary) => normalizePriorSessionSummary(summary))
    .filter(Boolean)
    .slice(0, maxResults);
  if (normalized.length > 0) return normalized;

  const fallbackContent = fallbackFn(options.fallbackPath);
  const fallbackSummary = normalizePriorSessionSummary({
    nodeId: 'fallback-last-session-summary',
    content: fallbackContent,
    sessionNumber: null,
    createdAtMs: 0,
  });
  return fallbackSummary ? [fallbackSummary] : [];
}

async function querySessionSnapshotSummary(sessionId, options = {}) {
  if (typeof options.querySessionSnapshot !== 'function') return null;
  try {
    const snapshot = await Promise.resolve(options.querySessionSnapshot({ sessionId }));
    const payload = safeJsonObject(snapshot?.content && typeof snapshot.content === 'object'
      ? snapshot.content
      : snapshot);
    const sessionSummary = safeJsonObject(payload.sessionSummary);
    const content = toOptionalString(
      sessionSummary.summaryMarkdown
      || sessionSummary.summaryText
      || payload.summaryMarkdown
      || payload.summaryText,
      null
    );
    if (!content) return null;
    return normalizePriorSessionSummary({
      nodeId: toOptionalString(snapshot?.snapshotId, null) || 'session-end-snapshot',
      content,
      sessionNumber: parseSessionNumber(sessionSummary.sessionNumber ?? payload.session),
      createdAtMs: Number(sessionSummary.createdAtMs ?? snapshot?.createdAtMs ?? 0) || 0,
    });
  } catch {
    return null;
  }
}

function normalizeUnresolvedClaims(claims = [], maxClaims = UNRESOLVED_CLAIMS_MAX) {
  const limit = Math.max(1, Number(maxClaims) || UNRESOLVED_CLAIMS_MAX);
  const dedup = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const claimId = toOptionalString(claim?.id, null);
    if (!claimId) continue;
    const status = toOptionalString(claim?.status, '').toLowerCase();
    if (!UNRESOLVED_STATUS_SET.has(status)) continue;
    const rawStatement = toOptionalString(claim?.statement, '');
    if (!rawStatement || isTransportArtifactClaimStatement(rawStatement)) continue;
    const normalized = {
      id: claimId,
      status,
      statement: truncateClaimStatement(rawStatement),
      confidence: Number.isFinite(Number(claim?.confidence)) ? Number(claim.confidence) : null,
    };
    const current = dedup.get(claimId);
    if (!current) {
      dedup.set(claimId, normalized);
      continue;
    }
    const currentConfidence = Number.isFinite(Number(current.confidence)) ? Number(current.confidence) : Number.NEGATIVE_INFINITY;
    const nextConfidence = Number.isFinite(Number(normalized.confidence)) ? Number(normalized.confidence) : Number.NEGATIVE_INFINITY;
    if (nextConfidence > currentConfidence) {
      dedup.set(claimId, normalized);
    }
  }

  const priority = new Map(UNRESOLVED_STATUS_ORDER.map((status, index) => [status, index]));
  return Array.from(dedup.values())
    .sort((left, right) => {
      const leftPriority = priority.has(left.status) ? priority.get(left.status) : Number.MAX_SAFE_INTEGER;
      const rightPriority = priority.has(right.status) ? priority.get(right.status) : Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const leftConfidence = Number.isFinite(Number(left.confidence)) ? Number(left.confidence) : Number.NEGATIVE_INFINITY;
      const rightConfidence = Number.isFinite(Number(right.confidence)) ? Number(right.confidence) : Number.NEGATIVE_INFINITY;
      if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}

async function queryUnresolvedClaims(options = {}) {
  const unresolvedLimit = Math.max(1, Number(options.unresolvedLimitPerStatus) || UNRESOLVED_CLAIMS_MAX);
  const queryFn = typeof options.queryClaims === 'function'
    ? options.queryClaims
    : (payload, queryOptions) => executeTeamMemoryOperation('query-claims', payload, queryOptions);
  const queryOptions = {};
  if (toOptionalString(options.teamMemoryDbPath, null)) {
    queryOptions.runtimeOptions = {
      storeOptions: {
        dbPath: options.teamMemoryDbPath,
      },
    };
  }

  const claims = [];
  for (const status of UNRESOLVED_STATUS_ORDER) {
    try {
      const result = await Promise.resolve(queryFn({
        status,
        limit: unresolvedLimit,
      }, queryOptions));
      const rows = Array.isArray(result?.claims) ? result.claims : [];
      claims.push(...rows);
    } catch {
      // Best-effort only: unresolved claim rendering should never block handoff output.
    }
  }
  return normalizeUnresolvedClaims(claims, options.unresolvedClaimsMax);
}

function sortByEventTsAsc(rows) {
  return [...rows].sort((left, right) => {
    const leftTs = toEventTsMs(left);
    const rightTs = toEventTsMs(right);
    if (leftTs !== rightTs) return leftTs - rightTs;
    const leftId = toOptionalString(left?.messageId, '');
    const rightId = toOptionalString(right?.messageId, '');
    return leftId.localeCompare(rightId);
  });
}

function buildDecisionDigestGroups(crossSessionTaggedRows = [], options = {}) {
  const sessionLimit = Math.max(1, Number(options.digestSessionLimit) || DIGEST_SESSION_LIMIT);
  const highlightLimit = Math.max(1, Number(options.digestHighlightLimit) || DIGEST_HIGHLIGHT_LIMIT);
  const groups = new Map();

  for (const entry of Array.isArray(crossSessionTaggedRows) ? crossSessionTaggedRows : []) {
    const tag = toOptionalString(entry?.tag?.tag, '').toUpperCase();
    if (!DIGEST_TAGS.has(tag)) continue;

    const row = entry?.row || {};
    const sessionId = toOptionalString(row?.sessionId, '-') || '-';
    const detail = toOptionalString(entry?.tag?.detail, '');
    if (!detail) continue;
    const tsMs = toEventTsMs(row);

    if (!groups.has(sessionId)) {
      groups.set(sessionId, {
        sessionId,
        latestTsMs: tsMs,
        decisions: 0,
        findings: 0,
        highlights: [],
      });
    }

    const group = groups.get(sessionId);
    group.latestTsMs = Math.max(group.latestTsMs, tsMs);
    if (tag === 'DECISION') group.decisions += 1;
    if (tag === 'FINDING') group.findings += 1;
    group.highlights.push({
      tsMs,
      tag,
      detail,
      messageId: toOptionalString(row?.messageId, '-') || '-',
    });
  }

  return Array.from(groups.values())
    .sort((left, right) => {
      if (left.latestTsMs !== right.latestTsMs) return right.latestTsMs - left.latestTsMs;
      return left.sessionId.localeCompare(right.sessionId);
    })
    .slice(0, sessionLimit)
    .map((group) => {
      const highlights = group.highlights
        .sort((left, right) => {
          if (left.tsMs !== right.tsMs) return right.tsMs - left.tsMs;
          if (left.messageId !== right.messageId) return left.messageId.localeCompare(right.messageId);
          if (left.tag !== right.tag) return left.tag.localeCompare(right.tag);
          return left.detail.localeCompare(right.detail);
        })
        .slice(0, highlightLimit)
        .map((item) => `${item.tag}: ${item.detail}`);
      return {
        sessionId: group.sessionId,
        latestTsMs: group.latestTsMs,
        decisions: group.decisions,
        findings: group.findings,
        highlights,
      };
    });
}

function toAppSessionNumber(value) {
  const normalized = normalizeAppSessionScopeId(value);
  if (!normalized) return null;
  const match = normalized.match(/^app-session-(\d+)$/);
  if (!match) return null;
  const sessionNumber = Number.parseInt(match[1], 10);
  return Number.isInteger(sessionNumber) && sessionNumber > 0 ? sessionNumber : null;
}

function isWithinCrossSessionAgeLimit(rowSessionId, currentSessionId, ageLimit = CROSS_SESSION_AGE_LIMIT) {
  const limit = Math.max(1, Number(ageLimit) || CROSS_SESSION_AGE_LIMIT);
  const currentSessionNumber = toAppSessionNumber(currentSessionId);
  if (!Number.isInteger(currentSessionNumber)) return true;

  const rowSessionNumber = toAppSessionNumber(rowSessionId);
  if (!Number.isInteger(rowSessionNumber)) return false;
  if (rowSessionNumber > currentSessionNumber) return false;
  return (currentSessionNumber - rowSessionNumber) <= limit;
}

function formatSessionNumberLabel(sessionId) {
  const sessionNumber = toAppSessionNumber(sessionId);
  if (Number.isInteger(sessionNumber)) return String(sessionNumber);
  return toOptionalString(sessionId, 'unknown') || 'unknown';
}

function formatPriorContextAge(currentSessionId, priorSessionId, latestTsMs = 0, nowMs = Date.now()) {
  const currentSessionNumber = toAppSessionNumber(currentSessionId);
  const priorSessionNumber = toAppSessionNumber(priorSessionId);
  if (Number.isInteger(currentSessionNumber) && Number.isInteger(priorSessionNumber)) {
    const diff = currentSessionNumber - priorSessionNumber;
    if (diff > 0) return `${diff} ${diff === 1 ? 'session' : 'sessions'}`;
  }

  const latest = Number(latestTsMs);
  const now = Number(nowMs);
  if (Number.isFinite(latest) && latest > 0 && Number.isFinite(now) && now >= latest) {
    const ageMinutes = Math.max(0, Math.round((now - latest) / 60000));
    if (ageMinutes < 60) return `${ageMinutes} ${ageMinutes === 1 ? 'minute' : 'minutes'}`;
    const ageHours = Math.round(ageMinutes / 60);
    if (ageHours < 48) return `${ageHours} ${ageHours === 1 ? 'hour' : 'hours'}`;
    const ageDays = Math.round(ageHours / 24);
    return `${ageDays} ${ageDays === 1 ? 'day' : 'days'}`;
  }

  return 'unknown';
}

function buildSessionHandoffMarkdown(rows, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const sessionId = toOptionalString(options.sessionId, '-') || '-';
  const unresolvedClaims = normalizeUnresolvedClaims(
    Array.isArray(options.unresolvedClaims) ? options.unresolvedClaims : [],
    options.unresolvedClaimsMax
  );
  const orderedRows = sortByEventTsAsc(Array.isArray(rows) ? rows : []);
  const totalRows = orderedRows.length;
  const recentLimit = Math.max(1, Number(options.recentLimit) || DEFAULT_RECENT_LIMIT);
  const taggedLimit = Math.max(1, Number(options.taggedLimit) || DEFAULT_TAGGED_LIMIT);
  const crossSessionLimit = Math.max(1, Number(options.crossSessionLimit) || DEFAULT_CROSS_SESSION_LIMIT);
  const crossSessionAgeLimit = Math.max(1, Number(options.crossSessionAgeLimit) || CROSS_SESSION_AGE_LIMIT);
  const failureLimit = Math.max(1, Number(options.failureLimit) || DEFAULT_FAILURE_LIMIT);
  const pendingLimit = Math.max(1, Number(options.pendingLimit) || DEFAULT_PENDING_LIMIT);
  const recentRows = orderedRows.slice(Math.max(0, orderedRows.length - recentLimit));

  const statusCounts = {};
  const channelCounts = {};
  const directionCounts = {};
  for (const row of orderedRows) {
    const status = toOptionalString(row?.status, 'unknown') || 'unknown';
    const channel = toOptionalString(row?.channel, 'unknown') || 'unknown';
    const direction = toOptionalString(row?.direction, 'unknown') || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;
    directionCounts[direction] = (directionCounts[direction] || 0) + 1;
  }

  const taggedRows = [];
  const crossSessionTaggedRows = [];
  const failedRows = [];
  const pendingRows = [];
  for (const row of orderedRows) {
    const status = normalizeDeliveryToken(row?.status) || 'unknown';
    const direction = toOptionalString(row?.direction, 'unknown') || 'unknown';
    const ackStatus = normalizeDeliveryToken(row?.ackStatus);
    const errorCode = toOptionalString(row?.errorCode, null);
    const tag = extractTag(row?.rawBody || '');
    const failed = status === 'failed' || hasFailureDeliverySignal(ackStatus, errorCode);
    if (tag) {
      taggedRows.push({ row, tag });
    }
    if (failed) {
      failedRows.push(row);
    }
    // Pending deliveries are unresolved outbound rows and must exclude failed outcomes.
    const pending =
      direction === 'outbound'
      && !failed
      && (
        PENDING_DELIVERY_STATUSES.has(status)
        || (status === 'brokered' && hasPendingDeliverySignal(ackStatus))
      );
    if (pending) {
      pendingRows.push(row);
    }
  }
  const crossSessionSourceRows = sortByEventTsAsc(
    Array.isArray(options.crossSessionTaggedRows) ? options.crossSessionTaggedRows : orderedRows
  );
  for (const row of crossSessionSourceRows) {
    const tag = extractTag(row?.rawBody || '');
    if (!tag || !CROSS_SESSION_TAGS.has(tag.tag)) continue;
    if (!isWithinCrossSessionAgeLimit(row?.sessionId, sessionId, crossSessionAgeLimit)) continue;
    crossSessionTaggedRows.push({ row, tag });
  }
  const decisionDigestGroups = buildDecisionDigestGroups(crossSessionTaggedRows, options);

  const latestTsMs = totalRows > 0 ? toEventTsMs(orderedRows[totalRows - 1]) : 0;
  const earliestTsMs = totalRows > 0 ? toEventTsMs(orderedRows[0]) : 0;

  const lines = [
    '# Session Handoff Index (auto-generated, deterministic)',
    '',
    `- generated_at: ${toIso(nowMs)}`,
    '- source: comms_journal',
    '- materializer: deterministic-v1',
    `- session_id: ${sessionId}`,
    `- rows_scanned: ${totalRows}`,
    `- window_start: ${toIso(earliestTsMs)}`,
    `- window_end: ${toIso(latestTsMs)}`,
    '',
    '## Coverage',
    `- statuses: ${formatCounts(statusCounts, Object.keys(statusCounts).sort()) || '-'}`,
    `- channels: ${formatCounts(channelCounts, Object.keys(channelCounts).sort()) || '-'}`,
    `- directions: ${formatCounts(directionCounts, Object.keys(directionCounts).sort()) || '-'}`,
    `- tagged_rows: ${taggedRows.length}`,
    `- decision_digest_sessions: ${decisionDigestGroups.length}`,
    `- failed_rows: ${failedRows.length}`,
    `- pending_rows: ${pendingRows.length}`,
  ];

  const priorContextRows = sortByEventTsAsc(
    Array.isArray(options.priorContextRows) ? options.priorContextRows : []
  );
  const priorContextSessionId = toOptionalString(options.priorContextSessionId, null);
  if (priorContextRows.length > 0) {
    const priorLatestTsMs = Number.isFinite(Number(options.priorContextLatestTsMs))
      ? Number(options.priorContextLatestTsMs)
      : toEventTsMs(priorContextRows[priorContextRows.length - 1]);
    lines.push(
      '',
      `## Prior Context (session ${formatSessionNumberLabel(priorContextSessionId)}, age ${formatPriorContextAge(sessionId, priorContextSessionId, priorLatestTsMs, nowMs)})`,
      `- source_session_id: ${priorContextSessionId || '-'}`,
      '- note: Current session had no meaningful handoff rows; these rows are prior context only.',
      '',
      '| sent_at | message_id | trace_id | sender | target | channel | direction | status | excerpt |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of priorContextRows.slice(Math.max(0, priorContextRows.length - recentLimit))) {
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.channel, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.direction, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.status, '-')),
        '|',
        escapeMarkdownCell(normalizeInline(row?.rawBody || '')),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    '## Unresolved Claims',
    '| claim_id | status | statement excerpt | confidence |',
    '| --- | --- | --- | --- |',
  );

  if (unresolvedClaims.length === 0) {
    lines.push('| - | - | - | - |');
  } else {
    for (const claim of unresolvedClaims) {
      lines.push([
        '|',
        escapeMarkdownCell(claim.id),
        '|',
        escapeMarkdownCell(claim.status),
        '|',
        escapeMarkdownCell(claim.statement),
        '|',
        escapeMarkdownCell(formatConfidence(claim.confidence)),
        '|',
      ].join(' '));
      }
  }

  lines.push(
    '',
    '## Decision Digest',
    '| session_id | latest_at | decisions | findings | highlights |',
    '| --- | --- | --- | --- | --- |',
  );

  if (decisionDigestGroups.length === 0) {
    lines.push('| - | - | - | - | - |');
  } else {
    for (const group of decisionDigestGroups) {
      lines.push([
        '|',
        escapeMarkdownCell(group.sessionId),
        '|',
        escapeMarkdownCell(toIso(group.latestTsMs)),
        '|',
        escapeMarkdownCell(group.decisions),
        '|',
        escapeMarkdownCell(group.findings),
        '|',
        escapeMarkdownCell(normalizeInline(group.highlights.join(' ; '), 260)),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    '## Cross-Session Decisions',
    '| sent_at | session_id | tag | message_id | trace_id | sender | target | detail |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  const crossSessionTaggedTail = crossSessionTaggedRows.slice(Math.max(0, crossSessionTaggedRows.length - crossSessionLimit));
  if (crossSessionTaggedTail.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    for (const entry of crossSessionTaggedTail) {
      const row = entry.row;
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(toOptionalString(row?.sessionId, '-')),
        '|',
        escapeMarkdownCell(entry.tag.tag),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(entry.tag.detail),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    '## Tagged Signals (explicit markers only)',
    '| sent_at | tag | message_id | trace_id | sender | target | status | detail |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  const taggedRowsTail = taggedRows.slice(Math.max(0, taggedRows.length - taggedLimit));
  if (taggedRowsTail.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    for (const entry of taggedRowsTail) {
      const row = entry.row;
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(entry.tag.tag),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.status, '-')),
        '|',
        escapeMarkdownCell(entry.tag.detail),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    '## Failed Deliveries',
    '| sent_at | message_id | trace_id | sender | target | status | ack_status | error_code | excerpt |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  const failedRowsTail = failedRows.slice(Math.max(0, failedRows.length - failureLimit));
  if (failedRowsTail.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - | - |');
  } else {
    for (const row of failedRowsTail) {
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.status, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.ackStatus, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.errorCode, '-')),
        '|',
        escapeMarkdownCell(normalizeInline(row?.rawBody || '')),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    '## Pending Deliveries',
    '| sent_at | message_id | trace_id | sender | target | status | attempt | excerpt |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  const pendingRowsTail = pendingRows.slice(Math.max(0, pendingRows.length - pendingLimit));
  if (pendingRowsTail.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    for (const row of pendingRowsTail) {
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.status, '-')),
        '|',
        escapeMarkdownCell(Number.isFinite(Number(row?.attempt)) ? Math.floor(Number(row.attempt)) : '-'),
        '|',
        escapeMarkdownCell(normalizeInline(row?.rawBody || '')),
        '|',
      ].join(' '));
    }
  }

  lines.push(
    '',
    `## Recent Messages (last ${recentRows.length})`,
    '| sent_at | message_id | trace_id | sender | target | channel | direction | status | excerpt |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  if (recentRows.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - | - |');
  } else {
    for (const row of recentRows) {
      lines.push([
        '|',
        escapeMarkdownCell(toIso(toEventTsMs(row))),
        '|',
        escapeMarkdownCell(toOptionalString(row?.messageId, '-')),
        '|',
        escapeMarkdownCell(extractTraceId(row)),
        '|',
        escapeMarkdownCell(toOptionalString(row?.senderRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.targetRole, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.channel, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.direction, '-')),
        '|',
        escapeMarkdownCell(toOptionalString(row?.status, '-')),
        '|',
        escapeMarkdownCell(normalizeInline(row?.rawBody || '')),
        '|',
      ].join(' '));
    }
  }

  // Prior session summaries for cross-session continuity
  const priorSummaries = Array.isArray(options.priorSessionSummaries) ? options.priorSessionSummaries : [];
  if (priorSummaries.length > 0) {
    lines.push(
      '',
      '## Prior Session Summaries',
      '',
    );
    for (const summary of priorSummaries) {
      const sessionLabel = summary.sessionNumber ? `Session ${summary.sessionNumber}` : 'Unknown session';
      const createdAt = summary.createdAtMs > 0 ? toIso(summary.createdAtMs) : '-';
      lines.push(`### ${sessionLabel} (captured: ${createdAt})`);
      lines.push('');
      // Include full summary content, indented as a block
      const content = String(summary.content || '').trim();
      if (content) {
        // Strip the top-level heading if present (it would be redundant)
        const contentLines = content.split('\n');
        const startIndex = contentLines.length > 0 && /^#\s+Session\s+\d+/.test(contentLines[0]) ? 1 : 0;
        for (let i = startIndex; i < contentLines.length; i += 1) {
          lines.push(contentLines[i]);
        }
      } else {
        lines.push('(no content)');
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

function resolvePrimarySessionHandoffPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join(HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE);
}

function resolveLastSessionHandoffPath(primaryPath) {
  return path.join(path.dirname(primaryPath), 'last-session.md');
}

async function ensureParentDir(targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
}

async function writeTextIfChanged(filePath, content, options = {}) {
  const next = String(content || '');
  try {
    let current = null;
    let hasExistingFile = false;
    try {
      current = await fs.promises.readFile(filePath, 'utf8');
      hasExistingFile = true;
      if (current === next) {
        return { changed: false };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }

    await ensureParentDir(filePath);
    let backupPath = null;
    const requestedBackupPath = toOptionalString(options.backupPath, null);
    if (hasExistingFile && requestedBackupPath && path.resolve(requestedBackupPath) !== path.resolve(filePath)) {
      await ensureParentDir(requestedBackupPath);
      await fs.promises.writeFile(requestedBackupPath, current, 'utf8');
      backupPath = requestedBackupPath;
    }
    await fs.promises.writeFile(filePath, next, 'utf8');
    return { changed: true, backupPath };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

async function materializeSessionHandoff(options = {}) {
  const sessionId = resolveEffectiveSessionScopeId(options.sessionId, options);
  const queryLimit = Math.max(1, Number(options.queryLimit) || DEFAULT_QUERY_LIMIT);
  const queryFn = typeof options.queryCommsJournal === 'function'
    ? options.queryCommsJournal
    : queryCommsJournalEntries;

  const queriedRows = Array.isArray(options.rows)
    ? options.rows
    : await Promise.resolve(queryFn({
      sessionId: sessionId || undefined,
      order: 'asc',
      limit: queryLimit,
    }, {
      dbPath: options.dbPath || null,
    }));
  const rows = Array.isArray(queriedRows) ? queriedRows : [];

  const queriedCrossSessionRows = Array.isArray(options.crossSessionRows)
    ? options.crossSessionRows
    : (
      Array.isArray(options.rows)
        ? options.rows
        : (
          sessionId
            ? await Promise.resolve(queryFn({
              order: 'asc',
              limit: queryLimit,
            }, {
              dbPath: options.dbPath || null,
            }))
            : rows
        )
    );
  const crossSessionRows = Array.isArray(queriedCrossSessionRows) ? queriedCrossSessionRows : [];
  const sourceSession = selectSourceSessionRows(sessionId, rows, crossSessionRows);
  const unresolvedClaims = Array.isArray(options.unresolvedClaims)
    ? normalizeUnresolvedClaims(options.unresolvedClaims, options.unresolvedClaimsMax)
    : await queryUnresolvedClaims({
      queryClaims: options.queryClaims,
      teamMemoryDbPath: options.teamMemoryDbPath,
      unresolvedLimitPerStatus: options.unresolvedLimitPerStatus,
      unresolvedClaimsMax: options.unresolvedClaimsMax,
    });

  // Gather prior session summaries for cross-session continuity
  const sessionHistoryLimit = Math.max(0, Number(options.sessionHistoryLimit) || DEFAULT_SESSION_HISTORY_LIMIT);
  let priorSessionSummaries = [];
  if (Array.isArray(options.priorSessionSummaries)) {
    priorSessionSummaries = options.priorSessionSummaries;
  } else if (sessionHistoryLimit > 0 && options.skipSessionHistory !== true && options.enableSessionHistory === true) {
    priorSessionSummaries = gatherPriorSessionSummaries(sessionHistoryLimit, {
      cognitiveMemoryApi: options.cognitiveMemoryApi,
      fallbackPath: options.sessionSummaryFallbackPath,
      querySessionSummariesFromMemory: options.querySessionSummariesFromMemory,
      readFallbackSummary: options.readFallbackSummary,
    });
  }
  if (sourceSession.usedFallback && sourceSession.fallbackSessionId) {
    const snapshotSummary = await querySessionSnapshotSummary(sourceSession.fallbackSessionId, options);
    if (snapshotSummary) {
      const dedupKey = `${snapshotSummary.sessionNumber || 'unknown'}:${snapshotSummary.content}`;
      const existingKeys = new Set(priorSessionSummaries
        .map((summary) => normalizePriorSessionSummary(summary))
        .filter(Boolean)
        .map((summary) => `${summary.sessionNumber || 'unknown'}:${summary.content}`));
      if (!existingKeys.has(dedupKey)) {
        priorSessionSummaries = [snapshotSummary, ...priorSessionSummaries];
      }
    }
  }

  const normalizedPriorSessionSummaries = priorSessionSummaries
    .map((summary) => normalizePriorSessionSummary(summary))
    .filter(Boolean);

  const primaryPath = toOptionalString(options.outputPath, null) || resolvePrimarySessionHandoffPath();
  const hasPriorContextRows = sourceSession.usedFallback === true
    && Array.isArray(sourceSession.fallbackMeaningfulRows)
    && sourceSession.fallbackMeaningfulRows.length > 0;
  const fallbackOnly = sourceSession.meaningfulRows.length === 0
    && !hasPriorContextRows
    && normalizedPriorSessionSummaries.length === 0
    && unresolvedClaims.length === 0;
  if (fallbackOnly) {
    return {
      ok: true,
      outputPath: primaryPath,
      mirrorPath: options.legacyMirrorPath === false ? null : toOptionalString(options.legacyMirrorPath, null),
      rowsScanned: 0,
      written: false,
      skipped: true,
      reason: 'no_meaningful_content',
      sourceSessionId: sourceSession.sessionId || sessionId || null,
      fallbackSourceSessionId: sourceSession.fallbackSessionId || null,
    };
  }

  const markdown = buildSessionHandoffMarkdown(sourceSession.rows, {
    sessionId: sourceSession.sessionId || sessionId || '-',
    nowMs: options.nowMs,
    recentLimit: options.recentLimit,
    taggedLimit: options.taggedLimit,
    crossSessionLimit: options.crossSessionLimit,
    crossSessionAgeLimit: options.crossSessionAgeLimit,
    digestSessionLimit: options.digestSessionLimit,
    digestHighlightLimit: options.digestHighlightLimit,
    failureLimit: options.failureLimit,
    pendingLimit: options.pendingLimit,
    crossSessionTaggedRows: crossSessionRows,
    priorContextRows: sourceSession.usedFallback ? sourceSession.fallbackMeaningfulRows : [],
    priorContextSessionId: sourceSession.usedFallback ? sourceSession.fallbackSessionId : null,
    priorContextLatestTsMs: sourceSession.usedFallback ? sourceSession.fallbackLatestTsMs : 0,
    unresolvedClaims,
    unresolvedClaimsMax: options.unresolvedClaimsMax,
    priorSessionSummaries: normalizedPriorSessionSummaries,
  });

  const legacyMirrorPath = options.legacyMirrorPath === false
    ? null
    : toOptionalString(options.legacyMirrorPath, null);
  const backupPath = options.lastSessionPath === false
    ? null
    : toOptionalString(options.lastSessionPath, null) || resolveLastSessionHandoffPath(primaryPath);

  const writes = [];
  const primaryWrite = await writeTextIfChanged(primaryPath, markdown, { backupPath });
  if (primaryWrite.error) {
    return {
      ok: false,
      reason: 'write_failed',
      error: primaryWrite.error,
      outputPath: primaryPath,
      rowsScanned: Array.isArray(rows) ? rows.length : 0,
    };
  }
  writes.push({ path: primaryPath, changed: primaryWrite.changed, backupPath: primaryWrite.backupPath || null });

  if (legacyMirrorPath && path.resolve(legacyMirrorPath) !== path.resolve(primaryPath)) {
    const mirrorWrite = await writeTextIfChanged(legacyMirrorPath, markdown);
    if (mirrorWrite.error) {
      return {
        ok: false,
        reason: 'write_failed',
        error: mirrorWrite.error,
        outputPath: legacyMirrorPath,
        rowsScanned: Array.isArray(rows) ? rows.length : 0,
      };
    }
    writes.push({ path: legacyMirrorPath, changed: mirrorWrite.changed });
  }

  return {
    ok: true,
    outputPath: primaryPath,
    mirrorPath: legacyMirrorPath,
    rowsScanned: Array.isArray(sourceSession.rows) ? sourceSession.rows.length : 0,
    written: writes.some((entry) => entry.changed),
    writes,
    sourceSessionId: sourceSession.sessionId || sessionId || null,
    fallbackSourceSessionId: sourceSession.fallbackSessionId || null,
    usedFallbackSession: sourceSession.usedFallback === true,
  };
}

function removeLegacyPaneHandoffFiles(options = {}) {
  const removed = [];
  const failed = [];
  const roots = new Set(Array.isArray(options.roots) ? options.roots : []);
  const fileNames = Array.isArray(options.fileNames) && options.fileNames.length > 0
    ? options.fileNames
    : LEGACY_PANE_HANDOFFS;

  if (roots.size === 0) {
    roots.add(path.join(WORKSPACE_PATH, HANDOFFS_RELATIVE_DIR));
    if (typeof resolveCoordPath === 'function') {
      const resolvedSessionPath = resolveCoordPath(path.join(HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE), { forWrite: true });
      roots.add(path.dirname(resolvedSessionPath));
    }
  }

  for (const root of roots) {
    for (const fileName of fileNames) {
      const targetPath = path.join(root, fileName);
      if (!fs.existsSync(targetPath)) continue;
      try {
        fs.unlinkSync(targetPath);
        removed.push(targetPath);
      } catch (err) {
        failed.push({ path: targetPath, error: err.message });
      }
    }
  }

  if (options.ignoreErrors === true) {
    return {
      ok: true,
      removed,
      failed,
    };
  }

  return {
    ok: failed.length === 0,
    removed,
    failed,
  };
}

module.exports = {
  materializeSessionHandoff,
  buildSessionHandoffMarkdown,
  removeLegacyPaneHandoffFiles,
  _internals: {
    extractTag,
    extractTraceId,
    stripKnownTagPrefixes,
    buildDecisionDigestGroups,
    normalizeInline,
    normalizeUnresolvedClaims,
    queryUnresolvedClaims,
    toEventTsMs,
    toIso,
    normalizeAppSessionScopeId,
    resolveCurrentSessionScopeIdFromAppStatus,
    resolveEffectiveSessionScopeId,
    resolvePrimarySessionHandoffPath,
    resolveLastSessionHandoffPath,
    isMeaningfulHandoffRow,
    filterMeaningfulRows,
    selectSourceSessionRows,
    LEGACY_PANE_HANDOFFS,
  },
};
