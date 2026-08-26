const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  buildBeliefSnapshotCandidate,
  planBeliefSnapshotPrune,
} = require('../modules/belief-snapshot-prune');

function makeFixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE belief_snapshots (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        session TEXT NOT NULL,
        snapshot_at INTEGER NOT NULL,
        beliefs TEXT NOT NULL
      );
      CREATE TABLE belief_contradictions (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES belief_snapshots(id) ON DELETE CASCADE,
        note TEXT NOT NULL
      );
      CREATE TABLE other_state (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        exact_int INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO belief_snapshots (id, agent, session, snapshot_at, beliefs)
      VALUES (?, ?, ?, ?, ?)
    `);
    const rows = [
      ['a1', 'architect', 's1', 1, 'A'],
      ['a2', 'architect', 's1', 2, 'A'],
      ['a3', 'architect', 's1', 3, 'A'],
      ['a4', 'architect', 's1', 4, 'B'],
      ['a5', 'architect', 's1', 5, 'B'],
      ['a6', 'architect', 's1', 6, 'B'],
      ['b1', 'builder', 's2', 1, 'X'],
      ['b2', 'builder', 's2', 2, 'X'],
      ['b3', 'builder', 's2', 3, 'Y'],
      ['o1', 'oracle', 's3', 9007199254740993n, 'Z'],
    ];
    for (const row of rows) insert.run(...row);
    db.prepare('INSERT INTO belief_contradictions (id, snapshot_id, note) VALUES (?, ?, ?)')
      .run('c1', 'a3', 'referenced duplicate must survive');
    db.prepare('INSERT INTO other_state (id, value, exact_int) VALUES (?, ?, ?)')
      .run('state-1', 'untouched', 9007199254740993n);
  } finally {
    db.close();
  }
}

function statWith(stat, overrides) {
  return new Proxy(stat, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('belief snapshot copy-only prune candidate', () => {
  let tempDir;
  let sourcePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-snapshot-prune-test-'));
    sourcePath = path.join(tempDir, 'source.sqlite');
    makeFixture(sourcePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('plans exact transition, newest, and contradiction-reference keep set without writes', () => {
    const before = fs.statSync(sourcePath);
    const plan = planBeliefSnapshotPrune({ sourcePath });
    const after = fs.statSync(sourcePath);

    expect(plan.metrics).toMatchObject({
      rowCount: 10,
      distinctPayloads: 5,
      transitionCount: 5,
      newestCount: 3,
      referencedCount: 1,
      keepCount: 7,
      deleteCount: 3,
    });
    expect(plan.keepIds).toEqual(['a1', 'a3', 'a4', 'a6', 'b1', 'b3', 'o1']);
    expect(plan.metrics.firstSnapshotAt).toBe('1');
    expect(plan.metrics.lastSnapshotAt).toBe('9007199254740993');
    expect(plan.candidateCreated).toBe(false);
    expect(plan.prunePerformed).toBe(false);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('builds a verified candidate while leaving source and non-belief state unchanged', () => {
    const outputPath = path.join(tempDir, 'candidate.sqlite');
    const sourceBefore = fs.statSync(sourcePath);
    const result = buildBeliefSnapshotCandidate({ sourcePath, outputPath });
    const sourceAfter = fs.statSync(sourcePath);

    expect(result.ok).toBe(true);
    expect(result.sourceOpenedReadOnly).toBe(true);
    expect(result.sourceFileIdentityUnchanged).toBe(true);
    expect(result.sourceStatChangedDuringSnapshot).toBe(false);
    expect(result.sourceStatChangedAfterSnapshot).toBe(false);
    expect(result.sourceStatChangedAcrossBuild).toBe(false);
    expect(result.liveDatabaseWrittenByBuilder).toBe(false);
    expect(result.sourceMainFileStatDriftObserved).toBe(false);
    expect(result.candidateIsPointInTimeSnapshot).toBe(true);
    expect(result.candidateCurrentnessAgainstLiveNotEstablished).toBe(true);
    expect(result.liveSwapPerformed).toBe(false);
    expect(result.candidatePublishedAfterVerification).toBe(true);
    expect(result.candidateSha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
    );
    expect(result.before.metrics.deleteCount).toBe(3);
    expect(result.after.metrics).toMatchObject({ rowCount: 7, keepCount: 7, deleteCount: 0 });
    expect(Object.values(result.verification.checks).every(Boolean)).toBe(true);
    expect(result.verification.checks.nonBeliefStatePreserved).toBe(true);
    expect(sourceAfter.size).toBe(sourceBefore.size);
    expect(sourceAfter.mtimeMs).toBe(sourceBefore.mtimeMs);

    const source = new DatabaseSync(sourcePath, { readOnly: true });
    const candidate = new DatabaseSync(outputPath, { readOnly: true });
    try {
      expect(source.prepare('SELECT COUNT(*) AS count FROM belief_snapshots').get().count).toBe(10);
      expect(candidate.prepare('SELECT id FROM belief_snapshots ORDER BY id').all().map((row) => row.id))
        .toEqual(['a1', 'a3', 'a4', 'a6', 'b1', 'b3', 'o1']);
      expect(candidate.prepare('SELECT snapshot_id FROM belief_contradictions').get().snapshot_id).toBe('a3');
      expect(candidate.prepare('SELECT value FROM other_state WHERE id = ?').get('state-1').value)
        .toBe('untouched');
      const exactInteger = candidate.prepare(
        'SELECT exact_int FROM other_state WHERE id = ?'
      );
      exactInteger.setReadBigInts(true);
      expect(exactInteger.get('state-1').exact_int).toBe(9007199254740993n);
    } finally {
      source.close();
      candidate.close();
    }
  });

  test('records WAL-style source stat drift without rejecting a coherent candidate', () => {
    const outputPath = path.join(tempDir, 'drift-candidate.sqlite');
    const originalLstat = fs.lstatSync;
    let sourceLstatCalls = 0;
    const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      const stat = originalLstat(filePath, ...args);
      if (path.resolve(String(filePath)) !== path.resolve(sourcePath)) return stat;
      sourceLstatCalls += 1;
      if (sourceLstatCalls === 3) return statWith(stat, { mtimeMs: stat.mtimeMs + 10 });
      if (sourceLstatCalls === 4) return statWith(stat, { mtimeMs: stat.mtimeMs + 20 });
      return stat;
    });
    let result;
    try {
      result = buildBeliefSnapshotCandidate({ sourcePath, outputPath });
    } finally {
      spy.mockRestore();
    }
    expect(result.ok).toBe(true);
    expect(result.sourceStatChangedDuringSnapshot).toBe(true);
    expect(result.sourceStatChangedAfterSnapshot).toBe(true);
    expect(result.sourceStatChangedAcrossBuild).toBe(true);
    expect(result.sourceFileIdentityUnchanged).toBe(true);
    expect(result.sourceMainFileStatDriftObserved).toBe(true);
    expect(result.candidateIsPointInTimeSnapshot).toBe(true);
    expect(result.candidateCurrentnessAgainstLiveNotEstablished).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  test.each(['missing', 'reparse'])(
    'leaves no work root when source is %s at the start identity check',
    (failureMode) => {
      const outputPath = path.join(tempDir, `start-${failureMode}-candidate.sqlite`);
      const originalLstat = fs.lstatSync;
      let sourceLstatCalls = 0;
      const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stat = originalLstat(filePath, ...args);
        if (path.resolve(String(filePath)) !== path.resolve(sourcePath)) return stat;
        sourceLstatCalls += 1;
        if (sourceLstatCalls !== 2) return stat;
        if (failureMode === 'reparse') {
          return statWith(stat, { isSymbolicLink: () => true });
        }
        const error = new Error('injected source disappearance');
        error.code = 'ENOENT';
        throw error;
      });
      try {
        expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath }))
          .toThrow('belief_snapshot_source_identity_changed:start');
      } finally {
        spy.mockRestore();
      }
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(tempDir).some((name) => name.includes('.building-'))).toBe(false);
    }
  );

  test('rejects a source ordinary-file identity change before publication', () => {
    const outputPath = path.join(tempDir, 'identity-change-candidate.sqlite');
    const originalLstat = fs.lstatSync;
    let sourceLstatCalls = 0;
    const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
      const stat = originalLstat(filePath, ...args);
      if (path.resolve(String(filePath)) !== path.resolve(sourcePath)) return stat;
      sourceLstatCalls += 1;
      if (sourceLstatCalls === 3) return statWith(stat, { ino: BigInt(stat.ino) + 1n });
      return stat;
    });
    try {
      expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath }))
        .toThrow('belief_snapshot_source_identity_changed:post_vacuum');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readdirSync(tempDir).some((name) => name.includes('.building-'))).toBe(false);
  });

  test('rejects and removes a candidate if pruning changes any non-belief row', () => {
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        CREATE TRIGGER mutate_other_state_after_belief_delete
        AFTER DELETE ON belief_snapshots
        BEGIN
          UPDATE other_state SET value = 'mutated';
        END;
      `);
    } finally {
      source.close();
    }
    const outputPath = path.join(tempDir, 'invalid-candidate.sqlite');
    expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath }))
      .toThrow('belief_snapshot_candidate_verification_failed:nonBeliefStatePreserved');
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readdirSync(tempDir).some((name) => name.includes('.building-'))).toBe(false);
    const sourceCheck = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      expect(sourceCheck.prepare('SELECT value FROM other_state WHERE id = ?').get('state-1').value)
        .toBe('untouched');
    } finally {
      sourceCheck.close();
    }
  });

  test('a returning failure-only seam cannot publish and removes its altered working file', () => {
    const outputPath = path.join(tempDir, 'partial-output.sqlite');
    let workingPath;
    expect(() => buildBeliefSnapshotCandidate({
      sourcePath,
      outputPath,
      injectFailureAfterSnapshot: (destinationPath) => {
        workingPath = destinationPath;
        fs.writeFileSync(destinationPath, 'partial');
      },
    })).toThrow('belief_snapshot_injected_failure_after_snapshot');
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(workingPath)).toBe(false);
    expect(fs.existsSync(path.dirname(workingPath))).toBe(false);
  });

  test('rejects a success-capable snapshot override before it can replace provenance', () => {
    const outputPath = path.join(tempDir, 'foreign-output.sqlite');
    const foreignPath = path.join(tempDir, 'foreign.sqlite');
    makeFixture(foreignPath);
    let overrideCalled = false;
    expect(() => buildBeliefSnapshotCandidate({
      sourcePath,
      outputPath,
      snapshotInto: (_source, destinationPath) => {
        overrideCalled = true;
        fs.copyFileSync(foreignPath, destinationPath);
      },
    })).toThrow('belief_snapshot_snapshot_override_forbidden');
    expect(overrideCalled).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readdirSync(tempDir).some((name) => name.includes('.building-'))).toBe(false);
  });

  test('refuses to follow or delete a reparse replacement during failed cleanup', () => {
    const outputPath = path.join(tempDir, 'reparse-output.sqlite');
    const foreignTarget = path.join(tempDir, 'foreign-target');
    fs.mkdirSync(foreignTarget);
    fs.writeFileSync(path.join(foreignTarget, 'keep.txt'), 'do-not-delete');
    let workingPath;
    let caught;
    try {
      buildBeliefSnapshotCandidate({
        sourcePath,
        outputPath,
        injectFailureAfterSnapshot: (destinationPath) => {
          workingPath = destinationPath;
          fs.unlinkSync(destinationPath);
          fs.symlinkSync(
            foreignTarget,
            destinationPath,
            process.platform === 'win32' ? 'junction' : 'dir'
          );
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.message).toBe(
      `belief_snapshot_work_root_cleanup_refused:${path.dirname(workingPath)}`
    );
    expect(caught.cause.message).toBe('belief_snapshot_injected_failure_after_snapshot');
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.lstatSync(workingPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(foreignTarget, 'keep.txt'), 'utf8')).toBe('do-not-delete');
    fs.unlinkSync(workingPath);
    fs.rmdirSync(path.dirname(workingPath));
  });

  test('refuses same-path or existing-output replacement', () => {
    expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath: '' }))
      .toThrow('belief_snapshot_candidate_path_required');
    expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath: sourcePath }))
      .toThrow('belief_snapshot_candidate_must_not_replace_source');

    const existing = path.join(tempDir, 'existing.sqlite');
    fs.writeFileSync(existing, 'do-not-overwrite');
    expect(() => buildBeliefSnapshotCandidate({ sourcePath, outputPath: existing }))
      .toThrow('belief_snapshot_candidate_already_exists');
    expect(fs.readFileSync(existing, 'utf8')).toBe('do-not-overwrite');
  });

  test('CLI help and plan are read-only and build writes only named fresh paths', () => {
    const cli = path.resolve(__dirname, '..', 'scripts', 'hm-belief-snapshot-prune.js');
    const before = fs.statSync(sourcePath);
    expect(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }))
      .toContain('never replaces, swaps, or deletes the source database');
    const plan = JSON.parse(execFileSync(
      process.execPath,
      [cli, 'plan', '--source', sourcePath],
      { encoding: 'utf8' }
    ));
    expect(plan.mode).toBe('plan');
    expect(plan.metrics.deleteCount).toBe(3);
    const forbiddenPlanReceipt = path.join(tempDir, 'plan-must-not-write.json');
    const rejected = spawnSync(
      process.execPath,
      [cli, 'plan', '--source', sourcePath, '--receipt', forbiddenPlanReceipt],
      { encoding: 'utf8' }
    );
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain('unknown_option:--receipt');
    expect(fs.existsSync(forbiddenPlanReceipt)).toBe(false);

    const outputPath = path.join(tempDir, 'cli-candidate.sqlite');
    const receiptPath = path.join(tempDir, 'cli-receipt.json');
    const built = JSON.parse(execFileSync(
      process.execPath,
      [cli, 'build', '--source', sourcePath, '--output', outputPath, '--receipt', receiptPath],
      { encoding: 'utf8' }
    ));
    expect(built.mode).toBe('build');
    expect(built.receiptPath).toBe(receiptPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).verification.ok).toBe(true);
    const after = fs.statSync(sourcePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const collisionPath = path.join(tempDir, 'candidate-receipt-collision.sqlite');
    const collision = spawnSync(
      process.execPath,
      [cli, 'build', '--source', sourcePath, '--output', collisionPath, '--receipt', collisionPath],
      { encoding: 'utf8' }
    );
    expect(collision.status).toBe(2);
    expect(collision.stderr).toContain('receipt_must_differ_from_candidate');
    expect(fs.existsSync(collisionPath)).toBe(false);
  });
});
