/**
 * Comms Console tab module
 * Live monitor for agent-to-agent and external channel comms.
 */

const { ipcRenderer } = require('electron');
const { PANE_ROLES, SHORT_AGENT_NAMES, ROLE_ID_MAP } = require('../../config');
const { escapeHtml } = require('./utils');

const MAX_SCROLL_ENTRIES = 200;
const BODY_PREVIEW_LIMIT = 180;

const CHANNEL_LABELS = {
  ws: 'WS',
  telegram: 'Telegram',
  sms: 'SMS',
};

let busRef = null;
let handlers = [];
let domCleanupFns = [];
let entries = [];
let keySet = new Set();
let hasLoadedBackfill = false;

function formatTimestamp(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'system') return 'system';
  if (lower === 'architect' || lower === 'builder' || lower === 'oracle') return lower;
  if (lower === 'arch') return 'architect';
  if (lower === 'ana' || lower === 'analyst') return 'oracle';
  if (lower === 'devops' || lower === 'backend' || lower === 'infra') return 'builder';
  if (ROLE_ID_MAP[lower]) return normalizeRole(ROLE_ID_MAP[lower]);
  if (PANE_ROLES[raw]) return normalizeRole(PANE_ROLES[raw]);
  return lower;
}

function roleFromPaneId(paneId) {
  if (paneId === '1' || paneId === 1) return 'architect';
  if (paneId === '2' || paneId === 2) return 'builder';
  if (paneId === '5' || paneId === 5) return 'oracle';
  return null;
}

function displayRole(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return 'Unknown';
  if (normalized === 'system') return SHORT_AGENT_NAMES.system || 'Sys';
  if (normalized === 'architect') return SHORT_AGENT_NAMES['1'] || PANE_ROLES['1'] || 'Architect';
  if (normalized === 'builder') return SHORT_AGENT_NAMES['2'] || PANE_ROLES['2'] || 'Builder';
  if (normalized === 'oracle') return SHORT_AGENT_NAMES['5'] || PANE_ROLES['5'] || 'Oracle';
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function roleClassName(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return 'role-unknown';
  if (normalized === 'architect' || normalized === 'builder' || normalized === 'oracle' || normalized === 'system') {
    return `role-${normalized}`;
  }
  return 'role-unknown';
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
  const senderRole = normalizeRole(row.senderRole);
  const targetRole = normalizeRole(row.targetRole);
  const channel = detectChannel(row.channel, row.metadata?.targetRaw);
  const body = extractBody(row.rawBody);
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
  };
}

function normalizeBusEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (!event.type.startsWith('comms.')) return null;

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const senderRole = normalizeRole(
    payload.senderRole
      || payload.fromRole
      || payload.role
      || roleFromPaneId(payload.paneId)
      || roleFromPaneId(event.paneId)
  );
  const targetRaw = payload.targetRole || payload.target || payload.targetRaw || null;
  const targetRole = normalizeRole(targetRaw);
  const channel = detectChannel(payload.channel, targetRaw);
  const body = extractBody(payload.rawBody || payload.content || payload.message || payload.body || payload.text || payload.summary);
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
  };
}

function scrollToBottom() {
  const list = document.getElementById('commsConsoleList');
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

function createEntryNode(entry) {
  const div = document.createElement('div');
  div.className = 'comms-console-entry';

  const senderText = displayRole(entry.senderRole);
  const targetText = displayRole(entry.targetRole);
  const senderClass = roleClassName(entry.senderRole);
  const targetClass = roleClassName(entry.targetRole);
  const ch = detectChannel(entry.channel);
  const fullBody = extractBody(entry.body);
  const preview = bodyPreview(fullBody);
  const truncated = preview.length < fullBody.length;

  div.innerHTML = `
    <div class="comms-console-entry-head">
      <span class="comms-console-time">${formatTimestamp(entry.timestamp)}</span>
      <span class="comms-console-role ${senderClass}">${escapeHtml(senderText)}</span>
      <span class="comms-console-route-arrow">&rarr;</span>
      <span class="comms-console-role ${targetClass}">${escapeHtml(targetText)}</span>
      <span class="comms-console-channel ch-${escapeHtml(ch)}">${escapeHtml(channelLabel(ch))}</span>
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

  const bodyNode = div.querySelector('.comms-console-entry-body');
  if (bodyNode) {
    const bodyToggleHandler = () => {
      if (!bodyNode.classList.contains('is-truncated')) return;
      const expanded = bodyNode.classList.toggle('expanded');
      bodyNode.textContent = expanded ? bodyNode.dataset.full || '' : bodyNode.dataset.preview || '';
      const toggle = div.querySelector('[data-action="toggle-body"]');
      if (toggle) toggle.textContent = expanded ? 'Collapse' : 'Expand';
    };
    bodyNode.addEventListener('click', bodyToggleHandler);
    domCleanupFns.push(() => bodyNode.removeEventListener('click', bodyToggleHandler));
  }

  const toggle = div.querySelector('[data-action="toggle-body"]');
  if (toggle && bodyNode) {
    const clickHandler = () => {
      const expanded = bodyNode.classList.toggle('expanded');
      bodyNode.textContent = expanded ? bodyNode.dataset.full || '' : bodyNode.dataset.preview || '';
      toggle.textContent = expanded ? 'Collapse' : 'Expand';
    };
    toggle.addEventListener('click', clickHandler);
    domCleanupFns.push(() => toggle.removeEventListener('click', clickHandler));
  }

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

function addEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return;
  if (!entry.body || !String(entry.body).trim()) return;
  if (!entry.senderRole && !entry.targetRole) return;

  if (entry.key && keySet.has(entry.key)) return;
  if (entry.key) keySet.add(entry.key);

  entries.push(entry);
  renderEntry(entry, options);

  while (entries.length > MAX_SCROLL_ENTRIES) {
    const removed = entries.shift();
    if (removed && removed.key) keySet.delete(removed.key);
    const list = document.getElementById('commsConsoleList');
    const first = list ? list.querySelector('.comms-console-entry') : null;
    if (first) first.remove();
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

function normalizeJournalResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.entries)) return result.entries;
  return [];
}

async function backfillFromJournal() {
  try {
    const result = await ipcRenderer.invoke('evidence-ledger:query-comms-journal', {
      limit: MAX_SCROLL_ENTRIES,
      order: 'desc',
    });
    const rows = normalizeJournalResult(result).slice().reverse();
    appendRows(rows, { animate: false });
    hasLoadedBackfill = true;
  } catch (_) {
    hasLoadedBackfill = true;
  }
}

async function backfillByMessageId(messageId) {
  if (!messageId) return;
  try {
    const result = await ipcRenderer.invoke('evidence-ledger:query-comms-journal', {
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

function setupCommsConsoleTab(bus) {
  destroy();
  busRef = bus || null;
  entries = [];
  keySet = new Set();
  hasLoadedBackfill = false;
  resetListPlaceholder();
  bindOpenBackfill();

  const pane = document.getElementById('tab-comms');
  if (pane && pane.classList.contains('active')) {
    void backfillFromJournal();
  }

  if (busRef) {
    const commsHandler = (event) => {
      const entry = normalizeBusEvent(event);
      if (!entry) return;
      if (!entry.body && entry.messageId) {
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
  resetListPlaceholder();
}

module.exports = {
  setupCommsConsoleTab,
  destroy,
};
