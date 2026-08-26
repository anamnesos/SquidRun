'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegularSource(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new Error('belief_snapshot_source_path_required');
  }
  const resolved = path.resolve(String(sourcePath || ''));
  const stat = lstatOrNull(resolved);
  if (!stat) {
    throw new Error(`belief_snapshot_source_missing:${resolved}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`belief_snapshot_source_not_regular_file:${resolved}`);
  }
  if (normalizedPath(fs.realpathSync(resolved)) !== normalizedPath(resolved)) {
    throw new Error(`belief_snapshot_source_is_reparse_path:${resolved}`);
  }
  return resolved;
}

function assertFreshCandidatePath(sourcePath, outputPath) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new Error('belief_snapshot_candidate_path_required');
  }
  const resolved = path.resolve(String(outputPath || ''));
  if (normalizedPath(sourcePath) === normalizedPath(resolved)) {
    throw new Error('belief_snapshot_candidate_must_not_replace_source');
  }
  if (lstatOrNull(resolved)) {
    throw new Error(`belief_snapshot_candidate_already_exists:${resolved}`);
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`belief_snapshot_candidate_parent_missing:${parent}`);
  }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`belief_snapshot_candidate_parent_not_regular:${parent}`);
  }
  if (normalizedPath(fs.realpathSync(parent)) !== normalizedPath(parent)) {
    throw new Error(`belief_snapshot_candidate_parent_is_reparse_path:${parent}`);
  }
  return resolved;
}

function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameFileIdentity(stat, expected) {
  return !expected || (
    String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino
  );
}

function sourceMainFilePhase(sourcePath, expectedIdentity, phase) {
  const stat = lstatOrNull(sourcePath);
  if (
    !stat
    || !stat.isFile()
    || stat.isSymbolicLink()
    || normalizedPath(fs.realpathSync(sourcePath)) !== normalizedPath(sourcePath)
    || !sameFileIdentity(stat, expectedIdentity)
  ) {
    throw new Error(`belief_snapshot_source_identity_changed:${phase}`);
  }
  return stat;
}

function mainFileStat(stat) {
  return { bytes: stat.size, mtimeMs: stat.mtimeMs };
}

function sameMainFileStat(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function classifySourceStatDrift(start, postVacuum, final) {
  return {
    sourceStatChangedDuringSnapshot: !sameMainFileStat(start, postVacuum),
    sourceStatChangedAfterSnapshot: !sameMainFileStat(postVacuum, final),
    sourceStatChangedAcrossBuild: !sameMainFileStat(start, final),
  };
}

function removeSafeRegularFile(filePath, expectedIdentity = null) {
  const stat = lstatOrNull(filePath);
  if (!stat) return true;
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if (normalizedPath(fs.realpathSync(filePath)) !== normalizedPath(filePath)) return false;
  if (!sameFileIdentity(stat, expectedIdentity)) return false;
  fs.rmSync(filePath, { force: true });
  return !lstatOrNull(filePath);
}

function createWorkingLocation(outputPath) {
  const rootPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.building-${process.pid}-${crypto.randomUUID()}`
  );
  fs.mkdirSync(rootPath, { recursive: false });
  const stat = fs.lstatSync(rootPath);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || normalizedPath(fs.realpathSync(rootPath)) !== normalizedPath(rootPath)
  ) {
    throw new Error(`belief_snapshot_work_root_not_regular:${rootPath}`);
  }
  return {
    rootPath,
    databasePath: path.join(rootPath, 'candidate.sqlite'),
  };
}

function removeOwnedWorkingLocation(rootPath, databasePath) {
  const rootStat = lstatOrNull(rootPath);
  if (!rootStat) return true;
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || normalizedPath(fs.realpathSync(rootPath)) !== normalizedPath(rootPath)
  ) {
    return false;
  }
  for (const filePath of [
    databasePath,
    `${databasePath}-journal`,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ]) {
    try { removeSafeRegularFile(filePath); } catch {}
  }
  if (fs.readdirSync(rootPath).length !== 0) return false;
  fs.rmdirSync(rootPath);
  return !lstatOrNull(rootPath);
}

function cleanupFailure(originalError, messages) {
  const cleanupErrors = messages.map((message) => new Error(message));
  return new AggregateError(
    [originalError, ...cleanupErrors],
    messages.join(','),
    { cause: originalError }
  );
}

