/**
 * Pipeline Module Unit Tests
 * Tests for detection patterns, stage transitions, auto-notifications,
 * persistence, and edge cases.
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

// Mock crypto
jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({ toString: () => 'abc123' })),
}));

// Mock config
jest.mock('../config', () => ({
  WORKSPACE_PATH: '/test/workspace',
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: { '1': 'Architect', '2': 'Builder', '5': 'Oracle' },
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const pipeline = require('../modules/pipeline');

describe('Pipeline Module', () => {
  let mockMainWindow;
  let mockSendDirectMessage;

  beforeEach(() => {
    jest.clearAllMocks();

    mockMainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    };

    mockSendDirectMessage = jest.fn();

    // Default: no existing pipeline file
    fs.existsSync.mockReturnValue(false);

    pipeline.init({
      mainWindow: mockMainWindow,
      sendDirectMessage: mockSendDirectMessage,
    });
  });

  describe('detectStage', () => {
    test('detects [PROPOSAL] structured tag', () => {
      const result = pipeline.detectStage({ msg: '[PROPOSAL] We should fix the tooltip', from: 'ORACLE' });
      expect(result).toEqual({ stage: 'proposed', method: 'structured' });
    });

    test('detects [ACCEPT] structured tag', () => {
      const result = pipeline.detectStage({ msg: '[ACCEPT] Go ahead with that', from: 'ARCH' });
      expect(result).toEqual({ stage: 'accepted', method: 'structured' });
    });

    test('detects [DONE] structured tag as review_pending', () => {
      const result = pipeline.detectStage({ msg: '[DONE] Tooltip fix complete', from: 'BUILDER' });
      expect(result).toEqual({ stage: 'review_pending', method: 'structured' });
    });

    test('detects [REVIEW] structured tag as review_pending', () => {
      const result = pipeline.detectStage({ msg: '[REVIEW] Please check my changes', from: 'ORACLE' });
      expect(result).toEqual({ stage: 'review_pending', method: 'structured' });
    });

    test('detects [APPROVED] structured tag', () => {
      const result = pipeline.detectStage({ msg: '[APPROVED] Looks good, ship it', from: 'ARCH' });
      expect(result).toEqual({ stage: 'approved', method: 'structured' });
    });

    test('detects [ASSIGNED] structured tag', () => {
      const result = pipeline.detectStage({ msg: '[ASSIGNED] Builder will handle this', from: 'ARCH' });
      expect(result).toEqual({ stage: 'assigned', method: 'structured' });
    });

    test('structured tags are case-insensitive', () => {
      const result = pipeline.detectStage({ msg: '[proposal] small idea here', from: 'ORACLE' });
      expect(result).toEqual({ stage: 'proposed', method: 'structured' });
    });

    test('structured tags win over keywords', () => {
      // Message has [PROPOSAL] tag but also "done" keyword
      const result = pipeline.detectStage({ msg: '[PROPOSAL] I am done thinking, we should refactor', from: 'ORACLE' });
      expect(result).toEqual({ stage: 'proposed', method: 'structured' });
    });

    test('keyword fallback detects "we should"', () => {
      const result = pipeline.detectStage({ msg: 'I think we should refactor the triggers module', from: 'ORACLE' });
      expect(result).toEqual({ stage: 'proposed', method: 'keyword' });
    });

    test('keyword fallback detects "sounds good"', () => {
      const result = pipeline.detectStage({ msg: 'That sounds good to me, lets proceed with it', from: 'ARCH' });
      expect(result).toEqual({ stage: 'accepted', method: 'keyword' });
    });

    test('keyword fallback detects "working on"', () => {
      const result = pipeline.detectStage({ msg: 'I am working on the tooltip fix now', from: 'BUILDER' });
      expect(result).toEqual({ stage: 'implementing', method: 'keyword' });
    });

    test('keyword fallback detects "ready for review"', () => {
      const result = pipeline.detectStage({ msg: 'Changes are ready for review, please check', from: 'BUILDER' });
      expect(result).toEqual({ stage: 'review_pending', method: 'keyword' });
    });

    test('ignores system messages for keyword detection', () => {
      const result = pipeline.detectStage({ msg: 'We should restart the system now please', from: 'SYSTEM' });
      expect(result).toBeNull();
    });

    test('ignores short messages for keyword detection', () => {
      const result = pipeline.detectStage({ msg: 'let me', from: 'ORACLE' });
      expect(result).toBeNull();
    });

    test('returns null for unrecognized messages', () => {
      const result = pipeline.detectStage({ msg: 'Just checking in on the current status of things', from: 'ORACLE' });
      expect(result).toBeNull();
    });

    test('returns null for null/empty entry', () => {
      expect(pipeline.detectStage(null)).toBeNull();
      expect(pipeline.detectStage({})).toBeNull();
      expect(pipeline.detectStage({ msg: '' })).toBeNull();
    });
  });

  describe('isValidTransition', () => {
    test('allows forward transitions', () => {
      expect(pipeline.isValidTransition('proposed', 'accepted')).toBe(true);
      expect(pipeline.isValidTransition('proposed', 'assigned')).toBe(true);
      expect(pipeline.isValidTransition('implementing', 'review_pending')).toBe(true);
      expect(pipeline.isValidTransition('review_pending', 'approved')).toBe(true);
      expect(pipeline.isValidTransition('approved', 'committed')).toBe(true);
    });

    test('rejects backward transitions', () => {
      expect(pipeline.isValidTransition('accepted', 'proposed')).toBe(false);
      expect(pipeline.isValidTransition('committed', 'proposed')).toBe(false);
      expect(pipeline.isValidTransition('approved', 'implementing')).toBe(false);
    });

    test('rejects same-stage transitions', () => {
      expect(pipeline.isValidTransition('proposed', 'proposed')).toBe(false);
      expect(pipeline.isValidTransition('committed', 'committed')).toBe(false);
    });

    test('rejects invalid stage names', () => {
      expect(pipeline.isValidTransition('proposed', 'invalid')).toBe(false);
      expect(pipeline.isValidTransition('invalid', 'proposed')).toBe(false);
    });
  });

  describe('extractTitle', () => {
    test('extracts title from proposal message', () => {
      const title = pipeline.extractTitle('[PROPOSAL] Fix the tooltip alignment issue');
      expect(title).toBe('Fix the tooltip alignment issue');
    });

    test('strips role prefix', () => {
      const title = pipeline.extractTitle('(ARCH): We should fix the CSS layout');
      expect(title).toBe('We should fix the CSS layout');
    });

    test('truncates long titles', () => {
      const longMsg = 'A'.repeat(100);
      const title = pipeline.extractTitle(longMsg);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title).toContain('...');
    });

    test('returns Untitled for empty input', () => {
      expect(pipeline.extractTitle('')).toBe('Untitled');
      expect(pipeline.extractTitle(null)).toBe('Untitled');
    });
  });

  describe('onMessage - pipeline item creation', () => {
    test('creates pipeline item on [PROPOSAL] tag', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Fix tooltip alignment',
        type: 'broadcast',
      });

      const items = pipeline.getItems();
      expect(items.length).toBe(1);
      expect(items[0].stage).toBe('proposed');
      expect(items[0].proposedBy).toBe('ORACLE');
      expect(items[0].title).toBe('Fix tooltip alignment');
    });

    test('creates pipeline item on keyword proposal', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: 'I think we should refactor the triggers module for better clarity',
        type: 'broadcast',
      });

      const items = pipeline.getItems();
      expect(items.length).toBe(1);
      expect(items[0].stage).toBe('proposed');
    });

    test('emits pipeline-update IPC on creation', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] New feature idea',
        type: 'broadcast',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'pipeline-update',
        expect.objectContaining({
          item: expect.objectContaining({ stage: 'proposed' }),
        })
      );
    });

    test('persists to disk on creation', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Save test',
        type: 'broadcast',
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('onMessage - stage transitions', () => {
    beforeEach(() => {
      // Create a proposal first
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Fix tooltip alignment',
        type: 'broadcast',
      });
      jest.clearAllMocks();
    });

    test('advances from proposed to accepted', () => {
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Go ahead with the tooltip fix',
        type: 'direct',
      });

      const items = pipeline.getItems();
      expect(items[0].stage).toBe('accepted');
    });

    test('advances from proposed to assigned', () => {
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'BUILDER',
        msg: '[ASSIGNED] Builder handle the tooltip fix',
        type: 'direct',
      });

      const items = pipeline.getItems();
      expect(items[0].stage).toBe('assigned');
      expect(items[0].assignedTo).toBe('BUILDER');
    });

    test('skips intermediate stages (proposed -> review_pending)', () => {
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[DONE] Tooltip fix is complete',
        type: 'broadcast',
      });

      const items = pipeline.getItems();
      expect(items[0].stage).toBe('review_pending');
    });

    test('emits pipeline-stage-change IPC on transition', () => {
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Approved',
        type: 'direct',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        'pipeline-stage-change',
        expect.objectContaining({
          from: 'proposed',
          to: 'accepted',
        })
      );
    });

    test('ignores backward transitions (idempotent)', () => {
      // Advance to accepted
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Go ahead',
        type: 'direct',
      });

      jest.clearAllMocks();

      // Try to go back to proposed (should be ignored)
      pipeline.onMessage({
        ts: 1707350402,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Actually let me rethink this',
        type: 'broadcast',
      });

      // Should create a NEW item, not regress the existing one
      const items = pipeline.getItems();
      expect(items.length).toBe(2);
      expect(items[0].stage).toBe('accepted'); // Original stays accepted
      expect(items[1].stage).toBe('proposed'); // New item created
    });

    test('records message history on each transition', () => {
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Go ahead',
        type: 'direct',
      });

      const items = pipeline.getItems();
      expect(items[0].messages.length).toBe(2);
      expect(items[0].messages[0].stage).toBe('proposed');
      expect(items[0].messages[1].stage).toBe('accepted');
    });
  });

  describe('auto-notifications', () => {
    beforeEach(() => {
      // Create and advance a proposal to implementing
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Fix tooltip alignment',
        type: 'broadcast',
      });
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Go ahead',
        type: 'direct',
      });
      jest.clearAllMocks();
    });

    test('auto-notifies Architect when stage reaches review_pending', () => {
      pipeline.onMessage({
        ts: 1707350402,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[DONE] Tooltip fix is complete',
        type: 'broadcast',
      });

      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        expect.stringContaining('[PIPELINE]'),
        'Pipeline'
      );
      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        expect.stringContaining('ready for review'),
        'Pipeline'
      );
    });

    test('auto-notifies Architect to commit when approved', () => {
      // Advance to review_pending first
      pipeline.onMessage({
        ts: 1707350402,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[DONE] Tooltip fix is complete',
        type: 'broadcast',
      });
      jest.clearAllMocks();

      // Now approve
      pipeline.onMessage({
        ts: 1707350403,
        from: 'ARCH',
        to: 'ALL',
        msg: '[APPROVED] Ship it',
        type: 'broadcast',
      });

      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        expect.stringContaining('APPROVED'),
        'Pipeline'
      );
      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        expect.stringContaining('Ready to commit'),
        'Pipeline'
      );
    });

    test('handles sendDirectMessage failure gracefully', () => {
      mockSendDirectMessage.mockImplementation(() => { throw new Error('send failed'); });

      // Should not throw
      expect(() => {
        pipeline.onMessage({
          ts: 1707350402,
          from: 'ORACLE',
          to: 'ALL',
          msg: '[DONE] Tooltip fix is complete',
          type: 'broadcast',
        });
      }).not.toThrow();
    });
  });

  describe('markCommitted', () => {
    test('marks item as committed', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Fix tooltip alignment',
        type: 'broadcast',
      });

      // Advance through stages
      pipeline.onMessage({ ts: 1707350401, from: 'ARCH', to: 'ORACLE', msg: '[ACCEPT] Go', type: 'direct' });
      pipeline.onMessage({ ts: 1707350402, from: 'ORACLE', to: 'ALL', msg: '[DONE] Done', type: 'broadcast' });
      pipeline.onMessage({ ts: 1707350403, from: 'ARCH', to: 'ALL', msg: '[APPROVED] Ship', type: 'broadcast' });

      const items = pipeline.getItems();
      const result = pipeline.markCommitted(items[0].id);
      expect(result).toBe(true);
      expect(items[0].stage).toBe('committed');
    });

    test('returns false for non-existent item', () => {
      const result = pipeline.markCommitted('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('getItems and getActiveItems', () => {
    beforeEach(() => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] First item',
        type: 'broadcast',
      });
      pipeline.onMessage({
        ts: 1707350401,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Second item',
        type: 'broadcast',
      });
    });

    test('getItems returns all items', () => {
      expect(pipeline.getItems().length).toBe(2);
    });

    test('getItems with stage filter returns matching items', () => {
      // Advance first item
      pipeline.onMessage({
        ts: 1707350402,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Go ahead with first',
        type: 'direct',
      });

      const proposed = pipeline.getItems('proposed');
      // Note: accept advances the first active non-committed item found
      expect(proposed.length).toBe(1);
    });

    test('getActiveItems excludes committed items', () => {
      // Advance first item all the way
      pipeline.onMessage({ ts: 1707350402, from: 'ARCH', to: 'ORACLE', msg: '[ACCEPT] Go', type: 'direct' });
      pipeline.onMessage({ ts: 1707350403, from: 'ORACLE', to: 'ALL', msg: '[DONE] Done', type: 'broadcast' });
      pipeline.onMessage({ ts: 1707350404, from: 'ARCH', to: 'ALL', msg: '[APPROVED] Ship', type: 'broadcast' });

      const items = pipeline.getItems();
      // Find the approved item and commit it
      const approvedItem = items.find(i => i.stage === 'approved');
      if (approvedItem) pipeline.markCommitted(approvedItem.id);

      const active = pipeline.getActiveItems();
      expect(active.every(i => i.stage !== 'committed')).toBe(true);
    });
  });

  describe('persistence', () => {
    test('loads existing pipeline from disk', () => {
      const existingData = {
        version: 1,
        items: [{
          id: 'pipe-123-abc',
          title: 'Existing item',
          proposedBy: 'ORACLE',
          assignedTo: null,
          stage: 'implementing',
          messages: [],
          createdAt: '2026-02-08T00:00:00Z',
          updatedAt: '2026-02-08T00:00:00Z',
        }],
        lastUpdated: '2026-02-08T00:00:00Z',
      };

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingData));

      pipeline.init({
        mainWindow: mockMainWindow,
        sendDirectMessage: mockSendDirectMessage,
      });

      const items = pipeline.getItems();
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('pipe-123-abc');
      expect(items[0].stage).toBe('implementing');
    });

    test('handles corrupt pipeline file gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json{{{');

      expect(() => {
        pipeline.init({
          mainWindow: mockMainWindow,
          sendDirectMessage: mockSendDirectMessage,
        });
      }).not.toThrow();

      expect(pipeline.getItems().length).toBe(0);
    });

    test('saves with atomic write pattern (tmp + rename)', () => {
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ORACLE',
        to: 'ALL',
        msg: '[PROPOSAL] Test atomic write',
        type: 'broadcast',
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    test('handles null entry gracefully', () => {
      expect(() => pipeline.onMessage(null)).not.toThrow();
      expect(() => pipeline.onMessage(undefined)).not.toThrow();
      expect(() => pipeline.onMessage({})).not.toThrow();
    });

    test('handles missing from field', () => {
      pipeline.onMessage({
        ts: 1707350400,
        to: 'ALL',
        msg: '[PROPOSAL] No from field',
        type: 'broadcast',
      });

      const items = pipeline.getItems();
      expect(items.length).toBe(1);
      expect(items[0].proposedBy).toBe('unknown');
    });

    test('non-proposal detection with no active items is no-op', () => {
      // Send an [ACCEPT] with no active proposals
      pipeline.onMessage({
        ts: 1707350400,
        from: 'ARCH',
        to: 'ORACLE',
        msg: '[ACCEPT] Sounds good to me',
        type: 'direct',
      });

      expect(pipeline.getItems().length).toBe(0);
    });

    test('window destroyed does not throw on IPC emit', () => {
      mockMainWindow.isDestroyed.mockReturnValue(true);

      expect(() => {
        pipeline.onMessage({
          ts: 1707350400,
          from: 'ORACLE',
          to: 'ALL',
          msg: '[PROPOSAL] Window destroyed test',
          type: 'broadcast',
        });
      }).not.toThrow();

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('STAGES constant', () => {
    test('has all expected stages in order', () => {
      expect(pipeline.STAGES).toEqual([
        'proposed', 'accepted', 'assigned', 'implementing',
        'review_pending', 'approved', 'committed',
      ]);
    });
  });
});
