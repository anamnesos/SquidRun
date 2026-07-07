'use strict';

const workspacePaneShell = require('./workspace-pane-shell');
const {
  DOORBELL_ACK_EVENT,
  DOORBELL_CHOKEPOINT_CALLERS,
  DOORBELL_EVENTS,
  DOORBELL_TRIGGER_EVENTS,
  createDoorbellState,
  transitionDoorbell,
} = require('./shell-v2-doorbell');

const SHELL_V2_TABS = Object.freeze([
  { id: 'mira', label: 'MIRA', shortcut: '1' },
  { id: 'squid-room', label: 'SQUID ROOM', shortcut: '2' },
  { id: 'today', label: 'TODAY', shortcut: '3' },
]);
const SHELL_V2_LAB_TAB = Object.freeze({ id: 'lab', label: 'LAB', shortcut: '4' });

const SHELL_V2_SETTINGS_SECTIONS = Object.freeze([
  ['general', 'General'],
  ['permissions', 'Permissions'],
  ['voice', 'Voice'],
  ['cost', 'Cost Alerts'],
  ['devices', 'Devices'],
  ['secrets', 'Secrets'],
  ['profile', 'Profile'],
]);

const TODAY_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'team', label: 'Team' },
  { id: 'james', label: 'James' },
  { id: 'system', label: 'System' },
]);
const TODAY_POLL_MS = 5000;
const SHELL_V2_TODAY_REFRESH_EVENT = 'shell-v2-refresh-today';

const CORE_STATION_PANE_IDS = Object.freeze(['2', '3']);
const CORE_STATION_LABELS = Object.freeze({
  '2': 'Builder',
  '3': 'Oracle',
});
const TRUSTQUOTE_APP_ID = 'trustquote';
const TRUSTQUOTE_ARM_PANES = Object.freeze(
  Array.isArray(workspacePaneShell.SQUID_ROOM_TRUSTQUOTE_ARM_PANES)
    ? workspacePaneShell.SQUID_ROOM_TRUSTQUOTE_ARM_PANES.slice()
    : []
);
const TRUSTQUOTE_ARM_PANE_IDS = Object.freeze(TRUSTQUOTE_ARM_PANES.map((pane) => pane.paneId));
const SHELL_V2_ACTIVE_PANE_IDS = Object.freeze([
  '1',
  ...CORE_STATION_PANE_IDS,
  ...TRUSTQUOTE_ARM_PANE_IDS,
]);
const SHELL_V2_PANE_SHORTCUTS = Object.freeze({
  '1': { paneId: '1', tabId: 'mira' },
  '2': { paneId: '2', tabId: 'squid-room' },
  '3': { paneId: '3', tabId: 'squid-room' },
});

const SHELL_V2_DOORBELL_PERMISSION_PATTERNS = Object.freeze([
  /\bpermission prompt\b/i,
  /\bpermission (?:required|needed|requested)\b/i,
  /\bapproval (?:required|needed|requested)\b/i,
  /\b(?:allow|approve) (?:this|the) (?:command|action|tool)\b/i,
  /\bdo you want to (?:continue|proceed)\?\b/i,
]);

const SHELL_V2_LEAD_ESCALATION_PATTERNS = Object.freeze([
  /\blead escalation\b/i,
  /\[lead escalation\]/i,
  /\bmissing arm escalation\b/i,
  /\(system response-debt\):/i,
]);

const MAIN_WINDOW_KEYS = new Set(['', 'main']);
const stateByDocument = new WeakMap();

function getShellV2Tabs(settings = {}) {
  return settings?.devMode === true
    ? Object.freeze([...SHELL_V2_TABS, SHELL_V2_LAB_TAB])
    : SHELL_V2_TABS;
}

function normalizeWindowKey(windowContext = {}) {
  return String(windowContext?.windowKey || 'main').trim().toLowerCase();
}

function isMainWindowContext(windowContext = {}) {
  return MAIN_WINDOW_KEYS.has(normalizeWindowKey(windowContext));
}

function isShellV2EnvOverrideEnabled(env = {}) {
  return String(env?.SQUIDRUN_SHELL_V2 || '').trim() === '1';
}

function resolveShellV2Enabled(settings = {}, env = {}, windowContext = {}) {
  if (!isMainWindowContext(windowContext)) return false;
  return settings?.shellV2Enabled === true || isShellV2EnvOverrideEnabled(env);
}

function isShellV2GateProfile(windowContext = {}, env = {}) {
  const profile = String(
    windowContext?.profileName
    || env?.SQUIDRUN_PROFILE
    || ''
  ).trim().toLowerCase();
  return profile === 'shellv2qa';
}

function ensureClass(element, className) {
  if (element && className && !element.classList?.contains?.(className)) {
    element.classList?.add?.(className);
  }
  return element;
}

function makeElement(doc, tagName, className, attributes = {}) {
  const element = doc.createElement(tagName);
  if (className) element.className = className;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'textContent') {
      element.textContent = value;
    } else if (key === 'dataset' && value && typeof value === 'object') {
      Object.assign(element.dataset, value);
    } else {
      element.setAttribute(key, value);
    }
  }
  return element;
}

function appendExisting(parent, child) {
  if (!parent || !child || child.parentNode === parent) return child;
  parent.appendChild(child);
  return child;
}

function findPaneIn(container, paneId) {
  if (!container || !paneId) return null;
  if (container.classList?.contains?.('pane') && String(container.dataset?.paneId || '') === String(paneId)) {
    return container;
  }
  return container.querySelector?.(`.pane[data-pane-id="${paneId}"]`) || null;
}

function showShellElement(element) {
  if (!element) return null;
  element.hidden = false;
  if (element.style?.display === 'none') {
    element.style.display = '';
  }
  element.style?.removeProperty?.('display');
  element.removeAttribute?.('hidden');
  element.removeAttribute?.('aria-hidden');
  return element;
}

function removeElement(element) {
  if (!element) return false;
  if (typeof element.remove === 'function') {
    element.remove();
    return true;
  }
  const parent = element.parentNode;
  if (!parent?.children) return false;
  parent.children = parent.children.filter((child) => child !== element);
  element.parentNode = null;
  element.parentElement = null;
  return true;
}

function clearElement(element) {
  if (!element) return;
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  if (typeof element.removeChild === 'function') {
    while (element.firstChild) element.removeChild(element.firstChild);
    return;
  }
  (element.children || []).forEach((child) => {
    child.parentNode = null;
    child.parentElement = null;
  });
  element.children = [];
}

function appendText(doc, parent, text) {
  if (!parent || !text) return null;
  if (typeof doc?.createTextNode === 'function') {
    const node = doc.createTextNode(text);
    parent.appendChild(node);
    return node;
  }
  const span = makeElement(doc, 'span', '', { textContent: text });
  parent.appendChild(span);
  return span;
}

function titleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function detectModelFamily(command = '') {
  const normalized = String(command || '').trim().toLowerCase();
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('claude')) return 'claude';
  return '';
}

function resolvePaneCommand(settings = {}, paneId = '', fallback = '') {
  const paneCommands = settings?.paneCommands && typeof settings.paneCommands === 'object'
    ? settings.paneCommands
    : {};
  const command = String(paneCommands[String(paneId)] || '').trim();
  return command || fallback || '';
}

function resolvePaneModelLabel(doc, paneId, settings = {}, fallbackCommand = '') {
  const cliBadgeText = String(doc?.getElementById?.(`cli-badge-${paneId}`)?.textContent || '').trim();
  if (cliBadgeText) return cliBadgeText;

  const selectorValue = String(doc?.getElementById?.(`model-selector-${paneId}`)?.value || '').trim();
  const family = detectModelFamily(selectorValue || resolvePaneCommand(settings, paneId, fallbackCommand));
  return family ? titleCase(family) : 'CLI';
}

function makeControlButton(doc, className, paneId, label) {
  const button = makeElement(doc, 'button', `pane-action-btn ${className}`, {
    type: 'button',
    textContent: label,
    dataset: { paneId, tooltip: label },
    'aria-label': label,
  });
  button.dataset.paneId = paneId;
  button.dataset.tooltip = label;
  return button;
}

function makeModelSelector(doc, paneId, command = '') {
  const selector = makeElement(doc, 'select', 'model-selector squid-room-arm-model-selector', {
    id: `model-selector-${paneId}`,
    dataset: {
      paneId,
      squidRoomArmModelSelector: 'true',
    },
    title: 'Switch model for this arm',
  });
  selector.dataset.paneId = paneId;
  selector.dataset.squidRoomArmModelSelector = 'true';
  const current = detectModelFamily(command) || 'codex';
  [
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['gemini', 'Gemini'],
  ].forEach(([value, label]) => {
    const option = makeElement(doc, 'option', '', { value, textContent: label });
    option.value = value;
    if (value === current) option.selected = true;
    selector.appendChild(option);
  });
  selector.value = current;
  selector.dataset.previousValue = current;
  return selector;
}

function getRequiredElements(doc) {
  const body = doc.body;
  const header = doc.querySelector('.header');
  const headerActions = doc.querySelector('.header-actions');
  const paneLayout = doc.querySelector('.pane-layout');
  const mainPaneContainer = doc.querySelector('.main-pane-container');
  const sidePanesContainer = doc.querySelector('.side-panes-container');
  const statusBar = doc.querySelector('.status-bar');

  if (!body || !header || !headerActions || !paneLayout || !mainPaneContainer || !sidePanesContainer || !statusBar) {
    return null;
  }

  return {
    body,
    header,
    headerActions,
    paneLayout,
    mainPaneContainer,
    sidePanesContainer,
    statusBar,
  };
}

function buildTabRail(doc, header, onSelectTab, tabs = SHELL_V2_TABS) {
  let rail = doc.getElementById('shellV2TabRail');
  if (rail) return rail;

  rail = makeElement(doc, 'nav', 'shell-v2-tab-rail', {
    id: 'shellV2TabRail',
    'aria-label': 'Primary views',
  });

  tabs.forEach((tab) => {
    const button = makeElement(doc, 'button', 'shell-v2-tab', {
      type: 'button',
      'data-shell-v2-tab': tab.id,
      'data-shortcut': `Ctrl+${tab.shortcut}`,
      'aria-pressed': 'false',
    });
    button.dataset.shellV2Tab = tab.id;
    button.dataset.shortcut = `Ctrl+${tab.shortcut}`;
    button.appendChild(makeElement(doc, 'span', 'shell-v2-tab-label', {
      textContent: tab.label,
    }));
    if (tab.id === 'squid-room') {
      const badge = makeElement(doc, 'span', 'shell-v2-tab-doorbell-badge', {
        textContent: '',
        hidden: 'true',
        dataset: { shellV2DoorbellBadge: 'squid-room' },
        'aria-label': 'Squid Room needs input',
      });
      badge.dataset.shellV2DoorbellBadge = 'squid-room';
      badge.hidden = true;
      button.appendChild(badge);
    }
    button.addEventListener?.('click', () => onSelectTab(tab.id));
    rail.appendChild(button);
  });

  header.insertBefore(rail, header.firstChild || null);
  return rail;
}

function buildHeaderActions(doc, header, existingActions) {
  let shellActions = doc.getElementById('shellV2HeaderActions');
  if (!shellActions) {
    shellActions = makeElement(doc, 'div', 'shell-v2-header-actions', {
      id: 'shellV2HeaderActions',
    });
    header.appendChild(shellActions);
  }

  const settingsBtn = doc.getElementById('settingsBtn');
  const fullRestartBtn = doc.getElementById('fullRestartBtn');
  appendExisting(shellActions, showShellElement(settingsBtn));
  appendExisting(shellActions, showShellElement(fullRestartBtn));
  if (existingActions) ensureClass(existingActions, 'shell-v2-source-actions');
  return shellActions;
}

function mergeBottomBar(doc, statusBar) {
  showShellElement(statusBar);
  const projectIndicator = doc.querySelector('.project-indicator');
  const sessionBadge = doc.getElementById('headerSessionBadge');
  const ownedWorkSummary = doc.getElementById('ownedWorkSummary');
  const sessionTimer = doc.getElementById('sessionTimer');
  const costIndicator = doc.getElementById('costIndicator');
  const connectionStatus = doc.getElementById('connectionStatus');
  const voiceStatus = doc.getElementById('voiceStatus');
  const heartbeatIndicator = doc.getElementById('heartbeatIndicator');

  ensureClass(statusBar, 'shell-v2-bottom-bar');
  [
    projectIndicator,
    sessionBadge,
    ownedWorkSummary,
    sessionTimer,
    costIndicator,
    connectionStatus,
    voiceStatus,
    heartbeatIndicator,
  ].forEach((element) => appendExisting(statusBar, element));
  statusBar.querySelectorAll?.('.status-shortcuts').forEach((element) => removeElement(element));
}

