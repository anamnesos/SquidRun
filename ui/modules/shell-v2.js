'use strict';

const workspacePaneShell = require('./workspace-pane-shell');

const SHELL_V2_TABS = Object.freeze([
  { id: 'mira', label: 'MIRA', shortcut: '1' },
  { id: 'squid-room', label: 'SQUID ROOM', shortcut: '2' },
  { id: 'today', label: 'TODAY', shortcut: '3' },
]);

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

const MAIN_WINDOW_KEYS = new Set(['', 'main']);
const stateByDocument = new WeakMap();

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

function buildTabRail(doc, header, onSelectTab) {
  let rail = doc.getElementById('shellV2TabRail');
  if (rail) return rail;

  rail = makeElement(doc, 'nav', 'shell-v2-tab-rail', {
    id: 'shellV2TabRail',
    'aria-label': 'Primary views',
  });

  SHELL_V2_TABS.forEach((tab) => {
    const button = makeElement(doc, 'button', 'shell-v2-tab', {
      type: 'button',
      textContent: tab.label,
      'data-shell-v2-tab': tab.id,
      'data-shortcut': `Ctrl+${tab.shortcut}`,
      'aria-pressed': 'false',
    });
    button.dataset.shellV2Tab = tab.id;
    button.dataset.shortcut = `Ctrl+${tab.shortcut}`;
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

function ensureViews(doc, paneLayout) {
  ensureClass(paneLayout, 'shell-v2-pane-layout');

  const views = {};
  SHELL_V2_TABS.forEach((tab) => {
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
  appendText(doc, chip, ' · ');
  if (cliBadge) {
    chip.appendChild(cliBadge);
  } else {
    chip.appendChild(makeElement(doc, 'span', 'cli-badge visible', {
      id: `cli-badge-${paneId}`,
      textContent: modelLabel,
    }));
  }

  const needsInput = makeElement(doc, 'span', 'shell-v2-needs-input-slot', {
    dataset: { paneId },
    'aria-label': `${roleLabel} needs input`,
  });
  needsInput.dataset.paneId = paneId;

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
    appendText(doc, title, ' · ');
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
    header.appendChild(makeArmControlMenu(doc, spec, command));
    pane.appendChild(header);
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

function updateTabState(doc, body, rail, views, activeTab) {
  body.dataset.shellV2ActiveTab = activeTab;
  SHELL_V2_TABS.forEach((tab) => {
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

function resolveShortcutTab(event) {
  if (!event?.ctrlKey || event.altKey || event.metaKey) return null;
  const key = String(event.key || '');
  const tab = SHELL_V2_TABS.find((candidate) => candidate.shortcut === key);
  return tab?.id || null;
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

  const required = getRequiredElements(doc);
  if (!required) return { enabled: false, reason: 'missing_required_elements' };

  const state = {
    activeTab: options.defaultTab || 'mira',
    coreExpanded: false,
  };

  required.body.classList.add('shell-v2-enabled');
  required.body.dataset.shellV2Enabled = 'true';

  const switchTab = (tabId) => {
    if (!SHELL_V2_TABS.some((tab) => tab.id === tabId)) return false;
    state.activeTab = tabId;
    updateTabState(doc, required.body, rail, views, state.activeTab);
    if (state.activeTab === 'squid-room') {
      scheduleArmRevealRefit(options.terminal || {}, windowRef);
    } else {
      scheduleRefit(options.terminal || {}, windowRef);
    }
    if (typeof options.onTabActivated === 'function') {
      options.onTabActivated(state.activeTab);
    }
    return true;
  };

  const rail = buildTabRail(doc, required.header, switchTab);
  const views = ensureViews(doc, required.paneLayout);
  const coreStrip = reparentPaneContainers(doc, views, required.mainPaneContainer, required.sidePanesContainer);
  const refreshChrome = () => {
    required.body.classList.add('shell-v2-enabled');
    required.body.dataset.shellV2Enabled = 'true';
    buildHeaderActions(doc, required.header, required.headerActions);
    mergeBottomBar(doc, required.statusBar);
    purgeLegacyPaneExpandButtons(required.sidePanesContainer);
    ensureSquidRoomFloor(doc, views, coreStrip, options.terminal || {}, state, options.settings || {}, {
      windowContext: options.windowContext || {},
      env: options.env || {},
    });
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

  const onKeyDown = (event) => {
    if (event?.key === 'Escape' && clearArmZoom(state, doc, options.terminal || {})) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      return;
    }
    const targetTab = resolveShortcutTab(event);
    if (!targetTab) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
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
  switchTab(state.activeTab);

  const controller = {
    enabled: true,
    switchTab,
    getActiveTab: () => state.activeTab,
    toggleCoreExpanded,
    isCoreExpanded: () => state.coreExpanded,
    refreshChrome,
    elements: {
      rail,
      views,
      coreStrip,
    },
    destroy: () => {
      doc.removeEventListener?.('keydown', onKeyDown, true);
      doc.removeEventListener?.('click', onClick, true);
      doc.removeEventListener?.('shell-v2-toggle-core-expanded', onToggleCoreExpandedEvent);
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
  SHELL_V2_TABS,
  initShellV2,
  isShellV2EnvOverrideEnabled,
  resolveShellV2Enabled,
  _internals: {
    isMainWindowContext,
    normalizeWindowKey,
    dispatchShellEvent,
    resolveShortcutTab,
    shouldHandleCoreExpand,
  },
};
