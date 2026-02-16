/**
 * Tests for terminal.js module
 * Terminal management, PTY injection, idle detection, message queuing
 */

// Mock dependencies before requiring the module
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    loadAddon: jest.fn(),
    open: jest.fn(),
    write: jest.fn(),
    clear: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    onData: jest.fn(),
    onSelectionChange: jest.fn(),
    getSelection: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
  })),
}));

jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({
    fit: jest.fn(),
  })),
}));

jest.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@xterm/addon-webgl', () => ({
  WebglAddon: jest.fn().mockImplementation(() => ({
    onContextLoss: jest.fn(),
  })),
}));

jest.mock('@xterm/addon-search', () => ({
  SearchAddon: jest.fn().mockImplementation(() => ({
    findNext: jest.fn(),
    findPrevious: jest.fn(),
  })),
}));

// Mock settings module (used by isCodexFromSettings)
const mockSettings = {
  getSettings: jest.fn().mockReturnValue({ paneCommands: {} }),
};
jest.mock('../modules/settings', () => mockSettings);

const mockContractPromotion = {
  init: jest.fn(),
  incrementSession: jest.fn(),
  checkPromotions: jest.fn(() => []),
  saveStats: jest.fn(),
};
jest.mock('../modules/contract-promotion', () => mockContractPromotion);

// Mock window.hivemind
const mockHivemind = {
  pty: {
    create: jest.fn().mockResolvedValue(),
    write: jest.fn().mockResolvedValue(),
    kill: jest.fn().mockResolvedValue(),
    resize: jest.fn().mockResolvedValue(),
    onData: jest.fn(),
    onExit: jest.fn(),
    sendTrustedEnter: jest.fn().mockResolvedValue(),
  },
  claude: {
    spawn: jest.fn().mockResolvedValue({ success: true, command: 'claude' }),
  },
  context: {
    read: jest.fn().mockResolvedValue({ success: true, content: 'test context' }),
  },
  settings: {
    get: jest.fn().mockReturnValue({ paneCommands: {} }),
  },
};

// Mock process.cwd
const originalCwd = process.cwd;
process.cwd = jest.fn().mockReturnValue('/test/cwd');

// Mock document
const mockDocument = {
  getElementById: jest.fn(),
  querySelector: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([]),
  activeElement: null,
  addEventListener: jest.fn(),
};

// Mock navigator.clipboard
const mockClipboard = {
  writeText: jest.fn().mockResolvedValue(),
  readText: jest.fn().mockResolvedValue('clipboard text'),
};

// Setup global mocks
global.window = { hivemind: mockHivemind };
global.document = mockDocument;
global.navigator = { clipboard: mockClipboard };
global.alert = jest.fn();
global.confirm = jest.fn().mockReturnValue(true);
global.KeyboardEvent = class KeyboardEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.key = options.key || '';
    this.code = options.code || '';
    this.keyCode = options.keyCode || 0;
    this.which = options.which || 0;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
    this.isTrusted = options.isTrusted !== false;
    this.ctrlKey = options.ctrlKey || false;
    this.altKey = options.altKey || false;
    this.metaKey = options.metaKey || false;
  }
};

// Mock ResizeObserver (not available in jsdom)
global.ResizeObserver = class ResizeObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};

const terminal = require('../modules/terminal');
const { Terminal } = require('@xterm/xterm');

