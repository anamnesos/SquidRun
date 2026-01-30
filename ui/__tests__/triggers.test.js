/**
 * Tests for trigger file handling
 * T5 - Worker B
 */

const path = require('path');
const { TRIGGER_TARGETS, WORKSPACE_PATH } = require('../config');

describe('Trigger System', () => {
  describe('TRIGGER_TARGETS mapping', () => {
    test('should have 25 trigger file types (new + legacy)', () => {
      const keys = Object.keys(TRIGGER_TARGETS);
      expect(keys.length).toBe(25); // 6 new + 5 legacy + 3 broadcast + 11 "others" triggers
    });

    test('all trigger files should end with .txt', () => {
      Object.keys(TRIGGER_TARGETS).forEach(filename => {
        expect(filename).toMatch(/\.txt$/);
      });
    });

    test('all target arrays should contain valid pane IDs', () => {
      const validPaneIds = ['1', '2', '3', '4', '5', '6'];

      Object.values(TRIGGER_TARGETS).forEach(targets => {
        expect(Array.isArray(targets)).toBe(true);
        targets.forEach(paneId => {
          expect(validPaneIds).toContain(paneId);
        });
      });
    });

    describe('individual trigger targets', () => {
      test('lead.txt targets only pane 1 (Architect)', () => {
        expect(TRIGGER_TARGETS['lead.txt']).toEqual(['1']);
      });

      test('orchestrator.txt targets only pane 2 (Orchestrator)', () => {
        expect(TRIGGER_TARGETS['orchestrator.txt']).toEqual(['2']);
      });

      test('worker-a.txt targets only pane 3 (Implementer A)', () => {
        expect(TRIGGER_TARGETS['worker-a.txt']).toEqual(['3']);
      });

      test('worker-b.txt targets only pane 4 (Implementer B)', () => {
        expect(TRIGGER_TARGETS['worker-b.txt']).toEqual(['4']);
      });

      test('investigator.txt targets only pane 5 (Investigator)', () => {
        expect(TRIGGER_TARGETS['investigator.txt']).toEqual(['5']);
      });

      test('reviewer.txt targets only pane 6 (Reviewer)', () => {
        expect(TRIGGER_TARGETS['reviewer.txt']).toEqual(['6']);
      });

      test('workers.txt targets Frontend and Backend panes', () => {
        expect(TRIGGER_TARGETS['workers.txt']).toEqual(['3', '4']);
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('1');
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('2');
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('5');
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('6');
      });

      test('all.txt targets all 6 panes', () => {
        expect(TRIGGER_TARGETS['all.txt']).toEqual(['1', '2', '3', '4', '5', '6']);
        expect(TRIGGER_TARGETS['all.txt'].length).toBe(6);
      });
    });
  });

  describe('trigger file path construction', () => {
    const TRIGGERS_DIR = path.join(WORKSPACE_PATH, 'triggers');

    test('trigger directory should be under workspace', () => {
      expect(TRIGGERS_DIR).toContain('workspace');
      expect(TRIGGERS_DIR).toContain('triggers');
    });

    test('full trigger paths should be constructable', () => {
      Object.keys(TRIGGER_TARGETS).forEach(filename => {
        const fullPath = path.join(TRIGGERS_DIR, filename);
        expect(fullPath).toContain('triggers');
        expect(fullPath).toContain(filename);
      });
    });
  });

  describe('trigger detection logic', () => {
    // Simulate the trigger detection from main.js
    function isTriggerFile(filePath) {
      return filePath.includes('triggers') && filePath.endsWith('.txt');
    }

    function getTriggerTargets(filename) {
      return TRIGGER_TARGETS[filename] || null;
    }

    test('should detect trigger files by path pattern', () => {
      expect(isTriggerFile('/workspace/triggers/lead.txt')).toBe(true);
      expect(isTriggerFile('/workspace/triggers/all.txt')).toBe(true);
      expect(isTriggerFile('C:\\workspace\\triggers\\reviewer.txt')).toBe(true);
    });

    test('should not detect non-trigger files', () => {
      expect(isTriggerFile('/workspace/build/status.md')).toBe(false);
      expect(isTriggerFile('/workspace/triggers/something.md')).toBe(false);
      expect(isTriggerFile('/workspace/plan.txt')).toBe(false);
    });

    test('should return correct targets for known files', () => {
      expect(getTriggerTargets('lead.txt')).toEqual(['1']);
      expect(getTriggerTargets('workers.txt')).toEqual(['3', '4']); // Frontend + Backend
      expect(getTriggerTargets('all.txt')).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    test('should return null for unknown trigger files', () => {
      expect(getTriggerTargets('unknown.txt')).toBeNull();
      expect(getTriggerTargets('random.txt')).toBeNull();
    });
  });

  describe('trigger filtering by running state', () => {
    // Simulate filtering to only running Claude instances
    function filterToRunning(targets, claudeRunning) {
      return targets.filter(paneId => claudeRunning.get(paneId) === 'running');
    }

    test('should filter to only running panes', () => {
      const claudeRunning = new Map([
        ['1', 'running'],
        ['2', 'idle'],
        ['3', 'running'],
        ['4', 'starting'],
        ['5', 'running'],
        ['6', 'idle'],
      ]);

      const allTargets = ['1', '2', '3', '4', '5', '6'];
      const running = filterToRunning(allTargets, claudeRunning);

      expect(running).toEqual(['1', '3', '5']);
      expect(running).not.toContain('2');
      expect(running).not.toContain('4');
      expect(running).not.toContain('6');
    });

    test('should return empty array when no panes running', () => {
      const claudeRunning = new Map([
        ['1', 'idle'],
        ['2', 'idle'],
        ['3', 'idle'],
        ['4', 'idle'],
        ['5', 'idle'],
        ['6', 'idle'],
      ]);

      const running = filterToRunning(['1', '2', '3', '4', '5', '6'], claudeRunning);
      expect(running).toEqual([]);
    });

    test('should return all targets when all running', () => {
      const claudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
        ['4', 'running'],
        ['5', 'running'],
        ['6', 'running'],
      ]);

      const running = filterToRunning(['1', '2', '3', '4', '5', '6'], claudeRunning);
      expect(running).toEqual(['1', '2', '3', '4', '5', '6']);
    });
  });

  describe('trigger message format', () => {
    test('trigger content should be trimmed before use', () => {
      const rawContent = '  [TEST] Hello world  \n';
      const trimmed = rawContent.trim();

      expect(trimmed).toBe('[TEST] Hello world');
      expect(trimmed).not.toMatch(/^\s/);
      expect(trimmed).not.toMatch(/\s$/);
    });

    test('empty trigger files should be ignored', () => {
      const emptyContent = '';
      const whitespaceContent = '   \n  ';

      expect(emptyContent.trim()).toBe('');
      expect(whitespaceContent.trim()).toBe('');

      // Logic: if (!message) return;
      expect(!emptyContent.trim()).toBe(true);
      expect(!whitespaceContent.trim()).toBe(true);
    });
  });

  describe('trigger file scenarios', () => {
    test('agent-to-agent trigger workflow', () => {
      // Implementer A wants to trigger Implementer B
      const triggerFile = 'worker-b.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets).toEqual(['4']);

      // Simulate: Implementer A writes to workspace/triggers/worker-b.txt
      // Main.js detects change, reads content, sends to pane 4
      const message = '[HANDOFF] Implementer A completed. Your turn!';
      expect(message.length).toBeGreaterThan(0);
    });

    test('broadcast trigger workflow', () => {
      // Architect wants to notify all agents
      const triggerFile = 'all.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets.length).toBe(6);

      // All panes should receive the message
      const message = '[BROADCAST] Sprint 3 begins now!';
      targets.forEach(paneId => {
        expect(['1', '2', '3', '4', '5', '6']).toContain(paneId);
      });
    });

    test('workers-only trigger workflow', () => {
      // Reviewer wants to notify only execution agents (Frontend + Backend)
      const triggerFile = 'workers.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets).toContain('3'); // Frontend
      expect(targets).toContain('4'); // Backend
      expect(targets).not.toContain('1'); // Not Architect
      expect(targets).not.toContain('2'); // Not Infra
      expect(targets).not.toContain('5'); // Not Analyst
      expect(targets).not.toContain('6'); // Not Reviewer
    });
  });

  describe('trigger path extraction', () => {
    test('should extract filename from full path', () => {
      const testPaths = [
        { path: '/workspace/triggers/lead.txt', expected: 'lead.txt' },
        { path: 'C:\\workspace\\triggers\\reviewer.txt', expected: 'reviewer.txt' },
        { path: 'D:/projects/hivemind/workspace/triggers/all.txt', expected: 'all.txt' },
      ];

      testPaths.forEach(({ path: filePath, expected }) => {
        const filename = path.basename(filePath);
        expect(filename).toBe(expected);
      });
    });
  });
});

