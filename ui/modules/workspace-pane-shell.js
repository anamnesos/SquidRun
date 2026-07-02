'use strict';

const {
  getTrustQuoteDayToDayArmSpecs,
} = require('./trustquote-arm-specs');
const {
  applyWindowChrome,
  resolveWindowChromeClass,
} = require('./window-chrome');
const rendererSettings = require('./settings');
const {
  CLAUDE_MODEL_SELECTOR_OPTIONS,
  selectorValueForCommand,
} = require('./claude-model-options');

const SQUID_ROOM_WORKSPACE_KEY = 'squid-room';
const SQUID_ROOM_TEAM_PANE_IDS = Object.freeze(['2', '3']);
const SQUID_ROOM_PET_PANE_SPECS = Object.freeze([
  {
    paneId: '2',
    petId: 'builder',
    assetRef: 'builder-squid',
    title: 'Builder',
    role: 'Builder',
    state: 'running',
    stateLabel: 'Working',
    bubble: 'Working the active fix.',
  },
  {
    paneId: '3',
    petId: 'oracle',
    assetRef: 'oracle-squid',
    title: 'Oracle',
    role: 'Oracle',
    state: 'review',
    stateLabel: 'Reviewing',
    bubble: 'Checking the proof.',
  },
]);
const PANE_ICON_SVGS = Object.freeze({
  avatar: '<svg class="avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  info: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  interrupt: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>',
  enter: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  restart: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  freshSession: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>',
  expand: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  lock: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
});
const SQUID_ROOM_TRUSTQUOTE_ARM_PANES = Object.freeze(getTrustQuoteDayToDayArmSpecs().map((spec) => Object.freeze({
  paneId: spec.paneId,
  label: spec.label,
  role: spec.roleLabel,
  roleId: spec.role,
  routeTarget: spec.routeTarget,
  commandSourcePaneId: spec.commandSourcePaneId,
  workingDir: spec.workingDir,
  command: spec.command,
  startupMessage: spec.startupMessage,
})));
const SQUID_ROOM_PANE_IDS = Object.freeze([
  ...SQUID_ROOM_TEAM_PANE_IDS,
  ...SQUID_ROOM_TRUSTQUOTE_ARM_PANES.map((pane) => pane.paneId),
]);

function detectModelFamily(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('gemini')) return 'gemini';
  return 'claude';
}

function resolveArmCommandFromSettings(paneId, fallback = 'codex') {
  try {
    const paneCommands = rendererSettings.getSettings?.()?.paneCommands || {};
    const command = String(paneCommands[String(paneId)] || '').trim();
    return command || fallback;
  } catch (_) {
    return fallback;
  }
}

function getDocument(doc) {
  if (doc && typeof doc.querySelector === 'function') return doc;
  if (typeof document !== 'undefined') return document;
  return null;
}

