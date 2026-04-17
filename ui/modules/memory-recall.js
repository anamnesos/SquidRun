const fs = require('fs');
const path = require('path');

const { getProjectRoot, resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('./main/comms-journal');
const { TeamMemoryStore } = require('./team-memory/store');
const { executeTeamMemoryOperation } = require('./team-memory/runtime');
const { MemorySearchIndex } = require('./memory-search');
const { CognitiveMemoryApi } = require('./cognitive-memory-api');
const { formatDuration } = require('./formatters');

const DEFAULT_TOP_N = 6;
const DEFAULT_BACKEND_LIMIT = 4;
const DEFAULT_RECALL_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_RECALL_TIMEOUT_MS || '5000', 10) || 5000
);
const DEFAULT_RECALL_AUDIT_MAX_BYTES = Math.max(
  1024 * 1024,
  Number.parseInt(process.env.SQUIDRUN_RECALL_AUDIT_MAX_BYTES || `${10 * 1024 * 1024}`, 10) || (10 * 1024 * 1024)
);
const SUPERVISOR_STATUS_PATH = resolveCoordPath(path.join('runtime', 'supervisor-status.json'));
const APP_STATUS_PATH = path.join(getProjectRoot() || process.cwd(), '.squidrun', 'app-status.json');
const RECALL_AUDIT_PATH = resolveCoordPath(path.join('runtime', 'memory-recall-audit.jsonl'), { forWrite: true });
const RECALL_BLOCK_START = '[SQUIDRUN RECALL START]';
const RECALL_BLOCK_END = '[SQUIDRUN RECALL END]';
const RECALL_CORRECTION_PATTERN = /\b(i already told you|i told you this|already told you|already said|we already covered this|you forgot|you missed this|you keep forgetting)\b/i;
const EUNBYEOL_CHAT_ID = '8754356993';
const EUNBYEOL_BOOST_TERMS = Object.freeze([
  '은별',
  'private-profile',
  '8754356993',
  '전명삼',
  'jeon myeongsam',
  '힐스테이트',
  'hillstate',
  '큐라인',
  'qeline',
  '동인동디엠',
  'korean fraud',
  '관세청',
  'customs',
]);
const JAMES_DIRECT_BOOST_TERMS = Object.freeze([
  'james',
  'kim',
  '[private-live-ops]',
  'positions',
  'pnl',
  'stop loss',
  'giveback',
  'squidrun',
  'architecture',
  'memory recall',
  'agent conversations',
  'architect builder oracle',
  'feedback history',
  'runtime',
  'trading',
]);

let sharedMemorySearchIndex = null;
let sharedCognitiveMemoryApi = null;
let sharedTeamMemoryStore = null;
let recallAuditWriteTail = Promise.resolve();
const recallPaneLocks = new Map();

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readJsonFileSafe(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return null;
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function tokenize(value) {
  return normalizeWhitespace(value).toLowerCase().match(/[a-z0-9_\-./\\:가-힣]+/g) || [];
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

async function ensureDirAsync(targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
}

function generateId(prefix = 'recall') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const crypto = require('crypto');

function buildRecallIdentityKey(item = {}) {
  const fingerprint = [
    asString(item.store, ''),
    normalizeSourcePath(item.sourcePath || item.source_path || ''),
    asString(item.citation, ''),
    normalizeWhitespace(item.title || ''),
    normalizeWhitespace(item.excerpt || ''),
  ].join('|');
  return crypto.createHash('sha1').update(fingerprint, 'utf8').digest('hex');
}

function buildResultItemId(resultSetId, item = {}, index = 0) {
  const fingerprint = `${asString(resultSetId, '')}|${buildRecallIdentityKey(item)}|${Math.max(0, Number(index) || 0)}`;
  return `recall-item-${crypto.createHash('sha1').update(fingerprint, 'utf8').digest('hex').slice(0, 16)}`;
}

function buildProjectScopedPath(...segments) {
  return path.join(getProjectRoot() || process.cwd(), ...segments);
}

function getMemorySearchIndex(options = {}) {
  if (options.memorySearchIndex) return options.memorySearchIndex;
  if (!sharedMemorySearchIndex) {
    sharedMemorySearchIndex = new MemorySearchIndex();
  }
  return sharedMemorySearchIndex;
}

function getCognitiveMemoryApi(options = {}) {
  if (options.cognitiveMemoryApi) return options.cognitiveMemoryApi;
  if (!sharedCognitiveMemoryApi) {
    sharedCognitiveMemoryApi = new CognitiveMemoryApi({
      memorySearchIndex: getMemorySearchIndex(options),
    });
  }
  return sharedCognitiveMemoryApi;
}

function getTeamMemoryStore(options = {}) {
  if (options.teamMemoryStore) return options.teamMemoryStore;
  if (!sharedTeamMemoryStore) {
    sharedTeamMemoryStore = new TeamMemoryStore({
      dbPath: resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true }),
    });
    sharedTeamMemoryStore.init();
  }
  return sharedTeamMemoryStore;
}

