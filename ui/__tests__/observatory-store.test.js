const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ObservatoryLogError,
  appendObservationEvent,
  listObservations,
  loadObservationLog,
  openObservation,
  reconstructEvents,
} = require('../modules/observatory-store');
const observatoryCli = require('../scripts/hm-observatory');
const { promoteObservation, resolveRuntimeActor } = observatoryCli;
const initiative = require('../scripts/hm-initiative');

const tempRoots = [];

function tempLog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-observatory-'));
  tempRoots.push(root);
  return path.join(root, 'oracle.jsonl');
}

function opening(overrides = {}) {
  return {
    question: 'Why did the continuity receipt change?',
    whyItMatters: 'A silent source change could break recovery.',
    stakes: 'medium',
    favorable: false,
    evidence: [{ ref: 'receipt:1', note: 'Hash changed.', scopeSearched: 'pane 1 receipt' }],
    disconfirmers: [],
    nextProbe: 'Compare the loader source hash.',
    reviewAt: '2026-08-21T06:00:00.000Z',
    expiresAt: '2026-08-22T06:00:00.000Z',
    noExpiryReason: null,
    ...overrides,
  };
}

function open(filePath, overrides = {}) {
  return openObservation({
    filePath,
    id: overrides.id || 'obs-test-1',
    actor: overrides.actor || 'oracle',
    at: overrides.at || new Date('2026-08-21T05:00:00.000Z'),
    input: opening(overrides.input || {}),
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('observatory append-only lifecycle', () => {
  test('reconstructs deterministically and retains evidence/disconfirmer provenance', () => {
    const filePath = tempLog();
    open(filePath);
    appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      type: 'evidence_added',
      payload: { ref: 'ledger:81403', note: 'Route row exists.', scopeSearched: 'current ledger' },
      at: new Date('2026-08-21T05:10:00.000Z'),
    });
    appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      type: 'disconfirmer_added',
      payload: { ref: 'test:negative', note: 'No cross-seat bytes.', countercheck: true },
      at: new Date('2026-08-21T05:11:00.000Z'),
    });

    const loaded = loadObservationLog(filePath);
    const rebuilt = reconstructEvents(loaded.events);
    expect(Array.from(rebuilt.values())).toEqual(Array.from(loaded.states.values()));
    const state = loaded.states.get('obs-test-1');
    expect(state.evidence.at(-1)).toEqual(expect.objectContaining({
      ref: 'ledger:81403',
      recordedBy: 'oracle',
      recordedAt: '2026-08-21T05:10:00.000Z',
      scopeSearched: 'current ledger',
    }));
    expect(state.disconfirmers[0]).toEqual(expect.objectContaining({
      ref: 'test:negative',
      countercheck: true,
      recordedBy: 'oracle',
    }));
  });

  test('rejects duplicate opens before appending another line', () => {
    const filePath = tempLog();
    open(filePath);
    const before = fs.readFileSync(filePath, 'utf8');
    expect(() => open(filePath)).toThrow('already opened');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  test('prevents cross-seat mutation without changing the log', () => {
    const filePath = tempLog();
    open(filePath);
    const before = fs.readFileSync(filePath, 'utf8');
    expect(() => appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'builder',
      type: 'next_probe_set',
      payload: { nextProbe: 'Rook tries to overwrite Vera.' },
      at: new Date('2026-08-21T05:12:00.000Z'),
    })).toThrow('cannot mutate');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  test('computes due and expiry from injected time and excludes expired items from active authority', () => {
    const filePath = tempLog();
    open(filePath, {
      id: 'obs-due',
      input: {
        reviewAt: '2026-08-21T05:30:00.000Z',
        expiresAt: '2026-08-22T05:00:00.000Z',
      },
    });
    open(filePath, {
      id: 'obs-expired',
      input: {
        reviewAt: '2026-08-21T05:30:00.000Z',
        expiresAt: '2026-08-21T05:45:00.000Z',
      },
    });
    const states = loadObservationLog(filePath).states;
    const now = new Date('2026-08-21T06:00:00.000Z');
    const due = listObservations(states, { due: true, now });
    expect(due.map((item) => item.id)).toEqual(['obs-due', 'obs-expired']);
    expect(due.find((item) => item.id === 'obs-expired').effectiveStatus).toBe('expired');
    expect(listObservations(states, { activeOnly: true, now }).map((item) => item.id)).toEqual(['obs-due']);
    expect(() => appendObservationEvent({
      filePath,
      id: 'obs-expired',
      actor: 'oracle',
      type: 'evidence_added',
      payload: { ref: 'too-late' },
      at: now,
    })).toThrow('has expired');
  });

  test('a due review cannot be rolled forward without evidence, a new probe, or another real disposition', () => {
    const filePath = tempLog();
    open(filePath, { input: { reviewAt: '2026-08-21T05:30:00.000Z' } });
    const reviewTime = new Date('2026-08-21T06:00:00.000Z');
    expect(() => appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      type: 'review_scheduled',
      payload: { reviewAt: '2026-08-21T07:00:00.000Z' },
      at: reviewTime,
    })).toThrow('due review requires');

    appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      type: 'next_probe_set',
      payload: { nextProbe: 'Run a fresh receipt comparison.' },
      at: reviewTime,
    });
    const result = appendObservationEvent({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      type: 'review_scheduled',
      payload: { reviewAt: '2026-08-21T07:00:00.000Z' },
      at: new Date('2026-08-21T06:01:00.000Z'),
    });
    expect(result.state.reviewAt).toBe('2026-08-21T07:00:00.000Z');
  });

  test('missing-artifact evidence requires the searched scope', () => {
    const filePath = tempLog();
    expect(() => open(filePath, {
      input: {
        evidence: [{ ref: 'missing:receipt', missingArtifact: true }],
      },
    })).toThrow('requires scopeSearched');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('corrupt or noncanonical tails fail visibly and expose the valid prefix', () => {
    const filePath = tempLog();
    open(filePath);
    const validPrefix = fs.readFileSync(filePath, 'utf8');
    fs.appendFileSync(filePath, '{"truncated":', 'utf8');

    try {
      loadObservationLog(filePath);
      throw new Error('expected truncated tail failure');
    } catch (err) {
      expect(err).toBeInstanceOf(ObservatoryLogError);
      expect(err.lineNumber).toBe(2);
      expect(err.validEvents).toHaveLength(1);
      expect(err.states.has('obs-test-1')).toBe(true);
    }

    fs.writeFileSync(filePath, validPrefix, 'utf8');
    const noncanonical = {
      schema: 'squidrun.observatory_event.v1',
      id: 'obs-test-1',
      owner: ' Oracle ',
      type: 'next_probe_set',
      at: '2026-08-21T05:12:00.000Z',
      payload: { nextProbe: 'This must not apply.' },
    };
    fs.appendFileSync(filePath, `${JSON.stringify(noncanonical)}\n`, 'utf8');
    expect(() => loadObservationLog(filePath)).toThrow('owner must be canonical');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
  });
});

