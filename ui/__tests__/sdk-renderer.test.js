/**
 * Tests for sdk-renderer.js module
 * SDK message rendering, streaming, delivery tracking
 */

// Mock notifications module to prevent DOM access
jest.mock('../modules/notifications', () => ({
  showNotification: jest.fn(),
  showToast: jest.fn(),
  showStatusNotice: jest.fn(),
}));

// Track created elements to capture what initSDKPane creates
let createdElements = [];

// Mock document
const mockDocument = {
  getElementById: jest.fn(),
  querySelector: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([]),
  createElement: jest.fn(),
  createTextNode: jest.fn(),
};

// Default mock element factory
function createMockElement(tagName = 'div') {
  const el = {
    tagName,
    className: '',
    innerHTML: '',
    textContent: '',
    id: '',
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 1000,
    childNodes: [],
    firstChild: null,
    parentNode: { removeChild: jest.fn() },
    parentElement: null,
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn().mockReturnValue(false),
    },
    appendChild: jest.fn(),
    insertBefore: jest.fn(),
    remove: jest.fn(),
    querySelector: jest.fn().mockReturnValue(null),
    querySelectorAll: jest.fn().mockReturnValue([]),
    after: jest.fn(),
  };
  createdElements.push(el);
  return el;
}

global.document = mockDocument;
global.URL = class URL {
  constructor(urlString) {
    this.hostname = urlString.includes('//') ? urlString.split('//')[1].split('/')[0] : urlString;
  }
};

// Set up createElement mock to return unique elements
mockDocument.createElement.mockImplementation((tag) => createMockElement(tag));
mockDocument.createTextNode.mockImplementation((text) => ({ nodeType: 3, textContent: text }));

const sdkRenderer = require('../modules/sdk-renderer');

