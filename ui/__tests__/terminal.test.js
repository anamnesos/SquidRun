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
    codexExec: jest.fn().mockResolvedValue(),
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

const terminal = require('../modules/terminal');

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
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
    mockDocument.activeElement = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('PANE_IDS constant', () => {
    test('should have 6 pane IDs', () => {
      expect(terminal.PANE_IDS).toHaveLength(6);
    });

    test('should be strings 1-6', () => {
      expect(terminal.PANE_IDS).toEqual(['1', '2', '3', '4', '5', '6']);
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

  describe('setSDKMode', () => {
    test('should enable SDK mode', () => {
      terminal.setSDKMode(true);
      // SDK mode blocks initTerminals - tested via integration
    });

    test('should disable SDK mode', () => {
      terminal.setSDKMode(false);
      // PTY operations allowed
    });
  });

  describe('isIdle', () => {
    test('should return true when no output recorded', () => {
      terminal.lastOutputTime['1'] = 0;
      expect(terminal.isIdle('1')).toBe(true);
    });

    test('should return true when output was long ago', () => {
      terminal.lastOutputTime['1'] = Date.now() - 5000; // 5 seconds ago
      expect(terminal.isIdle('1')).toBe(true);
    });

    test('should return false when output was recent', () => {
      terminal.lastOutputTime['1'] = Date.now() - 500; // 0.5 seconds ago
      expect(terminal.isIdle('1')).toBe(false);
    });

    test('should use IDLE_THRESHOLD_MS (2000ms)', () => {
      // At exactly threshold
      terminal.lastOutputTime['1'] = Date.now() - 2000;
      expect(terminal.isIdle('1')).toBe(true);

      // Just under threshold
      terminal.lastOutputTime['1'] = Date.now() - 1999;
      expect(terminal.isIdle('1')).toBe(false);
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
      mockHivemind.settings.get.mockReturnValue({
        paneCommands: { '2': 'codex --mode exec' },
      });

      // Pane not registered but settings say codex
      expect(terminal.isCodexPane('2')).toBe(true);
    });
  });

  describe('sendToPane', () => {
    test('should queue message when pane is busy', () => {
      // Stay on fake timers - set lastOutputTime to "now" to simulate busy pane
      const now = Date.now();
      jest.setSystemTime(now);
      terminal.lastOutputTime['1'] = now; // Recent output = busy

      terminal.sendToPane('1', 'test message');

      expect(terminal.messageQueue['1']).toHaveLength(1);
      expect(terminal.messageQueue['1'][0].message).toBe('test message');
      // Clear any pending processQueue timers
      jest.runAllTimers();
    });

    test('should include timestamp in queued message', () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      const before = Date.now();
      terminal.sendToPane('1', 'test');
      const after = Date.now();

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      const timestamp = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1].timestamp;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
      jest.useFakeTimers();
    });

    test('should include onComplete callback if provided', () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      const callback = jest.fn();
      terminal.sendToPane('1', 'test', { onComplete: callback });

      expect(terminal.messageQueue['1']).toBeDefined();
      const lastItem = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(lastItem.onComplete).toBe(callback);
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

      // Should queue message for pane 1
      expect(terminal.messageQueue['1']).toBeDefined();
      const lastItem = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(lastItem.message).toBe('test broadcast');
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
    test('should nudge all 6 panes', () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      terminal.nudgeAllPanes();

      expect(connectionCb).toHaveBeenCalledWith('Nudging all agents...');
      expect(mockHivemind.pty.write).toHaveBeenCalledTimes(6);
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

      // Enter should be sent after 150ms delay
      jest.advanceTimersByTime(150);
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', '\r');
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
    test('should kill all 6 panes', async () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.killAllTerminals();

      expect(connectionCb).toHaveBeenCalledWith('Killing all terminals...');
      expect(mockHivemind.pty.kill).toHaveBeenCalledTimes(6);
      expect(connectionCb).toHaveBeenCalledWith('All terminals killed');
    });

    test('should handle kill errors gracefully', async () => {
      mockHivemind.pty.kill.mockRejectedValueOnce(new Error('kill failed'));

      await expect(terminal.killAllTerminals()).resolves.not.toThrow();
    });
  });

  describe('handleResize', () => {
    test('should fit and resize all terminals', () => {
      const mockFitAddon = { fit: jest.fn() };
      const mockTerminalObj = { cols: 80, rows: 24 };

      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal.handleResize();

      expect(mockFitAddon.fit).toHaveBeenCalled();
      expect(mockHivemind.pty.resize).toHaveBeenCalledWith('1', 80, 24);
    });

    test('should handle resize errors gracefully', () => {
      const mockFitAddon = { fit: jest.fn().mockImplementation(() => { throw new Error('fit error'); }) };
      terminal.fitAddons.set('1', mockFitAddon);

      expect(() => terminal.handleResize()).not.toThrow();
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

    test('should block in SDK mode', async () => {
      terminal.setSDKMode(true);

      await terminal.freshStartAll();

      expect(alert).toHaveBeenCalledWith(expect.stringContaining('not available in SDK mode'));
      expect(confirm).not.toHaveBeenCalled();

      terminal.setSDKMode(false); // Reset
    });
  });

  describe('syncSharedContext', () => {
    test('should read context and broadcast', async () => {
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.syncSharedContext();

      expect(mockHivemind.context.read).toHaveBeenCalled();
      expect(connectionCb).toHaveBeenCalledWith('Syncing shared context...');
      expect(connectionCb).toHaveBeenCalledWith('Shared context synced to all panes');
    });

    test('should handle read failure', async () => {
      mockHivemind.context.read.mockResolvedValueOnce({ success: false, error: 'read error' });
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.syncSharedContext();

      expect(connectionCb).toHaveBeenCalledWith('Sync failed: read error');
    });

    test('should handle exception', async () => {
      mockHivemind.context.read.mockRejectedValueOnce(new Error('network error'));
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      await terminal.syncSharedContext();

      expect(connectionCb).toHaveBeenCalledWith('Sync error: network error');
    });
  });

  describe('spawnClaude', () => {
    test('should skip if no terminal exists', async () => {
      terminal.terminals.clear();

      await terminal.spawnClaude('1');

      expect(mockHivemind.claude.spawn).not.toHaveBeenCalled();
    });

    test('should block in SDK mode', async () => {
      terminal.terminals.set('1', { test: true });
      terminal.setSDKMode(true);

      await terminal.spawnClaude('1');

      expect(mockHivemind.claude.spawn).not.toHaveBeenCalled();

      terminal.setSDKMode(false); // Reset
    });

    test('should spawn and write command', async () => {
      jest.useRealTimers();
      const mockTerminalObj = { write: jest.fn() };
      terminal.terminals.set('1', mockTerminalObj);
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      // Just test the immediate part, not the delayed identity injection
      const spawnPromise = terminal.spawnClaude('1');

      // Wait for initial spawn to complete
      await spawnPromise;

      expect(mockHivemind.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', 'claude');
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting...');
      jest.useFakeTimers();
    });

    test('should handle Codex pane differently', async () => {
      jest.useRealTimers();
      terminal.registerCodexPane('1');
      terminal.terminals.set('1', { write: jest.fn() });
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnClaude('1');

      // Codex now calls spawn to get command (needed after model switch)
      expect(mockHivemind.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', 'claude');
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting Codex...');
      expect(statusCb).toHaveBeenCalledWith('1', 'Codex exec ready');

      terminal.unregisterCodexPane('1'); // Reset
      jest.useFakeTimers();
    });

    test('should handle spawn failure', async () => {
      terminal.terminals.set('1', { write: jest.fn() });
      mockHivemind.claude.spawn.mockRejectedValueOnce(new Error('spawn failed'));
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnClaude('1');

      expect(statusCb).toHaveBeenCalledWith('1', 'Spawn failed');
    });
  });

  describe('spawnAllClaude', () => {
    test('should spawn in all 6 panes', async () => {
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

      await terminal.spawnAllClaude();

      expect(connectionCb).toHaveBeenCalledWith('Starting agents in all panes...');
      expect(mockHivemind.claude.spawn).toHaveBeenCalledTimes(6);
      expect(connectionCb).toHaveBeenCalledWith('All agents running');
      jest.useFakeTimers();
    });
  });

  describe('message queue processing', () => {
    test('should process queue when pane becomes idle', () => {
      jest.useRealTimers();
      // Queue a message while busy
      terminal.lastOutputTime['1'] = Date.now();
      terminal.sendToPane('1', 'test message\r');

      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      jest.useFakeTimers();
    });

    test('should track message timestamp for timeout logic', () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      terminal.sendToPane('1', 'test');

      expect(terminal.messageQueue['1']).toBeDefined();
      const item = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(item.timestamp).toBeDefined();
      expect(typeof item.timestamp).toBe('number');
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

  describe('initTerminals', () => {
    test('should skip in SDK mode', async () => {
      terminal.setSDKMode(true);

      await terminal.initTerminals();

      // Should not create any PTY
      expect(mockHivemind.pty.create).not.toHaveBeenCalled();

      terminal.setSDKMode(false); // Reset
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

    test('isIdle should handle missing pane', () => {
      delete terminal.lastOutputTime['999'];
      expect(terminal.isIdle('999')).toBe(true);
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
      terminal.setSDKMode(false);
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

  describe('spawnClaude edge cases', () => {
    test('should handle spawn returning failure', async () => {
      jest.useRealTimers();
      terminal.terminals.set('1', { write: jest.fn() });
      mockHivemind.claude.spawn.mockResolvedValueOnce({ success: false });
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnClaude('1');

      // Should still update status but not write command
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting...');
      expect(statusCb).toHaveBeenCalledWith('1', 'Working');
      jest.useFakeTimers();
    });

    test('should handle Codex command detection', async () => {
      jest.useRealTimers();
      terminal.terminals.set('1', { write: jest.fn() });
      mockHivemind.claude.spawn.mockResolvedValueOnce({
        success: true,
        command: 'codex --interactive',
      });

      await terminal.spawnClaude('1');

      // Should detect Codex command
      expect(mockHivemind.pty.write).toHaveBeenCalledWith('1', 'codex --interactive');
      jest.useFakeTimers();
    });
  });

  describe('syncSharedContext details', () => {
    test('should format sync message correctly', async () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      mockHivemind.context.read.mockResolvedValueOnce({
        success: true,
        content: 'test content here',
      });

      await terminal.syncSharedContext();

      // Should have queued a sync message
      expect(terminal.messageQueue['1']).toBeDefined();
      const lastItem = terminal.messageQueue['1'][terminal.messageQueue['1'].length - 1];
      expect(lastItem.message).toContain('[HIVEMIND SYNC]');
      expect(lastItem.message).toContain('test content here');
      jest.useFakeTimers();
    });
  });

  describe('SDK mode edge cases', () => {
    test('setSDKMode should accept true', () => {
      expect(() => terminal.setSDKMode(true)).not.toThrow();
    });

    test('setSDKMode should accept false', () => {
      expect(() => terminal.setSDKMode(false)).not.toThrow();
    });
  });

  describe('sendToPane edge cases', () => {
    test('should queue message when pane is busy', () => {
      // Stay on fake timers - set lastOutputTime to "now" to simulate busy pane
      const now = Date.now();
      jest.setSystemTime(now);
      terminal.lastOutputTime['1'] = now; // Keep pane busy

      terminal.sendToPane('1', 'Test message');

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'].length).toBeGreaterThan(0);
      // Clear any pending processQueue timers
      jest.runAllTimers();
    });

    test('should handle empty message', () => {
      expect(() => terminal.sendToPane('1', '')).not.toThrow();
    });

    test('should handle SDK mode', () => {
      terminal.setSDKMode(true);
      expect(() => terminal.sendToPane('1', 'test')).not.toThrow();
      terminal.setSDKMode(false);
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

  describe('PANE_IDS constant', () => {
    test('should have 6 pane IDs', () => {
      expect(terminal.PANE_IDS).toHaveLength(6);
      expect(terminal.PANE_IDS).toContain('1');
      expect(terminal.PANE_IDS).toContain('6');
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
        title: '',
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
          title: '',
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
          title: '',
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
        };
        mockDocument.getElementById.mockReturnValue(mockLockIcon);

        terminal.setInputLocked('1', true);

        expect(mockLockIcon.innerHTML).toContain('svg');
        expect(mockLockIcon.innerHTML).toContain('pane-btn-icon');
        expect(mockLockIcon.title).toContain('locked');
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

  describe('Idle Detection', () => {
    describe('isIdle', () => {
      test('should return true when pane has been idle', () => {
        terminal.lastOutputTime['1'] = Date.now() - 10000; // 10 seconds ago
        expect(terminal.isIdle('1')).toBe(true);
      });

      test('should return false when pane has recent output', () => {
        terminal.lastOutputTime['1'] = Date.now() - 500; // 0.5 seconds ago
        expect(terminal.isIdle('1')).toBe(false);
      });

      test('should return true for undefined pane', () => {
        delete terminal.lastOutputTime['3'];
        expect(terminal.isIdle('3')).toBe(true);
      });
    });
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

      expect(mockDocument.addEventListener).toHaveBeenCalledWith('focusin', expect.any(Function));
    });

    test('should attach keydown event listener', () => {
      mockDocument.addEventListener.mockClear();
      terminal.initUIFocusTracker();

      expect(mockDocument.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
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
