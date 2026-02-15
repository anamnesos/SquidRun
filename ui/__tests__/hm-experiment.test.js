const hmExperiment = require('../scripts/hm-experiment');

describe('hm-experiment CLI helpers', () => {
  test('normalizeCommand handles aliases', () => {
    expect(hmExperiment.normalizeCommand('create')).toBe('run');
    expect(hmExperiment.normalizeCommand('run-experiment')).toBe('run');
    expect(hmExperiment.normalizeCommand('get-experiment')).toBe('get');
    expect(hmExperiment.normalizeCommand('list-experiments')).toBe('list');
    expect(hmExperiment.normalizeCommand('attach-to-claim')).toBe('attach');
  });

  test('toAction maps supported commands', () => {
    expect(hmExperiment.toAction('run')).toBe('run-experiment');
    expect(hmExperiment.toAction('get')).toBe('get-experiment');
    expect(hmExperiment.toAction('list')).toBe('list-experiments');
    expect(hmExperiment.toAction('attach')).toBe('attach-to-claim');
  });

  test('buildPayload creates run payload with args/env/guard context', () => {
    const options = new Map([
      ['profile', 'jest-file'],
      ['claim-id', 'clm_123'],
      ['requested-by', 'builder'],
      ['session', 's_999'],
      ['arg', ['file=__tests__/team-memory-store.test.js', 'mode=watch']],
      ['env-allowlist', 'NODE_ENV,CI'],
      ['guard-id', 'grd_12'],
      ['guard-action', 'block'],
      ['guard-blocking', 'true'],
    ]);

    expect(hmExperiment.buildPayload('run', options)).toEqual(
      expect.objectContaining({
        profileId: 'jest-file',
        claimId: 'clm_123',
        requestedBy: 'builder',
        session: 's_999',
        guardContext: {
          guardId: 'grd_12',
          action: 'block',
          blocking: true,
        },
        input: expect.objectContaining({
          args: {
            file: '__tests__/team-memory-store.test.js',
            mode: 'watch',
          },
          envAllowlist: ['NODE_ENV', 'CI'],
        }),
      })
    );
  });

  test('buildPayload creates get/list/attach payloads', () => {
    const getOptions = new Map([['run-id', 'exp_123']]);
    expect(hmExperiment.buildPayload('get', getOptions)).toEqual({ runId: 'exp_123' });

    const listOptions = new Map([
      ['status', 'attached'],
      ['profile-id', 'jest-suite'],
      ['claim-id', 'clm_1'],
      ['limit', '20'],
    ]);
    expect(hmExperiment.buildPayload('list', listOptions)).toEqual(
      expect.objectContaining({
        status: 'attached',
        profileId: 'jest-suite',
        claimId: 'clm_1',
        limit: 20,
      })
    );

    const attachOptions = new Map([
      ['run-id', 'exp_123'],
      ['claim-id', 'clm_1'],
      ['relation', 'supports'],
      ['added-by', 'oracle'],
    ]);
    expect(hmExperiment.buildPayload('attach', attachOptions)).toEqual({
      runId: 'exp_123',
      claimId: 'clm_1',
      relation: 'supports',
      addedBy: 'oracle',
      summary: '',
    });
  });
});