function ensureViews(doc, paneLayout, tabs = SHELL_V2_TABS) {
  ensureClass(paneLayout, 'shell-v2-pane-layout');

  const views = {};
  tabs.forEach((tab) => {
    let view = paneLayout.querySelector(`.shell-v2-view[data-shell-v2-view="${tab.id}"]`);
    if (!view) {
      view = makeElement(doc, 'section', 'shell-v2-view', {
        'data-shell-v2-view': tab.id,
        'aria-label': tab.label,
        'aria-hidden': 'true',
      });
      view.dataset.shellV2View = tab.id;
      paneLayout.appendChild(view);
    }
    views[tab.id] = view;
  });

  return views;
}

function reparentPaneContainers(doc, views, mainPaneContainer, sidePanesContainer) {
  appendExisting(views.mira, mainPaneContainer);
  ensureClass(views.mira, 'shell-v2-mira-view');

  let coreStrip = doc.getElementById('shellV2CoreStrip');
  if (!coreStrip) {
    coreStrip = makeElement(doc, 'div', 'shell-v2-core-strip', {
      id: 'shellV2CoreStrip',
      'aria-label': 'Squid Room core panes',
    });
    views['squid-room'].appendChild(coreStrip);
  }
  appendExisting(coreStrip, sidePanesContainer);
  ensureClass(views['squid-room'], 'shell-v2-squid-room-view');

  ensureClass(views.today, 'shell-v2-today-view');
  if (!views.today.dataset.phase) {
    views.today.dataset.phase = 'empty';
  }

  return coreStrip;
}

function ensureLabView(doc, views, windowRef) {
  const view = views?.lab;
  if (!doc || !view || view.dataset.shellV2LabBuilt === 'true') return;
  ensureClass(view, 'shell-v2-lab-view');
  const shell = makeElement(doc, 'div', 'shell-v2-lab-shell');
  shell.appendChild(makeElement(doc, 'div', 'shell-v2-lab-title', {
    textContent: 'Mira Lab',
  }));
  const button = makeElement(doc, 'button', 'shell-v2-lab-open', {
    type: 'button',
    textContent: 'Open Mira Lab',
  });
  button.addEventListener?.('click', () => {
    const invoke = resolveRendererInvoke(windowRef);
    if (invoke) void invoke('open-app-window', { windowKey: 'mira-lab' });
  });
  shell.appendChild(button);
  view.appendChild(shell);
  view.dataset.shellV2LabBuilt = 'true';
}

function createTodayState() {
  return {
    filter: 'all',
    search: '',
    rows: [],
    pendingRows: null,
    newCount: 0,
    expandedRowIds: new Set(),
    focusedRowId: null,
    fullFiles: new Map(),
    loading: false,
    error: '',
    rendered: false,
  };
}

function getTodayState(state = {}) {
  if (!state.today) state.today = createTodayState();
  return state.today;
}

function computeTodayWindow(nowMs = Date.now()) {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const dayStartMs = day.getTime();
  return {
    dayStartMs,
    dayEndMs: dayStartMs + 24 * 60 * 60 * 1000,
  };
}

