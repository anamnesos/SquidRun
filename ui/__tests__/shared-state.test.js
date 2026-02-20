/**
 * Shared State Module Unit Tests
 */

const path = require('path');

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../config', () => ({
  WORKSPACE_PATH: '/test/workspace',
  PANE_IDS: ['1', '2', '3'],
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

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

    fs.existsSync.mockReturnValue(false);
  });

  describe('utility helpers', () => {
    it('valuesEqual compares primitives and objects', () => {
      expect(_internals.valuesEqual('a', 'a')).toBe(true);
      expect(_internals.valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(_internals.valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('computeDiffs tracks pipeline item changes', () => {
      const oldState = { items: [{ id: '1' }] };
      const newState = { items: [{ id: '1' }, { id: '2' }] };
      const diffs = _internals.computeDiffs(oldState, newState, 'pipeline');
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe('items');
    });

    it('buildSummary formats pipeline count changes', () => {
      const summary = _internals.buildSummary('Pipeline', [
        { field: 'items', old: [{ id: '1' }], new: [{ id: '1' }, { id: '2' }] },
      ], 'pipeline');
      expect(summary).toContain('Pipeline');
      expect(summary).toContain('2 active items');
    });
  });

  describe('init', () => {
    it('registers watches for pipeline + review', () => {
      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      expect(mockWatcher.addWatch).toHaveBeenCalledTimes(2);
      expect(mockWatcher.addWatch).toHaveBeenCalledWith(
        expect.stringContaining(path.join('pipeline.json')),
        expect.any(Function)
      );
      expect(mockWatcher.addWatch).toHaveBeenCalledWith(
        expect.stringContaining(path.join('review.json')),
        expect.any(Function)
      );
    });

    it('loads pipeline/review state from existing files', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('pipeline.json')) {
          return JSON.stringify({ items: [{ id: '1' }] });
        }
        if (String(filePath).includes('review.json')) {
          return JSON.stringify({ result: 'pending' });
        }
        if (String(filePath).includes('state-changelog.json')) {
          return JSON.stringify({ version: 1, entries: [] });
        }
        return '{}';
      });

      sharedState.init({ watcher: mockWatcher, mainWindow: mockMainWindow });
      const state = sharedState.getState();
      expect(state.pipeline.items).toHaveLength(1);
      expect(state.review.result).toBe('pending');
    });
  });

  describe('onFileChange', () => {
    beforeEach(() => {
      _internals.mainWindow = mockMainWindow;
    });

    it('updates state, changelog, websocket, and ipc for pipeline changes', () => {
      _internals.state.pipeline = { items: [{ id: '1' }] };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ items: [{ id: '1' }, { id: '2' }] }));

      const config = _internals.WATCHED_FILES['pipeline.json'];
      _internals.onFileChange('pipeline.json', config);

      expect(_internals.state.pipeline.items).toHaveLength(2);
      expect(_internals.changelog).toHaveLength(1);
      expect(websocketServer.broadcast).toHaveBeenCalledTimes(1);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'shared-state-update',
        expect.objectContaining({ file: 'pipeline.json', source: 'Pipeline' })
      );
    });

    it('skips update when file is missing or unchanged', () => {
      const config = _internals.WATCHED_FILES['review.json'];

      fs.existsSync.mockReturnValue(false);
      _internals.onFileChange('review.json', config);
      expect(_internals.changelog).toHaveLength(0);

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ result: 'approved' }));
      _internals.state.review = { result: 'approved' };
      _internals.onFileChange('review.json', config);
      expect(_internals.changelog).toHaveLength(0);
    });
  });

  describe('state + changelog APIs', () => {
    it('getState returns a copy', () => {
      _internals.state = {
        intent: {},
        pipeline: { items: [] },
        review: { result: 'pending' },
      };
      const snapshot = sharedState.getState();
      snapshot.pipeline.items = ['mutated'];
      expect(_internals.state.pipeline.items).toEqual([]);
    });

    it('tracks per-pane changelog visibility', () => {
      const now = Date.now();
      _internals.lastSeenAt = { '1': now - 1000 };
      _internals.changelog = [
        { ts: now - 5000, file: 'a', source: 'A', summary: 'old', changes: [] },
        { ts: now - 100, file: 'b', source: 'B', summary: 'new', changes: [] },
      ];

      const result = sharedState.getChangelogForPane('1');
      expect(result.changes).toHaveLength(1);
      expect(result.formatted).toContain('new');
    });
  });

  describe('watched files config', () => {
    it('only watches pipeline and review files', () => {
      expect(Object.keys(_internals.WATCHED_FILES)).toEqual(['pipeline.json', 'review.json']);
      expect(_internals.WATCHED_FILES['pipeline.json']).toBeDefined();
      expect(_internals.WATCHED_FILES['review.json']).toBeDefined();
    });
  });
});
