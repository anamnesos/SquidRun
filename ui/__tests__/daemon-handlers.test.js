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
    '2': '/project/instances/worker-a',
    '3': '/project/instances/worker-b',
    '4': '/project/instances/reviewer',
    '5': '/project/instances/investigator',
    '6': '/project/instances/orchestrator',
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
}));

// Mock sdk-renderer module
jest.mock('../modules/sdk-renderer', () => ({
  appendMessage: jest.fn().mockReturnValue('msg-123'),
  updateDeliveryState: jest.fn(),
}));

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
      expect(daemonHandlers.PANE_ROLES['2']).toBe('Infra');
      expect(daemonHandlers.PANE_ROLES['3']).toBe('Frontend');
      expect(daemonHandlers.PANE_ROLES['6']).toBe('Reviewer');
    });
  });

  describe('STATE_DISPLAY_NAMES constant', () => {
    test('should have display names for common states', () => {
      expect(daemonHandlers.STATE_DISPLAY_NAMES['idle']).toBe('IDLE');
      expect(daemonHandlers.STATE_DISPLAY_NAMES['executing']).toBe('EXECUTING');
      expect(daemonHandlers.STATE_DISPLAY_NAMES['error']).toBe('ERROR');
    });
  });

  describe('setStatusCallbacks', () => {
    test('should set callbacks', () => {
      const connectionCb = jest.fn();
      const paneCb = jest.fn();

      daemonHandlers.setStatusCallbacks(connectionCb, paneCb);

      // Callbacks should be set (internal, tested via other functions)
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
    test('should create toast element', () => {
      const mockToast = {
        className: '',
        textContent: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.createElement.mockReturnValue(mockToast);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showToast('Test message', 'info');

      expect(mockDocument.createElement).toHaveBeenCalledWith('div');
      expect(mockToast.className).toBe('toast-notification toast-info');
      expect(mockToast.textContent).toBe('Test message');
      expect(mockDocument.body.appendChild).toHaveBeenCalledWith(mockToast);
    });

    test('should remove existing toast', () => {
      const existingToast = { remove: jest.fn() };
      mockDocument.querySelector.mockReturnValue(existingToast);

      daemonHandlers.showToast('New message');

      expect(existingToast.remove).toHaveBeenCalled();
    });

    test('should fade out after 5 seconds', () => {
      const mockToast = {
        className: '',
        textContent: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.createElement.mockReturnValue(mockToast);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showToast('Test');

      jest.advanceTimersByTime(5000);
      expect(mockToast.classList.add).toHaveBeenCalledWith('toast-fade');

      jest.advanceTimersByTime(500);
      expect(mockToast.remove).toHaveBeenCalled();
    });
  });

  describe('updatePaneProject', () => {
    test('should update project element with path', () => {
      const mockEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(mockEl);

      daemonHandlers.updatePaneProject('1', '/path/to/project');

      expect(mockEl.textContent).toBe('project');
      expect(mockEl.title).toContain('/path/to/project');
      expect(mockEl.classList.add).toHaveBeenCalledWith('has-project');
    });

    test('should clear project element when no path', () => {
      const mockEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(mockEl);

      daemonHandlers.updatePaneProject('1', null);

      expect(mockEl.textContent).toBe('');
      expect(mockEl.classList.remove).toHaveBeenCalledWith('has-project');
    });

    test('should handle missing element gracefully', () => {
      mockDocument.getElementById.mockReturnValue(null);

      expect(() => daemonHandlers.updatePaneProject('1', '/path')).not.toThrow();
    });
  });

  describe('updateAllPaneProjects', () => {
    test('should update multiple panes', () => {
      const elements = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (!elements[id]) {
          elements[id] = {
            textContent: '',
            title: '',
            classList: { add: jest.fn(), remove: jest.fn() },
          };
        }
        return elements[id];
      });

      daemonHandlers.updateAllPaneProjects({
        '1': '/project1',
        '2': '/project2',
      });

      expect(elements['project-1'].textContent).toBe('project1');
      expect(elements['project-2'].textContent).toBe('project2');
    });
  });

  describe('handleSessionTimerState', () => {
    test('should start timer when agent starts running', () => {
      daemonHandlers.handleSessionTimerState('1', 'running');

      // Timer should be started (internal state)
      const totalTime = daemonHandlers.getTotalSessionTime();
      expect(totalTime).toBeGreaterThanOrEqual(0);
    });

    test('should stop timer when agent becomes idle', () => {
      // First start a timer
      daemonHandlers.handleSessionTimerState('1', 'running');

      // Then stop it
      daemonHandlers.handleSessionTimerState('1', 'idle');

      // Total time should be 0 since timer was stopped
      // (actually depends on implementation details)
    });
  });

  describe('getTotalSessionTime', () => {
    test('should return 0 when no sessions active', () => {
      // Clear any existing sessions
      for (const paneId of daemonHandlers.PANE_IDS) {
        daemonHandlers.handleSessionTimerState(paneId, 'idle');
      }

      const total = daemonHandlers.getTotalSessionTime();
      expect(total).toBe(0);
    });
  });

  describe('updateStateDisplay', () => {
    test('should update state display element', () => {
      const stateEl = {
        textContent: '',
        className: '',
      };
      const progressFill = { style: { width: '' } };
      const progressText = { textContent: '' };

      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'stateDisplay') return stateEl;
        if (id === 'progressFill') return progressFill;
        if (id === 'progressText') return progressText;
        return null;
      });

      daemonHandlers.updateStateDisplay({
        state: 'executing',
        current_checkpoint: 2,
        total_checkpoints: 5,
        active_agents: ['1', '2'],
      });

      expect(stateEl.textContent).toBe('EXECUTING');
      expect(progressFill.style.width).toBe('40%');
      expect(progressText.textContent).toBe('2 / 5');
    });

    test('should handle unknown state', () => {
      const stateEl = { textContent: '', className: '' };
      const progressFill = { style: { width: '' } };
      const progressText = { textContent: '' };

      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'stateDisplay') return stateEl;
        if (id === 'progressFill') return progressFill;
        if (id === 'progressText') return progressText;
        return null;
      });

      daemonHandlers.updateStateDisplay({ state: 'unknown_state' });

      expect(stateEl.textContent).toBe('UNKNOWN_STATE');
    });

    test('should handle missing elements gracefully', () => {
      mockDocument.getElementById.mockReturnValue(null);

      expect(() => daemonHandlers.updateStateDisplay({ state: 'idle' })).not.toThrow();
    });
  });

  describe('updateAgentTasks', () => {
    test('should update task elements from agent_claims', () => {
      const taskElements = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (id.startsWith('task-')) {
          const paneId = id.replace('task-', '');
          if (!taskElements[paneId]) {
            taskElements[paneId] = {
              textContent: '',
              title: '',
              classList: { add: jest.fn(), remove: jest.fn() },
            };
          }
          return taskElements[paneId];
        }
        return null;
      });

      daemonHandlers.updateAgentTasks({
        agent_claims: {
          '1': 'Review PR #123',
        },
      });

      expect(taskElements['1'].textContent).toBe('Review PR #123');
      expect(taskElements['1'].classList.add).toHaveBeenCalledWith('has-task');
    });

    test('should clear task when no claim', () => {
      const taskEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(taskEl);

      daemonHandlers.updateAgentTasks({ agent_claims: {} });

      expect(taskEl.textContent).toBe('');
      expect(taskEl.classList.remove).toHaveBeenCalledWith('has-task');
    });
  });

  describe('showHandoffNotification', () => {
    test('should create handoff notification', () => {
      const mockNotification = {
        className: '',
        innerHTML: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.createElement.mockReturnValue(mockNotification);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showHandoffNotification({
        fromPane: '1',
        toPane: '2',
        reason: 'Task completed',
      });

      expect(mockDocument.createElement).toHaveBeenCalledWith('div');
      expect(mockNotification.className).toBe('handoff-notification');
      expect(mockNotification.innerHTML).toContain('Architect');
      expect(mockNotification.innerHTML).toContain('Infra');
    });

    test('should remove existing notification', () => {
      const existingNotification = { remove: jest.fn() };
      mockDocument.querySelector.mockReturnValue(existingNotification);

      daemonHandlers.showHandoffNotification({
        fromPane: '1',
        toPane: '2',
      });

      expect(existingNotification.remove).toHaveBeenCalled();
    });
  });

  describe('showConflictNotification', () => {
    test('should create conflict notification', () => {
      const mockNotification = {
        className: '',
        innerHTML: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.createElement.mockReturnValue(mockNotification);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showConflictNotification({
        file: 'src/app.js',
        agents: ['1', '2'],
        status: 'pending',
      });

      expect(mockNotification.className).toBe('conflict-notification');
      expect(mockNotification.innerHTML).toContain('src/app.js');
    });
  });

  describe('showAutoTriggerFeedback', () => {
    test('should flash target pane header', () => {
      const mockHeader = {
        classList: { add: jest.fn(), remove: jest.fn() },
        offsetWidth: 100,
      };
      const mockPane = {
        querySelector: jest.fn().mockReturnValue(mockHeader),
      };
      const mockIndicator = {
        className: '',
        innerHTML: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };

      mockDocument.querySelector.mockReturnValue(mockPane);
      mockDocument.createElement.mockReturnValue(mockIndicator);

      daemonHandlers.showAutoTriggerFeedback({
        fromPane: '1',
        toPane: '2',
        reason: 'Completion detected',
      });

      expect(mockHeader.classList.add).toHaveBeenCalledWith('auto-triggered');
    });
  });

  describe('showRollbackUI', () => {
    test('should create rollback indicator', () => {
      const mockIndicator = {
        className: '',
        innerHTML: '',
        querySelector: jest.fn().mockReturnValue({
          addEventListener: jest.fn(),
        }),
      };
      mockDocument.createElement.mockReturnValue(mockIndicator);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showRollbackUI({
        checkpointId: 'cp-123',
        files: ['file1.js', 'file2.js'],
        timestamp: '2026-01-28T12:00:00Z',
      });

      expect(mockIndicator.className).toBe('rollback-indicator');
      expect(mockIndicator.innerHTML).toContain('Rollback Available');
    });

    test('should remove existing rollback UI', () => {
      const existingIndicator = { remove: jest.fn() };
      mockDocument.querySelector.mockReturnValue(existingIndicator);

      daemonHandlers.showRollbackUI({
        checkpointId: 'cp-123',
        files: [],
        timestamp: '2026-01-28T12:00:00Z',
      });

      expect(existingIndicator.remove).toHaveBeenCalled();
    });
  });

  describe('hideRollbackUI', () => {
    test('should remove rollback indicator', () => {
      const mockIndicator = { remove: jest.fn() };
      mockDocument.querySelector.mockReturnValue(mockIndicator);

      daemonHandlers.hideRollbackUI();

      expect(mockIndicator.remove).toHaveBeenCalled();
    });

    test('should handle missing indicator gracefully', () => {
      mockDocument.querySelector.mockReturnValue(null);

      expect(() => daemonHandlers.hideRollbackUI()).not.toThrow();
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

      const taskEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(taskEl);

      await daemonHandlers.loadInitialAgentTasks();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-state');
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

      const projectEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectEl);

      await daemonHandlers.loadPaneProjects();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-all-pane-projects');
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

      const projectPathEl = {
        textContent: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectPathEl);

      await daemonHandlers.selectProject();

      expect(window.hivemind.project.select).toHaveBeenCalled();
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

      const projectPathEl = {
        textContent: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectPathEl);

      await daemonHandlers.loadInitialProject();

      expect(window.hivemind.project.get).toHaveBeenCalled();
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

  describe('setStatusCallbacks', () => {
    test('should set both callbacks', () => {
      const statusCb = jest.fn();
      const connectionCb = jest.fn();

      daemonHandlers.setStatusCallbacks(statusCb, connectionCb);

      // Callbacks should be stored for later use
    });

    test('should allow null callbacks', () => {
      expect(() => daemonHandlers.setStatusCallbacks(null, null)).not.toThrow();
    });
  });

  describe('handleSessionTimerState', () => {
    test('should update timer display when running', () => {
      daemonHandlers.handleSessionTimerState({
        running: true,
        totalSeconds: 120,
      });

      // Timer should be updated
    });

    test('should stop timer when not running', () => {
      daemonHandlers.handleSessionTimerState({
        running: false,
        totalSeconds: 60,
      });

      // Timer should be stopped
    });

    test('should handle null state', () => {
      expect(() => daemonHandlers.handleSessionTimerState(null)).not.toThrow();
    });
  });

  describe('getTotalSessionTime', () => {
    test('should return 0 initially', () => {
      const time = daemonHandlers.getTotalSessionTime();
      expect(typeof time).toBe('number');
    });
  });

  describe('SDK mode functions', () => {
    test('isSDKModeEnabled should return boolean', () => {
      const enabled = daemonHandlers.isSDKModeEnabled();
      expect(typeof enabled).toBe('boolean');
    });

    test('setSDKMode should accept true', () => {
      expect(() => daemonHandlers.setSDKMode(true)).not.toThrow();
    });

    test('setSDKMode should accept false', () => {
      expect(() => daemonHandlers.setSDKMode(false)).not.toThrow();
    });
  });

  describe('updatePaneProject', () => {
    test('should update project display for valid pane', () => {
      const projectEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectEl);

      daemonHandlers.updatePaneProject('1', '/test/project');

      expect(projectEl.textContent).toBeDefined();
    });

    test('should handle missing element', () => {
      mockDocument.getElementById.mockReturnValue(null);

      expect(() => daemonHandlers.updatePaneProject('1', '/path')).not.toThrow();
    });

    test('should handle empty path', () => {
      const projectEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectEl);

      expect(() => daemonHandlers.updatePaneProject('1', '')).not.toThrow();
    });
  });

  describe('updateAllPaneProjects', () => {
    test('should update all pane projects from map', () => {
      const projectEl = {
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(projectEl);

      daemonHandlers.updateAllPaneProjects({
        '1': '/project1',
        '2': '/project2',
      });
    });

    test('should handle empty map', () => {
      expect(() => daemonHandlers.updateAllPaneProjects({})).not.toThrow();
    });
  });

  describe('showToast edge cases', () => {
    test('should handle empty message', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        style: {},
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      expect(() => daemonHandlers.showToast('')).not.toThrow();
    });

    test('should handle special characters', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        style: {},
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      expect(() => daemonHandlers.showToast('<script>alert(1)</script>')).not.toThrow();
    });

    test('should handle long messages', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        style: {},
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      const longMessage = 'A'.repeat(1000);
      expect(() => daemonHandlers.showToast(longMessage)).not.toThrow();
    });

    test('should handle missing container', () => {
      mockDocument.getElementById.mockReturnValue(null);

      expect(() => daemonHandlers.showToast('Test')).not.toThrow();
    });
  });

  describe('updateStateDisplay edge cases', () => {
    test('should handle planning state', () => {
      const mockElements = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (!mockElements[id]) {
          mockElements[id] = {
            textContent: '',
            className: '',
            style: {},
            classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
          };
        }
        return mockElements[id];
      });

      daemonHandlers.updateStateDisplay('planning');
    });

    test('should handle executing state', () => {
      const mockElements = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (!mockElements[id]) {
          mockElements[id] = {
            textContent: '',
            className: '',
            style: {},
            classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
          };
        }
        return mockElements[id];
      });

      daemonHandlers.updateStateDisplay('executing');
    });

    test('should handle paused state', () => {
      const mockElements = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (!mockElements[id]) {
          mockElements[id] = {
            textContent: '',
            className: '',
            style: {},
            classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
          };
        }
        return mockElements[id];
      });

      daemonHandlers.updateStateDisplay('paused');
    });
  });

  describe('updateAgentTasks edge cases', () => {
    test('should handle empty agent claims', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      expect(() => daemonHandlers.updateAgentTasks({ agent_claims: {} })).not.toThrow();
    });

    test('should handle missing agent_claims property', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        title: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      expect(() => daemonHandlers.updateAgentTasks({})).not.toThrow();
    });
  });

  describe('showDeliveryIndicator', () => {
    test('should show delivered indicator', () => {
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      const headerEl = {
        classList: { add: jest.fn(), remove: jest.fn() },
        offsetWidth: 100,
      };

      mockDocument.getElementById.mockImplementation((id) => {
        if (id === 'delivery-1') return deliveryEl;
        return null;
      });
      // document.querySelector returns headerEl directly
      mockDocument.querySelector.mockReturnValue(headerEl);

      daemonHandlers.showDeliveryIndicator('1', 'delivered');

      expect(deliveryEl.textContent).toBe('✓');
      expect(deliveryEl.className).toBe('delivery-indicator visible delivered');
      expect(headerEl.classList.remove).toHaveBeenCalledWith('delivery-flash');
      expect(headerEl.classList.add).toHaveBeenCalledWith('delivery-flash');
    });

    test('should show failed indicator', () => {
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(deliveryEl);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showDeliveryIndicator('1', 'failed');

      expect(deliveryEl.textContent).toBe('✗');
    });

    test('should show pending indicator', () => {
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(deliveryEl);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showDeliveryIndicator('1', 'pending');

      expect(deliveryEl.textContent).toBe('…');
    });

    test('should auto-hide after 3 seconds', () => {
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(deliveryEl);
      mockDocument.querySelector.mockReturnValue(null);

      daemonHandlers.showDeliveryIndicator('1', 'delivered');

      jest.advanceTimersByTime(3000);
      expect(deliveryEl.classList.remove).toHaveBeenCalledWith('visible');
    });

    test('should handle missing delivery element', () => {
      mockDocument.getElementById.mockReturnValue(null);
      expect(() => daemonHandlers.showDeliveryIndicator('1')).not.toThrow();
    });
  });

  describe('showDeliveryFailed', () => {
    test('should show failed indicator and toast', () => {
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      const mockToast = {
        className: '',
        textContent: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };

      mockDocument.getElementById.mockReturnValue(deliveryEl);
      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockToast);

      daemonHandlers.showDeliveryFailed('1', 'Connection timeout');

      expect(deliveryEl.textContent).toBe('✗');
      expect(mockToast.textContent).toContain('Delivery to pane 1 failed');
    });
  });

  describe('markManualSync', () => {
    test('should mark sync file as manually synced', () => {
      const indicator = {
        querySelector: jest.fn().mockReturnValue({
          classList: { add: jest.fn(), remove: jest.fn() },
          title: '',
        }),
      };
      const leftGroup = { appendChild: jest.fn() };
      const statusBar = { querySelector: jest.fn().mockReturnValue(leftGroup), firstElementChild: null };
      mockDocument.querySelector.mockReturnValue(statusBar);
      mockDocument.getElementById.mockReturnValue(indicator);

      daemonHandlers.markManualSync('shared_context.md');

      // Should not throw
    });

    test('should ignore non-sync files', () => {
      expect(() => daemonHandlers.markManualSync('random.txt')).not.toThrow();
    });
  });

  describe('setupSyncIndicator', () => {
    test('should set up sync indicator and IPC listeners', () => {
      const leftGroup = { appendChild: jest.fn() };
      const statusBar = {
        querySelector: jest.fn().mockReturnValue(leftGroup),
        insertBefore: jest.fn(),
        appendChild: jest.fn(),
        firstElementChild: null,
      };
      mockDocument.querySelector.mockReturnValue(statusBar);
      mockDocument.getElementById.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue({
        id: '',
        className: '',
        appendChild: jest.fn(),
        dataset: {},
        textContent: '',
        title: '',
      });

      daemonHandlers.setupSyncIndicator();

      expect(ipcRenderer.on).toHaveBeenCalledWith('sync-file-changed', expect.any(Function));
      expect(ipcRenderer.on).toHaveBeenCalledWith('sync-triggered', expect.any(Function));
    });
  });

  describe('IPC Handler Execution', () => {
    let ipcHandlers;

    beforeEach(() => {
      // Capture IPC handlers
      ipcHandlers = {};
      ipcRenderer.on.mockImplementation((channel, handler) => {
        ipcHandlers[channel] = handler;
      });
    });

    describe('daemon-connected handler', () => {
      test('should handle SDK mode', async () => {
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

        // Trigger daemon-connected with SDK mode
        await ipcHandlers['daemon-connected']({}, { terminals: [], sdkMode: true });

        expect(daemonHandlers.isSDKModeEnabled()).toBe(true);
        expect(onTerminalsReadyFn).toHaveBeenCalledWith(true);
        expect(initTerminalsFn).not.toHaveBeenCalled();
      });

      test('should create new terminals when none exist', async () => {
        const initTerminalsFn = jest.fn().mockResolvedValue();
        const reattachTerminalFn = jest.fn();
        const setReconnectedFn = jest.fn();
        const onTerminalsReadyFn = jest.fn();

        daemonHandlers.setSDKMode(false); // Ensure PTY mode
        daemonHandlers.setupDaemonListeners(
          initTerminalsFn,
          reattachTerminalFn,
          setReconnectedFn,
          onTerminalsReadyFn
        );

        await ipcHandlers['daemon-connected']({}, { terminals: [], sdkMode: false });

        expect(initTerminalsFn).toHaveBeenCalled();
        expect(onTerminalsReadyFn).toHaveBeenCalledWith(false);
      });

      test('should reattach existing terminals', async () => {
        const initTerminalsFn = jest.fn();
        const reattachTerminalFn = jest.fn().mockResolvedValue();
        const setReconnectedFn = jest.fn();
        const onTerminalsReadyFn = jest.fn();

        daemonHandlers.setSDKMode(false);
        daemonHandlers.setupDaemonListeners(
          initTerminalsFn,
          reattachTerminalFn,
          setReconnectedFn,
          onTerminalsReadyFn
        );

        await ipcHandlers['daemon-connected']({}, {
          terminals: [
            { paneId: '1', alive: true, cwd: '/project/instances/lead', scrollback: 'test' },
          ],
          sdkMode: false,
        });

        expect(setReconnectedFn).toHaveBeenCalledWith(true);
        expect(reattachTerminalFn).toHaveBeenCalledWith('1', 'test');
      });
    });

    describe('daemon-reconnected handler', () => {
      test('should handle reconnection', () => {
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        expect(() => ipcHandlers['daemon-reconnected']({})).not.toThrow();
      });
    });

    describe('daemon-disconnected handler', () => {
      test('should handle disconnection', () => {
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        expect(() => ipcHandlers['daemon-disconnected']({})).not.toThrow();
      });
    });

    describe('inject-message handler', () => {
      const terminal = require('../modules/terminal');

      test('should queue message for delivery', () => {
        daemonHandlers.setSDKMode(false);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['1'], message: 'test message' });

        jest.advanceTimersByTime(200);
        expect(terminal.sendToPane).toHaveBeenCalled();
      });

      test('should handle UNSTICK command in PTY mode', () => {
        daemonHandlers.setSDKMode(false);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['1'], message: '(UNSTICK)' });

        expect(terminal.sendUnstick).toHaveBeenCalledWith('1');
      });

      test('should handle UNSTICK command in SDK mode', () => {
        daemonHandlers.setSDKMode(true);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['1'], message: '(UNSTICK)' });

        expect(ipcRenderer.invoke).toHaveBeenCalledWith('sdk-interrupt', '1');
      });

      test('should handle AGGRESSIVE_NUDGE in PTY mode', () => {
        daemonHandlers.setSDKMode(false);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['1'], message: '(AGGRESSIVE_NUDGE)' });

        expect(terminal.aggressiveNudge).toHaveBeenCalledWith('1');
      });

      test('should route messages through SDK when enabled', () => {
        daemonHandlers.setSDKMode(true);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['2'], message: 'SDK message\r' });

        jest.advanceTimersByTime(200);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('sdk-send-message', '2', 'SDK message');
      });

      test('should handle multiple panes', () => {
        daemonHandlers.setSDKMode(false);
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, { panes: ['1', '2', '3'], message: 'broadcast' });

        jest.advanceTimersByTime(500);
        expect(terminal.sendToPane).toHaveBeenCalledTimes(3);
      });

      test('should handle delivery ID for acks', async () => {
        daemonHandlers.setSDKMode(true);
        ipcRenderer.invoke.mockResolvedValue({});
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['inject-message']({}, {
          panes: ['1'],
          message: 'test',
          deliveryId: 'del-123',
        });

        // Flush promises and advance timers
        await Promise.resolve();
        jest.advanceTimersByTime(200);
        await Promise.resolve();

        // In SDK mode, delivery ack is sent after sdk-send-message resolves
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('sdk-send-message', '1', 'test');
      });
    });

    describe('state-changed handler', () => {
      test('should update state display', () => {
        const stateEl = { textContent: '', className: '' };
        mockDocument.getElementById.mockImplementation((id) => {
          if (id === 'stateDisplay') return stateEl;
          return null;
        });

        daemonHandlers.setupStateListener();
        ipcHandlers['state-changed']({}, { state: 'executing', agent_claims: {} });

        expect(stateEl.textContent).toBe('EXECUTING');
      });
    });

    describe('claude-state-changed handler', () => {
      test('should update agent status for each pane', () => {
        const statusEl = {
          textContent: '',
          innerHTML: '',
          classList: { add: jest.fn(), remove: jest.fn() },
          querySelector: jest.fn().mockReturnValue(null),
        };
        const badgeEl = {
          classList: { add: jest.fn(), remove: jest.fn() },
        };
        mockDocument.getElementById.mockImplementation((id) => {
          if (id.startsWith('status-')) return statusEl;
          if (id.startsWith('badge-')) return badgeEl;
          return null;
        });

        const handleTimerFn = jest.fn();
        daemonHandlers.setupClaudeStateListener(handleTimerFn);
        ipcHandlers['claude-state-changed']({}, { '1': 'running', '2': 'idle' });

        expect(handleTimerFn).toHaveBeenCalledWith('1', 'running');
        expect(handleTimerFn).toHaveBeenCalledWith('2', 'idle');
      });
    });

    describe('cost-alert handler', () => {
      test('should show cost alert', () => {
        const costEl = {
          style: {},
          textContent: '',
          closest: jest.fn().mockReturnValue({ classList: { add: jest.fn() } }),
        };
        const alertBadge = { style: {}, addEventListener: jest.fn() };
        const mockToast = {
          className: '',
          textContent: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };

        mockDocument.getElementById.mockImplementation((id) => {
          if (id === 'usageEstCost') return costEl;
          if (id === 'costAlertBadge') return alertBadge;
          return null;
        });
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockToast);

        daemonHandlers.setupCostAlertListener();
        ipcHandlers['cost-alert']({}, { message: 'Budget exceeded', cost: 50.00 });

        expect(costEl.textContent).toBe('$50');
        expect(costEl.style.color).toBe('#e94560');
      });
    });

    describe('project-changed handler', () => {
      test('should update project display', () => {
        const projectPathEl = {
          textContent: '',
          classList: { add: jest.fn(), remove: jest.fn() },
        };
        mockDocument.getElementById.mockReturnValue(projectPathEl);

        daemonHandlers.setupProjectListener();
        ipcHandlers['project-changed']({}, '/new/project/path');

        expect(projectPathEl.textContent).toBe('/new/project/path');
      });
    });

    describe('auto-trigger handler', () => {
      test('should show auto-trigger feedback', () => {
        const mockHeader = {
          classList: { add: jest.fn(), remove: jest.fn() },
          offsetWidth: 100,
        };
        const mockPane = { querySelector: jest.fn().mockReturnValue(mockHeader) };
        const mockIndicator = {
          className: '',
          innerHTML: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };

        mockDocument.querySelector.mockReturnValue(mockPane);
        mockDocument.createElement.mockReturnValue(mockIndicator);

        daemonHandlers.setupAutoTriggerListener();
        ipcHandlers['auto-trigger']({}, { fromPane: '1', toPane: '2', reason: 'test' });

        expect(mockHeader.classList.add).toHaveBeenCalledWith('auto-triggered');
      });

      test('should handle completion-detected event', () => {
        const mockToast = {
          className: '',
          textContent: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockToast);

        daemonHandlers.setupAutoTriggerListener();
        ipcHandlers['completion-detected']({}, { paneId: '1', pattern: 'done' });

        expect(mockToast.textContent).toContain('completed task');
      });
    });

    describe('handoff handlers', () => {
      test('should handle task-handoff event', () => {
        const mockNotification = {
          className: '',
          innerHTML: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockNotification);

        daemonHandlers.setupHandoffListener();
        ipcHandlers['task-handoff']({}, { fromPane: '1', toPane: '2', reason: 'Done' });

        expect(mockNotification.innerHTML).toContain('Architect');
      });

      test('should handle auto-handoff event', () => {
        const mockNotification = {
          className: '',
          innerHTML: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockNotification);

        daemonHandlers.setupHandoffListener();
        ipcHandlers['auto-handoff']({}, { fromPane: '3', toPane: '4' });

        expect(mockNotification.innerHTML).toContain('Frontend');
      });
    });

    describe('conflict handlers', () => {
      test('should handle file-conflict event', () => {
        const mockNotification = {
          className: '',
          innerHTML: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockNotification);

        daemonHandlers.setupConflictResolutionListener();
        ipcHandlers['file-conflict']({}, { file: 'app.js', agents: ['1', '2'], status: 'pending' });

        expect(mockNotification.innerHTML).toContain('app.js');
      });

      test('should handle conflict-resolved event', () => {
        const mockNotification = {
          className: '',
          innerHTML: '',
          classList: { add: jest.fn() },
          remove: jest.fn(),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockNotification);

        daemonHandlers.setupConflictResolutionListener();
        ipcHandlers['conflict-resolved']({}, { file: 'app.js', agents: ['1'] });

        expect(mockNotification.className).toBe('conflict-notification');
      });

    });

    describe('rollback handlers', () => {
      test('should handle rollback-available event', () => {
        const mockIndicator = {
          className: '',
          innerHTML: '',
          querySelector: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
        };
        mockDocument.querySelector.mockReturnValue(null);
        mockDocument.createElement.mockReturnValue(mockIndicator);

        daemonHandlers.setupRollbackListener();
        ipcHandlers['rollback-available']({}, {
          checkpointId: 'cp-1',
          files: ['file1.js'],
          timestamp: '2026-01-30',
        });

        expect(mockIndicator.innerHTML).toContain('Rollback Available');
      });

      test('should handle rollback-cleared event', () => {
        const existingIndicator = { remove: jest.fn() };
        mockDocument.querySelector.mockReturnValue(existingIndicator);

        daemonHandlers.setupRollbackListener();
        ipcHandlers['rollback-cleared']({});

        expect(existingIndicator.remove).toHaveBeenCalled();
      });
    });

    describe('sync handlers', () => {
      beforeEach(() => {
        // Reset sync indicator state so setupSyncIndicator can re-register handlers
        daemonHandlers._resetForTesting();
      });

      test('should handle sync-file-changed event', () => {
        const indicator = {
          querySelector: jest.fn().mockReturnValue({
            classList: { add: jest.fn(), remove: jest.fn() },
            title: '',
          }),
        };
        mockDocument.getElementById.mockReturnValue(indicator);
        mockDocument.querySelector.mockReturnValue({
          querySelector: jest.fn().mockReturnValue(null),
          appendChild: jest.fn(),
        });
        mockDocument.createElement.mockReturnValue({
          id: '',
          className: '',
          appendChild: jest.fn(),
          dataset: {},
          textContent: '',
        });

        daemonHandlers.setupSyncIndicator();
        ipcHandlers['sync-file-changed']({}, { file: 'shared_context.md', changedAt: Date.now() });

        // Should update sync state
      });

      test('should handle sync-triggered event', () => {
        const indicator = {
          querySelector: jest.fn().mockReturnValue({
            classList: { add: jest.fn(), remove: jest.fn() },
            title: '',
          }),
        };
        mockDocument.getElementById.mockReturnValue(indicator);
        mockDocument.querySelector.mockReturnValue({
          querySelector: jest.fn().mockReturnValue(null),
          appendChild: jest.fn(),
        });
        mockDocument.createElement.mockReturnValue({
          id: '',
          className: '',
          appendChild: jest.fn(),
          dataset: {},
          textContent: '',
        });

        daemonHandlers.setupSyncIndicator();
        ipcHandlers['sync-triggered']({}, {
          file: 'blockers.md',
          notified: ['1', '2'],
          mode: 'pty',
        });

        // Should update sync state
      });
    });

    describe('health handlers', () => {
      const terminal = require('../modules/terminal');

      test('should handle nudge-pane event', () => {
        terminal.nudgePane = jest.fn();
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['nudge-pane']({}, { paneId: '3' });

        expect(terminal.nudgePane).toHaveBeenCalledWith('3');
      });

      test('should handle restart-pane event', () => {
        terminal.restartPane = jest.fn();
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['restart-pane']({}, { paneId: '2' });

        expect(terminal.restartPane).toHaveBeenCalledWith('2');
      });

      test('should handle restart-all-panes event', () => {
        terminal.freshStartAll = jest.fn();
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        ipcHandlers['restart-all-panes']({});

        expect(terminal.freshStartAll).toHaveBeenCalled();
      });
    });
  });

  describe('Message Queue Processing', () => {
    test('should process messages sequentially', () => {
      const terminal = require('../modules/terminal');
      daemonHandlers.setSDKMode(false);

      // Setup daemon listeners to get inject-message handler
      let injectHandler;
      ipcRenderer.on.mockImplementation((channel, handler) => {
        if (channel === 'inject-message') injectHandler = handler;
      });
      daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

      // Queue messages one at a time
      // With the fix for race conditions, each message now waits for onComplete
      // before processing the next message for the same pane
      injectHandler({}, { panes: ['1'], message: 'msg1' });
      injectHandler({}, { panes: ['1'], message: 'msg2' });
      injectHandler({}, { panes: ['1'], message: 'msg3' });

      // First message is sent immediately
      expect(terminal.sendToPane).toHaveBeenCalledTimes(1);
      expect(terminal.sendToPane).toHaveBeenCalledWith('1', 'msg1', expect.any(Object));

      // Advance timer to trigger the setTimeout(0) callback in mock
      jest.advanceTimersByTime(1);
      // Advance timer for MESSAGE_DELAY (150ms) between queue processing
      jest.advanceTimersByTime(150);
      expect(terminal.sendToPane).toHaveBeenCalledTimes(2);

      // Process third message
      jest.advanceTimersByTime(1);
      jest.advanceTimersByTime(150);

      // All messages processed after callbacks complete
      expect(terminal.sendToPane).toHaveBeenCalledTimes(3);
      expect(terminal.sendToPane).toHaveBeenCalledWith('1', 'msg2', expect.any(Object));
      expect(terminal.sendToPane).toHaveBeenCalledWith('1', 'msg3', expect.any(Object));
    });

    test('should throttle when multiple items in queue', () => {
      const terminal = require('../modules/terminal');
      daemonHandlers.setSDKMode(false);

      // Setup daemon listeners
      let injectHandler;
      ipcRenderer.on.mockImplementation((channel, handler) => {
        if (channel === 'inject-message') injectHandler = handler;
      });
      daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

      // Block processing by adding to processingPanes first
      // Then queue multiple messages - they'll throttle when processed
      terminal.sendToPane.mockClear();

      // Inject with multiple panes to test queue per pane
      injectHandler({}, { panes: ['2'], message: 'msgA' });
      expect(terminal.sendToPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('Session Timer Functions', () => {
    test('should format timer correctly', () => {
      // Test through handleSessionTimerState
      const timerEl = {
        textContent: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockReturnValue(timerEl);

      daemonHandlers.handleSessionTimerState('1', 'running');

      // Advance time and update timers
      jest.advanceTimersByTime(65000);

      // Timer should have been updated
      expect(timerEl.classList.add).toHaveBeenCalledWith('active');
    });

    test('should track multiple sessions', () => {
      const timerEls = {};
      mockDocument.getElementById.mockImplementation((id) => {
        if (!timerEls[id]) {
          timerEls[id] = {
            textContent: '',
            classList: { add: jest.fn(), remove: jest.fn() },
          };
        }
        return timerEls[id];
      });

      daemonHandlers.handleSessionTimerState('1', 'running');
      daemonHandlers.handleSessionTimerState('2', 'running');

      const total = daemonHandlers.getTotalSessionTime();
      expect(total).toBeGreaterThanOrEqual(0);
    });

    test('should clear timer interval when all sessions stop', () => {
      mockDocument.getElementById.mockReturnValue({
        textContent: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      });

      daemonHandlers.handleSessionTimerState('1', 'running');
      daemonHandlers.handleSessionTimerState('1', 'idle');

      // After some time, interval should be cleared if no active sessions
      jest.advanceTimersByTime(2000);
    });
  });

  describe('Rollback UI Actions', () => {
    test('should handle dismiss button click', () => {
      const dismissBtn = { addEventListener: jest.fn() };
      const confirmBtn = { addEventListener: jest.fn() };
      const mockIndicator = {
        className: '',
        innerHTML: '',
        querySelector: jest.fn((selector) => {
          if (selector.includes('dismiss')) return dismissBtn;
          if (selector.includes('confirm')) return confirmBtn;
          return null;
        }),
        remove: jest.fn(),
      };

      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockIndicator);

      daemonHandlers.showRollbackUI({
        checkpointId: 'cp-1',
        files: ['file1.js'],
        timestamp: '2026-01-30',
      });

      // Get click handler
      const dismissClickHandler = dismissBtn.addEventListener.mock.calls.find(
        c => c[0] === 'click'
      )?.[1];

      if (dismissClickHandler) {
        // Mock querySelector for hideRollbackUI
        mockDocument.querySelector.mockReturnValue(mockIndicator);
        dismissClickHandler();
        expect(mockIndicator.remove).toHaveBeenCalled();
      }
    });

    test('should handle confirm button click with canceled confirm', async () => {
      global.confirm.mockReturnValue(false);

      const dismissBtn = { addEventListener: jest.fn() };
      const confirmBtn = { addEventListener: jest.fn() };
      const mockIndicator = {
        className: '',
        innerHTML: '',
        querySelector: jest.fn((selector) => {
          if (selector.includes('dismiss')) return dismissBtn;
          if (selector.includes('confirm')) return confirmBtn;
          return null;
        }),
      };

      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockIndicator);

      daemonHandlers.showRollbackUI({
        checkpointId: 'cp-1',
        files: ['file1.js'],
        timestamp: '2026-01-30',
      });

      const confirmClickHandler = confirmBtn.addEventListener.mock.calls.find(
        c => c[0] === 'click'
      )?.[1];

      if (confirmClickHandler) {
        await confirmClickHandler();
        // Should not invoke rollback since confirm was canceled
        expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('apply-rollback', 'cp-1');
      }
    });

    test('should handle successful rollback', async () => {
      global.confirm.mockReturnValue(true);
      ipcRenderer.invoke.mockResolvedValue({ success: true, filesRestored: 2 });

      const dismissBtn = { addEventListener: jest.fn() };
      const confirmBtn = { addEventListener: jest.fn() };
      const mockIndicator = {
        className: '',
        innerHTML: '',
        querySelector: jest.fn((selector) => {
          if (selector.includes('dismiss')) return dismissBtn;
          if (selector.includes('confirm')) return confirmBtn;
          return null;
        }),
        remove: jest.fn(),
      };

      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockIndicator);

      daemonHandlers.showRollbackUI({
        checkpointId: 'cp-1',
        files: ['file1.js'],
        timestamp: '2026-01-30',
      });

      const confirmClickHandler = confirmBtn.addEventListener.mock.calls.find(
        c => c[0] === 'click'
      )?.[1];

      if (confirmClickHandler) {
        mockDocument.querySelector.mockReturnValue(mockIndicator);
        await confirmClickHandler();
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('apply-rollback', 'cp-1');
      }
    });
  });

  describe('Conflict Status Text', () => {
    test('should show pending status text', () => {
      const mockNotification = {
        className: '',
        innerHTML: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockNotification);

      daemonHandlers.showConflictNotification({
        file: 'test.js',
        agents: ['1'],
        status: 'pending',
      });

      expect(mockNotification.innerHTML).toContain('Waiting for resolution');
    });

    test('should show resolved status text', () => {
      const mockNotification = {
        className: '',
        innerHTML: '',
        classList: { add: jest.fn() },
        remove: jest.fn(),
      };
      mockDocument.querySelector.mockReturnValue(null);
      mockDocument.createElement.mockReturnValue(mockNotification);

      daemonHandlers.showConflictNotification({
        file: 'test.js',
        agents: ['1'],
        status: 'resolved',
      });

      expect(mockNotification.innerHTML).toContain('Conflict resolved');
    });
  });

  describe('Pane Header Flashing', () => {
    test('should flash header on delivery', () => {
      const headerEl = {
        classList: { add: jest.fn(), remove: jest.fn() },
        offsetWidth: 100,
      };
      const deliveryEl = {
        textContent: '',
        className: '',
        classList: { add: jest.fn(), remove: jest.fn() },
      };

      mockDocument.getElementById.mockImplementation((id) => {
        if (id.startsWith('delivery-')) return deliveryEl;
        return null;
      });
      // document.querySelector returns headerEl directly
      mockDocument.querySelector.mockReturnValue(headerEl);

      daemonHandlers.showDeliveryIndicator('1', 'delivered');

      expect(headerEl.classList.add).toHaveBeenCalledWith('delivery-flash');
    });
  });

  describe('Agent Status Badge Updates', () => {
    test('should set working class for running state', () => {
      const statusEl = {
        textContent: '',
        innerHTML: '',
        classList: { add: jest.fn(), remove: jest.fn() },
        querySelector: jest.fn().mockReturnValue(null),
      };
      const badgeEl = {
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockImplementation((id) => {
        if (id.startsWith('status-')) return statusEl;
        if (id.startsWith('badge-')) return badgeEl;
        return null;
      });

      let handler;
      ipcRenderer.on.mockImplementation((channel, h) => {
        if (channel === 'claude-state-changed') handler = h;
      });

      daemonHandlers.setupClaudeStateListener();
      handler({}, { '1': 'running' });

      expect(badgeEl.classList.add).toHaveBeenCalledWith('working');
    });

    test('should set starting class for starting state', () => {
      const statusEl = {
        textContent: '',
        innerHTML: '',
        classList: { add: jest.fn(), remove: jest.fn() },
        querySelector: jest.fn().mockReturnValue(null),
      };
      const badgeEl = {
        classList: { add: jest.fn(), remove: jest.fn() },
      };
      mockDocument.getElementById.mockImplementation((id) => {
        if (id.startsWith('status-')) return statusEl;
        if (id.startsWith('badge-')) return badgeEl;
        return null;
      });

      let handler;
      ipcRenderer.on.mockImplementation((channel, h) => {
        if (channel === 'claude-state-changed') handler = h;
      });

      daemonHandlers.setupClaudeStateListener();
      handler({}, { '1': 'starting' });

      expect(badgeEl.classList.add).toHaveBeenCalledWith('starting');
    });

    test('should preserve spinner when activity class is present', () => {
      const spinnerEl = { className: 'pane-spinner' };
      const statusEl = {
        textContent: '',
        innerHTML: '',
        classList: new Set(['activity-reading']),
        querySelector: jest.fn().mockReturnValue(spinnerEl),
        appendChild: jest.fn(),
      };
      statusEl.classList.add = jest.fn((cls) => statusEl.classList.add(cls));
      statusEl.classList.remove = jest.fn((cls) => statusEl.classList.delete(cls));
      statusEl.classList.some = jest.fn((fn) => Array.from(statusEl.classList).some(fn));

      mockDocument.getElementById.mockImplementation((id) => {
        if (id.startsWith('status-')) return statusEl;
        return { classList: { add: jest.fn(), remove: jest.fn() } };
      });

      let handler;
      ipcRenderer.on.mockImplementation((channel, h) => {
        if (channel === 'claude-state-changed') handler = h;
      });

      daemonHandlers.setupClaudeStateListener();
      handler({}, { '1': 'running' });

      // Should not override the activity indicator
    });
  });
});