function formatTodayTime(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '--:--';
  const date = new Date(numeric);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function normalizeRoleName(value) {
  return String(value || '').trim().toLowerCase();
}

function displayRoleName(value) {
  const role = normalizeRoleName(value);
  if (!role) return 'System';
  if (role === 'user') return 'James';
  if (role === 'architect' || role === 'arch') return 'Mira';
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function classifyTodayRow(row = {}) {
  const sender = normalizeRoleName(row.senderRole);
  const target = normalizeRoleName(row.targetRole);
  const channel = normalizeRoleName(row.channel);
  if (sender === 'user' || target === 'user') return 'james';
  if (
    sender === 'system'
    || target === 'system'
    || sender === 'daemon'
    || target === 'daemon'
    || channel === 'voice'
  ) {
    return 'system';
  }
  return 'team';
}

function todayOriginGlyph(row = {}) {
  const kind = row.todayKind || classifyTodayRow(row);
  if (kind === 'system') return 'sys';
  if (kind === 'james') {
    return normalizeRoleName(row.senderRole) === 'user' ? '⇠' : '⇢';
  }
  return '⇄';
}

function parseTodayTag(rawBody = '', row = {}) {
  const text = String(rawBody || '').trim();
  const withoutSpeaker = text.replace(/^\([^)]+\):\s*/, '').trim();
  const bracket = withoutSpeaker.match(/^\[([^\]\r\n]{1,36})\]/);
  if (bracket) return bracket[1].trim();
  const speaker = text.match(/^\(([A-Za-z][A-Za-z/-]*\s+#\d+)\):/);
  if (speaker) return speaker[1].trim();
  return String(row.channel || '').trim().toUpperCase() || 'MSG';
}

function compactTodayExcerpt(rawBody = '', maxChars = 180) {
  const text = String(rawBody || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeTodayRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const normalized = {
      rowId: row.rowId ?? row.row_id ?? '',
      messageId: row.messageId ?? row.message_id ?? '',
      sessionId: row.sessionId ?? row.session_id ?? '',
      senderRole: row.senderRole ?? row.sender_role ?? '',
      targetRole: row.targetRole ?? row.target_role ?? '',
      channel: row.channel ?? '',
      direction: row.direction ?? '',
      timestampMs: Number(row.timestampMs ?? row.brokeredAtMs ?? row.sentAtMs ?? row.updatedAtMs ?? 0) || 0,
      rawBody: typeof row.rawBody === 'string'
        ? row.rawBody
        : (typeof row.raw_body === 'string' ? row.raw_body : ''),
      status: row.status || 'recorded',
      ackStatus: row.ackStatus ?? row.ack_status ?? '',
      attempt: row.attempt ?? '',
      hasFullFile: row.hasFullFile === true,
    };
    normalized.todayKind = classifyTodayRow(normalized);
    normalized.tag = parseTodayTag(normalized.rawBody, normalized);
    normalized.excerpt = compactTodayExcerpt(normalized.rawBody);
    return normalized;
  });
}

function countTodayKinds(rows = []) {
  const counts = { all: rows.length, team: 0, james: 0, system: 0 };
  rows.forEach((row) => {
    const kind = row.todayKind || classifyTodayRow(row);
    if (Object.prototype.hasOwnProperty.call(counts, kind)) counts[kind] += 1;
  });
  return counts;
}

function getVisibleTodayRows(today = {}) {
  const query = String(today.search || '').trim().toLowerCase();
  return (today.rows || []).filter((row) => {
    if (today.filter && today.filter !== 'all' && row.todayKind !== today.filter) return false;
    if (!query) return true;
    return [
      row.rawBody,
      row.senderRole,
      row.targetRole,
      row.status,
      row.tag,
      row.messageId,
      row.sessionId,
    ].some((value) => String(value || '').toLowerCase().includes(query));
  });
}

function resolveTodayApi(windowRef = null, options = {}) {
  if (typeof options.todayJournalApi === 'function') {
    return {
      query: options.todayJournalApi,
      readFull: typeof options.todayFullMessageApi === 'function'
        ? options.todayFullMessageApi
        : null,
    };
  }
  const bridge = windowRef?.squidrunAPI || windowRef?.squidrun || {};
  const invoke = typeof bridge.invoke === 'function'
    ? bridge.invoke.bind(bridge)
    : (typeof bridge.ipc?.invoke === 'function' ? bridge.ipc.invoke.bind(bridge.ipc) : null);
  if (!invoke) return { query: null, readFull: null };
  return {
    query: (payload) => invoke('shell-v2:today-journal', payload),
    readFull: (payload) => invoke('shell-v2:today-full-message', payload),
  };
}

function makeTodaySeparator(doc) {
  return makeElement(doc, 'span', 'shell-v2-today-separator', {
    textContent: '·',
    'aria-hidden': 'true',
  });
}

function formatTodayParticipants(row = {}) {
  return `${displayRoleName(row.senderRole)}→${displayRoleName(row.targetRole)}`;
}

function formatSessionDivider(row = {}) {
  const sessionId = String(row.sessionId || 'session').trim() || 'session';
  const match = sessionId.match(/app-session-(\d+)/i);
  const label = match ? `session ${match[1]}` : sessionId;
  return `${label} · started ${formatTodayTime(row.timestampMs)}`;
}

function renderTodayHeader(doc, root, today) {
  const counts = countTodayKinds(today.rows || []);
  TODAY_FILTERS.forEach((filter) => {
    const chip = root.querySelector?.(`[data-today-filter="${filter.id}"]`);
    if (!chip) return;
    chip.textContent = `${filter.label} ${counts[filter.id] || 0}`;
    chip.classList.toggle('active', today.filter === filter.id);
    chip.setAttribute?.('aria-pressed', today.filter === filter.id ? 'true' : 'false');
  });

  const search = root.querySelector?.('[data-today-search="true"]');
  if (search && search.value !== today.search) search.value = today.search || '';

  const collapse = root.querySelector?.('[data-today-collapse-all="true"]');
  if (collapse) collapse.disabled = today.expandedRowIds.size === 0;

  const pill = root.querySelector?.('[data-today-new-pill="true"]');
  if (pill) {
    pill.hidden = !(today.newCount > 0);
    pill.textContent = today.newCount > 0 ? `${today.newCount} new ↑` : '';
  }
}

function renderTodayEmpty(doc, list, text) {
  const empty = makeElement(doc, 'div', 'shell-v2-today-empty', {
    textContent: text || 'No journal rows today',
  });
  list.appendChild(empty);
}

async function writeClipboardText(windowRef, text) {
  const value = String(text || '');
  const clipboard = windowRef?.navigator?.clipboard
    || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
  if (clipboard && typeof clipboard.writeText === 'function') {
    await clipboard.writeText(value);
    return true;
  }
  return false;
}

function makeTodayCopyButton(doc, label, value, windowRef) {
  const button = makeElement(doc, 'button', 'shell-v2-today-copy-btn', {
    type: 'button',
    textContent: label,
    dataset: { todayCopy: label.toLowerCase().replace(/\s+/g, '-') },
  });
  button.addEventListener?.('click', async (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    button.dataset.copyState = 'pending';
    const ok = await writeClipboardText(windowRef || doc.defaultView || null, value);
    button.dataset.copyState = ok ? 'copied' : 'failed';
    try {
      const EventCtor = (windowRef || doc.defaultView || globalThis)?.CustomEvent;
      if (typeof EventCtor === 'function') {
        doc.dispatchEvent(new EventCtor('shell-v2-today-copy', {
          bubbles: true,
          detail: { label, value: String(value || ''), ok },
        }));
      }
    } catch (_) {}
  });
  return button;
}

function renderTodayExpanded(doc, row, today, api, refreshRender, windowRef = null) {
  const expanded = makeElement(doc, 'div', 'shell-v2-today-expanded');
  const actions = makeElement(doc, 'div', 'shell-v2-today-expanded-actions');
  actions.appendChild(makeTodayCopyButton(doc, 'Copy body', row.rawBody || '', windowRef));
  actions.appendChild(makeTodayCopyButton(doc, 'Copy id', row.messageId || row.rowId || '', windowRef));
  expanded.appendChild(actions);
  expanded.appendChild(makeElement(doc, 'pre', 'shell-v2-today-raw', {
    textContent: row.rawBody || '',
  }));
  expanded.appendChild(makeElement(doc, 'div', 'shell-v2-today-footer', {
    textContent: [
      `msgId=${row.messageId || '-'}`,
      `rowId=${row.rowId || '-'}`,
      `sessionId=${row.sessionId || '-'}`,
      `attempt=${row.attempt === '' || row.attempt === null || row.attempt === undefined ? '-' : row.attempt}`,
      `ackStatus=${row.ackStatus || '-'}`,
    ].join(' · '),
  }));

  if (row.hasFullFile) {
    const loaded = today.fullFiles.get(String(row.messageId || ''));
    if (loaded?.ok) {
      expanded.appendChild(makeElement(doc, 'div', 'shell-v2-today-full-meta', {
        textContent: `${loaded.bytes} bytes · sha ${loaded.shaShort}`,
      }));
      expanded.appendChild(makeElement(doc, 'pre', 'shell-v2-today-full-raw', {
        textContent: loaded.content || '',
      }));
    } else {
      const button = makeElement(doc, 'button', 'shell-v2-today-full-btn', {
        type: 'button',
        textContent: loaded?.loading ? 'Opening...' : 'Open full file',
      });
      button.disabled = loaded?.loading === true || !api?.readFull;
      button.addEventListener?.('click', async (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        const key = String(row.messageId || '');
        today.fullFiles.set(key, { loading: true });
        refreshRender();
        try {
          const result = await api.readFull({ messageId: row.messageId });
          today.fullFiles.set(key, result && typeof result === 'object' ? result : { ok: false, reason: 'read_failed' });
        } catch (err) {
          today.fullFiles.set(key, { ok: false, reason: err?.message || 'read_failed' });
        }
        refreshRender();
      });
      expanded.appendChild(button);
      if (loaded && loaded.ok === false) {
        expanded.appendChild(makeElement(doc, 'div', 'shell-v2-today-full-error', {
          textContent: loaded.reason || 'full file unavailable',
        }));
      }
    }
  }

  return expanded;
}

function renderTodayRows(doc, root, today, api, windowRef = null) {
  renderTodayHeader(doc, root, today);
  const list = root.querySelector?.('[data-today-list="true"]');
  if (!list) return;
  clearElement(list);

  if (today.loading && (!today.rows || today.rows.length === 0)) {
    renderTodayEmpty(doc, list, 'Loading journal rows');
    return;
  }
  if (today.error) {
    renderTodayEmpty(doc, list, today.error);
    return;
  }

  const visibleRows = getVisibleTodayRows(today);
  today.visibleRowIds = visibleRows.map((row) => String(row.rowId || row.messageId || ''));
  if (!today.focusedRowId && visibleRows[0]) {
    today.focusedRowId = String(visibleRows[0].rowId || visibleRows[0].messageId || '');
  }
  if (visibleRows.length === 0) {
    const noRowsToday = (today.rows || []).length === 0 && !String(today.search || '').trim() && today.filter === 'all';
    renderTodayEmpty(doc, list, noRowsToday ? 'No journal rows today' : 'No journal rows match');
    return;
  }

  let previousSession = null;
  visibleRows.forEach((row) => {
    const sessionId = String(row.sessionId || '');
    if (sessionId !== previousSession) {
      list.appendChild(makeElement(doc, 'div', 'shell-v2-today-session-divider', {
        textContent: formatSessionDivider(row),
      }));
      previousSession = sessionId;
    }

    const rowId = String(row.rowId || row.messageId || '');
    const article = makeElement(doc, 'article', `shell-v2-today-row today-kind-${row.todayKind}`, {
      dataset: {
        todayRowId: rowId,
        todayKind: row.todayKind,
        status: row.status || '',
      },
    });
    article.dataset.todayRowId = rowId;
    article.dataset.todayKind = row.todayKind;
    article.dataset.status = row.status || '';
    const expanded = today.expandedRowIds.has(rowId);
    article.classList.toggle('is-expanded', expanded);
    article.classList.toggle('is-focused', today.focusedRowId === rowId);

    const summary = makeElement(doc, 'button', 'shell-v2-today-summary', {
      type: 'button',
      'aria-expanded': expanded ? 'true' : 'false',
      dataset: { todayRowSummary: rowId },
    });
    summary.dataset.todayRowSummary = rowId;
    summary.tabIndex = today.focusedRowId === rowId ? 0 : -1;
    summary.appendChild(makeElement(doc, 'span', 'shell-v2-today-time', {
      textContent: formatTodayTime(row.timestampMs),
    }));
    summary.appendChild(makeTodaySeparator(doc));
    summary.appendChild(makeElement(doc, 'span', 'shell-v2-today-origin', {
      textContent: todayOriginGlyph(row),
    }));
    summary.appendChild(makeTodaySeparator(doc));
    summary.appendChild(makeElement(doc, 'span', 'shell-v2-today-party', {
      textContent: formatTodayParticipants(row),
    }));
    summary.appendChild(makeElement(doc, 'span', 'shell-v2-today-tag', {
      textContent: `[${row.tag}]`,
    }));
    summary.appendChild(makeElement(doc, 'span', 'shell-v2-today-excerpt', {
      textContent: row.excerpt,
    }));
    const status = makeElement(doc, 'span', 'shell-v2-today-status', {
      textContent: row.status || 'recorded',
    });
    if (String(row.status || '').toLowerCase() === 'failed') {
      status.classList.add('is-failed');
    }
    summary.appendChild(status);
    summary.addEventListener?.('click', () => {
      today.focusedRowId = rowId;
      if (today.expandedRowIds.has(rowId)) today.expandedRowIds.delete(rowId);
      else today.expandedRowIds.add(rowId);
      renderTodayRows(doc, root, today, api, windowRef);
    });
    article.appendChild(summary);

    if (expanded) {
      article.appendChild(renderTodayExpanded(
        doc,
        row,
        today,
        api,
        () => renderTodayRows(doc, root, today, api, windowRef),
        windowRef
      ));
    }
    list.appendChild(article);
  });
}

function setTodayFilter(doc, root, today, filterId, api, windowRef = null) {
  const next = TODAY_FILTERS.some((filter) => filter.id === filterId) ? filterId : 'all';
  today.filter = next;
  const first = getVisibleTodayRows(today)[0];
  today.focusedRowId = first ? String(first.rowId || first.messageId || '') : null;
  renderTodayRows(doc, root, today, api, windowRef || today.windowRef || null);
}

function focusTodayRow(root, rowId) {
  if (!rowId) return;
  const summary = root.querySelector?.(`[data-today-row-summary="${rowId}"]`);
  summary?.focus?.({ preventScroll: true });
}

function navigateTodayRows(doc, root, today, api, delta, windowRef = null) {
  const rows = getVisibleTodayRows(today);
  if (rows.length === 0) return;
  const ids = rows.map((row) => String(row.rowId || row.messageId || ''));
  const current = ids.indexOf(String(today.focusedRowId || ''));
  const nextIndex = Math.max(0, Math.min(ids.length - 1, (current < 0 ? 0 : current) + delta));
  today.focusedRowId = ids[nextIndex];
  renderTodayRows(doc, root, today, api, windowRef || today.windowRef || null);
  focusTodayRow(root, today.focusedRowId);
}

function toggleFocusedTodayRow(doc, root, today, api, windowRef = null) {
  const rowId = String(today.focusedRowId || '');
  if (!rowId) return;
  if (today.expandedRowIds.has(rowId)) today.expandedRowIds.delete(rowId);
  else today.expandedRowIds.add(rowId);
  renderTodayRows(doc, root, today, api, windowRef || today.windowRef || null);
  focusTodayRow(root, rowId);
}

function collapseFocusedTodayRow(doc, root, today, api, windowRef = null) {
  const rowId = String(today.focusedRowId || '');
  if (!rowId || !today.expandedRowIds.has(rowId)) return false;
  today.expandedRowIds.delete(rowId);
  renderTodayRows(doc, root, today, api, windowRef || today.windowRef || null);
  focusTodayRow(root, rowId);
  return true;
}

function applyPendingTodayRows(doc, root, today, api, windowRef = null) {
  if (Array.isArray(today.pendingRows)) {
    today.rows = today.pendingRows;
    today.pendingRows = null;
  }
  today.newCount = 0;
  renderTodayRows(doc, root, today, api, windowRef || today.windowRef || null);
  const list = root.querySelector?.('[data-today-list="true"]');
  if (list) list.scrollTop = 0;
}

function bindTodayKeyboard(doc, root, today, api, windowRef = null) {
  if (root.dataset.todayKeyboardBound === 'true') return;
  root.addEventListener?.('keydown', (event) => {
    const targetTag = String(event.target?.tagName || '').toUpperCase();
    const inTextInput = ['INPUT', 'TEXTAREA'].includes(targetTag);
    if (inTextInput && event.key !== 'Escape') return;

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault?.();
      navigateTodayRows(doc, root, today, api, 1, windowRef);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault?.();
      navigateTodayRows(doc, root, today, api, -1, windowRef);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault?.();
      toggleFocusedTodayRow(doc, root, today, api, windowRef);
      return;
    }
    if (event.key === 'Escape') {
      if (collapseFocusedTodayRow(doc, root, today, api, windowRef)) {
        event.preventDefault?.();
      }
      return;
    }
    if (['1', '2', '3', '4'].includes(String(event.key || '')) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault?.();
      const filter = TODAY_FILTERS[Number(event.key) - 1];
      setTodayFilter(doc, root, today, filter?.id || 'all', api, windowRef);
      return;
    }
    if (event.key === '/' && !inTextInput) {
      event.preventDefault?.();
      root.querySelector?.('[data-today-search="true"]')?.focus?.();
    }
  });
  root.dataset.todayKeyboardBound = 'true';
}

function ensureTodayView(doc, view, windowRef, state = {}, options = {}) {
  if (!doc || !view) return null;
  ensureClass(view, 'shell-v2-today-view');
  const today = getTodayState(state);
  let root = view.querySelector?.('#shellV2TodayRoot');
  const api = resolveTodayApi(windowRef, options);
  today.api = api;
  today.windowRef = windowRef || null;

  if (!root) {
    clearElement(view);
    root = makeElement(doc, 'section', 'shell-v2-today-root', {
      id: 'shellV2TodayRoot',
      'aria-label': 'Today journal',
    });
    const header = makeElement(doc, 'div', 'shell-v2-today-header');
    const chips = makeElement(doc, 'div', 'shell-v2-today-chips', {
      'aria-label': 'Today filters',
    });
    TODAY_FILTERS.forEach((filter) => {
      const chip = makeElement(doc, 'button', 'shell-v2-today-chip', {
        type: 'button',
        textContent: `${filter.label} 0`,
        dataset: { todayFilter: filter.id },
        'aria-pressed': filter.id === today.filter ? 'true' : 'false',
      });
      chip.dataset.todayFilter = filter.id;
      chip.addEventListener?.('click', () => setTodayFilter(doc, root, today, filter.id, api, windowRef));
      chips.appendChild(chip);
    });
    const search = makeElement(doc, 'input', 'shell-v2-today-search', {
      type: 'search',
      placeholder: 'Search today',
      dataset: { todaySearch: 'true' },
      'aria-label': 'Search today',
    });
    search.dataset.todaySearch = 'true';
    search.value = today.search || '';
    search.addEventListener?.('input', (event) => {
      today.search = String(event.target?.value || '');
      const first = getVisibleTodayRows(today)[0];
      today.focusedRowId = first ? String(first.rowId || first.messageId || '') : null;
      renderTodayRows(doc, root, today, api, windowRef);
    });
    const collapse = makeElement(doc, 'button', 'shell-v2-today-collapse-all', {
      type: 'button',
      textContent: 'Collapse all',
      dataset: { todayCollapseAll: 'true' },
    });
    collapse.dataset.todayCollapseAll = 'true';
    collapse.addEventListener?.('click', () => {
      today.expandedRowIds.clear();
      renderTodayRows(doc, root, today, api, windowRef);
    });
    header.appendChild(chips);
    header.appendChild(search);
    header.appendChild(collapse);

    const body = makeElement(doc, 'div', 'shell-v2-today-body');
    const pill = makeElement(doc, 'button', 'shell-v2-today-new-pill', {
      type: 'button',
      textContent: '',
      hidden: 'true',
      dataset: { todayNewPill: 'true' },
    });
    pill.dataset.todayNewPill = 'true';
    pill.hidden = true;
    pill.addEventListener?.('click', () => applyPendingTodayRows(doc, root, today, api, windowRef));
    const list = makeElement(doc, 'div', 'shell-v2-today-list', {
      dataset: { todayList: 'true' },
      tabindex: '0',
    });
    list.dataset.todayList = 'true';
    list.addEventListener?.('scroll', () => {
      today.atTop = Number(list.scrollTop || 0) <= 2;
    });
    body.appendChild(pill);
    body.appendChild(list);

    root.appendChild(header);
    root.appendChild(body);
    view.appendChild(root);
    bindTodayKeyboard(doc, root, today, api, windowRef);
  }

  renderTodayRows(doc, root, today, api, windowRef);
  today.rendered = true;
  return root;
}

async function refreshShellV2Today(doc, view, windowRef, state = {}, options = {}, refreshOptions = {}) {
  const today = getTodayState(state);
  const root = ensureTodayView(doc, view, windowRef, state, options);
  const api = today.api || resolveTodayApi(windowRef, options);
  today.api = api;
  if (!root || typeof api.query !== 'function') {
    today.error = 'Today journal IPC unavailable';
    renderTodayRows(doc, root, today, api, windowRef);
    return { ok: false, reason: 'today_ipc_unavailable' };
  }

  const list = root.querySelector?.('[data-today-list="true"]');
  const awayFromTop = Number(list?.scrollTop || 0) > 2;
  const previousTop = today.rows?.[0]?.rowId || null;
  today.loading = true;
  today.error = '';
  renderTodayHeader(doc, root, today);

  try {
    const windowPayload = computeTodayWindow();
    const result = await api.query({
      ...windowPayload,
      limit: refreshOptions.limit || 5000,
    });
    if (!result || result.ok === false) {
      today.error = result?.reason || 'Today journal query failed';
      today.loading = false;
      renderTodayRows(doc, root, today, api, windowRef);
      return result || { ok: false, reason: 'today_query_failed' };
    }

    const rows = normalizeTodayRows(result.rows || []);
    const nextTop = rows[0]?.rowId || null;
    if (
      refreshOptions.preserveScroll !== false
      && awayFromTop
      && previousTop
      && nextTop
      && String(nextTop) !== String(previousTop)
    ) {
      today.pendingRows = rows;
      const previousNumeric = Number(previousTop);
      today.newCount = rows.filter((row) => Number(row.rowId) > previousNumeric).length || 1;
      today.loading = false;
      renderTodayHeader(doc, root, today);
      return { ok: true, pending: true, count: rows.length, newCount: today.newCount };
    }

    today.rows = rows;
    today.pendingRows = null;
    today.newCount = 0;
    today.loading = false;
    if (!today.focusedRowId && rows[0]) today.focusedRowId = String(rows[0].rowId || rows[0].messageId || '');
    renderTodayRows(doc, root, today, api, windowRef);
    return { ok: true, count: rows.length };
  } catch (err) {
    today.loading = false;
    today.error = err?.message || 'Today journal query failed';
    renderTodayRows(doc, root, today, api, windowRef);
    return { ok: false, reason: today.error };
  }
}

function bindTodayWindowButtonShim(doc, switchTab) {
  const button = doc?.getElementById?.('openHumanTimelineBtn');
  if (!button || button.dataset.shellV2TodayShim === 'true') return;
  try {
    button.onclick = null;
    button.removeAttribute?.('onclick');
  } catch (_) {}
  button.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    switchTab('today');
  });
  button.dataset.shellV2TodayShim = 'true';
}

