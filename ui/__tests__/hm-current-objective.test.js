const fs = require('fs');
const os = require('os');
const path = require('path');

const currentObjective = require('../scripts/hm-current-objective');

describe('hm-current-objective', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-current-objective-'));
    statePath = path.join(tempDir, 'current-objective-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('initial state parks receivables and starts with no lanes', () => {
    const state = currentObjective.makeInitialState({
      objective: 'Keep agents moving from current objective residuals.',
      summary: 'Receivables parked.',
    });

    expect(state).toEqual(expect.objectContaining({
      objective: 'Keep agents moving from current objective residuals.',
      summary: 'Receivables parked.',
      status: 'active',
      lanes: {},
    }));
    expect(state.parkedTopics).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'TrustQuote receivables outbound' }),
    ]));
  });

  test('checkState catches incomplete active lanes', () => {
    const state = {
      objective: 'Keep agents moving.',
      lanes: {
        builder: {
          id: 'builder',
          status: 'active',
          owner: 'builder',
          currentReality: 'Script exists.',
        },
      },
    };

    const result = currentObjective.checkState(state, {
      statePath,
      staleMinutes: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lane_missing_required_fields',
        lane: 'builder',
        owner: 'builder',
        missing: expect.arrayContaining(['nextAction', 'evidencePath', 'stopCondition']),
      }),
    ]));
  });

  test('checkState flags stale active lanes and ignores closed lanes', () => {
    const staleAt = new Date(Date.now() - (45 * 60 * 1000)).toISOString();
    const state = {
      objective: 'Keep agents moving.',
      lanes: {
        builder: {
          id: 'builder',
          status: 'active',
          owner: 'builder',
          currentReality: 'Work started.',
          nextAction: 'Continue.',
          evidencePath: 'ui/scripts/hm-current-objective.js',
          stopCondition: 'Committed and reviewed.',
          updatedAt: staleAt,
        },
        oracle: {
          id: 'oracle',
          status: 'closed',
          owner: 'oracle',
          worldChange: 'Oracle guardrail documented.',
          residual: 'none',
          nextOwner: 'architect',
          clientFailureMode: 'Guardrail can become prose-only.',
          stopReason: 'closed because checkpoint answers are complete',
          updatedAt: staleAt,
        },
      },
    };

    const result = currentObjective.checkState(state, {
      statePath,
      staleMinutes: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        type: 'lane_stale',
        lane: 'builder',
        owner: 'builder',
      }),
    ]);
  });

  test('checkState refuses closed lanes without checkpoint answers', () => {
    const state = {
      objective: 'Keep agents moving.',
      lanes: {
        builder: {
          id: 'builder',
          status: 'closed',
          owner: 'builder',
          currentReality: 'Commit landed.',
          evidencePath: 'ui/scripts/hm-current-objective.js',
        },
      },
    };

    const result = currentObjective.checkState(state, {
      statePath,
      staleMinutes: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        type: 'closed_lane_missing_checkpoint',
        lane: 'builder',
        owner: 'builder',
        missing: expect.arrayContaining([
          'worldChange',
          'residual',
          'nextOwner',
          'clientFailureMode',
          'stopReason',
        ]),
      }),
    ]);
  });

  test('main init and update-lane write the objective state file', () => {
    currentObjective.main([
      'init',
      '--state',
      statePath,
      '--objective',
      'Operate the wake loop.',
    ]);
    currentObjective.main([
      'update-lane',
      '--state',
      statePath,
      '--lane',
      'builder-wake-loop',
      '--owner',
      'builder',
      '--current-reality',
      'State tool exists.',
      '--next-action',
      'Wire supervisor lane.',
      '--evidence-path',
      'ui/scripts/hm-current-objective.js',
      '--stop-condition',
      'Supervisor status shows currentObjectiveWake.',
      '--world-change',
      'The wake loop is represented.',
      '--residual',
      'Supervisor wiring remains.',
      '--next-owner',
      'builder',
      '--client-failure-mode',
      'A green schema can hide incomplete work.',
      '--stop-reason',
      'not closing yet',
    ]);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.objective).toBe('Operate the wake loop.');
    expect(state.lanes['builder-wake-loop']).toEqual(expect.objectContaining({
      owner: 'builder',
      nextAction: 'Wire supervisor lane.',
      clientFailureMode: 'A green schema can hide incomplete work.',
    }));
  });
});