function publishVerifiedCandidate(workingPath, outputPath, expectedIdentity) {
  if (lstatOrNull(outputPath)) {
    throw new Error(`belief_snapshot_candidate_already_exists:${outputPath}`);
  }
  try {
    fs.linkSync(workingPath, outputPath);
    const outputStat = fs.lstatSync(outputPath);
    if (
      !outputStat.isFile()
      || outputStat.isSymbolicLink()
      || !sameFileIdentity(outputStat, expectedIdentity)
    ) {
      throw new Error('belief_snapshot_candidate_publish_identity_mismatch');
    }
    fs.unlinkSync(workingPath);
  } catch (error) {
    try { removeSafeRegularFile(outputPath, expectedIdentity); } catch {}
    throw error;
  }
}

function exactStatement(db, sql) {
  const statement = db.prepare(sql);
  if (typeof statement.setReadBigInts !== 'function') {
    throw new Error('belief_snapshot_bigint_reads_unavailable');
  }
  statement.setReadBigInts(true);
  return statement;
}

function jsonSafeExactValue(value) {
  if (typeof value === 'bigint') return { sqliteInteger: value.toString() };
  if (value instanceof Uint8Array) {
    return {
      sqliteBlobBase64: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      ).toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(jsonSafeExactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafeExactValue(entry)])
    );
  }
  return value;
}

function boundedCount(value, label) {
  let exact;
  if (typeof value === 'bigint') exact = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) exact = BigInt(value);
  else throw new Error(`belief_snapshot_invalid_bounded_count:${label}`);
  if (exact < 0n || exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`belief_snapshot_count_out_of_range:${label}`);
  }
  return Number(exact);
}

function exactIntegerText(value, label) {
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error(`belief_snapshot_invalid_exact_integer:${label}`);
}

function readRows(db, sql) {
  return exactStatement(db, sql).all()
    .map((row) => jsonSafeExactValue({ ...row }));
}

function digestRows(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function digestFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function normalizeSqlValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['real', 'NaN'];
    if (Object.is(value, -0)) return ['real', '-0'];
    return ['number', String(value)];
  }
  if (typeof value === 'string') return ['text', value];
  if (value instanceof Uint8Array) {
    return [
      'blob',
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    ];
  }
  throw new Error(`belief_snapshot_unsupported_sql_value:${typeof value}`);
}

function digestTableRows(db, tableName) {
  const rowDigests = [];
  const statement = exactStatement(db, `SELECT * FROM ${quoteIdentifier(tableName)}`);
  for (const row of statement.iterate()) {
    const normalized = Object.entries(row)
      .map(([column, value]) => [column, normalizeSqlValue(value)]);
    rowDigests.push(
      crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    );
  }
  rowDigests.sort();
  return {
    count: rowDigests.length,
    sha256: digestRows(rowDigests),
  };
}

function readTransitionRows(db) {
  return readRows(db, `
    WITH ordered AS (
      SELECT
        id,
        agent,
        session,
        snapshot_at,
        beliefs,
        LAG(beliefs) OVER (
          PARTITION BY agent, session
          ORDER BY snapshot_at, id
        ) AS previous_beliefs
      FROM belief_snapshots
    )
    SELECT id, agent, session, snapshot_at, beliefs
    FROM ordered
    WHERE previous_beliefs IS NULL OR beliefs <> previous_beliefs
    ORDER BY agent, session, snapshot_at, id
  `);
}

function readNewestRows(db) {
  return readRows(db, `
    WITH ranked AS (
      SELECT
        id,
        agent,
        session,
        snapshot_at,
        beliefs,
        ROW_NUMBER() OVER (
          PARTITION BY agent, session
          ORDER BY snapshot_at DESC, id DESC
        ) AS rank
      FROM belief_snapshots
    )
    SELECT id, agent, session, snapshot_at, beliefs
    FROM ranked
    WHERE rank = 1
    ORDER BY agent, session, snapshot_at, id
  `);
}

function readReferencedRows(db) {
  return readRows(db, `
    SELECT DISTINCT
      snapshot.id,
      snapshot.agent,
      snapshot.session,
      snapshot.snapshot_at,
      snapshot.beliefs
    FROM belief_snapshots AS snapshot
    INNER JOIN belief_contradictions AS contradiction
      ON contradiction.snapshot_id = snapshot.id
    ORDER BY snapshot.agent, snapshot.session, snapshot.snapshot_at, snapshot.id
  `);
}

