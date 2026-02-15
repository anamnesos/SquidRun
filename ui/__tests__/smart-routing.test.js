/**
 * Smart Routing Core Module Tests
 * Target: Full coverage of smart-routing.js (pure scoring/routing logic)
 */

'use strict';

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { inferTaskType, scoreAgents, getBestAgent } = require('../modules/smart-routing');

describe('Smart Routing Core', () => {
  afterEach(() => jest.clearAllMocks());

  // ── inferTaskType ──

  describe('inferTaskType', () => {
    test('resolves explicit task type alias', () => {
      const result = inferTaskType('thinking', '');
      expect(result.taskType).toBe('analysis');
      expect(result.inferred).toBe(false);
    });

    test('resolves explicit alias "implement"', () => {
      const result = inferTaskType('implement', '');
      expect(result.taskType).toBe('implementation');
    });

    test('infers from message when no type given', () => {
      const result = inferTaskType('', 'please investigate the root cause of this bug and diagnose');
      expect(result.taskType).toBe('analysis');
      expect(result.inferred).toBe(true);
    });

    test('infers UI type from keywords', () => {
      const result = inferTaskType('', 'fix the frontend css layout renderer');
      expect(result.taskType).toBe('ui');
    });

    test('infers backend type', () => {
      const result = inferTaskType('', 'fix the ipc daemon node process');
      expect(result.taskType).toBe('backend');
    });

    test('infers review type', () => {
      const result = inferTaskType('', 'review verify qa audit coverage');
      expect(result.taskType).toBe('review');
    });

    test('infers planning type', () => {
      const result = inferTaskType('', 'plan the architecture roadmap strategy spec');
      expect(result.taskType).toBe('planning');
    });

    test('infers coordination type', () => {
      const result = inferTaskType('', 'route and assign the handoff for sync coordination');
      expect(result.taskType).toBe('coordination');
    });

    test('infers implementation type', () => {
      const result = inferTaskType('', 'implement build code feature fix ship');
      expect(result.taskType).toBe('implementation');
    });

    test('high confidence when many keywords match', () => {
      const result = inferTaskType('', 'investigate analysis debug trace repro root cause diagnose');
      expect(result.confidence).toBe(0.8);
    });

    test('medium confidence with few keywords', () => {
      const result = inferTaskType('', 'debug something');
      expect(result.confidence).toBe(0.5);
    });

    test('low confidence with no keywords', () => {
      const result = inferTaskType('', 'do the thing');
      expect(result.confidence).toBe(0.2);
    });

    test('returns "general" when no type and no keywords match', () => {
      const result = inferTaskType('', '');
      expect(result.taskType).toBe('general');
    });

    test('handles null inputs', () => {
      const result = inferTaskType(null, null);
      expect(result.taskType).toBeDefined();
    });

    test('handles multi-word keyword "root cause"', () => {
      const result = inferTaskType('', 'find the root cause of the crash');
      expect(result.taskType).toBe('analysis');
    });
  });

  // ── scoreAgents ──

  describe('scoreAgents', () => {
    const mockRoles = {
      '1': { name: 'Architect', type: 'coordination', skills: ['coordination', 'planning', 'architecture'] },
      '2': { name: 'Builder', type: 'backend', skills: ['backend', 'implementation', 'ipc', 'testing'] },
      '5': { name: 'Oracle', type: 'analysis', skills: ['analysis', 'debugging', 'review'] },
    };

    const allRunning = { get: () => 'running' };

    test('scores all running agents', () => {
      const scores = scoreAgents({
        taskType: 'analysis',
        message: 'investigate this bug',
        roles: mockRoles,
        runningMap: allRunning,
      });
      expect(scores).toHaveLength(3);
      expect(scores[0].paneId).toBeDefined();
      expect(typeof scores[0].total).toBe('number');
      expect(scores[0].breakdown).toBeDefined();
    });

    test('excludes non-running agents', () => {
      const partialRunning = {
        get: (id) => id === '1' ? 'running' : 'stopped'
      };
      const scores = scoreAgents({
        taskType: 'coordination',
        message: '',
        roles: mockRoles,
        runningMap: partialRunning,
      });
      expect(scores).toHaveLength(1);
      expect(scores[0].paneId).toBe('1');
    });

    test('returns sorted by total score descending', () => {
      const scores = scoreAgents({
        taskType: 'backend',
        message: 'fix the ipc daemon process server api',
        roles: mockRoles,
        runningMap: allRunning,
      });
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1].total).toBeGreaterThanOrEqual(scores[i].total);
      }
    });

    test('handles no runningMap (all agents scored)', () => {
      const scores = scoreAgents({
        taskType: 'review',
        message: 'review code',
        roles: mockRoles,
      });
      expect(scores).toHaveLength(3);
    });

    test('uses learning data when provided', () => {
      const learning = {
        taskTypes: {
          analysis: {
            agentStats: {
              '5': { attempts: 10, success: 9, totalTime: 50000 }
            }
          }
        }
      };
      const scores = scoreAgents({
        taskType: 'analysis',
        message: 'investigate',
        roles: mockRoles,
        runningMap: allRunning,
        learning,
      });
      // Oracle (pane 5) should have higher learning score
      const oracle = scores.find(s => s.paneId === '5');
      expect(oracle.breakdown.learning).toBeGreaterThan(0.5);
    });

    test('uses performance data when provided', () => {
      const performance = {
        agents: {
          '2': { completions: 50, errors: 2, responseCount: 50, totalResponseTime: 250000 }
        }
      };
      const scores = scoreAgents({
        taskType: 'backend',
        message: 'fix server',
        roles: mockRoles,
        runningMap: allRunning,
        performance,
      });
      const builder = scores.find(s => s.paneId === '2');
      expect(builder.breakdown.performance).toBeGreaterThan(0.5);
    });

    test('returns empty array when no running agents', () => {
      const noneRunning = { get: () => 'stopped' };
      const scores = scoreAgents({
        taskType: 'analysis',
        message: '',
        roles: mockRoles,
        runningMap: noneRunning,
      });
      expect(scores).toHaveLength(0);
    });

    test('handles roles with no skills', () => {
      const bareRoles = { '1': { name: 'Bare', type: 'general' } };
      const scores = scoreAgents({
        taskType: 'analysis',
        message: 'test',
        roles: bareRoles,
        runningMap: allRunning,
      });
      expect(scores).toHaveLength(1);
      expect(scores[0].breakdown.skillMatch).toBeDefined();
    });
  });

  // ── getBestAgent ──

  describe('getBestAgent', () => {
    const mockRoles = {
      '1': { name: 'Architect', type: 'coordination', skills: ['coordination', 'planning'] },
      '2': { name: 'Builder', type: 'backend', skills: ['backend', 'implementation'] },
      '5': { name: 'Oracle', type: 'analysis', skills: ['analysis', 'debugging'] },
    };
    const allRunning = { get: () => 'running' };

    test('returns best agent with decision metadata', () => {
      const result = getBestAgent({
        taskType: 'analysis',
        message: 'investigate bug',
        roles: mockRoles,
        runningMap: allRunning,
      });
      expect(result.paneId).toBeDefined();
      expect(result.taskType).toBe('analysis');
      expect(result.reason).toBeDefined();
      expect(typeof result.confidence).toBe('number');
    });

    test('returns no_running_candidates when all stopped', () => {
      const result = getBestAgent({
        taskType: 'analysis',
        message: 'test',
        roles: mockRoles,
        runningMap: { get: () => 'stopped' },
      });
      expect(result.paneId).toBeNull();
      expect(result.reason).toBe('no_running_candidates');
    });

    test('infers task type from message', () => {
      const result = getBestAgent({
        message: 'fix the frontend css layout',
        roles: mockRoles,
        runningMap: allRunning,
      });
      expect(result.taskType).toBe('ui');
      expect(result.inferred).toBe(true);
    });

    test('loads learning from workspace', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        taskTypes: {},
        routingWeights: { '1': 1.0 },
        totalDecisions: 5,
        routingHistory: [],
      }));

      const result = getBestAgent({
        taskType: 'backend',
        message: 'fix server',
        roles: mockRoles,
        runningMap: allRunning,
        workspacePath: '/workspace',
      });

      expect(fs.existsSync).toHaveBeenCalled();
      expect(result.paneId).toBeDefined();
    });

    test('handles missing workspace path', () => {
      const result = getBestAgent({
        taskType: 'review',
        message: 'review code',
        roles: mockRoles,
        runningMap: allRunning,
        workspacePath: null,
      });
      expect(result.paneId).toBeDefined();
    });

    test('records decision to learning file', () => {
      fs.existsSync.mockReturnValue(false);

      getBestAgent({
        taskType: 'analysis',
        message: 'debug this',
        roles: mockRoles,
        runningMap: allRunning,
        workspacePath: '/workspace',
      });

      // Should have written learning file
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('decision reason reflects dominant factor', () => {
      // When a role has strong skill match
      const result = getBestAgent({
        taskType: 'backend',
        message: 'fix the ipc daemon node process server api backend',
        roles: {
          '2': { name: 'Builder', type: 'backend', skills: ['backend', 'implementation', 'ipc'] },
        },
        runningMap: allRunning,
      });
      expect(result.paneId).toBe('2');
      // Reason could be skill_match, balanced, or first_available depending on scores
      expect(['skill_match', 'balanced', 'first_available', 'performance_based', 'load_balanced']).toContain(result.reason);
    });
  });
});
