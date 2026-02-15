const fs = require('fs');
const os = require('os');
const path = require('path');

const mockExecuteExperimentOperation = jest.fn(() => ({ ok: true }));

jest.mock('../modules/experiment/runtime', () => ({
  executeExperimentOperation: (...args) => mockExecuteExperimentOperation(...args),
}));

const runtime = require('../modules/team-memory/runtime');
const { loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory runtime experiment action routing', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-runtime-exp-'));
    mockExecuteExperimentOperation.mockReset();
    mockExecuteExperimentOperation.mockReturnValue({ ok: true });
  });

  afterEach(() => {
    runtime.closeSharedRuntime();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('routes run/get/list/attach to experiment runtime', () => {
    const init = runtime.initializeTeamMemoryRuntime({
      runtimeOptions: {
        storeOptions: {
          dbPath: path.join(tempDir, 'team-memory.sqlite'),
        },
      },
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);

    runtime.executeTeamMemoryOperation('run-experiment', { profileId: 'jest-suite', claimId: 'clm_1' });
    expect(mockExecuteExperimentOperation).toHaveBeenLastCalledWith(
      'run-experiment',
      expect.objectContaining({ profileId: 'jest-suite', claimId: 'clm_1' }),
      expect.objectContaining({
        runtimeOptions: expect.objectContaining({
          dbPath: path.join(tempDir, 'team-memory.sqlite'),
        }),
      })
    );

    runtime.executeTeamMemoryOperation('get-experiment', { runId: 'exp_1' });
    expect(mockExecuteExperimentOperation).toHaveBeenLastCalledWith(
      'get-experiment',
      expect.objectContaining({ runId: 'exp_1' }),
      expect.any(Object)
    );

    runtime.executeTeamMemoryOperation('list-experiments', { status: 'attached' });
    expect(mockExecuteExperimentOperation).toHaveBeenLastCalledWith(
      'list-experiments',
      expect.objectContaining({ status: 'attached' }),
      expect.any(Object)
    );

    runtime.executeTeamMemoryOperation('attach-to-claim', {
      runId: 'exp_1',
      claimId: 'clm_1',
      relation: 'supports',
      addedBy: 'builder',
    });
    expect(mockExecuteExperimentOperation).toHaveBeenLastCalledWith(
      'attach-to-claim',
      expect.objectContaining({
        runId: 'exp_1',
        claimId: 'clm_1',
        relation: 'supports',
      }),
      expect.any(Object)
    );
  });
});