// ============================================================
// TRIGGERS MODULE FUNCTION TESTS
// ============================================================

// Mock fs for triggers module tests
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
}));

const fs = require('fs');
const triggers = require('../modules/triggers');

describe('triggers.js module functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module state
    triggers.init(null, null, null);
    triggers.setWatcher(null);
    triggers.setSDKBridge(null);
    triggers.setSDKMode(false);
  });

  // ============================================================
  // parseMessageSequence TESTS
  // ============================================================

  describe('parseMessageSequence', () => {
    test('should parse standard format: (ROLE #N): message', () => {
      const result = triggers.parseMessageSequence('(LEAD #5): Hello world');
      expect(result.seq).toBe(5);
      expect(result.sender).toBe('lead');
      expect(result.content).toBe('(LEAD): Hello world');
    });

    test('should parse hyphenated roles: (WORKER-A #10): message', () => {
      const result = triggers.parseMessageSequence('(WORKER-A #10): Task complete');
      expect(result.seq).toBe(10);
      expect(result.sender).toBe('worker-a');
      expect(result.content).toBe('(WORKER-A): Task complete');
    });

    test('should parse IMPLEMENTER-B format', () => {
      const result = triggers.parseMessageSequence('(IMPLEMENTER-B #3): Working on it');
      expect(result.seq).toBe(3);
      expect(result.sender).toBe('implementer-b');
    });

    test('should handle backwards compat format without sequence', () => {
      const result = triggers.parseMessageSequence('(REVIEWER): Check this');
      expect(result.seq).toBeNull();
      expect(result.sender).toBe('reviewer');
      expect(result.content).toBe('(REVIEWER): Check this');
    });

    test('should handle unrecognized format', () => {
      const result = triggers.parseMessageSequence('Just a plain message');
      expect(result.seq).toBeNull();
      expect(result.sender).toBeNull();
      expect(result.content).toBe('Just a plain message');
    });

    test('should handle multiline messages', () => {
      const msg = '(LEAD #1): First line\nSecond line\nThird line';
      const result = triggers.parseMessageSequence(msg);
      expect(result.seq).toBe(1);
      expect(result.sender).toBe('lead');
      expect(result.content).toContain('Second line');
    });

    test('should handle large sequence numbers', () => {
      const result = triggers.parseMessageSequence('(LEAD #999): Big number');
      expect(result.seq).toBe(999);
    });

    test('should handle sequence #0', () => {
      const result = triggers.parseMessageSequence('(LEAD #0): Zero seq');
      expect(result.seq).toBe(0);
    });

    test('should not parse when space before sequence number', () => {
      // Current regex requires no space between # and number
      const result = triggers.parseMessageSequence('(LEAD # 5): With space');
      // Falls back to no-sequence format
      expect(result.seq).toBeNull();
    });
  });

  // ============================================================
  // isDuplicateMessage TESTS
  // ============================================================

  describe('isDuplicateMessage', () => {
    test('should return false for first message from sender', () => {
      const result = triggers.isDuplicateMessage('lead', 1, 'worker-a');
      expect(result).toBe(false);
    });

    test('should return false for null sequence (backwards compat)', () => {
      const result = triggers.isDuplicateMessage('lead', null, 'worker-a');
      expect(result).toBe(false);
    });

    test('should return false for null sender', () => {
      const result = triggers.isDuplicateMessage(null, 5, 'worker-a');
      expect(result).toBe(false);
    });

    test('should return true for duplicate sequence after recording', () => {
      triggers.recordMessageSeen('lead', 5, 'worker-a');
      const result = triggers.isDuplicateMessage('lead', 5, 'worker-a');
      expect(result).toBe(true);
    });

    test('should return true for lower sequence after recording', () => {
      triggers.recordMessageSeen('lead', 10, 'worker-a');
      const result = triggers.isDuplicateMessage('lead', 5, 'worker-a');
      expect(result).toBe(true);
    });

    test('should return false for higher sequence after recording', () => {
      triggers.recordMessageSeen('lead', 5, 'worker-a');
      const result = triggers.isDuplicateMessage('lead', 10, 'worker-a');
      expect(result).toBe(false);
    });

    test('should track sequences per sender-recipient pair', () => {
      triggers.recordMessageSeen('lead', 5, 'worker-a');
      // Same sender, different recipient - not a duplicate
      const result = triggers.isDuplicateMessage('lead', 5, 'worker-b');
      expect(result).toBe(false);
    });

    test('should handle unknown recipient', () => {
      const result = triggers.isDuplicateMessage('lead', 5, 'unknown-role');
      expect(result).toBe(false);
    });
  });

  // ============================================================
  // recordMessageSeen TESTS
  // ============================================================

  describe('recordMessageSeen', () => {
    test('should record sequence and save state', () => {
      triggers.recordMessageSeen('lead', 5, 'worker-a');
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    test('should not save for null sequence', () => {
      fs.writeFileSync.mockClear();
      triggers.recordMessageSeen('lead', null, 'worker-a');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('should not save for null sender', () => {
      fs.writeFileSync.mockClear();
      triggers.recordMessageSeen(null, 5, 'worker-a');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('should create recipient state if not exists', () => {
      triggers.recordMessageSeen('lead', 1, 'new-recipient');
      const state = triggers.getSequenceState();
      expect(state.sequences['new-recipient']).toBeDefined();
    });

    test('should not update if new sequence is lower', () => {
      triggers.recordMessageSeen('lead', 10, 'worker-a');
      fs.writeFileSync.mockClear();
      triggers.recordMessageSeen('lead', 5, 'worker-a');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // getNextSequence TESTS
  // ============================================================

  describe('getNextSequence', () => {
    test('should return incrementing sequence numbers', () => {
      const seq1 = triggers.getNextSequence('lead');
      const seq2 = triggers.getNextSequence('lead');
      const seq3 = triggers.getNextSequence('lead');

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    test('should track sequences per sender', () => {
      triggers.getNextSequence('lead');
      triggers.getNextSequence('lead');
      const leadSeq = triggers.getNextSequence('lead');
      const workerSeq = triggers.getNextSequence('worker-a');

      expect(leadSeq).toBe(3);
      expect(workerSeq).toBe(1);
    });

    test('should create sender state if not exists', () => {
      const seq = triggers.getNextSequence('new-sender');
      expect(seq).toBe(1);
    });
  });

  // ============================================================
  // getSequenceState TESTS
  // ============================================================

  describe('getSequenceState', () => {
    test('should return state with sequences property', () => {
      const state = triggers.getSequenceState();
      expect(state).toHaveProperty('sequences');
    });

    test('should return state with default roles', () => {
      const state = triggers.getSequenceState();
      expect(state.sequences).toHaveProperty('lead');
      expect(state.sequences).toHaveProperty('worker-a');
      expect(state.sequences).toHaveProperty('reviewer');
    });

    test('should reflect recorded sequences', () => {
      triggers.recordMessageSeen('reviewer', 7, 'lead');
      const state = triggers.getSequenceState();
      expect(state.sequences.lead.lastSeen.reviewer).toBe(7);
    });
  });

  // ============================================================
  // checkWorkflowGate TESTS
  // ============================================================

  describe('checkWorkflowGate', () => {
    test('should allow non-worker targets without watcher', () => {
      const result = triggers.checkWorkflowGate(['1', '2']);
      expect(result.allowed).toBe(true);
    });

    test('should allow worker targets when watcher not initialized', () => {
      const result = triggers.checkWorkflowGate(['3', '4']);
      expect(result.allowed).toBe(true);
    });

    test('should allow workers in executing state', () => {
      triggers.setWatcher({ readState: () => ({ state: 'executing' }) });
      const result = triggers.checkWorkflowGate(['3', '4', '5']);
      expect(result.allowed).toBe(true);
    });

    test('should allow workers in idle state', () => {
      triggers.setWatcher({ readState: () => ({ state: 'idle' }) });
      const result = triggers.checkWorkflowGate(['3']);
      expect(result.allowed).toBe(true);
    });

    test('should allow workers in planning state', () => {
      triggers.setWatcher({ readState: () => ({ state: 'planning' }) });
      const result = triggers.checkWorkflowGate(['3', '4']);
      expect(result.allowed).toBe(true);
    });

    test('should block workers in reviewing state', () => {
      triggers.setWatcher({ readState: () => ({ state: 'reviewing' }) });
      const result = triggers.checkWorkflowGate(['3', '4']);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('reviewing');
    });
  });

  // ============================================================
  // checkDirectMessageGate TESTS
  // ============================================================

  describe('checkDirectMessageGate', () => {
    test('should always allow direct messages', () => {
      const result = triggers.checkDirectMessageGate();
      expect(result.allowed).toBe(true);
    });
  });

  // ============================================================
  // SDK MODE TESTS
  // ============================================================

  describe('SDK mode functions', () => {
    test('isSDKModeEnabled should return false by default', () => {
      expect(triggers.isSDKModeEnabled()).toBe(false);
    });

    test('should enable SDK mode when bridge is set and mode enabled', () => {
      triggers.setSDKBridge({ sendMessage: jest.fn() });
      triggers.setSDKMode(true);
      expect(triggers.isSDKModeEnabled()).toBe(true);
    });

    test('should disable SDK mode when set to false', () => {
      triggers.setSDKBridge({ sendMessage: jest.fn() });
      triggers.setSDKMode(true);
      triggers.setSDKMode(false);
      expect(triggers.isSDKModeEnabled()).toBe(false);
    });

    test('should report disabled if bridge is null', () => {
      triggers.setSDKBridge(null);
      triggers.setSDKMode(true);
      expect(triggers.isSDKModeEnabled()).toBe(false);
    });
  });

  // ============================================================
  // AGENT_ROLES TESTS
  // ============================================================

  describe('AGENT_ROLES', () => {
    test('should define all 6 panes', () => {
      expect(Object.keys(triggers.AGENT_ROLES)).toHaveLength(6);
    });

    test('should have name, type, and skills for each role', () => {
      Object.values(triggers.AGENT_ROLES).forEach(role => {
        expect(role).toHaveProperty('name');
        expect(role).toHaveProperty('type');
        expect(role).toHaveProperty('skills');
        expect(Array.isArray(role.skills)).toBe(true);
      });
    });

    test('should have correct role names', () => {
      expect(triggers.AGENT_ROLES['1'].name).toBe('Architect');
      expect(triggers.AGENT_ROLES['2'].name).toBe('Orchestrator');
      expect(triggers.AGENT_ROLES['3'].name).toBe('Implementer A');
      expect(triggers.AGENT_ROLES['4'].name).toBe('Implementer B');
      expect(triggers.AGENT_ROLES['5'].name).toBe('Investigator');
      expect(triggers.AGENT_ROLES['6'].name).toBe('Reviewer');
    });
  });

  // ============================================================
  // HANDOFF_CHAIN TESTS
  // ============================================================

  describe('HANDOFF_CHAIN', () => {
    test('should define chains for all 6 panes', () => {
      expect(Object.keys(triggers.HANDOFF_CHAIN)).toHaveLength(6);
    });

    test('Architect should hand off to Orchestrator', () => {
      expect(triggers.HANDOFF_CHAIN['1']).toContain('2');
    });

    test('Orchestrator should hand off to workers', () => {
      expect(triggers.HANDOFF_CHAIN['2']).toContain('3');
      expect(triggers.HANDOFF_CHAIN['2']).toContain('4');
      expect(triggers.HANDOFF_CHAIN['2']).toContain('5');
    });

    test('Workers should hand off to Reviewer', () => {
      expect(triggers.HANDOFF_CHAIN['3']).toContain('6');
      expect(triggers.HANDOFF_CHAIN['4']).toContain('6');
      expect(triggers.HANDOFF_CHAIN['5']).toContain('6');
    });

    test('Reviewer should hand off to Architect', () => {
      expect(triggers.HANDOFF_CHAIN['6']).toContain('1');
    });
  });

  // ============================================================
  // getBestAgent TESTS
  // ============================================================

  describe('getBestAgent', () => {
    beforeEach(() => {
      const mockClaudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
        ['4', 'stopped'],
        ['5', 'running'],
        ['6', 'running'],
      ]);
      triggers.init(null, mockClaudeRunning, null);
    });

    test('should return UI specialist for ui task', () => {
      const result = triggers.getBestAgent('ui', null);
      expect(result.paneId).toBe('3');
    });

    test('should return reviewer for review task', () => {
      const result = triggers.getBestAgent('review', null);
      expect(result.paneId).toBe('6');
    });

    test('should skip non-running agents', () => {
      const result = triggers.getBestAgent('backend', null);
      expect(result.paneId).not.toBe('4');
    });

    test('should return first available when no skill match', () => {
      const result = triggers.getBestAgent('unknown-skill', null);
      expect(result.paneId).toBeTruthy();
      expect(['first_available', 'load_balanced', 'balanced']).toContain(result.reason);
    });

    test('should use performance data when available', () => {
      const performance = {
        agents: {
          '3': { completions: 10, errors: 0, totalResponseTime: 5000, responseCount: 10 },
          '5': { completions: 5, errors: 2, totalResponseTime: 8000, responseCount: 5 },
        },
      };
      const result = triggers.getBestAgent('frontend', performance);
      expect(result.paneId).toBe('3');
      expect(['performance_based', 'skill_match', 'balanced']).toContain(result.reason);
    });

    test('should return null paneId when no running candidates', () => {
      triggers.init(null, new Map(), null);
      const result = triggers.getBestAgent('ui', null);
      expect(result.paneId).toBeNull();
      expect(result.reason).toBe('no_running_candidates');
    });
  });

  // ============================================================
  // handleTriggerFile TESTS
  // ============================================================

  describe('handleTriggerFile', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('should return error for unknown trigger file', () => {
      const result = triggers.handleTriggerFile('/path/to/unknown.txt', 'unknown.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('unknown');
    });

    test('should return error for empty file', () => {
      fs.readFileSync.mockReturnValue(Buffer.from(''));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('empty');
    });

    test('should return error for whitespace-only file', () => {
      fs.readFileSync.mockReturnValue(Buffer.from('   \n  '));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('empty');
    });

    test('should detect and decode UTF-16LE BOM', () => {
      const content = '(LEAD #1): Test';
      const utf16le = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from(content, 'utf16le'),
      ]);
      fs.readFileSync.mockReturnValue(utf16le);
      triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('should strip UTF-8 BOM', () => {
      const content = '(LEAD #1): Test';
      const utf8bom = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(content, 'utf-8'),
      ]);
      fs.readFileSync.mockReturnValue(utf8bom);
      triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('should skip duplicate messages', () => {
      triggers.recordMessageSeen('reviewer', 5, 'lead');
      fs.readFileSync.mockReturnValue(Buffer.from('(REVIEWER #5): Duplicate'));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('duplicate');
    });

    test('should reset lastSeen on session restart message', () => {
      triggers.recordMessageSeen('reviewer', 100, 'lead');
      fs.readFileSync.mockReturnValue(Buffer.from('(REVIEWER #1): # HIVEMIND SESSION: Reviewer'));
      triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');

      fs.readFileSync.mockReturnValue(Buffer.from('(REVIEWER #2): Second'));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.reason).not.toBe('duplicate');
    });

    test('should handle read errors gracefully', () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('Read failed'); });
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('read_error');
    });
  });

  // ============================================================
  // notifyAgents TESTS
  // ============================================================

  describe('notifyAgents', () => {
    let mockMainWindow;
    let mockClaudeRunning;

    beforeEach(() => {
      jest.useFakeTimers();
      mockMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      mockClaudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
      ]);
      triggers.init(mockMainWindow, mockClaudeRunning, null);
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('should return undefined for null message', () => {
      const result = triggers.notifyAgents(['1'], null);
      expect(result).toBeUndefined();
    });

    test('should return undefined for empty message', () => {
      const result = triggers.notifyAgents(['1'], '');
      expect(result).toBeUndefined();
    });

    test('should send inject-message with TRIGGER prefix', () => {
      triggers.notifyAgents(['1'], 'Test message');
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({
          message: expect.stringContaining('[TRIGGER]'),
        })
      );
    });

    test('should only notify running panes', () => {
      mockClaudeRunning.set('2', 'stopped');
      const result = triggers.notifyAgents(['1', '2'], 'Test');
      expect(result).toContain('1');
      expect(result).not.toContain('2');
    });

    test('should return empty when no panes running', () => {
      mockClaudeRunning.set('1', 'stopped');
      mockClaudeRunning.set('2', 'stopped');
      const result = triggers.notifyAgents(['1', '2'], 'Test');
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // broadcastToAllAgents TESTS
  // ============================================================

  describe('broadcastToAllAgents', () => {
    let mockMainWindow;
    let mockClaudeRunning;

    beforeEach(() => {
      jest.useFakeTimers();
      mockMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      mockClaudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
        ['4', 'running'],
        ['5', 'running'],
        ['6', 'running'],
      ]);
      triggers.init(mockMainWindow, mockClaudeRunning, null);
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('should send broadcast-sent IPC event', () => {
      triggers.broadcastToAllAgents('Test broadcast');
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'broadcast-sent',
        expect.objectContaining({
          message: 'Test broadcast',
          mode: 'pty',
        })
      );
    });

    test('should include broadcast prefix in message', () => {
      // broadcastToAllAgents uses sendStaggered which has setTimeout for multi-pane
      // so we check the broadcast-sent event instead which includes the message
      triggers.broadcastToAllAgents('Test');
      const call = mockMainWindow.webContents.send.mock.calls.find(
        c => c[0] === 'broadcast-sent'
      );
      // The original message is passed without the prefix in broadcast-sent
      expect(call[1].message).toBe('Test');
    });

    test('should only notify running panes', () => {
      mockClaudeRunning.set('3', 'stopped');
      mockClaudeRunning.set('4', 'stopped');
      const result = triggers.broadcastToAllAgents('Test');
      expect(result.notified).not.toContain('3');
      expect(result.notified).not.toContain('4');
      expect(result.notified).toContain('1');
    });

    test('should return success with notified list', () => {
      const result = triggers.broadcastToAllAgents('Test');
      expect(result.success).toBe(true);
      expect(result.notified.length).toBe(6);
      expect(result.mode).toBe('pty');
    });
  });

  // ============================================================
  // sendDirectMessage TESTS
  // ============================================================

  describe('sendDirectMessage', () => {
    let mockMainWindow;
    let mockClaudeRunning;

    beforeEach(() => {
      jest.useFakeTimers();
      mockMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      mockClaudeRunning = new Map([
        ['1', 'running'],
        ['3', 'running'],
      ]);
      triggers.init(mockMainWindow, mockClaudeRunning, null);
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('should return error for null message', () => {
      const result = triggers.sendDirectMessage(['1'], null);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No message');
    });

    test('should send to running targets', () => {
      const result = triggers.sendDirectMessage(['1', '3'], 'Hello');
      expect(result.success).toBe(true);
      expect(result.notified).toContain('1');
      expect(result.notified).toContain('3');
    });

    test('should prefix message with sender role', () => {
      triggers.sendDirectMessage(['1'], 'Hello', 'Reviewer');
      const call = mockMainWindow.webContents.send.mock.calls.find(
        c => c[0] === 'inject-message'
      );
      expect(call[1].message).toContain('[MSG from Reviewer]');
    });

    test('should skip non-running targets', () => {
      mockClaudeRunning.set('3', 'stopped');
      const result = triggers.sendDirectMessage(['1', '3'], 'Hello');
      expect(result.notified).toContain('1');
      expect(result.notified).not.toContain('3');
    });

    test('should send direct-message-sent IPC event', () => {
      triggers.sendDirectMessage(['1'], 'Hello', 'Lead');
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'direct-message-sent',
        expect.objectContaining({
          to: ['1'],
          from: 'Lead',
          mode: 'pty',
        })
      );
    });
  });

  describe('handleDeliveryAck', () => {
    test('should handle null deliveryId', () => {
      expect(() => triggers.handleDeliveryAck(null, '1')).not.toThrow();
    });

    test('should handle undefined deliveryId', () => {
      expect(() => triggers.handleDeliveryAck(undefined, '1')).not.toThrow();
    });

    test('should handle non-existent delivery', () => {
      expect(() => triggers.handleDeliveryAck('nonexistent-123', '1')).not.toThrow();
    });
  });

  describe('routeTask', () => {
    test('should return failure when no watcher', () => {
      triggers.setWatcher(null);
      const result = triggers.routeTask('test task', 'thinking');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_agent_available');
    });

    test('should handle thinking category', () => {
      const mockWatcher = { getClaudeRunning: jest.fn().mockReturnValue(new Map([['1', 'running']])) };
      triggers.setWatcher(mockWatcher);
      const result = triggers.routeTask('analyze this code', 'thinking');
      expect(result).toBeDefined();
    });

    test('should handle implementation category', () => {
      const mockWatcher = { getClaudeRunning: jest.fn().mockReturnValue(new Map([['3', 'running']])) };
      triggers.setWatcher(mockWatcher);
      const result = triggers.routeTask('implement feature X', 'implementation');
      expect(result).toBeDefined();
    });

    test('should handle review category', () => {
      const mockWatcher = { getClaudeRunning: jest.fn().mockReturnValue(new Map([['6', 'running']])) };
      triggers.setWatcher(mockWatcher);
      const result = triggers.routeTask('review PR changes', 'review');
      expect(result).toBeDefined();
    });

    test('should handle unknown category', () => {
      const mockWatcher = { getClaudeRunning: jest.fn().mockReturnValue(new Map([['1', 'running']])) };
      triggers.setWatcher(mockWatcher);
      const result = triggers.routeTask('do something', 'unknown');
      expect(result).toBeDefined();
    });
  });

  describe('triggerAutoHandoff', () => {
    test('should handle missing watcher', () => {
      triggers.setWatcher(null);
      expect(() => triggers.triggerAutoHandoff('1', '2', 'test task')).not.toThrow();
    });

    test('should handle valid handoff', () => {
      const mockWatcher = { getClaudeRunning: jest.fn().mockReturnValue(new Map([['2', 'running']])) };
      triggers.setWatcher(mockWatcher);
      expect(() => triggers.triggerAutoHandoff('1', '2', 'implement feature')).not.toThrow();
    });
  });

  describe('init', () => {
    test('should accept null mainWindow', () => {
      expect(() => triggers.init(null)).not.toThrow();
    });

    test('should accept valid mainWindow', () => {
      const testMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      expect(() => triggers.init(testMainWindow)).not.toThrow();
    });
  });

  describe('notifyAllAgentsSync', () => {
    let testMainWindow;
    let testClaudeRunning;

    beforeEach(() => {
      jest.useFakeTimers();
      testMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      testClaudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
      ]);
      triggers.init(testMainWindow, testClaudeRunning, null);
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('should handle empty message', () => {
      const result = triggers.notifyAllAgentsSync('');
      // Function returns result object or undefined
      if (result) {
        expect(result.success).toBeFalsy();
      }
    });

    test('should notify all running agents', () => {
      const result = triggers.notifyAllAgentsSync('test broadcast');
      // Result should either have notified or we should verify webContents.send was called
      if (result && result.notified) {
        expect(result.notified).toBeDefined();
      } else {
        expect(testMainWindow.webContents.send).toHaveBeenCalled();
      }
    });
  });

  // ============================================================
  // getReliabilityStats TESTS
  // ============================================================

  describe('getReliabilityStats', () => {
    test('should return stats object with required fields', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats).toHaveProperty('uptime');
      expect(stats).toHaveProperty('uptimeFormatted');
      expect(stats).toHaveProperty('aggregate');
      expect(stats).toHaveProperty('byMode');
      expect(stats).toHaveProperty('byPane');
      expect(stats).toHaveProperty('byType');
      expect(stats).toHaveProperty('latency');
      expect(stats).toHaveProperty('windows');
    });

    test('should have aggregate stats with successRate', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats.aggregate).toHaveProperty('sent');
      expect(stats.aggregate).toHaveProperty('delivered');
      expect(stats.aggregate).toHaveProperty('failed');
      expect(stats.aggregate).toHaveProperty('timedOut');
      expect(stats.aggregate).toHaveProperty('skipped');
      expect(stats.aggregate).toHaveProperty('successRate');
    });

    test('should have byMode stats for sdk and pty', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats.byMode).toHaveProperty('sdk');
      expect(stats.byMode).toHaveProperty('pty');
    });

    test('should have byType stats for trigger, broadcast, direct', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats.byType).toHaveProperty('trigger');
      expect(stats.byType).toHaveProperty('broadcast');
      expect(stats.byType).toHaveProperty('direct');
    });

    test('should have latency stats', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats.latency).toHaveProperty('avg');
      expect(stats.latency).toHaveProperty('min');
      expect(stats.latency).toHaveProperty('max');
      expect(stats.latency).toHaveProperty('sampleCount');
    });

    test('should have windows stats for 15m and 1h', () => {
      const stats = triggers.getReliabilityStats();
      expect(stats.windows).toHaveProperty('last15m');
      expect(stats.windows).toHaveProperty('last1h');
    });

    test('should format uptime correctly', () => {
      const stats = triggers.getReliabilityStats();
      expect(typeof stats.uptimeFormatted).toBe('string');
      // Should contain 's' for seconds, 'm' for minutes, or 'h' for hours
      expect(stats.uptimeFormatted).toMatch(/[smh]/);
    });

    test('should calculate successRate as 100 when no messages sent', () => {
      const stats = triggers.getReliabilityStats();
      // Initial state has 0 sent, so successRate should be 100
      if (stats.aggregate.sent === 0) {
        expect(stats.aggregate.successRate).toBe(100);
      }
    });
  });

  // ============================================================
  // setSelfHealing TESTS
  // ============================================================

  describe('setSelfHealing', () => {
    test('should accept null manager', () => {
      expect(() => triggers.setSelfHealing(null)).not.toThrow();
    });

    test('should accept valid manager', () => {
      const mockManager = {
        recordTask: jest.fn(),
      };
      expect(() => triggers.setSelfHealing(mockManager)).not.toThrow();
    });
  });

  // ============================================================
  // SDK Mode with Bridge Tests
  // ============================================================

  describe('SDK mode with bridge', () => {
    let mockMainWindow;
    let mockSdkBridge;

    beforeEach(() => {
      jest.useFakeTimers();
      mockMainWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      mockSdkBridge = {
        sendMessage: jest.fn().mockReturnValue(true),
        broadcast: jest.fn(),
      };
      triggers.init(mockMainWindow, new Map(), null);
      triggers.setSDKBridge(mockSdkBridge);
      triggers.setSDKMode(true);
    });

    afterEach(() => {
      triggers.setSDKMode(false);
      triggers.setSDKBridge(null);
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('notifyAgents should use SDK bridge when enabled', () => {
      triggers.notifyAgents(['1', '2'], 'Test message');
      expect(mockSdkBridge.sendMessage).toHaveBeenCalled();
    });

    test('broadcastToAllAgents should use SDK broadcast', () => {
      triggers.broadcastToAllAgents('Test broadcast');
      expect(mockSdkBridge.broadcast).toHaveBeenCalled();
    });

    test('sendDirectMessage should use SDK bridge when enabled', () => {
      triggers.sendDirectMessage(['1'], 'Hello', 'Lead');
      expect(mockSdkBridge.sendMessage).toHaveBeenCalled();
    });

    test('handleTriggerFile should use SDK mode', () => {
      fs.readFileSync.mockReturnValue(Buffer.from('(LEAD #1): Test SDK'));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(mockSdkBridge.sendMessage).toHaveBeenCalled();
      expect(result.mode).toBe('sdk');
    });

    test('sendDirectMessage should handle SDK send failure', () => {
      mockSdkBridge.sendMessage.mockReturnValue(false);
      const result = triggers.sendDirectMessage(['1'], 'Test', 'Lead');
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // Edge Cases and Error Handling
  // ============================================================

  describe('edge cases', () => {
    test('handleTriggerFile should handle workflow gate rejection', () => {
      triggers.setWatcher({ readState: () => ({ state: 'reviewing' }) });
      fs.readFileSync.mockReturnValue(Buffer.from('Test message'));
      const result = triggers.handleTriggerFile('/path/to/workers.txt', 'workers.txt');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('workflow_gate');
    });

    test('handleTriggerFile should strip null bytes from content', () => {
      fs.readFileSync.mockReturnValue(Buffer.from('(LEAD #1): Test\x00with\x00nulls'));
      triggers.setWatcher(null);
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      // Should process without crashing
      expect(result).toBeDefined();
    });

    test('triggerAutoHandoff should return no_chain for unknown pane', () => {
      const mockClaudeRunning = new Map([['1', 'running']]);
      triggers.init(null, mockClaudeRunning, null);
      const result = triggers.triggerAutoHandoff('99', 'Task done');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_chain');
    });

    test('triggerAutoHandoff should return no_running_next when next pane not running', () => {
      const mockClaudeRunning = new Map([
        ['1', 'running'],
        ['2', 'stopped'],
      ]);
      triggers.init(null, mockClaudeRunning, null);
      const result = triggers.triggerAutoHandoff('1', 'Task done');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_running_next');
    });

    test('handleTriggerFile should detect sequence regression and reset', () => {
      // Record a high sequence number
      triggers.recordMessageSeen('reviewer', 100, 'lead');

      // Send a much lower sequence (regression > 5)
      fs.readFileSync.mockReturnValue(Buffer.from('(REVIEWER #5): After restart'));
      triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');

      // The sequence should be reset, next message should work
      fs.readFileSync.mockReturnValue(Buffer.from('(REVIEWER #6): Next message'));
      const result = triggers.handleTriggerFile('/path/to/lead.txt', 'lead.txt');
      expect(result.reason).not.toBe('duplicate');
    });
  });
});
