/**
 * Tests for daemon-handlers.js module
 * IPC event handling, message queuing, UI notifications, SDK integration
 */

// Mock dependencies before requiring the module
jest.mock('electron', () => ({
  ipcRenderer: {
    on: jest.fn(),
    invoke: jest.fn().mockResolvedValue({}),
    send: jest.fn(),
  },
}));

// Mock config
jest.mock('../config', () => ({
  INSTANCE_DIRS: {
    '1': '/project/instances/lead',
    '2': '/project/instances/infra',
    '3': '/project/instances/front',
    '4': '/project/instances/worker-b',
    '5': '/project/instances/investigator',
    '6': '/project/instances/reviewer',
  },
  PANE_IDS: ['1', '2', '3', '4', '5', '6'],
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Infra',
    '3': 'Frontend',
    '4': 'Backend',
    '5': 'Analyst',
    '6': 'Reviewer',
  },
}));

// Mock terminal module
jest.mock('../modules/terminal', () => ({
  sendToPane: jest.fn((paneId, message, options) => {
    // Call onComplete callback to simulate async completion
    if (options && options.onComplete) {
      // Use setTimeout(0) to simulate async behavior - works with jest fake timers
      setTimeout(() => options.onComplete({ success: true }), 0);
    }
  }),
  sendUnstick: jest.fn(),
  aggressiveNudge: jest.fn(),
  initTerminal: jest.fn().mockResolvedValue(),
  restartPane: jest.fn(),
  freshStartAll: jest.fn(),
  nudgePane: jest.fn(),
}));

// Mock sdk-renderer module
jest.mock('../modules/sdk-renderer', () => ({
  appendMessage: jest.fn().mockReturnValue('msg-123'),
  updateDeliveryState: jest.fn(),
}));

// Mock notifications module
const mockNotifications = {
  showNotification: jest.fn(),
  showToast: jest.fn(),
  showStatusNotice: jest.fn(),
};
jest.mock('../modules/notifications', () => mockNotifications);

// Mock ui-view module
const mockUiView = {
  init: jest.fn(),
  showDeliveryIndicator: jest.fn(),
  showDeliveryFailed: jest.fn(),
  updatePaneProject: jest.fn(),
  updateStateDisplay: jest.fn(),
  updateAgentTasks: jest.fn(),
  showHandoffNotification: jest.fn(),
  showAutoTriggerFeedback: jest.fn(),
  showRollbackUI: jest.fn(),
  hideRollbackUI: jest.fn(),
  updateAgentStatus: jest.fn(),
  flashPaneHeader: jest.fn(),
  showConflictNotification: jest.fn(),
  showCostAlert: jest.fn(),
  updateProjectDisplay: jest.fn(),
  updateSyncChip: jest.fn(),
  updateAllPaneProjects: jest.fn(), // Missing in previous mock definition
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Infra',
    '3': 'Frontend',
    '4': 'Backend',
    '5': 'Analyst',
    '6': 'Reviewer',
  },
  STATE_DISPLAY_NAMES: {
    'idle': 'IDLE',
    'executing': 'EXECUTING',
    'error': 'ERROR',
  },
  SYNC_FILES: {
    'shared_context.md': { label: 'CTX' },
  },
  _resetForTesting: jest.fn(),
};

jest.mock('../modules/ui-view', () => mockUiView);

// Mock window.hivemind
global.window = {
  hivemind: {
    project: {
      select: jest.fn().mockResolvedValue({ success: true, path: '/test/project' }),
      get: jest.fn().mockResolvedValue('/test/project'),
    },
  },
};

// Mock document
const mockDocument = {
  getElementById: jest.fn(),
  querySelector: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([]),
  createElement: jest.fn().mockReturnValue({
    className: '',
    innerHTML: '',
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
    },
    querySelector: jest.fn(),
    remove: jest.fn(),
  }),
  body: {
    appendChild: jest.fn(),
  },
  head: {
    appendChild: jest.fn(),
  },
};

global.document = mockDocument;
global.confirm = jest.fn().mockReturnValue(true);

const { ipcRenderer } = require('electron');
const daemonHandlers = require('../modules/daemon-handlers');
const uiView = require('../modules/ui-view');
const notifications = require('../modules/notifications');
const terminal = require('../modules/terminal');