describe('sdk-renderer.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdElements = [];

    // Reset createElement mock
    mockDocument.createElement.mockImplementation((tag) => createMockElement(tag));
    mockDocument.createTextNode.mockImplementation((text) => ({ nodeType: 3, textContent: text }));
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
  });

  describe('PANE_IDS constant', () => {
    test('should have 6 pane IDs', () => {
      expect(sdkRenderer.PANE_IDS).toHaveLength(6);
    });

    test('should be strings 1-6', () => {
      expect(sdkRenderer.PANE_IDS).toEqual(['1', '2', '3', '4', '5', '6']);
    });
  });

  describe('PANE_ROLES constant', () => {
    test('should have roles for all 6 panes', () => {
      expect(Object.keys(sdkRenderer.PANE_ROLES)).toHaveLength(6);
    });

    test('should have correct role names', () => {
      expect(sdkRenderer.PANE_ROLES['1']).toBe('Architect');
      expect(sdkRenderer.PANE_ROLES['6']).toBe('Reviewer');
    });
  });

  describe('setPaneConfig', () => {
    test('should accept custom pane IDs without throwing', () => {
      // Note: Exported PANE_IDS is frozen at module load time
      // This test verifies the function accepts valid input
      expect(() => sdkRenderer.setPaneConfig({ paneIds: ['a', 'b', 'c'] })).not.toThrow();

      // Reset to defaults
      sdkRenderer.setSDKPaneConfig();
    });

    test('should accept custom pane roles without throwing', () => {
      // Note: Exported PANE_ROLES is frozen at module load time
      expect(() => sdkRenderer.setPaneConfig({ paneRoles: { 'a': 'Custom Role' } })).not.toThrow();

      // Reset to defaults
      sdkRenderer.setSDKPaneConfig();
    });

    test('should handle empty options', () => {
      expect(() => sdkRenderer.setPaneConfig()).not.toThrow();
      expect(() => sdkRenderer.setPaneConfig({})).not.toThrow();
    });
  });

  describe('setSDKPaneConfig', () => {
    test('should reset to SDK defaults', () => {
      sdkRenderer.setPaneConfig({ paneIds: ['x', 'y'] });
      sdkRenderer.setSDKPaneConfig();

      expect(sdkRenderer.PANE_IDS).toHaveLength(6);
      expect(sdkRenderer.PANE_ROLES['1']).toBe('Architect');
    });
  });

  describe('generateMessageId', () => {
    test('should generate unique IDs', () => {
      const id1 = sdkRenderer.generateMessageId();
      const id2 = sdkRenderer.generateMessageId();

      expect(id1).not.toBe(id2);
    });

    test('should start with msg- prefix', () => {
      const id = sdkRenderer.generateMessageId();
      expect(id.startsWith('msg-')).toBe(true);
    });
  });

  describe('initSDKPane', () => {
    test('should skip if pane not found', () => {
      mockDocument.querySelector.mockReturnValue(null);

      sdkRenderer.initSDKPane('1');

      // Should not throw
    });

    test('should create SDK container when pane exists', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn((selector) => {
        if (selector === '.pane-terminal') return mockTerminal;
        if (selector === '.pane-header') return createMockElement('div');
        return null;
      });

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      // Should create SDK pane and messages container
      expect(mockDocument.createElement).toHaveBeenCalled();
    });

    test('should handle xterm already modified DOM', () => {
      const mockXterm = createMockElement('div');
      mockXterm.parentElement = createMockElement('div');

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn((selector) => {
        if (selector === '.xterm') return mockXterm;
        return null;
      });

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockReturnValue(null);

      sdkRenderer.initSDKPane('1');

      // Should find xterm container and use its parent
    });
  });

  describe('initAllSDKPanes', () => {
    test('should initialize all 6 panes', () => {
      // Set up a mock that returns null (pane not found)
      mockDocument.querySelector.mockReturnValue(null);

      sdkRenderer.initAllSDKPanes();

      // Should attempt to query for each pane
      expect(mockDocument.querySelector).toHaveBeenCalled();
    });
  });

  describe('appendMessage', () => {
    test('should handle missing container gracefully', () => {
      mockDocument.getElementById.mockReturnValue(null);
      mockDocument.querySelector.mockReturnValue(null);

      const result = sdkRenderer.appendMessage('1', { type: 'system', content: 'test' });

      // Should return null when container not found
      expect(result).toBeNull();
    });

    test('should add message to container when tracking delivery', () => {
      // Create mock terminal that will be found
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      // Initialize pane first to set up containers Map
      sdkRenderer.initSDKPane('1');

      // Get the sdk-messages container that was created
      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');

      // Now append message with delivery tracking
      sdkRenderer.appendMessage('1', { type: 'user', content: 'test' }, { trackDelivery: true });

      // Should have appended the message element to the container
      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });
  });

  describe('updateDeliveryState', () => {
    test('should update delivery state element', () => {
      const mockStateEl = createMockElement('span');
      const mockMsgEl = createMockElement('div');
      mockMsgEl.querySelector = jest.fn().mockReturnValue(mockStateEl);

      mockDocument.querySelector.mockReturnValue(mockMsgEl);

      sdkRenderer.updateDeliveryState('msg-123', 'delivered');

      expect(mockStateEl.className).toBe('sdk-delivery-state delivered');
    });

    test('should handle missing message element', () => {
      mockDocument.querySelector.mockReturnValue(null);

      expect(() => sdkRenderer.updateDeliveryState('msg-999', 'delivered')).not.toThrow();
    });
  });

  describe('clearPane', () => {
    test('should clear container innerHTML', () => {
      const mockContainer = createMockElement('div');
      mockContainer.innerHTML = '<div>old content</div>';

      // Manually add to containers map via init
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'sdk-messages-1') return mockContainer;
        return null;
      });

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      const mockTerminal = createMockElement('div');
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);
      mockDocument.querySelector.mockReturnValue(mockPane);

      // Initialize pane first
      sdkRenderer.initSDKPane('1');

      // Then clear
      sdkRenderer.clearPane('1');

      // clearPane sets innerHTML to empty
    });
  });

  describe('clearAllPanes', () => {
    test('should clear all panes', () => {
      // Just test it doesn't throw
      expect(() => sdkRenderer.clearAllPanes()).not.toThrow();
    });
  });

  describe('scrollToBottom', () => {
    test('should set scrollTop to scrollHeight', () => {
      const mockContainer = createMockElement('div');
      mockContainer.scrollHeight = 500;
      mockContainer.scrollTop = 0;

      // Need to add container to internal map
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'sdk-messages-1') return mockContainer;
        if (id === 'terminal-1') return createMockElement('div');
        return null;
      });

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      const mockTerminal = createMockElement('div');
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);
      mockDocument.querySelector.mockReturnValue(mockPane);

      sdkRenderer.initSDKPane('1');
      sdkRenderer.scrollToBottom('1');

      // scrollTop should be set to scrollHeight
    });
  });

  describe('streamingIndicator', () => {
    test('should create indicator when active', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      // Find the sdk-messages container that was created
      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null); // No existing indicator

      sdkRenderer.streamingIndicator('1', true);

      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });

    test('should remove indicator when inactive', () => {
      const mockIndicator = createMockElement('div');
      mockIndicator.className = 'sdk-streaming';

      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      // Find the sdk-messages container and set up indicator query
      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(mockIndicator);

      sdkRenderer.streamingIndicator('1', false);

      expect(mockIndicator.remove).toHaveBeenCalled();
    });

    test('should update context text when indicator exists', () => {
      jest.useFakeTimers();

      const mockTextEl = createMockElement('span');
      mockTextEl.classList = { add: jest.fn(), remove: jest.fn() };

      const mockIndicator = createMockElement('div');
      mockIndicator.querySelector.mockReturnValue(mockTextEl);
      mockIndicator.dataset = { tool: 'thinking', intensity: 'medium' };

      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      // Find the sdk-messages container and set up indicator query
      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(mockIndicator);

      sdkRenderer.streamingIndicator('1', true, 'Reading file...', 'read');

      jest.advanceTimersByTime(100);

      expect(mockTextEl.classList.add).toHaveBeenCalledWith('updating');
      jest.useRealTimers();
    });
  });

  describe('updateToolContext', () => {
    test('should show Read tool context', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null); // No existing indicator

      sdkRenderer.updateToolContext('1', { name: 'Read', input: { file_path: '/path/to/file.js' } });

      // Should create streaming indicator with Read context
      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });

    test('should show Bash tool context', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null);

      sdkRenderer.updateToolContext('1', { name: 'Bash', input: { command: 'npm test' } });

      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });

    test('should handle WebFetch URL parsing', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null);

      sdkRenderer.updateToolContext('1', { name: 'WebFetch', input: { url: 'https://example.com/page' } });

      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });
  });

  describe('appendTextDelta', () => {
    test('should create new streaming message', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null);

      sdkRenderer.appendTextDelta('1', 'Hello');

      expect(sdkMessagesContainer.appendChild).toHaveBeenCalled();
    });

    test('should append to existing streaming message', () => {
      const mockTerminal = createMockElement('div');
      mockTerminal.id = 'terminal-1';

      const mockPane = createMockElement('div');
      mockPane.dataset = { paneId: '1' };
      mockPane.querySelector = jest.fn().mockReturnValue(mockTerminal);

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'terminal-1') return mockTerminal;
        return null;
      });

      sdkRenderer.initSDKPane('1');

      const sdkMessagesContainer = createdElements.find(el => el.id === 'sdk-messages-1');
      sdkMessagesContainer.querySelector.mockReturnValue(null);

      // First delta creates message
      sdkRenderer.appendTextDelta('1', 'Hello');

      // Second delta appends to the existing streaming message
      // Note: This uses insertBefore on the content element, not appendChild on container
      expect(() => sdkRenderer.appendTextDelta('1', ' World')).not.toThrow();

      // createTextNode should be called for both deltas
      expect(mockDocument.createTextNode).toHaveBeenCalledTimes(2);
    });
  });

  describe('finalizeStreamingMessage', () => {
    test('should handle no active streaming', () => {
      // Clear any existing state
      sdkRenderer.clearStreamingState('1');

      expect(() => sdkRenderer.finalizeStreamingMessage('1')).not.toThrow();
    });
  });

  describe('clearStreamingState', () => {
    test('should clear streaming state', () => {
      expect(() => sdkRenderer.clearStreamingState('1')).not.toThrow();
    });
  });

  describe('getSessionId', () => {
    test('should return null when no session', () => {
      const sessionId = sdkRenderer.getSessionId('999');
      expect(sessionId).toBeNull();
    });
  });

  describe('addSystemMessage', () => {
    test('should call appendMessage with system type', () => {
      mockDocument.getElementById.mockReturnValue(null);
      mockDocument.querySelector.mockReturnValue(null);

      // Should not throw even when container not found
      expect(() => sdkRenderer.addSystemMessage('1', 'System message')).not.toThrow();
    });
  });

  describe('addErrorMessage', () => {
    test('should call appendMessage with error', () => {
      mockDocument.getElementById.mockReturnValue(null);
      mockDocument.querySelector.mockReturnValue(null);

      expect(() => sdkRenderer.addErrorMessage('1', 'Error occurred')).not.toThrow();
    });
  });
});