function findSettingsSectionByTitle(doc, pattern) {
  const sections = [...(doc?.querySelectorAll?.('#settingsPanel .settings-section') || [])];
  return sections.find((section) => pattern.test(section.querySelector?.('.settings-section-title')?.textContent || '')) || null;
}

function resolveRendererInvoke(windowRef = null) {
  const bridge = windowRef?.squidrunAPI || windowRef?.squidrun || {};
  return typeof bridge.invoke === 'function'
    ? bridge.invoke.bind(bridge)
    : (typeof bridge.ipc?.invoke === 'function' ? bridge.ipc.invoke.bind(bridge.ipc) : null);
}

function resolveDoorbellJournalWriter(windowRef = null, options = {}) {
  if (typeof options.doorbellJournalApi === 'function') return options.doorbellJournalApi;
  return async (row) => {
    const invoke = resolveRendererInvoke(windowRef);
    if (!invoke) return { ok: false, reason: 'doorbell_journal_ipc_unavailable' };
    return invoke('evidence-ledger:upsert-comms-journal', row);
  };
}

function getDoorbellSessionId(doc, options = {}) {
  const candidates = [
    options.windowContext?.sessionScopeId,
    options.windowContext?.sessionId,
    doc?.getElementById?.('headerSessionBadge')?.textContent,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return null;
}

function makeDoorbellMessageId(eventName, paneId, timestampMs) {
  const safePane = String(paneId || 'squid-room').replace(/[^A-Za-z0-9_-]/g, '-');
  const safeEvent = String(eventName || 'event').replace(/[^A-Za-z0-9_-]/g, '-');
  return `shell-v2-doorbell-${safeEvent}-${safePane}-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`;
}

function getShellV2DoorbellState(state = {}) {
  if (!state.doorbell) state.doorbell = createDoorbellState();
  return state.doorbell;
}

function makeDoorbellSlot(doc, paneId, label) {
  const slot = makeElement(doc, 'span', 'shell-v2-needs-input-slot', {
    dataset: { paneId, shellV2DoorbellSlot: 'true' },
    'aria-label': `${label || paneId} needs input`,
  });
  slot.dataset.paneId = paneId;
  slot.dataset.shellV2DoorbellSlot = 'true';
  return slot;
}

function appendStationSeparator(doc, parent) {
  return parent?.appendChild?.(makeElement(doc, 'span', 'shell-v2-station-separator', {
    textContent: '·',
    'aria-hidden': 'true',
  })) || null;
}

function getDoorbellHeaderForSlot(slot) {
  return slot?.closest?.('.pane-header') || slot?.parentNode || null;
}

function renderShellV2Doorbell(doc, state = {}) {
  const doorbell = getShellV2DoorbellState(state);
  const count = Number(doorbell.count || 0);
  const badge = doc?.querySelector?.('[data-shell-v2-doorbell-badge="squid-room"]');
  if (badge) {
    badge.hidden = count <= 0;
    badge.textContent = count > 0 ? String(count) : '';
    badge.classList.toggle('on', count > 0);
  }
  const tab = doc?.querySelector?.('[data-shell-v2-tab="squid-room"]');
  tab?.classList?.toggle?.('has-doorbell', count > 0);

  doc?.querySelectorAll?.('[data-shell-v2-doorbell-slot="true"]').forEach((slot) => {
    const paneId = String(slot.dataset?.paneId || '');
    const active = doorbell.byPane?.[paneId] || null;
    slot.textContent = active ? active.displayText : '';
    slot.dataset.doorbellEvent = active?.eventName || '';
    const header = getDoorbellHeaderForSlot(slot);
    header?.classList?.toggle?.('shell-v2-doorbell-on', Boolean(active));
    if (active) header?.setAttribute?.('data-shell-v2-doorbell-event', active.eventName);
    else header?.removeAttribute?.('data-shell-v2-doorbell-event');
  });
}

function extractDoorbellPayloadText(payload = {}) {
  if (typeof payload === 'string') return payload;
  const candidates = [
    payload.message,
    payload.body,
    payload.content,
    payload.text,
    payload.rawBody,
    payload.raw_body,
    payload.payload?.message,
    payload.payload?.body,
    payload.meta?.message,
    payload.metadata?.message,
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function extractDoorbellMetadata(payload = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const structured = metadata.structured || meta.structured || payload?.structured || {};
  return { ...metadata, ...meta, structured };
}

function detectShellV2PermissionPrompt(data) {
  const text = String(data || '');
  return SHELL_V2_DOORBELL_PERMISSION_PATTERNS.some((pattern) => pattern.test(text));
}

function isShellV2LeadEscalationPayload(payload = {}) {
  const metadata = extractDoorbellMetadata(payload);
  const structuredType = String(metadata.structured?.type || metadata.structuredType || '').trim().toLowerCase();
  const kind = String(metadata.kind || metadata.eventName || metadata.doorbellEvent || '').trim().toLowerCase();
  if (structuredType === 'lead_escalation' || kind === 'lead_escalation') return true;
  const text = extractDoorbellPayloadText(payload);
  return SHELL_V2_LEAD_ESCALATION_PATTERNS.some((pattern) => pattern.test(text));
}

function resolveDoorbellPaneIdFromPayload(payload = {}, fallback = 'squid-room') {
  const metadata = extractDoorbellMetadata(payload);
  const direct = payload.paneId || payload.pane_id || metadata.paneId || metadata.pane_id;
  if (direct) return String(direct);
  const panes = Array.isArray(payload.panes) ? payload.panes : [];
  return panes[0] ? String(panes[0]) : fallback;
}

function resolveDoorbellLabel(doc, paneId) {
  const pane = doc?.querySelector?.(`.pane[data-pane-id="${paneId}"]`);
  return String(
    pane?.dataset?.squidRoomLabel
    || pane?.dataset?.squidRoomRole
    || CORE_STATION_LABELS[paneId]
    || (paneId === '1' ? 'Mira' : '')
    || paneId
  ).trim();
}

function makeDoorbellPayload(doc, options, eventName, detail = {}) {
  const timestampMs = Number.isFinite(Number(detail.timestampMs))
    ? Math.floor(Number(detail.timestampMs))
    : Date.now();
  const paneId = String(detail.paneId || 'squid-room');
  return {
    ...detail,
    paneId,
    label: detail.label || resolveDoorbellLabel(doc, paneId),
    timestampMs,
    sessionId: detail.sessionId || getDoorbellSessionId(doc, options),
    messageId: detail.messageId || makeDoorbellMessageId(eventName, paneId, timestampMs),
  };
}

function createShellV2DoorbellController(doc, windowRef, state = {}, options = {}, refreshToday = null) {
  const doorbell = getShellV2DoorbellState(state);
  const writeJournal = resolveDoorbellJournalWriter(windowRef, options);

  const applyTransition = async (eventName, detail = {}) => {
    const payload = makeDoorbellPayload(doc, options, eventName, detail);
    const result = await transitionDoorbell(doorbell, eventName, payload, { writeJournal });
    if (result?.ok === true && !result.ignored) {
      renderShellV2Doorbell(doc, state);
      if (state.activeTab === 'today' && typeof refreshToday === 'function') {
        await refreshToday({ preserveScroll: true });
      }
    }
    return result;
  };

  const fire = (eventName, detail = {}) => applyTransition(eventName, detail);
  const ack = (detail = {}) => applyTransition(DOORBELL_ACK_EVENT, {
    paneId: 'squid-room',
    displayText: 'acknowledged',
    detail: 'Squid Room doorbell acknowledged',
    ...detail,
  });

  const sources = {
    handlePermissionPrompt: (paneId, data) => {
      if (!detectShellV2PermissionPrompt(data)) return Promise.resolve({ ok: true, ignored: true });
      return fire('permission_prompt', {
        paneId,
        displayText: 'permission',
        detail: 'CLI permission prompt detected',
      });
    },
    handleLeadEscalationMessage: (payload = {}) => {
      if (!isShellV2LeadEscalationPayload(payload)) return Promise.resolve({ ok: true, ignored: true });
      const paneId = resolveDoorbellPaneIdFromPayload(payload, 'trustquote-lead');
      return fire('lead_escalation', {
        paneId,
        displayText: 'lead escalation',
        detail: 'Lead escalation message received',
      });
    },
    handleProcessExit: (paneId, code) => fire('process_exit', {
      paneId,
      displayText: `exited (${code ?? 'unknown'})`,
      detail: `Process exited with code ${code ?? 'unknown'}`,
    }),
  };

  return {
    ack,
    fire,
    render: () => renderShellV2Doorbell(doc, state),
    sources,
  };
}

function bindShellV2DoorbellSources(doc, windowRef, controller, paneIds = [], options = {}) {
  const disposers = [];
  const pty = windowRef?.squidrun?.pty || windowRef?.squidrunAPI?.pty || null;
  const onData = typeof pty?.onData === 'function' ? pty.onData.bind(pty) : null;
  const onExit = typeof pty?.onExit === 'function' ? pty.onExit.bind(pty) : null;
  paneIds.forEach((paneId) => {
    if (onData) {
      const dispose = onData(paneId, (data) => {
        void controller.sources.handlePermissionPrompt(String(paneId), data);
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
    if (onExit) {
      const dispose = onExit(paneId, (code) => {
        void controller.sources.handleProcessExit(String(paneId), code);
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
  });

  const bridge = windowRef?.squidrunAPI || windowRef?.squidrun || {};
  if (typeof bridge.on === 'function') {
    const dispose = bridge.on('inject-message', (payload) => {
      void controller.sources.handleLeadEscalationMessage(payload || {});
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  }

  const onLeadEscalation = (event) => {
    void controller.sources.handleLeadEscalationMessage(event?.detail || {});
  };
  doc?.addEventListener?.('shell-v2-lead-escalation-message', onLeadEscalation);
  disposers.push(() => doc?.removeEventListener?.('shell-v2-lead-escalation-message', onLeadEscalation));

  if (options.enableSourceProbe === true) {
    doc?.body?.setAttribute?.('data-shell-v2-doorbell-source-probe', 'enabled');
    const onSourceProbe = (event) => {
      const detail = event?.detail || {};
      const eventName = String(detail.eventName || '').trim();
      if (eventName === 'permission_prompt') {
        void controller.sources.handlePermissionPrompt(
          String(detail.paneId || '2'),
          detail.data || detail.text || 'Permission prompt: approve this command'
        );
      } else if (eventName === 'lead_escalation') {
        void controller.sources.handleLeadEscalationMessage({
          panes: Array.isArray(detail.panes) ? detail.panes : [detail.paneId || 'trustquote-lead'],
          metadata: {
            ...(detail.metadata && typeof detail.metadata === 'object' ? detail.metadata : {}),
            doorbellEvent: 'lead_escalation',
          },
          rawBody: detail.rawBody || '[LEAD ESCALATION] QA fixture',
        });
      } else if (eventName === 'process_exit') {
        void controller.sources.handleProcessExit(
          String(detail.paneId || '3'),
          detail.code ?? 17
        );
      }
    };
    doc?.addEventListener?.('shell-v2-doorbell-source-probe', onSourceProbe);
    disposers.push(() => {
      doc?.removeEventListener?.('shell-v2-doorbell-source-probe', onSourceProbe);
      doc?.body?.removeAttribute?.('data-shell-v2-doorbell-source-probe');
    });
  }

  return () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch (_) {}
    }
  };
}

function createSettingToggleItem(doc, windowRef, settings, { id, key, label, description }) {
  const item = makeElement(doc, 'div', 'setting-item', {
    title: description,
  });
  const copy = makeElement(doc, 'div', 'setting-copy');
  copy.appendChild(makeElement(doc, 'span', 'setting-label', { textContent: label }));
  copy.appendChild(makeElement(doc, 'span', 'setting-description', { textContent: description }));
  const toggle = makeElement(doc, 'div', 'toggle', {
    id,
    dataset: { setting: key },
    role: 'switch',
    tabindex: '0',
    'aria-label': label,
  });
  const apply = (enabled) => {
    toggle.classList.toggle('active', enabled);
    toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  };
  apply(settings?.[key] === true);
  const run = async () => {
    const next = !toggle.classList.contains('active');
    apply(next);
    const invoke = resolveRendererInvoke(windowRef);
    if (invoke) {
      try {
        await invoke('set-setting', key, next);
      } catch (_) {
        apply(!next);
      }
    }
  };
  toggle.addEventListener?.('click', run);
  toggle.addEventListener?.('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault?.();
      void run();
    }
  });
  item.appendChild(copy);
  item.appendChild(toggle);
  return item;
}

function appendMovedSection(doc, target, source) {
  if (!target || !source) return false;
  appendExisting(target, source);
  source.classList?.add?.('shell-v2-settings-moved-section');
  return true;
}

function createSettingsSectionShell(doc, sectionId, label) {
  const section = makeElement(doc, 'section', 'shell-v2-settings-section', {
    id: `shellV2SettingsSection-${sectionId}`,
    dataset: { shellV2SettingsSection: sectionId },
    'aria-label': label,
  });
  section.dataset.shellV2SettingsSection = sectionId;
  return section;
}

function activateSettingsSection(root, sectionId) {
  if (!root) return;
  const target = String(sectionId || 'general');
  root.dataset.activeSection = target;
  root.querySelectorAll?.('[data-shell-v2-settings-nav]').forEach((button) => {
    const active = button.dataset.shellV2SettingsNav === target;
    button.classList.toggle('active', active);
    button.setAttribute?.('aria-pressed', active ? 'true' : 'false');
  });
  root.querySelectorAll?.('[data-shell-v2-settings-section]').forEach((section) => {
    const active = section.dataset.shellV2SettingsSection === target;
    section.hidden = !active;
    section.setAttribute?.('aria-hidden', active ? 'false' : 'true');
  });
}

function buildShellV2SettingsOverlay(doc, windowRef, settings = {}) {
  if (!doc?.body) return null;
  let overlay = doc.getElementById?.('shellV2SettingsOverlay');
  if (overlay) return overlay;

  overlay = makeElement(doc, 'div', 'shell-v2-settings-overlay', {
    id: 'shellV2SettingsOverlay',
    'aria-hidden': 'true',
  });
  const panel = makeElement(doc, 'div', 'shell-v2-settings-dialog', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Settings',
  });
  const nav = makeElement(doc, 'nav', 'shell-v2-settings-nav', {
    'aria-label': 'Settings sections',
  });
  const content = makeElement(doc, 'div', 'shell-v2-settings-content');

  SHELL_V2_SETTINGS_SECTIONS.forEach(([sectionId, label]) => {
    const button = makeElement(doc, 'button', 'shell-v2-settings-nav-item', {
      type: 'button',
      textContent: label,
      dataset: { shellV2SettingsNav: sectionId },
      'aria-pressed': 'false',
    });
    button.dataset.shellV2SettingsNav = sectionId;
    button.addEventListener?.('click', () => activateSettingsSection(overlay, sectionId));
    nav.appendChild(button);
    content.appendChild(createSettingsSectionShell(doc, sectionId, label));
  });

  const close = makeElement(doc, 'button', 'shell-v2-settings-close', {
    type: 'button',
    textContent: 'Close',
    'aria-label': 'Close settings',
  });
  close.addEventListener?.('click', () => {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.__previousFocus?.focus?.({ preventScroll: true });
  });

  const general = findSettingsSectionByTitle(doc, /^General$/i);
  const permissions = findSettingsSectionByTitle(doc, /^Permissions$/i);
  const voice = findSettingsSectionByTitle(doc, /^Voice/i);
  const cost = findSettingsSectionByTitle(doc, /^Cost/i);
  const devices = findSettingsSectionByTitle(doc, /^Devices$/i);

  appendMovedSection(doc, content.querySelector('[data-shell-v2-settings-section="general"]'), general);
  appendMovedSection(doc, content.querySelector('[data-shell-v2-settings-section="permissions"]'), permissions);
  appendMovedSection(doc, content.querySelector('[data-shell-v2-settings-section="cost"]'), cost);
  appendMovedSection(doc, content.querySelector('[data-shell-v2-settings-section="devices"]'), devices);

  const generalTarget = content.querySelector('[data-shell-v2-settings-section="general"]');
  if (generalTarget) {
    const developer = makeElement(doc, 'div', 'shell-v2-settings-developer');
    developer.appendChild(makeElement(doc, 'div', 'settings-section-title', { textContent: 'Developer' }));
    const devToolsItem = doc.getElementById?.('toggleDevTools')?.closest?.('.setting-item');
    if (devToolsItem) appendExisting(developer, devToolsItem);
    developer.appendChild(createSettingToggleItem(doc, windowRef, settings, {
      id: 'toggleDevMode',
      key: 'devMode',
      label: 'Mira Lab tab',
      description: 'Show the developer-gated Lab tab in the Shell V2 rail.',
    }));
    generalTarget.appendChild(developer);
  }

  const voiceTarget = content.querySelector('[data-shell-v2-settings-section="voice"]');
  appendMovedSection(doc, voiceTarget, voice);
  const voiceTab = doc.getElementById?.('tab-voice');
  if (voiceTarget && voiceTab) {
    [...(voiceTab.children || [])].forEach((child) => appendExisting(voiceTarget, child));
  }

  const secretsTarget = content.querySelector('[data-shell-v2-settings-section="secrets"]');
  const secretsTab = doc.getElementById?.('tab-api-keys');
  if (secretsTarget && secretsTab) {
    [...(secretsTab.children || [])].forEach((child) => appendExisting(secretsTarget, child));
  }

  const profileTarget = content.querySelector('[data-shell-v2-settings-section="profile"]');
  const profileSubtitle = doc.getElementById?.('profileModalSubtitle');
  const profileForm = doc.getElementById?.('profileModalForm');
  if (profileTarget) {
    if (profileSubtitle) appendExisting(profileTarget, profileSubtitle);
    if (profileForm) appendExisting(profileTarget, profileForm);
  }

  panel.appendChild(nav);
  panel.appendChild(content);
  panel.appendChild(close);
  overlay.appendChild(panel);
  doc.body.appendChild(overlay);
  activateSettingsSection(overlay, 'general');
  return overlay;
}

function openShellV2SettingsOverlay(doc, overlay, sectionId = 'general') {
  if (!overlay) return false;
  overlay.__previousFocus = doc.activeElement || null;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  activateSettingsSection(overlay, sectionId);
  overlay.querySelector?.(`[data-shell-v2-settings-nav="${sectionId}"]`)?.focus?.({ preventScroll: true });
  return true;
}

function bindShellV2SettingsOverlay(doc, overlay, windowRef) {
  if (!doc || !overlay || overlay.dataset.bound === 'true') return;
  const settingsBtn = doc.getElementById?.('settingsBtn');
  settingsBtn?.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    openShellV2SettingsOverlay(doc, overlay, overlay.dataset.activeSection || 'general');
  }, true);
  doc.addEventListener?.('shell-v2-open-settings', (event) => {
    openShellV2SettingsOverlay(doc, overlay, event?.detail?.section || 'general');
  });
  doc.addEventListener?.('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === ',') {
      event.preventDefault?.();
      openShellV2SettingsOverlay(doc, overlay, overlay.dataset.activeSection || 'general');
      return;
    }
    if (event.key === 'Escape' && overlay.classList.contains('open')) {
      event.preventDefault?.();
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.__previousFocus?.focus?.({ preventScroll: true });
    }
  }, true);
  overlay.addEventListener?.('click', (event) => {
    if (event.target === overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.__previousFocus?.focus?.({ preventScroll: true });
    }
  });
  overlay.dataset.bound = 'true';
}

function migrateShellV2Settings(doc, windowRef, settings = {}) {
  const overlay = buildShellV2SettingsOverlay(doc, windowRef, settings);
  bindShellV2SettingsOverlay(doc, overlay, windowRef);
  const settingsPanel = doc.getElementById?.('settingsPanel');
  if (settingsPanel) removeElement(settingsPanel);
  return overlay;
}

function removeShellV2KilledChrome(doc) {
  [
    'selectProjectBtn',
    'profileBtn',
    'openHumanTimelineBtn',
    'openSquidRoomBtn',
    'openMiraLabBtn',
    'panelBtn',
  ].forEach((id) => removeElement(doc.getElementById?.(id)));

  const rightPanel = doc.getElementById?.('rightPanel');
  if (rightPanel) removeElement(rightPanel);
}

function resolveScreenshotApi(windowRef = null) {
  const bridge = windowRef?.squidrun || windowRef?.squidrunAPI || {};
  const screenshot = bridge.screenshot || {};
  if (typeof screenshot.save === 'function' || typeof screenshot.list === 'function') {
    return screenshot;
  }
  const invoke = resolveRendererInvoke(windowRef);
  if (!invoke) return {};
  return {
    save: (base64Data, originalName) => invoke('save-screenshot', base64Data, originalName),
    list: (options = null) => invoke('list-screenshots', options),
  };
}

function toFileUrl(filePath) {
  if (!filePath) return '';
  const normalized = String(filePath).replace(/\\/g, '/');
  return `file://${encodeURI(normalized)}`;
}

function renderScreenshotDrawerList(doc, drawer, files = []) {
  const list = drawer?.querySelector?.('[data-shell-v2-screenshots-list="true"]');
  if (!list) return;
  clearElement(list);
  if (!Array.isArray(files) || files.length === 0) {
    list.appendChild(makeElement(doc, 'div', 'shell-v2-screenshots-empty', {
      textContent: 'No screenshots yet',
    }));
    return;
  }
  files.slice(0, 40).forEach((file) => {
    const item = makeElement(doc, 'div', 'shell-v2-screenshot-item');
    item.appendChild(makeElement(doc, 'img', 'shell-v2-screenshot-thumb', {
      src: toFileUrl(file.path),
      alt: file.name || 'screenshot',
    }));
    item.appendChild(makeElement(doc, 'span', 'shell-v2-screenshot-name', {
      textContent: file.name || '',
    }));
    list.appendChild(item);
  });
}

async function openScreenshotsDrawer(doc, drawer, windowRef) {
  if (!drawer) return false;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  const api = resolveScreenshotApi(windowRef);
  if (typeof api.list === 'function') {
    try {
      const result = await api.list({ limit: 40 });
      if (result?.success) renderScreenshotDrawerList(doc, drawer, result.files || []);
    } catch (_) {}
  }
  return true;
}

function addMiraAttachmentChip(doc, tray, result = {}) {
  if (!tray) return null;
  tray.hidden = false;
  tray.setAttribute?.('aria-hidden', 'false');
  const chip = makeElement(doc, 'span', 'shell-v2-mira-attachment-chip', {
    dataset: {
      shellV2MiraAttachment: 'true',
      path: result.path || '',
      filename: result.filename || '',
    },
    textContent: result.filename || 'image attached',
  });
  chip.dataset.shellV2MiraAttachment = 'true';
  chip.dataset.path = result.path || '';
  chip.dataset.filename = result.filename || '';
  tray.appendChild(chip);
  return chip;
}

function saveMiraAttachmentFile(doc, windowRef, tray, file) {
  if (!file || !String(file.type || '').startsWith('image/')) return false;
  const api = resolveScreenshotApi(windowRef);
  if (typeof api.save !== 'function') return false;
  const Reader = windowRef?.FileReader || (typeof FileReader !== 'undefined' ? FileReader : null);
  if (!Reader) return false;
  const reader = new Reader();
  reader.onload = async (event) => {
    const base64Data = event?.target?.result;
    if (!base64Data) return;
    const result = await api.save(base64Data, file.name || 'mira-attachment.png');
    if (result?.success !== false) {
      addMiraAttachmentChip(doc, tray, result || {});
    }
    reader.onload = null;
  };
  reader.readAsDataURL(file);
  return true;
}

function ensureMiraScreenshotAffordances(doc, view, windowRef, state = {}) {
  if (!doc || !view) return;
  const commandBar = view.querySelector?.('.command-bar');
  let tray = doc.getElementById?.('shellV2MiraAttachmentTray');
  if (!tray) {
    tray = makeElement(doc, 'div', 'shell-v2-mira-attachment-tray', {
      id: 'shellV2MiraAttachmentTray',
      hidden: 'true',
      'aria-hidden': 'true',
    });
    if (commandBar?.parentNode) {
      commandBar.parentNode.insertBefore(tray, commandBar);
    } else {
      view.appendChild(tray);
    }
  }

  let drawer = doc.getElementById?.('shellV2ScreenshotsDrawer');
  if (!drawer) {
    drawer = makeElement(doc, 'aside', 'shell-v2-screenshots-drawer', {
      id: 'shellV2ScreenshotsDrawer',
      'aria-hidden': 'true',
    });
    const header = makeElement(doc, 'div', 'shell-v2-screenshots-drawer-header');
    header.appendChild(makeElement(doc, 'span', 'shell-v2-screenshots-title', {
      textContent: 'Screenshots',
    }));
    const close = makeElement(doc, 'button', 'shell-v2-screenshots-close', {
      type: 'button',
      textContent: 'Close',
      'aria-label': 'Close screenshots gallery',
    });
    close.addEventListener?.('click', () => {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    });
    header.appendChild(close);
    drawer.appendChild(header);
    drawer.appendChild(makeElement(doc, 'div', 'shell-v2-screenshots-list', {
      dataset: { shellV2ScreenshotsList: 'true' },
    }));
    view.appendChild(drawer);
  }

  if (state.miraDropBound === true) return;
  const openHandler = (event) => {
    event.preventDefault?.();
    void openScreenshotsDrawer(doc, drawer, windowRef);
  };
  doc.addEventListener?.('shell-v2-open-screenshots', openHandler);
  view.addEventListener?.('dragover', (event) => {
    event.preventDefault?.();
    view.classList.add('shell-v2-mira-dragover');
  });
  view.addEventListener?.('dragleave', () => {
    view.classList.remove('shell-v2-mira-dragover');
  });
  view.addEventListener?.('drop', (event) => {
    event.preventDefault?.();
    view.classList.remove('shell-v2-mira-dragover');
    const files = [...(event.dataTransfer?.files || [])];
    files.forEach((file) => saveMiraAttachmentFile(doc, windowRef, tray, file));
  });
  state.miraDropBound = true;
}

function purgeLegacyPaneExpandButtons(sidePanesContainer) {
  sidePanesContainer?.querySelectorAll?.('.expand-btn').forEach((button) => {
    if (shouldHandleCoreExpand(button)) removeElement(button);
  });
}

function appendStationControl(panel, control) {
  if (!panel || !control) return null;
  return appendExisting(panel, showShellElement(control));
}

function rebuildCoreStationHeader(doc, pane, paneId, settings = {}) {
  if (!doc || !pane || !paneId) return;
  const header = pane.querySelector?.('.pane-header');
  if (!header) return;

  pane.classList?.add?.('shell-v2-station');
  header.classList?.add?.('shell-v2-station-header');
  pane.querySelectorAll?.('.agent-badge').forEach((badge) => removeElement(badge));
  pane.querySelectorAll?.('.expand-btn').forEach((button) => removeElement(button));

  if (header.dataset.shellV2Reduced === 'true') {
    const chipBadge = doc.getElementById?.(`cli-badge-${paneId}`);
    if (chipBadge && !String(chipBadge.textContent || '').trim()) {
      chipBadge.textContent = resolvePaneModelLabel(doc, paneId, settings);
    }
    return;
  }

  const roleLabel = CORE_STATION_LABELS[paneId] || `Pane ${paneId}`;
  const modelLabel = resolvePaneModelLabel(doc, paneId, settings);
  const cliBadge = doc.getElementById?.(`cli-badge-${paneId}`);
  if (cliBadge && !String(cliBadge.textContent || '').trim()) {
    cliBadge.textContent = modelLabel;
  }
  cliBadge?.classList?.add?.('visible');

  const chip = makeElement(doc, 'span', 'shell-v2-station-chip', {
    dataset: { paneId },
  });
  chip.dataset.paneId = paneId;
  chip.appendChild(makeElement(doc, 'span', 'shell-v2-station-role', {
    textContent: roleLabel,
  }));
  appendStationSeparator(doc, chip);
  if (cliBadge) {
    chip.appendChild(cliBadge);
  } else {
    chip.appendChild(makeElement(doc, 'span', 'cli-badge visible', {
      id: `cli-badge-${paneId}`,
      textContent: modelLabel,
    }));
  }

  const needsInput = makeDoorbellSlot(doc, paneId, roleLabel);

  const menu = makeElement(doc, 'details', 'shell-v2-station-menu', {
    dataset: { paneId },
  });
  menu.dataset.paneId = paneId;
  const trigger = makeElement(doc, 'summary', 'shell-v2-station-menu-trigger', {
    textContent: '...',
    'aria-label': `${roleLabel} station controls`,
    dataset: { tooltip: `${roleLabel} controls` },
  });
  trigger.dataset.tooltip = `${roleLabel} controls`;
  const panel = makeElement(doc, 'div', 'shell-v2-station-menu-panel', {
    'aria-label': `${roleLabel} station controls`,
  });

  const controls = [
    pane.querySelector?.(`.pane-role-info-btn[data-pane-id="${paneId}"]`),
    doc.getElementById?.(`model-selector-${paneId}`),
    pane.querySelector?.(`.fresh-session-btn[data-pane-id="${paneId}"]`),
    doc.getElementById?.(`health-${paneId}`),
    pane.querySelector?.(`.interrupt-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.unstick-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.kickoff-btn[data-pane-id="${paneId}"]`),
    doc.getElementById?.(`lock-icon-${paneId}`),
  ];
  controls.forEach((control) => appendStationControl(panel, control));
  menu.appendChild(trigger);
  menu.appendChild(panel);

  clearElement(header);
  header.appendChild(chip);
  header.appendChild(needsInput);
  header.appendChild(menu);
  header.dataset.shellV2Reduced = 'true';
}

function rebuildMiraStationHeader(doc, pane, settings = {}) {
  if (!doc || !pane) return;
  const paneId = '1';
  const header = pane.querySelector?.('.pane-header');
  if (!header) return;

  pane.classList?.add?.('shell-v2-station', 'shell-v2-mira-station');
  header.classList?.add?.('shell-v2-station-header');
  pane.querySelectorAll?.('.agent-badge').forEach((badge) => removeElement(badge));
  pane.querySelectorAll?.('.expand-btn').forEach((button) => removeElement(button));
  if (header.dataset.shellV2Reduced === 'true') return;

  const modelLabel = resolvePaneModelLabel(doc, paneId, settings);
  const cliBadge = doc.getElementById?.(`cli-badge-${paneId}`);
  if (cliBadge && !String(cliBadge.textContent || '').trim()) {
    cliBadge.textContent = modelLabel;
  }
  cliBadge?.classList?.add?.('visible');

  const chip = makeElement(doc, 'span', 'shell-v2-station-chip', {
    dataset: { paneId },
  });
  chip.dataset.paneId = paneId;
  chip.appendChild(makeElement(doc, 'span', 'shell-v2-station-role', {
    textContent: 'Mira',
  }));
  appendStationSeparator(doc, chip);
  if (cliBadge) {
    chip.appendChild(cliBadge);
  } else {
    chip.appendChild(makeElement(doc, 'span', 'cli-badge visible', {
      id: `cli-badge-${paneId}`,
      textContent: modelLabel,
    }));
  }

  const needsInput = makeDoorbellSlot(doc, paneId, 'Mira');

  const menu = makeElement(doc, 'details', 'shell-v2-station-menu shell-v2-mira-menu', {
    dataset: { paneId },
  });
  menu.dataset.paneId = paneId;
  const trigger = makeElement(doc, 'summary', 'shell-v2-station-menu-trigger', {
    textContent: '...',
    'aria-label': 'Mira station controls',
    dataset: { tooltip: 'Mira controls' },
  });
  const panel = makeElement(doc, 'div', 'shell-v2-station-menu-panel', {
    'aria-label': 'Mira station controls',
  });
  [
    pane.querySelector?.(`.pane-role-info-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.fresh-session-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.interrupt-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.unstick-btn[data-pane-id="${paneId}"]`),
    pane.querySelector?.(`.kickoff-btn[data-pane-id="${paneId}"]`),
  ].forEach((control) => appendStationControl(panel, control));
  menu.appendChild(trigger);
  menu.appendChild(panel);

  clearElement(header);
  header.appendChild(chip);
  header.appendChild(needsInput);
  header.appendChild(menu);
  header.dataset.shellV2Reduced = 'true';
}

function reduceCoreStationHeaders(doc, sidePanesContainer, settings = {}) {
  CORE_STATION_PANE_IDS.forEach((paneId) => {
    const pane = sidePanesContainer?.querySelector?.(`.pane[data-pane-id="${paneId}"]`);
    rebuildCoreStationHeader(doc, pane, paneId, settings);
  });
}

function configureShellV2ArmRuntime(terminalApi = {}, options = {}) {
  if (typeof terminalApi.setActivePaneIds === 'function') {
    const current = typeof terminalApi.getActivePaneIds === 'function'
      ? terminalApi.getActivePaneIds()
      : [];
    terminalApi.setActivePaneIds([
      ...new Set([
        ...(Array.isArray(current) && current.length > 0 ? current : ['1', ...CORE_STATION_PANE_IDS]),
        ...SHELL_V2_ACTIVE_PANE_IDS,
      ]),
    ]);
  }
  if (typeof workspacePaneShell.configureSquidRoomRuntimeOverrides === 'function') {
    workspacePaneShell.configureSquidRoomRuntimeOverrides(terminalApi, TRUSTQUOTE_ARM_PANES, {
      skipStartupInjection: options.skipStartupInjection === true,
      spawnCommandOnCreate: options.spawnCommandOnCreate !== false,
    });
  }
}

function makeArmControlMenu(doc, spec, command) {
  const menu = makeElement(doc, 'details', 'shell-v2-station-menu shell-v2-arm-menu', {
    dataset: { paneId: spec.paneId },
  });
  menu.dataset.paneId = spec.paneId;
  const trigger = makeElement(doc, 'summary', 'shell-v2-station-menu-trigger', {
    textContent: '...',
    'aria-label': `${spec.label} controls`,
  });
  const panel = makeElement(doc, 'div', 'shell-v2-station-menu-panel', {
    'aria-label': `${spec.label} controls`,
  });
  [
    makeModelSelector(doc, spec.paneId, command),
    makeControlButton(doc, 'fresh-session-btn', spec.paneId, 'Fresh session'),
    makeElement(doc, 'span', 'agent-health', { id: `health-${spec.paneId}`, textContent: '-' }),
    makeControlButton(doc, 'interrupt-btn', spec.paneId, 'Interrupt'),
    makeControlButton(doc, 'unstick-btn', spec.paneId, 'Enter'),
    makeControlButton(doc, 'kickoff-btn', spec.paneId, 'Restart agent'),
    makeElement(doc, 'button', 'pane-role-info-btn', {
      type: 'button',
      textContent: 'Role info',
      dataset: { paneId: spec.paneId },
      title: 'Show role bundle',
    }),
    makeElement(doc, 'span', 'lock-icon', {
      id: `lock-icon-${spec.paneId}`,
      textContent: 'Locked',
      dataset: { paneId: spec.paneId, tooltip: 'Locked (click to toggle)' },
    }),
  ].forEach((control) => appendStationControl(panel, control));
  menu.appendChild(trigger);
  menu.appendChild(panel);
  return menu;
}

function ensureArmPane(doc, spec, settings = {}) {
  const command = resolvePaneCommand(settings, spec.paneId, spec.command || '');
  const model = detectModelFamily(command) || 'codex';
  let pane = doc.querySelector?.(`.pane[data-pane-id="${spec.paneId}"]`);
  if (!pane) {
    pane = makeElement(doc, 'div', 'pane shell-v2-arm-pane', {
      dataset: {
        paneId: spec.paneId,
        squidRoomLivePane: 'true',
      },
    });
  }

  pane.classList?.add?.('shell-v2-arm-pane');
  pane.dataset.paneId = spec.paneId;
  pane.dataset.squidRoomLivePane = 'true';
  pane.dataset.squidRoomLabel = spec.label;
  pane.dataset.squidRoomRole = spec.role;
  pane.dataset.squidRoomRoleId = spec.roleId || spec.routeTarget || spec.paneId;
  pane.dataset.squidRoomRouteTarget = spec.routeTarget || spec.paneId;
  pane.dataset.squidRoomWorkingDir = spec.workingDir;
  pane.dataset.squidRoomCommand = command;
  pane.dataset.squidRoomCommandSourcePaneId = spec.commandSourcePaneId;
  pane.dataset.squidRoomStartupMessage = spec.startupMessage || '';
  pane.dataset.cli = model;

  if (!pane.querySelector?.('.pane-header')) {
    const header = makeElement(doc, 'div', 'pane-header shell-v2-arm-header');
    const title = makeElement(doc, 'span', 'shell-v2-arm-title');
    title.appendChild(makeElement(doc, 'span', 'shell-v2-arm-role', {
      textContent: spec.label,
    }));
    appendStationSeparator(doc, title);
    title.appendChild(makeElement(doc, 'span', `cli-badge visible ${model}`, {
      id: `cli-badge-${spec.paneId}`,
      textContent: titleCase(model),
    }));
    title.appendChild(makeElement(doc, 'span', 'pane-project', {
      id: `project-${spec.paneId}`,
    }));
    title.appendChild(makeElement(doc, 'span', 'agent-task', {
      id: `task-${spec.paneId}`,
    }));
    header.appendChild(title);
    header.appendChild(makeDoorbellSlot(doc, spec.paneId, spec.label));
    header.appendChild(makeArmControlMenu(doc, spec, command));
    pane.appendChild(header);
  }
  const header = pane.querySelector?.('.pane-header');
  if (header && !header.querySelector?.('[data-shell-v2-doorbell-slot="true"]')) {
    const menu = header.querySelector?.('.shell-v2-arm-menu');
    header.insertBefore(makeDoorbellSlot(doc, spec.paneId, spec.label), menu || null);
  }
  if (!pane.querySelector?.(`#terminal-${spec.paneId}`)) {
    pane.appendChild(makeElement(doc, 'div', 'pane-terminal', {
      id: `terminal-${spec.paneId}`,
    }));
  }
  if (!pane.querySelector?.(`#status-${spec.paneId}`)) {
    pane.appendChild(makeElement(doc, 'span', '', {
      id: `status-${spec.paneId}`,
    }));
  }
  return pane;
}

function isInteractiveTarget(target) {
  let cursor = target || null;
  while (cursor) {
    const tag = String(cursor.tagName || '').toUpperCase();
    if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'SUMMARY', 'A'].includes(tag)) return true;
    if (cursor.classList?.contains?.('shell-v2-station-menu')) return true;
    cursor = cursor.parentNode;
  }
  return false;
}

