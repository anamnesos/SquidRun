/**
 * Tests for trigger file handling
 * T5 - Worker B
 */

const path = require('path');
const { TRIGGER_TARGETS, WORKSPACE_PATH } = require('../config');

describe('Trigger System', () => {
  describe('TRIGGER_TARGETS mapping', () => {
    test('should have 10 trigger file types', () => {
      const keys = Object.keys(TRIGGER_TARGETS);
      expect(keys.length).toBe(10); // 6 original + 4 "others" triggers
    });

    test('all trigger files should end with .txt', () => {
      Object.keys(TRIGGER_TARGETS).forEach(filename => {
        expect(filename).toMatch(/\.txt$/);
      });
    });

    test('all target arrays should contain valid pane IDs', () => {
      const validPaneIds = ['1', '2', '3', '4'];

      Object.values(TRIGGER_TARGETS).forEach(targets => {
        expect(Array.isArray(targets)).toBe(true);
        targets.forEach(paneId => {
          expect(validPaneIds).toContain(paneId);
        });
      });
    });

    describe('individual trigger targets', () => {
      test('lead.txt targets only pane 1 (Lead)', () => {
        expect(TRIGGER_TARGETS['lead.txt']).toEqual(['1']);
      });

      test('worker-a.txt targets only pane 2 (Worker A)', () => {
        expect(TRIGGER_TARGETS['worker-a.txt']).toEqual(['2']);
      });

      test('worker-b.txt targets only pane 3 (Worker B)', () => {
        expect(TRIGGER_TARGETS['worker-b.txt']).toEqual(['3']);
      });

      test('reviewer.txt targets only pane 4 (Reviewer)', () => {
        expect(TRIGGER_TARGETS['reviewer.txt']).toEqual(['4']);
      });

      test('workers.txt targets panes 2 and 3 (both workers)', () => {
        expect(TRIGGER_TARGETS['workers.txt']).toEqual(['2', '3']);
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('1');
        expect(TRIGGER_TARGETS['workers.txt']).not.toContain('4');
      });

      test('all.txt targets all 4 panes', () => {
        expect(TRIGGER_TARGETS['all.txt']).toEqual(['1', '2', '3', '4']);
        expect(TRIGGER_TARGETS['all.txt'].length).toBe(4);
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
      expect(getTriggerTargets('workers.txt')).toEqual(['2', '3']);
      expect(getTriggerTargets('all.txt')).toEqual(['1', '2', '3', '4']);
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
      ]);

      const allTargets = ['1', '2', '3', '4'];
      const running = filterToRunning(allTargets, claudeRunning);

      expect(running).toEqual(['1', '3']);
      expect(running).not.toContain('2');
      expect(running).not.toContain('4');
    });

    test('should return empty array when no panes running', () => {
      const claudeRunning = new Map([
        ['1', 'idle'],
        ['2', 'idle'],
        ['3', 'idle'],
        ['4', 'idle'],
      ]);

      const running = filterToRunning(['1', '2', '3', '4'], claudeRunning);
      expect(running).toEqual([]);
    });

    test('should return all targets when all running', () => {
      const claudeRunning = new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
        ['4', 'running'],
      ]);

      const running = filterToRunning(['1', '2', '3', '4'], claudeRunning);
      expect(running).toEqual(['1', '2', '3', '4']);
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
      // Worker A wants to trigger Worker B
      const triggerFile = 'worker-b.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets).toEqual(['3']);

      // Simulate: Worker A writes to workspace/triggers/worker-b.txt
      // Main.js detects change, reads content, sends to pane 3
      const message = '[HANDOFF] Worker A completed. Your turn!';
      expect(message.length).toBeGreaterThan(0);
    });

    test('broadcast trigger workflow', () => {
      // Lead wants to notify all agents
      const triggerFile = 'all.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets.length).toBe(4);

      // All panes should receive the message
      const message = '[BROADCAST] Sprint 3 begins now!';
      targets.forEach(paneId => {
        expect(['1', '2', '3', '4']).toContain(paneId);
      });
    });

    test('workers-only trigger workflow', () => {
      // Reviewer wants to notify only workers (not lead)
      const triggerFile = 'workers.txt';
      const targets = TRIGGER_TARGETS[triggerFile];

      expect(targets).toContain('2'); // Worker A
      expect(targets).toContain('3'); // Worker B
      expect(targets).not.toContain('1'); // Not Lead
      expect(targets).not.toContain('4'); // Not Reviewer
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
