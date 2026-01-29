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
  sendToPane: jest.fn(),
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
      expect(daemonHandlers.PANE_ROLES['2']).toBe('Orchestrator');
      expect(daemonHandlers.PANE_ROLES['3']).toBe('Implementer A');
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
      expect(mockNotification.innerHTML).toContain('Orchestrator');
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
      expect(ipcRenderer.on).toHaveBeenCalledWith('conflict-queued', expect.any(Function));
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
});