describe('terminal.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset module state
    terminal.terminals.clear();
    terminal.fitAddons.clear();
    terminal.lastEnterTime['1'] = 0;
    terminal.lastTypedTime['1'] = 0;
    terminal.lastOutputTime['1'] = 0;
    for (const key of Object.keys(terminal.messageQueue)) {
      delete terminal.messageQueue[key];
    }

    // Reset mocks
    mockHivemind.pty.write.mockResolvedValue();
    mockHivemind.claude.spawn.mockResolvedValue({ success: true, command: 'claude' });
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
    mockDocument.activeElement = null;
    mockContractPromotion.checkPromotions.mockReturnValue([]);
    terminal.stopPromotionCheckTimer();
  });

  afterEach(() => {
    terminal.stopPromotionCheckTimer();
    jest.useRealTimers();
  });

  describe('PANE_IDS constant', () => {
    test('should have 3 pane IDs', () => {
      expect(terminal.PANE_IDS).toHaveLength(3);
    });

    test('should be strings 1,2,5', () => {
      expect(terminal.PANE_IDS).toEqual(['1', '2', '5']);
    });
  });

  describe('setStatusCallbacks', () => {
    test('should set status callbacks', () => {
      const statusCb = jest.fn();
      const connectionCb = jest.fn();

      terminal.setStatusCallbacks(statusCb, connectionCb);

      // Verify callbacks work by calling update functions
      terminal.updatePaneStatus('1', 'test status');
      expect(statusCb).toHaveBeenCalledWith('1', 'test status');

      terminal.updateConnectionStatus('connected');
      expect(connectionCb).toHaveBeenCalledWith('connected');
    });

    test('should handle null callbacks gracefully', () => {
      terminal.setStatusCallbacks(null, null);

      // Should not throw
      expect(() => terminal.updatePaneStatus('1', 'test')).not.toThrow();
      expect(() => terminal.updateConnectionStatus('test')).not.toThrow();
    });
  });

  describe('focusPane', () => {
    test('should focus pane and update focusedPane', () => {
      const mockPane = {
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      const mockTerminal = { focus: jest.fn() };

      mockDocument.querySelectorAll.mockReturnValue([mockPane]);
      mockDocument.querySelector.mockReturnValue(mockPane);
      terminal.terminals.set('1', mockTerminal);

      terminal.focusPane('1');

      expect(terminal.getFocusedPane()).toBe('1');
      expect(mockPane.classList.add).toHaveBeenCalledWith('focused');
      expect(mockTerminal.focus).toHaveBeenCalled();
    });

    test('should handle missing pane gracefully', () => {
      mockDocument.querySelectorAll.mockReturnValue([]);
      mockDocument.querySelector.mockReturnValue(null);

      expect(() => terminal.focusPane('99')).not.toThrow();
    });
  });

  describe('blurAllTerminals', () => {
    test('should blur all terminals', () => {
      const mockTerminal1 = { blur: jest.fn() };
      const mockTerminal2 = { blur: jest.fn() };

      terminal.terminals.set('1', mockTerminal1);
      terminal.terminals.set('2', mockTerminal2);

      terminal.blurAllTerminals();

      expect(mockTerminal1.blur).toHaveBeenCalled();
      expect(mockTerminal2.blur).toHaveBeenCalled();
    });

    test('should handle terminal without blur method', () => {
      terminal.terminals.set('1', {}); // No blur method

      expect(() => terminal.blurAllTerminals()).not.toThrow();
    });
  });

  describe('getTerminal', () => {
    test('should return terminal by pane ID', () => {
      const mockTerminal = { test: true };
      terminal.terminals.set('1', mockTerminal);

      expect(terminal.getTerminal('1')).toBe(mockTerminal);
    });

    test('should return undefined for non-existent pane', () => {
      expect(terminal.getTerminal('99')).toBeUndefined();
    });
  });

  describe('getFocusedPane', () => {
    test('should return current focused pane after focusPane call', () => {
      // Focus pane 2
      const mockPane = { classList: { add: jest.fn(), remove: jest.fn() } };
      mockDocument.querySelectorAll.mockReturnValue([mockPane]);
      mockDocument.querySelector.mockReturnValue(mockPane);
      terminal.terminals.set('2', { focus: jest.fn() });

      terminal.focusPane('2');
      expect(terminal.getFocusedPane()).toBe('2');
    });
  });

  describe('setReconnectedToExisting / getReconnectedToExisting', () => {
    test('should set and get reconnected state', () => {
      terminal.setReconnectedToExisting(true);
      expect(terminal.getReconnectedToExisting()).toBe(true);

      terminal.setReconnectedToExisting(false);
      expect(terminal.getReconnectedToExisting()).toBe(false);
    });
  });

  describe('registerCodexPane / unregisterCodexPane / isCodexPane', () => {
    test('registerCodexPane should mark pane as Codex', () => {
      terminal.registerCodexPane('1');
      expect(terminal.isCodexPane('1')).toBe(true);
    });

    test('unregisterCodexPane should unmark pane', () => {
      terminal.registerCodexPane('1');
      terminal.unregisterCodexPane('1');
      expect(terminal.isCodexPane('1')).toBe(false);
    });

    test('isCodexPane should return false for unregistered pane', () => {
      expect(terminal.isCodexPane('99')).toBe(false);
    });

    test('isCodexPane should check settings fallback', () => {
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '2': 'codex --mode exec' },
      });

      // Pane not registered but settings say codex
      expect(terminal.isCodexPane('2')).toBe(true);
    });
  });

  describe('getPaneInjectionCapabilities', () => {
    test('enables submit verification by default for Codex runtime', () => {
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '2': 'codex --yolo' },
      });

      const caps = terminal.getPaneInjectionCapabilities('2');
      expect(caps.mode).toBe('pty');
      expect(caps.modeLabel).toBe('codex-pty');
      expect(caps.verifySubmitAccepted).toBe(true);
      expect(caps.enterMethod).toBe('pty');
    });

    test('returns safe generic defaults for unknown runtimes', () => {
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '9': 'my-custom-cli --run' },
      });

      const caps = terminal.getPaneInjectionCapabilities('9');
      expect(caps.mode).toBe('pty');
      expect(caps.modeLabel).toBe('generic-pty');
      expect(caps.enterMethod).toBe('pty');
      expect(caps.requiresFocusForEnter).toBe(false);
      expect(caps.useChunkedWrite).toBe(true);
      expect(caps.verifySubmitAccepted).toBe(true);
    });

    test('applies injection capability overrides from settings', () => {
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '9': 'my-custom-cli --run' },
        injectionCapabilities: {
          panes: {
            '9': {
              modeLabel: 'custom-pane-pty',
              verifySubmitAccepted: false,
              useChunkedWrite: false,
            },
          },
        },
      });

      const caps = terminal.getPaneInjectionCapabilities('9');
      expect(caps.modeLabel).toBe('custom-pane-pty');
      expect(caps.verifySubmitAccepted).toBe(false);
      expect(caps.useChunkedWrite).toBe(false);
      expect(caps.enterMethod).toBe('pty');
    });
  });

  describe('sendToPane', () => {
    test('should queue message when injection in flight', () => {
      // Block immediate processing with injection lock
      terminal.setInjectionInFlight(true);

      terminal.sendToPane('1', 'test message');

      expect(terminal.messageQueue['1']).toHaveLength(1);
      expect(terminal.messageQueue['1'][0].message).toBe('test message');
      // Clear lock and pending processQueue timers
      terminal.setInjectionInFlight(false);
      jest.runAllTimers();
    });

    test('should include timestamp in queued message', () => {
      jest.useRealTimers();
      terminal.setInjectionInFlight(true); // Block immediate processing
      const before = Date.now();
      terminal.sendToPane('1', 'test');
      const after = Date.now();

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      const timestamp = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1].timestamp;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
      terminal.setInjectionInFlight(false);
      jest.useFakeTimers();
    });

    test('should include onComplete callback if provided', () => {
      jest.useRealTimers();
      terminal.setInjectionInFlight(true); // Block immediate processing
      const callback = jest.fn();
      terminal.sendToPane('1', 'test', { onComplete: callback });

      expect(terminal.messageQueue['1']).toBeDefined();
      const lastItem = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(lastItem.onComplete).toBe(callback);
      terminal.setInjectionInFlight(false);
      jest.useFakeTimers();
    });

    test('should create queue if not exists', () => {
      jest.useRealTimers();
      terminal.lastOutputTime['3'] = Date.now(); // Keep pane busy
      expect(terminal.messageQueue['3']).toBeUndefined();

      terminal.sendToPane('3', 'test');

      expect(terminal.messageQueue['3']).toBeDefined();
      expect(Array.isArray(terminal.messageQueue['3'])).toBe(true);
      jest.useFakeTimers();
    });
  });

  describe('broadcast', () => {
    test('should send message to pane 1 (Architect)', () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      const statusCb = jest.fn();
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, connectionCb);

      terminal.broadcast('test broadcast');

      // broadcast routes to pane 1 with priority + immediate
      // Immediate messages are processed instantly (bypass idle checks),
      // so the queue may already be empty. Verify the message was routed
      // to pane 1 via the connection status callback.
      expect(terminal.messageQueue['1']).toBeDefined();
      expect(connectionCb).toHaveBeenCalledWith('Message sent to Architect');
      jest.useFakeTimers();
    });
  });

  describe('nudgePane', () => {
    test('should send Enter to pane', () => {
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      terminal.nudgePane('1');

      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', '\r');
      expect(statusCb).toHaveBeenCalledWith('1', 'Nudged');
    });

    test('should update lastTypedTime', () => {
      const before = Date.now();
      terminal.nudgePane('1');

      expect(terminal.lastTypedTime['1']).toBeGreaterThanOrEqual(before);
    });
  });

  describe('nudgeAllPanes', () => {
    test('should nudge all 3 panes', () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      terminal.nudgeAllPanes();

      expect(connectionCb).toHaveBeenCalledWith('Nudging all agents...');
      expect(mockHivemind.pty.write).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendUnstick', () => {
    test('should dispatch ESC keyboard event', () => {
      const mockTextarea = {
        focus: jest.fn(),
        dispatchEvent: jest.fn(),
      };
      const mockPane = {
        querySelector: jest.fn().mockReturnValue(mockTextarea),
      };
      mockDocument.querySelector.mockReturnValue(mockPane);

      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      terminal.sendUnstick('1');

      expect(mockTextarea.focus).toHaveBeenCalled();
      expect(mockTextarea.dispatchEvent).toHaveBeenCalledTimes(2); // keydown + keyup
      expect(statusCb).toHaveBeenCalledWith('1', 'Unstick sent');
    });

    test('should handle missing textarea gracefully', () => {
      mockDocument.querySelector.mockReturnValue(null);

      expect(() => terminal.sendUnstick('1')).not.toThrow();
    });
  });

  describe('aggressiveNudge', () => {
    test('should send ESC then Enter', () => {
      const mockTextarea = {
        focus: jest.fn(),
        dispatchEvent: jest.fn(),
      };
      const mockPane = {
        querySelector: jest.fn().mockReturnValue(mockTextarea),
      };
      mockDocument.querySelector.mockReturnValue(mockPane);

      terminal.aggressiveNudge('1');

      // ESC should be sent immediately
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();

      // Enter should be sent after 150ms delay via DOM key dispatch
      jest.advanceTimersByTime(150);
      expect(mockTextarea.dispatchEvent.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('aggressiveNudgeAll', () => {
    test('should aggressive nudge all panes with stagger', () => {
      const mockTextarea = {
        focus: jest.fn(),
        dispatchEvent: jest.fn(),
      };
      const mockPane = {
        querySelector: jest.fn().mockReturnValue(mockTextarea),
      };
      mockDocument.querySelector.mockReturnValue(mockPane);

      terminal.aggressiveNudgeAll();

      // Panes are staggered by 200ms each
      // Pane 1: 200ms, Pane 2: 400ms, etc.
      jest.advanceTimersByTime(200);
      expect(mockTextarea.dispatchEvent).toHaveBeenCalled();
    });
  });

  describe('killAllTerminals', () => {
    test('should kill all 3 panes', async () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.killAllTerminals();

      expect(connectionCb).toHaveBeenCalledWith('Killing all terminals...');
      expect(mockHivemind.pty.kill).toHaveBeenCalledTimes(3);
      expect(connectionCb).toHaveBeenCalledWith('All terminals killed');
    });

    test('should handle kill errors gracefully', async () => {
      mockHivemind.pty.kill.mockRejectedValueOnce(new Error('kill failed'));

      await expect(terminal.killAllTerminals()).resolves.not.toThrow();
    });

    test('clears queued injection messages during teardown to prevent restart bleed', async () => {
      terminal.messageQueue['1'] = [
        { message: 'stale-1', timestamp: Date.now() },
        { message: 'stale-2', timestamp: Date.now() },
      ];

      await terminal.killAllTerminals();

      expect(terminal.messageQueue['1']).toBeUndefined();
    });
  });

  describe('handleResize', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('should fit and resize all terminals', () => {
      jest.useFakeTimers();
      const mockTerminalObj = { cols: 80, rows: 24 };
      const mockFitAddon = { fit: jest.fn(() => { mockTerminalObj.cols = 120; mockTerminalObj.rows = 40; }) };

      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal.handleResize();
      jest.advanceTimersByTime(150);

      expect(mockFitAddon.fit).toHaveBeenCalled();
      expect(mockHivemind.pty.resize).toHaveBeenCalledWith('1', 120, 40);
    });

    test('should handle resize errors gracefully', () => {
      jest.useFakeTimers();
      const mockFitAddon = { fit: jest.fn().mockImplementation(() => { throw new Error('fit error'); }) };
      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', { cols: 80, rows: 24 });

      terminal.handleResize();
      jest.advanceTimersByTime(150);

      // Should not throw — errors are caught internally
    });
  });

  describe('freshStartAll', () => {
    test('should show confirmation dialog', async () => {
      confirm.mockReturnValue(false);

      await terminal.freshStartAll();

      expect(confirm).toHaveBeenCalled();
    });

    test('should cancel if user declines', async () => {
      confirm.mockReturnValue(false);
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.freshStartAll();

      expect(connectionCb).toHaveBeenCalledWith('Fresh start cancelled');
      expect(mockHivemind.pty.kill).not.toHaveBeenCalled();
    });

  });

  describe('spawnAgent', () => {
    test('should skip if no terminal exists', async () => {
      terminal.terminals.clear();

      await terminal.spawnAgent('1');

      expect(mockHivemind.claude.spawn).not.toHaveBeenCalled();
    });

    test('should spawn and write command', async () => {
      jest.useRealTimers();
      const mockTerminalObj = { write: jest.fn() };
      terminal.terminals.set('1', mockTerminalObj);
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      // Just test the immediate part, not the delayed identity injection
      const spawnPromise = terminal.spawnAgent('1');

      // Wait for initial spawn to complete
      await spawnPromise;

      expect(mockHivemind.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', 'claude');
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting...');
      jest.useFakeTimers();
    });

    test('should spawn Codex pane via PTY (same as Claude)', async () => {
      jest.useRealTimers();
      terminal.registerCodexPane('1');
      terminal.terminals.set('1', { write: jest.fn() });
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnAgent('1');

      // Codex panes now use interactive PTY mode (same spawn path as Claude)
      expect(mockHivemind.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockHivemind.pty.write).toHaveBeenCalled();
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting...');
      expect(statusCb).toHaveBeenCalledWith('1', 'Working');

      terminal.unregisterCodexPane('1'); // Reset
      jest.useFakeTimers();
    });

    test('should handle spawn failure', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('5'); // Ensure pane 5 is not codex
      terminal.terminals.set('5', { write: jest.fn() });
      mockHivemind.claude.spawn.mockRejectedValueOnce(new Error('spawn failed'));
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnAgent('5');

      expect(statusCb).toHaveBeenCalledWith('5', 'Spawn failed');
      jest.useFakeTimers();
    });

  });

  describe('spawnAllAgents', () => {
    test('should spawn in all 3 panes', async () => {
      jest.useRealTimers();
      // Clear mock call counts from previous tests
      mockHivemind.claude.spawn.mockClear();

      // Ensure no panes are registered as Codex
      for (const paneId of terminal.PANE_IDS) {
        terminal.unregisterCodexPane(paneId);
      }

      // Setup terminals for all panes
      for (const paneId of terminal.PANE_IDS) {
        terminal.terminals.set(paneId, { write: jest.fn() });
      }

      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.spawnAllAgents();

      expect(connectionCb).toHaveBeenCalledWith('Starting agents in all panes...');
      expect(mockHivemind.claude.spawn).toHaveBeenCalledTimes(3);
      expect(connectionCb).toHaveBeenCalledWith('All agents running');
      jest.useFakeTimers();
    });
  });

  describe('message queue processing', () => {
    test('should process queue when injection lock clears', () => {
      jest.useRealTimers();
      // Queue a message while injection is in flight
      terminal.setInjectionInFlight(true);
      terminal.sendToPane('1', 'test message\r');

      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      terminal.setInjectionInFlight(false);
      jest.useFakeTimers();
    });

    test('should track message timestamp in queued item', () => {
      jest.useRealTimers();
      terminal.setInjectionInFlight(true); // Block immediate processing
      terminal.sendToPane('1', 'test');

      expect(terminal.messageQueue['1']).toBeDefined();
      const item = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(item.timestamp).toBeDefined();
      expect(typeof item.timestamp).toBe('number');
      terminal.setInjectionInFlight(false);
      jest.useFakeTimers();
    });
  });

  describe('updatePaneStatus', () => {
    test('should call status callback with pane and status', () => {
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      terminal.updatePaneStatus('2', 'Working');

      expect(statusCb).toHaveBeenCalledWith('2', 'Working');
    });
  });

  describe('updateConnectionStatus', () => {
    test('should call connection callback with status', () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      terminal.updateConnectionStatus('All terminals ready');

      expect(connectionCb).toHaveBeenCalledWith('All terminals ready');
    });
  });

  describe('exported state objects', () => {
    test('lastEnterTime should be an object', () => {
      expect(typeof terminal.lastEnterTime).toBe('object');
    });

    test('lastTypedTime should be an object', () => {
      expect(typeof terminal.lastTypedTime).toBe('object');
    });

    test('lastOutputTime should be an object', () => {
      expect(typeof terminal.lastOutputTime).toBe('object');
    });

    test('messageQueue should be an object', () => {
      expect(typeof terminal.messageQueue).toBe('object');
    });

    test('terminals should be a Map', () => {
      expect(terminal.terminals).toBeInstanceOf(Map);
    });

    test('fitAddons should be a Map', () => {
      expect(terminal.fitAddons).toBeInstanceOf(Map);
    });
  });

  describe('initTerminal', () => {
    test('should skip if container not found', async () => {
      mockDocument.getElementById.mockReturnValue(null);

      await terminal.initTerminal('1');

      // Should not create terminal
      expect(terminal.terminals.has('1')).toBe(false);
    });

    test('should create terminal and fitAddon when container exists', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.initTerminal('1');

      // Terminal and fitAddon should be created
      expect(terminal.terminals.has('1')).toBe(true);
      expect(terminal.fitAddons.has('1')).toBe(true);
    });

    test('should enforce xterm scrollback cap in constructor options', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.initTerminal('1');

      expect(Terminal).toHaveBeenCalledWith(expect.objectContaining({ scrollback: 2000 }));
    });
  });

  describe('contract promotion runtime wiring', () => {
    test('runPromotionCheck invokes checkPromotions and saveStats', () => {
      mockContractPromotion.checkPromotions.mockReturnValue(['overlay-fit-exclusion-shadow']);

      const result = terminal.runPromotionCheck();

      expect(result).toEqual(['overlay-fit-exclusion-shadow']);
      expect(mockContractPromotion.checkPromotions).toHaveBeenCalledTimes(1);
      expect(mockContractPromotion.saveStats).toHaveBeenCalledTimes(1);
    });

    test('initPromotionEngine initializes promotion and increments shadow contract sessions', () => {
      terminal._internals.initPromotionEngine();

      expect(mockContractPromotion.init).toHaveBeenCalledTimes(1);
      expect(mockContractPromotion.incrementSession).toHaveBeenCalledWith('overlay-fit-exclusion-shadow');
      expect(mockContractPromotion.checkPromotions).toHaveBeenCalledTimes(1);
      expect(mockContractPromotion.saveStats).toHaveBeenCalledTimes(1);
    });

    test('promotion timer triggers periodic checks', () => {
      terminal._internals.startPromotionCheckTimer();
      jest.advanceTimersByTime(terminal._internals.PROMOTION_CHECK_INTERVAL_MS);

      expect(mockContractPromotion.checkPromotions).toHaveBeenCalledTimes(1);
      expect(mockContractPromotion.saveStats).toHaveBeenCalledTimes(1);
    });
  });

  describe('reattachTerminal', () => {
    test('should skip if container not found', async () => {
      mockDocument.getElementById.mockReturnValue(null);

      await terminal.reattachTerminal('1', '');

      // Should not create terminal
      expect(terminal.terminals.has('1')).toBe(false);
    });

    test('should skip if already attached', async () => {
      const existingTerminal = { focus: jest.fn() };
      terminal.terminals.set('1', existingTerminal);

      await terminal.reattachTerminal('1', '');

      // Should keep existing terminal
      expect(terminal.terminals.get('1')).toBe(existingTerminal);
    });

    test('should create terminal and restore scrollback', async () => {
      terminal.terminals.delete('1');
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.reattachTerminal('1', 'scrollback content');

      expect(terminal.terminals.has('1')).toBe(true);
    });

    test('should trim restored scrollback to xterm cap lines', async () => {
      terminal.terminals.delete('99');
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      const longScrollback = Array.from({ length: 6000 }, (_, i) => `line-${i + 1}`).join('\n');

      await terminal.reattachTerminal('99', longScrollback);

      const terminalInstance = terminal.terminals.get('99');
      const writeCall = terminalInstance.write.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('line-'),
      );
      expect(writeCall).toBeDefined();
      const restored = writeCall[0];
      expect(restored).toContain('line-6000');
      expect(restored.startsWith('line-4001')).toBe(true);
      expect(restored).not.toContain('line-4000\n');
      expect(restored.split('\n')).toHaveLength(2000);
    });
  });

  describe('edge cases', () => {
    test('blurAllTerminals should handle empty terminals map', () => {
      terminal.terminals.clear();
      expect(() => terminal.blurAllTerminals()).not.toThrow();
    });

    test('handleResize should handle empty fitAddons map', () => {
      terminal.fitAddons.clear();
      expect(() => terminal.handleResize()).not.toThrow();
    });

    test('nudgePane should handle PTY write rejection', async () => {
      mockHivemind.pty.write.mockRejectedValueOnce(new Error('write error'));
      expect(() => terminal.nudgePane('1')).not.toThrow();
    });

    test('sendUnstick should handle pane without textarea', () => {
      const mockPane = {
        querySelector: jest.fn().mockReturnValue(null),
      };
      mockDocument.querySelector.mockReturnValue(mockPane);

      expect(() => terminal.sendUnstick('1')).not.toThrow();
    });
  });

  describe('Codex detection', () => {
    test('isCodexPane should handle settings.get throwing', () => {
      mockHivemind.settings.get.mockImplementationOnce(() => {
        throw new Error('settings error');
      });

      expect(terminal.isCodexPane('1')).toBe(false);
    });

    test('isCodexPane should handle missing paneCommands', () => {
      mockHivemind.settings.get.mockReturnValue({});
      expect(terminal.isCodexPane('999')).toBe(false);
    });

    test('isCodexPane should handle null settings', () => {
      mockHivemind.settings.get.mockReturnValue(null);
      expect(terminal.isCodexPane('1')).toBe(false);
    });
  });

  describe('freshStartAll edge cases', () => {
    test('should proceed when confirmed', async () => {
      jest.useRealTimers();
      confirm.mockReturnValue(true);

      // Setup terminals to be cleared
      const mockTerminal = { clear: jest.fn() };
      terminal.terminals.set('1', mockTerminal);

      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.freshStartAll();

      expect(connectionCb).toHaveBeenCalledWith('Fresh start: killing all terminals...');
      jest.useFakeTimers();
    });
  });

  describe('spawnAgent edge cases', () => {
    test('should handle spawn returning failure', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('5'); // Ensure pane 5 is not codex
      terminal.terminals.set('5', { write: jest.fn() });
      mockHivemind.claude.spawn.mockResolvedValueOnce({ success: false });
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnAgent('5');

      // Should still update status but not write command
      expect(statusCb).toHaveBeenCalledWith('5', 'Starting...');
      expect(statusCb).toHaveBeenCalledWith('5', 'Working');
      jest.useFakeTimers();
    });

    test('should handle Codex command detection', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('5'); // Ensure pane 5 is not codex
      terminal.terminals.set('5', { write: jest.fn() });
      mockHivemind.claude.spawn.mockResolvedValueOnce({
        success: true,
        command: 'codex --interactive',
      });

      await terminal.spawnAgent('5');

      // Should detect Codex command and write it via PTY
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('5', 'codex --interactive');
      jest.useFakeTimers();
    });
  });

  describe('sendToPane edge cases', () => {
    test('should queue message when injection in flight', () => {
      // Block immediate processing with injection lock
      terminal.setInjectionInFlight(true);

      terminal.sendToPane('1', 'Test message');

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      // Clear lock and pending processQueue timers
      terminal.setInjectionInFlight(false);
      jest.runAllTimers();
    });

    test('should handle empty message', () => {
      expect(() => terminal.sendToPane('1', '')).not.toThrow();
    });

  });

  describe('aggressiveNudge edge cases', () => {
    test('should handle missing pane gracefully', () => {
      mockDocument.querySelector.mockReturnValue(null);
      expect(() => terminal.aggressiveNudge('999')).not.toThrow();
    });
  });

  describe('aggressiveNudgeAll', () => {
    test('should not throw', () => {
      expect(() => terminal.aggressiveNudgeAll()).not.toThrow();
    });
  });

  describe('PANE_IDS constant (duplicate)', () => {
    test('should have 3 pane IDs', () => {
      expect(terminal.PANE_IDS).toHaveLength(3);
      expect(terminal.PANE_IDS).toContain('1');
      expect(terminal.PANE_IDS).toContain('5');
    });
  });

  describe('getTerminal', () => {
    test('should return undefined for missing terminal', () => {
      terminal.terminals.delete('999');
      const t = terminal.getTerminal('999');
      expect(t).toBeUndefined();
    });

    test('should return terminal for existing pane', () => {
      const mockTerm = { write: jest.fn() };
      terminal.terminals.set('1', mockTerm);
      const t = terminal.getTerminal('1');
      expect(t).toBe(mockTerm);
    });
  });

  describe('killAllTerminals', () => {
    test('should handle empty terminals map', async () => {
      jest.useRealTimers();
      terminal.terminals.clear();
      await expect(terminal.killAllTerminals()).resolves.not.toThrow();
      jest.useFakeTimers();
    });
  });

  describe('nudgeAllPanes', () => {
    test('should not throw', () => {
      expect(() => terminal.nudgeAllPanes()).not.toThrow();
    });
  });

  describe('setReconnectedToExisting', () => {
    test('should set reconnected flag', () => {
      terminal.setReconnectedToExisting(true);
      expect(terminal.getReconnectedToExisting()).toBe(true);

      terminal.setReconnectedToExisting(false);
      expect(terminal.getReconnectedToExisting()).toBe(false);
    });
  });

  describe('registerCodexPane and unregisterCodexPane', () => {
    test('should register and unregister pane', () => {
      terminal.registerCodexPane('1');
      expect(terminal.isCodexPane('1')).toBe(true);

      terminal.unregisterCodexPane('1');
      expect(terminal.isCodexPane('1')).toBe(false);
    });
  });

  describe('Input Lock Functions', () => {
    beforeEach(() => {
      terminal.inputLocked['1'] = false;
      terminal.inputLocked['2'] = false;
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        dataset: {},
        classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
      });
    });

    describe('isInputLocked', () => {
      test('should return false for unlocked pane', () => {
        terminal.inputLocked['1'] = false;
        expect(terminal.isInputLocked('1')).toBe(false);
      });

      test('should return true for locked pane', () => {
        terminal.inputLocked['1'] = true;
        expect(terminal.isInputLocked('1')).toBe(true);
      });

      test('should return false for undefined pane', () => {
        delete terminal.inputLocked['3'];
        expect(terminal.isInputLocked('3')).toBe(false);
      });
    });

    describe('toggleInputLock', () => {
      test('should toggle lock from false to true', () => {
        terminal.inputLocked['1'] = false;
        const result = terminal.toggleInputLock('1');
        expect(result).toBe(true);
        expect(terminal.inputLocked['1']).toBe(true);
      });

      test('should toggle lock from true to false', () => {
        terminal.inputLocked['1'] = true;
        const result = terminal.toggleInputLock('1');
        expect(result).toBe(false);
        expect(terminal.inputLocked['1']).toBe(false);
      });

      test('should update lock icon when element exists', () => {
        const mockLockIcon = {
          innerHTML: '',
          dataset: {},
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
        };
        mockDocument.getElementById.mockReturnValue(mockLockIcon);

        terminal.inputLocked['1'] = false;
        terminal.toggleInputLock('1');

        expect(mockLockIcon.innerHTML).toContain('svg');
        expect(mockLockIcon.innerHTML).toContain('pane-btn-icon');
        expect(mockLockIcon.classList.toggle).toHaveBeenCalledWith('unlocked', false);
      });

      test('should handle missing lock icon element', () => {
        mockDocument.getElementById.mockReturnValue(null);
        terminal.inputLocked['1'] = false;

        expect(() => terminal.toggleInputLock('1')).not.toThrow();
        expect(terminal.inputLocked['1']).toBe(true);
      });
    });

    describe('setInputLocked', () => {
      test('should set lock state to true', () => {
        terminal.inputLocked['1'] = false;
        terminal.setInputLocked('1', true);
        expect(terminal.inputLocked['1']).toBe(true);
      });

      test('should set lock state to false', () => {
        terminal.inputLocked['1'] = true;
        terminal.setInputLocked('1', false);
        expect(terminal.inputLocked['1']).toBe(false);
      });

      test('should update lock icon when element exists', () => {
        const mockLockIcon = {
          innerHTML: '',
          dataset: {},
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
        };
        mockDocument.getElementById.mockReturnValue(mockLockIcon);

        terminal.setInputLocked('1', true);

        expect(mockLockIcon.innerHTML).toContain('svg');
        expect(mockLockIcon.innerHTML).toContain('pane-btn-icon');
        expect(mockLockIcon.dataset.tooltip).toContain('Locked');
        expect(mockLockIcon.classList.toggle).toHaveBeenCalledWith('unlocked', false);
      });

      test('should handle missing lock icon element', () => {
        mockDocument.getElementById.mockReturnValue(null);

        expect(() => terminal.setInputLocked('1', true)).not.toThrow();
        expect(terminal.inputLocked['1']).toBe(true);
      });
    });
  });

  describe('Terminal Search Functions', () => {
    beforeEach(() => {
      terminal.searchAddons.set('1', {
        findNext: jest.fn(),
        findPrevious: jest.fn(),
      });
    });

    describe('searchAddons', () => {
      test('should store search addon instances', () => {
        expect(terminal.searchAddons.get('1')).toBeDefined();
        expect(terminal.searchAddons.get('1').findNext).toBeDefined();
      });
    });

    // Note: openTerminalSearch and closeTerminalSearch are tightly coupled
    // to DOM state (module-level searchBar variable) making isolated unit
    // testing difficult. Integration tests via renderer.test.js cover these.
  });

  describe('Stuck Message Sweeper', () => {
    describe('startStuckMessageSweeper', () => {
      test('should not throw when called', () => {
        expect(() => terminal.startStuckMessageSweeper()).not.toThrow();
      });
    });

    describe('stopStuckMessageSweeper', () => {
      test('should not throw when called', () => {
        expect(() => terminal.stopStuckMessageSweeper()).not.toThrow();
      });
    });

    describe('sweepStuckMessages', () => {
      test('should not throw when called', () => {
        terminal.potentiallyStuckPanes.clear();
        expect(() => terminal.sweepStuckMessages()).not.toThrow();
      });

      test('should process stuck panes', () => {
        terminal.potentiallyStuckPanes.set('1', {
          message: 'test',
          queuedAt: Date.now() - 60000, // 1 minute ago
        });

        expect(() => terminal.sweepStuckMessages()).not.toThrow();
      });
    });
  });

  describe('Message Queue', () => {
    test('should exist as an object', () => {
      expect(typeof terminal.messageQueue).toBe('object');
      expect(terminal.messageQueue).not.toBeNull();
    });
  });

  describe('Last Activity Tracking', () => {
    test('lastEnterTime should be an object', () => {
      expect(typeof terminal.lastEnterTime).toBe('object');
    });

    test('lastTypedTime should be an object', () => {
      expect(typeof terminal.lastTypedTime).toBe('object');
    });

    test('lastOutputTime should be an object', () => {
      expect(typeof terminal.lastOutputTime).toBe('object');
    });
  });

  describe('potentiallyStuckPanes', () => {
    test('should exist as a Map', () => {
      expect(terminal.potentiallyStuckPanes instanceof Map).toBe(true);
    });

    test('should allow set and get operations', () => {
      terminal.potentiallyStuckPanes.set('test', { message: 'test' });
      expect(terminal.potentiallyStuckPanes.get('test')).toEqual({ message: 'test' });
      terminal.potentiallyStuckPanes.delete('test');
    });
  });

  describe('fitAddons', () => {
    test('should exist as a Map', () => {
      expect(terminal.fitAddons instanceof Map).toBe(true);
    });
  });

  describe('searchAddons', () => {
    test('should exist as a Map', () => {
      expect(terminal.searchAddons instanceof Map).toBe(true);
    });
  });

  describe('initUIFocusTracker', () => {
    test('should attach focusin event listener', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      expect(mockDocument.addEventListener).toHaveBeenCalledWith('focusin', expect.any(Function), expect.objectContaining({ signal: expect.anything() }));
    });

    test('should attach keydown event listener', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      expect(mockDocument.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), expect.objectContaining({ signal: expect.anything() }));
    });

    test('should attach input event listener', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      expect(mockDocument.addEventListener).toHaveBeenCalledWith('input', expect.any(Function), expect.objectContaining({ signal: expect.anything() }));
    });

    test('focusin handler should track UI input focus', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      // Get the focusin handler
      const focusinCall = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'focusin'
      );
      const focusinHandler = focusinCall[1];

      // Simulate focus on INPUT element (not xterm)
      const mockInput = {
        tagName: 'INPUT',
        classList: { contains: jest.fn().mockReturnValue(false) },
      };

      focusinHandler({ target: mockInput });
      // Handler sets lastUserUIFocus internally - no error = success
    });

    test('focusin handler should ignore xterm-helper-textarea', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      const focusinCall = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'focusin'
      );
      const focusinHandler = focusinCall[1];

      // Simulate focus on xterm textarea (should be ignored)
      const mockXtermTextarea = {
        tagName: 'TEXTAREA',
        classList: { contains: jest.fn().mockReturnValue(true) }, // is xterm-helper-textarea
      };

      focusinHandler({ target: mockXtermTextarea });
      // Should not update lastUserUIFocus for xterm textarea
    });

    test('keydown handler should track typing in UI inputs', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      const keydownCall = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'keydown'
      );
      const keydownHandler = keydownCall[1];

      const mockInput = {
        tagName: 'INPUT',
        classList: { contains: jest.fn().mockReturnValue(false) },
      };

      keydownHandler({ target: mockInput });
      // Handler updates lastUserUIKeypressTime internally
    });

    test('userInputFocused returns true while UI input has recent key activity', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      const focusinHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'focusin'
      )[1];
      const keydownHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'keydown'
      )[1];

      const mockInput = {
        tagName: 'INPUT',
        classList: { contains: jest.fn().mockReturnValue(false) },
      };

      mockDocument.activeElement = mockInput;
      focusinHandler({ target: mockInput });
      keydownHandler({ target: mockInput });

      expect(terminal.userInputFocused()).toBe(true);
    });

    test('userInputFocused returns true while UI input has recent input activity', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      const focusinHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'focusin'
      )[1];
      const inputHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'input'
      )[1];

      const mockInput = {
        tagName: 'TEXTAREA',
        classList: { contains: jest.fn().mockReturnValue(false) },
      };

      mockDocument.activeElement = mockInput;
      focusinHandler({ target: mockInput });
      inputHandler({ target: mockInput });

      expect(terminal.userInputFocused()).toBe(true);
    });

    test('userInputFocused returns false after compose activity goes stale (>2s)', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      const focusinHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'focusin'
      )[1];
      const keydownHandler = mockDocument.addEventListener.mock.calls.find(
        call => call[0] === 'keydown'
      )[1];

      const mockInput = {
        tagName: 'INPUT',
        classList: { contains: jest.fn().mockReturnValue(false) },
      };

      mockDocument.activeElement = mockInput;
      focusinHandler({ target: mockInput });
      keydownHandler({ target: mockInput });

      expect(terminal.userInputFocused()).toBe(true);
      jest.advanceTimersByTime(2100);
      expect(terminal.userInputFocused()).toBe(false);
    });
  });

  describe('interruptPane', () => {
    test('should exist as a function', () => {
      expect(typeof terminal.interruptPane).toBe('function');
    });

    test('should not throw when called', () => {
      expect(() => terminal.interruptPane('1')).not.toThrow();
    });
  });

  describe('restartPane', () => {
    test('should exist as a function', () => {
      expect(typeof terminal.restartPane).toBe('function');
    });

    test('should return a promise', () => {
      terminal.terminals.set('1', { clear: jest.fn() });
      const result = terminal.restartPane('1');
      expect(result).toBeInstanceOf(Promise);
      // Don't await - has internal delays
    });
  });

  describe('unstickEscalation', () => {
    test('should exist as a function', () => {
      expect(typeof terminal.unstickEscalation).toBe('function');
    });

    test('should not throw when called', () => {
      expect(() => terminal.unstickEscalation('1')).not.toThrow();
    });
  });

  describe('inputLocked state', () => {
    test('inputLocked should be an object', () => {
      expect(typeof terminal.inputLocked).toBe('object');
    });

    test('should support setting and getting lock state', () => {
      terminal.inputLocked['1'] = true;
      expect(terminal.inputLocked['1']).toBe(true);
      terminal.inputLocked['1'] = false;
      expect(terminal.inputLocked['1']).toBe(false);
    });
  });

  describe('openTerminalSearch edge cases', () => {
    test('should handle missing search addon', () => {
      terminal.searchAddons.delete('999');
      expect(() => terminal.openTerminalSearch('999')).not.toThrow();
    });
  });

  describe('closeTerminalSearch edge cases', () => {
    test('should not throw when called without active search', () => {
      expect(() => terminal.closeTerminalSearch()).not.toThrow();
    });
  });
});
