const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  probeTelegramReplyObligation,
  reconcileTelegramReplyObligationFromJournal,
  closeTelegramReplyObligationStores,
} = require('../modules/main/telegram-reply-obligations');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

function seedAckedTelegram(store, overrides = {}) {
  const messageId = overrides.messageId || `telegram-out-${Math.random().toString(36).slice(2, 8)}`;
  const timestampMs = Number(overrides.timestampMs || 12_000);
  return store.upsertCommsJournal({
    messageId,
    sessionId: overrides.sessionId || 'app-session-1',
    senderRole: overrides.senderRole || 'architect',
    targetRole: overrides.targetRole || 'user',
    channel: overrides.channel || 'telegram',
    direction: overrides.direction || 'outbound',
    sentAtMs: timestampMs,
    brokeredAtMs: timestampMs,
    rawBody: overrides.rawBody || '(ARCHITECT #1): reply',
    status: overrides.status || 'acked',
    ackStatus: overrides.ackStatus || 'telegram_delivered',
    metadata: {
      chatId: overrides.chatId || '111111',
      routeKind: overrides.routeKind || 'telegram',
      replyToMessageId: overrides.replyToMessageId,
      inboundMessageId: overrides.inboundMessageId || overrides.replyToMessageId,
      ...(overrides.metadata || {}),
    },
  }, { nowMs: timestampMs });
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('telegram reply obligations', () => {
  let tempDir;
  let dbPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-reply-obligations-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
    store = new EvidenceLedgerStore({
      dbPath,
      sessionId: 'app-session-1',
    });
    expect(store.init().ok).toBe(true);
  });

  afterEach(() => {
    closeTelegramReplyObligationStores();
    if (store) {
      store.close();
      store = null;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('opens idempotently and does not downgrade a satisfied obligation', () => {
    const first = store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-1',
      chatId: '111111',
      sessionId: 'app-session-1',
      paneId: '1',
      openedAtMs: 10_000,
      deadlineAtMs: 20_000,
      metadata: { source: 'telegram-poller' },
    }, { nowMs: 10_000 });

    expect(first.ok).toBe(true);
    expect(first.status).toBe('inserted');

    const duplicate = store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-1',
      chatId: '111111',
      sessionId: 'app-session-1',
      paneId: '1',
      openedAtMs: 9_500,
      metadata: { windowKey: 'main' },
    }, { nowMs: 10_100 });

    expect(duplicate.ok).toBe(true);
    expect(duplicate.status).toBe('updated');
    expect(store.queryTelegramReplyObligations({ inboundMessageId: 'telegram-in-1' })).toHaveLength(1);
    expect(duplicate.obligation).toEqual(expect.objectContaining({
      inboundMessageId: 'telegram-in-1',
      status: 'open',
      openedAtMs: 9500,
      deadlineAtMs: 20000,
      metadata: expect.objectContaining({
        source: 'telegram-poller',
        windowKey: 'main',
      }),
    }));

    const satisfied = store.satisfyTelegramReplyObligation({
      inboundMessageId: 'telegram-in-1',
      satisfiedAtMs: 12_000,
      satisfiedByMessageId: 'telegram-out-1',
      satisfiedByRowId: 42,
      satisfactionSource: 'test',
      satisfaction: { reason: 'exact_reply_to_match' },
    }, { nowMs: 12_000 });
    expect(satisfied.ok).toBe(true);
    expect(satisfied.status).toBe('satisfied');

    const reopened = store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-1',
      status: 'open',
      openedAtMs: 13_000,
      metadata: { laterDuplicate: true },
    }, { nowMs: 13_000 });

    expect(reopened.ok).toBe(true);
    expect(reopened.obligation).toEqual(expect.objectContaining({
      status: 'satisfied',
      satisfiedByMessageId: 'telegram-out-1',
      metadata: expect.objectContaining({
        laterDuplicate: true,
      }),
    }));
  });

  test('probe explains rejected and matched Telegram egress candidates', () => {
    store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-exact',
      chatId: '111111',
      sessionId: 'app-session-1',
      paneId: '1',
      openedAtMs: 10_000,
      deadlineAtMs: 20_000,
    }, { nowMs: 10_000 });

    seedAckedTelegram(store, {
      messageId: 'telegram-out-before',
      timestampMs: 1_000,
      chatId: '111111',
      replyToMessageId: 'telegram-in-exact',
    });
    seedAckedTelegram(store, {
      messageId: 'telegram-out-cross-chat',
      timestampMs: 12_000,
      chatId: '222222',
      replyToMessageId: 'telegram-in-exact',
    });
    seedAckedTelegram(store, {
      messageId: 'telegram-out-not-proven',
      timestampMs: 13_000,
      chatId: '111111',
      replyToMessageId: 'telegram-in-exact',
      status: 'recorded',
      ackStatus: null,
    });
    seedAckedTelegram(store, {
      messageId: 'telegram-out-exact',
      timestampMs: 14_000,
      chatId: '111111',
      replyToMessageId: 'telegram-in-exact',
    });
    store.close();
    store = null;

    const probe = probeTelegramReplyObligation({
      inboundMessageId: 'telegram-in-exact',
    }, { dbPath });

    expect(probe.ok).toBe(true);
    expect(probe.status).toBe('matched');
    expect(probe.matchedCandidate).toEqual(expect.objectContaining({
      messageId: 'telegram-out-exact',
      reason: 'exact_reply_to_match',
    }));
    expect(probe.candidates.map((candidate) => [candidate.messageId, candidate.reason])).toEqual([
      ['telegram-out-before', 'before_reply_obligation_window'],
      ['telegram-out-cross-chat', 'chat_mismatch'],
      ['telegram-out-not-proven', 'not_proven_telegram_egress'],
      ['telegram-out-exact', 'exact_reply_to_match'],
    ]);
  });

  test('reconciles same-chat adjacent replyTo egress without accepting cross-chat replies', () => {
    store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-current',
      chatId: '111111',
      sessionId: 'app-session-1',
      paneId: '1',
      openedAtMs: 10_000,
      deadlineAtMs: 20_000,
    }, { nowMs: 10_000 });

    seedAckedTelegram(store, {
      messageId: 'telegram-out-wrong-chat-adjacent',
      timestampMs: 11_000,
      chatId: '222222',
      replyToMessageId: 'telegram-in-adjacent',
    });
    seedAckedTelegram(store, {
      messageId: 'telegram-out-same-chat-adjacent',
      timestampMs: 12_000,
      chatId: '111111',
      replyToMessageId: 'telegram-in-adjacent',
    });
    store.close();
    store = null;

    const reconciled = reconcileTelegramReplyObligationFromJournal({
      inboundMessageId: 'telegram-in-current',
    }, { dbPath });

    expect(reconciled.ok).toBe(true);
    expect(reconciled.status).toBe('satisfied');
    expect(reconciled.matchedCandidate).toEqual(expect.objectContaining({
      messageId: 'telegram-out-same-chat-adjacent',
      reason: 'same_chat_adjacent_reply_to_match',
    }));
    expect(reconciled.satisfaction.obligation).toEqual(expect.objectContaining({
      status: 'satisfied',
      satisfiedByMessageId: 'telegram-out-same-chat-adjacent',
      satisfaction: expect.objectContaining({
        reason: 'same_chat_adjacent_reply_to_match',
      }),
    }));
  });

  test('reconciles same-chat Telegram egress across app session changes', () => {
    store.upsertTelegramReplyObligation({
      inboundMessageId: 'telegram-in-before-restart',
      chatId: '111111',
      sessionId: 'app-session-before-restart',
      paneId: '1',
      openedAtMs: 10_000,
      deadlineAtMs: 20_000,
    }, { nowMs: 10_000 });

    seedAckedTelegram(store, {
      messageId: 'telegram-out-after-restart',
      sessionId: 'app-session-after-restart',
      timestampMs: 12_000,
      chatId: '111111',
      replyToMessageId: 'telegram-in-before-restart',
    });
    store.close();
    store = null;

    const reconciled = reconcileTelegramReplyObligationFromJournal({
      inboundMessageId: 'telegram-in-before-restart',
    }, { dbPath });

    expect(reconciled.ok).toBe(true);
    expect(reconciled.status).toBe('satisfied');
    expect(reconciled.matchedCandidate).toEqual(expect.objectContaining({
      messageId: 'telegram-out-after-restart',
      sessionId: 'app-session-after-restart',
      reason: 'exact_reply_to_match',
    }));
    expect(reconciled.satisfaction.obligation).toEqual(expect.objectContaining({
      status: 'satisfied',
      satisfiedByMessageId: 'telegram-out-after-restart',
    }));
  });
});
