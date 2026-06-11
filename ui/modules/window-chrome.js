'use strict';

/**
 * Window chrome by window class - a DELIBERATE rendered list, not
 * inheritance-minus-exceptions (S426 identity lane, James's product call).
 *
 * Every window loads the same index.html; what chrome renders is decided
 * here per window class. Allow-list semantics: a control renders ONLY if its
 * id is named on the class's list. Controls not in the registry are outside
 * this module's jurisdiction.
 *
 * Matrix status: ALL FOUR rows APPROVED (ARCH #8, S426, Oracle audit as the
 * per-control spec). Ruling of record: the Mira Lab button renders in MAIN
 * ONLY until New-Mira parity (docs/mira-system-map.md:584-585 - live
 * diagnostic surface; lab code is not deletable through this lane).
 */

const WINDOW_CHROME_CLASSES = Object.freeze({
  MAIN: 'main',
  SQUID_ROOM: 'squid-room',
  CLIENT_PROFILE: 'client-profile',
  INSTALLED_OPERATOR: 'installed-operator',
  WORK_ROOM: 'work-room',
});

// Registry of chrome controls this module governs: header action ids plus
// whole chrome regions (selected by CSS class / id).
const CHROME_CONTROL_IDS = Object.freeze([
  'selectProjectBtn',
  'fullRestartBtn',
  'profileBtn',
  'settingsBtn',
  'openSquidRoomBtn',
  'openTrustQuoteWorkspaceBtn',
  'openMiraLabBtn',
  'panelBtn',
  'dryRunIndicator',
  'ciStatusIndicator',
]);

const CHROME_REGION_SELECTORS = Object.freeze({
  right_panel: '#rightPanel',
  status_bar: '.status-bar',
  project_indicator: '.project-indicator',
});

const FULL_CHROME = Object.freeze({
  controls: CHROME_CONTROL_IDS,
  regions: Object.freeze(Object.keys(CHROME_REGION_SELECTORS)),
});

const INSTALLED_OPERATOR_DROPPED_CONTROLS = Object.freeze([
  'openSquidRoomBtn',
  'openTrustQuoteWorkspaceBtn',
  'openMiraLabBtn',
]);

const INSTALLED_OPERATOR_CHROME = Object.freeze({
  controls: Object.freeze(CHROME_CONTROL_IDS.filter((id) => !INSTALLED_OPERATOR_DROPPED_CONTROLS.includes(id))),
  regions: FULL_CHROME.regions,
});

const CHROME_ALLOWLIST = Object.freeze({
  // James's cockpit: everything renders.
  [WINDOW_CHROME_CLASSES.MAIN]: FULL_CHROME,
  // The S406 room: logo + session badge (not registered controls - always
  // render) and the window-conditional Close button. The room's real chrome
  // is its own surface header (SQUID ROOM / Apps and Arms / Refresh).
  [WINDOW_CHROME_CLASSES.SQUID_ROOM]: Object.freeze({
    controls: Object.freeze(['fullRestartBtn']),
    regions: Object.freeze([]),
  }),
  // Client window (Eunbyeol is the live instance): mark + badge always
  // render; Quit (window-conditional behavior lives in renderer.js) and
  // Profile are the only operator controls a client sees. Settings is
  // operator-grade leakage and is deliberately absent.
  [WINDOW_CHROME_CLASSES.CLIENT_PROFILE]: Object.freeze({
    controls: Object.freeze(['fullRestartBtn', 'profileBtn']),
    regions: Object.freeze([]),
  }),
  // Installed operator consoles (Eunbyeol is the live split install): keep
  // maintenance chrome, but remove cross-product entry points.
  [WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR]: INSTALLED_OPERATOR_CHROME,
  // Work rooms (TrustQuote workspace): mark + badge + Close. The right panel
  // starts absent; if a work room proves a need it gets added back named.
  [WINDOW_CHROME_CLASSES.WORK_ROOM]: Object.freeze({
    controls: Object.freeze(['fullRestartBtn']),
    regions: Object.freeze([]),
  }),
});

function resolveWindowChromeClass(windowContext = {}) {
  const windowKey = String(windowContext.windowKey || 'main').trim().toLowerCase();
  const profileName = String(windowContext.profileName || windowContext.profile || 'main').trim().toLowerCase();
  const standalone = windowContext.standaloneWindow === true || windowContext.standaloneWindow === 'true';
  const installedDeployment = windowContext.installedDeploymentWindow === true
    || windowContext.installedDeploymentWindow === 'true'
    || windowContext.installedDeployment === true
    || windowContext.installedDeployment === 'true'
    || (standalone && windowKey === 'main' && profileName === 'main');
  if (windowKey === 'squid-room') return WINDOW_CHROME_CLASSES.SQUID_ROOM;
  if (windowKey === 'trustquote') return WINDOW_CHROME_CLASSES.WORK_ROOM;
  if (windowKey === 'main' && profileName === 'main' && installedDeployment) {
    return WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR;
  }
  if (standalone || (profileName !== 'main' && windowKey !== 'main')) {
    return WINDOW_CHROME_CLASSES.CLIENT_PROFILE;
  }
  if (windowKey === 'main' && profileName !== 'main') return WINDOW_CHROME_CLASSES.CLIENT_PROFILE;
  return WINDOW_CHROME_CLASSES.MAIN;
}

function setHidden(element, hidden) {
  if (!element) return;
  element.hidden = Boolean(hidden);
  if (hidden) {
    if (element.style) element.style.display = 'none';
    element.setAttribute?.('aria-hidden', 'true');
  } else {
    element.style?.removeProperty?.('display');
    element.removeAttribute?.('aria-hidden');
  }
}

/**
 * Apply the chrome allow-list for a window class. Default-deny: every
 * registered control/region is hidden unless the class names it.
 */
function applyWindowChrome(doc, windowClass) {
  if (!doc || typeof doc.getElementById !== 'function') {
    return { ok: false, reason: 'document_unavailable' };
  }
  const allow = CHROME_ALLOWLIST[windowClass] || CHROME_ALLOWLIST[WINDOW_CHROME_CLASSES.MAIN];
  const shownControls = new Set(allow.controls);
  const shownRegions = new Set(allow.regions);
  const applied = { windowClass, hidden: [], shown: [] };

  for (const id of CHROME_CONTROL_IDS) {
    const element = doc.getElementById(id);
    if (!element) continue;
    const show = shownControls.has(id);
    setHidden(element, !show);
    (show ? applied.shown : applied.hidden).push(id);
  }
  for (const [region, selector] of Object.entries(CHROME_REGION_SELECTORS)) {
    const element = doc.querySelector?.(selector);
    if (!element) continue;
    const show = shownRegions.has(region);
    setHidden(element, !show);
    (show ? applied.shown : applied.hidden).push(region);
  }
  return { ok: true, ...applied };
}

module.exports = {
  CHROME_ALLOWLIST,
  CHROME_CONTROL_IDS,
  CHROME_REGION_SELECTORS,
  WINDOW_CHROME_CLASSES,
  applyWindowChrome,
  resolveWindowChromeClass,
};
