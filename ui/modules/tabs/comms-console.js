/**
 * Comms Console tab module
 * Live monitor for agent-to-agent and external channel comms.
 */

const { invokeBridge } = require('../renderer-bridge');
const {
  PANE_ROLES,
  SHORT_AGENT_NAMES,
  ROLE_ID_MAP,
  LEGACY_ROLE_ALIASES,
  ROLE_NAMES,
  resolveBackgroundBuilderAlias,
} = require('../../config');
const { escapeHtml } = require('./utils');

const MAX_SCROLL_ENTRIES = 5000;
const BODY_PREVIEW_LIMIT = 180;
const HISTORY_PAGE_SIZE = 50;
const TOP_LOAD_THRESHOLD_PX = 24;

const CHANNEL_LABELS = {
  ws: 'WS',
  telegram: 'Telegram',
  sms: 'SMS',
};
const MESSAGE_ROLE_PATTERN = /\(\s*([A-Z][A-Z0-9-]*)\s*#\d+\s*\):/i;
const MESSAGE_FROM_PATTERN = /\[MSG from ([^\]]+)\]/i;
const CANONICAL_ROLE_IDS = new Set(
  (Array.isArray(ROLE_NAMES) && ROLE_NAMES.length > 0 ? ROLE_NAMES : ['architect', 'builder', 'oracle'])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
);
const PANE_ID_TO_CANONICAL_ROLE = new Map(
  Object.entries(ROLE_ID_MAP || {})
    .map(([role, paneId]) => [String(role).toLowerCase(), String(paneId)])
    .filter(([role, paneId]) => CANONICAL_ROLE_IDS.has(role) && paneId)
    .map(([role, paneId]) => [paneId, role])
);
const PANE_LABEL_TO_CANONICAL_ROLE = new Map(
  Object.entries(PANE_ROLES || {})
    .map(([paneId, label]) => [String(label).toLowerCase(), PANE_ID_TO_CANONICAL_ROLE.get(String(paneId)) || null])
    .filter(([, role]) => Boolean(role))
);

let busRef = null;
let handlers = [];
let domCleanupFns = [];
let entries = [];
let keySet = new Set();
let hasLoadedBackfill = false;
let oldestLoadedTimestamp = null;
let hasMoreHistory = true;
let loadingOlderHistory = false;

function formatTimestamp(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function isBackgroundBuilderRole(role) {
  return typeof role === 'string' && /^builder-bg-\d+$/i.test(role.trim());
}

function getBackgroundBuilderSlot(role) {
  const match = typeof role === 'string' ? role.trim().match(/^builder-bg-(\d+)$/i) : null;
  return match && match[1] ? match[1] : null;
}

function inferRoleFromBody(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return null;
  const taggedMatch = text.match(MESSAGE_ROLE_PATTERN);
  if (taggedMatch && taggedMatch[1]) {
    return normalizeRole(taggedMatch[1]);
  }
  const msgFromMatch = text.match(MESSAGE_FROM_PATTERN);
  if (msgFromMatch && msgFromMatch[1]) {
    return normalizeRole(msgFromMatch[1]);
  }
  return null;
}

function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const backgroundAlias = typeof resolveBackgroundBuilderAlias === 'function'
    ? resolveBackgroundBuilderAlias(lower)
    : null;
  if (backgroundAlias) return backgroundAlias;
  if (lower === 'user' || lower === 'telegram') return 'user';
  if (lower === 'cli') return 'architect';
  if (lower === 'system') return 'system';
  if (lower === 'external' || lower === 'external-agent' || lower.includes('claude')) return 'external';
  if (CANONICAL_ROLE_IDS.has(lower)) return lower;
  if (LEGACY_ROLE_ALIASES?.[lower]) return LEGACY_ROLE_ALIASES[lower];
  const paneRole = PANE_ID_TO_CANONICAL_ROLE.get(lower);
  if (paneRole) return paneRole;
  if (ROLE_ID_MAP?.[lower]) {
    const mappedRole = PANE_ID_TO_CANONICAL_ROLE.get(String(ROLE_ID_MAP[lower]));
    if (mappedRole) return mappedRole;
  }
  if (PANE_LABEL_TO_CANONICAL_ROLE.has(lower)) {
    return PANE_LABEL_TO_CANONICAL_ROLE.get(lower);
  }
  return lower;
}

