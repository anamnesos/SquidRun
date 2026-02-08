/**
 * Shared State Module Unit Tests
 * Tests for initialization, file change handling, diff computation,
 * changelog management, state aggregation, WebSocket broadcasts,
 * IPC events, per-pane tracking, pruning, error handling, and persistence.
 */

const path = require('path');

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  appendFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock config
jest.mock('../config', () => ({
  WORKSPACE_PATH: '/test/workspace',
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: { '1': 'Architect', '2': 'DevOps', '5': 'Analyst' },
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock websocket-server
jest.mock('../modules/websocket-server', () => ({
  broadcast: jest.fn(),
}));

const fs = require('fs');
const websocketServer = require('../modules/websocket-server');
const sharedState = require('../modules/shared-state');
const { _internals } = sharedState;

describe('Shared State Module', () => {
  let mockMainWindow;
  let mockWatcher;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset internal state
    _internals.state = { intent: {}, pipeline: {}, review: {} };
    _internals.changelog = [];
    _internals.lastSeenAt = {};
    _internals.mainWindow = null;

    mockMainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    };

    mockWatcher = {
      addWatch: jest.fn(() => true),
    };

    // Default: no files exist
    fs.existsSync.mockReturnValue(false);
  });

  // ===========================================================
  // UTILITY FUNCTIONS
  // ===========================================================

  describe('valuesEqual', () => {
    it('should return true for identical primitives', () => {
      expect(_internals.valuesEqual('a', 'a')).toBe(true);
      expect(_internals.valuesEqual(42, 42)).toBe(true);
      expect(_internals.valuesEqual(null, null)).toBe(true);
    });

    it('should return false for different primitives', () => {
      expect(_internals.valuesEqual('a', 'b')).toBe(false);
      expect(_internals.valuesEqual(1, 2)).toBe(false);
    });

    it('should compare objects by JSON.stringify', () => {
      expect(_internals.valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(_internals.valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('should compare arrays by JSON.stringify', () => {
      expect(_internals.valuesEqual([1, 2], [1, 2])).toBe(true);
      expect(_internals.valuesEqual([1, 2], [1, 3])).toBe(false);
    });

    it('should handle null vs non-null', () => {
      expect(_internals.valuesEqual(null, 'a')).toBe(false);
      expect(_internals.valuesEqual('a', null)).toBe(false);
      expect(_internals.valuesEqual(undefined, null)).toBe(true);
    });
  });

  describe('formatValue', () => {
    it('should format null/undefined as none', () => {
      expect(_internals.formatValue(null)).toBe('none');
      expect(_internals.formatValue(undefined)).toBe('none');
    });

    it('should wrap strings in quotes', () => {
      expect(_internals.formatValue('hello')).toBe("'hello'");
    });

    it('should show array length', () => {
      expect(_internals.formatValue([1, 2, 3])).toBe('3 items');
    });

    it('should stringify objects', () => {
      expect(_internals.formatValue({ a: 1 })).toBe('{"a":1}');
    });

    it('should convert numbers to string', () => {
      expect(_internals.formatValue(42)).toBe('42');
    });
  });

  // ===========================================================
  // DIFF COMPUTATION
  // ===========================================================

  describe('computeDiffs', () => {
    it('should detect changed intent fields', () => {
      const oldState = { intent: 'Working on X', blockers: 'none' };
      const newState = { intent: 'Working on Y', blockers: 'none' };
      const diffs = _internals.computeDiffs(oldState, newState, 'intent');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('intent');
      expect(diffs[0].old).toBe('Working on X');
      expect(diffs[0].new).toBe('Working on Y');
    });

    it('should detect multiple field changes', () => {
      const oldState = { intent: 'A', blockers: 'none', status: 'idle' };
      const newState = { intent: 'B', blockers: 'waiting', status: 'idle' };
      const diffs = _internals.computeDiffs(oldState, newState, 'intent');
      expect(diffs).toHaveLength(2);
      expect(diffs.map(d => d.field)).toEqual(['intent', 'blockers']);
    });

    it('should return empty array when nothing changed', () => {
      const state = { intent: 'A', blockers: 'none' };
      const diffs = _internals.computeDiffs(state, { ...state }, 'intent');
      expect(diffs).toHaveLength(0);
    });

    it('should handle null old state (new file)', () => {
      const newState = { intent: 'Starting', blockers: 'none' };
      const diffs = _internals.computeDiffs(null, newState, 'intent');
      expect(diffs.length).toBeGreaterThan(0);
    });

    it('should detect array changes (active_files)', () => {
      const oldState = { active_files: ['a.js', 'b.js'] };
      const newState = { active_files: ['a.js', 'c.js'] };
      const diffs = _internals.computeDiffs(oldState, newState, 'intent');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('active_files');
    });

    it('should diff review fields', () => {
      const oldState = { result: 'pending', change_type: 'routine' };
      const newState = { result: 'approved', change_type: 'routine' };
      const diffs = _internals.computeDiffs(oldState, newState, 'review');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('result');
    });

    it('should diff pipeline items', () => {
      const oldState = { items: [{ id: '1' }] };
      const newState = { items: [{ id: '1' }, { id: '2' }] };
      const diffs = _internals.computeDiffs(oldState, newState, 'pipeline');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('items');
    });
  });

  // ===========================================================
  // SUMMARY BUILDING
  // ===========================================================

  describe('buildSummary', () => {
    it('should build a readable summary for intent changes', () => {
      const changes = [{ field: 'intent', old: 'Investigating X', new: 'Running tests' }];
      const summary = _internals.buildSummary('Analyst', changes, 'intent');
      expect(summary).toContain('Analyst');
      expect(summary).toContain("'Investigating X'");
      expect(summary).toContain("'Running tests'");
      expect(summary).toContain('→');
    });

    it('should handle pipeline item count changes', () => {
      const changes = [{ field: 'items', old: [{ id: '1' }], new: [{ id: '1' }, { id: '2' }] }];
      const summary = _internals.buildSummary('Pipeline', changes, 'pipeline');
      expect(summary).toContain('2 active items');
      expect(summary).toContain('was 1');
    });

    it('should handle multiple changes in one summary', () => {
      const changes = [
        { field: 'intent', old: 'A', new: 'B' },
        { field: 'blockers', old: 'none', new: 'waiting' },
      ];
      const summary = _internals.buildSummary('DevOps', changes, 'intent');
      expect(summary).toContain('Intent:');
      expect(summary).toContain('Blockers:');
    });

    it('should handle no field changes', () => {
      const summary = _internals.buildSummary('Analyst', [], 'intent');
      expect(summary).toContain('updated');
    });
  });

  // ===========================================================
  // INITIALIZATION
  // ===========================================================

  describe('init', () => {
    it('should register watches for all watched files', () => {
      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(mockWatcher.addWatch).toHaveBeenCalledTimes(5); // 3 intents + pipeline + review
    });

    it('should load initial state from existing files', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (filePath.includes('intent') && filePath.includes('1')) {
          return JSON.stringify({ pane: '1', role: 'Architect', intent: 'Building' });
        }
        if (filePath.includes('intent') && filePath.includes('2')) {
          return JSON.stringify({ pane: '2', role: 'DevOps', intent: 'Deploying' });
        }
        if (filePath.includes('intent') && filePath.includes('5')) {
          return JSON.stringify({ pane: '5', role: 'Analyst', intent: 'Analyzing' });
        }
        if (filePath.includes('pipeline.json') && !filePath.includes('state-changelog')) {
          return JSON.stringify({ items: [] });
        }
        if (filePath.includes('review.json')) {
          return JSON.stringify({ result: 'pending' });
        }
        if (filePath.includes('state-changelog.json')) {
          return JSON.stringify({ version: 1, entries: [] });
        }
        return '{}';
      });

      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      const state = sharedState.getState();
      expect(state.intent['1']).toBeDefined();
      expect(state.intent['1'].intent).toBe('Building');
      expect(state.intent['2'].intent).toBe('Deploying');
    });

    it('should initialize lastSeenAt for all panes', () => {
      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(_internals.lastSeenAt).toHaveProperty('1');
      expect(_internals.lastSeenAt).toHaveProperty('2');
      expect(_internals.lastSeenAt).toHaveProperty('5');
    });

    it('should load persisted changelog on init', () => {
      const entries = [
        { ts: 1000, file: 'intent/1.json', source: 'Architect', summary: 'test', changes: [] },
      ];
      fs.existsSync.mockImplementation((p) => p.includes('state-changelog'));
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('state-changelog')) {
          return JSON.stringify({ version: 1, entries });
        }
        throw new Error('not found');
      });

      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(_internals.changelog).toHaveLength(1);
      expect(_internals.changelog[0].ts).toBe(1000);
    });

    it('should handle missing changelog file gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(_internals.changelog).toEqual([]);
    });

    it('should handle corrupted changelog file gracefully', () => {
      fs.existsSync.mockImplementation((p) => p.includes('state-changelog'));
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('state-changelog')) return 'NOT JSON';
        throw new Error('not found');
      });

      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(_internals.changelog).toEqual([]);
    });

    it('should work without watcher (graceful degradation)', () => {
      sharedState.init({ mainWindow: mockMainWindow });
      expect(_internals.initialized).toBe(true);
    });
  });

  // ===========================================================
  // FILE CHANGE HANDLING
  // ===========================================================

  describe('onFileChange', () => {
    beforeEach(() => {
      _internals.mainWindow = mockMainWindow;
    });

    it('should update state on intent file change', () => {
      _internals.state.intent['5'] = { intent: 'Old task', blockers: 'none' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New task', blockers: 'none' }));

      const config = _internals.WATCHED_FILES['intent/5.json'];
      _internals.onFileChange('intent/5.json', config);

      expect(_internals.state.intent['5'].intent).toBe('New task');
    });

    it('should record a changelog entry on change', () => {
      _internals.state.intent['1'] = { intent: 'Old', blockers: 'none' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New', blockers: 'none' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog).toHaveLength(1);
      expect(_internals.changelog[0].file).toBe('intent/1.json');
      expect(_internals.changelog[0].source).toBe('Architect');
      expect(_internals.changelog[0].summary).toContain("'Old'");
      expect(_internals.changelog[0].summary).toContain("'New'");
    });

    it('should broadcast via WebSocket on change', () => {
      _internals.state.intent['2'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/2.json'];
      _internals.onFileChange('intent/2.json', config);

      expect(websocketServer.broadcast).toHaveBeenCalledTimes(1);
      const broadcastArg = websocketServer.broadcast.mock.calls[0][0];
      const parsed = JSON.parse(broadcastArg);
      expect(parsed.type).toBe('state-update');
      expect(parsed.file).toBe('intent/2.json');
      expect(parsed.source).toBe('DevOps');
    });

    it('should emit IPC event on change', () => {
      _internals.state.review = { result: 'pending' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ result: 'approved' }));

      const config = _internals.WATCHED_FILES['review.json'];
      _internals.onFileChange('review.json', config);

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'shared-state-update',
        expect.objectContaining({
          file: 'review.json',
          source: 'Review',
        })
      );
    });

    it('should skip if file cannot be read', () => {
      fs.existsSync.mockReturnValue(false);

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog).toHaveLength(0);
      expect(websocketServer.broadcast).not.toHaveBeenCalled();
    });

    it('should skip if no actual changes detected', () => {
      _internals.state.intent['1'] = { intent: 'Same', blockers: 'none' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'Same', blockers: 'none' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog).toHaveLength(0);
      expect(websocketServer.broadcast).not.toHaveBeenCalled();
    });

    it('should handle corrupted JSON gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('NOT VALID JSON');

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog).toHaveLength(0);
    });

    it('should handle pipeline file changes', () => {
      _internals.state.pipeline = { items: [{ id: '1' }] };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ items: [{ id: '1' }, { id: '2' }] }));

      const config = _internals.WATCHED_FILES['pipeline.json'];
      _internals.onFileChange('pipeline.json', config);

      expect(_internals.changelog).toHaveLength(1);
      expect(_internals.changelog[0].summary).toContain('Pipeline');
      expect(_internals.changelog[0].summary).toContain('2 active items');
    });

    it('should handle destroyed window gracefully', () => {
      _internals.mainWindow = {
        isDestroyed: jest.fn(() => true),
        webContents: { send: jest.fn() },
      };
      _internals.state.intent['1'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      // Should still update state and changelog, just skip IPC
      expect(_internals.changelog).toHaveLength(1);
      expect(_internals.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should handle null mainWindow gracefully', () => {
      _internals.mainWindow = null;
      _internals.state.intent['1'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog).toHaveLength(1);
    });
  });

  // ===========================================================
  // STATE AGGREGATION
  // ===========================================================

  describe('getState', () => {
    it('should return full aggregated state', () => {
      _internals.state = {
        intent: { '1': { intent: 'A' }, '2': { intent: 'B' } },
        pipeline: { items: [] },
        review: { result: 'pending' },
      };

      const result = sharedState.getState();
      expect(result.intent['1'].intent).toBe('A');
      expect(result.pipeline.items).toEqual([]);
      expect(result.review.result).toBe('pending');
    });

    it('should return a copy (not the internal object)', () => {
      _internals.state = { intent: { '1': { intent: 'A' } }, pipeline: {}, review: {} };
      const result = sharedState.getState();
      result.intent['1'] = 'modified';
      expect(_internals.state.intent['1']).toEqual({ intent: 'A' });
    });
  });

  // ===========================================================
  // CHANGELOG QUERIES
  // ===========================================================

  describe('getChangesSince', () => {
    it('should return entries after the given timestamp', () => {
      _internals.changelog = [
        { ts: 1000, file: 'a', source: 'A', summary: 's1', changes: [] },
        { ts: 2000, file: 'b', source: 'B', summary: 's2', changes: [] },
        { ts: 3000, file: 'c', source: 'C', summary: 's3', changes: [] },
      ];

      const result = sharedState.getChangesSince(1500);
      expect(result).toHaveLength(2);
      expect(result[0].ts).toBe(2000);
      expect(result[1].ts).toBe(3000);
    });

    it('should return all entries for timestamp 0', () => {
      _internals.changelog = [
        { ts: 1000, file: 'a', source: 'A', summary: 's1', changes: [] },
        { ts: 2000, file: 'b', source: 'B', summary: 's2', changes: [] },
      ];

      const result = sharedState.getChangesSince(0);
      expect(result).toHaveLength(2);
    });

    it('should return empty array for future timestamp', () => {
      _internals.changelog = [
        { ts: 1000, file: 'a', source: 'A', summary: 's1', changes: [] },
      ];

      const result = sharedState.getChangesSince(Date.now() + 100000);
      expect(result).toHaveLength(0);
    });
  });

  // ===========================================================
  // PER-PANE TRACKING
  // ===========================================================

  describe('getChangelogForPane', () => {
    it('should return changes since pane lastSeenAt', () => {
      _internals.lastSeenAt = { '1': 1500, '2': 0, '5': 0 };
      _internals.changelog = [
        { ts: 1000, file: 'a', source: 'A', summary: 's1', changes: [] },
        { ts: 2000, file: 'b', source: 'B', summary: 's2', changes: [] },
        { ts: 3000, file: 'c', source: 'C', summary: 's3', changes: [] },
      ];

      const result = sharedState.getChangelogForPane('1');
      expect(result.changes).toHaveLength(2);
      expect(result.formatted).toContain('s2');
      expect(result.formatted).toContain('s3');
    });

    it('should return all changes for pane with lastSeenAt 0', () => {
      _internals.lastSeenAt = { '2': 0 };
      _internals.changelog = [
        { ts: 1000, file: 'a', source: 'A', summary: 's1', changes: [] },
        { ts: 2000, file: 'b', source: 'B', summary: 's2', changes: [] },
      ];

      const result = sharedState.getChangelogForPane('2');
      expect(result.changes).toHaveLength(2);
    });

    it('should include formatted string', () => {
      _internals.lastSeenAt = { '5': 0 };
      _internals.changelog = [
        { ts: Date.now() - 30000, file: 'a', source: 'Analyst', summary: 'Intent updated', changes: [] },
      ];

      const result = sharedState.getChangelogForPane('5');
      expect(result.formatted).toContain('What changed since your last update');
      expect(result.formatted).toContain('Intent updated');
    });
  });

  describe('markPaneSeen', () => {
    it('should update lastSeenAt for the pane', () => {
      _internals.lastSeenAt = { '1': 0 };
      const before = Date.now();
      sharedState.markPaneSeen('1');
      expect(_internals.lastSeenAt['1']).toBeGreaterThanOrEqual(before);
    });

    it('should make subsequent getChangelogForPane return empty', () => {
      _internals.lastSeenAt = { '1': 0 };
      _internals.changelog = [
        { ts: Date.now() - 5000, file: 'a', source: 'A', summary: 's1', changes: [] },
      ];

      // Before marking
      let result = sharedState.getChangelogForPane('1');
      expect(result.changes).toHaveLength(1);

      // Mark as seen
      sharedState.markPaneSeen('1');

      // After marking
      result = sharedState.getChangelogForPane('1');
      expect(result.changes).toHaveLength(0);
    });
  });

  // ===========================================================
  // FORMATTED CHANGELOG
  // ===========================================================

  describe('getFormattedChangelog', () => {
    it('should return "Nothing new" when no unseen changes', () => {
      _internals.lastSeenAt = { '1': Date.now() };
      _internals.changelog = [
        { ts: Date.now() - 60000, file: 'a', source: 'A', summary: 'old', changes: [] },
      ];

      const result = sharedState.getFormattedChangelog('1');
      expect(result).toContain('Nothing new');
    });

    it('should include time-ago and summary for each entry', () => {
      _internals.lastSeenAt = { '1': 0 };
      _internals.changelog = [
        { ts: Date.now() - 30000, file: 'a', source: 'A', summary: 'Intent changed', changes: [] },
      ];

      const result = sharedState.getFormattedChangelog('1');
      expect(result).toContain('ago');
      expect(result).toContain('Intent changed');
    });

    it('should show seconds for recent changes', () => {
      _internals.lastSeenAt = { '1': 0 };
      _internals.changelog = [
        { ts: Date.now() - 5000, file: 'a', source: 'A', summary: 'test', changes: [] },
      ];

      const result = sharedState.getFormattedChangelog('1');
      expect(result).toMatch(/\d+s ago/);
    });

    it('should show minutes for older changes', () => {
      _internals.lastSeenAt = { '1': 0 };
      _internals.changelog = [
        { ts: Date.now() - 120000, file: 'a', source: 'A', summary: 'test', changes: [] },
      ];

      const result = sharedState.getFormattedChangelog('1');
      expect(result).toMatch(/\d+m ago/);
    });
  });

  // ===========================================================
  // CHANGELOG PRUNING
  // ===========================================================

  describe('changelog pruning', () => {
    it('should prune beyond MAX_CHANGELOG_ENTRIES', () => {
      _internals.mainWindow = mockMainWindow;
      _internals.state.intent['1'] = { intent: 'Start' };

      // Simulate 105 changes
      for (let i = 0; i < 105; i++) {
        _internals.state.intent['1'] = { intent: `State ${i}` };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({ intent: `State ${i + 1}` }));

        const config = _internals.WATCHED_FILES['intent/1.json'];
        _internals.onFileChange('intent/1.json', config);
      }

      expect(_internals.changelog.length).toBeLessThanOrEqual(_internals.MAX_CHANGELOG_ENTRIES);
    });

    it('should keep the most recent entries when pruning', () => {
      _internals.mainWindow = mockMainWindow;
      _internals.changelog = [];

      // Fill with 100 entries
      for (let i = 0; i < 100; i++) {
        _internals.changelog.push({ ts: i, file: 'a', source: 'A', summary: `Entry ${i}`, changes: [] });
      }

      // Add one more via file change
      _internals.state.intent['1'] = { intent: 'Old' };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(_internals.changelog.length).toBe(100);
      // The newest entry should be present
      expect(_internals.changelog[_internals.changelog.length - 1].summary).toContain("'New'");
      // The very first entry (ts=0) should have been pruned
      expect(_internals.changelog[0].ts).not.toBe(0);
    });
  });

  // ===========================================================
  // PERSISTENCE
  // ===========================================================

  describe('persistence', () => {
    it('should write changelog atomically (tmp + rename)', () => {
      _internals.changelog = [{ ts: 1000, file: 'a', source: 'A', summary: 's', changes: [] }];
      _internals.saveChangelog();

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writePath = fs.writeFileSync.mock.calls[0][0];
      expect(writePath).toContain('.tmp');
      expect(fs.renameSync).toHaveBeenCalledTimes(1);
    });

    it('should persist changelog on file change', () => {
      _internals.mainWindow = mockMainWindow;
      _internals.state.intent['1'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      _internals.onFileChange('intent/1.json', config);

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('should handle write errors gracefully', () => {
      fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
      _internals.changelog = [{ ts: 1000, file: 'a', source: 'A', summary: 's', changes: [] }];

      // Should not throw
      expect(() => _internals.saveChangelog()).not.toThrow();
    });

    it('should load changelog entries capped at MAX_CHANGELOG_ENTRIES', () => {
      const entries = Array.from({ length: 150 }, (_, i) => ({
        ts: i, file: 'a', source: 'A', summary: `entry ${i}`, changes: [],
      }));

      fs.existsSync.mockImplementation((p) => p.includes('state-changelog'));
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('state-changelog')) {
          return JSON.stringify({ version: 1, entries });
        }
        throw new Error('not found');
      });

      _internals.loadChangelog();
      expect(_internals.changelog.length).toBeLessThanOrEqual(_internals.MAX_CHANGELOG_ENTRIES);
    });
  });

  // ===========================================================
  // ERROR HANDLING
  // ===========================================================

  describe('error handling', () => {
    it('should handle WebSocket broadcast failure gracefully', () => {
      websocketServer.broadcast.mockImplementation(() => { throw new Error('ws error'); });
      _internals.mainWindow = mockMainWindow;
      _internals.state.intent['1'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];

      // Should not throw
      expect(() => _internals.onFileChange('intent/1.json', config)).not.toThrow();
      // State should still be updated
      expect(_internals.state.intent['1'].intent).toBe('New');
    });

    it('should handle IPC send failure gracefully', () => {
      const brokenWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: {
          send: jest.fn(() => { throw new Error('ipc error'); }),
        },
      };
      _internals.mainWindow = brokenWindow;
      _internals.state.intent['1'] = { intent: 'Old' };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ intent: 'New' }));

      const config = _internals.WATCHED_FILES['intent/1.json'];
      expect(() => _internals.onFileChange('intent/1.json', config)).not.toThrow();
    });
  });

  // ===========================================================
  // WATCHED FILES CONFIG
  // ===========================================================

  describe('watched files configuration', () => {
    it('should have 5 watched files', () => {
      expect(Object.keys(_internals.WATCHED_FILES)).toHaveLength(5);
    });

    it('should include all 3 intent files', () => {
      expect(_internals.WATCHED_FILES['intent/1.json']).toBeDefined();
      expect(_internals.WATCHED_FILES['intent/2.json']).toBeDefined();
      expect(_internals.WATCHED_FILES['intent/5.json']).toBeDefined();
    });

    it('should include pipeline and review', () => {
      expect(_internals.WATCHED_FILES['pipeline.json']).toBeDefined();
      expect(_internals.WATCHED_FILES['review.json']).toBeDefined();
    });

    it('should map correct sources from PANE_ROLES', () => {
      expect(_internals.WATCHED_FILES['intent/1.json'].source()).toBe('Architect');
      expect(_internals.WATCHED_FILES['intent/2.json'].source()).toBe('DevOps');
      expect(_internals.WATCHED_FILES['intent/5.json'].source()).toBe('Analyst');
    });
  });
});