describe('daemon-handlers.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset mocks
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('PANE_IDS constant', () => {
    test('should have 6 pane IDs', () => {
      expect(daemonHandlers.PANE_IDS).toHaveLength(6);
    });

    test('should be strings 1-6', () => {
      expect(daemonHandlers.PANE_IDS).toEqual(['1', '2', '3', '4', '5', '6']);
    });
  });

  describe('PANE_ROLES constant', () => {
    test('should have roles for all 6 panes', () => {
      expect(Object.keys(daemonHandlers.PANE_ROLES)).toHaveLength(6);
    });

    test('should have correct role names', () => {
      expect(daemonHandlers.PANE_ROLES['1']).toBe('Architect');
    });
  });

  describe('setStatusCallbacks', () => {
    test('should set callbacks', () => {
      const connectionCb = jest.fn();
      const paneCb = jest.fn();
      daemonHandlers.setStatusCallbacks(connectionCb, paneCb);
      // Callbacks should be set (internal)
    });
  });

  describe('setSDKMode / isSDKModeEnabled', () => {
    test('should enable SDK mode', () => {
      daemonHandlers.setSDKMode(true);
      expect(daemonHandlers.isSDKModeEnabled()).toBe(true);
    });

    test('should disable SDK mode', () => {
      daemonHandlers.setSDKMode(false);
      expect(daemonHandlers.isSDKModeEnabled()).toBe(false);
    });
  });

  describe('showToast', () => {
    test('should delegate to notifications.showToast', () => {
      daemonHandlers.showToast('Test message', 'info');
      expect(notifications.showToast).toHaveBeenCalledWith('Test message', 'info');
    });
  });

  describe('updatePaneProject', () => {
    test('should delegate to uiView.updatePaneProject', () => {
      daemonHandlers.updatePaneProject('1', '/path/to/project');
      expect(uiView.updatePaneProject).toHaveBeenCalledWith('1', '/path/to/project');
    });
  });

  describe('updateAllPaneProjects', () => {
    test('should update multiple panes', () => {
      daemonHandlers.updateAllPaneProjects({
        '1': '/project1',
        '2': '/project2',
      });
      // daemonHandlers iterates and calls uiView.updatePaneProject directly
      expect(uiView.updatePaneProject).toHaveBeenCalledWith('1', '/project1');
      expect(uiView.updatePaneProject).toHaveBeenCalledWith('2', '/project2');
    });
  });

  describe('updateStateDisplay', () => {
    test('should delegate to uiView.updateStateDisplay', () => {
      const state = {
        state: 'executing',
        current_checkpoint: 2,
        total_checkpoints: 5,
        active_agents: ['1', '2'],
      };
      daemonHandlers.updateStateDisplay(state);
      expect(uiView.updateStateDisplay).toHaveBeenCalledWith(state);
    });
  });

  describe('updateAgentTasks', () => {
    test('should delegate to uiView.updateAgentTasks', () => {
      const claims = { '1': 'Review PR #123' };
      daemonHandlers.updateAgentTasks(claims);
      expect(uiView.updateAgentTasks).toHaveBeenCalledWith(claims);
    });
  });

  describe('showHandoffNotification', () => {
    test('should delegate to uiView.showHandoffNotification', () => {
      const data = { fromPane: '1', toPane: '2', reason: 'Task completed' };
      daemonHandlers.showHandoffNotification(data);
      expect(uiView.showHandoffNotification).toHaveBeenCalledWith(data);
    });
  });

  describe('showConflictNotification', () => {
    test('should delegate to uiView.showConflictNotification', () => {
      const data = { file: 'src/app.js', agents: ['1', '2'], status: 'pending' };
      daemonHandlers.showConflictNotification(data);
      expect(uiView.showConflictNotification).toHaveBeenCalledWith(data);
    });
  });

  describe('showAutoTriggerFeedback', () => {
    test('should delegate to uiView.showAutoTriggerFeedback', () => {
      const data = { fromPane: '1', toPane: '2', reason: 'Completion detected' };
      daemonHandlers.showAutoTriggerFeedback(data);
      expect(uiView.showAutoTriggerFeedback).toHaveBeenCalledWith(data);
    });
  });

  describe('showRollbackUI', () => {
    test('should delegate to uiView.showRollbackUI', () => {
      const data = { checkpointId: 'cp-123', files: ['file1.js'], timestamp: '2026-01-28' };
      const confirmFn = jest.fn();
      const dismissFn = jest.fn();
      daemonHandlers.showRollbackUI(data, confirmFn, dismissFn);
      expect(uiView.showRollbackUI).toHaveBeenCalledWith(data, confirmFn, dismissFn);
    });
  });

  describe('hideRollbackUI', () => {
    test('should delegate to uiView.hideRollbackUI', () => {
      daemonHandlers.hideRollbackUI();
      expect(uiView.hideRollbackUI).toHaveBeenCalled();
    });
  });

  describe('setupDaemonListeners', () => {
    test('should register IPC listeners', () => {
      const initTerminalsFn = jest.fn();
      const reattachTerminalFn = jest.fn();
      const setReconnectedFn = jest.fn();
      const onTerminalsReadyFn = jest.fn();

      daemonHandlers.setupDaemonListeners(
        initTerminalsFn,
        reattachTerminalFn,
        setReconnectedFn,
        onTerminalsReadyFn
      );

      expect(ipcRenderer.on).toHaveBeenCalledWith('daemon-connected', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('daemon-reconnected', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('daemon-disconnected', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('inject-message', expect.any(Function));
    });
  });

  describe('setupStateListener', () => {
    test('should register state-changed listener', () => {
      daemonHandlers.setupStateListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('state-changed', expect.any(Function));
    });
  });

  describe('setupClaudeStateListener', () => {
    test('should register claude-state-changed listener', () => {
      const handleTimerFn = jest.fn();
      daemonHandlers.setupClaudeStateListener(handleTimerFn);
      expect(ipcRenderer.on).toHaveBeenCalledWith('claude-state-changed', expect.any(Function));
    });
  });

  describe('setupCostAlertListener', () => {
    test('should register cost-alert listener', () => {
      daemonHandlers.setupCostAlertListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('cost-alert', expect.any(Function));
    });
  });

  describe('setupProjectListener', () => {
    test('should register project-changed listener', () => {
      daemonHandlers.setupProjectListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('project-changed', expect.any(Function));
    });
  });

  describe('setupAutoTriggerListener', () => {
    test('should register auto-trigger listener', () => {
      daemonHandlers.setupAutoTriggerListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('auto-trigger', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('completion-detected', expect.any(Function));
    });
  });

  describe('setupHandoffListener', () => {
    test('should register handoff listeners', () => {
      daemonHandlers.setupHandoffListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('task-handoff', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('auto-handoff', expect.any(Function));
    });
  });

  describe('setupConflictResolutionListener', () => {
    test('should register conflict listeners', () => {
      daemonHandlers.setupConflictResolutionListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('file-conflict', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('conflict-resolved', expect.any(Function));
    });
  });

  describe('setupRollbackListener', () => {
    test('should register rollback listeners', () => {
      daemonHandlers.setupRollbackListener();
      expect(ipcRenderer.on).toHaveBeenCalledWith('rollback-available', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('rollback-cleared', expect.any(Function));
    });
  });

  describe('loadInitialAgentTasks', () => {
    test('should load state and update tasks', async () => {
      ipcRenderer.invoke.mockResolvedValueOnce({
        agent_claims: { '1': 'Test task' },
      });

      await daemonHandlers.loadInitialAgentTasks();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-state');
      expect(uiView.updateAgentTasks).toHaveBeenCalledWith({ '1': 'Test task' });
    });

    test('should handle errors gracefully', async () => {
      ipcRenderer.invoke.mockRejectedValueOnce(new Error('Failed'));
      await expect(daemonHandlers.loadInitialAgentTasks()).resolves.not.toThrow();
    });
  });

  describe('loadPaneProjects', () => {
    test('should load and update pane projects', async () => {
      ipcRenderer.invoke.mockResolvedValueOnce({
        success: true,
        paneProjects: { '1': '/project1' },
      });

      await daemonHandlers.loadPaneProjects();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-all-pane-projects');
      expect(uiView.updatePaneProject).toHaveBeenCalledWith('1', '/project1');
    });

    test('should handle errors gracefully', async () => {
      ipcRenderer.invoke.mockRejectedValueOnce(new Error('Failed'));
      await expect(daemonHandlers.loadPaneProjects()).resolves.not.toThrow();
    });
  });

  describe('selectProject', () => {
    test('should call project select and update display', async () => {
      window.hivemind.project.select.mockResolvedValueOnce({
        success: true,
        path: '/new/project',
      });

      await daemonHandlers.selectProject();

      expect(window.hivemind.project.select).toHaveBeenCalled();
      expect(uiView.updateProjectDisplay).toHaveBeenCalledWith('/new/project');
    });

    test('should handle canceled selection', async () => {
      window.hivemind.project.select.mockResolvedValueOnce({ canceled: true });
      await daemonHandlers.selectProject();
      // Should not throw
    });

    test('should handle errors', async () => {
      window.hivemind.project.select.mockRejectedValueOnce(new Error('Selection failed'));
      await expect(daemonHandlers.selectProject()).resolves.not.toThrow();
    });
  });

  describe('loadInitialProject', () => {
    test('should load and display project', async () => {
      window.hivemind.project.get.mockResolvedValueOnce('/initial/project');
      await daemonHandlers.loadInitialProject();
      expect(window.hivemind.project.get).toHaveBeenCalled();
      expect(uiView.updateProjectDisplay).toHaveBeenCalledWith('/initial/project');
    });

    test('should handle errors gracefully', async () => {
      window.hivemind.project.get.mockRejectedValueOnce(new Error('Failed'));
      await expect(daemonHandlers.loadInitialProject()).resolves.not.toThrow();
    });
  });

  describe('setupRefreshButtons', () => {
    test('should add click listeners to refresh buttons', () => {
      const mockBtn = {
        addEventListener: jest.fn(),
        dataset: { paneId: '1' },
      };
      mockDocument.querySelectorAll.mockReturnValue([mockBtn]);

      daemonHandlers.setupRefreshButtons(jest.fn());

      expect(mockBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });

  describe('setupPaneProjectClicks', () => {
    test('should add click listeners to project elements', () => {
      const mockEl = { addEventListener: jest.fn() };
      mockDocument.getElementById.mockReturnValue(mockEl);

      daemonHandlers.setupPaneProjectClicks();

      expect(mockEl.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });

  describe('handleSessionTimerState', () => {
    test('should start timer when running', () => {
      daemonHandlers.handleSessionTimerState('1', 'running');
      const totalTime = daemonHandlers.getTotalSessionTime();
      expect(totalTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('showDeliveryIndicator', () => {
    test('should delegate to uiView.showDeliveryIndicator', () => {
      daemonHandlers.showDeliveryIndicator('1', 'delivered');
      expect(uiView.showDeliveryIndicator).toHaveBeenCalledWith('1', 'delivered');
    });
  });

  describe('showDeliveryFailed', () => {
    test('should delegate to uiView.showDeliveryFailed', () => {
      daemonHandlers.showDeliveryFailed('1', 'Connection timeout');
      expect(uiView.showDeliveryFailed).toHaveBeenCalledWith('1', 'Connection timeout');
    });
  });

  describe('markManualSync', () => {
    test('should mark sync file and update chip', () => {
      daemonHandlers.markManualSync('shared_context.md');
      expect(uiView.updateSyncChip).toHaveBeenCalledWith('shared_context.md', expect.any(Object));
    });
  });

  describe('setupSyncIndicator', () => {
    test('should initialize UI and register listeners', () => {
      daemonHandlers.setupSyncIndicator();
      expect(uiView.init).toHaveBeenCalled();
      expect(ipcRenderer.on).toHaveBeenCalledWith('sync-file-changed', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('sync-triggered', expect.any(Function));
    });
  });

  describe('IPC Handler Execution', () => {
    let ipcHandlers;

    beforeEach(() => {
      ipcHandlers = {};
      ipcRenderer.on.mockImplementation((channel, handler) => {
        ipcHandlers[channel] = handler;
      });
    });

    describe('state-changed handler', () => {
      test('should update state display via uiView', () => {
        daemonHandlers.setupStateListener();
        ipcHandlers['state-changed']({}, { state: 'executing' });
        expect(uiView.updateStateDisplay).toHaveBeenCalledWith({ state: 'executing' });
      });
    });

    describe('claude-state-changed handler', () => {
      test('should update agent status via uiView', () => {
        daemonHandlers.setupClaudeStateListener();
        ipcHandlers['claude-state-changed']({}, { '1': 'running' });
        expect(uiView.updateAgentStatus).toHaveBeenCalledWith('1', 'running');
      });
    });

    describe('cost-alert handler', () => {
      test('should show cost alert via uiView', () => {
        daemonHandlers.setupCostAlertListener();
        const data = { message: 'Budget exceeded', cost: 50.00 };
        ipcHandlers['cost-alert']({}, data);
        expect(uiView.showCostAlert).toHaveBeenCalledWith(data);
        expect(notifications.showToast).toHaveBeenCalledWith(data.message, 'warning');
      });
    });

    describe('project-changed handler', () => {
      test('should update project display via uiView', () => {
        daemonHandlers.setupProjectListener();
        ipcHandlers['project-changed']({}, '/new/project/path');
        expect(uiView.updateProjectDisplay).toHaveBeenCalledWith('/new/project/path');
      });
    });

    describe('auto-trigger handler', () => {
      test('should show feedback via uiView', () => {
        daemonHandlers.setupAutoTriggerListener();
        const data = { fromPane: '1', toPane: '2', reason: 'test' };
        ipcHandlers['auto-trigger']({}, data);
        expect(uiView.showAutoTriggerFeedback).toHaveBeenCalledWith(data);
      });

      test('should show toast on completion', () => {
        daemonHandlers.setupAutoTriggerListener();
        ipcHandlers['completion-detected']({}, { paneId: '1', pattern: 'done' });
        expect(notifications.showToast).toHaveBeenCalled();
      });
    });

    describe('Throttle Queue UI Side Effects', () => {
      test('should flash pane header via uiView', () => {
        daemonHandlers.setSDKMode(false);
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        injectHandler({}, { panes: ['1'], message: 'msg' });
        expect(uiView.flashPaneHeader).toHaveBeenCalledWith('1');
      });
    });
  });
});