const {
  buildNodeWorkerForkOptions,
  isElectronRuntime,
  stripElectronRunAsNodeVariants,
} = require('../modules/node-worker-fork-options');

describe('node worker fork options', () => {
  test('strips stale ELECTRON_RUN_AS_NODE variants before setting child env', () => {
    const env = {
      ELECTRON_RUN_AS_NODE: 'stale',
      Electron_Run_As_Node: 'stale-case-variant',
      SQUIDRUN_ROLE: 'builder',
    };

    stripElectronRunAsNodeVariants(env);

    expect(env).toEqual({
      SQUIDRUN_ROLE: 'builder',
    });
  });

  test('uses electron-as-node when a worker is forked from Electron', () => {
    const runtime = {
      execPath: 'D:\\SquidRun\\Eunbyeol\\versions\\0.1.34-test\\sr-electron.exe',
      env: {
        ELECTRON_RUN_AS_NODE: 'stale',
        Electron_Run_As_Node: 'stale-case-variant',
        PATH: 'C:\\Windows\\System32',
      },
      versions: {
        electron: '28.3.3',
      },
    };

    const options = buildNodeWorkerForkOptions({
      env: {
        SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
      },
    }, runtime);

    expect(isElectronRuntime(runtime)).toBe(true);
    expect(options.execPath).toBe(runtime.execPath);
    expect(options.env).toEqual(expect.objectContaining({
      PATH: 'C:\\Windows\\System32',
      SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
      ELECTRON_RUN_AS_NODE: '1',
    }));
    expect(options.env.Electron_Run_As_Node).toBeUndefined();
  });

  test('does not force electron-as-node for plain Node test/runtime workers', () => {
    const runtime = {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: {
        ELECTRON_RUN_AS_NODE: 'stale',
        PATH: 'C:\\Windows\\System32',
      },
      versions: {
        node: '18.18.2',
      },
    };

    const options = buildNodeWorkerForkOptions({
      env: {
        SQUIDRUN_EVIDENCE_LEDGER_WORKER: '1',
      },
    }, runtime);

    expect(isElectronRuntime(runtime)).toBe(false);
    expect(options.execPath).toBeUndefined();
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.SQUIDRUN_EVIDENCE_LEDGER_WORKER).toBe('1');
  });
});
