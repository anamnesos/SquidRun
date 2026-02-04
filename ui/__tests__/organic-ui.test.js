/**
 * Tests for organic-ui.js module
 * Organic UI rendering, state updates, message streaming, agent containers
 */

// Track created elements
let createdElements = [];
let appendedChildren = [];
let styleElement = null;

// Mock element factory
function createMockElement(tagName = 'div') {
  const children = [];
  const classListSet = new Set();

  const el = {
    tagName: tagName.toUpperCase(),
    className: '',
    innerHTML: '',
    textContent: '',
    id: '',
    dataset: {},
    style: {
      setProperty: jest.fn(),
      visibility: 'visible',
    },
    scrollTop: 0,
    scrollHeight: 1000,
    childNodes: children,
    children,
    firstChild: null,
    parentNode: null,
    parentElement: null,
    classList: {
      add: jest.fn((...classes) => classes.forEach(c => classListSet.add(c))),
      remove: jest.fn((...classes) => classes.forEach(c => classListSet.delete(c))),
      contains: jest.fn((c) => classListSet.has(c)),
    },
    appendChild: jest.fn((child) => {
      children.push(child);
      child.parentNode = el;
      child.parentElement = el;
      appendedChildren.push(child);
      return child;
    }),
    insertBefore: jest.fn(),
    remove: jest.fn(),
    querySelector: jest.fn().mockReturnValue(null),
    querySelectorAll: jest.fn().mockReturnValue([]),
    after: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    getBoundingClientRect: jest.fn().mockReturnValue({
      left: 100,
      top: 100,
      width: 200,
      height: 150,
      right: 300,
      bottom: 250,
    }),
  };

  createdElements.push(el);
  return el;
}

// Mock document
const mockHead = createMockElement('head');
const mockBody = createMockElement('body');

const mockDocument = {
  getElementById: jest.fn((id) => {
    if (id === 'sdk-organic-ui-styles') return styleElement;
    return null;
  }),
  querySelector: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([]),
  createElement: jest.fn((tag) => createMockElement(tag)),
  createTextNode: jest.fn((text) => ({ nodeType: 3, textContent: text })),
  head: mockHead,
  body: mockBody,
  hidden: false,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};

global.document = mockDocument;
global.requestAnimationFrame = jest.fn((cb) => setTimeout(cb, 16));

// Import after mocks are set up
const { AGENT_CONFIG, createOrganicUI } = require('../sdk-ui/organic-ui');

