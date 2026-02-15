const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf-8').digest('hex');
}

function extractRedirectPath(command, streamNumber) {
  const pattern = new RegExp(`${streamNumber}>\\s+\"([^\"]+)\"`);
  const match = String(command || '').match(pattern);
  return match ? match[1] : null;
}

async function waitForStatus(runtime, runId, expectedStatus, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = runtime.getExperiment({ runId });
    if (snapshot?.ok && snapshot?.experiment?.status === expectedStatus) {
      return snapshot.experiment;
    }
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${expectedStatus} on ${runId}`);
}

async function waitForOneOfStatuses(runtime, runId, statuses, timeoutMs = 2000) {
  const statusSet = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = runtime.getExperiment({ runId });
    if (snapshot?.ok && statusSet.has(snapshot.experiment?.status)) {
      return snapshot.experiment;
    }
    await wait(10);
  }
  throw new Error(`Timed out waiting for one of [${statuses.join(', ')}] on ${runId}`);
}

maybeDescribe('experiment runtime isolation (phase6d)', () => {
  let tempDir;
  let dbPath;
  let artifactRoot;
  let profilesPath;
  let spawnSyncMock;
  let pendingExits;
  let deferExit;
  let mockExitCode;
  let ptyPidCounter;
  let ExperimentRuntime;
  let runtime;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-experiment-isolation-'));
    dbPath = path.join(tempDir, 'team-memory.sqlite');
    artifactRoot = path.join(tempDir, 'artifacts');
    profilesPath = path.join(tempDir, 'experiment-profiles.json');
    pendingExits = [];
    deferExit = false;
    mockExitCode = 0;
    ptyPidCounter = 9000;

    fs.writeFileSync(
      profilesPath,
      `${JSON.stringify({
        isolation: {
          command: 'echo isolation',
          timeoutMs: 200,
          cwd: tempDir,
          params: [],
        },
      }, null, 2)}\n`,
      'utf-8'
    );

    jest.doMock('child_process', () => {
      const actual = jest.requireActual('child_process');
      spawnSyncMock = jest.fn();
      return {
        ...actual,
        spawnSync: spawnSyncMock,
        execFileSync: jest.fn(() => ''),
      };
    });

    jest.doMock('node-pty', () => ({
      spawn: jest.fn((shell, args) => {
        const pid = ptyPidCounter++;
        const command = Array.isArray(args) ? String(args[args.length - 1] || '') : '';
        const rawStdoutPath = extractRedirectPath(command, 1);
        const rawStderrPath = extractRedirectPath(command, 2);

        if (rawStdoutPath) fs.writeFileSync(rawStdoutPath, `stdout from pid ${pid}\n`, 'utf-8');
        if (rawStderrPath) fs.writeFileSync(rawStderrPath, `stderr from pid ${pid}\n`, 'utf-8');

        return {
          pid,
          onExit: (cb) => {
            if (deferExit) {
              pendingExits.push({ cb, pid });
              return;
            }
            setImmediate(() => cb({ exitCode: mockExitCode }));
          },
        };
      }),
    }));

    jest.doMock('../modules/main/evidence-ledger-store', () => ({
      EvidenceLedgerStore: class MockEvidenceLedgerStore {
        init() {
          return { ok: true };
        }
        appendEvent(event) {
          return { ok: true, status: 'inserted', eventId: event.eventId };
        }
        close() {}
      },
    }));

    ({ ExperimentRuntime } = require('../modules/experiment/runtime'));
    runtime = new ExperimentRuntime({
      dbPath,
      artifactRoot,
      profilesPath,
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
    });
    expect(runtime.init({}).ok).toBe(true);
  });

  afterEach(() => {
    if (runtime) runtime.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('spawns PTY, captures stdout/stderr artifacts, and persists hashes', async () => {
    const created = runtime.createExperiment({
      profileId: 'isolation',
      requestedBy: 'builder',
      session: 's_phase6d',
      input: {},
    });
    expect(created.ok).toBe(true);

    const experiment = await waitForStatus(runtime, created.runId, 'succeeded');
    const stdoutPath = path.join(experiment.artifactDir, 'stdout.log');
    const stderrPath = path.join(experiment.artifactDir, 'stderr.log');
    const stdout = fs.readFileSync(stdoutPath, 'utf-8');
    const stderr = fs.readFileSync(stderrPath, 'utf-8');

    expect(stdout).toContain('stdout from pid');
    expect(stderr).toContain('stderr from pid');

    const dbRow = runtime.store.db.prepare(`
      SELECT stdout_hash, stderr_hash
      FROM experiments
      WHERE id = ?
    `).get(created.runId);
    expect(dbRow.stdout_hash).toBe(sha256(stdout));
    expect(dbRow.stderr_hash).toBe(sha256(stderr));
  });

  test('enforces timeout and kills process tree', async () => {
    deferExit = true;

    const processKillSpy = process.platform === 'win32'
      ? null
      : jest.spyOn(process, 'kill').mockImplementation(() => true);

    const created = runtime.createExperiment({
      profileId: 'isolation',
      requestedBy: 'builder',
      timeoutMs: 25,
      input: {},
    });
    expect(created.ok).toBe(true);
    expect(created.status).toBe('running');

    await wait(60);

    if (process.platform === 'win32') {
      expect(spawnSyncMock).toHaveBeenCalledWith(
        'taskkill',
        expect.arrayContaining(['/T', '/F']),
        expect.any(Object)
      );
    } else {
      expect(spawnSyncMock).toHaveBeenCalledWith(
        'pkill',
        expect.arrayContaining(['-TERM', '-P']),
        expect.any(Object)
      );
      expect(processKillSpy).toHaveBeenCalled();
    }

    const pending = pendingExits.shift();
    expect(pending).toBeDefined();
    pending.cb({ exitCode: 1 });

    const experiment = await waitForStatus(runtime, created.runId, 'timed_out');
    expect(experiment.status).toBe('timed_out');

    if (processKillSpy) processKillSpy.mockRestore();
  });

  test('allows only one active run at a time and queues additional runs', async () => {
    deferExit = true;
    const pty = require('node-pty');

    const first = runtime.createExperiment({
      profileId: 'isolation',
      requestedBy: 'builder',
      idempotencyKey: 'exp-iso-first',
      input: {},
    });
    const second = runtime.createExperiment({
      profileId: 'isolation',
      requestedBy: 'builder',
      idempotencyKey: 'exp-iso-second',
      input: {},
    });

    expect(first.ok).toBe(true);
    expect(first.status).toBe('running');
    expect(second.ok).toBe(true);
    expect(second.queued).toBe(true);
    expect(pty.spawn).toHaveBeenCalledTimes(1);

    const firstPending = pendingExits.shift();
    expect(firstPending).toBeDefined();
    firstPending.cb({ exitCode: 0 });

    await waitForOneOfStatuses(runtime, second.runId, ['running', 'succeeded']);
    expect(pty.spawn).toHaveBeenCalledTimes(2);

    const secondPending = pendingExits.shift();
    if (secondPending) {
      secondPending.cb({ exitCode: 0 });
    }
    await waitForStatus(runtime, second.runId, 'succeeded');
  });
});
