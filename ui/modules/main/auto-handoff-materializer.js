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
const LEGACY_PANE_HANDOFFS = ['1.md', '2.md', '5.md'];
const DEFAULT_QUERY_LIMIT = 5000;
const DEFAULT_RECENT_LIMIT = 250;
const DEFAULT_TAGGED_LIMIT = 120;
const DEFAULT_FAILURE_LIMIT = 80;
const DEFAULT_PENDING_LIMIT = 80;
const PREVIEW_LIMIT = 180;
const CLAIM_STATEMENT_LIMIT = 100;
const PENDING_DELIVERY_STATUSES = new Set(['recorded', 'routed']);
const UNRESOLVED_CLAIMS_MAX = 10;
const UNRESOLVED_STATUS_ORDER = ['contested', 'pending_proof', 'proposed'];
const UNRESOLVED_STATUS_SET = new Set(UNRESOLVED_STATUS_ORDER);
const TAG_PATTERN = /\b(DECISION|TASK|ACTION|FINDING|BLOCKER|QUESTION|NEXT|DONE|TEST|PLAN|RISK|CLAIM)\s*:\s*(.+)/i;

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
    const match = line.match(TAG_PATTERN);
    if (!match) continue;
    return {
      tag: String(match[1] || '').toUpperCase(),
      detail: normalizeInline(match[2] || ''),
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

function normalizeUnresolvedClaims(claims = [], maxClaims = UNRESOLVED_CLAIMS_MAX) {
  const limit = Math.max(1, Number(maxClaims) || UNRESOLVED_CLAIMS_MAX);
  const dedup = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const claimId = toOptionalString(claim?.id, null);
    if (!claimId) continue;
    const status = toOptionalString(claim?.status, '').toLowerCase();
    if (!UNRESOLVED_STATUS_SET.has(status)) continue;
    const normalized = {
      id: claimId,
      status,
      statement: truncateClaimStatement(claim?.statement),
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

function queryUnresolvedClaims(options = {}) {
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
      const result = queryFn({
        status,
        limit: unresolvedLimit,
      }, queryOptions);
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

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeTextIfChanged(filePath, content) {
  const next = String(content || '');
  try {
    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, 'utf8');
      if (current === next) {
        return { changed: false };
      }
    }
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, next, 'utf8');
    return { changed: true };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

function materializeSessionHandoff(options = {}) {
  const sessionId = toOptionalString(options.sessionId, null);
  const queryLimit = Math.max(1, Number(options.queryLimit) || DEFAULT_QUERY_LIMIT);
  const queryFn = typeof options.queryCommsJournal === 'function'
    ? options.queryCommsJournal
    : queryCommsJournalEntries;

  const rows = Array.isArray(options.rows)
    ? options.rows
    : queryFn({
      sessionId: sessionId || undefined,
      order: 'asc',
      limit: queryLimit,
    }, {
      dbPath: options.dbPath || null,
    });
  const unresolvedClaims = Array.isArray(options.unresolvedClaims)
    ? normalizeUnresolvedClaims(options.unresolvedClaims, options.unresolvedClaimsMax)
    : queryUnresolvedClaims({
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
    failureLimit: options.failureLimit,
    pendingLimit: options.pendingLimit,
    unresolvedClaims,
    unresolvedClaimsMax: options.unresolvedClaimsMax,
  });

  const primaryPath = toOptionalString(options.outputPath, null) || resolvePrimarySessionHandoffPath();
  const legacyMirrorPath = options.legacyMirrorPath === false
    ? null
    : (toOptionalString(options.legacyMirrorPath, null) || resolveLegacyWorkspaceSessionHandoffPath());

  const writes = [];
  const primaryWrite = writeTextIfChanged(primaryPath, markdown);
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
    const mirrorWrite = writeTextIfChanged(legacyMirrorPath, markdown);
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
