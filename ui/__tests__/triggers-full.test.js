/**
 * Comprehensive Tests for triggers.js module
 * Covers: File Handling, SDK/PTY Routing, Workflow Gate, Sequencing, SDK Bridge
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
const mockConfig = {
  WORKSPACE_PATH: '/test/workspace',
  TRIGGER_TARGETS: {
    'lead.txt': ['1'],
    'architect.txt': ['1'],
    'worker-a.txt': ['2'],
    'frontend.txt': ['3'],
    'worker-b.txt': ['3'],
    'backend.txt': ['4'],
    'analyst.txt': ['5'],
    'reviewer.txt': ['6'],
  },
  PANE_IDS: ['1', '2', '3', '4', '5', '6'],
};
jest.mock('../config', () => mockConfig);

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
    triggers.setSDKMode(false);
    triggers.setSDKBridge(null);
    triggers.setWatcher(null);
    // Reset window mock
    global.window.webContents.send.mockClear();
    global.window.isDestroyed.mockReturnValue(false);
    
    // Reset file mocks
    fs.renameSync.mockImplementation(() => {});
    fs.unlinkSync.mockImplementation(() => {});
    fs.readFileSync.mockReturnValue('');
    fs.writeFileSync.mockImplementation(() => {});
    fs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('1. File Handling (handleTriggerFile)', () => {
    test('should rename file to .processing and read it', () => {
      fs.readFileSync.mockReturnValue('test message');
      
      const result = triggers.handleTriggerFile('/test/workspace/triggers/lead.txt', 'lead.txt');
      
      expect(fs.renameSync).toHaveBeenCalledWith(
        '/test/workspace/triggers/lead.txt',
        '/test/workspace/triggers/lead.txt.processing'
      );
      expect(fs.readFileSync).toHaveBeenCalledWith('/test/workspace/triggers/lead.txt.processing');
      expect(fs.unlinkSync).toHaveBeenCalledWith('/test/workspace/triggers/lead.txt.processing');
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
      
      const result = triggers.handleTriggerFile('/path/lead.txt', 'lead.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_processing');
    });

    test('should handle read error', () => {
      fs.renameSync.mockImplementation(() => {});
      fs.readFileSync.mockImplementation(() => { throw new Error('Read failed'); });
      
      const result = triggers.handleTriggerFile('/path/lead.txt', 'lead.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('read_error');
      // Should attempt cleanup
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('should handle empty file', () => {
      fs.readFileSync.mockReturnValue('');
      
      const result = triggers.handleTriggerFile('/path/lead.txt', 'lead.txt');
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe('empty');
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('should decode UTF-16LE BOM', () => {
      const buffer = Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]); // "hi" in UTF-16LE
      fs.readFileSync.mockReturnValue(buffer);
      
      triggers.init(global.window, new Map([['1', 'running']]), null);
      const result = triggers.handleTriggerFile('/path/lead.txt', 'lead.txt');
      
      expect(result.success).toBe(true);
      expect(global.window.webContents.send).toHaveBeenCalledWith('inject-message', expect.objectContaining({
        message: expect.stringContaining('hi')
      }));
    });
  });

  describe('2. SDK/PTY Routing (notifyAgents)', () => {
    test('should route via PTY when SDK mode disabled', () => {
      triggers.setSDKMode(false);
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

    test('should route via SDK Bridge when SDK mode enabled', () => {
      triggers.setSDKMode(true);
      const mockBridge = {
        sendMessage: jest.fn().mockReturnValue(true),
      };
      triggers.setSDKBridge(mockBridge);
      
      triggers.notifyAgents(['1', '2'], 'hello sdk');
      
      // Should call bridge
      expect(mockBridge.sendMessage).toHaveBeenCalledWith('1', 'hello sdk');
      expect(mockBridge.sendMessage).toHaveBeenCalledWith('2', 'hello sdk');
      
      // Should also notify UI for display
      expect(global.window.webContents.send).toHaveBeenCalledWith('sdk-message', expect.anything());
    });

    test('should handle SDK send failure (exception)', () => {
      triggers.setSDKMode(true);
      const mockBridge = {
        sendMessage: jest.fn().mockImplementation(() => { throw new Error('SDK Error'); }),
      };
      triggers.setSDKBridge(mockBridge);
      
      triggers.notifyAgents(['1'], 'fail');
      
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Triggers'), 
        expect.stringContaining('SDK send failed'), 
        expect.anything()
      );
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
      
      // Frontend (3) is a worker
      const result = triggers.checkWorkflowGate(['3']);
      expect(result.allowed).toBe(true);
    });

    test('should BLOCK workers when in review state', () => {
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'plan_review' }),
      };
      triggers.setWatcher(mockWatcher);
      
      const result = triggers.checkWorkflowGate(['3']); // Worker
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked during');
    });

    test('should notify UI when blocked', () => {
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'plan_review' }),
      };
      triggers.setWatcher(mockWatcher);
      
      // Indirectly test via handleTriggerFile which calls checkWorkflowGate
      fs.readFileSync.mockReturnValue('msg');
      // worker-b.txt targets '3' (Worker)
      triggers.handleTriggerFile('/path/worker-b.txt', 'worker-b.txt');
      
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
      
      // Manually populate state to simulate history
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
      // This ensures we're testing the reset logic (1 < 5 would be duplicate without reset)
      triggers.recordMessageSeen('analyst', 5, 'architect');
      
      // Now send #1 with session banner
      const result = triggers.handleTriggerFile('/path/architect.txt', 'architect.txt'); // Architect is recipient
      
      expect(result.success).toBe(true);
      expect(mockLog.info).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Reset lastSeen'));
    });
  });

  describe('5. SDK Bridge & Mode', () => {
    test('isSDKModeEnabled returns correct status', () => {
      triggers.setSDKMode(false);
      triggers.setSDKBridge(null);
      expect(triggers.isSDKModeEnabled()).toBe(false);
      
      triggers.setSDKMode(true);
      expect(triggers.isSDKModeEnabled()).toBe(false); // Bridge null
      
      triggers.setSDKBridge({});
      expect(triggers.isSDKModeEnabled()).toBe(true);
    });

    test('broadcastToAllAgents uses SDK bridge when enabled', () => {
      triggers.setSDKMode(true);
      const mockBridge = {
        broadcast: jest.fn(),
        sendMessage: jest.fn().mockReturnValue(true),
      };
      triggers.setSDKBridge(mockBridge);
      
      triggers.broadcastToAllAgents('Announcement');
      
      // Should prefer broadcast if available
      expect(mockBridge.broadcast).toHaveBeenCalledWith(expect.stringContaining('Announcement'));
    });

    test('sendDirectMessage bypasses gate and uses SDK', () => {
      triggers.setSDKMode(true);
      const mockBridge = {
        sendMessage: jest.fn().mockReturnValue(true),
      };
      triggers.setSDKBridge(mockBridge);
      
      // Even if watcher says blocked
      const mockWatcher = {
        readState: jest.fn().mockReturnValue({ state: 'plan_review' }),
      };
      triggers.setWatcher(mockWatcher);
      
      triggers.sendDirectMessage(['3'], 'Direct msg');
      
      expect(mockBridge.sendMessage).toHaveBeenCalledWith('3', expect.stringContaining('Direct msg'));
    });
  });
});
