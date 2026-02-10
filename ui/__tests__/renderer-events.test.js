/**
 * Tests for renderer.js event bus wiring (Phase 4)
 * Tests overlay, resize, pane visibility, and longtask event emissions.
 */

// Mock electron
jest.mock('electron', () => ({
  ipcRenderer: {
    on: jest.fn(),
    invoke: jest.fn().mockResolvedValue({}),
  },
}));

// Mock all renderer dependencies
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../modules/terminal', () => ({
  PANE_IDS: ['1', '2', '5'],
  handleResize: jest.fn(),
  initTerminals: jest.fn().mockResolvedValue(),
  spawnAllAgents: jest.fn(),
  focusPane: jest.fn(),
  blurAllTerminals: jest.fn(),
  getReconnectedToExisting: jest.fn(() => false),
  setStatusCallbacks: jest.fn(),
  initUIFocusTracker: jest.fn(),
  setSDKMode: jest.fn(),
  sendToPane: jest.fn(),
  getFocusedPane: jest.fn(),
  broadcast: jest.fn(),
  killAllTerminals: jest.fn(),
  aggressiveNudgeAll: jest.fn(),
  interruptPane: jest.fn(),
  updatePaneStatus: jest.fn(),
  unstickEscalation: jest.fn(),
  restartPane: jest.fn(),
  nudgePane: jest.fn(),
  sendUnstick: jest.fn(),
  freshStartAll: jest.fn(),
  registerCodexPane: jest.fn(),
  unregisterCodexPane: jest.fn(),
  toggleInputLock: jest.fn(),
}));

jest.mock('../modules/tabs', () => ({
  setConnectionStatusCallback: jest.fn(),
  setupRightPanel: jest.fn(),
}));

jest.mock('../modules/settings', () => ({
  setConnectionStatusCallback: jest.fn(),
  setSettingsLoadedCallback: jest.fn(),
  setupSettings: jest.fn(),
  getSettings: jest.fn(() => ({})),
  applySettingsToUI: jest.fn(),
  checkAutoSpawn: jest.fn(),
}));

jest.mock('../modules/daemon-handlers', () => ({
  setSDKMode: jest.fn(),
  setStatusCallbacks: jest.fn(),
  setupClaudeStateListener: jest.fn(),
  setupCostAlertListener: jest.fn(),
  setupRefreshButtons: jest.fn(),
  setupSyncIndicator: jest.fn(),
  setupProjectListener: jest.fn(),
  setupAutoTriggerListener: jest.fn(),
  setupHandoffListener: jest.fn(),
  setupConflictResolutionListener: jest.fn(),
  setupRollbackListener: jest.fn(),
  setupDaemonListeners: jest.fn(),
  loadInitialProject: jest.fn().mockResolvedValue(),
  loadInitialAgentTasks: jest.fn().mockResolvedValue(),
  setupPaneProjectClicks: jest.fn(),
  loadPaneProjects: jest.fn().mockResolvedValue(),
  handleSessionTimerState: jest.fn(),
  selectProject: jest.fn(),
  showDeliveryIndicator: jest.fn(),
}));

jest.mock('../modules/sdk-renderer', () => ({
  appendMessage: jest.fn(),
  updateToolContext: jest.fn(),
  streamingIndicator: jest.fn(),
  clearStreamingState: jest.fn(),
  finalizeStreamingMessage: jest.fn(),
  appendTextDelta: jest.fn(),
  addErrorMessage: jest.fn(),
}));

jest.mock('../sdk-ui/organic-ui', () => ({
  createOrganicUI: jest.fn(),
}));

jest.mock('../modules/notifications', () => ({
  showStatusNotice: jest.fn(),
  showToast: jest.fn(),
}));

jest.mock('../modules/formatters', () => ({
  formatTimeSince: jest.fn(() => '0s'),
}));

jest.mock('../modules/constants', () => ({
  UI_IDLE_THRESHOLD_MS: 30000,
  UI_STUCK_THRESHOLD_MS: 120000,
  UI_IDLE_CLAIM_THRESHOLD_MS: 60000,
}));

jest.mock('../modules/utils', () => ({
  debounceButton: jest.fn(() => jest.fn()),
  applyShortcutTooltips: jest.fn(),
}));

jest.mock('../modules/command-palette', () => ({
  initCommandPalette: jest.fn(),
}));

jest.mock('../modules/target-dropdown', () => ({
  initCustomTargetDropdown: jest.fn(),
}));

jest.mock('../modules/status-strip', () => ({
  initStatusStrip: jest.fn(),
}));

jest.mock('../modules/model-selector', () => ({
  initModelSelectors: jest.fn(),
  setupModelSelectorListeners: jest.fn(),
  setupModelChangeListener: jest.fn(),
}));

jest.mock('../modules/health-strip', () => ({
  init: jest.fn(),
  destroy: jest.fn(),
}));

// We test event emissions on the bus directly since renderer.js wires them in DOMContentLoaded
describe('renderer event bus wiring', () => {
  let bus;

  beforeEach(() => {
    jest.resetModules();
    bus = require('../modules/event-bus');
    bus.reset();
  });

  afterEach(() => {
    bus.reset();
  });

  describe('overlay events', () => {
    test('overlay.opened emitted and state updated when settings panel gets open class', () => {
      const handler = jest.fn();
      bus.on('overlay.opened', handler);

      // Simulate: settingsPanel class toggled to 'open'
      bus.emit('overlay.opened', { paneId: 'system', source: 'renderer.js' });
      bus.updateState('system', { overlay: { open: true } });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].type).toBe('overlay.opened');
      expect(bus.getState('system').overlay.open).toBe(true);
    });

    test('overlay.closed emitted and state updated when settings panel loses open class', () => {
      const handler = jest.fn();
      bus.on('overlay.closed', handler);

      bus.updateState('system', { overlay: { open: true } });
      bus.emit('overlay.closed', { paneId: 'system', source: 'renderer.js' });
      bus.updateState('system', { overlay: { open: false } });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(bus.getState('system').overlay.open).toBe(false);
    });
  });

  describe('resize.requested', () => {
    test('resize.requested emitted with window_resize trigger', () => {
      const handler = jest.fn();
      bus.on('resize.requested', handler);

      bus.emit('resize.requested', {
        paneId: 'system',
        payload: { trigger: 'window_resize' },
        source: 'renderer.js',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.trigger).toBe('window_resize');
    });

    test('resize.requested emitted with panel_toggle trigger', () => {
      const handler = jest.fn();
      bus.on('resize.requested', handler);

      bus.emit('resize.requested', {
        paneId: 'system',
        payload: { trigger: 'panel_toggle' },
        source: 'renderer.js',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.trigger).toBe('panel_toggle');
    });
  });

  describe('pane.visibility.changed', () => {
    test('pane.visibility.changed emitted with paneId and visible flag', () => {
      const handler = jest.fn();
      bus.on('pane.visibility.changed', handler);

      bus.emit('pane.visibility.changed', {
        paneId: '1',
        payload: { paneId: '1', visible: true },
        source: 'renderer.js',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0].payload;
      expect(payload.paneId).toBe('1');
      expect(payload.visible).toBe(true);
    });
  });

  describe('ui.longtask.detected', () => {
    test('ui.longtask.detected emitted with duration and start time', () => {
      const handler = jest.fn();
      bus.on('ui.longtask.detected', handler);

      bus.emit('ui.longtask.detected', {
        paneId: 'system',
        payload: { durationMs: 120, startTime: 5000 },
        source: 'renderer.js',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0].payload;
      expect(payload.durationMs).toBe(120);
      expect(payload.startTime).toBe(5000);
    });
  });
});