function appendTextNode(parent, text) {
  if (!parent?.ownerDocument || !text) return null;
  if (typeof parent.ownerDocument.createTextNode === 'function') {
    const node = parent.ownerDocument.createTextNode(text);
    parent.appendChild(node);
    return node;
  }
  const node = parent.ownerDocument.createElement('span');
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function createElement(doc, tagName, attrs = {}, text = '') {
  const element = doc.createElement(tagName);
  if (attrs.className) element.className = attrs.className;
  if (attrs.id) element.id = attrs.id;
  if (attrs.type) element.type = attrs.type;
  if (attrs.title) element.title = attrs.title;
  if (attrs.value !== undefined) element.value = attrs.value;
  if (attrs.selected !== undefined) element.selected = Boolean(attrs.selected);
  if (attrs.dataset) {
    for (const [key, value] of Object.entries(attrs.dataset)) {
      if (value !== undefined && value !== null) {
        element.dataset[key] = String(value);
      }
    }
  }
  if (attrs.attributes) {
    for (const [key, value] of Object.entries(attrs.attributes)) {
      element.setAttribute?.(key, String(value));
    }
  }
  if (attrs.innerHTML) element.innerHTML = attrs.innerHTML;
  if (text) element.textContent = text;
  return element;
}

function createPaneActionButton(doc, className, paneId, tooltip, iconMarkup) {
  return createElement(doc, 'button', {
    className: `pane-action-btn ${className}`,
    type: 'button',
    dataset: {
      paneId,
      tooltip,
    },
    attributes: {
      'aria-label': tooltip,
    },
    innerHTML: iconMarkup,
  });
}

function createRoleInfoButton(doc, paneId) {
  return createElement(doc, 'button', {
    className: 'pane-role-info-btn',
    type: 'button',
    title: 'Show role bundle',
    dataset: { paneId },
    innerHTML: PANE_ICON_SVGS.info,
  });
}

function createArmModelSelector(doc, paneId, currentModel = 'codex', currentCommand = '') {
  const model = ['claude', 'codex', 'gemini'].includes(currentModel) ? currentModel : 'codex';
  const selectorValue = selectorValueForCommand(currentCommand, model);
  const selector = createElement(doc, 'select', {
    className: 'model-selector squid-room-arm-model-selector',
    id: `model-selector-${paneId}`,
    title: 'Switch model for this arm',
    dataset: {
      paneId,
      previousValue: selectorValue,
      squidRoomArmModelSelector: 'true',
    },
  });
  for (const option of [
    ...CLAUDE_MODEL_SELECTOR_OPTIONS,
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
  ]) {
    selector.appendChild(createElement(doc, 'option', {
      value: option.value,
      selected: option.value === selectorValue,
      dataset: option.model ? { claudeModel: option.model } : undefined,
    }, option.label));
  }
  selector.value = selectorValue;
  return selector;
}

function removeElement(element) {
  if (!element) return;
  if (typeof element.remove === 'function') {
    element.remove();
    return;
  }
  const siblings = element.parentNode?.childNodes;
  if (Array.isArray(siblings)) {
    const index = siblings.indexOf(element);
    if (index >= 0) siblings.splice(index, 1);
  }
}

function ensureArmModelSelector(doc, pane, paneId, currentModel = 'codex', currentCommand = '') {
  if (!doc || !pane || !paneId) return null;
  const model = ['claude', 'codex', 'gemini'].includes(currentModel) ? currentModel : 'codex';
  const selectorValue = selectorValueForCommand(currentCommand, model);
  let selector = pane.querySelector?.(`.model-selector[data-pane-id="${paneId}"]`);
  if (!selector) {
    selector = createArmModelSelector(doc, paneId, model, currentCommand);
    const badge = pane.querySelector?.(`.model-badge[data-pane-id="${paneId}"]`);
    if (badge?.parentNode) {
      badge.parentNode.insertBefore?.(selector, badge);
      removeElement(badge);
      return selector;
    }
    const squidRoomMenuPanel = pane.querySelector?.('.squid-room-pane-menu-panel');
    if (squidRoomMenuPanel) {
      squidRoomMenuPanel.insertBefore?.(selector, squidRoomMenuPanel.firstChild || null);
      return selector;
    }
    const headerRight = pane.querySelector?.('.pane-header-right') || pane.querySelector?.('.pane-header');
    const health = pane.querySelector?.(`#health-${paneId}`);
    if (headerRight && health?.parentNode === headerRight) {
      headerRight.insertBefore?.(selector, health);
    } else {
      headerRight?.appendChild?.(selector);
    }
  }
  selector.value = selectorValue;
  selector.dataset.previousValue = selectorValue;
  selector.dataset.squidRoomArmModelSelector = 'true';
  return selector;
}

function createSquidRoomPaneMenu(doc, paneId, controls = []) {
  const menu = createElement(doc, 'details', {
    className: 'squid-room-pane-menu',
    dataset: { paneId },
  });
  const trigger = createElement(doc, 'summary', {
    className: 'squid-room-pane-menu-trigger',
    dataset: { tooltip: 'Pane controls' },
    attributes: { 'aria-label': 'Pane controls' },
  }, '...');
  const panel = createElement(doc, 'div', {
    className: 'squid-room-pane-menu-panel',
    attributes: { 'aria-label': 'Pane controls' },
  });
  for (const control of controls) {
    if (control) panel.appendChild(control);
  }
  menu.appendChild(trigger);
  menu.appendChild(panel);
  return menu;
}

function createSquidRoomLivePane(doc, spec) {
  const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
  const model = detectModelFamily(command);
  const pane = createElement(doc, 'div', {
    className: 'pane squid-room-live-pane',
    dataset: {
      paneId: spec.paneId,
      squidRoomLivePane: 'true',
      squidRoomLabel: spec.label,
      squidRoomRole: spec.role,
      squidRoomRoleId: spec.roleId || spec.routeTarget || spec.paneId,
      squidRoomRouteTarget: spec.routeTarget || spec.paneId,
      squidRoomWorkingDir: spec.workingDir,
      squidRoomCommand: command,
      squidRoomCommandSourcePaneId: spec.commandSourcePaneId,
      squidRoomStartupMessage: spec.startupMessage,
      cli: model,
    },
  });

  const header = createElement(doc, 'div', { className: 'pane-header' });
  const title = createElement(doc, 'span', { className: 'pane-title' });
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-avatar',
    innerHTML: PANE_ICON_SVGS.avatar,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-badge idle',
    id: `badge-${spec.paneId}`,
  }));
  appendTextNode(title, spec.label);
  title.appendChild(createRoleInfoButton(doc, spec.paneId));
  title.appendChild(createElement(doc, 'span', {
    className: 'cli-badge',
    id: `cli-badge-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'pane-project',
    id: `project-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-task',
    id: `task-${spec.paneId}`,
    text: '',
  }));

  const headerRight = createElement(doc, 'div', { className: 'pane-header-right' });
  const modelSelector = createArmModelSelector(doc, spec.paneId, model, command);
  const freshSessionButton = createPaneActionButton(doc, 'fresh-session-btn', spec.paneId, 'Fresh session', PANE_ICON_SVGS.freshSession);
  const health = createElement(doc, 'span', {
    className: 'agent-health',
    id: `health-${spec.paneId}`,
    title: 'Last output time',
  }, '-');

  const actions = createElement(doc, 'div', { className: 'pane-actions' });
  actions.appendChild(createPaneActionButton(doc, 'interrupt-btn', spec.paneId, 'Interrupt', PANE_ICON_SVGS.interrupt));
  actions.appendChild(createPaneActionButton(doc, 'unstick-btn', spec.paneId, 'Enter', PANE_ICON_SVGS.enter));
  actions.appendChild(createPaneActionButton(doc, 'kickoff-btn', spec.paneId, 'Restart agent', PANE_ICON_SVGS.restart));
  actions.appendChild(createPaneActionButton(doc, 'expand-btn', spec.paneId, 'Expand (ESC to collapse)', PANE_ICON_SVGS.expand));
  const lock = createElement(doc, 'span', {
    className: 'lock-icon',
    id: `lock-icon-${spec.paneId}`,
    dataset: {
      paneId: spec.paneId,
      tooltip: 'Locked (click to toggle)',
    },
    innerHTML: PANE_ICON_SVGS.lock,
  });
  headerRight.appendChild(createSquidRoomPaneMenu(doc, spec.paneId, [
    modelSelector,
    freshSessionButton,
    health,
    actions,
    lock,
  ]));

  header.appendChild(title);
  header.appendChild(headerRight);
  pane.appendChild(header);
  pane.appendChild(createElement(doc, 'div', {
    className: 'pane-terminal',
    id: `terminal-${spec.paneId}`,
  }));
  pane.appendChild(createElement(doc, 'span', { id: `status-${spec.paneId}` }));
  return pane;
}

