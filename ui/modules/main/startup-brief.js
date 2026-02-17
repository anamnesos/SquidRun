const TASK_TAG_PATTERN = /\b(TASK|DONE|BLOCKER)\s*:\s*(.+)$/i;

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeTaskKey(detail = '') {
  return asString(detail, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEventTsMs(row = {}, nowMs = Date.now()) {
  const candidates = [row.brokeredAtMs, row.sentAtMs, row.updatedAtMs, nowMs];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }
  return Math.floor(nowMs);
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

function extractTaskTagItems(rawBody = '') {
  const lines = String(rawBody || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    const match = line.match(TASK_TAG_PATTERN);
    if (!match) continue;
    const tag = String(match[1] || '').toUpperCase();
    const detail = asString(match[2], '');
    if (!detail) continue;
    items.push({ tag, detail });
  }
  return items;
}

function toTraceId(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return asString(
    metadata.traceId
    || metadata.trace_id
    || metadata.correlationId
    || metadata.correlation_id
    || '',
    '-'
  );
}

function collectOpenTasksFromJournal(rows = []) {
  const sorted = [...rows].sort((left, right) => toEventTsMs(left) - toEventTsMs(right));
  const openByKey = new Map();

  for (const row of sorted) {
    const tags = extractTaskTagItems(row?.rawBody || '');
    if (tags.length === 0) continue;
    for (const tag of tags) {
      const key = normalizeTaskKey(tag.detail);
      if (!key) continue;
      if (tag.tag === 'DONE') {
        if (openByKey.has(key)) {
          openByKey.delete(key);
        }
        continue;
      }
      if (tag.tag === 'TASK' || tag.tag === 'BLOCKER') {
        openByKey.set(key, {
          detail: tag.detail,
          tag: tag.tag,
          messageId: asString(row?.messageId, '-'),
          traceId: toTraceId(row),
          senderRole: asString(row?.senderRole, '-'),
          tsMs: toEventTsMs(row),
        });
      }
    }
  }

  return Array.from(openByKey.values())
    .sort((left, right) => right.tsMs - left.tsMs);
}

function collectFailedDeliveries(rows = []) {
  return rows
    .filter((row) => {
      const status = asString(row?.status, '').toLowerCase();
      const ackStatus = asString(row?.ackStatus, '').toLowerCase();
      const errorCode = asString(row?.errorCode, '');
      return status === 'failed' || ackStatus === 'failed' || Boolean(errorCode);
    })
    .sort((left, right) => toEventTsMs(right) - toEventTsMs(left));
}

function buildStartupBrief(data = {}) {
  const nowMs = Number.isFinite(Number(data.nowMs)) ? Math.floor(Number(data.nowMs)) : Date.now();
  const sessionId = asString(data.sessionId, '-');
  const journalRows = Array.isArray(data.journalRows) ? data.journalRows : [];
  const unresolvedClaims = data.unresolvedClaims && typeof data.unresolvedClaims === 'object'
    ? data.unresolvedClaims
    : {};

  const openTasks = collectOpenTasksFromJournal(journalRows);
  const failedDeliveries = collectFailedDeliveries(journalRows);
  const proposedClaims = Array.isArray(unresolvedClaims.proposed) ? unresolvedClaims.proposed : [];
  const contestedClaims = Array.isArray(unresolvedClaims.contested) ? unresolvedClaims.contested : [];
  const pendingProofClaims = Array.isArray(unresolvedClaims.pending_proof) ? unresolvedClaims.pending_proof : [];
  const unresolvedCount = proposedClaims.length + contestedClaims.length + pendingProofClaims.length;

  const lines = [
    '[STARTUP BRIEF]',
    `generated_at=${toIso(nowMs)} session_id=${sessionId}`,
    `open_tasks=${openTasks.length} unresolved_claims=${unresolvedCount} failed_deliveries=${failedDeliveries.length}`,
    '',
    'Open tasks (from TASK:/BLOCKER: tags):',
  ];

  if (openTasks.length === 0) {
    lines.push('- none');
  } else {
    for (const task of openTasks.slice(0, 6)) {
      lines.push(`- [${task.tag}] ${task.detail} (msg=${task.messageId}, trace=${task.traceId}, by=${task.senderRole})`);
    }
  }

  lines.push(
    '',
    `Unresolved claims: proposed=${proposedClaims.length}, contested=${contestedClaims.length}, pending_proof=${pendingProofClaims.length}`
  );

  const unresolvedSamples = [...contestedClaims, ...pendingProofClaims, ...proposedClaims]
    .slice(0, 5)
    .map((claim) => {
      const status = asString(claim?.status, '-');
      const statement = asString(claim?.statement, '-').replace(/\s+/g, ' ').trim();
      const short = statement.length > 140 ? `${statement.slice(0, 137)}...` : statement;
      return `- [${status}] ${short}`;
    });

  if (unresolvedSamples.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...unresolvedSamples);
  }

  lines.push('', 'Failed deliveries:');
  if (failedDeliveries.length === 0) {
    lines.push('- none');
  } else {
    for (const row of failedDeliveries.slice(0, 5)) {
      lines.push(
        `- ${toIso(toEventTsMs(row))} msg=${asString(row?.messageId, '-')} status=${asString(row?.status, '-')} ack=${asString(row?.ackStatus, '-')} error=${asString(row?.errorCode, '-')}`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildStartupBrief,
  collectOpenTasksFromJournal,
  collectFailedDeliveries,
  extractTaskTagItems,
  normalizeTaskKey,
};