function readForeignKeyViolations(db) {
  return readRows(db, 'PRAGMA foreign_key_check')
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function readSchemaDigest(db) {
  const rows = readRows(db, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `);
  return { count: rows.length, sha256: digestRows(rows) };
}

function readNonBeliefTableState(db) {
  const tables = readRows(db, `
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name <> 'belief_snapshots'
    ORDER BY name
  `);
  return tables.map(({ name }) => {
    const digest = digestTableRows(db, name);
    return { table: name, ...digest };
  });
}

function inspectBeliefSnapshotState(db) {
  const metrics = exactStatement(db, `
    SELECT
      COUNT(*) AS row_count,
      COUNT(DISTINCT beliefs) AS distinct_payloads,
      MIN(snapshot_at) AS first_snapshot_at,
      MAX(snapshot_at) AS last_snapshot_at
    FROM belief_snapshots
  `).get();
  const transitions = readTransitionRows(db);
  const newest = readNewestRows(db);
  const referenced = readReferencedRows(db);
  const keepIds = new Set([
    ...transitions.map((row) => row.id),
    ...newest.map((row) => row.id),
    ...referenced.map((row) => row.id),
  ]);
  const integrity = readRows(db, 'PRAGMA integrity_check')
    .map((row) => String(Object.values(row)[0]));
  return {
    metrics: {
      rowCount: boundedCount(metrics.row_count, 'row_count'),
      distinctPayloads: boundedCount(metrics.distinct_payloads, 'distinct_payloads'),
      firstSnapshotAt: exactIntegerText(metrics.first_snapshot_at, 'first_snapshot_at'),
      lastSnapshotAt: exactIntegerText(metrics.last_snapshot_at, 'last_snapshot_at'),
      transitionCount: transitions.length,
      newestCount: newest.length,
      referencedCount: referenced.length,
      keepCount: keepIds.size,
      deleteCount: boundedCount(metrics.row_count, 'row_count') - keepIds.size,
    },
    keepIds: [...keepIds].sort(),
    transitionSha256: digestRows(transitions),
    newestSha256: digestRows(newest),
    referencedSha256: digestRows(referenced),
    schema: readSchemaDigest(db),
    nonBeliefTableState: readNonBeliefTableState(db),
    integrity,
    foreignKeyViolations: readForeignKeyViolations(db),
  };
}

function planBeliefSnapshotPrune(options = {}) {
  const sourcePath = assertRegularSource(options.sourcePath);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const state = inspectBeliefSnapshotState(db);
    return {
      ok: true,
      mode: 'plan',
      sourcePath,
      ...state,
      sourceMutated: false,
      candidateCreated: false,
      prunePerformed: false,
    };
  } finally {
    db.close();
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyCandidate(before, after) {
  const checks = {
    rowCountMatchesKeepSet: after.metrics.rowCount === before.metrics.keepCount,
    allCandidateRowsProtected: after.metrics.deleteCount === 0,
    distinctPayloadsPreserved: after.metrics.distinctPayloads === before.metrics.distinctPayloads,
    timelineBoundsPreserved: (
      after.metrics.firstSnapshotAt === before.metrics.firstSnapshotAt
      && after.metrics.lastSnapshotAt === before.metrics.lastSnapshotAt
    ),
    transitionsPreserved: after.transitionSha256 === before.transitionSha256,
    newestPerSessionPreserved: after.newestSha256 === before.newestSha256,
    contradictionReferencesPreserved: after.referencedSha256 === before.referencedSha256,
    keepSetExact: sameJson(after.keepIds, before.keepIds),
    schemaPreserved: sameJson(after.schema, before.schema),
    nonBeliefStatePreserved: sameJson(after.nonBeliefTableState, before.nonBeliefTableState),
    foreignKeyBaselinePreserved: sameJson(after.foreignKeyViolations, before.foreignKeyViolations),
    integrityOk: after.integrity.length === 1 && after.integrity[0] === 'ok',
  };
  return {
    checks,
    ok: Object.values(checks).every(Boolean),
  };
}

function buildBeliefSnapshotCandidate(options = {}) {
  const sourcePath = assertRegularSource(options.sourcePath);
  const outputPath = assertFreshCandidatePath(sourcePath, options.outputPath);
  if (options.snapshotInto !== undefined) {
    throw new Error('belief_snapshot_snapshot_override_forbidden');
  }
  if (
    options.injectFailureAfterSnapshot !== undefined
    && typeof options.injectFailureAfterSnapshot !== 'function'
  ) {
    throw new Error('belief_snapshot_failure_injection_must_be_function');
  }
  const sourceStart = sourceMainFilePhase(sourcePath, null, 'start');
  const sourceIdentity = fileIdentity(sourceStart);
  const working = createWorkingLocation(outputPath);
  const workingPath = working.databasePath;
  let outputPublished = false;
  let publishedIdentity = null;
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO ${sqlStringLiteral(workingPath)};`);
      if (options.injectFailureAfterSnapshot) {
        let injectedCause;
        try {
          options.injectFailureAfterSnapshot(workingPath);
        } catch (error) {
          injectedCause = error;
        }
        throw new Error(
          'belief_snapshot_injected_failure_after_snapshot',
          injectedCause ? { cause: injectedCause } : undefined
        );
      }
    } finally {
      source.close();
    }
    const sourcePostVacuum = sourceMainFilePhase(
      sourcePath,
      sourceIdentity,
      'post_vacuum'
    );

    const candidate = new DatabaseSync(workingPath);
    let before;
    let after;
    try {
      candidate.exec('PRAGMA busy_timeout=15000;');
      before = inspectBeliefSnapshotState(candidate);
      candidate.exec('BEGIN IMMEDIATE;');
      try {
        candidate.exec('CREATE TEMP TABLE keep_belief_snapshot_ids (id TEXT PRIMARY KEY);');
        const insert = candidate.prepare('INSERT INTO keep_belief_snapshot_ids (id) VALUES (?)');
        for (const id of before.keepIds) insert.run(id);
        candidate.exec(`
          DELETE FROM belief_snapshots
          WHERE id NOT IN (SELECT id FROM keep_belief_snapshot_ids);
        `);
        candidate.exec('COMMIT;');
      } catch (error) {
        try { candidate.exec('ROLLBACK;'); } catch {}
        throw error;
      }
      candidate.exec('VACUUM;');
      after = inspectBeliefSnapshotState(candidate);
    } finally {
      candidate.close();
    }

    const verification = verifyCandidate(before, after);
    if (!verification.ok) {
      const failed = Object.entries(verification.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      throw new Error(`belief_snapshot_candidate_verification_failed:${failed.join(',')}`);
    }

    const candidateStat = fs.statSync(workingPath);
    const candidateSha256 = digestFile(workingPath);
    const sourceFinal = sourceMainFilePhase(sourcePath, sourceIdentity, 'final');
    const sourceStatDrift = classifySourceStatDrift(
      sourceStart,
      sourcePostVacuum,
      sourceFinal
    );
    publishedIdentity = fileIdentity(fs.lstatSync(workingPath));
    publishVerifiedCandidate(workingPath, outputPath, publishedIdentity);
    outputPublished = true;
    if (!removeOwnedWorkingLocation(working.rootPath, workingPath)) {
      throw new Error(`belief_snapshot_work_root_cleanup_refused:${working.rootPath}`);
    }
    return {
      ok: true,
      mode: 'build',
      sourcePath,
      outputPath,
      sourceMainFileStats: {
        start: mainFileStat(sourceStart),
        postVacuum: mainFileStat(sourcePostVacuum),
        final: mainFileStat(sourceFinal),
      },
      ...sourceStatDrift,
      sourceFileIdentity: sourceIdentity,
      sourceFileIdentityUnchanged: true,
      sourceOpenedReadOnly: true,
      liveDatabaseWrittenByBuilder: false,
      sourceMainFileStatDriftObserved: (
        sourceStatDrift.sourceStatChangedDuringSnapshot
        || sourceStatDrift.sourceStatChangedAfterSnapshot
      ),
      candidateIsPointInTimeSnapshot: true,
      candidateCurrentnessAgainstLiveNotEstablished: true,
      candidateBytes: candidateStat.size,
      candidateSha256,
      candidatePublishedAfterVerification: true,
      before,
      after,
      verification,
      candidateCreated: true,
      liveSwapPerformed: false,
    };
  } catch (error) {
    const cleanupMessages = [];
    try {
      if (!removeOwnedWorkingLocation(working.rootPath, workingPath)) {
        cleanupMessages.push(`belief_snapshot_work_root_cleanup_refused:${working.rootPath}`);
      }
    } catch {
      cleanupMessages.push(`belief_snapshot_work_root_cleanup_refused:${working.rootPath}`);
    }
    if (outputPublished) {
      try {
        if (!removeSafeRegularFile(outputPath, publishedIdentity)) {
          cleanupMessages.push(`belief_snapshot_published_candidate_cleanup_refused:${outputPath}`);
        }
      } catch {
        cleanupMessages.push(`belief_snapshot_published_candidate_cleanup_refused:${outputPath}`);
      }
    }
    if (cleanupMessages.length > 0) throw cleanupFailure(error, cleanupMessages);
    throw error;
  }
}

module.exports = {
  buildBeliefSnapshotCandidate,
  inspectBeliefSnapshotState,
  planBeliefSnapshotPrune,
  verifyCandidate,
};