// P1.7 (S463): pets are PROCEDURAL LIVING CREATURES on a canvas - verlet
// tentacles, jet propulsion, banking - driven by squid-room-creature-runtime.
// The sprite atlases retire with honor (files kept, unused).
function createSquidRoomPetArtwork(doc, spec) {
  return createElement(doc, 'canvas', {
    className: 'squid-room-creature-canvas',
    dataset: {
      squidRoomCreature: spec.petId,
      avatarAssetRef: spec.assetRef,
    },
    attributes: { 'aria-hidden': 'true' },
  });
}

function createSvgElement(doc, tagName, attrs = {}) {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = typeof doc.createElementNS === 'function'
    ? doc.createElementNS(namespace, tagName)
    : doc.createElement(tagName);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      if (key === 'class' && element.classList?.add) {
        String(value).split(/\s+/).filter(Boolean).forEach((className) => {
          element.classList.add(className);
        });
      }
      element.setAttribute?.(key, String(value));
    }
  }
  return element;
}

function appendSquidRoomLiquidFilter(doc, defs, id, {
  baseFrequency,
  numOctaves = 2,
  scale = 4,
  seed = 3,
} = {}) {
  const filter = createSvgElement(doc, 'filter', {
    id,
    x: '-16%',
    y: '-16%',
    width: '132%',
    height: '132%',
    'color-interpolation-filters': 'sRGB',
  });
  filter.appendChild(createSvgElement(doc, 'feTurbulence', {
    type: 'fractalNoise',
    baseFrequency,
    numOctaves,
    seed,
    result: 'squid-room-liquid-noise',
  }));
  filter.appendChild(createSvgElement(doc, 'feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'squid-room-liquid-noise',
    scale,
    xChannelSelector: 'R',
    yChannelSelector: 'G',
  }));
  defs.appendChild(filter);
  return filter;
}

