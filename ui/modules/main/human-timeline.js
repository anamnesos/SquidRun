'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const {
  queryCommsJournalEntries,
  resolveDefaultEvidenceLedgerDbPath,
} = require('./comms-journal');
const {
  queryTelegramReplyObligations,
} = require('./telegram-reply-obligations');
const {
  readTaskAuditItems,
} = require('./live-task-audit-sidecar');
const {
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');

const SNAPSHOT_SCHEMA = 'squidrun.human_timeline.snapshot.v0';
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_FEED_ITEMS = 44;
const DEFAULT_MAX_NEEDS_YOU_ITEMS = 5;
const FOREIGN_SESSION_IDS = new Set(['app-session-446']);
const NEEDS_YOU_TASK_AUDIT_STATUSES = new Set([
  'needs_james_verification',
  'pending_james_go',
  'needs_james_input_over_time',
  'deferred_judgment_call_with_james',
]);
const TERMINAL_MARKER_RE = /\b(pass(?:ed)?|approved|closed|verdict|committed\s+[a-f0-9]{7,40})\b/i;
const CLAIM_RELEASE_RE = /^\s*\([^)]+\):\s*(?:claiming|index released|read #\d+|ack(?:nowledged)?\b|receipt\b)/i;
const SHA_RE = /\b[a-f0-9]{7,40}\b/gi;

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toMs(value, fallback) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallback;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asIso(value, fallbackMs = Date.now()) {
  const ms = toMs(value, fallbackMs);
  return new Date(ms).toISOString();
}

function startOfLocalDayMs(nowMs) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function rowTimeMs(row = {}) {
  return toMs(row.brokeredAtMs, toMs(row.sentAtMs, toMs(row.updatedAtMs, 0)));
}

function rowMetadata(row = {}) {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function cleanBody(value) {
  return String(value || '')
    .replace(/^\s*\([A-Z][A-Z0-9_-]*\s+#\d+\):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHeadlineJargon(value) {
  return cleanBody(value)
    .replace(SHA_RE, '')
    .replace(/\bpane\b/gi, "agent's window")
    .replace(/\bwarm resume\b/gi, 'came back with memory intact')
    .replace(/\back(?:ed|nowledged)?\b/gi, 'delivered')
    .replace(/\btrigger fallback\b/gi, 'retry path')
    .replace(/\btrigger\b/gi, 'retry path')
    .replace(/\bHEAD\b/g, 'saved change')
    .replace(/\bcommit(?:ted)?\b/gi, 'saved')
    .replace(/\btask[-\s]?audit\b/gi, 'task review')
    .replace(/\bsidecar\b/gi, 'side window')
    .replace(/\bregistry\b/gi, 'roster')
    .replace(/\bgo[-\s]?live\b/gi, 'launch')
    .replace(/\bwire real\b/gi, 'set up real')
    .replace(/\bscreenshot\b/gi, 'screen check')
    .replace(/\bG\d+\b:?/gi, '')
    .replace(/\bkeep-with-reason\b/gi, 'kept with a reason')
    .replace(/\bcensus verdict\b/gi, 'review decision')
    .replace(/\bcensus\b/gi, 'review')
    .replace(/\bverdict\b/gi, 'review decision')
    .replace(/\barms\b/gi, 'helper agents')
    .replace(/\barm\b/gi, 'helper agent')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(value, fallback = '') {
  const text = stripHeadlineJargon(value);
  if (!text) return fallback;
  const first = text.split(/(?<=[.!?])\s+/)[0] || text;
  if (first.length <= 100) return first;
  const clipped = first.slice(0, 97).replace(/\s+\S*$/, '').trim() || first.slice(0, 97).trim();
  return `${clipped}...`;
}

function detailText(value, fallback = '') {
  const text = stripHeadlineJargon(value);
  if (!text) return fallback;
  return text.length > 360 ? `${text.slice(0, 357).trim()}...` : text;
}

function parseSessionNumber(sessionId) {
  const match = String(sessionId || '').match(/\bapp-session-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function readAppStatus(options = {}) {
  try {
    return JSON.parse(fs.readFileSync(appStatusPath(options), 'utf8'));
  } catch (_) {
    return null;
  }
}

function currentSessionId(options = {}) {
  const explicit = toOptionalString(options.sessionId, null);
  if (explicit) return explicit;
  const parsed = readAppStatus(options);
  const sessionNumber = Number(parsed?.session);
  return Number.isInteger(sessionNumber) && sessionNumber > 0
    ? `app-session-${sessionNumber}`
    : null;
}

function displayTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function actorName(value) {
  const role = lower(value);
  if (role === 'architect') return 'mira';
  if (role === 'builder') return 'builder';
  if (role === 'oracle') return 'oracle';
  if (role === 'user' || role === 'telegram' || role === 'james') return 'james';
  if (role === 'codex' || role === 'codex-desktop') return 'codex-desktop';
  return role || 'system';
}

function rowActors(row = {}) {
  return [...new Set([actorName(row.senderRole), actorName(row.targetRole)].filter(Boolean))];
}

function refsForRow(row = {}) {
  return {
    commsRowId: row.rowId || null,
    messageId: row.messageId || null,
    sessionId: row.sessionId || null,
  };
}

function entryBase({ id, at, kind, headline, detail, actors, refs, needsYou = false, sessionId, tone = 'neutral' }) {
  const ms = toMs(at, Date.now());
  return {
    id,
    at: ms,
    timestamp: asIso(ms),
    timeLabel: displayTime(ms),
    kind,
    headline,
    title: headline,
    detail: detail || '',
    actors: Array.isArray(actors) ? actors.filter(Boolean) : [],
    refs: refs || {},
    evidence: refs || {},
    needsYou,
    tone,
    sessionNumber: parseSessionNumber(sessionId),
  };
}

function metadataProfile(row = {}) {
  const metadata = rowMetadata(row);
  return toOptionalString(
    metadata.profileName
    || metadata.profile
    || metadata.windowProfile
    || metadata.route?.profile
    || metadata.routing?.profile
    || null,
    null
  );
}

function isForeignWorldRow(row = {}, options = {}) {
  const sessionId = toOptionalString(row.sessionId, null);
  const foreignSessionIds = options.foreignSessionIds instanceof Set
    ? options.foreignSessionIds
    : FOREIGN_SESSION_IDS;
  if (sessionId && foreignSessionIds.has(sessionId)) return true;
  const profile = metadataProfile(row);
  if (profile && !['main', 'default'].includes(lower(profile))) return true;
  return false;
}

function isUserFacingRow(row = {}) {
  const channel = lower(row.channel);
  const direction = lower(row.direction);
  const target = lower(row.targetRole);
  const sender = lower(row.senderRole);
  if (['telegram', 'sms', 'voice', 'user'].includes(channel)) return true;
  if (target === 'user' || sender === 'user') return true;
  if (direction === 'inbound' && sender === 'user') return true;
  return false;
}

function isWsRow(row = {}) {
  return lower(row.channel) === 'ws' || lower(row.direction) === 'outbound';
}

function userEntryFromRow(row = {}) {
  const timestampMs = rowTimeMs(row);
  const fromJames = lower(row.senderRole) === 'user' || lower(row.direction) === 'inbound';
  const headline = firstSentence(row.rawBody, fromJames ? 'You sent a message.' : 'You got an update.');
  return entryBase({
    id: `comms-${row.rowId || row.messageId || timestampMs}`,
    at: timestampMs,
    kind: 'you',
    headline,
    detail: detailText(row.rawBody, headline),
    actors: rowActors(row),
    refs: { kind: 'comms_journal', ...refsForRow(row) },
    sessionId: row.sessionId,
    tone: fromJames ? 'ask' : 'neutral',
  });
}

function milestoneHeadline(row = {}) {
  const text = lower(row.rawBody);
  if (/timeline data spec|spec committed/.test(text)) return 'Oracle saved the Today feed data rules.';
  if (/census|sidecar/.test(text)) return 'Oracle saved the side window review decision.';
  if (/fresh[-\s]?eyes|room/.test(text)) return 'Mira turned the team review into next steps.';
  if (/restart|came back|resume/.test(text)) return 'The app restarted and the team came back with memory intact.';
  if (/eunbyeol|split[-\s]?brain|foreign/.test(text)) return 'The team isolated work from another install.';
  if (/\bapproved\b/.test(text)) return 'Mira approved the next step.';
  if (/\bpass(?:ed)?\b/.test(text)) return 'The team finished a check successfully.';
  if (/\bclosed\b/.test(text)) return 'The team closed a work thread.';
  if (/\bcommitted\s+[a-f0-9]{7,40}\b/.test(text)) return `${actorDisplay(row.senderRole)} saved a change.`;
  return `${actorDisplay(row.senderRole)} finished an update.`;
}

function actorDisplay(value) {
  const actor = actorName(value);
  if (actor === 'mira') return 'Mira';
  if (actor === 'builder') return 'Builder';
  if (actor === 'oracle') return 'Oracle';
  if (actor === 'james') return 'You';
  if (actor === 'codex-desktop') return 'Codex Desktop';
  return 'The team';
}

function milestoneEntryFromRows(rows = []) {
  if (rows.length < 3) return null;
  const terminal = rows[rows.length - 1];
  if (!TERMINAL_MARKER_RE.test(String(terminal.rawBody || ''))) return null;
  const timestampMs = rowTimeMs(terminal);
  return entryBase({
    id: `arc-${terminal.rowId || terminal.messageId || timestampMs}`,
    at: timestampMs,
    kind: 'team',
    headline: milestoneHeadline(terminal),
    detail: detailText(terminal.rawBody, 'The team reached an outcome.'),
    actors: [...new Set(rows.flatMap(rowActors))],
    refs: {
      kind: 'comms_journal_arc',
      terminalRowId: terminal.rowId || null,
      messageIds: rows.map((row) => row.messageId).filter(Boolean),
      rowIds: rows.map((row) => row.rowId).filter(Boolean),
      sessionId: terminal.sessionId || null,
    },
    sessionId: terminal.sessionId,
    tone: 'good',
  });
}

function collapsedMilestoneEntries(rows = []) {
  const entries = [];
  let burst = [];
  let lastPair = null;
  const flush = () => {
    const entry = milestoneEntryFromRows(burst);
    if (entry) entries.push(entry);
    burst = [];
    lastPair = null;
  };

  for (const row of rows) {
    if (!isWsRow(row) || isUserFacingRow(row) || CLAIM_RELEASE_RE.test(String(row.rawBody || ''))) {
      flush();
      continue;
    }
    const pair = `${lower(row.senderRole)}>${lower(row.targetRole)}`;
    if (lastPair && pair !== lastPair) flush();
    burst.push(row);
    lastPair = pair;
  }
  flush();
  return entries;
}

function hasInboundReplyWithin(row = {}, rows = [], windowMs = 4 * 60 * 60 * 1000) {
  const at = rowTimeMs(row);
  if (!at) return false;
  const threadKey = rowThreadKey(row);
  return rows.some((candidate) => {
    const candidateAt = rowTimeMs(candidate);
    if (candidateAt <= at || candidateAt > at + windowMs) return false;
    return rowThreadKey(candidate) === threadKey && isUserInbound(candidate);
  });
}

function rowThreadKey(row = {}) {
  const metadata = rowMetadata(row);
  const channel = lower(row.channel);
  const target = lower(row.targetRole);
  const sender = lower(row.senderRole);
  const threadId = toOptionalString(
    metadata.threadId
    || metadata.thread_id
    || metadata.conversationId
    || metadata.conversation_id
    || metadata.chatId
    || metadata.telegramChatId
    || metadata.routedChatId
    || metadata.replyContextChatId
    || metadata.envelope?.metadata?.chatId
    || metadata.envelope?.metadata?.telegramChatId
    || null,
    null
  );
  if (threadId) return `${channel || 'unknown'}:${threadId}`;
  if (channel) return `${channel}:${target || sender || 'user'}`;
  return `${sender}>${target}`;
}

function isUserInbound(row = {}) {
  const sender = lower(row.senderRole);
  const direction = lower(row.direction);
  const channel = lower(row.channel);
  return (sender === 'user' || direction === 'inbound') && ['telegram', 'sms', 'voice', 'user'].includes(channel);
}

function isOutboundToUser(row = {}) {
  const channel = lower(row.channel);
  const target = lower(row.targetRole);
  return lower(row.direction) === 'outbound'
    && (target === 'user' || ['telegram', 'sms', 'voice', 'user'].includes(channel));
}

function hasLaterOutboundInThread(row = {}, rows = []) {
  const at = rowTimeMs(row);
  if (!at) return false;
  const threadKey = rowThreadKey(row);
  return rows.some((candidate) => (
    rowTimeMs(candidate) > at
    && rowThreadKey(candidate) === threadKey
    && isOutboundToUser(candidate)
  ));
}

function isCurrentSessionRow(row = {}, sessionId = null) {
  if (!sessionId) return true;
  return toOptionalString(row.sessionId, null) === sessionId;
}

function isCurrentSessionTaskAuditItem(item = {}, sessionId = null) {
  if (!sessionId) return true;
  const itemSessionId = toOptionalString(item.sessionId, null);
  return !itemSessionId || itemSessionId === sessionId;
}

function rowNeedsUser(row = {}, rows = [], options = {}) {
  if (!isCurrentSessionRow(row, options.currentSessionId || null)) return false;
  if (hasLaterOutboundInThread(row, rows)) return false;
  const text = lower(row.rawBody);
  if (/\bwhat needs you\b/.test(text)) return false;
  const target = lower(row.targetRole);
  const outboundToJames = isOutboundToUser(row);
  const directedQuestion = /\?/.test(String(row.rawBody || ''))
    && outboundToJames
    && (/\bjames\b/.test(text) || /\byou\b|\byour\b/.test(text) || target === 'user');
  if (directedQuestion && !hasInboundReplyWithin(row, rows)) return true;
  return outboundToJames
    && /\b(ask james|james action|needs james|need james|needs you|need your|your call|approve|approval|confirm|permission)\b/.test(text)
    && !hasInboundReplyWithin(row, rows);
}

function needFromRow(row = {}, rows = [], options = {}) {
  if (!rowNeedsUser(row, rows, options)) return null;
  const timestampMs = rowTimeMs(row);
  return entryBase({
    id: `need-comms-${row.rowId || row.messageId || timestampMs}`,
    at: timestampMs,
    kind: 'needs-you',
    headline: 'Your input is needed.',
    detail: detailText(row.rawBody, 'The team needs a decision or answer from you.'),
    actors: rowActors(row),
    refs: { kind: 'comms_journal', ...refsForRow(row) },
    needsYou: true,
    sessionId: row.sessionId,
    tone: 'ask',
  });
}

function needFromObligation(obligation = {}) {
  const timestampMs = toMs(obligation.openedAtMs, toMs(obligation.createdAtMs, Date.now()));
  return entryBase({
    id: `need-telegram-${obligation.obligationId || obligation.inboundMessageId || timestampMs}`,
    at: timestampMs,
    kind: 'needs-you',
    headline: 'A Telegram reply is waiting.',
    detail: 'A recent Telegram message still needs a clear answer from the team.',
    actors: ['james'],
    refs: {
      kind: 'telegram_reply_obligation',
      obligationId: obligation.obligationId || null,
      inboundMessageId: obligation.inboundMessageId || null,
      sessionId: obligation.sessionId || null,
    },
    needsYou: true,
    sessionId: obligation.sessionId,
    tone: 'ask',
  });
}

function needFromTaskAuditItem(item = {}) {
  const timestampMs = toMs(item.updatedAt || item.createdAt || item.timestamp, Date.now());
  const detail = [item.nextAction, item.rationale].map((part) => detailText(part, '')).filter(Boolean).join(' ');
  return entryBase({
    id: `need-task-audit-${item.id || timestampMs}`,
    at: timestampMs,
    kind: 'needs-you',
    headline: firstSentence(item.title, 'A saved task needs your input.'),
    detail: detail || 'A saved task needs your input before it can move.',
    actors: ['james', ...((Array.isArray(item.ownerRoles) ? item.ownerRoles : []).map(actorName))],
    refs: {
      kind: 'task_audit_item',
      itemId: item.id || null,
      sourceRef: item.sourceRef || item.source?.ref || null,
      sessionId: item.sessionId || null,
    },
    needsYou: true,
    sessionId: item.sessionId,
    tone: 'ask',
  });
}

function dedupeById(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function sortNewestFirst(items = []) {
  return [...items].sort((left, right) => toMs(right.at ?? right.timestamp, 0) - toMs(left.at ?? left.timestamp, 0));
}

function appStatusPath(options = {}) {
  const explicit = toOptionalString(options.appStatusPath, null);
  if (explicit) return path.resolve(explicit);
  if (typeof resolveCoordPath === 'function') return resolveCoordPath('app-status.json');
  return path.join(getProjectRoot(), '.squidrun', 'app-status.json');
}

function restartEntry(options = {}) {
  const filePath = appStatusPath(options);
  const parsed = readAppStatus(options);
  if (!parsed) return null;
  const startedMs = toMs(parsed.started, 0);
  if (!startedMs) return null;
  const sessionId = `app-session-${parsed.session || ''}`;
  return entryBase({
    id: `restart-${sessionId}-${startedMs}`,
    at: startedMs,
    kind: 'event',
    headline: 'The app restarted and the team came back with memory intact.',
    detail: `Session ${parsed.session || 'today'} started cleanly.`,
    actors: ['system'],
    refs: { kind: 'app_status', path: filePath.replace(/\\/g, '/'), sessionId },
    sessionId,
    tone: 'good',
  });
}

function queryGitCommits(sinceMs, untilMs, options = {}) {
  if (typeof options.queryGitCommits === 'function') return options.queryGitCommits({ sinceMs, untilMs });
  const cwd = toOptionalString(options.projectRoot, null) || getProjectRoot() || process.cwd();
  try {
    const stdout = childProcess.execFileSync('git', [
      'log',
      `--since=${new Date(sinceMs).toISOString()}`,
      `--until=${new Date(untilMs).toISOString()}`,
      '--format=%H%x09%ct%x09%s',
      '--max-count=24',
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, seconds, ...subjectParts] = line.split('\t');
      return {
        sha,
        atMs: Number(seconds) * 1000,
        subject: subjectParts.join('\t'),
      };
    });
  } catch (_) {
    return [];
  }
}

function changeEntryFromCommit(commit = {}) {
  const subject = firstSentence(commit.subject, 'The team saved a change.');
  const normalized = subject.replace(/[.]+$/, '');
  const lowerSubject = lower(normalized);
  let headline = normalized;
  if (lowerSubject.startsWith('add ')) headline = `The team added ${normalized.slice(4)}.`;
  else if (lowerSubject.startsWith('fix ')) headline = `The team fixed ${normalized.slice(4)}.`;
  else if (lowerSubject.startsWith('record ')) headline = `The team recorded ${normalized.slice(7)}.`;
  else if (lowerSubject.startsWith('refresh ')) headline = `The team refreshed ${normalized.slice(8)}.`;
  else if (lowerSubject.startsWith('restore ')) headline = `The team restored ${normalized.slice(8)}.`;
  else if (lowerSubject.startsWith('guard ')) headline = `The team guarded ${normalized.slice(6)}.`;
  else if (lowerSubject.startsWith('retire ')) headline = `The team retired ${normalized.slice(7)}.`;
  else if (lowerSubject.startsWith('save ')) headline = `The team saved ${normalized.slice(5)}.`;
  return entryBase({
    id: `git-${commit.sha}`,
    at: toMs(commit.atMs, Date.now()),
    kind: 'change',
    headline,
    detail: detailText(commit.subject, subject),
    actors: ['system'],
    refs: { kind: 'git', sha: commit.sha || null },
    tone: 'good',
  });
}

function itemProfile(item = {}) {
  return toOptionalString(item.profile || item.windowKey || item.project?.profile || null, null);
}

function isForeignTaskAuditItem(item = {}) {
  const profile = itemProfile(item);
  if (profile && !['main', 'default'].includes(lower(profile))) return true;
  if (FOREIGN_SESSION_IDS.has(toOptionalString(item.sessionId, null))) return true;
  return false;
}

function readTaskAuditNeeds(options = {}) {
  const currentSession = options.currentSessionId || null;
  const readItems = typeof options.readTaskAuditItems === 'function'
    ? options.readTaskAuditItems
    : readTaskAuditItems;
  try {
    const result = readItems(options);
    const items = Array.isArray(result?.items) ? result.items : [];
    const foreign = items.filter(isForeignTaskAuditItem).length;
    const needs = items
      .filter((item) => !isForeignTaskAuditItem(item))
      .filter((item) => isCurrentSessionTaskAuditItem(item, currentSession))
      .filter((item) => NEEDS_YOU_TASK_AUDIT_STATUSES.has(lower(item.status)))
      .map(needFromTaskAuditItem);
    return {
      items: needs,
      sourcePath: result?.taskAuditItemsPath || result?.sourcePath || null,
      status: result?.status || 'unknown',
      excludedForeignCount: foreign,
    };
  } catch (error) {
    return {
      items: [],
      sourcePath: null,
      status: 'unavailable',
      error: error?.message || String(error || 'task_audit_query_failed'),
      excludedForeignCount: 0,
    };
  }
}

function buildHumanTimelineSnapshot(options = {}) {
  const nowMs = toMs(options.nowMs ?? options.now, Date.now());
  const sinceMs = toMs(options.sinceMs, startOfLocalDayMs(nowMs));
  const untilMs = toMs(options.untilMs, nowMs);
  const maxRows = Math.max(1, Math.min(50_000, Number(options.maxRows) || DEFAULT_MAX_ROWS));
  const maxFeedItems = Math.max(1, Math.min(49, Number(options.maxFeedItems) || DEFAULT_MAX_FEED_ITEMS));
  const maxNeedsYouItems = Math.max(1, Math.min(5, Number(options.maxNeedsYouItems) || DEFAULT_MAX_NEEDS_YOU_ITEMS));
  const sessionId = currentSessionId(options);
  const queryRows = typeof options.queryCommsJournalEntries === 'function'
    ? options.queryCommsJournalEntries
    : queryCommsJournalEntries;
  const queryObligations = typeof options.queryTelegramReplyObligations === 'function'
    ? options.queryTelegramReplyObligations
    : queryTelegramReplyObligations;

  let rows = [];
  let rowError = null;
  try {
    rows = queryRows({
      sinceMs,
      untilMs,
      order: 'asc',
      limit: maxRows,
    }, options.queryOptions || {});
  } catch (error) {
    rowError = error?.message || String(error || 'query_failed');
    rows = [];
  }
  rows = Array.isArray(rows) ? rows.filter(Boolean) : [];

  const foreignRows = rows.filter((row) => isForeignWorldRow(row, options));
  const localRows = rows.filter((row) => !isForeignWorldRow(row, options));

  let obligations = [];
  let obligationError = null;
  try {
    obligations = queryObligations({
      status: 'open',
      sinceMs,
      untilMs,
      order: 'asc',
      limit: 50,
      ...(sessionId ? { sessionId } : {}),
    }, options.queryOptions || {});
  } catch (error) {
    obligationError = error?.message || String(error || 'telegram_obligation_query_failed');
    obligations = [];
  }
  obligations = Array.isArray(obligations) ? obligations.filter(Boolean) : [];

  const taskAuditNeeds = readTaskAuditNeeds({ ...options, currentSessionId: sessionId });
  const restart = restartEntry(options);
  const userEntries = localRows.filter(isUserFacingRow).map(userEntryFromRow);
  const arcEntries = collapsedMilestoneEntries(localRows);
  const changeEntries = queryGitCommits(sinceMs, untilMs, options).map(changeEntryFromCommit);

  const feedItems = sortNewestFirst(dedupeById([
    ...(restart ? [restart] : []),
    ...userEntries,
    ...arcEntries,
    ...changeEntries,
  ])).slice(0, maxFeedItems);

  const rowNeeds = localRows
    .map((row) => needFromRow(row, localRows, { currentSessionId: sessionId }))
    .filter(Boolean);
  const obligationNeeds = obligations.map(needFromObligation);
  const allNeedsYouItems = sortNewestFirst(dedupeById([
    ...obligationNeeds,
    ...taskAuditNeeds.items,
    ...rowNeeds,
  ]));
  const needsYouItems = allNeedsYouItems.slice(0, maxNeedsYouItems);
  const needsYouOverflowCount = Math.max(0, allNeedsYouItems.length - needsYouItems.length);

  let dbPath = null;
  try {
    dbPath = resolveDefaultEvidenceLedgerDbPath();
  } catch (_) {
    dbPath = null;
  }

  const errors = [rowError, obligationError, taskAuditNeeds.error].filter(Boolean);
  const excludedForeignCount = foreignRows.length + taskAuditNeeds.excludedForeignCount;

  return {
    ok: errors.length === 0,
    schema: SNAPSHOT_SCHEMA,
    version: 1,
    generatedAt: asIso(nowMs),
    session: {
      id: sessionId,
      number: parseSessionNumber(sessionId),
    },
    window: {
      label: 'Today',
      since: asIso(sinceMs),
      until: asIso(untilMs),
    },
    needsYou: {
      count: needsYouItems.length,
      overflowCount: needsYouOverflowCount,
      totalCount: allNeedsYouItems.length,
      items: needsYouItems,
    },
    feed: {
      count: feedItems.length,
      totalCount: feedItems.length,
      items: feedItems,
    },
    footer: {
      excludedForeignCount,
      excludedForeignLabel: excludedForeignCount > 0
        ? `${excludedForeignCount} entries from another install were excluded.`
        : '',
    },
    sources: {
      evidenceLedgerDbPath: dbPath,
      commsJournal: rowError ? 'unavailable' : 'read',
      telegramReplyObligations: obligationError ? 'unavailable' : 'read',
      taskAuditItems: taskAuditNeeds.status,
      taskAuditItemsPath: taskAuditNeeds.sourcePath,
      readOnly: true,
      errors,
    },
  };
}

module.exports = {
  SNAPSHOT_SCHEMA,
  buildHumanTimelineSnapshot,
  cleanBody,
  collapsedMilestoneEntries,
  eventFromRow: userEntryFromRow,
  needFromRow,
  startOfLocalDayMs,
};