function updateArmPaneFocus(section, selectedPaneId, zoomPaneId = null) {
  section.dataset.shellV2SelectedPaneId = selectedPaneId || '';
  section.dataset.shellV2ZoomPaneId = zoomPaneId || '';
  section.classList.toggle('has-temp-zoom', Boolean(zoomPaneId));
  section.querySelectorAll?.('.shell-v2-arm-pane').forEach((pane) => {
    const paneId = String(pane.dataset?.paneId || '');
    const selected = paneId === selectedPaneId;
    const zoomed = paneId === zoomPaneId;
    pane.classList.toggle('is-main-slot', selected);
    pane.classList.toggle('is-neighbor', Boolean(selectedPaneId) && !selected);
    pane.classList.toggle('is-temp-zoom', zoomed);
  });
}

function setArmSectionExpanded(section, expanded) {
  const next = Boolean(expanded);
  section.dataset.shellV2Expanded = next ? 'true' : 'false';
  section.classList.toggle('is-collapsed', !next);
  const button = section.querySelector?.('.shell-v2-arm-section-toggle');
  button?.setAttribute?.('aria-expanded', next ? 'true' : 'false');
  const panel = section.querySelector?.('.shell-v2-arm-panes');
  if (panel) {
    panel.hidden = !next;
    panel.setAttribute?.('aria-hidden', next ? 'false' : 'true');
  }
}