function ensureSquidRoomPetFilters(doc) {
  const body = doc?.body;
  if (!body) return null;
  let svg = body.querySelector?.('.squid-room-pet-filters');
  if (svg) return svg;

  svg = createSvgElement(doc, 'svg', {
    class: 'squid-room-pet-filters',
    width: '0',
    height: '0',
    viewBox: '0 0 0 0',
    focusable: 'false',
    'aria-hidden': 'true',
  });
  const defs = createSvgElement(doc, 'defs');
  appendSquidRoomLiquidFilter(doc, defs, 'squid-room-liquid-active-a', {
    baseFrequency: '0.012 0.018',
    scale: 4.6,
    seed: 7,
  });
  appendSquidRoomLiquidFilter(doc, defs, 'squid-room-liquid-active-b', {
    baseFrequency: '0.018 0.012',
    scale: 4.2,
    seed: 11,
  });
  appendSquidRoomLiquidFilter(doc, defs, 'squid-room-liquid-settling-a', {
    baseFrequency: '0.010 0.014',
    scale: 3.4,
    seed: 5,
  });
  appendSquidRoomLiquidFilter(doc, defs, 'squid-room-liquid-settling-b', {
    baseFrequency: '0.014 0.010',
    scale: 3,
    seed: 13,
  });
  appendSquidRoomLiquidFilter(doc, defs, 'squid-room-liquid-resting', {
    baseFrequency: '0.008 0.010',
    scale: 1.6,
    seed: 17,
  });
  svg.appendChild(defs);
  body.insertBefore?.(svg, body.firstChild || null);
  return svg;
}

function removeSquidRoomPetFilters(doc) {
  const svg = doc?.body?.querySelector?.('.squid-room-pet-filters');
  svg?.remove?.();
}

function renderSquidRoomCoreTerminalPane(doc, pane, spec) {
  if (!doc || !pane || !spec) return null;
  if (Array.isArray(pane.childNodes)) pane.childNodes.length = 0;
  pane.innerHTML = '';
  pane.className = 'pane squid-room-core-terminal-pane';
  pane.dataset.paneId = spec.paneId;
  pane.dataset.squidRoomCoreTerminal = 'true';
  pane.dataset.squidRoomLabel = spec.title;
  pane.dataset.squidRoomRole = spec.role;

  const header = createElement(doc, 'div', { className: 'pane-header' });
  const title = createElement(doc, 'span', { className: 'pane-title' });
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-avatar',
    innerHTML: PANE_ICON_SVGS.avatar,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-badge idle',
    id: `badge-${spec.paneId}`,
  }));
  appendTextNode(title, spec.title);
  title.appendChild(createRoleInfoButton(doc, spec.paneId));
  title.appendChild(createElement(doc, 'span', {
    className: 'cli-badge',
    id: `cli-badge-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'pane-project',
    id: `project-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-task',
    id: `task-${spec.paneId}`,
    text: '',
  }));

  const headerRight = createElement(doc, 'div', { className: 'pane-header-right' });
  const actions = createElement(doc, 'div', { className: 'pane-actions' });
  actions.appendChild(createPaneActionButton(doc, 'interrupt-btn', spec.paneId, 'Interrupt', PANE_ICON_SVGS.interrupt));
  actions.appendChild(createPaneActionButton(doc, 'unstick-btn', spec.paneId, 'Enter', PANE_ICON_SVGS.enter));
  actions.appendChild(createPaneActionButton(doc, 'kickoff-btn', spec.paneId, 'Restart agent', PANE_ICON_SVGS.restart));
  actions.appendChild(createPaneActionButton(doc, 'expand-btn', spec.paneId, 'Expand (ESC to collapse)', PANE_ICON_SVGS.expand));
  headerRight.appendChild(actions);
  header.appendChild(title);
  header.appendChild(headerRight);

  pane.appendChild(header);
  pane.appendChild(createElement(doc, 'div', {
    className: 'pane-terminal',
    id: `terminal-${spec.paneId}`,
  }));
  pane.appendChild(createElement(doc, 'span', { id: `status-${spec.paneId}` }));
  return pane;
}

