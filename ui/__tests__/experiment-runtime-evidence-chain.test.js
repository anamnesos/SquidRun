const fs = require('fs');
const os = require('os');
const path = require('path');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('experiment runtime evidence chain (phase6b)', () => {
  let tempDir;
  let dbPath;
  let artifactRoot;
  let profilesPath;
  let ledgerEvents;
  let mockExitCode;
  let TeamMemoryStore;
  let TeamMemoryClaims;
  let ExperimentRuntime;
  let bootstrapStore;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-experiment-runtime-'));
    dbPath = path.join(tempDir, 'team-memory.sqlite');
    artifactRoot = path.join(tempDir, 'artifacts');
    profilesPath = path.join(tempDir, 'experiment-profiles.json');
    ledgerEvents = [];
    mockExitCode = 0;

    fs.writeFileSync(
      profilesPath,
      `${JSON.stringify({
        'jest-suite': {
          command: 'echo test',
          timeoutMs: 2000,
          cwd: tempDir,
          params: [],
        },
      }, null, 2)}\n`,
      'utf-8'
    );

    jest.doMock('node-pty', () => ({
      spawn: jest.fn(() => ({
        pid: 4242,
        onExit: (cb) => setImmediate(() => cb({ exitCode: mockExitCode })),
      })),
    }));

    jest.doMock('../modules/main/evidence-ledger-store', () => ({
      EvidenceLedgerStore: class MockEvidenceLedgerStore {
        constructor() {
          this.available = true;
        }
        init() {
          return { ok: true };
        }
        appendEvent(event) {
          ledgerEvents.push(event);
          return { ok: true, status: 'inserted', eventId: event.eventId };
        }
        close() {}
      },
    }));

    ({ TeamMemoryStore } = require('../modules/team-memory/store'));
    ({ TeamMemoryClaims } = require('../modules/team-memory/claims'));
    ({ ExperimentRuntime } = require('../modules/experiment/runtime'));
  });

  afterEach(() => {
    if (bootstrapStore) bootstrapStore.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function waitForStatus(runtime, runId, expectedStatus, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = runtime.getExperiment({ runId });
      if (snapshot?.ok && snapshot?.experiment?.status === expectedStatus) {
        return snapshot.experiment;
      }
      await wait(10);
    }
    throw new Error(`Timed out waiting for ${expectedStatus}`);
  }

  test('creates experiment.completed ledger event and auto-attaches evidence on success', async () => {
    bootstrapStore = new TeamMemoryStore({ dbPath });
    expect(bootstrapStore.init().ok).toBe(true);
    const claims = new TeamMemoryClaims(bootstrapStore.db);
    const created = claims.createClaim({
      statement: 'Contested claim for experiment proof',
      owner: 'oracle',
      status: 'contested',
      session: 's_phase6b',
      scopes: ['ui/modules/triggers.js'],
    });
    expect(created.ok).toBe(true);
    const claimId = created.claim.id;
    const pending = claims.updateClaimStatus(claimId, 'pending_proof', 'system', 'guard_block_experiment_started');
    expect(pending.ok).toBe(true);
    bootstrapStore.close();
    bootstrapStore = null;

    const runtime = new ExperimentRuntime({
      dbPath,
      artifactRoot,
      profilesPath,
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
    });
    const init = runtime.init({});
    expect(init.ok).toBe(true);

    const createdRun = runtime.createExperiment({
      profileId: 'jest-suite',
      claimId,
      requestedBy: 'builder',
      session: 's_phase6b',
      idempotencyKey: 'exp-success-1',
      guardContext: {
        guardId: 'grd_1',
        action: 'block',
        blocking: true,
      },
      input: {},
    });
    expect(createdRun.ok).toBe(true);

    const experiment = await waitForStatus(runtime, createdRun.runId, 'attached');
    expect(experiment.attach.evidenceEventId).toMatch(/^evt_experiment_/);

    const claimRow = runtime.store.db.prepare('SELECT status FROM claims WHERE id = ?').get(claimId);
    expect(claimRow.status).toBe('confirmed');
    const evidenceRow = runtime.store.db.prepare(`
      SELECT evidence_ref, relation, added_by
      FROM claim_evidence
      WHERE claim_id = ?
      LIMIT 1
    `).get(claimId);
    expect(evidenceRow.evidence_ref).toBe(experiment.attach.evidenceEventId);
    expect(evidenceRow.relation).toBe('supports');
    expect(evidenceRow.added_by).toBe('builder');

    expect(ledgerEvents.length).toBeGreaterThanOrEqual(1);
    expect(ledgerEvents[0]).toEqual(
      expect.objectContaining({
        type: 'experiment.completed',
        payload: expect.objectContaining({
          runId: createdRun.runId,
          claimId,
          profileId: 'jest-suite',
          status: 'succeeded',
        }),
      })
    );

    runtime.close();
  });

  test('marks failed experiment evidence as contradicts and restores contested status', async () => {
    mockExitCode = 1;
    bootstrapStore = new TeamMemoryStore({ dbPath });
    expect(bootstrapStore.init().ok).toBe(true);
    const claims = new TeamMemoryClaims(bootstrapStore.db);
    const created = claims.createClaim({
      statement: 'Contested claim for failing experiment',
      owner: 'oracle',
      status: 'contested',
      session: 's_phase6b',
      scopes: ['ui/modules/injection.js'],
    });
    expect(created.ok).toBe(true);
    const claimId = created.claim.id;
    expect(claims.updateClaimStatus(claimId, 'pending_proof', 'system', 'guard_block_experiment_started').ok).toBe(true);
    bootstrapStore.close();
    bootstrapStore = null;

    const runtime = new ExperimentRuntime({
      dbPath,
      artifactRoot,
      profilesPath,
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
    });
    expect(runtime.init({}).ok).toBe(true);
    const createdRun = runtime.createExperiment({
      profileId: 'jest-suite',
      claimId,
      requestedBy: 'oracle',
      session: 's_phase6b',
      idempotencyKey: 'exp-fail-1',
      input: {},
    });
    expect(createdRun.ok).toBe(true);

    const experiment = await waitForStatus(runtime, createdRun.runId, 'attached');
    const evidenceRow = runtime.store.db.prepare(`
      SELECT relation
      FROM claim_evidence
      WHERE claim_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(claimId);
    expect(evidenceRow.relation).toBe('contradicts');
    const claimRow = runtime.store.db.prepare('SELECT status FROM claims WHERE id = ?').get(claimId);
    expect(claimRow.status).toBe('contested');
    expect(experiment.attach.evidenceEventId).toMatch(/^evt_experiment_/);

    runtime.close();
  });
});
