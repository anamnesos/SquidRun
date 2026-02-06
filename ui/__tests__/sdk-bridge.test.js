/**
 * SDK Bridge Module Tests
 * Target: Full coverage of modules/sdk-bridge.js
 */

const EventEmitter = require('events');

// Create mock streams
function createMockStream() {
  const stream = new EventEmitter();
  stream.write = jest.fn((data, callback) => {
    if (callback) callback();
    return true;
  });
  return stream;
}

// Mock spawn to return controllable process
let mockProcess;
let mockSpawn = jest.fn(() => mockProcess);

jest.mock('child_process', () => ({
  spawn: jest.fn((...args) => mockSpawn(...args)),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock fs
let mockFsExistsSync = jest.fn(() => false);
let mockFsReadFileSync = jest.fn(() => '{}');
let mockFsWriteFileSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: jest.fn((...args) => mockFsExistsSync(...args)),
  readFileSync: jest.fn((...args) => mockFsReadFileSync(...args)),
  writeFileSync: jest.fn((...args) => mockFsWriteFileSync(...args)),
}));

const { spawn } = require('child_process');
const fs = require('fs');
const log = require('../modules/logger');
const { SDKBridge, getSDKBridge, PANE_ROLES, ROLE_TO_PANE } = require('../modules/sdk-bridge');

