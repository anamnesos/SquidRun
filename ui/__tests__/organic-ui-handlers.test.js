/**
 * Tests for organic-ui-handlers.js module
 * Agent state management and message routing for Organic UI
 */

// Mock dependencies before requiring the module
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../config', () => ({
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Infra',
    '3': 'Frontend',
    '4': 'Backend',
    '5': 'Analyst',
    '6': 'Reviewer',
  },
}));

// Import module under test
const organicUI = require('../modules/ipc/organic-ui-handlers');

describe('organic-ui-handlers', () => {
  let mockMainWindow;
  let mockIpcMain;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset agent states to offline before each test
    for (let i = 1; i <= 6; i++) {
      organicUI.setAgentState(String(i), 'offline');
    }

    // Mock mainWindow
    mockMainWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {
        send: jest.fn(),
      },
    };

    // Mock ipcMain
    mockIpcMain = {
      handle: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('SHORT_ROLES constant', () => {
    it('should have correct role mappings', () => {
      expect(organicUI.SHORT_ROLES).toEqual({
        '1': 'arch',
        '2': 'infra',
        '3': 'front',
        '4': 'back',
        '5': 'ana',
        '6': 'rev',
      });
    });
  });

  describe('setAgentState', () => {
    it('should update agent state', () => {
      organicUI.setAgentState('1', 'thinking');
      expect(organicUI.getAgentState('1')).toBe('thinking');
    });

    it('should not emit if state unchanged', () => {
      // First set up the handlers with mock window
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

      // Set initial state
      organicUI.setAgentState('1', 'idle');
      mockMainWindow.webContents.send.mockClear();

      // Set same state again
      organicUI.setAgentState('1', 'idle');

      // Should not have emitted for the duplicate state
      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should emit state change event when state changes', () => {
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

      organicUI.setAgentState('3', 'offline');
      mockMainWindow.webContents.send.mockClear();

      organicUI.setAgentState('3', 'thinking');

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'agent-state-changed',
        expect.objectContaining({
          agentId: '3',
          role: 'front',
          state: 'thinking',
          previousState: 'offline',
        })
      );
    });
  });

  describe('getAgentState', () => {
    it('should return current state', () => {
      organicUI.setAgentState('2', 'active');
      expect(organicUI.getAgentState('2')).toBe('active');
    });

    it('should return offline for unknown agent', () => {
      expect(organicUI.getAgentState('99')).toBe('offline');
    });
  });

  describe('getAllAgentStates', () => {
    it('should return all agent states with roles', () => {
      organicUI.setAgentState('1', 'idle');
      organicUI.setAgentState('2', 'thinking');
      organicUI.setAgentState('3', 'active');

      const states = organicUI.getAllAgentStates();

      expect(states['1']).toEqual({
        state: 'idle',
        role: 'arch',
        fullRole: 'Architect',
      });
      expect(states['2']).toEqual({
        state: 'thinking',
        role: 'infra',
        fullRole: 'Infra',
      });
      expect(states['3']).toEqual({
        state: 'active',
        role: 'front',
        fullRole: 'Frontend',
      });
    });
  });

  describe('Agent lifecycle functions', () => {
    describe('agentOnline', () => {
      it('should set agent to idle', () => {
        organicUI.agentOnline('1');
        expect(organicUI.getAgentState('1')).toBe('idle');
      });

      it('should emit agent-online event when transitioning from offline', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });
        organicUI.setAgentState('4', 'offline');
        mockMainWindow.webContents.send.mockClear();

        organicUI.agentOnline('4');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'agent-online',
          expect.objectContaining({
            agentId: '4',
            role: 'back',
            fullRole: 'Backend',
          })
        );
      });
    });

    describe('agentOffline', () => {
      it('should set agent to offline', () => {
        organicUI.agentOnline('5');
        organicUI.agentOffline('5');
        expect(organicUI.getAgentState('5')).toBe('offline');
      });

      it('should emit agent-offline event when transitioning from online', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });
        organicUI.setAgentState('5', 'idle');
        mockMainWindow.webContents.send.mockClear();

        organicUI.agentOffline('5');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'agent-offline',
          expect.objectContaining({
            agentId: '5',
            role: 'ana',
            fullRole: 'Analyst',
          })
        );
      });
    });

    describe('agentThinking', () => {
      it('should set agent to thinking', () => {
        organicUI.agentThinking('6');
        expect(organicUI.getAgentState('6')).toBe('thinking');
      });

      it('should auto-online offline agent first', () => {
        organicUI.setAgentState('6', 'offline');
        organicUI.agentThinking('6');
        // Should not remain offline, should be thinking
        expect(organicUI.getAgentState('6')).toBe('thinking');
      });
    });

    describe('agentActive', () => {
      it('should set agent to active', () => {
        organicUI.agentActive('1');
        expect(organicUI.getAgentState('1')).toBe('active');
      });

      it('should auto-transition to idle after timeout', () => {
        organicUI.agentActive('2');
        expect(organicUI.getAgentState('2')).toBe('active');

        // Fast-forward 2000ms (IDLE_TIMEOUT_MS)
        jest.advanceTimersByTime(2000);

        expect(organicUI.getAgentState('2')).toBe('idle');
      });

      it('should reset idle timer on subsequent active calls', () => {
        organicUI.agentActive('3');
        jest.advanceTimersByTime(1500);

        // Still active, haven't hit timeout
        expect(organicUI.getAgentState('3')).toBe('active');

        // Another activity - should reset timer
        organicUI.agentActive('3');
        jest.advanceTimersByTime(1500);

        // Still active because timer was reset
        expect(organicUI.getAgentState('3')).toBe('active');

        // Now hit full timeout
        jest.advanceTimersByTime(500);
        expect(organicUI.getAgentState('3')).toBe('idle');
      });

      it('should auto-online offline agent first', () => {
        organicUI.setAgentState('4', 'offline');
        organicUI.agentActive('4');
        expect(organicUI.getAgentState('4')).toBe('active');
      });
    });

    describe('agentReceiving', () => {
      it('should set agent to receiving', () => {
        organicUI.agentReceiving('5');
        expect(organicUI.getAgentState('5')).toBe('receiving');
      });

      it('should auto-transition to thinking after 500ms', () => {
        organicUI.agentReceiving('6');
        expect(organicUI.getAgentState('6')).toBe('receiving');

        jest.advanceTimersByTime(500);

        expect(organicUI.getAgentState('6')).toBe('thinking');
      });

      it('should auto-online offline agent first', () => {
        organicUI.setAgentState('1', 'offline');
        organicUI.agentReceiving('1');
        expect(organicUI.getAgentState('1')).toBe('receiving');
      });
    });

    describe('agentIdle', () => {
      it('should set agent to idle', () => {
        organicUI.agentThinking('2');
        organicUI.agentIdle('2');
        expect(organicUI.getAgentState('2')).toBe('idle');
      });

      it('should auto-online offline agent first', () => {
        organicUI.setAgentState('3', 'offline');
        organicUI.agentIdle('3');
        expect(organicUI.getAgentState('3')).toBe('idle');
      });
    });
  });

  describe('Message routing functions', () => {
    beforeEach(() => {
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });
    });

    describe('messageQueued', () => {
      it('should emit message-routing event with queued phase', () => {
        mockMainWindow.webContents.send.mockClear();

        organicUI.messageQueued('msg-1', '1', '2');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'message-routing',
          expect.objectContaining({
            messageId: 'msg-1',
            from: '1',
            fromRole: 'arch',
            to: '2',
            toRole: 'infra',
            phase: 'queued',
          })
        );
      });
    });

    describe('messageSending', () => {
      it('should emit message-routing event with sending phase', () => {
        organicUI.messageQueued('msg-2', '3', '4');
        mockMainWindow.webContents.send.mockClear();

        organicUI.messageSending('msg-2');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'message-routing',
          expect.objectContaining({
            messageId: 'msg-2',
            from: '3',
            fromRole: 'front',
            to: '4',
            toRole: 'back',
            phase: 'sending',
          })
        );
      });

      it('should mark target agent as receiving', () => {
        organicUI.messageQueued('msg-3', '5', '6');
        organicUI.messageSending('msg-3');

        expect(organicUI.getAgentState('6')).toBe('receiving');
      });

      it('should do nothing for unknown message', () => {
        mockMainWindow.webContents.send.mockClear();
        organicUI.messageSending('unknown-msg');
        expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
      });
    });

    describe('messageDelivered', () => {
      it('should emit message-routing event with delivered phase', () => {
        organicUI.messageQueued('msg-4', '1', '6');
        organicUI.messageSending('msg-4');
        mockMainWindow.webContents.send.mockClear();

        organicUI.messageDelivered('msg-4');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'message-routing',
          expect.objectContaining({
            messageId: 'msg-4',
            from: '1',
            fromRole: 'arch',
            to: '6',
            toRole: 'rev',
            phase: 'delivered',
            duration: expect.any(Number),
          })
        );
      });

      it('should cleanup route after 2000ms', () => {
        organicUI.messageQueued('msg-5', '2', '3');
        organicUI.messageDelivered('msg-5');

        // Route still exists immediately
        // (we can't directly check activeRoutes, but we can verify no error on second delivery)

        jest.advanceTimersByTime(2000);

        // After cleanup, calling messageDelivered again should do nothing
        mockMainWindow.webContents.send.mockClear();
        organicUI.messageDelivered('msg-5');
        expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
      });
    });

    describe('messageFailed', () => {
      it('should emit message-routing event with failed phase and error', () => {
        organicUI.messageQueued('msg-6', '4', '5');
        mockMainWindow.webContents.send.mockClear();

        organicUI.messageFailed('msg-6', 'Timeout exceeded');

        expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
          'message-routing',
          expect.objectContaining({
            messageId: 'msg-6',
            from: '4',
            fromRole: 'back',
            to: '5',
            toRole: 'ana',
            phase: 'failed',
            error: 'Timeout exceeded',
          })
        );
      });

      it('should cleanup route after 2000ms', () => {
        organicUI.messageQueued('msg-7', '1', '2');
        organicUI.messageFailed('msg-7', 'Test error');

        jest.advanceTimersByTime(2000);

        mockMainWindow.webContents.send.mockClear();
        organicUI.messageFailed('msg-7', 'Another error');
        expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
      });
    });
  });

  describe('registerOrganicUIHandlers', () => {
    it('should throw if ctx.ipcMain is missing', () => {
      expect(() => organicUI.registerOrganicUIHandlers({})).toThrow(
        'registerOrganicUIHandlers requires ctx.ipcMain'
      );
    });

    it('should register IPC handlers', () => {
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('organic:get-agent-states', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('organic:get-agent-state', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('organic:set-agent-state', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('organic:get-active-routes', expect.any(Function));
    });

    describe('IPC handler: organic:get-agent-states', () => {
      it('should return all states', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

        // Get the handler function
        const handler = mockIpcMain.handle.mock.calls.find(
          call => call[0] === 'organic:get-agent-states'
        )[1];

        organicUI.setAgentState('1', 'thinking');
        const result = handler();

        expect(result.success).toBe(true);
        expect(result.states['1'].state).toBe('thinking');
      });
    });

    describe('IPC handler: organic:get-agent-state', () => {
      it('should return single agent state', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

        const handler = mockIpcMain.handle.mock.calls.find(
          call => call[0] === 'organic:get-agent-state'
        )[1];

        organicUI.setAgentState('3', 'active');
        const result = handler(null, '3');

        expect(result.success).toBe(true);
        expect(result.agentId).toBe('3');
        expect(result.state).toBe('active');
        expect(result.role).toBe('front');
      });
    });

    describe('IPC handler: organic:set-agent-state', () => {
      it('should set agent state', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

        const handler = mockIpcMain.handle.mock.calls.find(
          call => call[0] === 'organic:set-agent-state'
        )[1];

        handler(null, '5', 'thinking');

        expect(organicUI.getAgentState('5')).toBe('thinking');
      });
    });

    describe('IPC handler: organic:get-active-routes', () => {
      it('should return active routes', () => {
        organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

        const handler = mockIpcMain.handle.mock.calls.find(
          call => call[0] === 'organic:get-active-routes'
        )[1];

        // Create routes with unique IDs for this test
        organicUI.messageQueued('unique-route-1', '1', '2');
        organicUI.messageQueued('unique-route-2', '3', '4');

        const result = handler();

        expect(result.success).toBe(true);
        // Check that our routes exist (other tests may have added routes too)
        expect(result.routes.length).toBeGreaterThanOrEqual(2);
        expect(result.routes).toContainEqual(
          expect.objectContaining({
            messageId: 'unique-route-1',
            from: '1',
            to: '2',
            phase: 'queued',
          })
        );
        expect(result.routes).toContainEqual(
          expect.objectContaining({
            messageId: 'unique-route-2',
            from: '3',
            to: '4',
            phase: 'queued',
          })
        );
      });
    });
  });

  describe('Edge cases', () => {
    it('should not emit when mainWindow is destroyed', () => {
      mockMainWindow.isDestroyed.mockReturnValue(true);
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });
      mockMainWindow.webContents.send.mockClear();

      organicUI.setAgentState('1', 'idle');
      organicUI.setAgentState('1', 'thinking');

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should handle rapid state changes', () => {
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

      // Rapid state changes
      organicUI.agentOnline('1');
      organicUI.agentThinking('1');
      organicUI.agentActive('1');
      organicUI.agentReceiving('1');
      organicUI.agentIdle('1');
      organicUI.agentOffline('1');

      expect(organicUI.getAgentState('1')).toBe('offline');
    });

    it('should handle concurrent messages for same agent pair', () => {
      organicUI.registerOrganicUIHandlers({ ipcMain: mockIpcMain, mainWindow: mockMainWindow });

      organicUI.messageQueued('concurrent-1', '1', '2');
      organicUI.messageQueued('concurrent-2', '1', '2');

      organicUI.messageSending('concurrent-1');
      organicUI.messageSending('concurrent-2');

      organicUI.messageDelivered('concurrent-1');
      organicUI.messageFailed('concurrent-2', 'Test');

      // Both should have emitted their respective events
      const routingCalls = mockMainWindow.webContents.send.mock.calls.filter(
        call => call[0] === 'message-routing'
      );

      // 2 queued + 2 sending + 1 delivered + 1 failed = 6 calls
      expect(routingCalls.length).toBe(6);
    });
  });
});