describe('observatory promotion and runtime authority', () => {
  function fakeInitiativeApi(initialInitiatives = []) {
    let register = { version: 1, updatedAt: null, initiatives: initialInitiatives.slice() };
    const api = {
      loadRegister: jest.fn(() => register),
      createInitiative: jest.fn((input, actor, at) => ({
        id: 'initiative-observatory-1',
        ...input,
        proposedBy: actor,
        status: 'proposed',
        createdAt: at,
      })),
      registerProposal: jest.fn((current, created, _actor, options) => {
        expect(options.surface).toBe(false);
        return { ...current, initiatives: [...current.initiatives, created] };
      }),
      writeRegister: jest.fn((next) => { register = next; }),
      findInitiative: jest.fn((current, id) => current.initiatives.find((item) => item.id === id)),
      surfaceInitiative: jest.fn(),
      getRegister: () => register,
    };
    return api;
  }

  test('duplicate promotion links one silent initiative and never calls an outbound surface', () => {
    const filePath = tempLog();
    open(filePath);
    const api = fakeInitiativeApi();
    const lockPath = path.join(path.dirname(filePath), 'promotion.lock');
    const first = promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:20:00.000Z'),
      initiativeApi: api,
      registerPath: '/test/register.json',
      lockPath,
    });
    const second = promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:21:00.000Z'),
      initiativeApi: api,
      registerPath: '/test/register.json',
      lockPath,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.initiative.id).toBe(first.initiative.id);
    expect(api.createInitiative).toHaveBeenCalledTimes(1);
    expect(api.registerProposal).toHaveBeenCalledTimes(1);
    expect(api.surfaceInitiative).not.toHaveBeenCalled();
    const loaded = loadObservationLog(filePath);
    const events = loaded.events;
    expect(events.filter((event) => event.type === 'promoted_to_initiative')).toHaveLength(1);
    expect(loaded.states.get('obs-test-1')).toEqual(expect.objectContaining({
      question: 'Why did the continuity receipt change?',
      status: 'open',
      initiativeId: 'initiative-observatory-1',
    }));
  });

  test('reuses an already shipped tagged initiative and preserves unknown terminal statuses', () => {
    const filePath = tempLog();
    open(filePath);
    const shipped = {
      id: 'initiative-shipped',
      status: 'shipped',
      tags: ['observatory:obs-test-1'],
    };
    const api = fakeInitiativeApi([shipped]);
    const lockPath = path.join(path.dirname(filePath), 'promotion.lock');
    const result = promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:20:00.000Z'),
      initiativeApi: api,
      registerPath: '/test/register.json',
      lockPath,
    });

    expect(result.created).toBe(false);
    expect(result.initiative.status).toBe('shipped');
    expect(api.createInitiative).not.toHaveBeenCalled();
    expect(initiative.normalizeStatus('shipped')).toBe('shipped');
    expect(initiative.normalizeStatus('completed_elsewhere')).toBe('completed_elsewhere');
  });

  test('high-stakes promotion requires an explicit countercheck', () => {
    const filePath = tempLog();
    open(filePath, { input: { stakes: 'high' } });
    const api = fakeInitiativeApi();
    expect(() => promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:20:00.000Z'),
      initiativeApi: api,
      lockPath: path.join(path.dirname(filePath), 'promotion.lock'),
    })).toThrow('explicit countercheck');
  });

  test('a forced concurrent promotion fails closed, then retry returns the single winner', () => {
    const filePath = tempLog();
    open(filePath);
    const api = fakeInitiativeApi();
    const lockPath = path.join(path.dirname(filePath), 'promotion.lock');
    const baseLoad = api.loadRegister.getMockImplementation();
    let nestedError = null;
    let interleaved = false;
    api.loadRegister.mockImplementation(() => {
      if (!interleaved) {
        interleaved = true;
        try {
          promoteObservation({
            filePath,
            id: 'obs-test-1',
            actor: 'oracle',
            now: new Date('2026-08-21T05:20:00.000Z'),
            initiativeApi: api,
            registerPath: '/test/register.json',
            lockPath,
            lockWaitMs: 0,
          });
        } catch (err) {
          nestedError = err;
        }
      }
      return baseLoad();
    });

    const winner = promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:20:00.000Z'),
      initiativeApi: api,
      registerPath: '/test/register.json',
      lockPath,
    });
    const retry = promoteObservation({
      filePath,
      id: 'obs-test-1',
      actor: 'oracle',
      now: new Date('2026-08-21T05:21:00.000Z'),
      initiativeApi: api,
      registerPath: '/test/register.json',
      lockPath,
    });

    expect(nestedError.message).toContain('promotion is busy');
    expect(retry.initiative.id).toBe(winner.initiative.id);
    expect(api.getRegister().initiatives).toHaveLength(1);
    expect(loadObservationLog(filePath).states.get('obs-test-1').initiativeId).toBe(winner.initiative.id);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('runtime actor is bound to role/pane metadata and contradictions fail closed', () => {
    expect(resolveRuntimeActor({ SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '3' })).toBe('oracle');
    expect(resolveRuntimeActor({ SQUIDRUN_PANE_ID: '2' })).toBe('builder');
    expect(() => resolveRuntimeActor({ SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '2' }))
      .toThrow('contradiction');
    expect(() => resolveRuntimeActor({ SQUIDRUN_ROLE: 'not-a-seat', SQUIDRUN_PANE_ID: '3' }))
      .toThrow('invalid runtime role');
    expect(() => resolveRuntimeActor({ SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '9' }))
      .toThrow('invalid runtime pane');
    expect(() => resolveRuntimeActor({})).toThrow('require SQUIDRUN_ROLE');
  });

  test('CLI open uses runtime identity and ignores a role-like write override', () => {
    const filePath = tempLog();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      observatoryCli.main([
        'open',
        '--role', 'builder',
        '--question', 'Is the route stable?',
        '--why', 'A mismatch would orphan history.',
        '--stakes', 'medium',
        '--evidence', 'ledger:route',
        '--next-probe', 'Compare stable route keys.',
        '--review-at', '2026-08-21T06:00:00.000Z',
        '--expires-at', '2026-08-22T06:00:00.000Z',
      ], {
        env: { SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '3' },
        filePath,
        now: new Date('2026-08-21T05:00:00.000Z'),
      });
    } finally {
      stdout.mockRestore();
    }

    const state = Array.from(loadObservationLog(filePath).states.values())[0];
    expect(state.owner).toBe('oracle');
  });

  test('CLI persists missing-artifact scope on open and add-evidence, and fails closed without it', () => {
    const filePath = tempLog();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runtime = {
      env: { SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '3' },
      filePath,
      now: new Date('2026-08-21T05:00:00.000Z'),
    };
    try {
      expect(() => observatoryCli.main([
        'open',
        '--question', 'Is a receipt missing?',
        '--why', 'Recovery needs all three receipts.',
        '--stakes', 'medium',
        '--evidence', 'missing:receipt-3',
        '--missing-artifact',
        '--next-probe', 'Search the runtime receipt directory again.',
        '--review-at', '2026-08-21T06:00:00.000Z',
        '--expires-at', '2026-08-22T06:00:00.000Z',
      ], runtime)).toThrow('requires scopeSearched');
      expect(fs.existsSync(filePath)).toBe(false);

      observatoryCli.main([
        'open',
        '--question', 'Is a receipt missing?',
        '--why', 'Recovery needs all three receipts.',
        '--stakes', 'medium',
        '--evidence', 'missing:receipt-3',
        '--missing-artifact',
        '--scope-searched', '.squidrun/runtime/seat-identity-loads',
        '--next-probe', 'Search the runtime receipt directory again.',
        '--review-at', '2026-08-21T06:00:00.000Z',
        '--expires-at', '2026-08-22T06:00:00.000Z',
      ], runtime);

      const id = Array.from(loadObservationLog(filePath).states.keys())[0];
      observatoryCli.main([
        'add-evidence', id,
        '--ref', 'missing:receipt-backup',
        '--missing-artifact',
        '--scope-searched', 'NAS extracted identity-receipts directory',
      ], { ...runtime, now: new Date('2026-08-21T05:10:00.000Z') });
    } finally {
      stdout.mockRestore();
    }

    const state = Array.from(loadObservationLog(filePath).states.values())[0];
    expect(state.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: 'missing:receipt-3',
        missingArtifact: true,
        scopeSearched: '.squidrun/runtime/seat-identity-loads',
      }),
      expect.objectContaining({
        ref: 'missing:receipt-backup',
        missingArtifact: true,
        scopeSearched: 'NAS extracted identity-receipts directory',
      }),
    ]));
  });
});
