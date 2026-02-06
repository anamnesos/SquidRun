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
  let _innerHTML = '';
  let _textContent = '';

  const el = {
    tagName: tagName.toUpperCase(),
    className: '',
    get innerHTML() { return _innerHTML; },
    set innerHTML(val) {
      _innerHTML = val;
      if (val === '') {
        _textContent = '';
        children.length = 0;
      }
    },
    get textContent() { 
      if (children.length > 0) {
        return children.map(c => c.textContent).join('');
      }
      return _textContent; 
    },
    set textContent(val) {
      _textContent = val;
      if (val === '') {
        _innerHTML = '';
        children.length = 0;
      }
    },
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
    test('should have 3 agents', () => {
      expect(AGENT_CONFIG).toHaveLength(3);
    });

    test('should have correct agent IDs', () => {
      const ids = AGENT_CONFIG.map(a => a.id);
      expect(ids).toEqual(['arch', 'devops', 'ana']);
    });

    test('should have correct labels', () => {
      const labels = AGENT_CONFIG.map(a => a.label);
      expect(labels).toEqual(['Arch', 'DevOps', 'Ana']);
    });

    test('should have full names', () => {
      expect(AGENT_CONFIG[0].fullName).toBe('Architect');
      expect(AGENT_CONFIG[2].fullName).toBe('Analyst');
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

    test('should create agent grid with 3 agents', () => {
      createOrganicUI({ mount: mockBody });

      const agentElements = createdElements.filter(el => el.className === 'organic-agent');
      expect(agentElements).toHaveLength(3);
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

      ui.triggerMessageStream({ from: 'arch', to: 'devops' });

      // No new elements should be appended
      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should create stream line element', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');

      ui.triggerMessageStream({ fromRole: 'arch', toRole: 'devops' });

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
      ui.triggerMessageStream({ from: 'arch', to: 'devops', phase: 'delivered' });

      expect(streamLayer.appendChild.mock.calls.length).toBe(appendCount);
    });

    test('should process queued phase', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const streamLayer = createdElements.find(el => el.className === 'organic-stream-layer');

      ui.triggerMessageStream({ from: 'arch', to: 'devops', phase: 'queued' });

      jest.advanceTimersByTime(16);

      expect(streamLayer.appendChild).toHaveBeenCalled();
    });

    test('should trigger scale animation on source and target', () => {
      const ui = createOrganicUI({ mount: mockBody });

      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );
      const devopsAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'devops'
      );

      ui.triggerMessageStream({ from: 'arch', to: 'devops' });

      expect(archAgent.classList.add).toHaveBeenCalledWith('is-sending');

      // Target receives after delay (60% of stream duration)
      jest.advanceTimersByTime(700 * 0.6);

      expect(devopsAgent.classList.add).toHaveBeenCalledWith('is-receiving');
    });

    test('should cleanup stream line after animation', () => {
      const ui = createOrganicUI({ mount: mockBody });

      ui.triggerMessageStream({ from: 'arch', to: 'devops' });

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

      ui.triggerMessageStream({ fromId: 'arch', toId: 'devops' });

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

    test('should resolve pane 2 to devops', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const devopsAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'devops'
      );

      ui.updateState('2', 'thinking');
      expect(devopsAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve pane 5 to ana', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const anaAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'ana'
      );

      ui.updateState('5', 'thinking');
      expect(anaAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "architect" to arch', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const archAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'arch'
      );

      ui.updateState('architect', 'thinking');
      expect(archAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "backend" to devops', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const devopsAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'devops'
      );

      ui.updateState('backend', 'thinking');
      expect(devopsAgent.classList.add).toHaveBeenCalledWith('is-thinking');
    });

    test('should resolve "analyst" to ana', () => {
      const ui = createOrganicUI({ mount: mockBody });
      const anaAgent = createdElements.find(el =>
        el.className === 'organic-agent' && el.dataset.agent === 'ana'
      );

      ui.updateState('analyst', 'thinking');
      expect(anaAgent.classList.add).toHaveBeenCalledWith('is-thinking');
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

  describe('War Room UI Phase 1', () => {
    describe('layout structure', () => {
      test('should create war room wrapper', () => {
        createOrganicUI({ mount: mockBody });

        const warRoomWrapper = createdElements.find(el => el.className === 'organic-war-room');
        expect(warRoomWrapper).toBeDefined();
      });

      test('should create agent grid', () => {
        createOrganicUI({ mount: mockBody });

        const agentGrid = createdElements.find(el => el.className === 'organic-agent-grid');
        expect(agentGrid).toBeDefined();
      });

      test('should have command center inside war room wrapper', () => {
        createOrganicUI({ mount: mockBody });

        const warRoomWrapper = createdElements.find(el => el.className === 'organic-war-room');
        const commandCenter = createdElements.find(el => el.className === 'organic-command-center');

        // Command center should be child of war room wrapper
        expect(warRoomWrapper).toBeDefined();
        expect(commandCenter).toBeDefined();
      });
    });

    describe('setTask', () => {
      test('should expose setTask function', () => {
        const ui = createOrganicUI({ mount: mockBody });

        expect(typeof ui.setTask).toBe('function');
      });

      test('should set task text for agent', () => {
        const ui = createOrganicUI({ mount: mockBody });

        // Find the arch agent's task text element (stored in agentElements map)
        const taskTextEl = createdElements.find(el =>
          el.className === 'organic-agent-task-text'
        );

        ui.setTask('arch', 'Implementing new feature');

        expect(taskTextEl.textContent).toBe('Implementing new feature');
      });

      test('should resolve pane number to agent', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const taskTextEl = createdElements.find(el =>
          el.className === 'organic-agent-task-text'
        );

        // Pane 1 = arch
        ui.setTask('1', 'Task via pane number');

        expect(taskTextEl.textContent).toBe('Task via pane number');
      });

      test('should handle case-insensitive agent names', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const taskTextEl = createdElements.find(el =>
          el.className === 'organic-agent-task-text'
        );

        ui.setTask('ARCHITECT', 'Task for architect');

        expect(taskTextEl.textContent).toBe('Task for architect');
      });

      test('should set dash when task is empty', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const taskTextEl = createdElements.find(el =>
          el.className === 'organic-agent-task-text'
        );

        ui.setTask('arch', '');

        expect(taskTextEl.textContent).toBe('—');
      });

      test('should set dash when task is null', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const taskTextEl = createdElements.find(el =>
          el.className === 'organic-agent-task-text'
        );

        ui.setTask('arch', null);

        expect(taskTextEl.textContent).toBe('—');
      });

      test('should ignore invalid agent ID', () => {
        const ui = createOrganicUI({ mount: mockBody });

        // Should not throw
        expect(() => ui.setTask('invalid', 'Some task')).not.toThrow();
      });
    });

    describe('status dots', () => {
      test('should create status dot in each agent header', () => {
        createOrganicUI({ mount: mockBody });

        // Status dots are created with class 'organic-status-dot is-offline' initially
        const statusDots = createdElements.filter(el =>
          el.className === 'organic-status-dot is-offline'
        );
        expect(statusDots.length).toBe(3);
      });

      test('should add is-active class for active state', () => {
        const ui = createOrganicUI({ mount: mockBody });

        // Find the first status dot (arch)
        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'active');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-active');
      });

      test('should add is-idle class for idle state', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'idle');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-idle');
      });

      test('should add is-error class for error state', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'error');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-error');
      });

      test('should add is-offline class for offline state', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'offline');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-offline');
      });

      test('should remove all status classes before applying new one', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'active');

        expect(statusDot.classList.remove).toHaveBeenCalledWith(
          'is-active', 'is-idle', 'is-error', 'is-offline'
        );
      });

      test('should map thinking state to is-active for status dot', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'thinking');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-active');
      });

      test('should map tool state to is-active for status dot', () => {
        const ui = createOrganicUI({ mount: mockBody });

        const statusDot = createdElements.find(el =>
          el.className === 'organic-status-dot is-offline'
        );

        ui.updateState('arch', 'tool');

        expect(statusDot.classList.add).toHaveBeenCalledWith('is-active');
      });
    });

    describe('task line structure', () => {
      test('should create task line container in each agent', () => {
        createOrganicUI({ mount: mockBody });

        const taskLines = createdElements.filter(el => el.className === 'organic-agent-task');
        expect(taskLines.length).toBe(3);
      });

      test('should have Working on: label', () => {
        createOrganicUI({ mount: mockBody });

        const taskLabels = createdElements.filter(el => el.className === 'organic-agent-task-label');
        expect(taskLabels.length).toBe(3);
        expect(taskLabels[0].textContent).toBe('Working on:');
      });

      test('should have task text element with default dash', () => {
        createOrganicUI({ mount: mockBody });

        const taskTexts = createdElements.filter(el => el.className === 'organic-agent-task-text');
        expect(taskTexts.length).toBe(3);
        expect(taskTexts[0].textContent).toBe('—');
      });
    });

    describe('appendWarRoomMessage (Phase 2)', () => {
      test('should expose appendWarRoomMessage function', () => {
        const ui = createOrganicUI({ mount: mockBody });

        expect(typeof ui.appendWarRoomMessage).toBe('function');
      });

      test('should create war-room-message element', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'devops', msg: 'Test message', type: 'direct' });

        const messageEl = createdElements.find(el => el.className === 'war-room-message');
        expect(messageEl).toBeDefined();
      });

      test('should add is-broadcast class for broadcast type', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'ALL', msg: 'Broadcast', type: 'broadcast' });

        const messageEl = createdElements.find(el =>
          el.className === 'war-room-message' || el.classList?.contains?.('war-room-message')
        );
        expect(messageEl.classList.add).toHaveBeenCalledWith('is-broadcast');
      });

      test('should create prefix with sender color', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'devops', msg: 'Test', type: 'direct' });

        const prefix = createdElements.find(el => el.className === 'war-room-prefix');
        expect(prefix).toBeDefined();
        // Arch color is #7C3AED
        expect(prefix.style.color).toBe('#7C3AED');
      });

      test('should format message as (FROM → TO): msg', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'devops', msg: 'Hello', type: 'direct' });

        const prefix = createdElements.find(el => el.className === 'war-room-prefix');
        expect(prefix.textContent).toBe('(ARCH → DEVOPS): ');

        const content = createdElements.find(el => el.className === 'war-room-content');
        expect(content.textContent).toBe('Hello');
      });

      test('should resolve full role names to short labels', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'architect', to: 'backend', msg: 'Test', type: 'direct' });

        const prefix = createdElements.find(el => el.className === 'war-room-prefix');
        expect(prefix.textContent).toBe('(ARCH → DEVOPS): ');
      });

      test('should handle USER as sender', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'USER', to: 'arch', msg: 'User message', type: 'direct' });

        const prefix = createdElements.find(el => el.className === 'war-room-prefix');
        expect(prefix.textContent).toBe('(YOU → ARCH): ');
        // User color is green
        expect(prefix.style.color).toBe('#22c55e');
      });

      test('should handle ALL as recipient', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'ALL', msg: 'Broadcast', type: 'broadcast' });

        const prefix = createdElements.find(el => el.className === 'war-room-prefix');
        expect(prefix.textContent).toBe('(ARCH → ALL): ');
      });

      test('should ignore null data', () => {
        const ui = createOrganicUI({ mount: mockBody });

        expect(() => ui.appendWarRoomMessage(null)).not.toThrow();
      });

      test('should handle empty message', () => {
        const ui = createOrganicUI({ mount: mockBody });

        ui.appendWarRoomMessage({ from: 'arch', to: 'devops', msg: '', type: 'direct' });

        const content = createdElements.find(el => el.className === 'war-room-content');
        expect(content.textContent).toBe('');
      });
    });
  });
});
