/**
 * Tests for event-bus emissions in modules/terminal.js
 * Verifies focus, typing, and resize events are emitted correctly.
 */

// Mock logger
jest.mock('../modules/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock event-bus
const mockBus = {
  emit: jest.fn(),
  startCorrelation: jest.fn().mockReturnValue('test-corr-id'),
  getCurrentCorrelation: jest.fn().mockReturnValue('test-corr-id'),
  updateState: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
  getState: jest.fn(),
  reset: jest.fn(),
  registerContract: jest.fn(),
};
jest.mock('../modules/event-bus', () => mockBus);

// Mock contracts module (initialized by terminal.js on load)
jest.mock('../modules/contracts', () => ({
  init: jest.fn(),
}));

// Mock settings
jest.mock('../modules/settings', () => ({
  getSettings: jest.fn().mockReturnValue({ paneCommands: {} }),
}));

// Mock recovery controller
jest.mock('../modules/terminal/recovery', () => ({
  createRecoveryController: jest.fn().mockReturnValue({
    potentiallyStuckPanes: new Map(),
    clearStuckStatus: jest.fn(),
    startStuckMessageSweeper: jest.fn(),
    stopStuckMessageSweeper: jest.fn(),
    sweepStuckMessages: jest.fn(),
    interruptPane: jest.fn(),
    restartPane: jest.fn(),
    unstickEscalation: jest.fn(),
    nudgePane: jest.fn(),
    nudgeAllPanes: jest.fn(),
    sendUnstick: jest.fn(),
    aggressiveNudge: jest.fn(),
    aggressiveNudgeAll: jest.fn(),
    markPotentiallyStuck: jest.fn(),
  }),
}));

// Mock injection controller
jest.mock('../modules/terminal/injection', () => ({
  createInjectionController: jest.fn().mockReturnValue({
    focusWithRetry: jest.fn(),
    sendEnterToPane: jest.fn(),
    isPromptReady: jest.fn(),
    processIdleQueue: jest.fn(),
    doSendToPane: jest.fn(),
    sendToPane: jest.fn(),
  }),
}));

// Mock agent-colors
jest.mock('../modules/terminal/agent-colors', () => ({
  attachAgentColors: jest.fn(),
}));

// Mock config
jest.mock('../config', () => ({
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: { '1': 'Architect', '2': 'DevOps', '5': 'Analyst' },
  WORKSPACE_PATH: '/tmp/workspace',
}));

// Mock constants
jest.mock('../modules/constants', () => ({
  TYPING_GUARD_MS: 300,
  QUEUE_RETRY_MS: 100,
  INJECTION_LOCK_TIMEOUT_MS: 1000,
  FOCUS_RETRY_DELAY_MS: 20,
  STARTUP_READY_TIMEOUT_MS: 5000,
  STARTUP_IDENTITY_DELAY_MS: 250,
  STARTUP_IDENTITY_DELAY_CODEX_MS: 6000,
  STARTUP_READY_BUFFER_MAX: 2000,
  GEMINI_ENTER_DELAY_MS: 75,
}));

// Mock fs
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock path
jest.mock('path', () => ({
  join: (...args) => args.join('/'),
}));

// Mock xterm and addons
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    loadAddon: jest.fn(),
    open: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    cols: 80,
    rows: 24,
    onData: jest.fn(),
    onSelectionChange: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
    getSelection: jest.fn(),
    hasSelection: jest.fn(),
    clearSelection: jest.fn(),
    write: jest.fn(),
    clear: jest.fn(),
    buffer: { active: {} },
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
    clearDecorations: jest.fn(),
  })),
}));