function ensureLeadReportElement(doc, header) {
  if (!doc || !header) return null;
  let report = header.querySelector?.('[data-shell-v2-lead-report="trustquote-lead"]')
    || header.querySelector?.('#shellV2TrustQuoteLeadReport');
  if (!report) {
    report = makeElement(doc, 'span', 'shell-v2-arm-section-report shell-v2-arm-section-lead-report', {
      id: 'shellV2TrustQuoteLeadReport',
      dataset: { shellV2LeadReport: 'trustquote-lead' },
      textContent: '',
    });
    header.appendChild(report);
  }
  ensureClass(report, 'shell-v2-arm-section-report');
  ensureClass(report, 'shell-v2-arm-section-lead-report');
  report.dataset.shellV2LeadReport = 'trustquote-lead';
  report.setAttribute?.('aria-label', 'Lead last report');
  return report;
}

function ensureTrustQuoteArmSection(doc, parent, terminalApi = {}, state = {}, settings = {}) {
  if (!doc || !parent || TRUSTQUOTE_ARM_PANES.length === 0) return null;
  state.armSections = state.armSections || {};
  const sectionState = state.armSections[TRUSTQUOTE_APP_ID] || {
    expanded: true,
    selectedPaneId: TRUSTQUOTE_ARM_PANES[0]?.paneId || '',
    zoomPaneId: '',
  };
  state.armSections[TRUSTQUOTE_APP_ID] = sectionState;

  let section = doc.getElementById?.('shellV2TrustQuoteSection');
  if (!section) {
    section = makeElement(doc, 'section', 'shell-v2-arm-section', {
      id: 'shellV2TrustQuoteSection',
      dataset: { shellV2ArmApp: TRUSTQUOTE_APP_ID },
      'aria-label': 'TrustQuote arms',
    });
    const header = makeElement(doc, 'div', 'shell-v2-arm-section-header');
    const toggle = makeElement(doc, 'button', 'shell-v2-arm-section-toggle', {
      type: 'button',
      'aria-expanded': 'true',
    });
    toggle.appendChild(makeElement(doc, 'span', 'shell-v2-arm-section-app', {
      textContent: 'TrustQuote',
    }));
    toggle.appendChild(makeElement(doc, 'span', 'shell-v2-arm-section-lead', {
      textContent: 'Lead',
    }));
    toggle.appendChild(makeElement(doc, 'span', 'shell-v2-arm-section-count', {
      textContent: `${TRUSTQUOTE_ARM_PANES.length} arms`,
    }));
    header.appendChild(toggle);
    ensureLeadReportElement(doc, header);
    const panes = makeElement(doc, 'div', 'shell-v2-arm-panes', {
      id: 'shellV2TrustQuoteArmPanes',
    });
    section.appendChild(header);
    section.appendChild(panes);
    parent.appendChild(section);
  }

  section.dataset.shellV2ArmApp = TRUSTQUOTE_APP_ID;
  ensureLeadReportElement(doc, section.querySelector?.('.shell-v2-arm-section-header'));
  const panes = section.querySelector?.('.shell-v2-arm-panes');
  TRUSTQUOTE_ARM_PANES.forEach((spec) => {
    appendExisting(panes, ensureArmPane(doc, spec, settings));
  });

  if (section.dataset.shellV2Bound !== 'true') {
    section.querySelector?.('.shell-v2-arm-section-toggle')?.addEventListener?.('click', () => {
      sectionState.expanded = section.dataset.shellV2Expanded !== 'true';
      setArmSectionExpanded(section, sectionState.expanded);
      if (sectionState.expanded) {
        scheduleArmRevealRefit(terminalApi, doc.defaultView || null);
      } else {
        scheduleRefit(terminalApi, doc.defaultView || null);
      }
    });
    section.addEventListener?.('click', (event) => {
      if (isInteractiveTarget(event.target)) return;
      const pane = event.target?.closest?.('.shell-v2-arm-pane');
      if (!pane || !section.contains?.(pane)) return;
      sectionState.selectedPaneId = String(pane.dataset?.paneId || '');
      updateArmPaneFocus(section, sectionState.selectedPaneId, sectionState.zoomPaneId);
      terminalApi.focusPane?.(sectionState.selectedPaneId);
      scheduleRefit(terminalApi, doc.defaultView || null);
    });
    section.addEventListener?.('dblclick', (event) => {
      if (isInteractiveTarget(event.target)) return;
      const pane = event.target?.closest?.('.shell-v2-arm-pane');
      if (!pane || !section.contains?.(pane)) return;
      sectionState.selectedPaneId = String(pane.dataset?.paneId || '');
      sectionState.zoomPaneId = sectionState.selectedPaneId;
      updateArmPaneFocus(section, sectionState.selectedPaneId, sectionState.zoomPaneId);
      terminalApi.focusPane?.(sectionState.selectedPaneId);
      scheduleRefit(terminalApi, doc.defaultView || null);
    });
    section.dataset.shellV2Bound = 'true';
  }

  setArmSectionExpanded(section, sectionState.expanded);
  updateArmPaneFocus(section, sectionState.selectedPaneId, sectionState.zoomPaneId);
  return section;
}