function renderSquidRoomPetPane(doc, pane, spec, options = {}) {
  if (!doc || !pane || !spec) return null;
  if (Array.isArray(pane.childNodes)) pane.childNodes.length = 0;
  pane.innerHTML = '';
  const presentationOnly = options.presentationOnly === true;
  pane.className = presentationOnly
    ? `squid-room-pet-pane squid-room-creature squid-room-creature-${spec.petId}`
    : 'pane squid-room-pet-pane';
  if (presentationOnly) {
    delete pane.dataset.paneId;
    pane.setAttribute?.('role', 'button');
    pane.setAttribute?.('tabindex', '0');
    pane.setAttribute?.('aria-label', `Open ${spec.title} terminal drawer`);
    pane.dataset.squidRoomTerminalDrawerOpen = 'true';
  } else {
    pane.dataset.paneId = spec.paneId;
  }
  pane.dataset.squidRoomPet = spec.petId;
  pane.dataset.squidRoomSourcePaneId = spec.paneId;
  pane.dataset.squidRoomState = spec.state;
  pane.dataset.squidRoomRole = spec.role;
  pane.dataset.squidRoomLabel = spec.title;
  pane.dataset.squidRoomPetAsset = spec.assetRef;

  const shell = createElement(doc, 'div', { className: 'squid-room-pet-shell' });
  const header = createElement(doc, 'div', { className: 'squid-room-pet-header' });
  const title = createElement(doc, 'div', { className: 'squid-room-pet-title' });
  title.appendChild(createElement(doc, 'strong', { className: 'pane-title' }, spec.title));
  header.appendChild(title);

  const stage = createElement(doc, 'div', { className: 'squid-room-pet-stage pet-stage is-active' });
  stage.appendChild(createElement(doc, 'span', { className: 'pet-caustics' }));
  stage.appendChild(createElement(doc, 'span', { className: 'pet-glow' }));
  // The creature canvas fills the whole stage: the procedural squid swims
  // the water region (P1.7); speech/name anchor to its head at runtime.
  stage.appendChild(createSquidRoomPetArtwork(doc, spec));
  const motionTrack = createElement(doc, 'span', { className: 'pet-motion-track' });
  const speech = createElement(doc, 'div', {
    className: 'squid-room-pet-speech',
    id: `squidRoomPetSpeech-${spec.paneId}`,
    attributes: { 'aria-live': 'polite' },
  });
  speech.appendChild(createElement(doc, 'span', { className: 'speech-line-text' }, `${spec.stateLabel}: ${spec.bubble}`));
  motionTrack.appendChild(speech);
  stage.appendChild(motionTrack);
  // Name label lives DIRECTLY on the stage: the sprite-era motion track
  // still carries CSS float animations whose transforms are invisible to
  // offset* reads - anchoring math inside it can never be right (live-CDP
  // diagnosis). Stage-local = the same frame as the head anchor.
  stage.appendChild(createElement(doc, 'span', { className: 'squid-room-pet-name-label' }, spec.title));

  const faceLine = createElement(doc, 'div', {
    className: 'squid-room-pet-caption face-line',
    id: `squidRoomPetBubble-${spec.paneId}`,
    attributes: { 'aria-live': 'polite' },
  });
  faceLine.appendChild(createElement(doc, 'span', { className: 'face-line-text' }, spec.bubble));
  const details = createElement(doc, 'details', { className: 'face-details' });
  details.hidden = true;
  details.appendChild(createElement(doc, 'summary', { className: 'details-toggle' }, 'raw'));
  details.appendChild(createElement(doc, 'pre', {
    className: 'face-raw',
    id: `squidRoomPetRaw-${spec.paneId}`,
  }, ''));
  faceLine.appendChild(details);

  shell.appendChild(header);
  shell.appendChild(stage);
  stage.appendChild(faceLine);
  pane.appendChild(shell);
  return pane;
}

function ensureSquidRoomPetPanes(doc) {
  const teamContainer = doc.querySelector?.('.side-panes-container');
  if (!teamContainer) return [];
  const ocean = ensureSquidRoomCreatureOcean(doc, teamContainer);
  if (!ocean) return [];
  const panes = [];
  for (const spec of SQUID_ROOM_PET_PANE_SPECS) {
    let pane = Array.from(ocean.querySelectorAll?.('.squid-room-pet-pane') || [])
      .find((candidate) => candidate?.dataset?.squidRoomPet === spec.petId);
    if (!pane) {
      pane = createElement(doc, 'div');
      ocean.querySelector?.('.squid-room-creature-layer')?.appendChild(pane);
    }
    setElementHidden(pane, false);
    renderSquidRoomPetPane(doc, pane, spec, { presentationOnly: true });
    panes.push(spec);
  }
  return panes;
}

// WAVE 4 deep space: starfield parallax layers + twinkles + distant galaxy
// + one pooled shooting star, injected once at body level (James 00:25:
// "cosmic universe type background"). Pure CSS animation - perf-lawful.
// FORMATION: the cosmos is the ARCHITECT's hand-authored subsystem
// (ui/styles/architect-cosmos-layer.css, integrated verbatim). This hook
// builds his exact DOM contract: one .cosmos div, first child of body.
function ensureSquidRoomSpaceLayers(doc) {
  const body = doc?.body;
  if (!body || body.querySelector?.('.cosmos')) return null;
  // Retire the builder's interim space layers if a re-render left them.
  body.querySelector?.('.squid-space-stars')?.remove?.();
  body.querySelector?.('.squid-space-galaxy')?.remove?.();
  body.querySelector?.('.squid-space-shooting-star')?.remove?.();
  const cosmos = createElement(doc, 'div', {
    className: 'cosmos',
    attributes: { 'aria-hidden': 'true' },
  });
  for (const className of ['stars s1', 'stars s2', 'stars s3', 'nebula n1', 'nebula n2', 'nebula n3', 'galaxy', 'comet']) {
    cosmos.appendChild(createElement(doc, 'div', { className }));
  }
  body.insertBefore?.(cosmos, body.firstChild || null);
  return cosmos;
}

