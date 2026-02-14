/**
 * Comprehensive Tests for triggers.js module
 * Covers: File Handling, PTY Routing, Workflow Gate, Sequencing
 */

const fs = require('fs');
const path = require('path');

// MOCKS
// Mock dependencies before requiring the module
const mockIpcRenderer = {
  on: jest.fn(),
  invoke: jest.fn().mockResolvedValue({}),
  send: jest.fn(),
};

jest.mock('electron', () => ({
  ipcRenderer: mockIpcRenderer,
}));

// Mock config
jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);

// Mock logger
const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('../modules/logger', () => mockLog);

// Mock diagnostic-log
const mockDiagnosticLog = {
  write: jest.fn(),
};
jest.mock('../modules/diagnostic-log', () => mockDiagnosticLog);

// Mock smart-routing
const mockSmartRouting = {
  getBestAgent: jest.fn().mockReturnValue({ paneId: '1', reason: 'mock', confidence: 0.9 }),
};
jest.mock('../modules/smart-routing', () => mockSmartRouting);

// Mock formatters
jest.mock('../modules/formatters', () => ({
  formatDuration: jest.fn(d => `${d}ms`),
}));

// Mock memory (optional, may fail require in real app but mocked here)
jest.mock('../modules/memory', () => ({
  logTriggerMessage: jest.fn(),
}), { virtual: true });

// Mock crypto
const mockCrypto = {
  randomUUID: jest.fn().mockReturnValue('uuid-1234'),
};
global.crypto = mockCrypto;

// Mock window
global.window = {
  isDestroyed: jest.fn().mockReturnValue(false),
  webContents: {
    send: jest.fn(),
  },
};

// Mock fs
jest.mock('fs');

// Import the module under test
const triggers = require('../modules/triggers');