describe('SDK Bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset mock implementations
    mockFsExistsSync = jest.fn(() => false);
    mockFsReadFileSync = jest.fn(() => '{}');
    mockFsWriteFileSync = jest.fn();

    // Setup mock process
    mockProcess = {
      stdout: createMockStream(),
      stderr: createMockStream(),
      stdin: createMockStream(),
      kill: jest.fn(),
      on: jest.fn(),
      pid: 12345,
    };

    mockSpawn = jest.fn(() => mockProcess);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Module exports', () => {
    test('exports SDKBridge class', () => {
      expect(SDKBridge).toBeDefined();
      expect(typeof SDKBridge).toBe('function');
    });

    test('exports getSDKBridge singleton getter', () => {
      const bridge1 = getSDKBridge();
      const bridge2 = getSDKBridge();
      expect(bridge1).toBe(bridge2);
    });

    test('exports PANE_ROLES mapping', () => {
      expect(PANE_ROLES['1']).toBe('Architect');
      expect(PANE_ROLES['2']).toBe('DevOps');
      expect(PANE_ROLES['5']).toBe('Analyst');
    });

    test('exports ROLE_TO_PANE mapping', () => {
      expect(ROLE_TO_PANE['Lead']).toBe('1');
      expect(ROLE_TO_PANE['Architect']).toBe('1');
      expect(ROLE_TO_PANE['orchestrator']).toBe('2');
      expect(ROLE_TO_PANE['worker-b']).toBe('2');
      expect(ROLE_TO_PANE['analyst']).toBe('5');
    });
  });

  describe('SDKBridge constructor', () => {
    test('initializes with default state', () => {
      const bridge = new SDKBridge();

      expect(bridge.process).toBeNull();
      expect(bridge.active).toBe(false);
      expect(bridge.ready).toBe(false);
      expect(bridge.mainWindow).toBeNull();
      expect(bridge.buffer).toBe('');
    });

    test('initializes 3 sessions', () => {
      const bridge = new SDKBridge();

      expect(Object.keys(bridge.sessions)).toHaveLength(3);
      for (const id of ['1', '2', '5']) {
        expect(bridge.sessions[id]).toBeDefined();
        expect(bridge.sessions[id].id).toBeNull();
        expect(bridge.sessions[id].status).toBe('idle');
      }
    });

    test('initializes all panes as subscribed', () => {
      const bridge = new SDKBridge();

      expect(bridge.subscribers.size).toBe(3);
      for (const id of ['1', '2', '5']) {
        expect(bridge.subscribers.has(id)).toBe(true);
      }
    });
  });

  describe('setMainWindow', () => {
    test('sets the main window', () => {
      const bridge = new SDKBridge();
      const mockWindow = { id: 'test-window' };

      bridge.setMainWindow(mockWindow);

      expect(bridge.mainWindow).toBe(mockWindow);
    });
  });

  describe('sendToRenderer', () => {
    test('sends to renderer when window exists', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.sendToRenderer('test-channel', { data: 'test' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('test-channel', { data: 'test' });
    });

    test('does not send when window is destroyed', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => true),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.sendToRenderer('test-channel', {});

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('does not send when window is null', () => {
      const bridge = new SDKBridge();

      expect(() => bridge.sendToRenderer('test-channel', {})).not.toThrow();
    });

    test('skips unsubscribed panes', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.subscribers.delete('2');

      bridge.sendToRenderer('test-channel', { paneId: '2' });

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('sends to subscribed panes', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.sendToRenderer('test-channel', { paneId: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalled();
    });
  });

  describe('loadSessionState', () => {
    test('loads session state from file', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        sdk_sessions: { '1': 'sess-123', '2': 'sess-456' },
      }));

      const result = bridge.loadSessionState();

      expect(result).toBe(true);
      expect(bridge.sessions['1'].id).toBe('sess-123');
      expect(bridge.sessions['2'].id).toBe('sess-456');
    });

    test('handles flat format for migration', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        '1': 'old-sess-1',
      }));

      const result = bridge.loadSessionState();

      expect(result).toBe(true);
      expect(bridge.sessions['1'].id).toBe('old-sess-1');
    });

    test('returns false when file does not exist', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(false);

      const result = bridge.loadSessionState();

      expect(result).toBe(false);
    });

    test('handles parse error', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const result = bridge.loadSessionState();

      expect(result).toBe(false);
      expect(log.error).toHaveBeenCalledWith('SDK Bridge', 'Failed to load session state', expect.any(Error));
    });
  });

  describe('saveSessionState', () => {
    test('saves session state to file', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';
      bridge.sessions['2'].id = 'sess-2';
      mockFsExistsSync.mockReturnValue(false);

      const result = bridge.saveSessionState();

      expect(result).toBe(true);
      expect(mockFsWriteFileSync).toHaveBeenCalled();
      const written = JSON.parse(mockFsWriteFileSync.mock.calls[0][1]);
      expect(written.sdk_sessions['1']).toBe('sess-1');
      expect(written.sdk_sessions['2']).toBe('sess-2');
    });

    test('preserves existing file data', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'new-sess';
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ other_data: 'preserved' }));

      bridge.saveSessionState();

      const written = JSON.parse(mockFsWriteFileSync.mock.calls[0][1]);
      expect(written.other_data).toBe('preserved');
      expect(written.sdk_sessions['1']).toBe('new-sess');
    });

    test('handles corrupted existing file', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockImplementation(() => {
        throw new Error('Corrupted');
      });

      const result = bridge.saveSessionState();

      expect(result).toBe(true); // Should still succeed with fresh object
    });

    test('handles write error', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(false);
      mockFsWriteFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = bridge.saveSessionState();

      expect(result).toBe(false);
      expect(log.error).toHaveBeenCalledWith('SDK Bridge', 'Failed to save session state', expect.any(Error));
    });
  });

  describe('startProcess', () => {
    test('spawns Python process', () => {
      const bridge = new SDKBridge();

      bridge.startProcess({ workspace: '/test/workspace' });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringMatching(/py|python/),
        expect.arrayContaining(['--ipc']),
        expect.objectContaining({ cwd: '/test/workspace' })
      );
      expect(bridge.active).toBe(true);
    });

    test('returns existing process if already running', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      mockSpawn.mockClear();
      bridge.startProcess();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('SDK Bridge', 'Process already running');
    });

    test('loads existing session state', () => {
      const bridge = new SDKBridge();
      mockFsExistsSync.mockReturnValue(true);
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ sdk_sessions: { '1': 'sess-1' } }));

      bridge.startProcess();

      expect(bridge.sessions['1'].id).toBe('sess-1');
    });

    test('uses workspace option in spawn args', () => {
      const bridge = new SDKBridge();

      bridge.startProcess({ workspace: '/custom/path' });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--workspace', '/custom/path']),
        expect.any(Object)
      );
    });

    test('sends ping after delay when not ready', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      jest.advanceTimersByTime(2000);

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('ping'));
    });

    test('does not send ping if already ready', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      mockProcess.stdin.write.mockClear();
      jest.advanceTimersByTime(2000);

      // Check that no ping was sent (ready signal already received)
      const pingSent = mockProcess.stdin.write.mock.calls.some(call =>
        call[0].includes('ping')
      );
      expect(pingSent).toBe(false);
    });
  });

  describe('stdout handling', () => {
    test('parses JSON messages from stdout', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      const msg = JSON.stringify({ type: 'text', content: 'Hello' });
      mockProcess.stdout.emit('data', Buffer.from(msg + '\n'));

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('handles partial JSON lines', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      // Send message in two parts
      mockProcess.stdout.emit('data', Buffer.from('{"type":"text",'));
      mockProcess.stdout.emit('data', Buffer.from('"content":"Hello"}\n'));

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('handles multiple messages in one data event', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      const msg1 = JSON.stringify({ type: 'text', paneId: '1' });
      const msg2 = JSON.stringify({ type: 'text', paneId: '2' });
      mockProcess.stdout.emit('data', Buffer.from(msg1 + '\n' + msg2 + '\n'));

      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(2);
    });

    test('logs non-JSON output', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      mockProcess.stdout.emit('data', Buffer.from('Debug output\n'));

      expect(log.info).toHaveBeenCalledWith('SDK Bridge', 'Python output: Debug output');
    });
  });

  describe('stderr handling', () => {
    test('logs errors from stderr', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      mockProcess.stderr.emit('data', Buffer.from('Error occurred'));

      expect(log.error).toHaveBeenCalledWith('SDK Bridge', 'Python stderr:', 'Error occurred');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-error', expect.any(Object));
    });

    test('parses pane from stderr error', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      mockProcess.stderr.emit('data', Buffer.from('[Pane 2] Error'));

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-error', expect.objectContaining({
        paneId: '2',
      }));
    });
  });

  describe('process close handling', () => {
    test('marks as inactive on close', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      const closeHandler = mockProcess.on.mock.calls.find(c => c[0] === 'close')[1];
      closeHandler(0);

      expect(bridge.active).toBe(false);
      expect(bridge.ready).toBe(false);
    });

    test('marks all sessions as stopped on close', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      const closeHandler = mockProcess.on.mock.calls.find(c => c[0] === 'close')[1];
      closeHandler(0);

      for (const paneId of Object.keys(bridge.sessions)) {
        expect(bridge.sessions[paneId].status).toBe('stopped');
      }
    });

    test('emits close event', () => {
      const bridge = new SDKBridge();
      const closeListener = jest.fn();
      bridge.on('close', closeListener);
      bridge.startProcess();

      const closeHandler = mockProcess.on.mock.calls.find(c => c[0] === 'close')[1];
      closeHandler(0);

      expect(closeListener).toHaveBeenCalledWith(0);
    });
  });

  describe('process error handling', () => {
    test('logs process error', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      const errorHandler = mockProcess.on.mock.calls.find(c => c[0] === 'error')[1];
      errorHandler(new Error('Process error'));

      expect(log.error).toHaveBeenCalledWith('SDK Bridge', 'Process error', expect.any(Error));
      expect(bridge.active).toBe(false);
    });
  });

  describe('sendMessage', () => {
    test('sends message to pane', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();
      bridge.ready = true;

      const result = bridge.sendMessage('1', 'Hello');

      expect(result).toBe(true);
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('send'));
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('Hello'));
    });

    test('normalizes role names to pane IDs', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.sendMessage('Lead', 'Test');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"pane_id":"1"'));
    });

    test('returns false for unknown pane', () => {
      const bridge = new SDKBridge();

      const result = bridge.sendMessage('99', 'Test');

      expect(result).toBe(false);
      expect(log.error).toHaveBeenCalledWith('SDK Bridge', 'Unknown pane: 99');
    });

    test('includes session_id if available', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'existing-session';
      bridge.startProcess();
      bridge.ready = true;

      bridge.sendMessage('1', 'Test');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('existing-session'));
    });

    test('sends delivery confirmation to renderer', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();
      bridge.ready = true;

      bridge.sendMessage('1', 'Test');

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message-delivered', { paneId: '1' });
    });
  });

  describe('subscribe / unsubscribe', () => {
    test('subscribes to pane', () => {
      const bridge = new SDKBridge();
      bridge.subscribers.delete('2');

      const result = bridge.subscribe('2');

      expect(result).toBe(true);
      expect(bridge.subscribers.has('2')).toBe(true);
    });

    test('normalizes role names for subscribe', () => {
      const bridge = new SDKBridge();
      bridge.subscribers.delete('5');

      bridge.subscribe('analyst');

      expect(bridge.subscribers.has('5')).toBe(true);
    });

    test('unsubscribes from pane', () => {
      const bridge = new SDKBridge();

      const result = bridge.unsubscribe('2');

      expect(result).toBe(true);
      expect(bridge.subscribers.has('2')).toBe(false);
    });

    test('normalizes role names for unsubscribe', () => {
      const bridge = new SDKBridge();

      bridge.unsubscribe('Architect');

      expect(bridge.subscribers.has('1')).toBe(false);
    });
  });

  describe('getSessionIds', () => {
    test('returns all session info', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';
      bridge.sessions['1'].status = 'active';

      const ids = bridge.getSessionIds();

      expect(ids['1'].sessionId).toBe('sess-1');
      expect(ids['1'].role).toBe('Architect');
      expect(ids['1'].status).toBe('active');
    });
  });

  describe('startSessions', () => {
    test('applies resume IDs before starting', async () => {
      const bridge = new SDKBridge();

      await bridge.startSessions({
        resumeIds: { '1': 'resume-1', '2': 'resume-2' },
      });

      expect(bridge.sessions['1'].id).toBe('resume-1');
      expect(bridge.sessions['2'].id).toBe('resume-2');
    });

    test('starts process if not active', async () => {
      const bridge = new SDKBridge();

      await bridge.startSessions({ workspace: '/test' });

      expect(mockSpawn).toHaveBeenCalled();
    });

    test('sends session-start notification', async () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      await bridge.startSessions();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-session-start', {
        panes: ['1', '2', '5'],
      });
    });
  });

  describe('sendToProcess', () => {
    test('queues message when process not running', () => {
      const bridge = new SDKBridge();

      const result = bridge.sendToProcess({ command: 'test' });

      expect(result).toBe(false);
      expect(bridge.pendingMessages).toContainEqual({ command: 'test' });
    });

    test('queues message when not ready', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      // ready is false by default

      const result = bridge.sendToProcess({ command: 'test' });

      expect(result).toBe(false);
      expect(bridge.pendingMessages).toContainEqual({ command: 'test' });
    });

    test('sends to stdin when ready', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      const result = bridge.sendToProcess({ command: 'test' });

      expect(result).toBe(true);
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('test'));
    });
  });

  describe('flushPendingMessages', () => {
    test('flushes pending messages when ready', () => {
      const bridge = new SDKBridge();
      bridge.pendingMessages = [{ command: 'msg1' }, { command: 'msg2' }];
      bridge.startProcess();
      bridge.ready = true;

      bridge.flushPendingMessages();

      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(2);
      expect(bridge.pendingMessages).toEqual([]);
    });

    test('does nothing when no pending messages', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.flushPendingMessages();

      // No "Flushing" log expected when no pending messages
      const flushCalls = log.info.mock.calls.filter(c => c[1] && c[1].includes('Flushing'));
      expect(flushCalls.length).toBe(0);
    });
  });

  describe('routeMessage', () => {
    test('routes session-init message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'session-init', pane_id: '1', session_id: 'new-sess' });

      expect(bridge.sessions['1'].id).toBe('new-sess');
      expect(bridge.sessions['1'].status).toBe('ready');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-status-changed', expect.any(Object));
    });

    test('routes text message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'text', content: 'Hello', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.objectContaining({
        paneId: '1',
        message: expect.objectContaining({ type: 'text' }),
      }));
    });

    test('routes assistant message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'assistant', content: 'Hello', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('routes tool_use message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'tool_use', name: 'read_file', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('routes tool_result message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'tool_result', result: 'data', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('routes streaming message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'streaming', active: true, pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-streaming', expect.objectContaining({
        paneId: '1',
        active: true,
      }));
    });

    test('updates status on streaming message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'streaming', active: true, pane_id: '1' });

      expect(bridge.sessions['1'].status).toBe('active');
    });

    test('routes status message with state thinking', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'status', state: 'thinking', pane_id: '1' });

      expect(bridge.sessions['1'].status).toBe('active');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-streaming', { paneId: '1', active: true });
    });

    test('routes status message with state connected', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'status', state: 'connected', pane_id: '1' });

      expect(bridge.sessions['1'].status).toBe('ready');
    });

    test('routes status message with state disconnected', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'status', state: 'disconnected', pane_id: '1' });

      expect(bridge.sessions['1'].status).toBe('stopped');
    });

    test('routes idle status message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'status', state: 'idle', pane_id: '1' });

      expect(bridge.sessions['1'].status).toBe('idle');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-streaming', { paneId: '1', active: false });
    });

    test('routes system message with session_id', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'system', data: { session_id: 'sys-sess' }, pane_id: '1' });

      expect(bridge.sessions['1'].id).toBe('sys-sess');
    });

    test('suppresses user message echo', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'user', content: 'test', pane_id: '1' });

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('SDK Bridge', expect.stringContaining('suppressed'));
    });

    test('routes thinking message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'thinking', thinking: 'hmm', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('routes text_delta for streaming', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'text_delta', text: 'Hello', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-text-delta', {
        paneId: '1',
        text: 'Hello',
      });
    });

    test('routes thinking_delta', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'thinking_delta', thinking: 'hmm', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-thinking-delta', {
        paneId: '1',
        thinking: 'hmm',
      });
    });

    test('routes result message and updates session', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'result', session_id: 'final-sess', pane_id: '1' });

      expect(bridge.sessions['1'].id).toBe('final-sess');
      expect(bridge.sessions['1'].status).toBe('idle');
    });

    test('routes error message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'error', error: 'Something went wrong', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-error', {
        paneId: '1',
        error: 'Something went wrong',
      });
    });

    test('routes ready message and flushes pending', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      bridge.routeMessage({ type: 'ready', agents: ['1', '2'] });

      expect(bridge.ready).toBe(true);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-ready', { agents: ['1', '2'] });
    });

    test('routes agent_started message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'agent_started', pane_id: '2', role: 'Orchestrator', resumed: true });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-agent-started', expect.objectContaining({
        paneId: '2',
        role: 'Orchestrator',
        resumed: true,
      }));
    });

    test('routes warning message', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'warning', message: 'Careful!', pane_id: '1' });

      expect(log.warn).toHaveBeenCalledWith('SDK Bridge', 'Careful!');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-warning', expect.any(Object));
    });

    test('logs message_received', () => {
      const bridge = new SDKBridge();

      bridge.routeMessage({ type: 'message_received', pane_id: '1' });

      expect(log.info).toHaveBeenCalledWith('SDK Bridge', 'Message received by pane 1');
    });

    test('emits sessions-stopped on all_stopped', () => {
      const bridge = new SDKBridge();
      const listener = jest.fn();
      bridge.on('sessions-stopped', listener);

      bridge.routeMessage({ type: 'all_stopped', sessions_saved: true });

      expect(listener).toHaveBeenCalled();
    });

    test('emits sessions-list on sessions message', () => {
      const bridge = new SDKBridge();
      const listener = jest.fn();
      bridge.on('sessions-list', listener);

      bridge.routeMessage({ type: 'sessions', sessions: { '1': 'sess-1' } });

      expect(listener).toHaveBeenCalledWith({ '1': 'sess-1' });
    });

    test('passes through unknown types', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'unknown_type', data: 'test', pane_id: '1' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.any(Object));
    });

    test('uses role mapping for paneId', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'text', role: 'Architect' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.objectContaining({
        paneId: '1',
      }));
    });

    test('uses agent mapping for paneId', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);

      bridge.routeMessage({ type: 'text', agent: 'Orchestrator' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('sdk-message', expect.objectContaining({
        paneId: '2',
      }));
    });
  });

  describe('stopSessions', () => {
    test('returns session IDs when process not running', async () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';

      const result = await bridge.stopSessions();

      expect(result['1'].sessionId).toBe('sess-1');
    });

    test('sends stop command and saves state', async () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      const stopPromise = bridge.stopSessions();

      // Simulate sessions-stopped event
      bridge.emit('sessions-stopped', bridge.getSessionIds());

      const result = await stopPromise;

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('stop'));
      expect(mockFsWriteFileSync).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    test('force stops on timeout', async () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      const stopPromise = bridge.stopSessions();

      jest.advanceTimersByTime(5000);

      await stopPromise;

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('forceStop', () => {
    test('kills process and resets state', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      bridge.forceStop();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(bridge.active).toBe(false);
      expect(bridge.ready).toBe(false);
      expect(bridge.process).toBeNull();
    });

    test('marks all sessions as stopped', () => {
      const bridge = new SDKBridge();
      const mockWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      };
      bridge.setMainWindow(mockWindow);
      bridge.startProcess();

      bridge.forceStop();

      for (const session of Object.values(bridge.sessions)) {
        expect(session.status).toBe('stopped');
      }
    });
  });

  describe('stop', () => {
    test('saves state and force stops', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      bridge.stop();

      expect(mockFsWriteFileSync).toHaveBeenCalled();
      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  describe('write', () => {
    test('writes to stdin when active', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();

      bridge.write('test input');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith('test input\n');
    });

    test('does nothing when not active', () => {
      const bridge = new SDKBridge();

      bridge.write('test');

      // No process, nothing to write to
    });
  });

  describe('isActive', () => {
    test('returns active state', () => {
      const bridge = new SDKBridge();

      expect(bridge.isActive()).toBe(false);

      bridge.startProcess();

      expect(bridge.isActive()).toBe(true);
    });
  });

  describe('getSessions', () => {
    test('returns session IDs (alias for getSessionIds)', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';

      const sessions = bridge.getSessions();

      expect(sessions['1'].sessionId).toBe('sess-1');
    });
  });

  describe('getPaneStatus', () => {
    test('returns status for valid pane', () => {
      const bridge = new SDKBridge();
      bridge.sessions['1'].id = 'sess-1';
      bridge.sessions['1'].status = 'active';

      const status = bridge.getPaneStatus('1');

      expect(status.id).toBe('sess-1');
      expect(status.status).toBe('active');
    });

    test('normalizes role names', () => {
      const bridge = new SDKBridge();

      const status = bridge.getPaneStatus('Architect');

      expect(status).not.toBeNull();
      expect(status.role).toBe('Architect');
    });

    test('returns null for invalid pane', () => {
      const bridge = new SDKBridge();

      const status = bridge.getPaneStatus('99');

      expect(status).toBeNull();
    });
  });

  describe('broadcast', () => {
    test('sends broadcast command', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.broadcast('Hello all');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('broadcast'));
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('Hello all'));
    });

    test('includes exclude list', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.broadcast('Hello', ['1', '2']);

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"exclude":["1","2"]'));
    });
  });

  describe('interrupt', () => {
    test('sends interrupt command', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.interrupt('2');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('interrupt'));
      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"pane_id":"2"'));
    });

    test('normalizes role names', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.interrupt('worker-b');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"pane_id":"2"'));
    });
  });

  describe('start (legacy)', () => {
    test('starts process and sends message to Lead', () => {
      const bridge = new SDKBridge();

      bridge.start('Initial prompt', { workspace: '/test' });

      expect(mockSpawn).toHaveBeenCalled();
      // Message is queued since not ready yet
      expect(bridge.pendingMessages.length).toBe(1);
    });

    test('sends to pane 1 when ready', () => {
      const bridge = new SDKBridge();
      bridge.startProcess();
      bridge.ready = true;

      bridge.start('Test prompt');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"pane_id":"1"'));
    });
  });
});