function ensureSquidRoomTeamHeader(doc, teamContainer) {
  if (!doc || !teamContainer) return null;
  let header = teamContainer.querySelector?.('.squid-room-team-header');
  if (!header) {
    header = createElement(doc, 'div', { className: 'squid-room-team-header' });
    teamContainer.insertBefore?.(header, teamContainer.firstChild || null);
  }

  header.innerHTML = '';
  const title = createElement(doc, 'div', { className: 'squid-room-team-title' });
  title.appendChild(createElement(doc, 'span', { className: 'squid-room-team-eyebrow' }, 'Ocean'));
  title.appendChild(createElement(doc, 'strong', {}, 'Builder + Oracle'));
  header.appendChild(title);

  const actions = createElement(doc, 'div', { className: 'pane-actions squid-room-team-actions' });
  const expandButton = createElement(doc, 'button', {
    className: 'squid-room-app-toggle-btn expand-btn squid-room-team-expand-btn',
    type: 'button',
    dataset: {
      paneId: SQUID_ROOM_TEAM_PANE_IDS[0],
      tooltip: 'Collapse Builder + Oracle',
      expanded: 'true',
      squidRoomTeamToggle: 'true',
    },
    attributes: {
      'aria-label': 'Collapse Builder + Oracle',
      'aria-expanded': 'true',
    },
  });
  expandButton.appendChild(createElement(doc, 'span', {
    className: 'squid-room-team-toggle-label',
  }, 'Collapse'));
  actions.appendChild(expandButton);
  header.appendChild(actions);
  return header;
}

function ensureSquidRoomCreatureOcean(doc, teamContainer) {
  if (!doc || !teamContainer) return null;
  let ocean = teamContainer.querySelector?.('.squid-room-creature-ocean');
  if (!ocean) {
    ocean = createElement(doc, 'section', {
      className: 'squid-room-creature-ocean',
      id: 'squidRoomCreatureOcean',
      attributes: { 'aria-label': 'Builder and Oracle open water' },
    });
    const layer = createElement(doc, 'div', {
      className: 'squid-room-creature-layer',
      attributes: { 'aria-hidden': 'false' },
    });
    const terminalsButton = createElement(doc, 'button', {
      className: 'squid-room-terminal-drawer-open',
      type: 'button',
      dataset: {
        squidRoomTerminalDrawerOpen: 'true',
        tooltip: 'Open Builder + Oracle terminals',
      },
      attributes: {
        'aria-label': 'Open Builder and Oracle terminals',
        'aria-expanded': 'false',
        'aria-controls': 'squidRoomTerminalDrawer',
      },
    }, 'Terminals');
    ocean.appendChild(layer);
    ocean.appendChild(terminalsButton);
    const header = teamContainer.querySelector?.('.squid-room-team-header');
    if (header?.nextSibling) {
      teamContainer.insertBefore?.(ocean, header.nextSibling);
    } else {
      teamContainer.appendChild(ocean);
    }
  }
  return ocean;
}

function ensureSquidRoomTerminalDrawer(doc, teamContainer) {
  if (!doc || !teamContainer) return null;
  let drawer = teamContainer.querySelector?.('#squidRoomTerminalDrawer');
  if (!drawer) {
    drawer = createElement(doc, 'div', {
      className: 'squid-room-terminal-drawer',
      id: 'squidRoomTerminalDrawer',
      attributes: {
        'aria-hidden': 'true',
        'aria-label': 'Builder and Oracle terminals',
      },
    });
    const backdrop = createElement(doc, 'button', {
      className: 'squid-room-terminal-drawer-backdrop',
      type: 'button',
      dataset: { squidRoomTerminalDrawerClose: 'true' },
      attributes: { 'aria-label': 'Close terminal drawer' },
    });
    const panel = createElement(doc, 'div', { className: 'squid-room-terminal-drawer-panel' });
    const header = createElement(doc, 'div', { className: 'squid-room-terminal-drawer-header' });
    header.appendChild(createElement(doc, 'strong', {}, 'Builder + Oracle terminals'));
    header.appendChild(createElement(doc, 'button', {
      className: 'squid-room-terminal-drawer-close',
      type: 'button',
      dataset: { squidRoomTerminalDrawerClose: 'true' },
      attributes: { 'aria-label': 'Close terminal drawer' },
    }, 'Close'));
    panel.appendChild(header);
    panel.appendChild(createElement(doc, 'div', { className: 'squid-room-terminal-drawer-panes' }));
    drawer.appendChild(backdrop);
    drawer.appendChild(panel);
    teamContainer.appendChild(drawer);
  }
  return drawer;
}