function displayRole(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return 'Unknown';
  if (isBackgroundBuilderRole(normalized)) {
    const slot = getBackgroundBuilderSlot(normalized);
    return slot ? `Builder BG-${slot}` : 'Builder BG';
  }
  if (normalized === 'user') return 'User';
  if (normalized === 'external') return 'External';
  if (normalized === 'system') return SHORT_AGENT_NAMES.system || 'Sys';
  if (normalized === 'architect') return SHORT_AGENT_NAMES['1'] || PANE_ROLES['1'] || 'Architect';
  if (normalized === 'builder') return SHORT_AGENT_NAMES['2'] || PANE_ROLES['2'] || 'Builder';
  if (normalized === 'oracle') return SHORT_AGENT_NAMES['3'] || PANE_ROLES['3'] || 'Oracle';
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function roleClassName(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return 'role-unknown';
  if (isBackgroundBuilderRole(normalized)) return 'role-builder-bg';
  if (
    normalized === 'architect'
    || normalized === 'builder'
    || normalized === 'oracle'
    || normalized === 'system'
    || normalized === 'user'
    || normalized === 'external'
  ) {
    return `role-${normalized}`;
  }
  return 'role-unknown';
}

function senderClassNames(role) {
  const normalized = normalizeRole(role) || 'unknown';
  if (isBackgroundBuilderRole(normalized)) {
    const slot = getBackgroundBuilderSlot(normalized);
    const classes = ['sender-builder-bg'];
    if (slot) classes.push(`sender-builder-bg-${slot}`);
    return classes;
  }
  return [`sender-${normalized}`];
}

function detectChannel(rawChannel, targetValue) {
  const channel = typeof rawChannel === 'string' ? rawChannel.trim().toLowerCase() : '';
  if (channel === 'telegram' || channel === 'sms' || channel === 'ws') return channel;

  const target = typeof targetValue === 'string' ? targetValue.trim().toLowerCase() : '';
  if (target.startsWith('telegram:')) return 'telegram';
  if (target.startsWith('sms:')) return 'sms';
  return 'ws';
}

function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || String(channel || 'WS').toUpperCase();
}

function extractBody(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function bodyPreview(text) {
  if (text.length <= BODY_PREVIEW_LIMIT) return text;
  return `${text.slice(0, BODY_PREVIEW_LIMIT)}...`;
}

function normalizeJournalRow(row) {
  if (!row || typeof row !== 'object') return null;
  const timestamp = Number(row.brokeredAtMs || row.sentAtMs || row.updatedAtMs || Date.now());
  const body = extractBody(row.rawBody);
  const senderRole = normalizeRole(row.senderRole) || inferRoleFromBody(body);
  const targetRole = normalizeRole(row.targetRole);
  const channel = detectChannel(row.channel, row.metadata?.targetRaw);
  const key = row.messageId
    ? `msg:${row.messageId}`
    : `row:${row.rowId || timestamp}:${row.senderRole || ''}:${row.targetRole || ''}`;

  return {
    key,
    timestamp,
    senderRole,
    targetRole,
    channel,
    body,
    sessionId: row.sessionId || row.session_id || null,
  };
}

function normalizeBusEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (!event.type.startsWith('comms.')) return null;

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const targetRaw = payload.targetRole
    || payload.target_role
    || payload.toRole
    || payload.to_role
    || payload.target?.role
    || payload.targetRaw
    || payload.target_raw
    || payload.target
    || null;
  const targetRole = normalizeRole(targetRaw);
  const channel = detectChannel(payload.channel, targetRaw);
  const body = extractBody(payload.rawBody || payload.content || payload.message || payload.body || payload.text || payload.summary);
  const senderRole = normalizeRole(
    payload.senderRole
      || payload.sender_role
      || payload.fromRole
      || payload.from_role
      || payload.sender?.role
  ) || inferRoleFromBody(body);
  const timestamp = Number(event.ts || Date.now());
  const key = payload.messageId
    ? `msg:${payload.messageId}`
    : `evt:${event.eventId || `${event.type}:${event.seq || timestamp}`}`;

  return {
    key,
    messageId: payload.messageId || null,
    timestamp,
    senderRole,
    targetRole,
    channel,
    body,
    sessionId: payload.sessionId || payload.session_id || null,
  };
}

function scrollToBottom() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

