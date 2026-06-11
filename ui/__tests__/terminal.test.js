/**
 * Tests for terminal.js module
 * Terminal management, PTY injection, idle detection, message queuing
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock dependencies before requiring the module
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    loadAddon: jest.fn(),
    open: jest.fn(),
    write: jest.fn(),
    clear: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    refresh: jest.fn(),
    scrollToBottom: jest.fn(),
    onData: jest.fn(),
    onSelectionChange: jest.fn(),
    getSelection: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
  })),
}), { virtual: true });

jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({
    fit: jest.fn(),
  })),
}), { virtual: true });

jest.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('@xterm/addon-webgl', () => ({
  WebglAddon: jest.fn().mockImplementation(() => ({
    onContextLoss: jest.fn(),
  })),
}), { virtual: true });

jest.mock('@xterm/addon-search', () => ({
  SearchAddon: jest.fn().mockImplementation(() => ({
    findNext: jest.fn(),
    findPrevious: jest.fn(),
  })),
}), { virtual: true });

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

const mockStartupAiBriefing = {
  readStartupBriefingForInjection: jest.fn(() => ''),
};
jest.mock('../modules/startup-ai-briefing', () => mockStartupAiBriefing);

// Mock window.squidrun
const mockSquidRun = {
  invoke: jest.fn().mockResolvedValue({ ok: true }),
  send: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
  pty: {
    create: jest.fn().mockResolvedValue(),
    write: jest.fn().mockResolvedValue(),
    claimStartupInjection: jest.fn().mockResolvedValue({
      ok: true,
      claimed: true,
      claim: { claimId: 'startup-claim-default' },
    }),
    releaseStartupInjection: jest.fn().mockResolvedValue({ ok: true, released: true }),
    clipboardWriteText: jest.fn().mockResolvedValue({ success: true }),
    clipboardPasteText: jest.fn().mockResolvedValue({ success: true, method: 'insertText', insertedLength: 0 }),
    kill: jest.fn().mockResolvedValue(),
    resize: jest.fn().mockResolvedValue(),
    pause: jest.fn(),
    resume: jest.fn(),
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
  daemon: {
    terminalSnapshot: jest.fn().mockResolvedValue({ ok: false, terminals: [] }),
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
global.window = { squidrun: mockSquidRun };
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
    mockSquidRun.invoke.mockResolvedValue({ ok: true });
    mockSquidRun.daemon.terminalSnapshot.mockResolvedValue({ ok: false, terminals: [] });
    mockSquidRun.pty.write.mockResolvedValue();
    mockSquidRun.claude.spawn.mockResolvedValue({ success: true, command: 'claude' });
    delete mockSquidRun.paneHost;
    mockSettings.getSettings.mockReturnValue({ paneCommands: {} });
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
    mockDocument.activeElement = null;
    mockContractPromotion.checkPromotions.mockReturnValue([]);
    terminal.stopPromotionCheckTimer();
    terminal.setInputLocked('1', true);
    terminal.setInputLocked('2', true);
    terminal.setInputLocked('3', true);
    for (const timer of terminal._internals.terminalWriteFlushTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.terminalWriteFlushTimers.clear();
    terminal._internals.terminalWriteFrameBudgets.clear();
    terminal._internals.terminalWatermarks.clear();
    terminal._internals.terminalPaused.clear();
    for (const timer of terminal._internals.terminalPaintRefreshTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.terminalPaintRefreshTimers.clear();
    for (const timer of terminal._internals.terminalStreamingFitTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.terminalStreamingFitTimers.clear();
    terminal._internals.terminalStreamingLastFitAt.clear();
    ['1', '2', '3', 'trustquote-app', 'trustquote-lead', 'trustquote-invoice', 'trustquote-schedule-dispatch'].forEach((paneId) => {
      terminal.resetTerminalWriteQueue(paneId);
    });
    for (const timer of terminal._internals.resizeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.resizeDebounceTimers.clear();
    terminal._internals.terminalAppliedPtyGeometries.clear();
    terminal._internals.terminalOwnFitSuppressUntil.clear();
    terminal._internals.terminalOwnFitContainerSizes.clear();
    for (const timer of terminal._internals.deferredResizeTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.deferredResizeTimers.clear();
    terminal._internals.deferredResizeFirstRequestedAt.clear();
    terminal.setStartupWindowContext({
      windowKey: 'main',
      profileName: 'main',
      startupBundlePath: '',
      startupBundleReady: false,
    });
    terminal.clearPaneRuntimeOverride('trustquote-lead');
    terminal.clearPaneRuntimeOverride('trustquote-invoice');
    terminal.clearPaneRuntimeOverride('trustquote-schedule-dispatch');
    terminal.clearPaneRuntimeOverride('trustquote-app');
  });

  afterEach(() => {
    terminal.stopPromotionCheckTimer();
    terminal.stopStuckMessageSweeper();
    for (const timer of terminal._internals.terminalWriteFlushTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.terminalWriteFlushTimers.clear();
    terminal._internals.terminalWriteFrameBudgets.clear();
    terminal._internals.terminalWatermarks.clear();
    terminal._internals.terminalPaused.clear();
    for (const timer of terminal._internals.terminalPaintRefreshTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.terminalPaintRefreshTimers.clear();
    for (const timer of terminal._internals.resizeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.resizeDebounceTimers.clear();
    terminal._internals.terminalAppliedPtyGeometries.clear();
    terminal._internals.terminalOwnFitSuppressUntil.clear();
    for (const timer of terminal._internals.deferredResizeTimers.values()) {
      clearTimeout(timer);
    }
    terminal._internals.deferredResizeTimers.clear();
    terminal._internals.deferredResizeFirstRequestedAt.clear();
    terminal.clearPaneRuntimeOverride('trustquote-lead');
    terminal.clearPaneRuntimeOverride('trustquote-invoice');
    terminal.clearPaneRuntimeOverride('trustquote-schedule-dispatch');
    terminal.clearPaneRuntimeOverride('trustquote-app');
    jest.useRealTimers();
  });

  describe('PANE_IDS constant', () => {
    test('should have 3 pane IDs', () => {
      expect(terminal.PANE_IDS).toHaveLength(3);
    });

    test('should be strings 1,2,3', () => {
      expect(terminal.PANE_IDS).toEqual(['1', '2', '3']);
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
    test('uses trusted Enter path for Claude panes when hidden host mode is off', () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: false,
        paneCommands: { '1': 'claude --dangerously-skip-permissions' },
      });

      const caps = terminal.getPaneInjectionCapabilities('1');
      const isDarwin = process.platform === 'darwin';
      expect(caps.enterMethod).toBe(isDarwin ? 'pty' : 'trusted');
      expect(caps.submitMethod).toBe('sendTrustedEnter');
      expect(caps.requiresFocusForEnter).toBe(!isDarwin);
      expect(caps.verifySubmitAccepted).toBe(!isDarwin);
      expect(caps.deferSubmitWhilePaneActive).toBe(!isDarwin);
    });

    test('disables submit verification/defer for Claude on macOS hidden-host-off path', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

      try {
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'darwin',
        });
        jest.resetModules();

        const macSettings = require('../modules/settings');
        macSettings.getSettings.mockReturnValue({
          hiddenPaneHostsEnabled: false,
          paneCommands: { '1': 'claude --dangerously-skip-permissions' },
        });

        const macTerminal = require('../modules/terminal');
        const caps = macTerminal.getPaneInjectionCapabilities('1');
        expect(caps.enterMethod).toBe('pty');
        expect(caps.verifySubmitAccepted).toBe(false);
        expect(caps.deferSubmitWhilePaneActive).toBe(false);
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform);
        }
        jest.resetModules();
      }
    });

    test('uses PTY Enter path for Claude panes when hidden host mode is on', () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'claude --dangerously-skip-permissions' },
      });

      const caps = terminal.getPaneInjectionCapabilities('1');
      const isDarwin = process.platform === 'darwin';
      expect(caps.enterMethod).toBe('pty');
      expect(caps.submitMethod).toBe(isDarwin ? 'sendTrustedEnter' : 'hidden-pane-host-pty-enter');
      expect(caps.requiresFocusForEnter).toBe(false);
      expect(caps.verifySubmitAccepted).toBe(false);
      expect(caps.deferSubmitWhilePaneActive).toBe(false);
    });

    test('keeps hidden-host PTY Enter path even when pane lock is toggled off', () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'claude --dangerously-skip-permissions' },
      });
      terminal.setInputLocked('1', false);

      const caps = terminal.getPaneInjectionCapabilities('1');
      const isDarwin = process.platform === 'darwin';
      expect(caps.enterMethod).toBe('pty');
      expect(caps.submitMethod).toBe(isDarwin ? 'sendTrustedEnter' : 'hidden-pane-host-pty-enter');
      expect(caps.requiresFocusForEnter).toBe(false);
    });

    test('enables submit verification by default for Codex runtime', () => {
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '2': 'codex --yolo' },
      });

      const caps = terminal.getPaneInjectionCapabilities('2');
      const isDarwin = process.platform === 'darwin';
      expect(caps.mode).toBe('pty');
      expect(caps.modeLabel).toBe(isDarwin ? 'codex-pty' : 'codex-trusted');
      expect(caps.verifySubmitAccepted).toBe(true);
      expect(caps.enterMethod).toBe(isDarwin ? 'pty' : 'trusted');
    });

    test('keeps Codex submit verification on when hidden pane host uses PTY Enter', () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '2': 'codex --yolo' },
      });

      const caps = terminal.getPaneInjectionCapabilities('2');
      expect(caps.enterMethod).toBe('pty');
      expect(caps.submitMethod).toBe('hidden-pane-host-pty-enter');
      expect(caps.requiresFocusForEnter).toBe(false);
      expect(caps.verifySubmitAccepted).toBe(true);
    });

    test('uses source pane runtime and PTY Enter for TrustQuote route-owned panes', () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: false,
        paneCommands: {
          '2': 'codex --yolo',
          '3': 'claude --dangerously-skip-permissions',
        },
      });

      const builderCaps = terminal.getPaneInjectionCapabilities('trustquote-builder');
      expect(builderCaps.displayName).toBe('Codex');
      expect(builderCaps.enterMethod).toBe('pty');
      expect(builderCaps.submitMethod).toBe('trustquote-pty-enter');
      expect(builderCaps.requiresFocusForEnter).toBe(false);
      expect(builderCaps.verifySubmitAccepted).toBe(true);

      const oracleCaps = terminal.getPaneInjectionCapabilities('trustquote-oracle');
      expect(oracleCaps.displayName).toBe('Claude');
      expect(oracleCaps.enterMethod).toBe('pty');
      expect(oracleCaps.submitMethod).toBe('trustquote-pty-enter');
      expect(oracleCaps.requiresFocusForEnter).toBe(false);
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
    test('uses pane host injection in hidden host mode without claiming verified model submit', async () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'claude --dangerously-skip-permissions' },
      });
      mockSquidRun.paneHost = {
        inject: jest.fn().mockResolvedValue({ success: true }),
      };
      terminal.setInputLocked('1', false);
      const onComplete = jest.fn();

      terminal.sendToPane('1', 'test message', { onComplete });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSquidRun.paneHost.inject).toHaveBeenCalledWith('1', expect.objectContaining({
        message: 'test message',
        meta: expect.objectContaining({
          runtimeHint: 'claude',
          codexPane: false,
        }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        verified: false,
        routePending: true,
        signal: 'pane_host_inject',
        status: 'pane_host_route_pending',
        reason: 'hidden_pane_host_delivery_pending',
      }));
    });

    test('passes Codex runtime metadata to hidden pane host injection', async () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'codex' },
      });
      mockSquidRun.paneHost = {
        inject: jest.fn().mockResolvedValue({ success: true }),
      };
      terminal.setInputLocked('1', false);

      terminal.sendToPane('1', 'codex message', { meta: { deliverySource: 'hm-send' } });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSquidRun.paneHost.inject).toHaveBeenCalledWith('1', expect.objectContaining({
        message: 'codex message',
        meta: expect.objectContaining({
          deliverySource: 'hm-send',
          runtimeHint: 'codex',
          codexPane: true,
        }),
      }));
    });

    test('passes deliveryId to hidden pane host injection for verification callbacks', async () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'codex' },
      });
      mockSquidRun.paneHost = {
        inject: jest.fn().mockResolvedValue({ success: true }),
      };
      terminal.setInputLocked('1', false);

      terminal.sendToPane('1', 'oracle verdict payload', { deliveryId: 'oracle-90-delivery' });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSquidRun.paneHost.inject).toHaveBeenCalledWith('1', expect.objectContaining({
        message: 'oracle verdict payload',
        deliveryId: 'oracle-90-delivery',
      }));
    });

    test('bypasses pane host injection for startupInjection payloads', async () => {
      mockSettings.getSettings.mockReturnValue({
        hiddenPaneHostsEnabled: true,
        paneCommands: { '1': 'claude --dangerously-skip-permissions' },
      });
      mockSquidRun.paneHost = {
        inject: jest.fn().mockResolvedValue({ success: true }),
      };
      terminal.setInputLocked('1', false);

      terminal.sendToPane('1', 'startup gated payload', { startupInjection: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSquidRun.paneHost.inject).not.toHaveBeenCalled();
      expect(
        mockSquidRun.pty.write.mock.calls.some(
          ([paneId, text]) => (
            paneId === '1'
            && /^\[\d{2}:\d{2} local\] startup gated payload$/.test(text)
          )
        )
      ).toBe(true);
    });

    test('should queue message when injection in flight', () => {
      // Block immediate processing with injection lock
      terminal.setInjectionInFlight(true);

      terminal.sendToPane('1', 'test message');

      expect(terminal.messageQueue['1']).toHaveLength(1);
      expect(terminal.messageQueue['1'][0].message).toBe('test message');
      // Clear lock and timers without draining the whole scheduler graph.
      terminal.setInjectionInFlight(false);
      jest.clearAllTimers();
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

  describe('startup health briefing', () => {
    test('reads startup ai briefing when present', () => {
      mockStartupAiBriefing.readStartupBriefingForInjection.mockReturnValueOnce('STALE SNAPSHOT generated 16 minutes ago, account values may have moved.\n\n# AI Startup Briefing\n\n- The user cares about shipping automation safely.');
      const briefing = terminal._internals.fetchStartupAiBriefing();

      expect(mockStartupAiBriefing.readStartupBriefingForInjection).toHaveBeenCalledTimes(1);
      expect(briefing).toContain('STALE SNAPSHOT generated 16 minutes ago');
      expect(briefing).toContain('AI Startup Briefing');
      expect(briefing).not.toContain('[SQUIDRUN RECALL START]');
    });

    test('reads startup health artifact when present', () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => (
        String(targetPath).includes('startup-health.md')
      ));
      const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((targetPath) => {
        if (String(targetPath).includes('startup-health.md')) {
          return 'STARTUP HEALTH\n- Tests: 194 files, 195 Jest-discoverable suites\n';
        }
        return '';
      });

      expect(terminal._internals.fetchStartupHealthSummary()).toContain('STARTUP HEALTH');
      expect(terminal._internals.fetchStartupHealthSummary()).toContain('195 Jest-discoverable suites');

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('builds startup identity without recall blocks', async () => {
      mockStartupAiBriefing.readStartupBriefingForInjection.mockReturnValueOnce('# AI Startup Briefing\n\n- Current priority: supervisor stability.');
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      const message = await terminal._internals.buildStartupIdentityMessage('2');

      expect(message).toContain('# SQUIDRUN SESSION: Builder');
      expect(message).toContain('AI Startup Briefing');
      expect(message).not.toContain('STARTUP RECALL');
      expect(message).not.toContain('[SQUIDRUN RECALL START]');

      existsSpy.mockRestore();
    });

    test('uses pane runtime startup override for Squid Room app arms', async () => {
      terminal.setPaneRuntimeOverride('trustquote-lead', {
        label: 'TrustQuote Lead',
        roleLabel: 'TrustQuote Lead',
        provider: 'codex',
        startupMessage: 'TrustQuote arm role: Lead.\nWork in D:\\projects\\TrustQuote.',
      });

      const message = await terminal._internals.buildStartupIdentityMessage('trustquote-lead');

      expect(message).toContain('# SQUIDRUN SESSION: TrustQuote Lead');
      expect(message).toContain('TrustQuote arm role: Lead.');
      expect(message).toContain('Work in D:\\projects\\TrustQuote.');
      expect(message).not.toContain('SIDE-PROFILE STARTUP CONTEXT PENDING');

      terminal.clearPaneRuntimeOverride('trustquote-lead');
    });

    test('uses side-profile startup bundle instead of main Mira briefing for Eunbyeol startup', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-eunbyeol-startup-'));
      const bundlePath = path.join(tempRoot, 'startup-bundle.md');
      fs.writeFileSync(bundlePath, [
        '# Eunbyeol Startup Bundle',
        '',
        'Profile identity:',
        '- Profile: eunbyeol',
        '- Workspace: D:\\projects\\squidrun',
        '',
        'Eunbyeol case/runtime context only.',
      ].join('\n'));
      try {
        mockStartupAiBriefing.readStartupBriefingForInjection.mockReturnValueOnce([
          '## Startup-Facing Durable Requirements',
          '- Mira Presence Runtime acceptance must surface active Mira lane.',
          '## Live Current Lane (machine-readable)',
          'New Mira implementation seam',
        ].join('\n'));
        const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => (
          path.resolve(String(targetPath)) === path.resolve(bundlePath)
        ));
        const realReadFileSync = fs.readFileSync;
        const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((targetPath, encoding) => {
          if (path.resolve(String(targetPath)) === path.resolve(bundlePath)) {
            return realReadFileSync(targetPath, encoding);
          }
          return '';
        });

        terminal.setStartupWindowContext({
          loaded: true,
          windowKey: 'eunbyeol',
          windowTeam: 'eunbyeol',
          profileName: 'eunbyeol',
          profileLabel: 'Eunbyeol',
          sessionScopeId: 'app-session-372:eunbyeol',
          startupBundlePath: bundlePath,
          startupBundleReady: true,
        });

        const message = await terminal._internals.buildStartupIdentityMessage('2');

        expect(message).toContain('# SQUIDRUN SESSION: Builder');
        expect(message).toContain('# Eunbyeol Startup Bundle');
        expect(message).toContain('Eunbyeol case/runtime context only.');
        expect(message).not.toContain('Mira Presence Runtime');
        expect(message).not.toContain('New Mira implementation seam');
        expect(mockStartupAiBriefing.readStartupBriefingForInjection).not.toHaveBeenCalled();

        existsSpy.mockRestore();
        readSpy.mockRestore();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test('holds side-profile startup context when bundle path is stale or not freshly materialized', async () => {
      mockStartupAiBriefing.readStartupBriefingForInjection.mockReturnValueOnce('Mira Presence Runtime acceptance');
      terminal.setStartupWindowContext({
        loaded: false,
        windowKey: 'eunbyeol',
        profileName: 'eunbyeol',
        profileLabel: 'Eunbyeol',
        sessionScopeId: 'app-session-372:eunbyeol',
        startupBundlePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\window-teams\\eunbyeol\\startup-bundle.md',
        startupBundleReady: false,
      });

      const message = await terminal._internals.buildStartupIdentityMessage('2');

      expect(message).toContain('SIDE-PROFILE STARTUP CONTEXT PENDING: Eunbyeol');
      expect(message).toContain('Main startup continuity intentionally omitted');
      expect(message).not.toContain('Mira Presence Runtime');
      expect(mockStartupAiBriefing.readStartupBriefingForInjection).not.toHaveBeenCalled();
    });

    test('uses Mira as pane 1 startup display while preserving Architect role', async () => {
      mockStartupAiBriefing.readStartupBriefingForInjection.mockReturnValueOnce('');
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      const message = await terminal._internals.buildStartupIdentityMessage('1');

      expect(message).toContain('# SQUIDRUN SESSION: Mira (Architect)');
      expect(message).toContain('Architect');
      expect(message).not.toContain('# SQUIDRUN SESSION: Architect - Started');

      existsSpy.mockRestore();
    });
  });

  describe('broadcast', () => {
    test('should send message to pane 1 through the architect role contract', async () => {
      jest.useRealTimers();
      terminal.lastOutputTime['1'] = Date.now(); // Keep pane busy
      const statusCb = jest.fn();
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, connectionCb);

      terminal.broadcast('test broadcast');
      await Promise.resolve();

      // broadcast routes to pane 1 with priority + immediate
      // Immediate messages are processed instantly (bypass idle checks),
      // so the queue may already be empty. Verify the message was routed
      // to pane 1 via the connection status callback.
      expect(terminal.messageQueue['1']).toBeDefined();
      expect(connectionCb).toHaveBeenCalledWith('Message sent to Architect');
      expect(mockSquidRun.invoke).toHaveBeenCalledWith(
        'evidence-ledger:upsert-comms-journal',
        expect.objectContaining({
          senderRole: 'user',
          targetRole: 'architect',
          channel: 'user',
          direction: 'outbound',
          rawBody: 'test broadcast',
          status: 'recorded',
          attempt: 1,
          metadata: { source: 'ui.broadcast' },
        }),
      );
      jest.useFakeTimers();
    });

    test('should not fail hard when journal IPC is unavailable', () => {
      mockSquidRun.invoke.mockRejectedValueOnce(new Error('bridge down'));
      const connectionCb = jest.fn();
      terminal.setStatusCallbacks(null, connectionCb);

      expect(() => terminal.broadcast('best effort')).not.toThrow();
      expect(connectionCb).toHaveBeenCalledWith('Message sent to Architect');
    });

    test('sends raw pane-1 user text without adding a second recall block', async () => {
      terminal.setInjectionInFlight(true);

      terminal.broadcast('User direct prompt');
      await Promise.resolve();

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'][0].message).toBe('User direct prompt');
      expect(terminal.messageQueue['1'][0].message).not.toContain('[SQUIDRUN RECALL START]');

      jest.clearAllTimers();
      terminal.setInjectionInFlight(false);
    });

    test('marks long user broadcasts for clipboard-paste injection', async () => {
      terminal.setInjectionInFlight(true);
      const longMessage = 'L'.repeat(1500);

      terminal.broadcast(longMessage);
      await Promise.resolve();

      expect(terminal.messageQueue['1']).toBeDefined();
      expect(terminal.messageQueue['1'][0].message).toBe(longMessage);
      expect(terminal.messageQueue['1'][0].preferClipboardPasteForLongMessage).toBe(true);
      expect(terminal.messageQueue['1'][0].clipboardPasteThresholdBytes).toBe(1024);

      jest.clearAllTimers();
      terminal.setInjectionInFlight(false);
    });
  });

  describe('nudgePane', () => {
    test('should send Enter to pane', () => {
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      terminal.nudgePane('1');

      expect(mockSquidRun.pty.write).toHaveBeenCalledWith('1', '\r');
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
      expect(mockSquidRun.pty.write).toHaveBeenCalledTimes(3);
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
      expect(mockSquidRun.pty.kill).toHaveBeenCalledTimes(3);
      expect(connectionCb).toHaveBeenCalledWith('All terminals killed');
    });

    test('should handle kill errors gracefully', async () => {
      mockSquidRun.pty.kill.mockRejectedValueOnce(new Error('kill failed'));

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
      expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('1', 120, 40);
    });

    test('does not refit or resize the PTY when the pane container is stable', () => {
      jest.useFakeTimers();
      const stableContainer = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({ width: 800, height: 420 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? stableContainer : null
      ));
      terminal._internals.terminalAppliedPtyGeometries.set('1', {
        cols: 120,
        rows: 40,
        containerWidth: 800,
        containerHeight: 420,
      });
      const mockTerminalObj = { cols: 120, rows: 40 };
      const mockFitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 121;
          mockTerminalObj.rows = 40;
        }),
      };

      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal._internals.resizeSinglePane('1');

      expect(mockFitAddon.fit).not.toHaveBeenCalled();
      expect(mockSquidRun.pty.resize).not.toHaveBeenCalled();
    });

    test('does resize the PTY when the pane container actually changes size', () => {
      jest.useFakeTimers();
      const changedContainer = {
        clientWidth: 920,
        clientHeight: 500,
        getBoundingClientRect: jest.fn(() => ({ width: 920, height: 500 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? changedContainer : null
      ));
      terminal._internals.terminalAppliedPtyGeometries.set('1', {
        cols: 120,
        rows: 40,
        containerWidth: 800,
        containerHeight: 420,
      });
      const mockTerminalObj = { cols: 120, rows: 40 };
      const mockFitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 136;
          mockTerminalObj.rows = 48;
        }),
      };

      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal._internals.resizeSinglePane('1');

      expect(mockFitAddon.fit).toHaveBeenCalled();
      expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('1', 136, 48);
    });

    test('gates direct paint-refresh PTY resize when only xterm geometry changes', () => {
      const stableContainer = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({ width: 800, height: 420 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? stableContainer : null
      ));
      terminal._internals.terminalAppliedPtyGeometries.set('1', {
        cols: 120,
        rows: 40,
        containerWidth: 800,
        containerHeight: 420,
      });
      const mockTerminalObj = { cols: 121, rows: 40 };

      const result = terminal._internals.applyTerminalPtyResize('1', mockTerminalObj, {
        operation: 'paint_refresh',
      });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('container_geometry_unchanged');
      expect(mockSquidRun.pty.resize).not.toHaveBeenCalled();
    });

    test('suppresses ResizeObserver callbacks caused by an owned fit pass', () => {
      const originalResizeObserver = global.ResizeObserver;
      const observe = jest.fn();
      let observerCallback;
      global.ResizeObserver = jest.fn((callback) => {
        observerCallback = callback;
        return {
          observe,
          unobserve: jest.fn(),
          disconnect: jest.fn(),
        };
      });
      const container = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({ width: 800, height: 420 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? container : null
      ));
      const fitAddon = { fit: jest.fn() };

      try {
        terminal._internals.setupResizeObserver('1');
        terminal._internals.fitTerminalForPane('1', fitAddon, 'test_fit');
        observerCallback();

        expect(observe).toHaveBeenCalledWith(container);
        expect(terminal._internals.resizeDebounceTimers.has('1')).toBe(false);
      } finally {
        global.ResizeObserver = originalResizeObserver;
      }
    });

    test('A rendering: allows ResizeObserver refit when container changes during own-fit suppression window', () => {
      const originalResizeObserver = global.ResizeObserver;
      const observe = jest.fn();
      let observerCallback;
      global.ResizeObserver = jest.fn((callback) => {
        observerCallback = callback;
        return {
          observe,
          unobserve: jest.fn(),
          disconnect: jest.fn(),
        };
      });
      const container = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({
          width: container.clientWidth,
          height: container.clientHeight,
        })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? container : null
      ));
      terminal._internals.terminalAppliedPtyGeometries.set('1', {
        cols: 120,
        rows: 40,
        containerWidth: 800,
        containerHeight: 420,
      });
      const mockTerminalObj = { cols: 120, rows: 40 };
      const fitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 130;
          mockTerminalObj.rows = 46;
        }),
      };
      terminal.fitAddons.set('1', fitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      try {
        terminal._internals.setupResizeObserver('1');
        terminal._internals.fitTerminalForPane('1', fitAddon, 'test_fit');
        container.clientWidth = 900;
        container.clientHeight = 500;
        observerCallback();
        jest.advanceTimersByTime(300);

        expect(observe).toHaveBeenCalledWith(container);
        expect(fitAddon.fit).toHaveBeenCalledTimes(2);
        expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('1', 130, 46);
      } finally {
        global.ResizeObserver = originalResizeObserver;
      }
    });

    test('A rendering: schedules bounded viewport fit during streaming without PTY resize when container is stable', () => {
      const stableContainer = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({ width: 800, height: 420 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? stableContainer : null
      ));
      terminal._internals.terminalAppliedPtyGeometries.set('1', {
        cols: 120,
        rows: 40,
        containerWidth: 800,
        containerHeight: 420,
      });
      const mockTerminalObj = {
        cols: 120,
        rows: 40,
        write: jest.fn(),
        refresh: jest.fn(),
        scrollToBottom: jest.fn(),
      };
      const fitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 121;
          mockTerminalObj.rows = 40;
        }),
      };
      terminal.fitAddons.set('1', fitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'streaming chunk');
      expect(terminal._internals.terminalStreamingFitTimers.has('1')).toBe(true);
      jest.advanceTimersByTime(terminal._internals.TERMINAL_STREAMING_FIT_SETTLE_MS);

      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
      expect(mockTerminalObj.refresh).toHaveBeenCalledWith(0, 39);
      expect(mockSquidRun.pty.resize).not.toHaveBeenCalled();
      terminal.resetTerminalWriteQueue('1');
    });

    test('skips fit and pty resize for squid-room mirrors of shared main panes', () => {
      jest.useFakeTimers();
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-416:squid-room',
      });
      const mockTerminalObj = { cols: 80, rows: 24 };
      const mockFitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 140;
          mockTerminalObj.rows = 50;
        }),
      };

      terminal.fitAddons.set('2', mockFitAddon);
      terminal.terminals.set('2', mockTerminalObj);

      terminal.handleResize();
      jest.advanceTimersByTime(300);

      expect(terminal._internals.rendererOwnsPtyGeometry('2')).toBe(false);
      expect(mockFitAddon.fit).not.toHaveBeenCalled();
      expect(mockSquidRun.pty.resize).not.toHaveBeenCalled();
    });

    test('skips startup injection ownership for squid-room mirrors of shared main panes', () => {
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-430:squid-room',
      });

      expect(terminal._internals.rendererOwnsStartupInjection('1')).toBe(false);
      expect(terminal._internals.rendererOwnsStartupInjection('2')).toBe(false);
      expect(terminal._internals.rendererOwnsStartupInjection('3')).toBe(false);
      expect(terminal._internals.rendererOwnsStartupInjection('trustquote-app')).toBe(true);
    });

    test('keeps squid-room TrustQuote arms authoritative for their own PTY geometry', () => {
      jest.useFakeTimers();
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-416:squid-room',
      });
      const mockTerminalObj = { cols: 80, rows: 24 };
      const mockFitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 128;
          mockTerminalObj.rows = 36;
        }),
      };

      terminal.fitAddons.set('trustquote-app', mockFitAddon);
      terminal.terminals.set('trustquote-app', mockTerminalObj);

      terminal.handleResize();
      jest.advanceTimersByTime(300);

      expect(terminal._internals.rendererOwnsPtyGeometry('trustquote-app')).toBe(true);
      expect(mockFitAddon.fit).toHaveBeenCalled();
      expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('trustquote-app', 128, 36);
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

    test('defers resize while UI input is active and flushes final geometry by max delay', () => {
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

      const mockTerminalObj = { cols: 80, rows: 24 };
      const mockFitAddon = {
        fit: jest.fn(() => {
          mockTerminalObj.cols = 132;
          mockTerminalObj.rows = 44;
        }),
      };

      terminal.fitAddons.set('1', mockFitAddon);
      terminal.terminals.set('1', mockTerminalObj);

      terminal.handleResize();
      jest.advanceTimersByTime(0);
      expect(mockFitAddon.fit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(terminal._internals.RESIZE_INPUT_MAX_DEFER_MS - 1);
      expect(mockFitAddon.fit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(mockFitAddon.fit).toHaveBeenCalledTimes(1);
      expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('1', 132, 44);
    });
  });

  describe('terminal write queue responsiveness', () => {
    test('yields between queued terminal chunks instead of draining recursively', () => {
      const mockTerminalObj = {
        write: jest.fn((_data, callback) => callback()),
      };

      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'one');
      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'two');
      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'three');

      expect(mockTerminalObj.write).toHaveBeenCalledTimes(1);
      jest.runOnlyPendingTimers();
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(2);
      jest.runOnlyPendingTimers();
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(3);
      jest.runOnlyPendingTimers();
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(3);
    });

    test('uses a frame delay after the terminal write byte budget is exhausted', () => {
      const mockTerminalObj = {
        write: jest.fn((_data, callback) => callback()),
      };
      const largeChunk = 'x'.repeat(terminal._internals.TERMINAL_WRITE_FRAME_BYTE_BUDGET + 1);

      terminal._internals.queueTerminalWrite('1', mockTerminalObj, largeChunk);
      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'after-budget');

      expect(mockTerminalObj.write).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(terminal._internals.TERMINAL_WRITE_FRAME_YIELD_MS - 1);
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(2);
      jest.runOnlyPendingTimers();
      expect(mockTerminalObj.write).toHaveBeenCalledTimes(2);
    });

    test('refreshes the viewport after the terminal write queue drains', () => {
      const mockTerminalObj = {
        cols: 120,
        rows: 30,
        write: jest.fn((_data, callback) => callback()),
        refresh: jest.fn(),
        scrollToBottom: jest.fn(),
      };
      const fitAddon = { fit: jest.fn() };
      terminal.terminals.set('1', mockTerminalObj);
      terminal.fitAddons.set('1', fitAddon);

      terminal._internals.queueTerminalWrite('1', mockTerminalObj, 'restored scrollback');

      jest.runOnlyPendingTimers();
      jest.runOnlyPendingTimers();

      expect(fitAddon.fit).toHaveBeenCalled();
      expect(mockSquidRun.pty.resize).toHaveBeenCalledWith('1', 120, 30);
      expect(mockTerminalObj.refresh).toHaveBeenCalledWith(0, 29);
      expect(mockTerminalObj.scrollToBottom).toHaveBeenCalled();
    });

    test('does not let squid-room mirrors drive producer pause backpressure for shared panes', () => {
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-416:squid-room',
      });
      const mockTerminalObj = {
        write: jest.fn(),
      };

      terminal._internals.queueTerminalWrite('2', mockTerminalObj, 'x'.repeat(600000));

      expect(mockTerminalObj.write).toHaveBeenCalledTimes(1);
      expect(mockSquidRun.pty.pause).not.toHaveBeenCalled();
      expect(terminal._internals.terminalPaused.get('2')).toBe(false);
    });

    test('does not let squid-room mirrors resume producers for shared panes', () => {
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-416:squid-room',
      });
      terminal._internals.terminalPaused.set('3', true);
      terminal._internals.terminalWatermarks.set('3', 10);
      const mockTerminalObj = {
        write: jest.fn((_data, callback) => callback()),
      };

      terminal._internals.queueTerminalWrite('3', mockTerminalObj, 'ok');

      expect(mockSquidRun.pty.resume).not.toHaveBeenCalled();
      expect(terminal._internals.terminalPaused.get('3')).toBe(false);
    });
  });

  describe('B scrollback accessibility', () => {
    test('B scrollback: counts xterm scrollback rows independently of rendering fit state', () => {
      const terminalObj = {
        rows: 24,
        buffer: {
          active: {
            baseY: 72,
            viewportY: 48,
            cursorY: 12,
            length: 96,
          },
        },
      };

      const info = terminal._internals.getTerminalScrollbackInfo(terminalObj);

      expect(info.scrollbackRows).toBe(72);
      expect(terminal._internals.terminalHasScrollableScrollback(terminalObj)).toBe(true);
    });

    test('B scrollback: passive wheel guard preserves user scroll from auto-bottom during output', () => {
      const stableContainer = {
        clientWidth: 800,
        clientHeight: 420,
        getBoundingClientRect: jest.fn(() => ({ width: 800, height: 420 })),
      };
      mockDocument.getElementById.mockImplementation((id) => (
        id === 'terminal-1' ? stableContainer : null
      ));
      const terminalObj = {
        cols: 120,
        rows: 24,
        buffer: {
          active: {
            baseY: 40,
            viewportY: 10,
            cursorY: 4,
            length: 64,
          },
        },
        refresh: jest.fn(),
        scrollToBottom: jest.fn(),
      };
      const fitAddon = { fit: jest.fn() };
      terminal.terminals.set('1', terminalObj);
      terminal.fitAddons.set('1', fitAddon);

      expect(terminal._internals.markTerminalUserScroll('1', terminalObj, { deltaY: -120 })).toBe(true);
      terminal._internals.refreshTerminalViewport('1', terminalObj, fitAddon, {
        operation: 'scrollback_access_probe',
        forceFit: true,
      });

      expect(terminalObj.refresh).toHaveBeenCalledWith(0, 23);
      expect(terminalObj.scrollToBottom).not.toHaveBeenCalled();

      // Position-based, NOT time-based: after a long gap the viewport is STILL
      // scrolled up (viewportY 10 < baseY 40), so auto-scroll stays suppressed.
      // (Old behavior yanked to bottom once the 1.8s hold expired — the bug.)
      jest.advanceTimersByTime(180000); // long gap — position, not time, decides
      terminal._internals.refreshTerminalViewport('1', terminalObj, fitAddon, {
        operation: 'scrollback_access_probe_after_hold',
        forceFit: true,
      });
      expect(terminalObj.scrollToBottom).not.toHaveBeenCalled();

      // When the user scrolls back to the bottom (viewportY >= baseY), auto-follow
      // resumes naturally — no timer involved.
      terminalObj.buffer.active.viewportY = 40;
      terminal._internals.refreshTerminalViewport('1', terminalObj, fitAddon, {
        operation: 'scrollback_access_probe_returned_to_bottom',
        forceFit: true,
      });
      expect(terminalObj.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    test('B scrollback: at-bottom race — a 1-row streaming lag still auto-follows (does not stick)', () => {
      // The opposite-but-equal bug: when following at the bottom and a line lands,
      // baseY bumps before the viewport follows, so viewportY is transiently 1 row
      // short. A strict viewportY<baseY predicate would suppress the follow and
      // stick mid-stream. The bottom tolerance must keep auto-following here.
      const make = (baseY, viewportY) => ({
        rows: 24,
        buffer: { active: { baseY, viewportY, cursorY: 4, length: baseY + 24 } },
        refresh: jest.fn(),
        scrollToBottom: jest.fn(),
      });
      const fitAddon = { fit: jest.fn() };

      for (const lag of [0, 1, 2]) {
        const t = make(40, 40 - lag); // within tolerance => keep following
        terminal.terminals.set('1', t);
        terminal._internals.refreshTerminalViewport('1', t, fitAddon, { operation: 'stream', forceFit: true });
        expect(t.scrollToBottom).toHaveBeenCalledTimes(1);
      }

      const scrolled = make(40, 37); // 3 rows up => a genuine scroll-back, preserve
      terminal.terminals.set('1', scrolled);
      terminal._internals.refreshTerminalViewport('1', scrolled, fitAddon, { operation: 'stream', forceFit: true });
      expect(scrolled.scrollToBottom).not.toHaveBeenCalled();
    });

    test('B scrollback: installs a passive wheel listener without swallowing xterm wheel handling', () => {
      let wheelHandler;
      const container = {
        addEventListener: jest.fn((type, handler) => {
          if (type === 'wheel') wheelHandler = handler;
        }),
      };
      const terminalObj = {
        rows: 24,
        buffer: {
          active: {
            baseY: 12,
            viewportY: 2,
            cursorY: 3,
            length: 40,
          },
        },
      };
      const signal = {};

      const installed = terminal._internals.setupTerminalWheelScrollGuard('1', container, terminalObj, { signal });

      expect(installed).toBe(true);
      expect(container.addEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function),
        expect.objectContaining({ passive: true, signal })
      );

      const event = { deltaY: -120, preventDefault: jest.fn() };
      wheelHandler(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      // Position authority: viewport is scrolled up (viewportY 2 < baseY 12), so
      // auto-follow is suppressed regardless of any timer.
      expect(terminal._internals.shouldPreserveTerminalUserScroll('1', terminalObj)).toBe(true);
    });

    test('B scrollback: wheel fallback scrolls when xterm leaves the viewport pinned', () => {
      const terminalObj = {
        rows: 24,
        buffer: {
          active: {
            baseY: 72,
            viewportY: 72,
            cursorY: 3,
            length: 96,
          },
        },
        focus: jest.fn(),
        scrollLines: jest.fn(),
      };
      terminal.terminals.set('1', terminalObj);

      const event = { deltaY: -120, deltaMode: 0, preventDefault: jest.fn() };
      expect(terminal._internals.handleTerminalWheelScrollIntent('1', terminalObj, event)).toBe(true);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(terminalObj.focus).toHaveBeenCalled();
      jest.advanceTimersByTime(terminal._internals.TERMINAL_SCROLL_FALLBACK_DELAY_MS);

      expect(terminalObj.scrollLines).toHaveBeenCalledWith(-3);
      // Simulate the fallback scroll landing (viewport moves up 3 rows). Position
      // authority now preserves the user's scroll — no timer involved.
      terminalObj.buffer.active.viewportY = 69;
      expect(terminal._internals.shouldPreserveTerminalUserScroll('1', terminalObj)).toBe(true);
    });

    test('B scrollback: wheel fallback does not double-scroll after xterm moves the viewport', () => {
      const terminalObj = {
        rows: 24,
        buffer: {
          active: {
            baseY: 72,
            viewportY: 72,
            cursorY: 3,
            length: 96,
          },
        },
        focus: jest.fn(),
        scrollLines: jest.fn(),
      };
      terminal.terminals.set('1', terminalObj);

      expect(terminal._internals.handleTerminalWheelScrollIntent('1', terminalObj, { deltaY: -120 })).toBe(true);
      terminalObj.buffer.active.viewportY = 69;
      jest.advanceTimersByTime(terminal._internals.TERMINAL_SCROLL_FALLBACK_DELAY_MS);

      expect(terminalObj.scrollLines).not.toHaveBeenCalled();
    });

    test('B scrollback: PageUp key scrolls locally instead of relying on PTY input', () => {
      const terminalObj = {
        rows: 24,
        buffer: {
          active: {
            baseY: 72,
            viewportY: 72,
            cursorY: 3,
            length: 96,
          },
        },
        scrollLines: jest.fn(),
      };
      const event = {
        key: 'PageUp',
        shiftKey: true,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      expect(terminal._internals.handleTerminalKeyboardScroll('1', terminalObj, event)).toBe(true);

      expect(terminalObj.scrollLines).toHaveBeenCalledWith(-24);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    test('B scrollback: xterm viewport CSS keeps scroll overflow on the viewport layer', () => {
      const css = fs.readFileSync(path.join(__dirname, '../styles/layout.css'), 'utf8');

      expect(css).toMatch(/\.pane-terminal\s+\.xterm-viewport\s*\{[^}]*overflow-y:\s*auto\s*!important/s);
      expect(css).toMatch(/\.pane-terminal\s*\{[^}]*overflow:\s*hidden/s);
    });
  });

  describe('spawnAgent', () => {
    test('should skip if no terminal exists', async () => {
      terminal.terminals.clear();

      await terminal.spawnAgent('1');

      expect(mockSquidRun.claude.spawn).not.toHaveBeenCalled();
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

      expect(mockSquidRun.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockSquidRun.pty.write).toHaveBeenCalledWith('1', 'claude');
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
      expect(mockSquidRun.claude.spawn).toHaveBeenCalledWith('1');
      expect(mockSquidRun.pty.write).toHaveBeenCalled();
      expect(statusCb).toHaveBeenCalledWith('1', 'Starting...');
      expect(statusCb).toHaveBeenCalledWith('1', 'Working');

      terminal.unregisterCodexPane('1'); // Reset
      jest.useFakeTimers();
    });

    test('should handle spawn failure', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('3'); // Ensure Pane 3 is not codex
      terminal.terminals.set('3', { write: jest.fn() });
      mockSquidRun.claude.spawn.mockRejectedValueOnce(new Error('spawn failed'));
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnAgent('3');

      expect(statusCb).toHaveBeenCalledWith('3', 'Spawn failed');
      jest.useFakeTimers();
    });

  });

  describe('spawnAllAgents', () => {
    test('should spawn in all 3 panes', async () => {
      jest.useRealTimers();
      // Clear mock call counts from previous tests
      mockSquidRun.claude.spawn.mockClear();

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
      expect(mockSquidRun.claude.spawn).toHaveBeenCalledTimes(3);
      expect(connectionCb).toHaveBeenCalledWith('All agents running');
      jest.useFakeTimers();
    });

    test('skips panes already launched by daemon command-on-create', async () => {
      jest.useRealTimers();
      mockSquidRun.claude.spawn.mockClear();
      mockSquidRun.daemon.terminalSnapshot.mockResolvedValue({
        ok: true,
        terminals: [
          { paneId: '1', alive: true, mode: 'pty-command' },
          { paneId: '2', alive: true, mode: 'pty-command' },
          { paneId: '3', alive: true, mode: 'pty-command' },
        ],
      });

      for (const paneId of terminal.PANE_IDS) {
        terminal.terminals.set(paneId, { write: jest.fn() });
      }

      await terminal.spawnAllAgents();

      expect(mockSquidRun.claude.spawn).not.toHaveBeenCalled();
      expect(mockSquidRun.pty.write).not.toHaveBeenCalled();
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

    test('does not block standard pane creation on daemon scrollback snapshots', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.initTerminal('2');

      expect(mockSquidRun.daemon.terminalSnapshot).not.toHaveBeenCalled();
      expect(mockSquidRun.pty.create).toHaveBeenCalledWith('2', '/test/cwd');
      expect(terminal.terminals.has('2')).toBe(true);
    });

    test('creates fresh standard panes with configured daemon spawn commands when requested', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      mockSettings.getSettings.mockReturnValue({
        paneCommands: { '1': 'claude', '2': 'claude', '3': 'codex' },
      });

      await terminal.initTerminal('3', { spawnCommandOnCreate: true });

      expect(mockSquidRun.daemon.terminalSnapshot).not.toHaveBeenCalled();
      expect(mockSquidRun.pty.create).toHaveBeenCalledWith(
        '3',
        '/test/cwd',
        expect.objectContaining({
          paneCommand: 'codex',
          spawnCommandOnCreate: true,
          preferWorkingDir: true,
        })
      );
    });

    test('should enforce xterm scrollback cap in constructor options', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.initTerminal('1');

      expect(Terminal).toHaveBeenCalledWith(expect.objectContaining({ scrollback: 2000 }));
    });

    test('should restore daemon scrollback when attaching an existing dynamic pane PTY', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      mockSquidRun.daemon.terminalSnapshot.mockResolvedValueOnce({
        ok: true,
        terminals: [
          {
            paneId: 'trustquote-invoice',
            alive: true,
            scrollback: 'Windows PowerShell\r\nPS D:\\projects\\TrustQuote> ',
          },
        ],
      });

      await terminal.initTerminal('trustquote-invoice', { snapshotTimeoutMs: 777 });

      expect(mockSquidRun.daemon.terminalSnapshot).toHaveBeenCalledWith({ timeoutMs: 777 });
      const terminalInstance = terminal.terminals.get('trustquote-invoice');
      const writeCall = terminalInstance.write.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('D:\\projects\\TrustQuote')
      );
      expect(writeCall).toBeDefined();
      jest.runOnlyPendingTimers();
      expect(terminalInstance.refresh).toHaveBeenCalledWith(0, 23);
      expect(terminalInstance.scrollToBottom).toHaveBeenCalled();
    });

    test('recreates runtime override panes when the daemon PTY cwd is wrong', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      terminal.setPaneRuntimeOverride('trustquote-lead', {
        workingDir: 'D:\\projects\\TrustQuote',
        command: 'codex --yolo',
        recreateOnWorkingDirMismatch: true,
      });
      mockSquidRun.daemon.terminalSnapshot.mockResolvedValueOnce({
        ok: true,
        terminals: [
          {
            paneId: 'trustquote-lead',
            alive: true,
            cwd: 'D:\\projects\\squidrun\\ui',
            scrollback: 'PS D:\\projects\\squidrun\\ui> ',
          },
        ],
      });

      await terminal.initTerminal('trustquote-lead', {
        snapshotTimeoutMs: 777,
        recreateDelayMs: 0,
        repaintAfterRecreate: false,
      });

      expect(mockSquidRun.pty.kill).toHaveBeenCalledWith('trustquote-lead');
      expect(mockSquidRun.pty.create).toHaveBeenCalledWith(
        'trustquote-lead',
        'D:\\projects\\TrustQuote',
        expect.objectContaining({
          paneCommand: 'codex --yolo',
          env: expect.objectContaining({
            SQUIDRUN_ROLE: 'trustquote-lead',
            SQUIDRUN_WORKING_DIR: 'D:\\projects\\TrustQuote',
          }),
        })
      );
      const terminalInstance = terminal.terminals.get('trustquote-lead');
      const staleWrite = terminalInstance.write.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('D:\\projects\\squidrun\\ui')
      );
      expect(staleWrite).toBeUndefined();
      terminal.clearPaneRuntimeOverride('trustquote-lead');
    });

    test('creates command-bearing runtime override panes without typing the command later', async () => {
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-413:squid-room',
      });
      terminal.setPaneRuntimeOverride('trustquote-app', {
        roleId: 'trustquote-app',
        routeTarget: 'trustquote-app',
        workingDir: 'D:\\projects\\TrustQuote',
        command: 'codex --yolo',
        spawnCommandOnCreate: true,
        startupMessage: 'TrustQuote arm role: TrustQuote App.',
      });

      await terminal.initTerminal('trustquote-app');
      await terminal.spawnAgent('trustquote-app', 'codex');

      expect(mockSquidRun.pty.create).toHaveBeenCalledWith(
        'trustquote-app',
        'D:\\projects\\TrustQuote',
        expect.objectContaining({
          paneCommand: 'codex --yolo',
          spawnCommandOnCreate: true,
          preferWorkingDir: true,
          env: expect.objectContaining({
            SQUIDRUN_ROLE: 'trustquote-app',
            SQUIDRUN_SESSION_SCOPE_ID: 'app-session-413:squid-room',
            SQUIDRUN_PROFILE: 'main',
            SQUIDRUN_WINDOW_KEY: 'squid-room',
            SQUIDRUN_WORKING_DIR: 'D:\\projects\\TrustQuote',
          }),
        })
      );
      expect(mockSquidRun.pty.write).not.toHaveBeenCalledWith('trustquote-app', 'codex --yolo');
      terminal.clearPaneRuntimeOverride('trustquote-app');
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

    test('does not arm pane 1 startup injection from squid-room mirror reattach', async () => {
      terminal.terminals.delete('1');
      terminal.setStartupWindowContext({
        windowKey: 'squid-room',
        profileName: 'main',
        sessionScopeId: 'app-session-430:squid-room',
      });
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);

      await terminal.reattachTerminal('1', '', {
        createdAt: Date.now(),
      });

      expect(terminal.terminals.has('1')).toBe(true);
      expect(mockSquidRun.pty.claimStartupInjection).not.toHaveBeenCalled();
      expect(terminal.hasPendingStartupInjection('1')).toBe(false);
    });

    test('recreates runtime override panes during reattach when the daemon PTY cwd is wrong', async () => {
      terminal.terminals.delete('trustquote-lead');
      const mockContainer = {
        addEventListener: jest.fn(),
      };
      mockDocument.getElementById.mockReturnValue(mockContainer);
      terminal.setPaneRuntimeOverride('trustquote-lead', {
        workingDir: 'D:\\projects\\TrustQuote',
        command: 'codex --yolo',
        recreateOnWorkingDirMismatch: true,
      });

      const reattachPromise = terminal.reattachTerminal('trustquote-lead', 'PS D:\\projects\\squidrun\\ui> ', {
        cwd: 'D:\\projects\\squidrun\\ui',
        daemonTerminal: {
          paneId: 'trustquote-lead',
          alive: true,
          cwd: 'D:\\projects\\squidrun\\ui',
          scrollback: 'PS D:\\projects\\squidrun\\ui> ',
        },
        recreateDelayMs: 0,
        spawnAfterRecreate: false,
        repaintAfterRecreate: false,
      });
      await reattachPromise;

      expect(mockSquidRun.pty.kill).toHaveBeenCalledWith('trustquote-lead');
      expect(mockSquidRun.pty.create).toHaveBeenCalledWith(
        'trustquote-lead',
        'D:\\projects\\TrustQuote',
        expect.objectContaining({
          paneCommand: 'codex --yolo',
          env: expect.objectContaining({
            SQUIDRUN_ROLE: 'trustquote-lead',
            SQUIDRUN_WORKING_DIR: 'D:\\projects\\TrustQuote',
          }),
        })
      );
      const terminalInstance = terminal.terminals.get('trustquote-lead');
      const staleWrite = terminalInstance.write.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('D:\\projects\\squidrun\\ui')
      );
      expect(staleWrite).toBeUndefined();
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
      mockSquidRun.pty.write.mockRejectedValueOnce(new Error('write error'));
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
      mockSquidRun.settings.get.mockImplementationOnce(() => {
        throw new Error('settings error');
      });

      expect(terminal.isCodexPane('1')).toBe(false);
    });

    test('isCodexPane should handle missing paneCommands', () => {
      mockSquidRun.settings.get.mockReturnValue({});
      expect(terminal.isCodexPane('999')).toBe(false);
    });

    test('isCodexPane should handle null settings', () => {
      mockSquidRun.settings.get.mockReturnValue(null);
      expect(terminal.isCodexPane('1')).toBe(false);
    });
  });

  describe('spawnAgent edge cases', () => {
    test('should handle spawn returning failure', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('3'); // Ensure Pane 3 is not codex
      terminal.terminals.set('3', { write: jest.fn() });
      mockSquidRun.claude.spawn.mockResolvedValueOnce({ success: false });
      const statusCb = jest.fn();
      terminal.setStatusCallbacks(statusCb, null);

      await terminal.spawnAgent('3');

      // Should still update status but not write command
      expect(statusCb).toHaveBeenCalledWith('3', 'Starting...');
      expect(statusCb).toHaveBeenCalledWith('3', 'Working');
      jest.useFakeTimers();
    });

    test('should handle Codex command detection', async () => {
      jest.useRealTimers();
      terminal.unregisterCodexPane('3'); // Ensure Pane 3 is not codex
      terminal.terminals.set('3', { write: jest.fn() });
      mockSquidRun.claude.spawn.mockResolvedValueOnce({
        success: true,
        command: 'codex --interactive',
      });

      await terminal.spawnAgent('3');

      // Should detect Codex command and write it via PTY
      expect(mockSquidRun.pty.write).toHaveBeenCalledWith('3', 'codex --interactive');
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
      expect(terminal.PANE_IDS).toContain('3');
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

describe('Bug A: settle redraw + fit telemetry', () => {
  let paneSeq = 0;
  let PANE;
  let term;
  let fitAddon;
  let ptyResize;
  let recordFit;
  let content;

  beforeEach(() => {
    jest.useFakeTimers();
    PANE = `bugA-${++paneSeq}`; // unique pane per test: module-level settle state must not leak
    ptyResize = jest.fn();
    recordFit = jest.fn();
    global.window.squidrun.pty.resize = ptyResize;
    global.window.squidrun.pty.recordFitTelemetry = recordFit;
    content = 'frame-A';
    term = {
      cols: 80,
      rows: 24,
      write: jest.fn((_data, cb) => { if (cb) cb(); }),
      refresh: jest.fn(),
      scrollToBottom: jest.fn(),
      buffer: { active: { baseY: 0, getLine: () => ({ translateToString: () => content }) } },
    };
    fitAddon = { fit: jest.fn(), proposeDimensions: jest.fn(() => ({ cols: 80, rows: 24 })) };
    terminal.terminals.set(PANE, term);
    terminal.fitAddons.set(PANE, fitAddon);
  });

  afterEach(() => {
    terminal._internals.clearTerminalSettleRedraw(PANE);
    terminal.terminals.delete(PANE);
    terminal.fitAddons.delete(PANE);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('applyTerminalPtyResize re-pokes on identical geometry ONLY with forceApply (Oracle bar a)', () => {
    terminal._internals.applyTerminalPtyResize(PANE, term, { operation: 'seed' });
    expect(ptyResize).toHaveBeenCalledTimes(1); // first apply seeds geometry
    ptyResize.mockClear();

    terminal._internals.applyTerminalPtyResize(PANE, term, { operation: 'noop_same_dims' });
    expect(ptyResize).not.toHaveBeenCalled(); // same dims, no force -> skipped (the bug)

    terminal._internals.applyTerminalPtyResize(PANE, term, { operation: 'settle_redraw', forceApply: true });
    expect(ptyResize).toHaveBeenCalledTimes(1); // forceApply re-pokes the PTY on same dims (the fix)
  });

  test('captureTerminalFrameSignature changes iff visible content changes', () => {
    const a = terminal._internals.captureTerminalFrameSignature(term);
    expect(terminal._internals.captureTerminalFrameSignature(term)).toBe(a);
    content = 'frame-B';
    expect(terminal._internals.captureTerminalFrameSignature(term)).not.toBe(a);
  });

  test('captureTerminalFitCoherence flags drift between xterm and proposed dims', () => {
    expect(terminal._internals.captureTerminalFitCoherence(PANE, term, fitAddon).coherent).toBe(true);
    fitAddon.proposeDimensions = jest.fn(() => ({ cols: 100, rows: 24 }));
    expect(terminal._internals.captureTerminalFitCoherence(PANE, term, fitAddon).coherent).toBe(false);
  });

  test('settle redraw forces one re-poke and emits painted=true when the frame repainted', () => {
    terminal._internals.scheduleSettleRedraw(PANE, term, fitAddon);
    jest.advanceTimersByTime(250); // debounce (200ms) elapses -> performSettleRedraw fires
    expect(ptyResize).toHaveBeenCalled(); // forceApply re-poke on same dims

    content = 'redrawn-frame'; // simulate the agent TUI repainting after the re-poke
    jest.advanceTimersByTime(200); // paint sample (140ms) elapses -> telemetry emitted
    expect(recordFit).toHaveBeenCalledTimes(1);
    const payload = recordFit.mock.calls[0][0];
    expect(payload.paneId).toBe(PANE);
    expect(payload.operation).toBe('settle_redraw');
    expect(payload.painted).toBe(true);
    expect(payload.coherent).toBe(true);
    expect(payload.quietSettle).toBe(true); // no streaming write before the re-poke -> evidence-grade
  });

  test('quietSettle=true when the burst was quiet before the re-poke', () => {
    terminal._internals.performSettleRedraw(PANE, term, fitAddon); // no prior queueTerminalWrite
    jest.advanceTimersByTime(200);
    expect(recordFit.mock.calls[0][0].quietSettle).toBe(true);
  });

  test('quietSettle=false when a streaming write landed just before the re-poke (confound excluded)', () => {
    terminal._internals.queueTerminalWrite(PANE, term, 'mid-stream-chunk'); // stamps lastWriteAt = now
    terminal._internals.performSettleRedraw(PANE, term, fitAddon); // re-poke in the same tick -> not quiet
    jest.advanceTimersByTime(200);
    const payload = recordFit.mock.calls.find((c) => c[0].operation === 'settle_redraw')[0];
    expect(payload.quietSettle).toBe(false);
  });

  test('settle redraw rate-limits forced re-pokes (protects steady_state_event_rates)', () => {
    terminal._internals.scheduleSettleRedraw(PANE, term, fitAddon);
    jest.advanceTimersByTime(250); // first re-poke fires
    const firstCount = ptyResize.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    terminal._internals.scheduleSettleRedraw(PANE, term, fitAddon); // again, well within MIN_INTERVAL (1100ms)
    jest.advanceTimersByTime(250); // debounce elapses but cooldown has not
    expect(ptyResize.mock.calls.length).toBe(firstCount); // no second re-poke yet
  });

  test('settle telemetry is best-effort: a rejecting recordFitTelemetry (handler absent pre-restart) does not throw', () => {
    recordFit.mockImplementation(() => Promise.reject(new Error('No handler registered for terminal-fit-telemetry')));
    expect(() => {
      terminal._internals.scheduleSettleRedraw(PANE, term, fitAddon);
      jest.advanceTimersByTime(250);
      jest.advanceTimersByTime(200);
    }).not.toThrow();
    expect(recordFit).toHaveBeenCalled();
  });

  test('painted=false when the frame did not change after the re-poke (X inert -> Y signal)', () => {
    terminal._internals.scheduleSettleRedraw(PANE, term, fitAddon);
    jest.advanceTimersByTime(250);
    jest.advanceTimersByTime(200); // no content mutation -> before == after
    const payload = recordFit.mock.calls[0][0];
    expect(payload.painted).toBe(false);
  });
});

describe('runTerminalScrollProbe (Bug B proof seam)', () => {
  const PROBE_PROP = '__squidrunTerminalScrollProbeTarget';

  function makeTarget({ viewportY = 100, baseY = 100, length = 124, cursorY = 0 } = {}) {
    const buffer = { active: { baseY, viewportY, cursorY, length } };
    const term = {
      rows: 24,
      buffer,
      scrollLines: jest.fn((n) => {
        buffer.active.viewportY = Math.max(0, buffer.active.viewportY + Number(n));
      }),
    };
    return { paneId: 'trustquote-app', terminal: term };
  }

  beforeEach(() => {
    mockDocument.getElementById.mockReset();
    mockDocument.activeElement = null;
  });

  it('returns container_not_found when the container is missing', () => {
    mockDocument.getElementById.mockReturnValue(null);
    const res = terminal.runTerminalScrollProbe({ containerId: 'nope', op: 'scrollLines', lines: -10 });
    expect(res.reason).toBe('container_not_found');
    expect(res.success).toBe(false);
  });

  it('still returns terminal_probe_target_unavailable when the expando is absent', () => {
    mockDocument.getElementById.mockReturnValue({});
    const res = terminal.runTerminalScrollProbe({ containerId: 'terminal-x', op: 'scrollLines', lines: -10 });
    expect(res.reason).toBe('terminal_probe_target_unavailable');
    expect(res.success).toBe(false);
  });

  it('reads real scrollback and reports movement once the read context matches the target world', () => {
    const target = makeTarget({ viewportY: 100, baseY: 100, length: 124 });
    mockDocument.getElementById.mockReturnValue({ [PROBE_PROP]: target });

    const res = terminal.runTerminalScrollProbe({
      containerId: 'terminal-trustquote-app',
      windowKey: 'squid-room',
      op: 'scrollLines',
      lines: -10,
    });

    expect(res.success).toBe(true);
    expect(res.paneId).toBe('trustquote-app');
    expect(res.before.scrollbackRows).toBe(100); // length 124 - rows 24
    expect(target.terminal.scrollLines).toHaveBeenCalledWith(-10);
    expect(res.after.viewportY).toBe(90);
    expect(res.moved).toBe(true);
  });

  it('reports xterm_helper_textarea_not_found for dispatchKey with no helper textarea', () => {
    const target = makeTarget();
    mockDocument.getElementById.mockReturnValue({
      [PROBE_PROP]: target,
      querySelector: jest.fn(() => null),
    });
    const res = terminal.runTerminalScrollProbe({
      containerId: 'terminal-x',
      op: 'dispatchKey',
      key: 'PageUp',
      waitMs: 0,
    });
    expect(res.reason).toBe('xterm_helper_textarea_not_found');
  });
});
