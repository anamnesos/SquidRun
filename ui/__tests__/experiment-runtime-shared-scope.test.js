const fs = require('fs');
const os = require('os');
const path = require('path');

const experimentRuntime = require('../modules/experiment/runtime');
const { loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('experiment runtime shared scope', () => {
  let tempDir;
  let profilesPath;

  function buildRuntimeOptions(suffix) {
    return {
      dbPath: path.join(tempDir, `team-memory-${suffix}.sqlite`),
      artifactRoot: path.join(tempDir, `artifacts-${suffix}`),
      profilesPath,
      evidenceLedgerDbPath: path.join(tempDir, `evidence-ledger-${suffix}.db`),
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-exp-runtime-shared-'));
    profilesPath = path.join(tempDir, 'experiment-profiles.json');
    fs.writeFileSync(
      profilesPath,
      `${JSON.stringify({
        smoke: {
          command: 'echo smoke',
          timeoutMs: 5000,
          cwd: tempDir,
          params: [],
        },
      }, null, 2)}\n`,
      'utf-8'
    );
  });

  afterEach(() => {
    experimentRuntime.closeSharedRuntime();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('recreates shared runtime when dbPath changes across calls', () => {
    const firstOptions = buildRuntimeOptions('a');
    const secondOptions = buildRuntimeOptions('b');

    const init = experimentRuntime.initializeExperimentRuntime({
      runtimeOptions: firstOptions,
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);
    expect(init.status.dbStatus.dbPath).toBe(firstOptions.dbPath);

    const health = experimentRuntime.executeExperimentOperation('health', {}, {
      runtimeOptions: secondOptions,
    });
    expect(health.ok).toBe(true);
    expect(health.dbStatus.dbPath).toBe(secondOptions.dbPath);
    expect(health.dbStatus.dbPath).not.toBe(firstOptions.dbPath);
  });
});
