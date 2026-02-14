const mockExecuteTeamMemoryOperation = jest.fn();
const mockCloseTeamMemoryRuntime = jest.fn(() => Promise.resolve());

jest.mock('../modules/team-memory', () => ({
  executeTeamMemoryOperation: (...args) => mockExecuteTeamMemoryOperation(...args),
  closeTeamMemoryRuntime: (...args) => mockCloseTeamMemoryRuntime(...args),
}));

const {
  registerTeamMemoryHandlers,
  unregisterTeamMemoryHandlers,
  TEAM_MEMORY_CHANNELS,
} = require('../modules/ipc/team-memory-handlers');

describe('team-memory IPC handlers', () => {
  let ipcMain;
  let ctx;

  beforeEach(() => {
    mockExecuteTeamMemoryOperation.mockReset();
    mockExecuteTeamMemoryOperation.mockReturnValue({ ok: true });
    mockCloseTeamMemoryRuntime.mockClear();

    ipcMain = {
      handle: jest.fn(),
      removeHandler: jest.fn(),
    };
    ctx = { ipcMain };
  });

  test('registers all team-memory channels', () => {
    registerTeamMemoryHandlers(ctx);
    expect(ipcMain.handle).toHaveBeenCalledTimes(TEAM_MEMORY_CHANNELS.length);
    for (const channel of TEAM_MEMORY_CHANNELS) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  test('routes create/query/update/deprecate/experiment channels to expected actions', async () => {
    registerTeamMemoryHandlers(ctx);

    const getHandler = (channel) => {
      const call = ipcMain.handle.mock.calls.find(([name]) => name === channel);
      return call?.[1];
    };

    await getHandler('team-memory:create')({}, {
      statement: 'Test claim',
      entity: 'claim',
      owner: 'devops',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'create-claim',
      expect.objectContaining({ statement: 'Test claim' }),
      expect.objectContaining({
        source: expect.objectContaining({ via: 'ipc', role: 'system' }),
      })
    );

    await getHandler('team-memory:create')({}, {
      entity: 'evidence',
      claimId: 'clm_1',
      evidenceRef: 'evt_1',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'add-evidence',
      expect.objectContaining({ claimId: 'clm_1', evidenceRef: 'evt_1' }),
      expect.any(Object)
    );

    await getHandler('team-memory:create')({}, {
      entity: 'consensus',
      claimId: 'clm_1',
      agent: 'devops',
      position: 'agree',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'record-consensus',
      expect.objectContaining({ claimId: 'clm_1', position: 'agree' }),
      expect.any(Object)
    );

    await getHandler('team-memory:create')({}, {
      entity: 'belief-snapshot',
      agent: 'devops',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'create-belief-snapshot',
      expect.objectContaining({ agent: 'devops' }),
      expect.any(Object)
    );

    await getHandler('team-memory:create')({}, {
      entity: 'pattern',
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'create-pattern',
      expect.objectContaining({ patternType: 'failure' }),
      expect.any(Object)
    );

    await getHandler('team-memory:create')({}, {
      entity: 'guard',
      action: 'warn',
      triggerCondition: { scope: 'ui/modules/triggers.js' },
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'create-guard',
      expect.objectContaining({ action: 'warn' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { scope: 'ui/modules/triggers.js' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'query-claims',
      expect.objectContaining({ scope: 'ui/modules/triggers.js' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { entity: 'consensus', claimId: 'clm_2' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'get-consensus',
      expect.objectContaining({ claimId: 'clm_2' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { entity: 'beliefs', agent: 'devops' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'get-agent-beliefs',
      expect.objectContaining({ agent: 'devops' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { entity: 'contradictions', agent: 'devops' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'get-contradictions',
      expect.objectContaining({ agent: 'devops' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { entity: 'patterns', scope: 'ui/modules/triggers.js' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'query-patterns',
      expect.objectContaining({ scope: 'ui/modules/triggers.js' }),
      expect.any(Object)
    );

    await getHandler('team-memory:query')({}, { entity: 'guards', scope: 'ui/modules/triggers.js' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'query-guards',
      expect.objectContaining({ scope: 'ui/modules/triggers.js' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      claimId: 'clm_2',
      status: 'confirmed',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'update-claim-status',
      expect.objectContaining({ claimId: 'clm_2', status: 'confirmed' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      entity: 'decision',
      operation: 'record-outcome',
      decisionId: 'dec_1',
      outcome: 'success',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'record-outcome',
      expect.objectContaining({ decisionId: 'dec_1', outcome: 'success' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      entity: 'pattern',
      operation: 'activate',
      patternId: 'pat_1',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'activate-pattern',
      expect.objectContaining({ patternId: 'pat_1' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      entity: 'pattern',
      operation: 'deactivate',
      patternId: 'pat_2',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'deactivate-pattern',
      expect.objectContaining({ patternId: 'pat_2' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      entity: 'guard',
      operation: 'activate',
      guardId: 'grd_1',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'activate-guard',
      expect.objectContaining({ guardId: 'grd_1' }),
      expect.any(Object)
    );

    await getHandler('team-memory:update')({}, {
      entity: 'guard',
      operation: 'deactivate',
      guardId: 'grd_2',
    });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'deactivate-guard',
      expect.objectContaining({ guardId: 'grd_2' }),
      expect.any(Object)
    );

    await getHandler('team-memory:deprecate')({}, { claimId: 'clm_3', reason: 'superseded' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'deprecate-claim',
      expect.objectContaining({ claimId: 'clm_3', reason: 'superseded' }),
      expect.any(Object)
    );

    await getHandler('team-memory:run-experiment')({}, { profileId: 'jest-suite', claimId: 'clm_8' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'run-experiment',
      expect.objectContaining({ profileId: 'jest-suite', claimId: 'clm_8' }),
      expect.any(Object)
    );

    await getHandler('team-memory:get-experiment')({}, { runId: 'exp_7' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'get-experiment',
      expect.objectContaining({ runId: 'exp_7' }),
      expect.any(Object)
    );

    await getHandler('team-memory:list-experiments')({}, { status: 'attached' });
    expect(mockExecuteTeamMemoryOperation).toHaveBeenLastCalledWith(
      'list-experiments',
      expect.objectContaining({ status: 'attached' }),
      expect.any(Object)
    );
  });

  test('unregister removes channels and closes runtime', () => {
    unregisterTeamMemoryHandlers(ctx);
    for (const channel of TEAM_MEMORY_CHANNELS) {
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
    expect(mockCloseTeamMemoryRuntime).toHaveBeenCalledWith({ killTimeoutMs: 500 });
  });
});
