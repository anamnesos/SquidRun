/**
 * Tests for daemon-handlers.js module
 * IPC event handling, message queuing, UI notifications
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
jest.mock('../config', () => require('./helpers/real-config').mockDefaultConfig);

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
  spawnAgent: jest.fn().mockResolvedValue(),
  restartPane: jest.fn(),
  freshStartAll: jest.fn(),
  nudgePane: jest.fn(),
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
    '2': 'Builder',
    '5': 'Oracle',
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
    if (typeof daemonHandlers._resetThrottleQueueForTesting === 'function') {
      daemonHandlers._resetThrottleQueueForTesting();
    }

    // Reset mocks
    mockDocument.getElementById.mockReturnValue(null);
    mockDocument.querySelector.mockReturnValue(null);
    mockDocument.querySelectorAll.mockReturnValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('PANE_IDS constant', () => {
    test('should have 3 pane IDs', () => {
      expect(daemonHandlers.PANE_IDS).toHaveLength(3);
    });

    test('should be strings 1,2,5', () => {
      expect(daemonHandlers.PANE_IDS).toEqual(['1', '2', '5']);
    });
  });

  describe('PANE_ROLES constant', () => {
    test('should have roles for all 3 panes', () => {
      expect(Object.keys(daemonHandlers.PANE_ROLES)).toHaveLength(3);
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

    describe('daemon-connected handler', () => {
      beforeEach(() => {
        jest.setSystemTime(new Date('2026-02-04T00:00:00Z'));
      });

      test('spawns only panes without CLI content and missing panes', async () => {
        const initTerminalsFn = jest.fn();
        const reattachTerminalFn = jest.fn().mockResolvedValue();
        const setReconnectedFn = jest.fn();
        const onTerminalsReadyFn = jest.fn();

        daemonHandlers.setupDaemonListeners(
          initTerminalsFn,
          reattachTerminalFn,
          setReconnectedFn,
          onTerminalsReadyFn
        );

        ipcRenderer.invoke.mockResolvedValueOnce({ autoSpawn: true, autonomyConsentGiven: true });
        const now = Date.now();

        const data = {

          terminals: [
            { paneId: '1', alive: true, scrollback: 'Claude Code\n> ', lastActivity: now, cwd: '/project/instances/arch' },
            { paneId: '2', alive: true, scrollback: '', cwd: '/project/instances/builder' },
          ],
        };

        await ipcHandlers['daemon-connected']({}, data);

        expect(setReconnectedFn).toHaveBeenCalledWith(true);
        expect(terminal.spawnAgent).toHaveBeenCalledWith('2');
        expect(terminal.spawnAgent).toHaveBeenCalledWith('5');
        expect(terminal.spawnAgent).not.toHaveBeenCalledWith('1');
      });

      test('treats stale scrollback with shell prompt as needing spawn', async () => {
        const initTerminalsFn = jest.fn();
        const reattachTerminalFn = jest.fn().mockResolvedValue();
        const setReconnectedFn = jest.fn();
        const onTerminalsReadyFn = jest.fn();

        daemonHandlers.setupDaemonListeners(
          initTerminalsFn,
          reattachTerminalFn,
          setReconnectedFn,
          onTerminalsReadyFn
        );

        ipcRenderer.invoke.mockResolvedValueOnce({ autoSpawn: true, autonomyConsentGiven: true });
        const now = Date.now();

        const data = {

          terminals: [
            {
              paneId: '1',
              alive: true,
              scrollback: 'Claude Code\nPS <user-home> >',
              lastActivity: now - 10 * 60 * 1000,
              cwd: '/project/instances/arch'
            },
          ],
        };

        await ipcHandlers['daemon-connected']({}, data);

        expect(terminal.spawnAgent).toHaveBeenCalledWith('1');
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

      test('should update task lifecycle on completion when pane has claim', async () => {
        daemonHandlers.setupAutoTriggerListener();
        ipcRenderer.invoke
          .mockResolvedValueOnce({ '1': { taskId: 'T-99' } }) // get-claims
          .mockResolvedValueOnce({ success: true }) // update-task-status
          .mockResolvedValueOnce({ success: true }); // release-agent

        await ipcHandlers['completion-detected']({}, { paneId: '1', pattern: 'done' });

        expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-claims');
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
          'update-task-status',
          expect.objectContaining({
            taskId: 'T-99',
            status: 'completed',
          })
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('release-agent', '1');
      });
    });

    describe('Throttle Queue UI Side Effects', () => {
      test('should flash pane header via uiView', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        injectHandler({}, { panes: ['1'], message: 'msg' });
        expect(uiView.flashPaneHeader).toHaveBeenCalledWith('1');
      });

      test('should forward traceContext from inject-message to terminal.sendToPane', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        injectHandler({}, {
          panes: ['2'],
          message: 'msg',
          deliveryId: 'delivery-1',
          traceContext: {
            traceId: 'trace-1',
            parentEventId: 'evt-parent-1',
          },
        });

        expect(terminal.sendToPane).toHaveBeenCalledWith(
          '2',
          'msg',
          expect.objectContaining({
            traceContext: expect.objectContaining({
              traceId: 'trace-1',
              correlationId: 'trace-1',
              parentEventId: 'evt-parent-1',
              causationId: 'evt-parent-1',
            }),
          })
        );
      });

      test('enables hm-send fast Enter path when trace context carries hm-send message id', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        injectHandler({}, {
          panes: ['2'],
          message: 'msg',
          deliveryId: 'delivery-hm-1',
          traceContext: {
            messageId: 'hm-abc123',
            traceId: 'hm-abc123',
            parentEventId: 'evt-parent-1',
          },
        });

        expect(terminal.sendToPane).toHaveBeenCalledWith(
          '2',
          'msg',
          expect.objectContaining({
            hmSendFastEnter: true,
          })
        );
      });

      test('should emit accepted.unverified outcome when terminal delivery is unverified (success=true)', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        terminal.sendToPane.mockImplementationOnce((paneId, message, options) => {
          setTimeout(() => options.onComplete({ success: true, verified: false, reason: 'timeout' }), 0);
        });

        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());
        injectHandler({}, { panes: ['5'], message: 'msg', deliveryId: 'delivery-unverified-1' });
        jest.runAllTimers();

        // Unverified but success=true means message was typed + Enter pressed = delivered.
        // We route as accepted.unverified to avoid inflating to delivered.verified ACK semantics.
        expect(uiView.showDeliveryIndicator).toHaveBeenCalledWith('5', 'delivered');
        expect(ipcRenderer.send).toHaveBeenCalledWith(
          'trigger-delivery-outcome',
          {
            deliveryId: 'delivery-unverified-1',
            paneId: '5',
            accepted: true,
            verified: false,
            status: 'accepted.unverified',
            reason: 'timeout',
          }
        );
        expect(ipcRenderer.send).not.toHaveBeenCalledWith('trigger-delivery-ack', { deliveryId: 'delivery-unverified-1', paneId: '5' });
      });

      test('should emit trigger-delivery-ack when terminal delivery is verified', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        terminal.sendToPane.mockImplementationOnce((paneId, message, options) => {
          setTimeout(() => options.onComplete({ success: true, verified: true }), 0);
        });

        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());
        injectHandler({}, { panes: ['5'], message: 'msg', deliveryId: 'delivery-verified-1' });
        jest.runAllTimers();

        expect(uiView.showDeliveryIndicator).toHaveBeenCalledWith('5', 'delivered');
        expect(ipcRenderer.send).toHaveBeenCalledWith('trigger-delivery-ack', {
          deliveryId: 'delivery-verified-1',
          paneId: '5',
        });
      });

      test('should emit accepted.unverified outcome when terminal reports submit_not_accepted', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        terminal.sendToPane.mockImplementationOnce((paneId, message, options) => {
          setTimeout(() => options.onComplete({
            success: true,
            verified: false,
            status: 'accepted.unverified',
            reason: 'submit_not_accepted',
          }), 0);
        });

        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());
        injectHandler({}, { panes: ['5'], message: 'msg', deliveryId: 'delivery-failed-1' });
        jest.runAllTimers();

        expect(uiView.showDeliveryIndicator).toHaveBeenCalledWith('5', 'delivered');
        expect(ipcRenderer.send).toHaveBeenCalledWith('trigger-delivery-outcome', {
          deliveryId: 'delivery-failed-1',
          paneId: '5',
          accepted: true,
          verified: false,
          status: 'accepted.unverified',
          reason: 'submit_not_accepted',
        });
        expect(ipcRenderer.send).not.toHaveBeenCalledWith('trigger-delivery-ack', { deliveryId: 'delivery-failed-1', paneId: '5' });
      });

      test('caps throttle queue depth to prevent unbounded growth', () => {
        let injectHandler;
        ipcRenderer.on.mockImplementation((channel, handler) => {
          if (channel === 'inject-message') injectHandler = handler;
        });
        terminal.sendToPane.mockImplementation(() => {
          // Intentionally no onComplete callback to keep pane throttled/in-flight.
        });

        daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

        for (let i = 0; i < 600; i += 1) {
          injectHandler({}, { panes: ['1'], message: `burst-${i}` });
        }

        expect(daemonHandlers._getThrottleQueueDepthForTesting('1')).toBeLessThanOrEqual(200);
      });
    });
  });
});