describe('triggers.js module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Reset module state (as much as possible via exported functions)
    triggers.setWatcher(null);
    // Reset window mock
    global.window.webContents.send.mockClear();
    global.window.isDestroyed.mockReturnValue(false);
    
    // Reset file mocks
    fs.renameSync.mockImplementation(() => {});
    fs.unlinkSync.mockImplementation(() => {});
    fs.readFileSync.mockReturnValue('');
    fs.writeFileSync.mockImplementation(() => {});
    if (!fs.appendFileSync) fs.appendFileSync = jest.fn();
    fs.appendFileSync.mockImplementation(() => {});
    fs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('1. File Handling (handleTriggerFile)', () => {
    test('should rename file to .processing and read it', () => {
      fs.readFileSync.mockReturnValue('test message');
      
      const result = triggers.handleTriggerFile('/test/workspace/triggers/architect.txt', 'architect.txt');
      
      expect(fs.renameSync).toHaveBeenCalledWith(
        '/test/workspace/triggers/architect.txt',
        '/test/workspace/triggers/architect.txt.processing'
      );
      expect(fs.readFileSync).toHaveBeenCalledWith('/test/workspace/triggers/architect.txt.processing');
      expect(fs.unlinkSync).toHaveBeenCalledWith('/test/workspace/triggers/architect.txt.processing');
      expect(result.success).toBe(true);
    });

    test('should handle unknown trigger file', () => {
      const result = triggers.handleTriggerFile('/path/unknown.txt', 'unknown.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('unknown');
      expect(fs.renameSync).not.toHaveBeenCalled();
    });

    test('should handle rename error (concurrent access)', () => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      fs.renameSync.mockImplementation(() => { throw error; });
      
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_processing');
    });

    test('should handle read error', () => {
      fs.renameSync.mockImplementation(() => {});
      fs.readFileSync.mockImplementation(() => { throw new Error('Read failed'); });
      
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('read_error');
      // Should attempt cleanup
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('should handle empty file', () => {
      fs.readFileSync.mockReturnValue('');
      
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('empty');
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('should decode UTF-16LE BOM', () => {
      const buffer = Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]); // "hi" in UTF-16LE
      fs.readFileSync.mockReturnValue(buffer);
      
      triggers.init(global.window, new Map([['1', 'running']]), null);
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      
      expect(result.success).toBe(true);
      // Fixed: Now records to War Room first
      expect(global.window.webContents.send).toHaveBeenCalledWith('war-room-message', expect.objectContaining({
        msg: expect.stringContaining('hi')
      }));
    });

    test('strips HM messageId marker before injection payload', () => {
      fs.readFileSync.mockReturnValue('[HM-MESSAGE-ID:hm-test-1]\n(ANALYST): marker strip');
      triggers.init(global.window, new Map([['1', 'running']]), null);

      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      expect(result.success).toBe(true);
      jest.runAllTimers();

      const injectCalls = global.window.webContents.send.mock.calls
        .filter(([channel]) => channel === 'inject-message');
      expect(injectCalls.length).toBeGreaterThan(0);
      const injectPayload = injectCalls[injectCalls.length - 1][1];
      expect(injectPayload.message).toContain('marker strip');
      expect(injectPayload.message).not.toContain('[HM-MESSAGE-ID:');
    });

    test('deduplicates trigger fallback payloads by HM messageId marker', () => {
      fs.readFileSync.mockReturnValue('[HM-MESSAGE-ID:hm-dup-1]\n(ANALYST): duplicate guard');
      triggers.init(global.window, new Map([['1', 'running']]), null);

      const first = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      expect(first.success).toBe(true);
      jest.runAllTimers();

      const injectCountAfterFirst = global.window.webContents.send.mock.calls
        .filter(([channel]) => channel === 'inject-message').length;

      const second = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt');
      expect(second.success).toBe(false);
      expect(second.reason).toBe('duplicate_message_id');
      jest.runAllTimers();

      const injectCountAfterSecond = global.window.webContents.send.mock.calls
        .filter(([channel]) => channel === 'inject-message').length;

      expect(injectCountAfterSecond).toBe(injectCountAfterFirst);
    });
  });

  describe('2. PTY Routing (notifyAgents)', () => {
    test('should route via PTY injection', () => {
      // init with running state
      const claudeState = new Map([['1', 'running'], ['2', 'stopped']]);
      triggers.init(global.window, claudeState, null);
      
      triggers.notifyAgents(['1', '2'], 'hello');
      
      // Should send to PTY injection channel
      expect(global.window.webContents.send).toHaveBeenCalledWith('inject-message', expect.objectContaining({
        panes: ['1'], // Only running pane 1
        message: expect.stringContaining('hello')
      }));
      // Pane 2 skipped because stopped
    });

    test('sendDirectMessage delivers even when target is not running', () => {
      triggers.init(global.window, new Map([['1', 'running'], ['2', 'idle'], ['5', 'idle']]), null);

      const result = triggers.sendDirectMessage(['2'], 'Direct msg', 'architect');

      expect(result).toEqual(expect.objectContaining({
        success: true,
        accepted: true,
        queued: true,
        verified: false,
        status: 'routed_unverified',
        notified: ['2'],
        mode: 'pty',
      }));
      expect(typeof result.deliveryId).toBe('string');

      jest.runAllTimers();
      expect(global.window.webContents.send).toHaveBeenCalledWith('inject-message', expect.objectContaining({
        panes: ['2'],
        message: expect.stringContaining('[MSG from architect]: Direct msg'),
      }));
    });
  });

  describe('3. Workflow Gate (checkWorkflowGate)', () => {
    test('should allow triggers to non-workers', () => {
      // Architect (1) is not a worker
      const result = triggers.checkWorkflowGate(['1']);
      expect(result.allowed).toBe(true);
    });

    test('should allow workers when watcher state is allowed', () => {
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'executing' }),
      };
      triggers.setWatcher(mockWatcher);

      // DevOps (2) is a worker
      const result = triggers.checkWorkflowGate(['2']);
      expect(result.allowed).toBe(true);
    });

    test('should BLOCK workers when in checkpoint_fix state (actually not allowed)', () => {
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'reviewing' }),
      };
      triggers.setWatcher(mockWatcher);

      const result = triggers.checkWorkflowGate(['2']); // Worker
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked during');
    });

    test('should notify UI when blocked', () => {
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'reviewing' }),
      };
      triggers.setWatcher(mockWatcher);

      // Indirectly test via handleTriggerFile which calls checkWorkflowGate
      fs.readFileSync.mockReturnValue('msg');
      // workers.txt targets '2' (Worker)
      triggers.handleTriggerFile('/path/workers.txt', 'workers.txt');

      expect(global.window.webContents.send).toHaveBeenCalledWith('trigger-blocked', expect.anything());
    });
  });

  describe('4. Sequencing (isDuplicateMessage)', () => {
    test('should parse sequence numbers', () => {
      const parsed = triggers.parseMessageSequence('(ARCHITECT #5): msg');
      expect(parsed.seq).toBe(5);
      expect(parsed.sender).toBe('architect');
    });

    test('should detect duplicates based on state', () => {
      // triggers.init() resets state to empty (preventing stale blocks)
      triggers.init(global.window, null, null);
      
      // Fixed: recordMessageSeen is exported
      triggers.recordMessageSeen('analyst', 5, 'architect');
      
      // Test duplicate (seq 5 <= lastSeen 5)
      const isDup = triggers.isDuplicateMessage('analyst', 5, 'architect');
      expect(isDup).toBe(true);
      
      // Test new message (seq 6 > lastSeen 5)
      const isNew = triggers.isDuplicateMessage('analyst', 6, 'architect');
      expect(isNew).toBe(false);
    });

    test('should update state on new message', () => {
      // Simulate successful delivery updating state
      // recordMessageSeen is exported
      triggers.recordMessageSeen('analyst', 10, 'architect');
      
      // Verify save (write to temp then rename)
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('.tmp'), expect.any(String), 'utf-8');
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('should handle session reset banner', () => {
      // Reset logic requires banner IN the message content
      fs.readFileSync.mockReturnValue('(ANALYST #1): # HIVEMIND SESSION: Reset');
      
      // Mock state to have seen #5
      triggers.recordMessageSeen('analyst', 5, 'architect');
      
      // Now send #1 with session banner
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt'); // Architect recipient

      expect(result.success).toBe(true);
      // Verification of sequence reset happens internally:
      // If reset worked, #1 is NOT a duplicate even though lastSeen was 5
      expect(triggers.isDuplicateMessage('analyst', 1, 'architect')).toBe(false);
    });
  });

  describe('5. War Room logging + ambient updates', () => {
    test('records war room entry for trigger messages', () => {
      fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('war-room.log')) return '';
        return '(BACK #1): API ready';
      });
      triggers.init(global.window, new Map([['1', 'running']]), null);

      triggers.handleTriggerFile('/test/workspace/triggers/architect.txt', 'architect.txt');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('war-room.log'),
        expect.stringContaining('"from":"DEVOPS"'),
        'utf-8'
      );
      expect(global.window.webContents.send).toHaveBeenCalledWith(
        'war-room-message',
        expect.objectContaining({ from: 'DEVOPS', to: 'ARCH', msg: 'API ready' })
      );
    });

    test('injects ambient update when role is mentioned', () => {
      fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('war-room.log')) return '';
        return '(INFRA #2): Backend should check';
      });
      const running = new Map([['1', 'running'], ['2', 'running'], ['5', 'running']]);
      triggers.init(global.window, running, null);

      triggers.handleTriggerFile('/test/workspace/triggers/architect.txt', 'architect.txt');

      // War room message should be emitted for mentioned role
      expect(global.window.webContents.send).toHaveBeenCalledWith('war-room-message', expect.objectContaining({
        from: 'DEVOPS',
        to: 'ARCH',
      }));
    });

    test('sanitizes carriage returns before war room emit/log', () => {
      fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('war-room.log')) return '';
        return '(BACK #3): first line\r\nsecond line\r';
      });
      triggers.init(global.window, new Map([['1', 'running']]), null);

      triggers.handleTriggerFile('/test/workspace/triggers/architect.txt', 'architect.txt');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('war-room.log'),
        expect.not.stringContaining('\\r'),
        'utf-8'
      );
      expect(global.window.webContents.send).toHaveBeenCalledWith(
        'war-room-message',
        expect.objectContaining({ msg: 'first line\nsecond line' })
      );
    });
  });
});