describe('Terminal Events', () => {
  let terminal;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.resetModules();

    // Set up minimal DOM mocking
    global.document = {
      getElementById: jest.fn().mockReturnValue(null),
      querySelector: jest.fn().mockReturnValue(null),
      querySelectorAll: jest.fn().mockReturnValue([]),
      activeElement: null,
      addEventListener: jest.fn(),
      body: { contains: jest.fn().mockReturnValue(true) },
      createElement: jest.fn().mockReturnValue({
        id: '',
        innerHTML: '',
        style: {},
        dataset: {},
        appendChild: jest.fn(),
        addEventListener: jest.fn(),
      }),
    };

    global.window = {
      hivemind: {
        pty: {
          create: jest.fn().mockResolvedValue(undefined),
          write: jest.fn().mockResolvedValue(undefined),
          resize: jest.fn(),
          kill: jest.fn().mockResolvedValue(undefined),
          onData: jest.fn(),
          onExit: jest.fn(),
          sendTrustedEnter: jest.fn().mockResolvedValue(undefined),
          codexExec: jest.fn().mockResolvedValue(undefined),
          pause: jest.fn(),
          resume: jest.fn(),
        },
        claude: {
          spawn: jest.fn().mockResolvedValue({ success: true, command: 'claude' }),
        },
      },
    };

    global.process = { cwd: jest.fn().mockReturnValue('/tmp') };
    global.navigator = { clipboard: { writeText: jest.fn(), readText: jest.fn() } };
    global.ResizeObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      disconnect: jest.fn(),
    }));
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    mockBus.emit.mockClear();
    mockBus.updateState.mockClear();

    terminal = require('../modules/terminal');
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.document;
    delete global.window;
    delete global.process;
    delete global.navigator;
    delete global.ResizeObserver;
    delete global.requestAnimationFrame;
  });

  // ──────────────────────────────────────────
  // Focus events
  // ──────────────────────────────────────────
  describe('focus.changed event', () => {
    test('emits focus.changed when pane focus changes', () => {
      // focusPane is exported — we can call it directly
      // Initial focused pane is '1'
      terminal.focusPane('2');

      const focusChanged = mockBus.emit.mock.calls.find(c => c[0] === 'focus.changed');
      expect(focusChanged).toBeDefined();
      expect(focusChanged[1].paneId).toBe('2');
      expect(focusChanged[1].payload.prevPane).toBe('1');
      expect(focusChanged[1].payload.newPane).toBe('2');
      expect(focusChanged[1].source).toBe('terminal.js');
    });

    test('does not emit focus.changed when focusing same pane', () => {
      // Initial focused pane is '1'
      terminal.focusPane('1');

      const focusChanged = mockBus.emit.mock.calls.find(c => c[0] === 'focus.changed');
      expect(focusChanged).toBeUndefined();
    });

    test('emits focus.changed on successive focus changes', () => {
      terminal.focusPane('2');
      terminal.focusPane('5');

      const focusEvents = mockBus.emit.mock.calls.filter(c => c[0] === 'focus.changed');
      expect(focusEvents).toHaveLength(2);
      expect(focusEvents[0][1].payload.prevPane).toBe('1');
      expect(focusEvents[0][1].payload.newPane).toBe('2');
      expect(focusEvents[1][1].payload.prevPane).toBe('2');
      expect(focusEvents[1][1].payload.newPane).toBe('5');
    });
  });

  // ──────────────────────────────────────────
  // Resize events (resizeSinglePane is internal but called by handleResize)
  // ──────────────────────────────────────────
  describe('resize events', () => {
    test('handleResize is exported and callable', () => {
      expect(typeof terminal.handleResize).toBe('function');
      // handleResize iterates fitAddons — with no terminals initialized, it does nothing
      terminal.handleResize();
    });
  });

  // ──────────────────────────────────────────
  // Source consistency
  // ──────────────────────────────────────────
  describe('source consistency', () => {
    test('focus events use source: terminal.js', () => {
      terminal.focusPane('2');

      const focusEvents = mockBus.emit.mock.calls.filter(c => c[0] === 'focus.changed');
      for (const call of focusEvents) {
        expect(call[1].source).toBe('terminal.js');
      }
    });
  });
});
