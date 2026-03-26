jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../config', () => ({
  LEGACY_ROLE_ALIASES: {
    arch: 'architect',
    ana: 'oracle',
  },
  ROLE_ID_MAP: {
    architect: '1',
    builder: '2',
    oracle: '3',
  },
  resolveCoordPath: jest.fn(() => '/test/.squidrun/runtime/initiative-register.json'),
}));

const pipelineState = [];

jest.mock('../modules/pipeline', () => ({
  init: jest.fn(),
  getItems: jest.fn(() => pipelineState.slice()),
  onMessage: jest.fn((entry) => {
    pipelineState.push({
      id: `pipe-${pipelineState.length + 1}`,
      title: String(entry.msg || '').replace(/^\[PROPOSAL\]\s*/i, ''),
      stage: 'proposed',
    });
  }),
}));

const fs = require('fs');
const pipeline = require('../modules/pipeline');
const initiative = require('../scripts/hm-initiative');

describe('hm-initiative', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pipelineState.length = 0;
    fs.existsSync.mockReturnValue(false);
    process.env.SQUIDRUN_ROLE = 'builder';
    delete process.env.SQUIDRUN_PANE_ID;
  });

  afterEach(() => {
    delete process.env.SQUIDRUN_ROLE;
    delete process.env.SQUIDRUN_PANE_ID;
  });

  test('creates initiatives with self-endorsement and metadata', () => {
    const created = initiative.createInitiative({
      title: 'Surface self-authored initiative proposals',
      reason: 'We need a standing path from thought to attention.',
      priority: 'high',
      scope: 'global',
      tags: ['agency', 'initiative'],
    }, 'builder', '2026-03-23T23:55:00Z');

    expect(created.proposedBy).toBe('builder');
    expect(created.priority).toBe('high');
    expect(created.scope).toBe('global');
    expect(created.tags).toEqual(['agency', 'initiative']);
    expect(created.endorsements).toHaveLength(1);
    expect(created.endorsements[0].role).toBe('builder');
    expect(created.challenges).toHaveLength(0);
  });

  test('registerProposal surfaces into the pipeline by default', () => {
    const register = { version: 1, updatedAt: null, initiatives: [] };
    const created = initiative.createInitiative({
      title: 'Add initiative protocol',
      reason: 'Agent proposals need an attention path.',
      priority: 'critical',
      scope: 'cross-agent',
      tags: [],
    }, 'builder', '2026-03-23T23:55:00Z');

    const next = initiative.registerProposal(register, created, 'builder', {
      createdAt: '2026-03-23T23:55:00Z',
      surface: true,
      pipelineModule: pipeline,
    });

    expect(next.initiatives).toHaveLength(1);
    expect(created.pipelineId).toBe('pipe-1');
    expect(created.surfacedAt).toBe('2026-03-23T23:55:00Z');
    expect(pipeline.init).toHaveBeenCalled();
    expect(pipeline.onMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: 'BUILDER',
      msg: expect.stringContaining('[PROPOSAL]'),
      type: 'initiative',
    }));
  });

  test('challenge removes same-role endorsement and vice versa', () => {
    const register = { version: 1, updatedAt: null, initiatives: [] };
    const created = initiative.createInitiative({
      title: 'Start with initiative surfacing',
      reason: 'Initiative should come before veto.',
      priority: 'normal',
      scope: 'global',
      tags: [],
    }, 'builder', '2026-03-23T23:55:00Z');
    register.initiatives.push(created);

    initiative.applyReaction(register, created.id, 'oracle', 'challenge', 'Veto can wait.', '2026-03-23T23:56:00Z');
    expect(created.challenges).toHaveLength(1);
    expect(created.challenges[0].role).toBe('oracle');

    initiative.applyReaction(register, created.id, 'oracle', 'endorse', 'Sequence is right.', '2026-03-23T23:57:00Z');
    expect(created.challenges).toHaveLength(0);
    expect(created.endorsements.some((entry) => entry.role === 'oracle')).toBe(true);
  });

  test('filterInitiatives can return only mine sorted by attention score', () => {
    const mine = initiative.createInitiative({
      title: 'Higher-priority item',
      reason: 'Needs attention now.',
      priority: 'high',
      scope: 'global',
      tags: [],
    }, 'builder', '2026-03-23T23:55:00Z');
    const theirs = initiative.createInitiative({
      title: 'Oracle item',
      reason: 'Different owner.',
      priority: 'critical',
      scope: 'global',
      tags: [],
    }, 'oracle', '2026-03-23T23:54:00Z');

    const register = {
      version: 1,
      updatedAt: null,
      initiatives: [theirs, mine],
    };

    const filtered = initiative.filterInitiatives(register, {
      mine: true,
      actorRole: 'builder',
      status: 'all',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].proposedBy).toBe('builder');
    expect(filtered[0].title).toBe('Higher-priority item');
  });

  test('accept marks an initiative as accepted with decision metadata', () => {
    const register = { version: 1, updatedAt: null, initiatives: [] };
    const created = initiative.createInitiative({
      title: 'Ship initiative protocol',
      reason: 'It is ready for standing use.',
      priority: 'high',
      scope: 'global',
      tags: [],
    }, 'builder', '2026-03-23T23:55:00Z');
    register.initiatives.push(created);

    const updated = initiative.updateInitiativeStatus(
      register,
      created.id,
      'architect',
      'accepted',
      'Good enough to become a standing mechanism.',
      '2026-03-23T23:58:00Z'
    );

    expect(updated.status).toBe('accepted');
    expect(updated.decidedBy).toBe('architect');
    expect(updated.decidedAt).toBe('2026-03-23T23:58:00Z');
    expect(updated.lastDecisionReason).toBe('Good enough to become a standing mechanism.');
    expect(updated.history.at(-1)).toEqual(expect.objectContaining({
      type: 'accepted',
      role: 'architect',
    }));
  });

  test('park and reject both resolve into durable status instead of leaving proposals hanging', () => {
    const register = { version: 1, updatedAt: null, initiatives: [] };
    const parked = initiative.createInitiative({
      title: 'Deferred idea',
      reason: 'Good but not now.',
      priority: 'normal',
      scope: 'global',
      tags: [],
    }, 'oracle', '2026-03-23T23:55:00Z');
    const rejected = initiative.createInitiative({
      title: 'Bad framing',
      reason: 'This one should not proceed.',
      priority: 'normal',
      scope: 'global',
      tags: [],
    }, 'builder', '2026-03-23T23:55:00Z');
    register.initiatives.push(parked, rejected);

    initiative.updateInitiativeStatus(
      register,
      parked.id,
      'architect',
      'parked',
      'Keep it visible but out of the active lane.',
      '2026-03-23T23:59:00Z'
    );
    initiative.updateInitiativeStatus(
      register,
      rejected.id,
      'architect',
      'rejected',
      'This does not solve the right problem.',
      '2026-03-24T00:00:00Z'
    );

    expect(parked.status).toBe('parked');
    expect(rejected.status).toBe('rejected');
    expect(parked.history.at(-1)).toEqual(expect.objectContaining({ type: 'parked' }));
    expect(rejected.history.at(-1)).toEqual(expect.objectContaining({ type: 'rejected' }));
  });
});
