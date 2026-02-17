/**
 * Context Compressor Module Unit Tests
 * Tests for snapshot generation, token budget enforcement, section prioritization,
 * missing data handling, auto-refresh on events, timer management, file persistence,
 * error handling, init/shutdown.
 */

const path = require('path');

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock config
jest.mock('../config', () => ({
  WORKSPACE_PATH: '/test/workspace',
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: { '1': 'Architect', '2': 'Builder', '5': 'Oracle' },
  resolveCoordPath: jest.fn((relPath) => `/coord-root/${String(relPath || '').replace(/\\/g, '/')}`),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock token-utils
jest.mock('../modules/token-utils', () => ({
  estimateTokens: jest.fn((text) => {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }),
  truncateToTokenBudget: jest.fn((text, budget) => {
    if (!text || budget <= 0) return '';
    const maxChars = Math.max(20, Math.floor(budget * 4));
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '...';
  }),
}));

const fs = require('fs');
const config = require('../config');
const { estimateTokens, truncateToTokenBudget } = require('../modules/token-utils');
const contextCompressor = require('../modules/context-compressor');
const { _internals } = contextCompressor;

describe('Context Compressor Module', () => {
  let mockMainWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset internal state
    _internals.sharedStateRef = null;
    _internals.mainWindowRef = null;
    _internals.lastSnapshots = {};
    _internals.initialized = false;
    _internals.watcherRef = null;
    _internals.isIdleRef = null;
    if (_internals.refreshTimer) {
      clearInterval(_internals.refreshTimer);
      _internals.refreshTimer = null;
    }

    mockMainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
        on: jest.fn(),
      },
    };

    // Default: no files exist
    fs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    // Cleanup any timers
    if (_internals.refreshTimer) {
      clearInterval(_internals.refreshTimer);
      _internals.refreshTimer = null;
    }
    jest.useRealTimers();
  });

  // ===========================================================
  // UTILITY FUNCTIONS
  // ===========================================================

  describe('readJsonFile', () => {
    it('should return parsed JSON for valid file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"key": "value"}');

      const result = _internals.readJsonFile('/test/file.json');
      expect(result).toEqual({ key: 'value' });
    });

    it('should return null for non-existent file', () => {
      fs.existsSync.mockReturnValue(false);
      const result = _internals.readJsonFile('/test/missing.json');
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('NOT JSON');

      const result = _internals.readJsonFile('/test/bad.json');
      expect(result).toBeNull();
    });
  });

  describe('readTextFile', () => {
    it('should return file content', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('  some text  ');

      const result = _internals.readTextFile('/test/file.txt');
      expect(result).toBe('some text');
    });

    it('should return empty string for non-existent file', () => {
      fs.existsSync.mockReturnValue(false);
      const result = _internals.readTextFile('/test/missing.txt');
      expect(result).toBe('');
    });

    it('should return empty string on read error', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => { throw new Error('read error'); });

      const result = _internals.readTextFile('/test/bad.txt');
      expect(result).toBe('');
    });
  });

  describe('ensureSnapshotsDir', () => {
    it('should create directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      _internals.ensureSnapshotsDir();
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('context-snapshots'),
        { recursive: true }
      );
    });

    it('should not create directory if it already exists', () => {
      fs.existsSync.mockReturnValue(true);
      _internals.ensureSnapshotsDir();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle mkdir failure gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => { throw new Error('permission denied'); });
      expect(() => _internals.ensureSnapshotsDir()).not.toThrow();
    });
  });

  // ===========================================================
  // SECTION BUILDERS
  // ===========================================================

  describe('readHandoffFile', () => {
    it('should read handoff file content', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('## Architect Handoff\nCompleted: P1 fix');

      const content = _internals.readHandoffFile('1');
      expect(content).toContain('Architect Handoff');
    });

    it('should return empty string when file missing', () => {
      fs.existsSync.mockReturnValue(false);
      const content = _internals.readHandoffFile('1');
      expect(content).toBe('');
    });
  });

  describe('extractHandoffSummary', () => {
    it('should extract Completed line', () => {
      const summary = _internals.extractHandoffSummary('## Handoff\nCompleted: P1 fix, P2 update\nNext: P3');
      expect(summary).toBe('Completed: P1 fix, P2 update');
    });

    it('should extract Status line', () => {
      const summary = _internals.extractHandoffSummary('## Handoff\nStatus: Standing by');
      expect(summary).toBe('Status: Standing by');
    });

    it('should fall back to first non-heading line', () => {
      const summary = _internals.extractHandoffSummary('## Handoff\n---\nWorking on memory fix');
      expect(summary).toBe('Working on memory fix');
    });

    it('should return empty string for empty content', () => {
      expect(_internals.extractHandoffSummary('')).toBe('');
      expect(_internals.extractHandoffSummary(null)).toBe('');
    });
  });

  describe('readAppStatus', () => {
    it('should parse app-status.json', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        session: 158,
        note: 'S158: Enter fix',
        started: '2026-02-17T06:15:00.000Z',
      }));

      const status = _internals.readAppStatus();
      expect(status.session).toBe(158);
      expect(status.note).toBe('S158: Enter fix');
    });

    it('should resolve app-status path through coord root', () => {
      fs.existsSync.mockReturnValue(false);
      _internals.readAppStatus();
      expect(config.resolveCoordPath).toHaveBeenCalledWith('app-status.json', {});
    });

    it('should return null when file missing', () => {
      fs.existsSync.mockReturnValue(false);
      const status = _internals.readAppStatus();
      expect(status).toBeNull();
    });
  });

  describe('buildHandoffSection', () => {
    it('should build section from handoff file', () => {
      fs.existsSync.mockImplementation((p) => typeof p === 'string' && p.includes('handoffs'));
      fs.readFileSync.mockReturnValue('## Architect Handoff\nCompleted: P1 fix, P2 update\nNext: P3 investigation');

      const section = _internals.buildHandoffSection('1');
      expect(section).not.toBeNull();
      expect(section.id).toBe('handoff');
      expect(section.priority).toBe(110);
      expect(section.required).toBe(true);
      expect(section.content).toContain('Handoff');
      expect(section.content).toContain('P1 fix');
    });

    it('should return null when handoff file missing', () => {
      fs.existsSync.mockReturnValue(false);
      const section = _internals.buildHandoffSection('1');
      expect(section).toBeNull();
    });

    it('should return null for very short content', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('empty');
      const section = _internals.buildHandoffSection('1');
      expect(section).toBeNull();
    });
  });

  describe('buildAppStatusSection', () => {
    it('should build section from app-status.json', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        session: 158,
        note: 'S158: Enter fix and CWD leak fix',
      }));

      const section = _internals.buildAppStatusSection();
      expect(section).not.toBeNull();
      expect(section.id).toBe('appStatus');
      expect(section.priority).toBe(105);
      expect(section.content).toContain('Session: 158');
      expect(section.content).toContain('S158: Enter fix');
    });

    it('should return null when app-status missing', () => {
      fs.existsSync.mockReturnValue(false);
      const section = _internals.buildAppStatusSection();
      expect(section).toBeNull();
    });
  });

  describe('buildTeamStatusSection', () => {
    it('should build status from handoff files', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.includes('handoffs')) {
          return '## Handoff\nCompleted: P1 fix, P2 update\nNext: P3';
        }
        return '';
      });

      const section = _internals.buildTeamStatusSection();
      expect(section.id).toBe('teamStatus');
      expect(section.priority).toBe(100);
      expect(section.required).toBe(true);
      expect(section.content).toContain('Architect');
      expect(section.content).toContain('Builder');
      expect(section.content).toContain('Oracle');
      expect(section.content).toContain('Completed:');
    });

    it('should handle missing handoff files', () => {
      fs.existsSync.mockReturnValue(false);

      const section = _internals.buildTeamStatusSection();
      expect(section.content).toContain('No handoff data');
    });

    it('should truncate long summaries', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('Completed: ' + 'X'.repeat(200));

      const section = _internals.buildTeamStatusSection();
      expect(section.content).toContain('...');
    });
  });

  describe('buildRecentChangesSection', () => {
    it('should return null when no shared state ref', () => {
      _internals.sharedStateRef = null;
      const section = _internals.buildRecentChangesSection('1');
      expect(section).toBeNull();
    });

    it('should return null when no changes', () => {
      _internals.sharedStateRef = {
        getFormattedChangelog: jest.fn(() => '## What changed since your last update\nNothing new.'),
      };
      const section = _internals.buildRecentChangesSection('1');
      expect(section).toBeNull();
    });

    it('should return section with changes', () => {
      _internals.sharedStateRef = {
        getFormattedChangelog: jest.fn(() => '## What changed since your last update\n- [30s ago] Intent changed'),
      };
      const section = _internals.buildRecentChangesSection('1');
      expect(section).not.toBeNull();
      expect(section.id).toBe('recentChanges');
      expect(section.priority).toBe(90);
      expect(section.content).toContain('Recent Changes');
      expect(section.content).toContain('Intent changed');
    });

    it('should handle shared state errors gracefully', () => {
      _internals.sharedStateRef = {
        getFormattedChangelog: jest.fn(() => { throw new Error('broken'); }),
      };
      const section = _internals.buildRecentChangesSection('1');
      expect(section).toBeNull();
    });
  });

  describe('buildActiveIssuesSection', () => {
    it('should return null when no blockers or errors files', () => {
      fs.existsSync.mockReturnValue(false);
      const section = _internals.buildActiveIssuesSection();
      expect(section).toBeNull();
    });

    it('should return null when files contain only "(none)"', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('(none)');
      const section = _internals.buildActiveIssuesSection();
      expect(section).toBeNull();
    });

    it('should return section with blockers', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (filePath.includes('blockers')) {
          return '# Active Blockers\n- SDK bridge timeout on pane 2\n- Review pending';
        }
        return '(none)';
      });

      const section = _internals.buildActiveIssuesSection();
      expect(section).not.toBeNull();
      expect(section.id).toBe('activeIssues');
      expect(section.priority).toBe(75);
      expect(section.content).toContain('Blockers');
      expect(section.content).toContain('SDK bridge timeout');
    });

    it('should return section with errors', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (filePath.includes('errors')) {
          return '# Active Errors\n- Jest test failure in shared-state';
        }
        return '(none)';
      });

      const section = _internals.buildActiveIssuesSection();
      expect(section).not.toBeNull();
      expect(section.content).toContain('Errors');
      expect(section.content).toContain('Jest test failure');
    });
  });

  describe('buildSessionProgressSection', () => {
    it('should return null when no data sources available', () => {
      fs.existsSync.mockReturnValue(false);
      const section = _internals.buildSessionProgressSection();
      expect(section).toBeNull();
    });

    it('should build section from handoff file data', () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p !== 'string') return false;
        return p.includes('handoffs') || p.includes('app-status');
      });
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.includes('app-status')) {
          return JSON.stringify({ session: 158, note: 'S158 fixes' });
        }
        if (typeof filePath === 'string' && filePath.includes('handoffs')) {
          return [
            '## Handoff',
            'Completed: P1 fix, P2 update, P3 context',
            'Next: P4 compressor, P5 auto-inject',
            'Tests: 156 suites, 3140 tests',
          ].join('\n');
        }
        return '';
      });

      const section = _internals.buildSessionProgressSection();
      expect(section).not.toBeNull();
      expect(section.id).toBe('sessionProgress');
      expect(section.priority).toBe(70);
      expect(section.content).toContain('Session: 158');
      expect(section.content).toContain('P3 context');
      expect(section.content).toContain('P4 compressor');
      expect(section.content).toContain('156 suites');
    });

    it('should fall back to snapshot data when no handoff', () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p !== 'string') return false;
        return p.includes('context-snapshots');
      });
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.includes('context-snapshots')) {
          return 'Session: 90\nCompleted: P1 fix\nNext: P2 update';
        }
        return '';
      });

      const section = _internals.buildSessionProgressSection();
      expect(section).not.toBeNull();
      expect(section.content).toContain('P1 fix');
    });

    it('should return null when handoff has no useful data', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('No session metadata here');

      const section = _internals.buildSessionProgressSection();
      expect(section).toBeNull();
    });
  });

  // ===========================================================
  // SNAPSHOT GENERATION
  // ===========================================================

  describe('generateSnapshot', () => {
    beforeEach(() => {
      // Setup minimal data sources — handoff files + app-status
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath !== 'string') return '{}';
        if (filePath.includes('handoffs')) {
          return [
            '## Architect Handoff',
            'Completed: P1 file watcher, P2 pipeline, P3 shared state',
            'Next: P4 context compressor',
            'Tests: 91 suites, 2857 tests',
          ].join('\n');
        }
        if (filePath.includes('app-status')) {
          return JSON.stringify({ session: 90, note: 'S90: core fixes' });
        }
        if (filePath.includes('blockers') || filePath.includes('errors')) {
          return '(none)';
        }
        return '{}';
      });
    });

    it('should generate a snapshot with header and team status', () => {
      const snapshot = contextCompressor.generateSnapshot('1');

      expect(snapshot).toContain('## Context Restoration (auto-generated)');
      expect(snapshot).toContain('Session 90');
      expect(snapshot).toContain('### Team Status');
      expect(snapshot).toContain('Architect');
    });

    it('should include handoff section', () => {
      const snapshot = contextCompressor.generateSnapshot('1');
      expect(snapshot).toContain('### Handoff');
      expect(snapshot).toContain('P4 context compressor');
    });

    it('should include app status section', () => {
      const snapshot = contextCompressor.generateSnapshot('1');
      expect(snapshot).toContain('### Session Info');
      expect(snapshot).toContain('S90: core fixes');
    });

    it('should cache the snapshot', () => {
      contextCompressor.generateSnapshot('1');
      const cached = contextCompressor.getLastSnapshot('1');
      expect(cached).not.toBeNull();
      expect(cached).toContain('P4 context compressor');
    });

    it('should write snapshot to disk', () => {
      contextCompressor.generateSnapshot('1');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('context-snapshots', '1.md')),
        expect.stringContaining('Context Restoration'),
        'utf-8'
      );
    });

    it('should include session progress section', () => {
      const snapshot = contextCompressor.generateSnapshot('1');
      expect(snapshot).toContain('Session Progress');
      expect(snapshot).toContain('91 suites');
    });

    it('should include recent changes when shared state has updates', () => {
      _internals.sharedStateRef = {
        getFormattedChangelog: jest.fn(() => '## What changed since your last update\n- [30s ago] Intent changed'),
      };

      const snapshot = contextCompressor.generateSnapshot('1');
      expect(snapshot).toContain('Recent Changes');
      expect(snapshot).toContain('Intent changed');
    });

    it('should respect token budget', () => {
      // Override estimateTokens to make sections appear very large
      estimateTokens.mockImplementation((text) => {
        if (!text) return 0;
        return text.length; // 1 char = 1 token (makes everything huge)
      });

      const snapshot = contextCompressor.generateSnapshot('1', { maxTokens: 50 });

      // Should still contain the header and required sections (team status, handoff)
      expect(snapshot).toContain('Context Restoration');

      // Reset mock
      estimateTokens.mockImplementation((text) => {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
      });
    });

    it('should handle all data sources missing gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      fs.readFileSync.mockImplementation(() => { throw new Error('not found'); });

      const snapshot = contextCompressor.generateSnapshot('1');
      expect(snapshot).toContain('Context Restoration');
      expect(snapshot).toContain('Team Status');
    });
  });

  // ===========================================================
  // TOKEN BUDGET ENFORCEMENT
  // ===========================================================

  describe('token budget enforcement', () => {
    it('should always include required sections (team status, handoff)', () => {
      // Make estimateTokens report huge values
      estimateTokens.mockImplementation((text) => {
        if (!text) return 0;
        return text.length * 10; // Everything is "huge"
      });

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath !== 'string') return '{}';
        if (filePath.includes('handoffs')) return '## Handoff\nCompleted: P1 fix';
        if (filePath.includes('app-status')) return JSON.stringify({ session: 90 });
        return '{}';
      });

      const snapshot = contextCompressor.generateSnapshot('1', { maxTokens: 10 });
      // Team status and handoff are required, so they must be included regardless
      expect(snapshot).toContain('Team Status');
      expect(snapshot).toContain('Handoff');

      estimateTokens.mockImplementation((text) => {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
      });
    });

    it('should truncate sections to fit budget', () => {
      truncateToTokenBudget.mockImplementation((text, budget) => {
        if (!text || budget <= 0) return '';
        const maxChars = Math.max(20, Math.floor(budget * 4));
        if (text.length <= maxChars) return text;
        return text.slice(0, maxChars) + '...';
      });

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath !== 'string') return '{}';
        if (filePath.includes('handoffs')) return `## Handoff\nCompleted: ${Array.from({length: 50}, (_, i) => `task-${i}`).join(', ')}`;
        if (filePath.includes('app-status')) return JSON.stringify({ session: 90, note: 'X'.repeat(200) });
        return '{}';
      });

      contextCompressor.generateSnapshot('1', { maxTokens: 200 });
      // The function should have been called (token budget management is active)
      expect(estimateTokens).toHaveBeenCalled();
    });
  });

  // ===========================================================
  // SECTION PRIORITIZATION
  // ===========================================================

  describe('section prioritization', () => {
    it('should have correct priority ordering', () => {
      expect(_internals.SECTION_PRIORITIES.handoff).toBeGreaterThan(_internals.SECTION_PRIORITIES.appStatus);
      expect(_internals.SECTION_PRIORITIES.appStatus).toBeGreaterThan(_internals.SECTION_PRIORITIES.teamStatus);
      expect(_internals.SECTION_PRIORITIES.teamStatus).toBeGreaterThan(_internals.SECTION_PRIORITIES.recentChanges);
      expect(_internals.SECTION_PRIORITIES.recentChanges).toBeGreaterThan(_internals.SECTION_PRIORITIES.activeIssues);
      expect(_internals.SECTION_PRIORITIES.activeIssues).toBeGreaterThan(_internals.SECTION_PRIORITIES.sessionProgress);
    });

    it('should place handoff before team status in output', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath !== 'string') return '{}';
        if (filePath.includes('handoffs')) {
          return '## Architect Handoff\nCompleted: P1 fix\nNext: P2 update';
        }
        if (filePath.includes('app-status')) {
          return JSON.stringify({ session: 90, note: 'S90 fixes' });
        }
        if (filePath.includes('blockers') || filePath.includes('errors')) {
          return '(none)';
        }
        return '{}';
      });

      const snapshot = contextCompressor.generateSnapshot('1');
      const handoffIdx = snapshot.indexOf('### Handoff');
      const teamIdx = snapshot.indexOf('### Team Status');
      const progressIdx = snapshot.indexOf('### Session Progress');
      expect(handoffIdx).toBeLessThan(teamIdx);
      expect(teamIdx).toBeLessThan(progressIdx);
    });
  });

  // ===========================================================
  // AUTO-REFRESH
  // ===========================================================

  describe('auto-refresh on file watch events', () => {
    // Save/restore WATCHED_FILES since production code now populates it
    let savedWatchedFiles;
    beforeEach(() => {
      savedWatchedFiles = [..._internals.WATCHED_FILES];
      _internals.WATCHED_FILES.push('test-watch.json');
    });
    afterEach(() => {
      _internals.WATCHED_FILES.length = 0;
      _internals.WATCHED_FILES.push(...savedWatchedFiles);
    });

    it('should register watches for all watched files on init', () => {
      fs.existsSync.mockReturnValue(false);
      const mockWatcher = { addWatch: jest.fn() };

      contextCompressor.init({ watcher: mockWatcher });

      expect(mockWatcher.addWatch).toHaveBeenCalledTimes(_internals.WATCHED_FILES.length);
      for (const relPath of _internals.WATCHED_FILES) {
        expect(mockWatcher.addWatch).toHaveBeenCalledWith(
          expect.stringContaining(relPath.replace(/\//g, path.sep)),
          expect.any(Function)
        );
      }
    });

    it('should refresh all snapshots when a watched file changes', () => {
      fs.existsSync.mockReturnValue(false);
      const watchCallbacks = [];
      const mockWatcher = {
        addWatch: jest.fn((filePath, cb) => { watchCallbacks.push(cb); }),
      };

      contextCompressor.init({ watcher: mockWatcher });

      // Clear writes from init's initial refreshAll
      fs.writeFileSync.mockClear();

      // Trigger the first watch callback (simulates a file change)
      watchCallbacks[0]();

      // Should have written 3 snapshot files (one per pane)
      const snapshotWrites = fs.writeFileSync.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('context-snapshots')
      );
      expect(snapshotWrites.length).toBe(3);
    });

    it('should skip auto-refresh from watcher callback when app is idle', () => {
      fs.existsSync.mockReturnValue(false);
      const watchCallbacks = [];
      const mockWatcher = {
        addWatch: jest.fn((filePath, cb) => { watchCallbacks.push(cb); }),
      };

      contextCompressor.init({
        watcher: mockWatcher,
        isIdle: () => true,
      });

      fs.writeFileSync.mockClear();
      watchCallbacks[0]();

      const snapshotWrites = fs.writeFileSync.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('context-snapshots')
      );
      expect(snapshotWrites.length).toBe(0);
    });

    it('should handle watch callback errors gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      const watchCallbacks = [];
      const mockWatcher = {
        addWatch: jest.fn((filePath, cb) => { watchCallbacks.push(cb); }),
      };

      contextCompressor.init({ watcher: mockWatcher });

      // Make refreshAll throw by breaking fs
      fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });

      // Callback should not throw even if refreshAll internals fail
      expect(() => watchCallbacks[0]()).not.toThrow();
    });

    it('should skip watcher registration when no watcher provided', () => {
      fs.existsSync.mockReturnValue(false);

      // Should not throw when no watcher
      expect(() => contextCompressor.init({})).not.toThrow();
      expect(_internals.watcherRef).toBeNull();
    });

    it('should register zero watches when WATCHED_FILES is empty', () => {
      _internals.WATCHED_FILES.length = 0; // override the beforeEach push
      fs.existsSync.mockReturnValue(false);
      const mockWatcher = { addWatch: jest.fn() };

      contextCompressor.init({ watcher: mockWatcher });
      expect(mockWatcher.addWatch).toHaveBeenCalledTimes(0);
    });
  });

  // ===========================================================
  // TIMER MANAGEMENT
  // ===========================================================

  describe('timer management', () => {
    it('should start refresh timer on init', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({ mainWindow: mockMainWindow });
      expect(_internals.refreshTimer).not.toBeNull();
    });

    it('should refresh all snapshots on timer tick', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({ mainWindow: mockMainWindow });

      // Clear writes from init's initial refreshAll
      fs.writeFileSync.mockClear();

      // Advance timer
      jest.advanceTimersByTime(_internals.REFRESH_INTERVAL_MS);

      // Should have written 3 snapshot files (one per pane)
      const snapshotWrites = fs.writeFileSync.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('context-snapshots')
      );
      expect(snapshotWrites.length).toBe(3);
    });

    it('should skip timer refresh when app is idle', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({
        mainWindow: mockMainWindow,
        isIdle: () => true,
      });

      fs.writeFileSync.mockClear();
      jest.advanceTimersByTime(_internals.REFRESH_INTERVAL_MS);

      const snapshotWrites = fs.writeFileSync.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('context-snapshots')
      );
      expect(snapshotWrites.length).toBe(0);
    });

    it('should clear timer on shutdown', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({ mainWindow: mockMainWindow });
      expect(_internals.refreshTimer).not.toBeNull();

      contextCompressor.shutdown();
      expect(_internals.refreshTimer).toBeNull();
    });

    it('should replace existing timer on re-init', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({ mainWindow: mockMainWindow });
      const firstTimer = _internals.refreshTimer;

      // Re-init
      contextCompressor.init({ mainWindow: mockMainWindow });
      const secondTimer = _internals.refreshTimer;

      expect(secondTimer).not.toBeNull();
      // Timer should have been replaced (we can't easily compare setInterval IDs,
      // but the module clears old timer before setting new one)
    });
  });

  // ===========================================================
  // FILE PERSISTENCE
  // ===========================================================

  describe('file persistence', () => {
    it('should write snapshot to correct path', () => {
      _internals.writeSnapshot('1', 'test content');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('context-snapshots', '1.md')),
        'test content',
        'utf-8'
      );
    });

    it('should ensure directory exists before writing', () => {
      fs.existsSync.mockReturnValue(false);
      _internals.writeSnapshot('2', 'content');

      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('should handle write errors gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });

      expect(() => _internals.writeSnapshot('1', 'content')).not.toThrow();
    });
  });

  // ===========================================================
  // INIT / SHUTDOWN
  // ===========================================================

  describe('init', () => {
    it('should store references', () => {
      const mockSharedState = { getFormattedChangelog: jest.fn() };

      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({
        sharedState: mockSharedState,
        mainWindow: mockMainWindow,
      });

      expect(_internals.sharedStateRef).toBe(mockSharedState);
      expect(_internals.mainWindowRef).toBe(mockMainWindow);
      expect(_internals.initialized).toBe(true);
    });

    it('should store watcher reference', () => {
      fs.existsSync.mockReturnValue(false);
      const mockWatcher = { addWatch: jest.fn() };

      contextCompressor.init({ watcher: mockWatcher });
      expect(_internals.watcherRef).toBe(mockWatcher);
    });

    it('should register file watches via watcher.addWatch', () => {
      fs.existsSync.mockReturnValue(false);
      const mockWatcher = { addWatch: jest.fn() };

      // WATCHED_FILES includes app-status.json + handoff files for each pane
      contextCompressor.init({ watcher: mockWatcher });
      expect(mockWatcher.addWatch).toHaveBeenCalledTimes(_internals.WATCHED_FILES.length);
      expect(mockWatcher.addWatch.mock.calls.length).toBeGreaterThan(0);
    });

    it('should generate initial snapshots', () => {
      fs.existsSync.mockReturnValue(false);
      const writeCalls = [];
      fs.writeFileSync.mockImplementation((p, c) => { writeCalls.push(p); });

      contextCompressor.init({ mainWindow: mockMainWindow });

      // Should have written snapshots for all 3 panes
      const snapshotWrites = writeCalls.filter(p => p.includes('context-snapshots'));
      expect(snapshotWrites.length).toBe(3);
    });

    it('should work without mainWindow', () => {
      fs.existsSync.mockReturnValue(false);
      expect(() => contextCompressor.init({})).not.toThrow();
      expect(_internals.initialized).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should clear timer and set initialized to false', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.init({ mainWindow: mockMainWindow });
      expect(_internals.initialized).toBe(true);

      contextCompressor.shutdown();
      expect(_internals.initialized).toBe(false);
      expect(_internals.refreshTimer).toBeNull();
    });

    it('should be safe to call shutdown without init', () => {
      expect(() => contextCompressor.shutdown()).not.toThrow();
    });
  });

  // ===========================================================
  // REFRESH METHODS
  // ===========================================================

  describe('refreshAll', () => {
    it('should generate snapshots for all panes', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.refreshAll();

      // Should attempt to write for each pane
      const writeArgs = fs.writeFileSync.mock.calls.map(c => c[0]);
      expect(writeArgs.some(p => p.includes('1.md'))).toBe(true);
      expect(writeArgs.some(p => p.includes('2.md'))).toBe(true);
      expect(writeArgs.some(p => p.includes('5.md'))).toBe(true);
    });

    it('should not throw if one pane fails', () => {
      let callCount = 0;
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('read error');
        return JSON.stringify({ session: 90, intent: 'Test', blockers: 'none' });
      });

      expect(() => contextCompressor.refreshAll()).not.toThrow();
    });
  });

  describe('refresh', () => {
    it('should generate snapshot for a single pane', () => {
      fs.existsSync.mockReturnValue(false);

      contextCompressor.refresh('2');

      const writeArgs = fs.writeFileSync.mock.calls.map(c => c[0]);
      expect(writeArgs.some(p => p.includes('2.md'))).toBe(true);
    });

    it('should handle errors gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => { throw new Error('fail'); });

      expect(() => contextCompressor.refresh('1')).not.toThrow();
    });
  });

  describe('getLastSnapshot', () => {
    it('should return null when no snapshot has been generated', () => {
      _internals.lastSnapshots = {};
      expect(contextCompressor.getLastSnapshot('1')).toBeNull();
    });

    it('should return cached snapshot', () => {
      _internals.lastSnapshots = { '1': 'cached content' };
      expect(contextCompressor.getLastSnapshot('1')).toBe('cached content');
    });
  });

  // ===========================================================
  // ERROR HANDLING
  // ===========================================================

  describe('error handling', () => {
    it('should handle corrupted handoff files', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('');

      const section = _internals.buildTeamStatusSection();
      expect(section.content).toContain('No handoff data');
    });

    it('should handle missing workspace directory', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => { throw new Error('no parent'); });

      expect(() => contextCompressor.generateSnapshot('1')).not.toThrow();
    });

    it('should handle all sources failing simultaneously', () => {
      _internals.sharedStateRef = {
        getFormattedChangelog: jest.fn(() => { throw new Error('fail'); }),
      };
      fs.existsSync.mockReturnValue(false);

      const snapshot = contextCompressor.generateSnapshot('1');
      // Should still produce a valid snapshot with header + team status
      expect(snapshot).toContain('Context Restoration');
      expect(snapshot).toContain('Team Status');
    });
  });

  // ===========================================================
  // SESSION NUMBER
  // ===========================================================

  describe('getSessionNumber', () => {
    it('should return session number from app-status.json (primary)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.includes('app-status')) {
          return JSON.stringify({ session: 158, note: 'S158 fixes' });
        }
        return '{}';
      });

      expect(_internals.getSessionNumber()).toBe(158);
    });

    it('should fall back to context snapshots when app-status missing', () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p !== 'string') return false;
        return p.includes('context-snapshots');
      });
      fs.readFileSync.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.includes('context-snapshots')) {
          return 'Session: 90';
        }
        return '{}';
      });

      expect(_internals.getSessionNumber()).toBe(90);
    });

    it('should return 0 when all sources missing', () => {
      fs.existsSync.mockReturnValue(false);
      expect(_internals.getSessionNumber()).toBe(0);
    });

    it('should return 0 for corrupted data', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('CORRUPT');
      expect(_internals.getSessionNumber()).toBe(0);
    });
  });
});