function toggleEntryBody(entryNode) {
  if (!entryNode) return;
  const bodyNode = entryNode.querySelector('.comms-console-entry-body');
  if (!bodyNode || !bodyNode.classList.contains('is-truncated')) return;
  const expanded = bodyNode.classList.toggle('expanded');
  bodyNode.textContent = expanded ? bodyNode.dataset.full || '' : bodyNode.dataset.preview || '';
  const toggle = entryNode.querySelector('[data-action="toggle-body"]');
  if (toggle) toggle.textContent = expanded ? 'Collapse' : 'Expand';
}

function createEntryNode(entry) {
  const div = document.createElement('div');
  div.className = 'comms-console-entry';

  const senderText = displayRole(entry.senderRole);
  const targetText = displayRole(entry.targetRole);
  const senderClass = roleClassName(entry.senderRole);
  const targetClass = roleClassName(entry.targetRole);
  const ch = detectChannel(entry.channel);
  const classes = senderClassNames(entry.senderRole);
  for (const className of classes) {
    div.classList.add(className);
  }
  const fullBody = extractBody(entry.body);
  const preview = bodyPreview(fullBody);
  const truncated = preview.length < fullBody.length;
  const sessionText = entry.sessionId ? String(entry.sessionId) : 'session:-';
  const sessionClass = entry.sessionId ? '' : ' is-missing';

  div.innerHTML = `
    <div class="comms-console-entry-head">
      <span class="comms-console-time">${formatTimestamp(entry.timestamp)}</span>
      <span class="comms-console-role ${senderClass}">${escapeHtml(senderText)}</span>
      <span class="comms-console-route-arrow">&rarr;</span>
      <span class="comms-console-role ${targetClass}">${escapeHtml(targetText)}</span>
      <span class="comms-console-channel ch-${escapeHtml(ch)}">${escapeHtml(channelLabel(ch))}</span>
      <span class="comms-console-session-id${sessionClass}" title="Session ID">${escapeHtml(sessionText)}</span>
    </div>
    <div class="comms-console-entry-body${truncated ? ' is-truncated' : ''}">${escapeHtml(preview)}</div>
    ${truncated ? '<button class="comms-console-expand" data-action="toggle-body" type="button">Expand</button>' : ''}
  `;

  if (truncated) {
    const bodyNode = div.querySelector('.comms-console-entry-body');
    if (bodyNode) {
      bodyNode.dataset.preview = preview;
      bodyNode.dataset.full = fullBody;
    }
  }

  return div;
}

function sessionSeparatorLabel(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!raw) return null;
  const match = raw.match(/app-session-(\d+)/i);
  if (match && match[1]) return `--- Session ${match[1]} ---`;
  return `--- ${raw} ---`;
}

function createSessionSeparatorNode(sessionId) {
  const label = sessionSeparatorLabel(sessionId);
  if (!label) return null;
  const div = document.createElement('div');
  div.className = 'comms-console-session-sep';
  div.innerHTML = `<span>${escapeHtml(label)}</span>`;
  return div;
}

function renderEntry(entry, { animate = true } = {}) {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;

  const empty = list.querySelector('.comms-console-empty');
  if (empty) empty.remove();

  const node = createEntryNode(entry);
  if (animate) {
    node.classList.add('entering');
    requestAnimationFrame(() => node.classList.remove('entering'));
  }

  list.appendChild(node);
  scrollToBottom();
}

function resetListPlaceholder() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;
  list.innerHTML = '<div class="comms-console-empty">Waiting for comms traffic...</div>';
}

function showHistoryLoadingIndicator() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return null;
  let indicator = list.querySelector('.comms-console-history-loading');
  if (indicator) return indicator;
  indicator = document.createElement('div');
  indicator.className = 'comms-console-history-loading';
  indicator.innerHTML = '<span class="comms-console-history-spinner"></span><span>Loading older messages...</span>';
  list.prepend(indicator);
  return indicator;
}

function hideHistoryLoadingIndicator(indicator = null) {
  const node = indicator
    || document.querySelector('#commsConsoleList .comms-console-history-loading');
  if (node && node.parentElement) {
    node.remove();
  }
}

