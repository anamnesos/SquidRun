const path = require('path');
const {
  EvidenceLedgerStore,
  resolveDefaultDbPath,
} = require('./evidence-ledger-store');

const DEFAULT_MATCH_GRACE_MS = Math.max(
  0,
  Number.parseInt(process.env.SQUIDRUN_TELEGRAM_REPLY_GUARD_JOURNAL_GRACE_MS || '5000', 10) || 5000
);
const DEFAULT_PROBE_LOOKBACK_MS = 10 * 60 * 1000;

const storeCache = new Map();

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toOptionalMs(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

function normalizeChatId(value) {
  const text = toNonEmptyString(value);
  if (!text) return null;
  if (!/^-?\d+$/.test(text)) return null;
  return text;
}

function resolveStore(dbPath = null) {
  const targetPath = dbPath || resolveDefaultDbPath();
  const cacheKey = path.resolve(String(targetPath));
  const cached = storeCache.get(cacheKey);
  if (cached?.store?.isAvailable()) {
    return { ok: true, store: cached.store, dbPath: cacheKey };
  }

  const store = new EvidenceLedgerStore({
    dbPath: cacheKey,
    enabled: true,
  });
  const init = store.init();
  if (!init?.ok) {
    try { store.close(); } catch {}
    return {
      ok: false,
      reason: init?.reason || 'init_failed',
      dbPath: cacheKey,
    };
  }

  storeCache.set(cacheKey, { store });
  return { ok: true, store, dbPath: cacheKey };
}

function openTelegramReplyObligation(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.upsertTelegramReplyObligation(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function satisfyTelegramReplyObligation(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.satisfyTelegramReplyObligation(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function expireTelegramReplyObligations(options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.expireTelegramReplyObligations(opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function queryTelegramReplyObligations(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryTelegramReplyObligations(filters || {});
}

function getCommsJournalRowTimestampMs(row = {}) {
  for (const value of [row.sentAtMs, row.brokeredAtMs, row.updatedAtMs]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return 0;
}

function getCommsJournalRowMetadata(row = {}) {
  return asObject(row.metadata);
}

function getCommsJournalRowChatId(row = {}) {
  const metadata = getCommsJournalRowMetadata(row);
  return normalizeChatId(
    metadata.chatId
    || metadata.telegramChatId
    || metadata.routedChatId
    || metadata.replyContextChatId
    || metadata.envelope?.metadata?.chatId
    || metadata.envelope?.metadata?.telegramChatId
    || null
  );
}

function getCommsJournalRowSessionId(row = {}) {
  const metadata = getCommsJournalRowMetadata(row);
  return toNonEmptyString(
    row.sessionId
    || metadata.sessionScopeId
    || metadata.session_scope_id
    || metadata.sessionId
    || metadata.session_id
    || metadata.replyContextSessionScopeId
    || metadata.envelope?.session_id
    || null
  );
}

function getCommsJournalRowReplyToMessageId(row = {}) {
  const metadata = getCommsJournalRowMetadata(row);
  return toNonEmptyString(
    metadata.replyToMessageId
    || metadata.reply_to_message_id
    || metadata.inboundMessageId
    || metadata.inbound_message_id
    || null
  );
}

function isProvenTelegramEgressJournalRow(row = {}) {
  const metadata = getCommsJournalRowMetadata(row);
  const targetSignals = [
    row.targetRole,
    metadata.targetRaw,
    metadata.directTarget,
    metadata.target?.raw,
    metadata.target?.role,
    metadata.envelope?.target?.raw,
    metadata.envelope?.target?.role,
  ].map((value) => toNonEmptyString(value)?.toLowerCase()).filter(Boolean);
  const hasTelegramTargetSignal = targetSignals.includes('telegram')
    || String(metadata.routeKind || '').toLowerCase() === 'telegram';
  const hasUserTelegramTargetSignal = targetSignals.includes('user');
  return String(row.channel || '').toLowerCase() === 'telegram'
    && String(row.direction || '').toLowerCase() === 'outbound'
    && String(row.status || '').toLowerCase() === 'acked'
    && String(row.ackStatus || '').toLowerCase() === 'telegram_delivered'
    && (hasTelegramTargetSignal || hasUserTelegramTargetSignal);
}

function buildCandidateBase(row = {}) {
  return {
    rowId: row.rowId || null,
    messageId: row.messageId || null,
    chatId: getCommsJournalRowChatId(row),
    sessionId: getCommsJournalRowSessionId(row),
    timestampMs: getCommsJournalRowTimestampMs(row),
    replyToMessageId: getCommsJournalRowReplyToMessageId(row),
    targetRole: row.targetRole || null,
    status: row.status || null,
    ackStatus: row.ackStatus || null,
  };
}

function rejectCandidate(row, reason, extra = {}) {
  return {
    ...buildCandidateBase(row),
    matched: false,
    reason,
    ...extra,
  };
}

function evaluateTelegramReplyCandidate(obligation = {}, row = {}, options = {}) {
  const base = buildCandidateBase(row);
  if (!isProvenTelegramEgressJournalRow(row)) {
    return rejectCandidate(row, 'not_proven_telegram_egress');
  }

  const obligationSessionId = toNonEmptyString(obligation.sessionId || obligation.session_id || obligation.sessionScopeId);
  const obligationChatId = normalizeChatId(obligation.chatId || obligation.chat_id || obligation.telegramChatId);
  if (obligationSessionId && !base.sessionId) {
    return rejectCandidate(row, 'missing_session_id', { expectedSessionId: obligationSessionId });
  }
  const sameChatProven = Boolean(obligationChatId && base.chatId && base.chatId === obligationChatId);
  if (obligationSessionId && base.sessionId !== obligationSessionId && !sameChatProven) {
    return rejectCandidate(row, 'session_mismatch', { expectedSessionId: obligationSessionId });
  }

  const openedAtMs = toOptionalMs(obligation.openedAtMs ?? obligation.opened_at_ms ?? obligation.createdAtMs, 0);
  const graceMs = Math.max(0, Number(options.graceMs ?? DEFAULT_MATCH_GRACE_MS) || 0);
  const earliestAcceptedMs = openedAtMs > 0 ? Math.max(0, openedAtMs - graceMs) : 0;
  if (openedAtMs > 0 && base.timestampMs > 0 && base.timestampMs < earliestAcceptedMs) {
    return rejectCandidate(row, 'before_reply_obligation_window', {
      openedAtMs,
      earliestAcceptedMs,
    });
  }

  if (obligationChatId && base.chatId && base.chatId !== obligationChatId) {
    return rejectCandidate(row, 'chat_mismatch', { expectedChatId: obligationChatId });
  }

  const inboundMessageId = toNonEmptyString(
    obligation.inboundMessageId || obligation.inbound_message_id || obligation.messageId || obligation.message_id
  );
  if (!base.replyToMessageId || base.replyToMessageId === inboundMessageId) {
    return {
      ...base,
      matched: true,
      reason: base.replyToMessageId ? 'exact_reply_to_match' : 'matched_without_reply_to',
      expectedChatId: obligationChatId || null,
      expectedSessionId: obligationSessionId || null,
    };
  }

  if (obligationChatId && base.chatId && base.chatId === obligationChatId) {
    return {
      ...base,
      matched: true,
      reason: 'same_chat_adjacent_reply_to_match',
      expectedChatId: obligationChatId,
      expectedSessionId: obligationSessionId || null,
    };
  }

  return rejectCandidate(row, 'reply_to_mismatch', {
    expectedReplyToMessageId: inboundMessageId || null,
    expectedChatId: obligationChatId || null,
  });
}

function queryTelegramEgressCandidates(store, obligation = {}, options = {}) {
  const openedAtMs = toOptionalMs(obligation.openedAtMs ?? obligation.opened_at_ms ?? obligation.createdAtMs, 0);
  const lookbackMs = Math.max(0, Number(options.probeLookbackMs ?? DEFAULT_PROBE_LOOKBACK_MS) || 0);
  const sinceMs = options.sinceMs !== undefined
    ? toOptionalMs(options.sinceMs, 0)
    : Math.max(0, openedAtMs - lookbackMs);
  const filters = {
    channel: 'telegram',
    direction: 'outbound',
    sinceMs,
    order: 'asc',
    limit: Math.max(1, Math.min(5000, Number(options.limit) || 500)),
  };
  const sessionId = toNonEmptyString(obligation.sessionId || obligation.session_id || obligation.sessionScopeId);
  const chatId = normalizeChatId(obligation.chatId || obligation.chat_id || obligation.telegramChatId);
  if (sessionId && !chatId) filters.sessionId = sessionId;
  return store.queryCommsJournal(filters);
}

function probeTelegramReplyObligation(input = {}, options = {}) {
  const opts = asObject(options);
  const inboundMessageId = toNonEmptyString(
    input.inboundMessageId || input.inbound_message_id || input.messageId || input.message_id || input.inbound
  );
  const obligationId = toNonEmptyString(input.obligationId || input.obligation_id);
  if (!inboundMessageId && !obligationId) {
    return { ok: false, status: 'invalid', reason: 'inbound_message_id_required' };
  }

  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }

  const obligation = storeResult.store.getTelegramReplyObligation({
    ...(inboundMessageId ? { inboundMessageId } : {}),
    ...(obligationId ? { obligationId } : {}),
  });
  if (!obligation) {
    return {
      ok: false,
      status: 'no_obligation',
      reason: 'telegram_reply_obligation_not_found',
      inboundMessageId: inboundMessageId || null,
      obligationId: obligationId || null,
      dbPath: storeResult.dbPath,
      candidates: [],
    };
  }

  const rows = queryTelegramEgressCandidates(storeResult.store, obligation, opts);
  const candidates = rows.map((row) => evaluateTelegramReplyCandidate(obligation, row, opts));
  const matchedCandidate = candidates.find((candidate) => candidate.matched) || null;
  return {
    ok: true,
    status: matchedCandidate ? 'matched' : 'unmatched',
    dbPath: storeResult.dbPath,
    obligation,
    candidates,
    matchedCandidate,
  };
}

function reconcileTelegramReplyObligationFromJournal(input = {}, options = {}) {
  const probe = probeTelegramReplyObligation(input, options);
  if (!probe.ok || !probe.matchedCandidate) return probe;
  if (probe.obligation?.status !== 'open') {
    return {
      ...probe,
      ok: true,
      status: `obligation_${probe.obligation?.status || 'not_open'}`,
      satisfaction: null,
    };
  }
  const satisfaction = satisfyTelegramReplyObligation({
    inboundMessageId: probe.obligation.inboundMessageId,
    satisfiedAtMs: probe.matchedCandidate.timestampMs || Date.now(),
    satisfiedByMessageId: probe.matchedCandidate.messageId || null,
    satisfiedByRowId: probe.matchedCandidate.rowId || null,
    satisfactionSource: 'comms_journal_probe',
    satisfaction: {
      reason: probe.matchedCandidate.reason,
      chatId: probe.matchedCandidate.chatId || null,
      sessionId: probe.matchedCandidate.sessionId || null,
      replyToMessageId: probe.matchedCandidate.replyToMessageId || null,
    },
  }, options);
  return {
    ...probe,
    status: satisfaction.ok ? 'satisfied' : 'matched_not_satisfied',
    satisfaction,
  };
}

function closeTelegramReplyObligationStores() {
  for (const { store } of storeCache.values()) {
    try {
      store.close();
    } catch {
      // best-effort cleanup
    }
  }
  storeCache.clear();
}

module.exports = {
  DEFAULT_MATCH_GRACE_MS,
  DEFAULT_PROBE_LOOKBACK_MS,
  openTelegramReplyObligation,
  satisfyTelegramReplyObligation,
  expireTelegramReplyObligations,
  queryTelegramReplyObligations,
  evaluateTelegramReplyCandidate,
  probeTelegramReplyObligation,
  reconcileTelegramReplyObligationFromJournal,
  closeTelegramReplyObligationStores,
  getCommsJournalRowChatId,
  getCommsJournalRowSessionId,
  getCommsJournalRowReplyToMessageId,
  isProvenTelegramEgressJournalRow,
  normalizeChatId,
};