function ensureSquidRoomCoreTerminalPanes(doc, teamContainer) {
  const drawer = ensureSquidRoomTerminalDrawer(doc, teamContainer);
  const paneHost = drawer?.querySelector?.('.squid-room-terminal-drawer-panes');
  if (!paneHost) return [];

  const panes = [];
  for (const spec of SQUID_ROOM_PET_PANE_SPECS) {
    let pane = doc.querySelector?.(`.pane[data-pane-id="${spec.paneId}"]`);
    if (!pane) {
      pane = createElement(doc, 'div', { className: 'pane', dataset: { paneId: spec.paneId } });
    }
    if (!pane.querySelector?.('.pane-terminal') || pane.classList?.contains?.('squid-room-pet-pane')) {
      renderSquidRoomCoreTerminalPane(doc, pane, spec);
    }
    pane.classList?.remove?.('squid-room-pet-pane');
    pane.classList?.add?.('squid-room-core-terminal-pane');
    pane.dataset.squidRoomCoreTerminal = 'true';
    pane.dataset.squidRoomLabel = spec.title;
    pane.dataset.squidRoomRole = spec.role;
    setElementHidden(pane, false);
    paneHost.appendChild(pane);
    panes.push(spec);
  }
  return panes;
}

function ensureSquidRoomLivePaneContainer(doc) {
  let container = doc.querySelector?.('#squidRoomTrustQuoteLivePanes');
  if (container) return container;

  const app = doc.querySelector?.('.squid-room-app[data-app-room-id="trustquote"]')
    || doc.querySelector?.('[data-app-room-id="trustquote"]')
    || doc.querySelector?.('#squidRoomSurface');
  if (!app) return null;

  container = createElement(doc, 'div', {
    className: 'squid-room-live-panes',
    id: 'squidRoomTrustQuoteLivePanes',
  });
  app.appendChild(container);
  return container;
}

function ensureSquidRoomLivePanes(doc) {
  const container = ensureSquidRoomLivePaneContainer(doc);
  if (!container) return [];

  const panes = [];
  for (const spec of SQUID_ROOM_TRUSTQUOTE_ARM_PANES) {
    const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
    const model = detectModelFamily(command);
    let pane = doc.querySelector?.(`.pane[data-pane-id="${spec.paneId}"]`);
    if (!pane) {
      pane = createSquidRoomLivePane(doc, spec);
      container.appendChild(pane);
    }
    setElementHidden(pane, false);
    pane.dataset.squidRoomLivePane = 'true';
    pane.dataset.squidRoomLabel = spec.label;
    pane.dataset.squidRoomRole = spec.role;
    pane.dataset.squidRoomRoleId = spec.roleId || spec.routeTarget || spec.paneId;
    pane.dataset.squidRoomRouteTarget = spec.routeTarget || spec.paneId;
    pane.dataset.squidRoomWorkingDir = spec.workingDir;
    pane.dataset.squidRoomCommand = command;
    pane.dataset.squidRoomCommandSourcePaneId = spec.commandSourcePaneId;
    pane.dataset.squidRoomStartupMessage = spec.startupMessage;
    pane.dataset.cli = model;
    ensureArmModelSelector(doc, pane, spec.paneId, model, command);
    panes.push(spec);
  }
  return panes;
}

function configureSquidRoomRuntimeOverrides(terminal, livePanes = SQUID_ROOM_TRUSTQUOTE_ARM_PANES) {
  if (!terminal || typeof terminal.setPaneRuntimeOverride !== 'function') return;
  for (const spec of livePanes) {
    const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
    const provider = detectModelFamily(command);
    terminal.setPaneRuntimeOverride(spec.paneId, {
      label: spec.label,
      roleLabel: spec.label,
      roleId: spec.roleId || spec.routeTarget || spec.paneId,
      routeTarget: spec.routeTarget || spec.paneId,
      provider,
      command,
      commandSourcePaneId: spec.commandSourcePaneId,
      workingDir: spec.workingDir,
      startupMessage: spec.startupMessage,
      spawnCommandOnCreate: true,
      recreateOnWorkingDirMismatch: true,
    });
  }
}

function setElementHidden(element, hidden) {
  if (!element) return;
  element.hidden = Boolean(hidden);
  if (hidden) {
    element.setAttribute?.('aria-hidden', 'true');
    element.classList?.add?.('workspace-hidden-pane');
  } else {
    element.removeAttribute?.('aria-hidden');
    element.classList?.remove?.('workspace-hidden-pane');
  }
}

function isSquidRoomWorkspace(value) {
  return String(value || '').trim().toLowerCase() === SQUID_ROOM_WORKSPACE_KEY;
}