function clearArmZoom(state = {}, doc = null, terminalApi = {}) {
  const sectionState = state.armSections?.[TRUSTQUOTE_APP_ID];
  if (!sectionState?.zoomPaneId) return false;
  sectionState.zoomPaneId = '';
  const section = doc?.getElementById?.('shellV2TrustQuoteSection');
  if (section) updateArmPaneFocus(section, sectionState.selectedPaneId, '');
  scheduleRefit(terminalApi, doc?.defaultView || null);
  return true;
}

function ensureSquidRoomFloor(doc, views, coreStrip, terminalApi = {}, state = {}, settings = {}, options = {}) {
  reduceCoreStationHeaders(doc, coreStrip?.querySelector?.('.side-panes-container'), settings);
  const gateProfile = isShellV2GateProfile(options.windowContext, options.env);
  configureShellV2ArmRuntime(terminalApi, {
    skipStartupInjection: gateProfile,
    spawnCommandOnCreate: !gateProfile,
  });
  ensureTrustQuoteArmSection(doc, views?.['squid-room'], terminalApi, state, settings);
}

function scheduleRefit(terminalApi = {}, windowRef = null) {
  const resize = typeof terminalApi.handleResize === 'function'
    ? terminalApi.handleResize.bind(terminalApi)
    : null;
  if (!resize) return;

  resize();
  const requestFrame = typeof windowRef?.requestAnimationFrame === 'function'
    ? windowRef.requestAnimationFrame.bind(windowRef)
    : (fn) => setTimeout(fn, 0);
  requestFrame(() => resize());
  setTimeout(() => resize(), 120);
}

function refreshTrustQuoteArmPanes(terminalApi = {}) {
  let refreshed = 0;
  const refreshPane = typeof terminalApi.refreshPane === 'function'
    ? terminalApi.refreshPane.bind(terminalApi)
    : null;
  const refreshTerminalViewport = typeof terminalApi._internals?.refreshTerminalViewport === 'function'
    ? terminalApi._internals.refreshTerminalViewport
    : null;

  for (const paneId of TRUSTQUOTE_ARM_PANE_IDS) {
    const options = {
      operation: 'shell_v2_arm_reveal',
      forceFit: true,
      forceApply: true,
      scrollToBottom: true,
      resumeRender: true,
      replayDaemonScrollback: true,
      clear: true,
      snapshotTimeoutMs: 1500,
    };
    if (refreshPane) {
      if (refreshPane(paneId, options) !== false) refreshed += 1;
      continue;
    }
    if (refreshTerminalViewport && typeof terminalApi.getTerminal === 'function') {
      const terminal = terminalApi.getTerminal(paneId);
      const fitAddon = terminalApi.fitAddons?.get?.(paneId) || null;
      if (terminal) {
        refreshTerminalViewport(paneId, terminal, fitAddon, options);
        refreshed += 1;
      }
    }
  }
  return refreshed;
}

