const fs = require('fs');
const path = require('path');
const { configureWorkspacePaneShell } = require('../modules/workspace-pane-shell');

class FakeClassList {
  constructor(initial = '') {
    this.values = new Set(String(initial).split(/\s+/).filter(Boolean));
  }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName, attrs = {}, children = []) {
    this.tagName = tagName;
    this.id = attrs.id || '';
    this.dataset = { ...(attrs.dataset || {}) };
    this.classList = new FakeClassList(attrs.className || '');
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.hidden = false;
    this.textContent = attrs.textContent || '';
    for (const child of children) this.appendChild(child);
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  get className() {
    return Array.from(this.classList.values).join(' ');
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    const index = this.childNodes.indexOf(reference);
    if (index === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(index, 0, child);
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'aria-hidden') this.ariaHidden = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'aria-hidden') delete this.ariaHidden;
  }

  querySelector(selector) {
    return querySelectorFrom(this, selector);
  }

  querySelectorAll(selector) {
    return querySelectorAllFrom(this, selector);
  }
}

class FakeDocument {
  constructor(body) {
    this.body = body;
    setOwnerDocument(body, this);
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  querySelector(selector) {
    return querySelectorFrom(this.body, selector);
  }

  querySelectorAll(selector) {
    return querySelectorAllFrom(this.body, selector);
  }

  getElementById(id) {
    return querySelectorFrom(this.body, `#${id}`);
  }
}

function setOwnerDocument(element, doc) {
  element.ownerDocument = doc;
  for (const child of element.childNodes) setOwnerDocument(child, doc);
}

function walk(root) {
  const nodes = [];
  const visit = (node) => {
    if (!node) return;
    nodes.push(node);
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return nodes;
}

function matchesSelector(element, selector) {
  if (!element || typeof selector !== 'string') return false;
  const trimmed = selector.trim();
  if (trimmed === '[id]') return Boolean(element.id);
  if (trimmed === '[data-pane-id]') return Boolean(element.dataset?.paneId);
  if (trimmed.startsWith('#')) return element.id === trimmed.slice(1);

  const classAttrMatch = trimmed.match(/^\.([a-zA-Z0-9_-]+)\[data-([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
  if (classAttrMatch) {
    const [, className, dataName, expected] = classAttrMatch;
    const key = dataName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return element.classList.contains(className) && String(element.dataset?.[key] || '') === expected;
  }

  const classOnlyMatch = trimmed.match(/^\.([a-zA-Z0-9_-]+)$/);
  if (classOnlyMatch) return element.classList.contains(classOnlyMatch[1]);

  const attrOnlyMatch = trimmed.match(/^\[data-([a-zA-Z0-9_-]+)(?:="([^"]+)")?\]$/);
  if (attrOnlyMatch) {
    const [, dataName, expected] = attrOnlyMatch;
    const key = dataName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (expected === undefined) return element.dataset?.[key] !== undefined;
    return String(element.dataset?.[key] || '') === expected;
  }

  return false;
}

function querySelectorAllFrom(root, selector) {
  const selectors = String(selector || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return walk(root).filter((element) => selectors.some((entry) => matchesSelector(element, entry)));
}

function querySelectorFrom(root, selector) {
  return querySelectorAllFrom(root, selector)[0] || null;
}

function makePane(id, label) {
  return new FakeElement('div', {
    className: 'pane',
    dataset: { paneId: id },
  }, [
    new FakeElement('span', { className: 'pane-title' }, [
      new FakeElement('span', { className: 'agent-badge idle', id: `badge-${id}` }),
      new FakeElement('button', { className: 'pane-role-info-btn', dataset: { paneId: id }, textContent: label }),
      new FakeElement('span', { className: 'cli-badge', id: `cli-badge-${id}` }),
      new FakeElement('span', { className: 'pane-project', id: `project-${id}` }),
      new FakeElement('span', { className: 'agent-task', id: `task-${id}` }),
    ]),
    new FakeElement('button', { className: 'pane-action-btn', dataset: { paneId: id } }),
    new FakeElement('span', { className: 'lock-icon', id: `lock-icon-${id}`, dataset: { paneId: id } }),
    new FakeElement('div', { className: 'pane-terminal', id: `terminal-${id}` }),
    new FakeElement('span', { id: `status-${id}` }),
  ]);
}

function makeDocument() {
  return new FakeDocument(new FakeElement('body', {}, [
    new FakeElement('div', { className: 'project-indicator' }, [
      new FakeElement('span', { className: 'project-path no-project', id: 'projectPath', textContent: 'SquidRun home' }),
    ]),
    new FakeElement('div', { className: 'main-pane-container' }, [makePane('1', 'Mira')]),
    new FakeElement('div', { className: 'side-panes-container' }, [makePane('2', 'Builder'), makePane('3', 'Oracle')]),
    new FakeElement('form', { className: 'command-bar' }),
    new FakeElement('section', { className: 'squid-room-surface', id: 'squidRoomSurface' }, [
      new FakeElement('div', { className: 'squid-room-app', dataset: { appRoomId: 'trustquote' } }, [
        new FakeElement('div', { className: 'squid-room-live-panes', id: 'squidRoomTrustQuoteLivePanes' }),
      ]),
    ]),
  ]));
}

describe('workspace pane shell', () => {
  test('main workspace keeps the default pane ids', () => {
    const doc = makeDocument();
    const terminal = { setActivePaneIds: jest.fn() };

    configureWorkspacePaneShell({ windowKey: 'main' }, terminal, doc);

    expect(terminal.setActivePaneIds).toHaveBeenCalledWith(null);
    expect(doc.body.classList.contains('squid-room')).toBe(false);
    expect(doc.querySelector('.abyss-motes')).toBeFalsy();
    expect(doc.getElementById('terminal-2')).toBeTruthy();
    expect(doc.getElementById('terminal-3')).toBeTruthy();
    expect(doc.getElementById(`terminal-trustquote-${'builder'}`)).toBeFalsy();
  });

  test('Squid Room hides Architect, frees Builder/Oracle creatures, and keeps real terminals in a drawer', () => {
    const doc = makeDocument();
    const terminal = { setActivePaneIds: jest.fn(), setPaneRuntimeOverride: jest.fn() };
    doc.getElementById('squidRoomSurface').hidden = true;

    const result = configureWorkspacePaneShell({ windowKey: 'squid-room' }, terminal, doc);

    expect(result).toEqual(expect.objectContaining({
      workspaceKey: 'squid-room',
      paneIds: ['2', '3', 'trustquote-lead', 'trustquote-schedule-dispatch', 'trustquote-app', 'trustquote-invoice'],
      teamPaneIds: ['2', '3'],
    }));
    expect(doc.body.classList.contains('squid-room-workspace')).toBe(true);
    expect(doc.body.classList.contains('squid-room')).toBe(true);
    expect(doc.querySelector('.abyss-motes')).toBeTruthy();
    expect(doc.querySelector('.abyss-motes').childNodes).toHaveLength(12);
    expect(doc.querySelector('.squid-room-pet-filters')).toBeTruthy();
    expect(doc.body.classList.contains(`trustquote-${'workspace'}`)).toBe(false);
    expect(terminal.setActivePaneIds).toHaveBeenCalledWith([
      '2',
      '3',
      'trustquote-lead',
      'trustquote-schedule-dispatch',
      'trustquote-app',
      'trustquote-invoice',
    ]);
    expect(terminal.setPaneRuntimeOverride).toHaveBeenCalledTimes(4);
    expect(terminal.setPaneRuntimeOverride).toHaveBeenCalledWith(
      'trustquote-lead',
      expect.objectContaining({
        workingDir: 'D:\\projects\\TrustQuote',
        spawnCommandOnCreate: true,
        recreateOnWorkingDirMismatch: true,
      })
    );
    expect(terminal.setPaneRuntimeOverride).toHaveBeenCalledWith(
      'trustquote-app',
      expect.objectContaining({
        roleId: 'trustquote-app',
        routeTarget: 'trustquote-app',
        command: 'codex --yolo',
        commandSourcePaneId: '2',
        workingDir: 'D:\\projects\\TrustQuote',
        spawnCommandOnCreate: true,
      })
    );
    expect(doc.querySelector('.pane[data-pane-id="1"]').hidden).toBe(true);
    expect(doc.querySelector('.pane[data-pane-id="2"]').hidden).toBe(false);
    expect(doc.querySelector('.pane[data-pane-id="3"]').hidden).toBe(false);
    expect(doc.querySelector('.pane[data-pane-id="2"]').classList.contains('squid-room-core-terminal-pane')).toBe(true);
    expect(doc.querySelector('.pane[data-pane-id="3"]').classList.contains('squid-room-core-terminal-pane')).toBe(true);
    expect(doc.querySelector('#squidRoomCreatureOcean')).toBeTruthy();
    expect(doc.querySelector('#squidRoomTerminalDrawer')).toBeTruthy();
    expect(doc.querySelector('.squid-room-terminal-drawer-panes').querySelector('.pane[data-pane-id="2"]')).toBeTruthy();
    expect(doc.querySelector('.squid-room-terminal-drawer-panes').querySelector('.pane[data-pane-id="3"]')).toBeTruthy();
    const builderCreature = doc.querySelector('[data-squid-room-pet="builder"]');
    const oracleCreature = doc.querySelector('[data-squid-room-pet="oracle"]');
    // Room remodel v2 (mount step 2): presentation classes are sr2-.
    expect(builderCreature.classList.contains('sr2-creature-stage')).toBe(true);
    expect(oracleCreature.classList.contains('sr2-creature-stage')).toBe(true);
    expect(builderCreature.dataset.paneId).toBeUndefined();
    expect(oracleCreature.dataset.paneId).toBeUndefined();
    expect(builderCreature.dataset.squidRoomSourcePaneId).toBe('2');
    expect(oracleCreature.dataset.squidRoomSourcePaneId).toBe('3');
    expect(builderCreature.dataset.squidRoomPetAsset).toBe('builder-squid');
    expect(oracleCreature.dataset.squidRoomPetAsset).toBe('oracle-squid');
    // P1.7: procedural creature canvases replace the sprite atlases.
    const builderCanvas = builderCreature.querySelector('.sr2-creature-canvas');
    const oracleCanvas = oracleCreature.querySelector('.sr2-creature-canvas');
    expect(builderCanvas).toBeTruthy();
    expect(oracleCanvas).toBeTruthy();
    expect(builderCanvas.dataset.squidRoomCreature).toBe('builder');
    expect(oracleCanvas.dataset.squidRoomCreature).toBe('oracle');
    expect(builderCreature.querySelector('.squid-room-codex-pet-builder-squid')).toBeFalsy();
    expect(builderCreature.querySelector('.sr2-name-tag').textContent).toBe('Builder');
    expect(oracleCreature.querySelector('.sr2-name-tag').textContent).toBe('Oracle');
    // Mount step 2: the caption/face-line corpse is gone from the DOM whole.
    expect(builderCreature.querySelector('.squid-room-pet-caption')).toBeFalsy();
    expect(builderCreature.querySelector('.face-details')).toBeFalsy();
    // S465 purge: speech is Oracle's viewport-solved system; the old bubble
    // and the sprite-era motion track are gone (the track's CSS animation
    // broke name-tag anchoring from beyond the grave).
    expect(builderCreature.querySelector('.squid-room-pet-speech')).toBeFalsy();
    expect(builderCreature.querySelector('.speech-line-text')).toBeFalsy();
    expect(builderCreature.querySelector('.verb-chip')).toBeFalsy();
    expect(builderCreature.querySelector('.pet-motion-track')).toBeFalsy();
    // S466: the pedestal-era glow discs are gone too — free-swimming
    // creatures sit on nothing (James caught the blurred smudges live).
    expect(builderCreature.querySelector('.pet-glow')).toBeFalsy();
    expect(builderCreature.querySelector('.pet-caustics')).toBeFalsy();
    // P1.7: bubbles, ink bursts, and grounding shadow are ENGINE-drawn on the
    // creature canvas now - the CSS effect spans are gone by design.
    expect(builderCreature.querySelector('.pet-contact-shadow')).toBeFalsy();
    expect(builderCreature.querySelector('.pet-ink-burst')).toBeFalsy();
    expect(builderCreature.querySelector('.bubble-1')).toBeFalsy();
    // Builder/Oracle terminal controls live in the drawer; the creatures are
    // presentation-only and cannot duplicate terminal pane ids.
    for (const corePaneId of ['2', '3']) {
      const terminalPane = doc.querySelector(`.pane[data-pane-id="${corePaneId}"]`);
      expect(terminalPane.querySelector(`#terminal-${corePaneId}`)).toBeTruthy();
    }
    // Mount step 2: face-line text left the DOM with the caption corpse -
    // live text renders only in Oracle's speech layer (constitution V.4).
    expect(builderCreature.querySelector('.face-line-text')).toBeFalsy();
    expect(oracleCreature.querySelector('.face-line-text')).toBeFalsy();
    expect(doc.querySelector('.squid-room-team-header')).toBeTruthy();
    expect(doc.querySelector('.squid-room-team-eyebrow').textContent).toBe('Ocean');
    expect(doc.querySelector('.squid-room-team-expand-btn').dataset.paneId).toBe('2');
    expect(doc.querySelector('.squid-room-team-expand-btn').dataset.tooltip).toContain('Builder + Oracle');
    expect(doc.querySelector('.squid-room-team-expand-btn').dataset.expanded).toBe('true');
    expect(doc.querySelector('.squid-room-team-expand-btn').getAttribute('aria-expanded')).toBe('true');
    expect(doc.querySelector('.squid-room-team-expand-btn').querySelector('.squid-room-team-toggle-label').textContent).toBe('Collapse');
    expect(doc.getElementById('terminal-2')).toBeTruthy();
    expect(doc.getElementById('terminal-3')).toBeTruthy();
    expect(doc.getElementById(`terminal-trustquote-${'builder'}`)).toBeFalsy();
    expect(doc.getElementById('terminal-trustquote-lead')).toBeTruthy();
    expect(doc.getElementById('terminal-trustquote-schedule-dispatch')).toBeTruthy();
    expect(doc.getElementById('terminal-trustquote-app')).toBeTruthy();
    expect(doc.getElementById('terminal-trustquote-invoice')).toBeTruthy();
    for (const paneId of ['trustquote-lead', 'trustquote-schedule-dispatch', 'trustquote-app', 'trustquote-invoice']) {
      const pane = doc.querySelector(`.pane[data-pane-id="${paneId}"]`);
      expect(pane.querySelector('.agent-avatar').innerHTML).toContain('avatar-icon');
      const armSelector = pane.querySelector(`.model-selector[data-pane-id="${paneId}"]`);
      expect(armSelector).toBeTruthy();
      expect(armSelector.classList.contains('squid-room-arm-model-selector')).toBe(true);
      expect(armSelector.dataset.squidRoomArmModelSelector).toBe('true');
      expect(armSelector.value).toBe('codex');
      expect(armSelector.childNodes.map((option) => option.value)).toEqual([
        'claude',
        'claude:fable',
        'claude:opus',
        'claude:sonnet',
        'codex',
        'gemini',
      ]);
      expect(pane.querySelector(`.model-badge[data-pane-id="${paneId}"]`)).toBeFalsy();
      expect(pane.querySelector(`.pane-role-info-btn[data-pane-id="${paneId}"]`).innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector(`.fresh-session-btn[data-pane-id="${paneId}"]`).innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector('.interrupt-btn').innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector('.unstick-btn').innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector('.kickoff-btn').innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector('.expand-btn').innerHTML).toContain('pane-btn-icon');
      expect(pane.querySelector(`.lock-icon[data-pane-id="${paneId}"]`).innerHTML).toContain('pane-btn-icon');
    }
    expect(doc.getElementById('squidRoomSurface').hidden).toBe(false);
  });

  test('keeps Squid Room P1.5 formatting reserves in CSS', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'squid-room.css'), 'utf8');

    expect(css).toMatch(/body\.squid-room-workspace \.terminals-section\s*\{[^}]*padding:\s*14px 14px 22px/s);
    expect(css).toMatch(/scrollbar-color:\s*rgba\(94,\s*234,\s*212,\s*0\.45\)/);
    expect(css).toMatch(/body\.squid-room-workspace \.squid-room-live-panes \.pane\s*\{[^}]*padding-bottom:\s*12px/s);
    expect(css).toMatch(/body\.squid-room-workspace \.squid-room-live-panes \.pane-terminal\s*\{[^}]*calc\(100% - 12px\)/s);
    expect(css).toMatch(/radial-gradient\(ellipse at 50% 100%,\s*rgba\(94,\s*234,\s*212,\s*0\.055\)/);
    expect(css).toMatch(/linear-gradient\(180deg,[^;]*rgba\(0,\s*1,\s*4,\s*1\) 100%\)/s);
  });

  test('sprite-era motion CSS stays dead; live creature surfaces remain', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'squid-room.css'), 'utf8');

    expect(css).toMatch(/\.squid-room-creature-ocean/);
    // S465 purge 2b: the sprite-era swim/track animation library is deleted
    // (motion is engine-drawn; the track's animation broke name-tag
    // anchoring from beyond the grave). Pin the absences so it stays dead.
    expect(css).not.toMatch(/@keyframes squid-room-swim-active/);
    expect(css).not.toMatch(/\.pet-motion-track/);
    expect(css).not.toMatch(/\.squid-room-codex-pet/);
    expect(css).not.toMatch(/\.squid-room-pet-speech/);
    expect(css).toMatch(/\.squid-room-pane-menu\.is-fixed-positioned \.squid-room-pane-menu-panel\s*\{[^}]*position:\s*fixed/s);
  });
});