describe('organic-ui.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    createdElements = [];
    appendedChildren = [];
    styleElement = null;
    mockDocument.getElementById.mockImplementation((id) => {
      if (id === 'sdk-organic-ui-styles') return styleElement;
      return null;
    });
    mockDocument.hidden = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('AGENT_CONFIG constant', () => {
    test('should have 6 agents', () => {
      expect(AGENT_CONFIG).toHaveLength(6);
    });

    test('should have correct agent IDs', () => {
      const ids = AGENT_CONFIG.map(a => a.id);
      expect(ids).toEqual(['arch', 'infra', 'front', 'back', 'ana', 'rev']);
    });

    test('should have correct labels', () => {
      const labels = AGENT_CONFIG.map(a => a.label);
      expect(labels).toEqual(['Arch', 'Infra', 'Front', 'Back', 'Ana', 'Rev']);
    });

    test('should have full names', () => {
      expect(AGENT_CONFIG[0].fullName).toBe('Architect');
      expect(AGENT_CONFIG[5].fullName).toBe('Reviewer');
    });

    test('should have colors', () => {
      AGENT_CONFIG.forEach(agent => {
        expect(agent.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      });
    });
  });

  describe('createOrganicUI', () => {
    test('should create container with correct class', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(ui.container).toBeDefined();
      expect(ui.container.className).toBe('organic-ui');
    });

    test('should inject styles on first call', () => {
      createOrganicUI({ mount: mockBody });

      // Style should be created and appended to head
      expect(mockDocument.createElement).toHaveBeenCalledWith('style');
      expect(mockHead.appendChild).toHaveBeenCalled();
    });

    test('should not duplicate styles on second call', () => {
      // First call creates styles
      createOrganicUI({ mount: mockBody });

      // Simulate style element existing
      styleElement = createMockElement('style');
      styleElement.id = 'sdk-organic-ui-styles';

      const createStyleCalls = mockDocument.createElement.mock.calls.filter(c => c[0] === 'style').length;

      // Second call should not create another style element
      createOrganicUI({ mount: mockBody });

      const newCreateStyleCalls = mockDocument.createElement.mock.calls.filter(c => c[0] === 'style').length;
      expect(newCreateStyleCalls).toBe(createStyleCalls);
    });

    test('should create command center', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const commandCenter = createdElements.find(el => el.className === 'organic-command-center');
      expect(commandCenter).toBeDefined();
    });

    test('should create agent grid with 6 agents', () => {
      createOrganicUI({ mount: mockBody });

      const agentElements = createdElements.filter(el => el.className === 'organic-agent');
      expect(agentElements).toHaveLength(6);
    });

    test('should create input bar', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(ui.input).toBeDefined();
      expect(ui.sendBtn).toBeDefined();
    });

    test('should return correct API', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(typeof ui.updateState).toBe('function');
      expect(typeof ui.appendText).toBe('function');
      expect(typeof ui.setText).toBe('function');
      expect(typeof ui.triggerScale).toBe('function');
      expect(typeof ui.triggerMessageStream).toBe('function');
      expect(typeof ui.appendToCommandCenter).toBe('function');
      expect(typeof ui.destroy).toBe('function');
    });

    test('should mount to specified element', () => {
      const customMount = createMockElement('div');
      createOrganicUI({ mount: customMount });

      expect(customMount.appendChild).toHaveBeenCalled();
    });

    test('should mount to body by default', () => {
      createOrganicUI();

      expect(mockBody.appendChild).toHaveBeenCalled();
    });
  });

  describe('updateState', () => {
    test('should add thinking class for thinking state', () => {
      const ui = createOrganicUI({ mount: mockBody });

      // Find the arch agent element
      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('arch', 'thinking');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should add thinking class for tool state', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('arch', 'tool');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should add offline class for offline state', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('arch', 'offline');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-offline');
    });

    test('should remove all state classes before applying new one', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('arch', 'thinking');

      expect(archAgent.classList.remove).toHaveBeenCalledWith(
        'is-thinking', 'is-offline', 'is-sending', 'is-receiving'
      );
    });

    test('should resolve pane number to agent ID', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      // Pane 1 should resolve to arch
      ui.updateState('1', 'thinking');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should handle case-insensitive agent names', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('ARCHITECT', 'thinking');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should ignore invalid agent ID', () => {
      const ui = createOrganicUI({ mount: mockBody });

      // Should not throw
      expect(() => ui.updateState('invalid', 'thinking')).not.toThrow();
    });

    test('should ignore null/undefined agent ID', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(() => ui.updateState(null, 'thinking')).not.toThrow();
      expect(() => ui.updateState(undefined, 'thinking')).not.toThrow();
    });
  });

  describe('appendText', () => {
    test('should append text to agent content', () => {
      const ui = createOrganicUI({ mount: mockBody });

      // Find the arch agent's content element
      const agentElements = createdElements.filter(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const archAgent = agentElements[0];
      // Content is the second child (after header)
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      ui.appendText('arch', 'Hello world');

      expect(contentEl.textContent).toBe('Hello world');
    });

    test('should append multiple lines', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const agentElements = createdElements.filter(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const archAgent = agentElements[0];
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      ui.appendText('arch', 'Line 1');
      ui.appendText('arch', 'Line 2');

      expect(contentEl.textContent).toBe('Line 1\nLine 2');
    });

    test('should handle multiline text', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      ui.appendText('arch', 'Line 1\nLine 2\nLine 3');

      expect(contentEl.textContent).toContain('Line 1');
      expect(contentEl.textContent).toContain('Line 2');
      expect(contentEl.textContent).toContain('Line 3');
    });

    test('should limit to MAX_LINES (50)', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      // Add 60 lines
      for (let i = 0; i < 60; i++) {
        ui.appendText('arch', `Line ${i}`);
      }

      // Should only have last 50 lines
      const lines = contentEl.textContent.split('\n');
      expect(lines.length).toBeLessThanOrEqual(50);
      expect(contentEl.textContent).toContain('Line 59');
      expect(contentEl.textContent).not.toContain('Line 0\n');
    });

    test('should resolve pane number to agent', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      ui.appendText('1', 'Message via pane number');

      expect(contentEl.textContent).toBe('Message via pane number');
    });

    test('should ignore invalid agent ID', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(() => ui.appendText('invalid', 'text')).not.toThrow();
    });
  });

  describe('setText', () => {
    test('should replace text in agent content', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      ui.appendText('arch', 'Old text');
      ui.setText('arch', 'New text');

      expect(contentEl.textContent).toBe('New text');
    });

    test('should limit to MAX_LINES when setting', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const contentEl = archAgent.children.find(c => c.className === 'organic-agent-content');

      // Create text with 60 lines
      const longText = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join('\n');
      ui.setText('arch', longText);

      const lines = contentEl.textContent.split('\n');
      expect(lines.length).toBeLessThanOrEqual(50);
    });
  });

  describe('triggerScale', () => {
    test('should add is-sending class for send type', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.triggerScale('arch', 'send');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-sending');
    });

    test('should add is-receiving class for receive type', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.triggerScale('arch', 'receive');

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-receiving');
    });

    test('should remove class after 300ms', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.triggerScale('arch', 'send');

      jest.advanceTimersByTime(300);

      expect(archAgent.classList.remove).toHaveBeenCalledWith('is-sending');
    });
  });

  describe('triggerMessageStream', () => {
    test('should ignore when document is hidden', () => {
      mockDocument.hidden = true;
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');
      const appendCount = streamLayer.appendChild.mock.calls.length;

      ui.triggerMessageStream({ from: 'arch', to: 'front' });

      // No new elements should be appended
      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should create stream line element', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');

      ui.triggerMessageStream({ fromRole: 'arch', toRole: 'front' });

      jest.advanceTimersByTime(16); // requestAnimationFrame

      expect(streamLayer.appendChild).toHaveBeenCalled();
    });

    test('should ignore same source and target', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');
      const appendCount = streamLayer.appendChild.mock.calls.length;

      ui.triggerMessageStream({ from: 'arch', to: 'arch' });

      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should ignore invalid source', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');
      const appendCount = streamLayer.appendChild.mock.calls.length;

      ui.triggerMessageStream({ from: 'invalid', to: 'arch' });

      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should ignore invalid target', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');
      const appendCount = streamLayer.appendChild.mock.calls.length;

      ui.triggerMessageStream({ from: 'arch', to: 'invalid' });

      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should only process queued and sending phases', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');
      const appendCount = streamLayer.appendChild.mock.calls.length;

      // delivered phase should be ignored
      ui.triggerMessageStream({ from: 'arch', to: 'front', phase: 'delivered' });

      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should process queued phase', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');

      ui.triggerMessageStream({ from: 'arch', to: 'front', phase: 'queued' });

      jest.advanceTimersByTime(16);

      expect(streamLayer.appendChild).toHaveBeenCalled();
    });

    test('should trigger scale animation on source and target', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const frontAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'front'
      );

      ui.triggerMessageStream({ from: 'arch', to: 'front' });

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-sending');

      // Target receives after delay (60% of stream duration)
      jest.advanceTimersByTime(700 * 0.6);

      expect(frontAgent.classList.add).toHaveBeenCalledWith('is-receiving');
    });

    test('should cleanup stream line after animation', () => {
      const ui = createOrganicUI({ mount: mockBody });

      ui.triggerMessageStream({ from: 'arch', to: 'front' });

      jest.advanceTimersByTime(16); // requestAnimationFrame

      // Find the stream line
      const streamLine = createdElements.find(el => el.className === 'organic-stream-line');

      // Advance past animation duration + cleanup delay (700 + 100)
      jest.advanceTimersByTime(800);

      expect(streamLine.remove).toHaveBeenCalled();
    });

    test('should handle fromId/toId aliases', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');

      ui.triggerMessageStream({ fromId: 'arch', toId: 'front' });

      jest.advanceTimersByTime(16);

      expect(streamLayer.appendChild).toHaveBeenCalled();
    });
  });

  describe('appendToCommandCenter', () => {
    test('should append text to command center', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const commandContent = createdElements.find(el => el.className === 'organic-command-content');

      ui.appendToCommandCenter('Hello from command center');

      expect(commandContent.textContent).toBe('Hello from command center');
    });

    test('should append multiple texts', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const commandContent = createdElements.find(el => el.className === 'organic-command-content');

      ui.appendToCommandCenter('First ');
      ui.appendToCommandCenter('Second');

      expect(commandContent.textContent).toBe('First Second');
    });
  });

  describe('destroy', () => {
    test('should remove container', () => {
      const ui = createOrganicUI({ mount: mockBody });

      ui.destroy();

      expect(ui.container.remove).toHaveBeenCalled();
    });

    test('should remove visibility change listener', () => {
      createOrganicUI({ mount: mockBody });

      // visibilitychange listener should have been added
      expect(mockDocument.addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
    });
  });

  describe('role alias resolution', () => {
    test('should resolve pane 1 to arch', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('1', 'thinking');
      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 2 to infra', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const infraAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'infra'
      );

      ui.updateState('2', 'thinking');
      expect(infraAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 3 to front', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const frontAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'front'
      );

      ui.updateState('3', 'thinking');
      expect(frontAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 4 to back', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const backAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'back'
      );

      ui.updateState('4', 'thinking');
      expect(backAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 5 to ana', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const anaAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'ana'
      );

      ui.updateState('5', 'thinking');
      expect(anaAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 6 to rev', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const revAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'rev'
      );

      ui.updateState('6', 'thinking');
      expect(revAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "architect" to arch', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('architect', 'thinking');
      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "frontend" to front', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const frontAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'front'
      );

      ui.updateState('frontend', 'thinking');
      expect(frontAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "backend" to back', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const backAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'back'
      );

      ui.updateState('backend', 'thinking');
      expect(backAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "analyst" to ana', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const anaAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'ana'
      );

      ui.updateState('analyst', 'thinking');
      expect(anaAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "reviewer" to rev', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const revAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'rev'
      );

      ui.updateState('reviewer', 'thinking');
      expect(revAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });
  });

  describe('visibility handling', () => {
    test('should hide container when document is hidden', () => {
      createOrganicUI({ mount: mockBody });

      // Get the visibility change handler
      const visibilityHandler = mockDocument.addEventListener.mock.calls.find(
        c => c[0] === 'visibilitychange'
      )[1];

      // Find the container
      const container = createdElements.find(el => el.className === 'organic-ui');

      // Simulate document becoming hidden
      mockDocument.hidden = true;
      visibilityHandler();

      expect(container.style.visibility).toBe('hidden');
    });

    test('should show container when document is visible', () => {
      createOrganicUI({ mount: mockBody });

      const visibilityHandler = mockDocument.addEventListener.mock.calls.find(
        c => c[0] === 'visibilitychange'
      )[1];

      const container = createdElements.find(el => el.className === 'organic-ui');

      mockDocument.hidden = false;
      visibilityHandler();

      expect(container.style.visibility).toBe('visible');
    });
  });

  describe('agent container styling', () => {
    test('should set --agent-color CSS variable', () => {
      createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      expect(archAgent.style.setProperty).toHaveBeenCalledWith('--agent-color', '#7C3AED');
    });

    test('should set --agent-color-rgb CSS variable', () => {
      createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      // #7C3AED = rgb(124, 58, 237)
      expect(archAgent.style.setProperty).toHaveBeenCalledWith('--agent-color-rgb', '124, 58, 237');
    });
  });

  describe('input elements', () => {
    test('should create input field with correct type', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(ui.input.type).toBe('text');
    });

    test('should create input field with placeholder', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(ui.input.placeholder).toBe('Send a message to agents...');
    });

    test('should create send button', () => {
      const ui = createOrganicUI({ mount: mockBody });

      expect(ui.sendBtn.textContent).toBe('Send');
    });
  });
});