function ensureSquidRoomMotes(doc) {
  const body = doc?.body;
  if (!body) return null;
  let motes = body.querySelector?.('.abyss-motes');
  if (!motes) {
    motes = createElement(doc, 'div', {
      className: 'abyss-motes',
      attributes: { 'aria-hidden': 'true' },
    });
    for (let index = 0; index < 12; index += 1) {
      const mote = createElement(doc, 'span');
      if (mote.style) {
        mote.style.left = `${8 + ((index * 17) % 86)}%`;
        mote.style.animationDuration = `${18 + (index % 5) * 5}s`;
        mote.style.animationDelay = `${-1 * ((index * 3) % 17)}s`;
      }
      motes.appendChild(mote);
    }
    body.insertBefore?.(motes, body.firstChild || null);
  }
  return motes;
}

function removeSquidRoomMotes(doc) {
  const motes = doc?.body?.querySelector?.('.abyss-motes');
  motes?.remove?.();
}

function configureSquidRoomPaneShell(doc) {
  const body = doc.body;
  if (body) {
    body.dataset.workspaceKey = SQUID_ROOM_WORKSPACE_KEY;
    body.classList.add('squid-room-workspace');
    body.classList.add('squid-room');
  }
  ensureSquidRoomMotes(doc);
  ensureSquidRoomPetFilters(doc);

  const mainPane = doc.querySelector('.pane[data-pane-id="1"], .pane[data-workspace-source-pane-id="1"]');
  setElementHidden(mainPane, true);

  const commandBar = doc.querySelector('.command-bar');
  setElementHidden(commandBar, true);

  const miraLiveReply = doc.querySelector('#miraLiveReply');
  setElementHidden(miraLiveReply, true);

  ensureSquidRoomSpaceLayers(doc);
  const teamContainer = doc.querySelector?.('.side-panes-container');
  if (teamContainer) {
    teamContainer.classList?.add?.('squid-room-team-container');
    teamContainer.dataset.squidRoomSection = 'builder-oracle';
    teamContainer.setAttribute?.('aria-label', 'Builder and Oracle');
    ensureSquidRoomTeamHeader(doc, teamContainer);
    ensureSquidRoomCreatureOcean(doc, teamContainer);
    ensureSquidRoomCoreTerminalPanes(doc, teamContainer);
  }

  const petPanes = ensureSquidRoomPetPanes(doc);

  const surface = doc.querySelector('#squidRoomSurface');
  if (surface) {
    surface.hidden = false;
    surface.removeAttribute?.('aria-hidden');
  }

  const livePanes = ensureSquidRoomLivePanes(doc);

  return {
    workspaceKey: SQUID_ROOM_WORKSPACE_KEY,
    paneIds: SQUID_ROOM_PANE_IDS.slice(),
    teamPaneIds: SQUID_ROOM_TEAM_PANE_IDS.slice(),
    petPanes,
    livePanes,
  };
}

function configureWorkspacePaneShell(windowContext = {}, terminal = null, doc = null) {
  const resolvedDocument = getDocument(doc);
  if (!resolvedDocument) {
    return { workspaceKey: 'main', paneIds: [] };
  }

  // Chrome renders by window class from a deliberate allow-list - every
  // window decides its chrome here, never by inheriting main's header.
  const windowChromeClass = resolveWindowChromeClass(windowContext);
  applyWindowChrome(resolvedDocument, windowChromeClass);

  const workspaceKey = windowContext?.windowKey || windowContext?.profileName || 'main';
  let result = { workspaceKey: 'main', paneIds: null };
  if (isSquidRoomWorkspace(workspaceKey)) {
    result = configureSquidRoomPaneShell(resolvedDocument);
  } else if (resolvedDocument.body) {
    resolvedDocument.body.classList.remove('squid-room-workspace');
    resolvedDocument.body.classList.remove('squid-room');
    removeSquidRoomMotes(resolvedDocument);
    removeSquidRoomPetFilters(resolvedDocument);
  }

  if (terminal && typeof terminal.setActivePaneIds === 'function') {
    terminal.setActivePaneIds(result.paneIds || null);
  }
  if (isSquidRoomWorkspace(result.workspaceKey)) {
    configureSquidRoomRuntimeOverrides(terminal, result.livePanes);
  }

  return result;
}

module.exports = {
  SQUID_ROOM_WORKSPACE_KEY,
  SQUID_ROOM_PANE_IDS,
  SQUID_ROOM_PET_PANE_SPECS,
  SQUID_ROOM_TEAM_PANE_IDS,
  SQUID_ROOM_TRUSTQUOTE_ARM_PANES,
  ensureSquidRoomPetFilters,
  configureWorkspacePaneShell,
};