function renderEntriesFromState(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const preserveTopScroll = opts.preserveTopScroll && typeof opts.preserveTopScroll === 'object'
    ? opts.preserveTopScroll
    : null;
  const shouldScrollBottom = opts.scrollToBottom === true;

  const list = document.getElementById('commsConsoleList');
  if (!list) return;
  list.innerHTML = '';

  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<div class="comms-console-empty">Waiting for comms traffic...</div>';
    return;
  }

  let previousEntry = null;
  for (const entry of entries) {
    if (
      previousEntry
      && previousEntry.sessionId
      && entry.sessionId
      && previousEntry.sessionId !== entry.sessionId
    ) {
      const sepNode = createSessionSeparatorNode(entry.sessionId);
      if (sepNode) list.appendChild(sepNode);
    }
    list.appendChild(createEntryNode(entry));
    previousEntry = entry;
  }

  if (preserveTopScroll) {
    const previousHeight = Number(preserveTopScroll.previousHeight) || 0;
    const previousTop = Number(preserveTopScroll.previousTop) || 0;
    const delta = Math.max(0, list.scrollHeight - previousHeight);
    list.scrollTop = previousTop + delta;
    return;
  }

  if (shouldScrollBottom) {
    scrollToBottom();
  }
}

function addEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return;
  if (!entry.body || !String(entry.body).trim()) return;
  if (!entry.senderRole && !entry.targetRole) return;

  if (entry.key && keySet.has(entry.key)) return;
  if (entry.key) keySet.add(entry.key);

  const prevEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const shouldInsertSessionSep = Boolean(
    prevEntry
    && prevEntry.sessionId
    && entry.sessionId
    && prevEntry.sessionId !== entry.sessionId
  );
  if (shouldInsertSessionSep) {
    const list = document.getElementById('commsConsoleList');
    const sepNode = createSessionSeparatorNode(entry.sessionId);
    if (list && sepNode) list.appendChild(sepNode);
  }

  entries.push(entry);
  renderEntry(entry, options);

  while (entries.length > MAX_SCROLL_ENTRIES) {
    const removed = entries.shift();
    if (removed && removed.key) keySet.delete(removed.key);
    const list = document.getElementById('commsConsoleList');
    const first = list ? list.querySelector('.comms-console-entry') : null;
    if (first) {
      const prev = first.previousElementSibling;
      first.remove();
      if (prev && prev.classList.contains('comms-console-session-sep')) prev.remove();
    }
    if (list) {
      const danglingSep = list.firstElementChild;
      if (danglingSep && danglingSep.classList.contains('comms-console-session-sep')) danglingSep.remove();
    }
  }
}

function appendRows(rows, { animate = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  for (const row of rows) {
    const entry = normalizeJournalRow(row);
    if (!entry) continue;
    addEntry(entry, { animate });
  }
}

function prependRows(rows, { preserveTopScroll = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const toPrepend = [];
  for (const row of rows) {
    const entry = normalizeJournalRow(row);
    if (!entry) continue;
    if (entry.key && keySet.has(entry.key)) continue;
    if (entry.key) keySet.add(entry.key);
    toPrepend.push(entry);
  }
  if (toPrepend.length === 0) return 0;

  entries = [...toPrepend, ...entries];
  oldestLoadedTimestamp = Number(entries[0]?.timestamp || oldestLoadedTimestamp || Date.now());

  while (entries.length > MAX_SCROLL_ENTRIES) {
    const removed = entries.pop();
    if (removed?.key) keySet.delete(removed.key);
  }

  renderEntriesFromState({ preserveTopScroll });
  return toPrepend.length;
}

function normalizeJournalResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.entries)) return result.entries;
  return [];
}

async function backfillFromJournal(force = false) {
  if (hasLoadedBackfill && force !== true) return;
  try {
    const result = await invokeBridge('evidence-ledger:query-comms-journal', {
      limit: HISTORY_PAGE_SIZE,
      order: 'desc',
    });
    const rows = normalizeJournalResult(result).slice().reverse();
    appendRows(rows, { animate: false });
    oldestLoadedTimestamp = rows.length > 0
      ? Number(rows[0].brokeredAtMs || rows[0].sentAtMs || rows[0].updatedAtMs || Date.now())
      : null;
    hasMoreHistory = rows.length >= HISTORY_PAGE_SIZE;
    scrollToBottom();
    hasLoadedBackfill = true;
  } catch (_) {
    hasLoadedBackfill = true;
  }
}

