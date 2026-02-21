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

const HANDOFFS_RELATIVE_DIR = 'handoffs';
const SESSION_HANDOFF_FILE = 'session.md';
const LEGACY_PANE_HANDOFFS = ['1.md', '2.md', '3.md'];
const DEFAULT_QUERY_LIMIT = 5000;
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

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
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
    '',
    '## Unresolved Claims',
    '| claim_id | status | statement excerpt | confidence |',
    '| --- | --- | --- | --- |',
  ];

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

  return `${lines.join('\n')}\n`;
}

function resolvePrimarySessionHandoffPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join(HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE);
}

function resolveLegacyWorkspaceSessionHandoffPath() {
  return path.join(WORKSPACE_PATH, HANDOFFS_RELATIVE_DIR, SESSION_HANDOFF_FILE);
}

async function ensureParentDir(targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
}

async function writeTextIfChanged(filePath, content) {
  const next = String(content || '');
  try {
    try {
      const current = await fs.promises.readFile(filePath, 'utf8');
      if (current === next) {
        return { changed: false };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }

    await ensureParentDir(filePath);
    await fs.promises.writeFile(filePath, next, 'utf8');
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

async function materializeSessionHandoff(options = {}) {
  const sessionId = toOptionalString(options.sessionId, null);
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
  const unresolvedClaims = Array.isArray(options.unresolvedClaims)
    ? normalizeUnresolvedClaims(options.unresolvedClaims, options.unresolvedClaimsMax)
    : await queryUnresolvedClaims({
      queryClaims: options.queryClaims,
      teamMemoryDbPath: options.teamMemoryDbPath,
      unresolvedLimitPerStatus: options.unresolvedLimitPerStatus,
      unresolvedClaimsMax: options.unresolvedClaimsMax,
    });

  const markdown = buildSessionHandoffMarkdown(rows, {
    sessionId: sessionId || '-',
    nowMs: options.nowMs,
    recentLimit: options.recentLimit,
    taggedLimit: options.taggedLimit,
    crossSessionLimit: options.crossSessionLimit,
    digestSessionLimit: options.digestSessionLimit,
    digestHighlightLimit: options.digestHighlightLimit,
    failureLimit: options.failureLimit,
    pendingLimit: options.pendingLimit,
    crossSessionTaggedRows: crossSessionRows,
    unresolvedClaims,
    unresolvedClaimsMax: options.unresolvedClaimsMax,
  });

  const primaryPath = toOptionalString(options.outputPath, null) || resolvePrimarySessionHandoffPath();
  const legacyMirrorPath = options.legacyMirrorPath === false
    ? null
    : (toOptionalString(options.legacyMirrorPath, null) || resolveLegacyWorkspaceSessionHandoffPath());

  const writes = [];
  const primaryWrite = await writeTextIfChanged(primaryPath, markdown);
  if (primaryWrite.error) {
    return {
      ok: false,
      reason: 'write_failed',
      error: primaryWrite.error,
      outputPath: primaryPath,
      rowsScanned: Array.isArray(rows) ? rows.length : 0,
    };
  }
  writes.push({ path: primaryPath, changed: primaryWrite.changed });

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
    rowsScanned: Array.isArray(rows) ? rows.length : 0,
    written: writes.some((entry) => entry.changed),
    writes,
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
    resolvePrimarySessionHandoffPath,
    resolveLegacyWorkspaceSessionHandoffPath,
    LEGACY_PANE_HANDOFFS,
  },
};