function scheduleArmRevealRefit(terminalApi = {}, windowRef = null) {
  scheduleRefit(terminalApi, windowRef);
  const requestFrame = typeof windowRef?.requestAnimationFrame === 'function'
    ? windowRef.requestAnimationFrame.bind(windowRef)
    : (fn) => setTimeout(fn, 0);
  const refresh = () => refreshTrustQuoteArmPanes(terminalApi);
  refresh();
  requestFrame(refresh);
  setTimeout(refresh, 120);
  setTimeout(refresh, 320);
}

function dispatchShellEvent(doc, activeTab) {
  if (typeof doc?.dispatchEvent !== 'function') return;
  try {
    const CustomEventCtor = doc.defaultView?.CustomEvent
      || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
    if (typeof CustomEventCtor === 'function') {
      doc.dispatchEvent(new CustomEventCtor('shell-v2-tab-activated', {
        detail: { activeTab },
      }));
    }
  } catch (_) {}
}

function updateTabState(doc, body, rail, views, activeTab, tabs = SHELL_V2_TABS) {
  body.dataset.shellV2ActiveTab = activeTab;
  tabs.forEach((tab) => {
    const isActive = tab.id === activeTab;
    const button = rail.querySelector?.(`[data-shell-v2-tab="${tab.id}"]`);
    if (button) {
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    }

    const view = views[tab.id];
    if (view) {
      view.dataset.shellV2Active = isActive ? 'true' : 'false';
      view.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    }
  });
  dispatchShellEvent(doc, activeTab);
}

function resolveShortcutTab(event, tabs = SHELL_V2_TABS) {
  if (!event?.ctrlKey || event.altKey || event.metaKey) return null;
  const key = String(event.key || '');
  const tab = tabs.find((candidate) => candidate.shortcut === key);
  return tab?.id || null;
}

function resolveShortcutPane(event) {
  if (!event?.altKey || event.ctrlKey || event.metaKey) return null;
  return SHELL_V2_PANE_SHORTCUTS[String(event.key || '')] || null;
}

function blurActivePaneTerminal(doc, terminalApi) {
  const active = doc?.activeElement;
  const isPaneTerminalFocus = Boolean(
    active?.closest?.('.pane-terminal')
      || active?.closest?.('.xterm')
      || active?.closest?.('.xterm-helper-textarea')
  );
  if (!isPaneTerminalFocus) return;
  try {
    terminalApi?.blurAllTerminals?.();
  } catch (_) {}
  try {
    active.blur?.();
  } catch (_) {}
  if (doc.activeElement === active) {
    try {
      doc.body?.focus?.();
    } catch (_) {}
  }
}

function shouldHandleCoreExpand(button) {
  const paneId = String(button?.dataset?.paneId || '');
  return paneId === '2' || paneId === '3';
}

function initShellV2(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const windowRef = options.window || (typeof window !== 'undefined' ? window : null);
  if (!doc) return { enabled: false, reason: 'document_unavailable' };

  const existing = stateByDocument.get(doc);
  if (existing) {
    existing.controller.refreshChrome?.();
    return existing.controller;
  }

  const enabled = resolveShellV2Enabled(options.settings || {}, options.env || {}, options.windowContext || {});
  if (!enabled) return { enabled: false, reason: 'disabled' };
  const gateProfile = isShellV2GateProfile(options.windowContext || {}, options.env || {});

  const required = getRequiredElements(doc);
  if (!required) return { enabled: false, reason: 'missing_required_elements' };

  const state = {
    activeTab: options.defaultTab || 'mira',
    coreExpanded: false,
    today: createTodayState(),
    doorbell: createDoorbellState(),
  };
  const shellTabs = getShellV2Tabs(options.settings || {});
  if (!shellTabs.some((tab) => tab.id === state.activeTab)) {
    state.activeTab = 'mira';
  }
  let todayRefreshTimer = null;

  const refreshToday = (refreshOptions = {}) => refreshShellV2Today(
    doc,
    views?.today,
    windowRef,
    state,
    options,
    refreshOptions
  );
  const doorbellController = createShellV2DoorbellController(
    doc,
    windowRef,
    state,
    options,
    refreshToday
  );

  const stopTodayPolling = () => {
    if (!todayRefreshTimer) return;
    const clearTimer = typeof windowRef?.clearInterval === 'function'
      ? windowRef.clearInterval.bind(windowRef)
      : clearInterval;
    clearTimer(todayRefreshTimer);
    todayRefreshTimer = null;
  };

  const startTodayPolling = () => {
    if (todayRefreshTimer) return;
    const setTimer = typeof windowRef?.setInterval === 'function'
      ? windowRef.setInterval.bind(windowRef)
      : setInterval;
    todayRefreshTimer = setTimer(() => {
      if (state.activeTab === 'today') {
        refreshToday({ preserveScroll: true });
      }
    }, TODAY_POLL_MS);
  };

  required.body.classList.add('shell-v2-enabled');
  required.body.dataset.shellV2Enabled = 'true';

  const switchTab = (tabId) => {
    if (!shellTabs.some((tab) => tab.id === tabId)) return false;
    state.activeTab = tabId;
    updateTabState(doc, required.body, rail, views, state.activeTab, shellTabs);
    if (state.activeTab === 'squid-room') {
      void doorbellController.ack({
        detail: 'Squid Room doorbell cleared on visit',
      });
    }
    if (state.activeTab === 'squid-room') {
      stopTodayPolling();
      scheduleArmRevealRefit(options.terminal || {}, windowRef);
    } else if (state.activeTab === 'today') {
      ensureTodayView(doc, views.today, windowRef, state, options);
      refreshToday({ preserveScroll: true });
      startTodayPolling();
      scheduleRefit(options.terminal || {}, windowRef);
    } else {
      stopTodayPolling();
      scheduleRefit(options.terminal || {}, windowRef);
    }
    if (typeof options.onTabActivated === 'function') {
      options.onTabActivated(state.activeTab);
    }
    return true;
  };

  const rail = buildTabRail(doc, required.header, switchTab, shellTabs);
  const views = ensureViews(doc, required.paneLayout, shellTabs);
  const coreStrip = reparentPaneContainers(doc, views, required.mainPaneContainer, required.sidePanesContainer);
  const refreshChrome = () => {
    required.body.classList.add('shell-v2-enabled');
    required.body.dataset.shellV2Enabled = 'true';
    buildHeaderActions(doc, required.header, required.headerActions);
    mergeBottomBar(doc, required.statusBar);
    migrateShellV2Settings(doc, windowRef, options.settings || {});
    ensureMiraScreenshotAffordances(doc, views.mira, windowRef, state);
    ensureLabView(doc, views, windowRef);
    rebuildMiraStationHeader(doc, findPaneIn(required.mainPaneContainer, '1'), options.settings || {});
    purgeLegacyPaneExpandButtons(required.sidePanesContainer);
    ensureSquidRoomFloor(doc, views, coreStrip, options.terminal || {}, state, options.settings || {}, {
      windowContext: options.windowContext || {},
      env: options.env || {},
    });
    ensureTodayView(doc, views.today, windowRef, state, options);
    bindTodayWindowButtonShim(doc, switchTab);
    removeShellV2KilledChrome(doc);
    doorbellController.render();
  };
  refreshChrome();

  const toggleCoreExpanded = (force) => {
    state.coreExpanded = typeof force === 'boolean' ? force : !state.coreExpanded;
    coreStrip.classList.toggle('shell-v2-core-expanded', state.coreExpanded);
    required.body.dataset.shellV2CoreExpanded = state.coreExpanded ? 'true' : 'false';
    scheduleRefit(options.terminal || {}, windowRef);
    return state.coreExpanded;
  };

  const onToggleCoreExpandedEvent = (event) => {
    const detail = event?.detail || {};
    toggleCoreExpanded(typeof detail.expanded === 'boolean' ? detail.expanded : undefined);
  };

  const onTodayRefreshEvent = (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    void refreshToday({
      preserveScroll: detail.preserveScroll !== false,
      limit: detail.limit,
    });
  };

  const onKeyDown = (event) => {
    if (event?.key === 'Escape' && clearArmZoom(state, doc, options.terminal || {})) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      return;
    }
    const targetPane = resolveShortcutPane(event);
    if (targetPane) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      if (targetPane.tabId && state.activeTab !== targetPane.tabId) {
        switchTab(targetPane.tabId);
      }
      options.terminal?.focusPane?.(targetPane.paneId);
      return;
    }
    const targetTab = resolveShortcutTab(event, shellTabs);
    if (!targetTab) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    blurActivePaneTerminal(doc, options.terminal || {});
    switchTab(targetTab);
  };

  const onClick = (event) => {
    const button = event.target?.closest?.('.expand-btn');
    if (!shouldHandleCoreExpand(button)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    toggleCoreExpanded();
  };

  doc.addEventListener?.('keydown', onKeyDown, true);
  doc.addEventListener?.('click', onClick, true);
  doc.addEventListener?.('shell-v2-toggle-core-expanded', onToggleCoreExpandedEvent);
  doc.addEventListener?.(SHELL_V2_TODAY_REFRESH_EVENT, onTodayRefreshEvent);
  const stopDoorbellSources = bindShellV2DoorbellSources(
    doc,
    windowRef,
    doorbellController,
    SHELL_V2_ACTIVE_PANE_IDS,
    { enableSourceProbe: gateProfile }
  );
  switchTab(state.activeTab);

  const controller = {
    enabled: true,
    switchTab,
    getActiveTab: () => state.activeTab,
    toggleCoreExpanded,
    isCoreExpanded: () => state.coreExpanded,
    refreshChrome,
    refreshToday,
    ackDoorbell: doorbellController.ack,
    doorbellSources: doorbellController.sources,
    handleDoorbellPermissionPrompt: doorbellController.sources.handlePermissionPrompt,
    handleDoorbellLeadEscalationMessage: doorbellController.sources.handleLeadEscalationMessage,
    handleDoorbellProcessExit: doorbellController.sources.handleProcessExit,
    elements: {
      rail,
      views,
      coreStrip,
    },
    destroy: () => {
      doc.removeEventListener?.('keydown', onKeyDown, true);
      doc.removeEventListener?.('click', onClick, true);
      doc.removeEventListener?.('shell-v2-toggle-core-expanded', onToggleCoreExpandedEvent);
      doc.removeEventListener?.(SHELL_V2_TODAY_REFRESH_EVENT, onTodayRefreshEvent);
      stopDoorbellSources?.();
      stopTodayPolling();
      if (windowRef?.__squidrunShellV2 === controller) {
        try {
          delete windowRef.__squidrunShellV2;
        } catch (_) {
          windowRef.__squidrunShellV2 = null;
        }
      }
      stateByDocument.delete(doc);
    },
  };

  if (required.body && typeof required.body === 'object') {
    required.body.__squidrunShellV2Controller = controller;
  }
  for (const target of [windowRef, doc.defaultView, typeof globalThis !== 'undefined' ? globalThis : null]) {
    if (target && typeof target === 'object') {
      try {
        Object.defineProperty(target, '__squidrunShellV2', {
          value: controller,
          configurable: true,
          writable: true,
        });
      } catch (_) {
        target.__squidrunShellV2 = controller;
      }
    }
  }

  stateByDocument.set(doc, { controller });
  return controller;
}

module.exports = {
  DOORBELL_CHOKEPOINT_CALLERS,
  DOORBELL_EVENTS,
  DOORBELL_TRIGGER_EVENTS,
  SHELL_V2_TABS,
  getShellV2Tabs,
  initShellV2,
  isShellV2EnvOverrideEnabled,
  resolveShellV2Enabled,
  _internals: {
    isMainWindowContext,
    normalizeWindowKey,
    dispatchShellEvent,
    resolveShortcutTab,
    blurActivePaneTerminal,
    shouldHandleCoreExpand,
    detectShellV2PermissionPrompt,
    isShellV2LeadEscalationPayload,
  },
};
