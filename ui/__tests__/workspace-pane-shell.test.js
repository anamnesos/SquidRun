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
    if (name === 'aria-hidden') this.ariaHidden = String(value);
  }

  removeAttribute(name) {
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
      new FakeElement('span', { className: 'project-path no-project', id: 'projectPath', textContent: 'Developer Mode' }),
    ]),
    new FakeElement('div', { className: 'main-pane-container' }, [makePane('1', 'Mira')]),
    new FakeElement('div', { className: 'side-panes-container' }, [makePane('2', 'Builder'), makePane('3', 'Oracle')]),
  ]));
}

describe('workspace pane shell', () => {
  test('TrustQuote workspace retargets the visible panes to the live TrustQuote terminal ids', () => {
    const doc = makeDocument();
    const terminal = { setActivePaneIds: jest.fn() };

    const result = configureWorkspacePaneShell({ windowKey: 'trustquote' }, terminal, doc);

    expect(result.paneIds).toEqual(['trustquote-builder', 'trustquote-oracle']);
    expect(terminal.setActivePaneIds).toHaveBeenCalledWith(['trustquote-builder', 'trustquote-oracle']);
    expect(doc.querySelector('.pane[data-pane-id="1"]').hidden).toBe(true);
    expect(doc.getElementById('terminal-trustquote-builder')).toBeTruthy();
    expect(doc.getElementById('terminal-trustquote-oracle')).toBeTruthy();
    expect(doc.getElementById('projectPath').textContent).toBe('D:\\projects\\TrustQuote');
    expect(doc.querySelector('.pane[data-pane-id="trustquote-builder"]').querySelector('.workspace-pane-label').textContent).toBe('TrustQuote Builder');
    expect(doc.querySelector('.pane[data-pane-id="trustquote-oracle"]').querySelector('.workspace-pane-label').textContent).toBe('TrustQuote Oracle');
    expect(doc.querySelector('.pane[data-pane-id="trustquote-builder"]').querySelector('[data-pane-id]')).toBeTruthy();
    expect(doc.querySelector('.pane[data-pane-id="trustquote-oracle"]').querySelector('[data-pane-id]')).toBeTruthy();
  });

  test('main workspace keeps the default pane ids', () => {
    const doc = makeDocument();
    const terminal = { setActivePaneIds: jest.fn() };

    configureWorkspacePaneShell({ windowKey: 'main' }, terminal, doc);

    expect(terminal.setActivePaneIds).toHaveBeenCalledWith(null);
    expect(doc.getElementById('terminal-2')).toBeTruthy();
    expect(doc.getElementById('terminal-3')).toBeTruthy();
    expect(doc.getElementById('terminal-trustquote-builder')).toBeFalsy();
  });
});
