const fs = require('fs');
const os = require('os');
const path = require('path');

const { setProjectRoot, resetProjectRoot } = require('../config');
const experimentRuntime = require('../modules/experiment/runtime');

function runtimeCoordRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), '.hivemind', 'runtime');
}

describe('experiment runtime default path resolution', () => {
  let projectA;
  let projectB;

  beforeEach(() => {
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-exp-path-a-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-exp-path-b-'));
  });

  afterEach(() => {
    experimentRuntime.closeSharedRuntime();
    resetProjectRoot();
    if (projectA) fs.rmSync(projectA, { recursive: true, force: true });
    if (projectB) fs.rmSync(projectB, { recursive: true, force: true });
  });

  test('constructor fallbacks track project root changes after module import', () => {
    setProjectRoot(projectA);
    const runtimeA = new experimentRuntime.ExperimentRuntime({});
    const rootA = runtimeCoordRoot(projectA);
    expect(runtimeA.dbPath).toBe(path.join(rootA, 'team-memory.sqlite'));
    expect(runtimeA.artifactRoot).toBe(path.join(rootA, 'experiments'));
    expect(runtimeA.profilesPath).toBe(path.join(rootA, 'experiment-profiles.json'));
    expect(runtimeA.evidenceLedgerDbPath).toBe(path.join(rootA, 'evidence-ledger.db'));

    setProjectRoot(projectB);
    const runtimeB = new experimentRuntime.ExperimentRuntime({});
    const rootB = runtimeCoordRoot(projectB);
    expect(runtimeB.dbPath).toBe(path.join(rootB, 'team-memory.sqlite'));
    expect(runtimeB.artifactRoot).toBe(path.join(rootB, 'experiments'));
    expect(runtimeB.profilesPath).toBe(path.join(rootB, 'experiment-profiles.json'));
    expect(runtimeB.evidenceLedgerDbPath).toBe(path.join(rootB, 'evidence-ledger.db'));
  });
});