async function loadOlderHistory() {
  if (!hasLoadedBackfill || loadingOlderHistory || !hasMoreHistory) return;
  if (!Number.isFinite(oldestLoadedTimestamp) || oldestLoadedTimestamp <= 0) return;
  const list = document.getElementById('commsConsoleList');
  if (!list) return;

  loadingOlderHistory = true;
  const indicator = showHistoryLoadingIndicator();
  const previousHeight = list.scrollHeight;
  const previousTop = list.scrollTop;

  try {
    const result = await invokeBridge('evidence-ledger:query-comms-journal', {
      limit: HISTORY_PAGE_SIZE,
      order: 'desc',
      untilMs: Math.max(0, oldestLoadedTimestamp - 1),
    });
    const rows = normalizeJournalResult(result).slice().reverse();
    const inserted = prependRows(rows, {
      preserveTopScroll: {
        previousHeight,
        previousTop,
      },
    });
    hasMoreHistory = rows.length >= HISTORY_PAGE_SIZE && inserted > 0;
  } catch (_) {
    // Keep console resilient if backfill fails.
  } finally {
    hideHistoryLoadingIndicator(indicator);
    loadingOlderHistory = false;
  }
}

async function backfillByMessageId(messageId) {
  if (!messageId) return;
  try {
    const result = await invokeBridge('evidence-ledger:query-comms-journal', {
      messageId,
      limit: 1,
      order: 'desc',
    });
    const rows = normalizeJournalResult(result);
    if (rows.length === 0) return;
    const entry = normalizeJournalRow(rows[0]);
    if (entry) addEntry(entry, { animate: true });
  } catch (_) {}
}

function bindOpenBackfill() {
  const tabBtn = document.querySelector('.panel-tab[data-tab="comms"]');
  if (!tabBtn) return;

  const onOpen = () => {
    void backfillFromJournal();
  };
  tabBtn.addEventListener('click', onOpen);
  domCleanupFns.push(() => tabBtn.removeEventListener('click', onOpen));
}

function bindEntryToggleDelegation() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;

  const clickHandler = (event) => {
    const toggle = event.target.closest('[data-action="toggle-body"]');
    if (toggle) {
      toggleEntryBody(toggle.closest('.comms-console-entry'));
      return;
    }

    const bodyNode = event.target.closest('.comms-console-entry-body');
    if (!bodyNode || !bodyNode.classList.contains('is-truncated')) return;
    toggleEntryBody(bodyNode.closest('.comms-console-entry'));
  };

  list.addEventListener('click', clickHandler);
  domCleanupFns.push(() => list.removeEventListener('click', clickHandler));
}

function bindInfiniteHistoryScroll() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;

  let scheduled = false;
  const onScroll = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (list.scrollTop > TOP_LOAD_THRESHOLD_PX) return;
      void loadOlderHistory();
    });
  };

  list.addEventListener('scroll', onScroll);
  domCleanupFns.push(() => list.removeEventListener('scroll', onScroll));
}

function setupCommsConsoleTab(bus) {
  destroy();
  busRef = bus || null;
  entries = [];
  keySet = new Set();
  hasLoadedBackfill = false;
  oldestLoadedTimestamp = null;
  hasMoreHistory = true;
  loadingOlderHistory = false;
  resetListPlaceholder();
  bindOpenBackfill();
  bindEntryToggleDelegation();
  bindInfiniteHistoryScroll();

  const pane = document.getElementById('tab-comms');
  if (pane && pane.classList.contains('active')) {
    void backfillFromJournal();
  }

  if (busRef) {
    const commsHandler = (event) => {
      const entry = normalizeBusEvent(event);
      if (!entry) return;
      if (entry.messageId) {
        void backfillByMessageId(entry.messageId);
        return;
      }
      addEntry(entry, { animate: true });
    };
    busRef.on('comms.*', commsHandler);
    handlers.push({ type: 'comms.*', fn: commsHandler });
  }

  if (!hasLoadedBackfill) {
    void backfillFromJournal();
  }
}

function destroy() {
  if (busRef) {
    for (const h of handlers) {
      busRef.off(h.type, h.fn);
    }
  }
  handlers = [];
  busRef = null;

  for (const fn of domCleanupFns) {
    try { fn(); } catch (_) {}
  }
  domCleanupFns = [];

  entries = [];
  keySet = new Set();
  hasLoadedBackfill = false;
  oldestLoadedTimestamp = null;
  hasMoreHistory = true;
  loadingOlderHistory = false;
  resetListPlaceholder();
}

module.exports = {
  setupCommsConsoleTab,
  destroy,
};