function closeSharedRecallRuntime() {
  try { sharedCognitiveMemoryApi?.close?.(); } catch {}
  try { sharedMemorySearchIndex?.close?.(); } catch {}
  try { sharedTeamMemoryStore?.close?.(); } catch {}
  sharedCognitiveMemoryApi = null;
  sharedMemorySearchIndex = null;
  sharedTeamMemoryStore = null;
}

function getRecallFeedbackOps(input = {}) {
  const custom = input.feedbackOps || {};
  return {
    getRankAdjustments: typeof custom.getRankAdjustments === 'function'
      ? custom.getRankAdjustments
      : (payload) => executeTeamMemoryOperation('get-recall-rank-adjustments', payload, input.teamMemoryRuntimeOptions || {}),
    recordRecallSet: typeof custom.recordRecallSet === 'function'
      ? custom.recordRecallSet
      : (payload) => executeTeamMemoryOperation('record-recall-set', payload, input.teamMemoryRuntimeOptions || {}),
    recordRecallFeedback: typeof custom.recordRecallFeedback === 'function'
      ? custom.recordRecallFeedback
      : (payload) => executeTeamMemoryOperation('record-recall-feedback', payload, input.teamMemoryRuntimeOptions || {}),
  };
}

function stripRecallBlocks(value) {
  const text = String(value || '');
  if (!text.includes(RECALL_BLOCK_START)) return text;
  const pattern = new RegExp(`${escapeRegExp(RECALL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(RECALL_BLOCK_END)}\\s*`, 'g');
  return text.replace(pattern, '').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarize(value, limit = 220) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function compactExcerpt(value, limit = 50) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  const maxChars = Math.max(8, Number(limit) || 50);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function scoreTokenMatch(text, tokens) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += token.length > 3 ? 2 : 1;
  }
  return score;
}

function dedupeTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(normalized);
  }
  return terms;
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : (value > 1e9 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      return toTimestampMs(numeric);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getNestedValue(root, selector) {
  if (!root || typeof root !== 'object' || !selector) return null;
  const parts = String(selector).split('.');
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

function formatTimestampInZone(timestampMs, timeZone, options = {}) {
  if (!Number.isFinite(timestampMs)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: options.includeDate ? 'numeric' : undefined,
    month: options.includeDate ? '2-digit' : undefined,
    day: options.includeDate ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs)).replace(',', '');
}

function describeElapsedSince(timestampMs, options = {}) {
  if (!Number.isFinite(timestampMs)) {
    return asString(options.fallback || 'never', 'never');
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  const elapsed = formatDuration(elapsedMs, { style: 'compound' });
  const zoneLabel = asString(options.zoneLabel || '', '');
  const zoneId = asString(options.zoneId || '', '');
  if (!zoneLabel || !zoneId) return `${elapsed} ago`;
  const formatted = formatTimestampInZone(timestampMs, zoneId, {
    includeDate: options.includeDate === true,
  });
  return formatted ? `${elapsed} ago (${zoneLabel} ${formatted})` : `${elapsed} ago`;
}

function selectLatestTimestamp(...candidates) {
  const timestamps = candidates
    .map((value) => toTimestampMs(value))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function findLatestCommsTimestamp(rows = [], predicate = () => false) {
  for (const row of rows) {
    if (!predicate(row)) continue;
    const timestampMs = selectLatestTimestamp(row.sentAtMs, row.brokeredAtMs, row.createdAtMs);
    if (Number.isFinite(timestampMs)) {
      return { row, timestampMs };
    }
  }
  return null;
}

function getRecallLockKey(input = {}) {
  const paneId = asString(input.paneId || '', '');
  if (paneId) return `pane:${paneId}`;
  const role = asString(input.role || input.agentRole || '', '');
  if (role) return `role:${role}`;
  return 'global';
}

async function withRecallLock(key, work) {
  const normalizedKey = asString(key, '') || 'global';
  const previous = recallPaneLocks.get(normalizedKey) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => work());
  recallPaneLocks.set(normalizedKey, current.finally(() => {
    if (recallPaneLocks.get(normalizedKey) === current) {
      recallPaneLocks.delete(normalizedKey);
    }
  }));
  return current;
}

function shouldBoostKoreanCase(context = {}, message = '') {
  const chatId = asString(context.chatId || context.telegramChatId || context.userId || '', '');
  if (chatId === EUNBYEOL_CHAT_ID) return true;
  const lowered = normalizeWhitespace(message).toLowerCase();
  return /은별|private-profile|전명삼|힐스테이트|hillstate|큐라인|qeline|동인동디엠|관세청|customs|korean fraud/.test(lowered);
}

function shouldBoostthe userDirectInput(context = {}) {
  if (context.assumethe userDirectInput === true) return true;
  const identity = asString(context.userIdentity || context.sender || '', '').toLowerCase();
  const channel = asString(context.channel || '', '').toLowerCase();
  if (identity === 'james' || identity === 'james kim') return true;
  return channel === 'user_prompt' || channel === 'direct_terminal';
}

function buildRecallQueryFromMessage(message, context = {}) {
  const baseMessage = stripRecallBlocks(message);
  const parts = [baseMessage];
  const sender = asString(context.sender || context.from || context.displayName || '', '');
  const channel = asString(context.channel || '', '');
  if (sender) parts.push(sender);
  if (channel) parts.push(channel);
  if (shouldBoostKoreanCase(context, baseMessage)) {
    parts.push(...EUNBYEOL_BOOST_TERMS);
  }
  if (shouldBoostthe userDirectInput(context)) {
    parts.push(...JAMES_DIRECT_BOOST_TERMS);
  }
  return dedupeTerms(parts).join(' ');
}

function buildStartupRecallQuery(context = {}) {
  const role = asString(context.role || context.agentRole || '', '').toLowerCase();
  const paneId = asString(context.paneId || '', '');
  const roleSpecific = role || ({
    '1': 'architect',
    '2': 'builder',
    '3': 'oracle',
  }[paneId] || 'agent');
  const seed = {
    architect: 'current session priorities recent decisions user preferences active investigations blockers private-profile james telegram customs trading',
    builder: 'current session priorities recent decisions user preferences active investigations blockers runtime implementation supervisor trading private-profile james telegram',
    oracle: 'current session priorities recent decisions user preferences active investigations blockers research documentation evidence customs private-profile james telegram',
  };
  return seed[roleSpecific] || seed.architect;
}

function buildTimeAwareness(input = {}) {
  const override = asObject(input.timeAwareness);
  if (Array.isArray(override.lines) && override.lines.length > 0) {
    return {
      lines: override.lines.map((line) => normalizeWhitespace(line)).filter(Boolean),
      raw: asObject(override.raw),
    };
  }

  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const appStatus = asObject(input.appStatus || readJsonFileSafe(APP_STATUS_PATH));
  const supervisorStatus = asObject(input.supervisorStatus || readJsonFileSafe(SUPERVISOR_STATUS_PATH));
  const commsRows = Array.isArray(input.commsRows)
    ? input.commsRows
    : queryCommsJournalEntries({
        order: 'desc',
        limit: Number(input.timeAwarenessLedgerLimit) || 200,
      });
  const lines = [];
  const raw = {};

  const sessionStartedMs = selectLatestTimestamp(
    override.sessionStartedAtMs,
    input.sessionStartedAtMs,
    appStatus.started,
    appStatus.startedAt,
    appStatus.startedAtMs
  );
  raw.sessionStartedMs = sessionStartedMs;
  if (Number.isFinite(sessionStartedMs)) {
    const elapsedMs = Math.max(0, nowMs - sessionStartedMs);
    const pdtStarted = formatTimestampInZone(sessionStartedMs, 'America/Los_Angeles', { includeDate: true });
    const kstStarted = formatTimestampInZone(sessionStartedMs, 'Asia/Seoul', { includeDate: true });
    const sinceParts = [
      pdtStarted ? `PDT ${pdtStarted}` : null,
      kstStarted ? `KST ${kstStarted}` : null,
    ].filter(Boolean);
    lines.push(
      `Session duration: ${formatDuration(elapsedMs, { style: 'compound' })}${sinceParts.length ? ` (since ${sinceParts.join(' / ')})` : ''}`
    );
  }

  const consultationFromComms = findLatestCommsTimestamp(commsRows, (row) => /consultation-\d+/i.test(asString(row.rawBody || row.body || '', '')));
  const consultationMs = selectLatestTimestamp(
    override.lastConsultationAtMs,
    supervisorStatus?.cryptoTradingAutomation?.lastProcessedAt,
    supervisorStatus?.tradingAutomation?.lastProcessedAt,
    consultationFromComms?.timestampMs
  );
  raw.lastConsultationAtMs = consultationMs;
  if (Number.isFinite(consultationMs)) {
    lines.push(
      `Last consultation: ${describeElapsedSince(consultationMs, {
        nowMs,
        zoneLabel: 'PDT',
        zoneId: 'America/Los_Angeles',
      })}`
    );
  }

  const [private-live-ops]CheckMs = selectLatestTimestamp(
    override.last[private-live-ops]CheckAtMs,
    supervisorStatus?.[private-live-ops]PositionMonitor?.lastSummary?.checkedAt,
    supervisorStatus?.[private-live-ops]PositionMonitor?.checkedAt
  );
  raw.last[private-live-ops]CheckAtMs = [private-live-ops]CheckMs;
  if (Number.isFinite([private-live-ops]CheckMs)) {
    lines.push(`Last [private-live-ops] check: ${describeElapsedSince([private-live-ops]CheckMs, { nowMs })}`);
  }

  const newsScanMs = selectLatestTimestamp(
    override.lastNewsScanAtMs,
    getNestedValue(supervisorStatus, 'newsScanAutomation.lastProcessedAt'),
    getNestedValue(supervisorStatus, 'eventNewsAutomation.lastProcessedAt'),
    getNestedValue(supervisorStatus, 'marketNewsAutomation.lastProcessedAt')
  );
  raw.lastNewsScanAtMs = newsScanMs;
  lines.push(
    Number.isFinite(newsScanMs)
      ? `Last news scan: ${describeElapsedSince(newsScanMs, { nowMs })}`
      : 'Last news scan: never (not automated)'
  );

  if (shouldBoostKoreanCase(input, input.message || input.text || input.query || '')) {
    const private-profileFromComms = findLatestCommsTimestamp(commsRows, (row) => {
      const metadata = asObject(row.metadata);
      const rawBody = asString(row.rawBody || row.body || '', '');
      const chatId = asString(metadata.chatId || metadata.telegramChatId || row.chatId || '', '');
      const sender = asString(metadata.from || row.sender || '', '');
      return (
        chatId === EUNBYEOL_CHAT_ID
        || /은별|private-profile/i.test(sender)
        || /은별|private-profile|8754356993/i.test(rawBody)
      );
    });
    const private-profileMs = selectLatestTimestamp(
      override.last[private-profile]MessageAtMs,
      private-profileFromComms?.timestampMs
    );
    raw.last[private-profile]MessageAtMs = private-profileMs;
    if (Number.isFinite(private-profileMs)) {
      lines.push(
        `Last 은별 message: ${describeElapsedSince(private-profileMs, {
          nowMs,
          zoneLabel: 'KST',
          zoneId: 'Asia/Seoul',
        })}`
      );
    }
  }

  return { lines, raw };
}

function normalizeSourcePath(value) {
  const normalized = asString(value, '');
  if (!normalized) return '';
  return normalized.replace(/\\/g, '/');
}

function mapEvidenceLedgerRows(rows = [], queryTokens = []) {
  return rows.map((row) => {
    const metadata = row.metadata || {};
    const rawBody = asString(row.rawBody || row.body || '', '');
    const sourceBits = [
      row.senderRole,
      row.targetRole,
      row.channel,
      metadata.from,
      metadata.chatId,
    ].filter(Boolean).join(' ');
    return {
      id: `ledger:${row.messageId || row.rowId || Math.random().toString(36).slice(2, 8)}`,
      store: 'evidence_ledger',
      sourceRole: 'episodic',
      title: `Comms ${row.channel || 'message'}`,
      text: rawBody,
      excerpt: summarize(rawBody, 200),
      citation: row.messageId || null,
      sourcePath: 'evidence-ledger/comms_journal',
      metadata,
      score: scoreTokenMatch(`${rawBody} ${sourceBits}`, queryTokens) + 0.6,
    };
  }).filter((entry) => entry.score > 0);
}

function queryEvidenceLedger(query, options = {}) {
  const rows = queryCommsJournalEntries({
    order: 'desc',
    limit: Number(options.ledgerLimit) || 200,
  });
  return mapEvidenceLedgerRows(rows, tokenize(query))
    .sort((left, right) => right.score - left.score)
    .slice(0, Number(options.limit) || DEFAULT_BACKEND_LIMIT);
}

function mapTeamClaim(claim = {}, queryTokens = []) {
  const scopeText = asArray(claim.scopes).join(' ');
  const statement = asString(claim.statement, '');
  return {
    id: `team-claim:${claim.id}`,
    store: 'team_memory',
    sourceRole: 'structured',
    title: `Claim (${claim.claimType || claim.claim_type || 'fact'})`,
    text: statement,
    excerpt: summarize(statement, 180),
    citation: claim.id,
    sourcePath: scopeText || 'team-memory/claims',
    metadata: {
      owner: claim.owner,
      status: claim.status,
      confidence: claim.confidence,
    },
    score: scoreTokenMatch(`${statement} ${scopeText}`, queryTokens) + Number(claim.confidence || 0),
  };
}

function queryTeamMemoryClaims(query, options = {}) {
  const result = executeTeamMemoryOperation('search-claims', {
    text: query,
    limit: Number(options.claimLimit) || DEFAULT_BACKEND_LIMIT,
    sessionsBack: 8,
  }, options.teamMemoryRuntimeOptions || {});
  if (!result?.ok) return [];
  const queryTokens = tokenize(query);
  return asArray(result.claims)
    .map((claim) => mapTeamClaim(claim, queryTokens))
    .filter((entry) => entry.score > 0);
}

function queryTeamMemorySurfaced(query, options = {}) {
  const store = getTeamMemoryStore(options);
  if (!store?.db) return [];
  const rows = store.db.prepare(`
    SELECT
      e.injection_id,
      e.memory_id,
      e.memory_class,
      e.injection_reason,
      e.source_tier,
      e.confidence,
      e.created_at,
      m.content,
      m.result_refs_json
    FROM memory_injection_events e
    LEFT JOIN memory_objects m ON m.memory_id = e.memory_id
    WHERE e.status IN ('delivered', 'referenced')
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(Number(options.surfacedScanLimit) || 40);
  const queryTokens = tokenize(query);
  return rows.map((row) => {
    const content = asString(row.content, '');
    return {
      id: `team-surfaced:${row.injection_id}`,
      store: 'team_memory',
      sourceRole: 'curated_delivery',
      title: `Surfaced ${row.memory_class || 'memory'}`,
      text: content,
      excerpt: summarize(content, 180),
      citation: row.injection_id,
      sourcePath: 'team-memory/memory_injection_events',
      metadata: {
        memoryId: row.memory_id,
        reason: row.injection_reason,
        sourceTier: row.source_tier,
        confidence: Number(row.confidence || 0),
      },
      score: scoreTokenMatch(`${content} ${row.memory_class || ''} ${row.injection_reason || ''}`, queryTokens) + 1.2,
    };
  }).filter((entry) => entry.score > 0).slice(0, Number(options.surfacedLimit) || 3);
}

function queryTeamMemoryHandoffs(query, options = {}) {
  const store = getTeamMemoryStore(options);
  if (!store?.db) return [];
  const rows = store.db.prepare(`
    SELECT memory_id, content, confidence, session_id, result_refs_json, updated_at
    FROM memory_objects
    WHERE memory_class = 'cross_device_handoff'
      AND status IN ('active', 'pending', 'stale')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(Number(options.handoffScanLimit) || 20);
  const queryTokens = tokenize(query);
  return rows.map((row) => {
    const content = asString(row.content, '');
    return {
      id: `team-handoff:${row.memory_id}`,
      store: 'team_memory',
      sourceRole: 'handoff',
      title: 'Cross-device handoff',
      text: content,
      excerpt: summarize(content, 180),
      citation: row.memory_id,
      sourcePath: 'team-memory/memory_objects',
      metadata: {
        sessionId: row.session_id,
        confidence: Number(row.confidence || 0),
      },
      score: scoreTokenMatch(content, queryTokens) + 0.9,
    };
  }).filter((entry) => entry.score > 0).slice(0, Number(options.handoffLimit) || 2);
}

async function queryMemorySearch(query, options = {}) {
  const index = getMemorySearchIndex(options);
  const result = await index.search(query, {
    limit: Number(options.memorySearchLimit) || DEFAULT_BACKEND_LIMIT,
  });
  return asArray(result.results).map((entry) => ({
    id: `search:${entry.documentId}`,
    store: 'memory_search',
    sourceRole: 'corpus',
    title: asString(entry.title || entry.heading || entry.sourceType || 'Search result', 'Search result'),
    text: asString(entry.content, ''),
    excerpt: summarize(entry.excerpt || entry.content, 180),
    citation: entry.documentId,
    sourcePath: normalizeSourcePath(entry.sourcePath),
    metadata: {
      sourceType: entry.sourceType,
      heading: entry.heading,
    },
    score: Number(entry.score || 0) + 1,
  }));
}

async function queryCognitiveMemory(query, options = {}) {
  const api = getCognitiveMemoryApi(options);
  const result = await api.retrieve(query, {
    agentId: asString(options.agentRole || options.role || 'system', 'system'),
    limit: Number(options.cognitiveLimit) || DEFAULT_BACKEND_LIMIT,
    purpose: 'proactive_injection',
    proactiveInjection: true,
  });
  return asArray(result.results).map((entry) => ({
    id: `cognitive:${entry.nodeId}`,
    store: 'cognitive_memory',
    sourceRole: 'derived_semantic',
    title: asString(entry.title || entry.heading || entry.sourceType || 'Cognitive memory', 'Cognitive memory'),
    text: asString(entry.content, ''),
    excerpt: summarize(entry.content, 180),
    citation: entry.nodeId,
    sourcePath: normalizeSourcePath(entry.sourcePath),
    metadata: {
      sourceType: entry.sourceType,
      leaseId: entry.leaseId,
    },
    score: Number(entry.score || 0) + 0.35,
  }));
}

function dedupeRecallItems(items = []) {
  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    const key = [
      buildRecallIdentityKey(item),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function annotateRecallItems(items = [], resultSetId = '') {
  return items.map((item, index) => ({
    ...item,
    identityKey: item.identityKey || buildRecallIdentityKey(item),
    rankIndex: Number.isFinite(Number(item.rankIndex)) ? Math.floor(Number(item.rankIndex)) : index,
    baseScore: Number(item.baseScore ?? item.score ?? 0) || 0,
    resultItemId: item.resultItemId || buildResultItemId(resultSetId, item, index),
  }));
}

function mergeRecallItems(groups = [], options = {}) {
  const topN = Number(options.topN) || DEFAULT_TOP_N;
  const flattened = dedupeRecallItems(groups.flat());
  const storeWeights = {
    evidence_ledger: 1.2,
    team_memory: 1.4,
    memory_search: 1.0,
    cognitive_memory: 0.8,
  };
  const rankAdjustments = asObject(options.rankAdjustments);
  return flattened
    .map((item) => ({
      ...item,
      baseScore: Number(item.baseScore ?? item.score ?? 0) || 0,
      rankAdjustment: Number(rankAdjustments[item.identityKey] || 0) || 0,
      rankScore: (Number(item.baseScore ?? item.score ?? 0) || 0) * (storeWeights[item.store] || 1)
        + (Number(rankAdjustments[item.identityKey] || 0) || 0),
    }))
    .sort((left, right) => right.rankScore - left.rankScore)
    .map((item, index) => ({
      ...item,
      rankIndex: index,
    }))
    .slice(0, topN);
}

async function rotateRecallAuditIfNeeded(targetPath, maxBytes = DEFAULT_RECALL_AUDIT_MAX_BYTES) {
  let stat = null;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {}
  if (!stat || !stat.isFile() || Number(stat.size || 0) < maxBytes) {
    return { rotated: false, oldPath: `${targetPath}.old` };
  }

  const oldPath = `${targetPath}.old`;
  try {
    await fs.promises.rm(oldPath, { force: true });
  } catch {}
  await fs.promises.rename(targetPath, oldPath);
  return { rotated: true, oldPath };
}

async function persistRecallAudit(entry = {}, options = {}) {
  const targetPath = options.auditPath || RECALL_AUDIT_PATH;
  const maxBytes = Math.max(
    1024,
    Number.parseInt(options.auditMaxBytes || `${DEFAULT_RECALL_AUDIT_MAX_BYTES}`, 10) || DEFAULT_RECALL_AUDIT_MAX_BYTES
  );
  const serialized = `${JSON.stringify(entry)}\n`;
  recallAuditWriteTail = recallAuditWriteTail
    .catch(() => {})
    .then(async () => {
      await ensureDirAsync(targetPath);
      await rotateRecallAuditIfNeeded(targetPath, maxBytes);
      await fs.promises.appendFile(targetPath, serialized, 'utf8');
      return targetPath;
    });
  return recallAuditWriteTail;
}

function isRecallCorrectionSignal(message = '') {
  return RECALL_CORRECTION_PATTERN.test(String(message || ''));
}

async function recordRecallCorrectionFromMessage(message, input = {}) {
  const baseMessage = stripRecallBlocks(message);
  if (!isRecallCorrectionSignal(baseMessage)) {
    return { ok: true, skipped: true, reason: 'no_correction_signal' };
  }
  const feedbackOps = getRecallFeedbackOps(input);
  return Promise.resolve(feedbackOps.recordRecallFeedback({
    feedbackType: 'missing',
    reason: 'user_correction_signal',
    paneId: asString(input.paneId || '', '') || null,
    agentRole: asString(input.role || input.agentRole || '', '') || null,
    channel: asString(input.channel || '', '') || null,
    messageText: baseMessage,
    metadata: {
      sender: asString(input.sender || input.from || '', '') || null,
      chatId: asString(input.chatId || input.telegramChatId || '', '') || null,
    },
    nowMs: input.nowMs || Date.now(),
  }));
}

async function recordRecallUsageFromMessage(message, input = {}) {
  const baseMessage = stripRecallBlocks(message);
  if (!normalizeWhitespace(baseMessage)) {
    return { ok: true, skipped: true, reason: 'empty_message' };
  }
  const feedbackOps = getRecallFeedbackOps(input);
  return Promise.resolve(feedbackOps.recordRecallFeedback({
    feedbackType: 'used',
    reason: 'outbound_message_overlap',
    paneId: asString(input.paneId || '', '') || null,
    agentRole: asString(input.role || input.agentRole || '', '') || null,
    channel: asString(input.channel || '', '') || null,
    resultSetId: asString(input.resultSetId || '', '') || null,
    messageText: baseMessage,
    metadata: {
      target: asString(input.target || '', '') || null,
      routeKind: asString(input.routeKind || '', '') || null,
    },
    nowMs: input.nowMs || Date.now(),
  }));
}

async function recall(input = {}) {
  return withRecallLock(getRecallLockKey(input), async () => {
    const mode = asString(input.mode || 'message', 'message');
    const resultSetId = asString(input.resultSetId, '') || generateId('recall');
    const query = asString(input.query, '') || (
      mode === 'startup'
        ? buildStartupRecallQuery(input)
        : buildRecallQueryFromMessage(input.message || input.text || '', input)
    );
    const timeAwareness = buildTimeAwareness({
      ...input,
      mode,
      query,
    });
    if (!query) {
      return {
        ok: false,
        reason: 'query_required',
        resultSetId,
        query: '',
        items: [],
        timeAwareness,
      };
    }

    const timeoutMs = Math.max(
      250,
      Number.parseInt(input.recallTimeoutMs || `${DEFAULT_RECALL_TIMEOUT_MS}`, 10) || DEFAULT_RECALL_TIMEOUT_MS
    );
    const backends = input.backends || {};
    const backendSpecs = [
      ['evidenceLedger', () => Promise.resolve((backends.queryEvidenceLedger || queryEvidenceLedger)(query, input))],
      ['teamClaims', () => Promise.resolve((backends.queryTeamMemoryClaims || queryTeamMemoryClaims)(query, input))],
      ['teamSurfaced', () => Promise.resolve((backends.queryTeamMemorySurfaced || queryTeamMemorySurfaced)(query, input))],
      ['teamHandoffs', () => Promise.resolve((backends.queryTeamMemoryHandoffs || queryTeamMemoryHandoffs)(query, input))],
      ['memorySearch', () => (backends.queryMemorySearch || queryMemorySearch)(query, input)],
      ['cognitive', () => (backends.queryCognitiveMemory || queryCognitiveMemory)(query, input)],
    ];
    const backendResults = new Map(
      backendSpecs.map(([name]) => [name, {
        name,
        ok: false,
        timedOut: false,
        error: null,
        items: [],
      }])
    );
    const backendPromises = backendSpecs.map(([name, runner]) => Promise.race([
      Promise.resolve()
        .then(runner)
        .then((items) => {
          const result = {
            name,
            ok: true,
            timedOut: false,
            error: null,
            items: asArray(items),
          };
          backendResults.set(name, result);
          return result;
        })
        .catch((error) => {
          const result = {
            name,
            ok: false,
            timedOut: false,
            error: error?.message || `${name}_failed`,
            items: [],
          };
          backendResults.set(name, result);
          return result;
        }),
      new Promise((resolve) => {
        setTimeout(() => {
          const result = {
            name,
            ok: false,
            timedOut: true,
            error: `${name}_timeout`,
            items: [],
          };
          backendResults.set(name, result);
          resolve(result);
        }, timeoutMs);
      }),
    ]));

    const settledBackendResults = await Promise.race([
      Promise.all(backendPromises),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(backendSpecs.map(([name]) => backendResults.get(name)));
        }, timeoutMs);
      }),
    ]);

    const resultByName = new Map(
      asArray(settledBackendResults)
        .filter(Boolean)
        .map((result) => [result.name, result])
    );
    const ledgerItems = asArray(resultByName.get('evidenceLedger')?.items);
    const claimItems = asArray(resultByName.get('teamClaims')?.items);
    const surfacedItems = asArray(resultByName.get('teamSurfaced')?.items);
    const handoffItems = asArray(resultByName.get('teamHandoffs')?.items);
    const searchItems = asArray(resultByName.get('memorySearch')?.items);
    const cognitiveItems = asArray(resultByName.get('cognitive')?.items);

    const annotatedGroups = [
      ledgerItems,
      claimItems,
      surfacedItems,
      handoffItems,
      searchItems,
      cognitiveItems,
    ].map((group) => annotateRecallItems(group, resultSetId));

    const feedbackOps = getRecallFeedbackOps(input);
    const identityKeys = [...new Set(annotatedGroups.flat().map((item) => item.identityKey).filter(Boolean))];
    let rankAdjustments = {};
    let suppressedIdentityKeys = new Set();
    try {
      const adjustmentResult = await Promise.resolve(feedbackOps.getRankAdjustments({ identityKeys }));
      rankAdjustments = asObject(adjustmentResult?.adjustments);
      suppressedIdentityKeys = new Set(
        asArray(adjustmentResult?.suppressedIdentityKeys)
          .map((entry) => asString(entry, ''))
          .filter(Boolean)
      );
    } catch {
      rankAdjustments = {};
      suppressedIdentityKeys = new Set();
    }

    const items = mergeRecallItems(annotatedGroups, {
      ...input,
      rankAdjustments,
    }).filter((item) => {
      const identityKey = asString(item?.identityKey, '');
      return !identityKey || !suppressedIdentityKeys.has(identityKey);
    }).map((item, index) => ({
      ...item,
      resultItemId: item.resultItemId || buildResultItemId(resultSetId, item, index),
      rankIndex: index,
    }));

    const backendStatus = Object.fromEntries(
      backendSpecs.map(([name]) => {
        const result = resultByName.get(name) || backendResults.get(name) || {
          ok: false,
          timedOut: true,
          error: `${name}_timeout`,
          items: [],
        };
        return [name, {
          ok: result.ok === true,
          timedOut: result.timedOut === true,
          error: result.error || null,
          count: asArray(result.items).length,
        }];
      })
    );
    const partial = Object.values(backendStatus).some((entry) => entry.timedOut || entry.error);

    const auditEntry = {
      resultSetId,
      at: new Date().toISOString(),
      mode,
      paneId: asString(input.paneId || '', '') || null,
      role: asString(input.role || input.agentRole || '', '') || null,
      channel: asString(input.channel || '', '') || null,
      sender: asString(input.sender || input.from || '', '') || null,
      chatId: asString(input.chatId || input.telegramChatId || '', '') || null,
      query,
      partial,
      timeoutMs,
      backendStatus,
      counts: {
        evidenceLedger: ledgerItems.length,
        teamClaims: claimItems.length,
        teamSurfaced: surfacedItems.length,
        teamHandoffs: handoffItems.length,
        memorySearch: searchItems.length,
        cognitive: cognitiveItems.length,
        final: items.length,
        hardSuppressed: suppressedIdentityKeys.size,
      },
      items: items.map((item) => ({
        id: item.id,
        resultItemId: item.resultItemId,
        identityKey: item.identityKey,
        store: item.store,
        sourceRole: item.sourceRole,
        title: item.title,
        sourcePath: item.sourcePath,
        citation: item.citation,
        score: Number(item.rankScore || item.score || 0),
        rankAdjustment: Number(item.rankAdjustment || 0),
        excerpt: item.excerpt,
      })),
    };
    const auditPath = await persistRecallAudit(auditEntry, input);

    let feedbackStatus = null;
    try {
      feedbackStatus = await Promise.resolve(feedbackOps.recordRecallSet({
        resultSetId,
        paneId: asString(input.paneId || '', '') || null,
        agentRole: asString(input.role || input.agentRole || '', '') || null,
        channel: asString(input.channel || '', '') || null,
        sender: asString(input.sender || input.from || '', '') || null,
        query,
        metadata: {
          mode,
          auditPath,
          partial,
          timeoutMs,
          backendStatus,
          chatId: asString(input.chatId || input.telegramChatId || '', '') || null,
          hardSuppressedIdentityKeys: Array.from(suppressedIdentityKeys),
        },
        items: items.map((item) => ({
          resultItemId: item.resultItemId,
          identityKey: item.identityKey,
          rankIndex: item.rankIndex,
          store: item.store,
          sourceRole: item.sourceRole,
          sourcePath: item.sourcePath,
          citation: item.citation,
          title: item.title,
          excerpt: item.excerpt,
          score: Number(item.baseScore ?? item.score ?? 0),
          rankScore: Number(item.rankScore || item.score || 0),
          metadata: item.metadata || {},
        })),
        nowMs: input.nowMs || Date.now(),
      }));
    } catch (error) {
      feedbackStatus = {
        ok: false,
        reason: error?.message || 'record_recall_set_failed',
      };
    }

    return {
      ok: true,
      resultSetId,
      query,
      items,
      timeAwareness,
      auditPath,
      partial,
      timeoutMs,
      backendStatus,
      feedbackStatus,
    };
  });
}

function formatRecallForInjection(result = {}, options = {}) {
  const items = asArray(result.items);
  const timeAwarenessLines = asArray(result.timeAwareness?.lines).filter(Boolean);
  if (items.length === 0 && timeAwarenessLines.length === 0) return '';
  const header = asString(options.header || 'RECALL', 'RECALL');
  const compact = options.compact === true;
  const maxItems = Math.max(0, Number(options.maxItems) || (compact ? 3 : items.length));
  const excerptLimit = Math.max(8, Number(options.excerptLimit) || (compact ? 50 : 220));
  const lines = [
    RECALL_BLOCK_START,
    compact
      ? header
      : `${header} resultSetId=${result.resultSetId}`,
  ];
  if (!compact) {
    lines.push(`query=${result.query}`);
  }
  if (timeAwarenessLines.length > 0) {
    lines.push('TIME AWARENESS');
    timeAwarenessLines.forEach((line) => lines.push(`- ${line}`));
  }
  items.slice(0, maxItems).forEach((item, index) => {
    if (compact) {
      lines.push(`${index + 1}. [${item.store}] ${compactExcerpt(item.excerpt || item.text || item.title || '', excerptLimit)}`);
      return;
    }
    const source = item.sourcePath || item.store;
    lines.push(`${index + 1}. [${item.store}/${item.sourceRole}] resultId=${item.resultItemId} ${item.title} :: ${source}`);
    lines.push(`   ${compactExcerpt(item.excerpt || item.text || '', excerptLimit)}`);
  });
  lines.push(RECALL_BLOCK_END);
  return lines.join('\n');
}

async function buildMessageWithRecall(message, input = {}) {
  const baseMessage = stripRecallBlocks(message);
  try {
    await recordRecallCorrectionFromMessage(baseMessage, input);
  } catch {
    // Best-effort negative feedback only; recall delivery should continue.
  }
  const result = await recall({
    ...input,
    mode: input.mode || 'message',
    message: baseMessage,
  });
  const recallBlock = formatRecallForInjection(result, {
    header: input.header || 'RECALL',
  });
  return {
    ok: true,
    result,
    message: recallBlock ? `${baseMessage}\n\n${recallBlock}` : baseMessage,
  };
}

module.exports = {
  EUNBYEOL_BOOST_TERMS,
  EUNBYEOL_CHAT_ID,
  JAMES_DIRECT_BOOST_TERMS,
  RECALL_AUDIT_PATH,
  RECALL_BLOCK_END,
  RECALL_BLOCK_START,
  buildMessageWithRecall,
  buildRecallIdentityKey,
  buildRecallQueryFromMessage,
  buildStartupRecallQuery,
  buildTimeAwareness,
  closeSharedRecallRuntime,
  formatRecallForInjection,
  isRecallCorrectionSignal,
  mergeRecallItems,
  persistRecallAudit,
  queryEvidenceLedger,
  queryTeamMemoryClaims,
  queryTeamMemoryHandoffs,
  queryTeamMemorySurfaced,
  recall,
  recordRecallCorrectionFromMessage,
  recordRecallUsageFromMessage,
  stripRecallBlocks,
  _internals: {
    annotateRecallItems,
    buildResultItemId,
    dedupeTerms,
    dedupeRecallItems,
    getRecallLockKey,
    mapEvidenceLedgerRows,
    rotateRecallAuditIfNeeded,
    scoreTokenMatch,
    shouldBoostthe userDirectInput,
    shouldBoostKoreanCase,
    summarize,
    withRecallLock,
  },
};
