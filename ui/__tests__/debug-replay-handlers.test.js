/**
 * Debug Replay IPC Handlers Tests
 * Target: Full coverage of modules/ipc/debug-replay-handlers.js
 */

const { registerDebugReplayHandlers } = require('../modules/ipc/debug-replay-handlers');

// Mock the debug-replay module
jest.mock('../modules/memory/debug-replay', () => ({
  loadSession: jest.fn(),
  loadTimeRangeSession: jest.fn(),
  stepForward: jest.fn(),
  stepBackward: jest.fn(),
  jumpTo: jest.fn(),
  jumpToTime: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  reset: jest.fn(),
  setFilter: jest.fn(),
  searchActions: jest.fn(),
  getState: jest.fn(),
  getCurrentAction: jest.fn(),
  getActions: jest.fn(),
  getActionContext: jest.fn(),
  findRelatedActions: jest.fn(),
  addBreakpoint: jest.fn(),
  addTypeBreakpoint: jest.fn(),
  removeBreakpoint: jest.fn(),
  removeTypeBreakpoint: jest.fn(),
  clearBreakpoints: jest.fn(),
  exportSession: jest.fn(),
  getSessionStats: jest.fn(),
}));

const mockDebugReplay = require('../modules/memory/debug-replay');

describe('Debug Replay IPC Handlers', () => {
  let mockIpcMain;
  let handlers;
  const WORKSPACE_PATH = '/test/workspace';

  beforeEach(() => {
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    // Default mock implementations
    mockDebugReplay.getState.mockReturnValue({
      currentIndex: 0,
      totalActions: 10,
      isPlaying: false,
      filter: 'all',
    });
    mockDebugReplay.getCurrentAction.mockReturnValue({ type: 'input', content: 'test' });
    mockDebugReplay.getActions.mockReturnValue([]);
  });

  describe('registerDebugReplayHandlers', () => {
    test('does nothing if ipcMain is missing', () => {
      registerDebugReplayHandlers({});

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('does nothing if WORKSPACE_PATH is missing', () => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('registers all expected handlers', () => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-load-session', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-load-timerange', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-step-forward', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-step-backward', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-jump-to', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-jump-to-time', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-play', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-pause', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-reset', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-set-filter', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-search', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-get-state', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-get-actions', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-get-context', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-add-breakpoint', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-remove-breakpoint', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-clear-breakpoints', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-export', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('debug-get-stats', expect.any(Function));
    });
  });

  describe('debug-load-session', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when role is missing', async () => {
      const result = await handlers['debug-load-session']({}, {});

      expect(result).toEqual({ success: false, error: 'role required' });
    });

    test('loads session successfully', async () => {
      mockDebugReplay.loadSession.mockReturnValue({
        success: true,
        actions: [{ type: 'input' }],
        count: 1,
      });

      const result = await handlers['debug-load-session']({}, {
        role: 'architect',
        startTime: 1000,
        endTime: 2000,
        limit: 100,
        types: ['input', 'output'],
      });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.loadSession).toHaveBeenCalledWith('architect', {
        startTime: 1000,
        endTime: 2000,
        limit: 100,
        types: ['input', 'output'],
      });
    });

    test('handles load session error', async () => {
      mockDebugReplay.loadSession.mockImplementation(() => {
        throw new Error('Session not found');
      });

      const result = await handlers['debug-load-session']({}, { role: 'architect' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session not found');
    });
  });

  describe('debug-load-timerange', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when startTime is missing', async () => {
      const result = await handlers['debug-load-timerange']({}, { endTime: 2000 });

      expect(result).toEqual({ success: false, error: 'startTime and endTime required' });
    });

    test('returns error when endTime is missing', async () => {
      const result = await handlers['debug-load-timerange']({}, { startTime: 1000 });

      expect(result).toEqual({ success: false, error: 'startTime and endTime required' });
    });

    test('loads timerange session successfully', async () => {
      mockDebugReplay.loadTimeRangeSession.mockReturnValue({
        success: true,
        actions: [{ type: 'input' }, { type: 'output' }],
      });

      const result = await handlers['debug-load-timerange']({}, {
        startTime: 1000,
        endTime: 2000,
      });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.loadTimeRangeSession).toHaveBeenCalledWith(1000, 2000);
    });

    test('handles load timerange error', async () => {
      mockDebugReplay.loadTimeRangeSession.mockImplementation(() => {
        throw new Error('Invalid time range');
      });

      const result = await handlers['debug-load-timerange']({}, {
        startTime: 1000,
        endTime: 2000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid time range');
    });
  });

  describe('debug-step-forward', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('steps forward successfully', async () => {
      mockDebugReplay.stepForward.mockReturnValue({ type: 'input', content: 'next action' });
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 1, totalActions: 10 });

      const result = await handlers['debug-step-forward']({});

      expect(result.success).toBe(true);
      expect(result.action).toEqual({ type: 'input', content: 'next action' });
      expect(result.state).toEqual({ currentIndex: 1, totalActions: 10 });
    });

    test('handles step forward error', async () => {
      mockDebugReplay.stepForward.mockImplementation(() => {
        throw new Error('No more actions');
      });

      const result = await handlers['debug-step-forward']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No more actions');
    });
  });

  describe('debug-step-backward', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('steps backward successfully', async () => {
      mockDebugReplay.stepBackward.mockReturnValue({ type: 'output', content: 'prev action' });
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 0, totalActions: 10 });

      const result = await handlers['debug-step-backward']({});

      expect(result.success).toBe(true);
      expect(result.action).toEqual({ type: 'output', content: 'prev action' });
      expect(result.state.currentIndex).toBe(0);
    });

    test('handles step backward error', async () => {
      mockDebugReplay.stepBackward.mockImplementation(() => {
        throw new Error('Already at beginning');
      });

      const result = await handlers['debug-step-backward']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Already at beginning');
    });
  });

  describe('debug-jump-to', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when index is missing', async () => {
      const result = await handlers['debug-jump-to']({}, {});

      expect(result).toEqual({ success: false, error: 'index required' });
    });

    test('jumps to index successfully', async () => {
      mockDebugReplay.jumpTo.mockReturnValue({ type: 'tool_use', tool: 'Bash' });
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 5, totalActions: 10 });

      const result = await handlers['debug-jump-to']({}, { index: 5 });

      expect(result.success).toBe(true);
      expect(result.action).toEqual({ type: 'tool_use', tool: 'Bash' });
      expect(mockDebugReplay.jumpTo).toHaveBeenCalledWith(5);
    });

    test('handles index 0', async () => {
      mockDebugReplay.jumpTo.mockReturnValue({ type: 'input', content: 'first' });
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 0 });

      const result = await handlers['debug-jump-to']({}, { index: 0 });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.jumpTo).toHaveBeenCalledWith(0);
    });

    test('handles jump to error', async () => {
      mockDebugReplay.jumpTo.mockImplementation(() => {
        throw new Error('Index out of range');
      });

      const result = await handlers['debug-jump-to']({}, { index: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Index out of range');
    });
  });

  describe('debug-jump-to-time', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when timestamp is missing', async () => {
      const result = await handlers['debug-jump-to-time']({}, {});

      expect(result).toEqual({ success: false, error: 'timestamp required' });
    });

    test('jumps to timestamp successfully', async () => {
      mockDebugReplay.jumpToTime.mockReturnValue({ type: 'input', timestamp: 1500 });
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 3 });

      const result = await handlers['debug-jump-to-time']({}, { timestamp: 1500 });

      expect(result.success).toBe(true);
      expect(result.action.timestamp).toBe(1500);
      expect(mockDebugReplay.jumpToTime).toHaveBeenCalledWith(1500);
    });

    test('handles jump to time error', async () => {
      mockDebugReplay.jumpToTime.mockImplementation(() => {
        throw new Error('Timestamp not found');
      });

      const result = await handlers['debug-jump-to-time']({}, { timestamp: 9999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp not found');
    });
  });

  describe('debug-play', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('starts playing with default speed', async () => {
      mockDebugReplay.getState.mockReturnValue({ isPlaying: true, speed: 1 });

      const result = await handlers['debug-play']({}, {});

      expect(result.success).toBe(true);
      expect(result.state.isPlaying).toBe(true);
      expect(mockDebugReplay.play).toHaveBeenCalledWith(1);
    });

    test('starts playing with custom speed', async () => {
      mockDebugReplay.getState.mockReturnValue({ isPlaying: true, speed: 2 });

      const result = await handlers['debug-play']({}, { speed: 2 });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.play).toHaveBeenCalledWith(2);
    });

    test('handles play error', async () => {
      mockDebugReplay.play.mockImplementation(() => {
        throw new Error('No session loaded');
      });

      const result = await handlers['debug-play']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No session loaded');
    });
  });

  describe('debug-pause', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('pauses playback successfully', async () => {
      mockDebugReplay.getState.mockReturnValue({ isPlaying: false });

      const result = await handlers['debug-pause']({});

      expect(result.success).toBe(true);
      expect(result.state.isPlaying).toBe(false);
      expect(mockDebugReplay.pause).toHaveBeenCalled();
    });

    test('handles pause error', async () => {
      mockDebugReplay.pause.mockImplementation(() => {
        throw new Error('Not playing');
      });

      const result = await handlers['debug-pause']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not playing');
    });
  });

  describe('debug-reset', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('resets session successfully', async () => {
      mockDebugReplay.getState.mockReturnValue({ currentIndex: 0, totalActions: 10 });

      const result = await handlers['debug-reset']({});

      expect(result.success).toBe(true);
      expect(result.state.currentIndex).toBe(0);
      expect(mockDebugReplay.reset).toHaveBeenCalled();
    });

    test('handles reset error', async () => {
      mockDebugReplay.reset.mockImplementation(() => {
        throw new Error('No session to reset');
      });

      const result = await handlers['debug-reset']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No session to reset');
    });
  });

  describe('debug-set-filter', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('sets filter with default value', async () => {
      mockDebugReplay.getState.mockReturnValue({ filter: 'all' });

      const result = await handlers['debug-set-filter']({}, {});

      expect(result.success).toBe(true);
      expect(mockDebugReplay.setFilter).toHaveBeenCalledWith('all');
    });

    test('sets custom filter', async () => {
      mockDebugReplay.getState.mockReturnValue({ filter: 'tool_use' });

      const result = await handlers['debug-set-filter']({}, { filter: 'tool_use' });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.setFilter).toHaveBeenCalledWith('tool_use');
    });

    test('handles set filter error', async () => {
      mockDebugReplay.setFilter.mockImplementation(() => {
        throw new Error('Invalid filter');
      });

      const result = await handlers['debug-set-filter']({}, { filter: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid filter');
    });
  });

  describe('debug-search', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when query is missing', async () => {
      const result = await handlers['debug-search']({}, {});

      expect(result).toEqual({ success: false, error: 'query required', results: [] });
    });

    test('searches actions successfully', async () => {
      mockDebugReplay.searchActions.mockReturnValue([
        { index: 2, type: 'input', content: 'test query' },
        { index: 5, type: 'output', content: 'test response' },
      ]);

      const result = await handlers['debug-search']({}, { query: 'test' });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(mockDebugReplay.searchActions).toHaveBeenCalledWith('test');
    });

    test('handles search error', async () => {
      mockDebugReplay.searchActions.mockImplementation(() => {
        throw new Error('Search failed');
      });

      const result = await handlers['debug-search']({}, { query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Search failed');
      expect(result.results).toEqual([]);
    });
  });

  describe('debug-get-state', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('gets state successfully', async () => {
      mockDebugReplay.getState.mockReturnValue({
        currentIndex: 3,
        totalActions: 10,
        isPlaying: false,
      });
      mockDebugReplay.getCurrentAction.mockReturnValue({ type: 'tool_use' });

      const result = await handlers['debug-get-state']({});

      expect(result.success).toBe(true);
      expect(result.state.currentIndex).toBe(3);
      expect(result.currentAction.type).toBe('tool_use');
    });

    test('handles get state error', async () => {
      mockDebugReplay.getState.mockImplementation(() => {
        throw new Error('State unavailable');
      });

      const result = await handlers['debug-get-state']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('State unavailable');
    });
  });

  describe('debug-get-actions', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('gets actions successfully', async () => {
      mockDebugReplay.getActions.mockReturnValue([
        { type: 'input' },
        { type: 'output' },
        { type: 'tool_use' },
      ]);

      const result = await handlers['debug-get-actions']({});

      expect(result.success).toBe(true);
      expect(result.actions).toHaveLength(3);
      expect(result.count).toBe(3);
    });

    test('handles get actions error', async () => {
      mockDebugReplay.getActions.mockImplementation(() => {
        throw new Error('No actions loaded');
      });

      const result = await handlers['debug-get-actions']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No actions loaded');
      expect(result.actions).toEqual([]);
    });
  });

  describe('debug-get-context', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when index is missing', async () => {
      const result = await handlers['debug-get-context']({}, {});

      expect(result).toEqual({ success: false, error: 'index required' });
    });

    test('gets context successfully', async () => {
      mockDebugReplay.getActionContext.mockReturnValue({
        before: [{ type: 'input' }],
        current: { type: 'tool_use', tool: 'Bash' },
        after: [{ type: 'output' }],
      });
      mockDebugReplay.findRelatedActions.mockReturnValue([
        { index: 1, type: 'input', related: 'request' },
      ]);

      const result = await handlers['debug-get-context']({}, { index: 5 });

      expect(result.success).toBe(true);
      expect(result.context.current.tool).toBe('Bash');
      expect(result.related).toHaveLength(1);
      expect(mockDebugReplay.getActionContext).toHaveBeenCalledWith(5, 5);
    });

    test('uses custom range', async () => {
      mockDebugReplay.getActionContext.mockReturnValue({ current: {} });
      mockDebugReplay.findRelatedActions.mockReturnValue([]);

      await handlers['debug-get-context']({}, { index: 5, range: 10 });

      expect(mockDebugReplay.getActionContext).toHaveBeenCalledWith(5, 10);
    });

    test('handles get context error', async () => {
      mockDebugReplay.getActionContext.mockImplementation(() => {
        throw new Error('Index not found');
      });

      const result = await handlers['debug-get-context']({}, { index: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Index not found');
    });
  });

  describe('debug-add-breakpoint', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('adds index breakpoint', async () => {
      mockDebugReplay.getState.mockReturnValue({ breakpoints: [5] });

      const result = await handlers['debug-add-breakpoint']({}, { index: 5 });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.addBreakpoint).toHaveBeenCalledWith(5);
    });

    test('adds type breakpoint', async () => {
      mockDebugReplay.getState.mockReturnValue({ typeBreakpoints: ['error'] });

      const result = await handlers['debug-add-breakpoint']({}, { type: 'error' });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.addTypeBreakpoint).toHaveBeenCalledWith('error');
    });

    test('adds both index and type breakpoints', async () => {
      mockDebugReplay.getState.mockReturnValue({});

      const result = await handlers['debug-add-breakpoint']({}, { index: 5, type: 'error' });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.addBreakpoint).toHaveBeenCalledWith(5);
      expect(mockDebugReplay.addTypeBreakpoint).toHaveBeenCalledWith('error');
    });

    test('handles add breakpoint without index or type', async () => {
      mockDebugReplay.getState.mockReturnValue({});

      const result = await handlers['debug-add-breakpoint']({}, {});

      expect(result.success).toBe(true);
      expect(mockDebugReplay.addBreakpoint).not.toHaveBeenCalled();
      expect(mockDebugReplay.addTypeBreakpoint).not.toHaveBeenCalled();
    });

    test('handles add breakpoint error', async () => {
      mockDebugReplay.addBreakpoint.mockImplementation(() => {
        throw new Error('Invalid breakpoint');
      });

      const result = await handlers['debug-add-breakpoint']({}, { index: -1 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid breakpoint');
    });
  });

  describe('debug-remove-breakpoint', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('removes index breakpoint', async () => {
      mockDebugReplay.getState.mockReturnValue({ breakpoints: [] });

      const result = await handlers['debug-remove-breakpoint']({}, { index: 5 });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.removeBreakpoint).toHaveBeenCalledWith(5);
    });

    test('removes type breakpoint', async () => {
      mockDebugReplay.getState.mockReturnValue({ typeBreakpoints: [] });

      const result = await handlers['debug-remove-breakpoint']({}, { type: 'error' });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.removeTypeBreakpoint).toHaveBeenCalledWith('error');
    });

    test('removes both index and type breakpoints', async () => {
      mockDebugReplay.getState.mockReturnValue({});

      const result = await handlers['debug-remove-breakpoint']({}, { index: 5, type: 'error' });

      expect(result.success).toBe(true);
      expect(mockDebugReplay.removeBreakpoint).toHaveBeenCalledWith(5);
      expect(mockDebugReplay.removeTypeBreakpoint).toHaveBeenCalledWith('error');
    });

    test('handles remove breakpoint error', async () => {
      mockDebugReplay.removeBreakpoint.mockImplementation(() => {
        throw new Error('Breakpoint not found');
      });

      const result = await handlers['debug-remove-breakpoint']({}, { index: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Breakpoint not found');
    });
  });

  describe('debug-clear-breakpoints', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('clears all breakpoints', async () => {
      mockDebugReplay.getState.mockReturnValue({ breakpoints: [], typeBreakpoints: [] });

      const result = await handlers['debug-clear-breakpoints']({});

      expect(result.success).toBe(true);
      expect(mockDebugReplay.clearBreakpoints).toHaveBeenCalled();
    });

    test('handles clear breakpoints error', async () => {
      mockDebugReplay.clearBreakpoints.mockImplementation(() => {
        throw new Error('Clear failed');
      });

      const result = await handlers['debug-clear-breakpoints']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Clear failed');
    });
  });

  describe('debug-export', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('exports session with default options', async () => {
      mockDebugReplay.exportSession.mockReturnValue({ actions: [], metadata: {} });

      const result = await handlers['debug-export']({}, {});

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(mockDebugReplay.exportSession).toHaveBeenCalledWith({
        format: 'json',
        includeContent: true,
      });
    });

    test('exports session with custom format', async () => {
      mockDebugReplay.exportSession.mockReturnValue('# Session Export\n...');

      const result = await handlers['debug-export']({}, {
        format: 'markdown',
        includeContent: false,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('markdown');
      expect(mockDebugReplay.exportSession).toHaveBeenCalledWith({
        format: 'markdown',
        includeContent: false,
      });
    });

    test('handles export error', async () => {
      mockDebugReplay.exportSession.mockImplementation(() => {
        throw new Error('Export failed');
      });

      const result = await handlers['debug-export']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Export failed');
    });
  });

  describe('debug-get-stats', () => {
    beforeEach(() => {
      registerDebugReplayHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('gets stats successfully', async () => {
      mockDebugReplay.getActions.mockReturnValue([
        { type: 'input' },
        { type: 'output' },
        { type: 'tool_use' },
      ]);
      mockDebugReplay.getSessionStats.mockReturnValue({
        totalActions: 3,
        byType: { input: 1, output: 1, tool_use: 1 },
        duration: 5000,
      });

      const result = await handlers['debug-get-stats']({});

      expect(result.success).toBe(true);
      expect(result.stats.totalActions).toBe(3);
      expect(mockDebugReplay.getSessionStats).toHaveBeenCalledWith([
        { type: 'input' },
        { type: 'output' },
        { type: 'tool_use' },
      ]);
    });

    test('handles get stats error', async () => {
      mockDebugReplay.getActions.mockImplementation(() => {
        throw new Error('No session');
      });

      const result = await handlers['debug-get-stats']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No session');
    });
  });

  describe('lazy loading of debug-replay module', () => {
    test('module is only loaded when first handler is called', async () => {
      // Clear all module cache to test lazy loading
      jest.resetModules();
      jest.clearAllMocks();

      // Re-mock the module
      jest.doMock('../modules/memory/debug-replay', () => ({
        getState: jest.fn().mockReturnValue({}),
        getCurrentAction: jest.fn().mockReturnValue(null),
      }));

      // Re-require the handler module
      const { registerDebugReplayHandlers: freshRegister } = require('../modules/ipc/debug-replay-handlers');

      const freshHandlers = {};
      const freshIpcMain = {
        handle: jest.fn((channel, handler) => {
          freshHandlers[channel] = handler;
        }),
      };

      freshRegister({ ipcMain: freshIpcMain, WORKSPACE_PATH });

      // Module not loaded yet until a handler is called
      await freshHandlers['debug-get-state']({});

      // Module should now be loaded (via lazy loading)
      const loadedModule = require('../modules/memory/debug-replay');
      expect(loadedModule.getState).toHaveBeenCalled();
    });
  });
});
