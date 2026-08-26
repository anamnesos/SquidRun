const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');
const { getDatabaseSync } = require('./sqlite-compat');

const DatabaseSync = getDatabaseSync();

const FREEZE_FILENAME = 'memory-metabolism-freeze.json';
const FREEZE_REASON = 'memory_metabolism_frozen';
const SLEEP_HOLD_VALUE_MS = Number.MAX_SAFE_INTEGER;
const COGNITIVE_TRIGGER_NAMES = Object.freeze([
  'memory_metabolism_freeze_pr_insert',
  'memory_metabolism_freeze_pr_update',
  'memory_metabolism_freeze_pr_delete',
  'memory_metabolism_freeze_sleep_run_insert',
  'memory_metabolism_freeze_sleep_run_update',
  'memory_metabolism_freeze_sleep_run_delete',
  'memory_metabolism_freeze_sleep_state_insert',
  'memory_metabolism_freeze_sleep_state_update',
  'memory_metabolism_freeze_sleep_state_delete',
]);
const SNAPSHOT_FINGERPRINT_TABLES = Object.freeze([
  'nodes',
  'edges',
  'traces',
  'memory_pr_queue',
  'antibody_queue',
  'agent_domain_trust',
  'transactive_meta',
  'sleep_cycle_runs',
]);

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureParent(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

function sqlStringLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveMemoryMetabolismFreezePath(options = {}) {
  if (options.statePath) return path.resolve(String(options.statePath));
  if (options.dbPath) return path.join(path.dirname(path.resolve(String(options.dbPath))), FREEZE_FILENAME);
  return path.resolve(resolveCoordPath(path.join('runtime', FREEZE_FILENAME), { forWrite: true }));
}

function readMemoryMetabolismFreeze(options = {}) {
  const statePath = resolveMemoryMetabolismFreezePath(options);
  if (!fs.existsSync(statePath)) {
    return { active: false, exists: false, statePath };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      ...parsed,
      active: parsed?.active === true,
      exists: true,
      statePath,
    };
  } catch (err) {
    // A damaged freeze marker must not silently reopen a retired write path.
    return {
      active: true,
      exists: true,
      malformed: true,
      reason: 'freeze_state_unreadable',
      error: err.message,
      statePath,
    };
  }
}

function frozenMutationResult(operation, extra = {}) {
  return {
    ok: true,
    accepted: false,
    skipped: true,
    frozen: true,
    reason: FREEZE_REASON,
    operation: String(operation || 'memory_mutation'),
    ...extra,
  };
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || '')));
}

function countRows(db, tableName) {
  if (!tableExists(db, tableName)) return null;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()?.count || 0);
}

function digestTable(db, tableName) {
  if (!tableExists(db, tableName)) return null;
  const hash = crypto.createHash('sha256');
  const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY rowid`);
  for (const row of statement.iterate()) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function cognitiveSnapshotFingerprint(db) {
  const tables = {};
  for (const tableName of SNAPSHOT_FINGERPRINT_TABLES) {
    tables[tableName] = {
      count: countRows(db, tableName),
      sha256: digestTable(db, tableName),
    };
  }
  return tables;
}

function fingerprintMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readMemoryPrStatusCounts(db) {
  if (!tableExists(db, 'memory_pr_queue')) return [];
  return db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_pr_queue
    GROUP BY status
    ORDER BY status
  `).all().map((row) => ({ status: String(row.status || ''), count: Number(row.count || 0) }));
}

function readPromotedMemoryPrs(db) {
  if (!tableExists(db, 'memory_pr_queue')) return [];
  return db.prepare(`
    SELECT *
    FROM memory_pr_queue
    WHERE status = 'promoted'
    ORDER BY updated_at_ms ASC, pr_id ASC
  `).all().map((row) => ({
    ...row,
    source_payload: (() => {
      try { return JSON.parse(row.source_payload_json || '{}'); } catch { return null; }
    })(),
    statement_sha256: crypto.createHash('sha256').update(String(row.statement || '')).digest('hex'),
  }));
}

function listInstalledCognitiveFreezeTriggers(db) {
  const placeholders = COGNITIVE_TRIGGER_NAMES.map(() => '?').join(', ');
  if (!placeholders) return [];
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${placeholders})
    ORDER BY name
  `).all(...COGNITIVE_TRIGGER_NAMES).map((row) => String(row.name));
}

function readSleepStateRow(db, stateKey) {
  if (!tableExists(db, 'sleep_cycle_state')) return null;
  return db.prepare(`
    SELECT state_key, state_value, updated_at_ms
    FROM sleep_cycle_state
    WHERE state_key = ?
    LIMIT 1
  `).get(String(stateKey || '')) || null;
}

function installCognitiveDatabaseBarrier(db, nowMs = Date.now()) {
  if (!tableExists(db, 'memory_pr_queue') || !tableExists(db, 'sleep_cycle_state') || !tableExists(db, 'sleep_cycle_runs')) {
    throw new Error('cognitive_memory_freeze_schema_missing');
  }
  const previousLastRun = readSleepStateRow(db, 'last_run_at_ms');

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO sleep_cycle_state (state_key, state_value, updated_at_ms)
      VALUES ('last_run_at_ms', ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        state_value = excluded.state_value,
        updated_at_ms = excluded.updated_at_ms
    `).run(String(SLEEP_HOLD_VALUE_MS), Number(nowMs));

    db.exec(`
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[0]}
      BEFORE INSERT ON memory_pr_queue
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[1]}
      BEFORE UPDATE ON memory_pr_queue
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[2]}
      BEFORE DELETE ON memory_pr_queue
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;

      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[3]}
      BEFORE INSERT ON sleep_cycle_runs
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[4]}
      BEFORE UPDATE ON sleep_cycle_runs
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[5]}
      BEFORE DELETE ON sleep_cycle_runs
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;

      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[6]}
      BEFORE INSERT ON sleep_cycle_state
      WHEN NEW.state_key IN ('last_run_at_ms', 'last_comms_row_id')
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[7]}
      BEFORE UPDATE ON sleep_cycle_state
      WHEN NEW.state_key IN ('last_run_at_ms', 'last_comms_row_id')
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
      CREATE TRIGGER ${COGNITIVE_TRIGGER_NAMES[8]}
      BEFORE DELETE ON sleep_cycle_state
      WHEN OLD.state_key IN ('last_run_at_ms', 'last_comms_row_id')
      BEGIN SELECT RAISE(ABORT, '${FREEZE_REASON}'); END;
    `);
    db.exec('COMMIT;');
    return { previousLastRun };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
}

function removeCognitiveDatabaseBarrier(db, priorState = {}) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const triggerName of COGNITIVE_TRIGGER_NAMES) {
      db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)};`);
    }
    const previousLastRun = priorState.previousLastRun || null;
    if (previousLastRun) {
      db.prepare(`
        INSERT INTO sleep_cycle_state (state_key, state_value, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          state_value = excluded.state_value,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        String(previousLastRun.state_key || 'last_run_at_ms'),
        previousLastRun.state_value == null ? null : String(previousLastRun.state_value),
        Number(previousLastRun.updated_at_ms || Date.now())
      );
    } else if (tableExists(db, 'sleep_cycle_state')) {
      db.prepare("DELETE FROM sleep_cycle_state WHERE state_key = 'last_run_at_ms'").run();
    }
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
}

function defaultArtifactDir(options = {}) {
  if (options.artifactDir) return path.resolve(String(options.artifactDir));
  const sessionSuffix = options.session ? `-s${String(options.session).replace(/[^a-z0-9_-]/gi, '')}` : '';
  return path.resolve(resolveCoordPath(path.join('coord', `memory-metabolism-freeze${sessionSuffix}`), { forWrite: true }));
}

function ensureFreshArtifactTargets(paths, options = {}) {
  fs.mkdirSync(paths.artifactDir, { recursive: true });
  for (const target of [paths.snapshotPath, paths.exportPath, paths.manifestPath]) {
    if (fs.existsSync(target) && options.force !== true) {
      throw new Error(`freeze_artifact_exists:${target}`);
    }
    if (fs.existsSync(target) && options.force === true) {
      fs.rmSync(target, { force: true });
    }
  }
}

function createCognitiveSnapshot(db, snapshotPath) {
  const tempPath = path.join(
    path.dirname(snapshotPath),
    `.${path.basename(snapshotPath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.rmSync(tempPath, { force: true });
    db.exec(`VACUUM INTO ${sqlStringLiteral(tempPath)};`);
    fs.renameSync(tempPath, snapshotPath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

function inspectMemoryMetabolismFreeze(options = {}) {
  const dbPath = path.resolve(String(options.dbPath || ''));
  const state = readMemoryMetabolismFreeze({
    dbPath,
    statePath: options.statePath,
  });
  const result = {
    ok: true,
    active: state.active === true,
    malformed: state.malformed === true,
    statePath: state.statePath,
    dbPath,
    installedTriggers: [],
    expectedTriggerCount: COGNITIVE_TRIGGER_NAMES.length,
    databaseBarrierActive: false,
    effectiveFrozen: false,
    state,
  };
  if (!dbPath || !fs.existsSync(dbPath)) return result;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    result.installedTriggers = listInstalledCognitiveFreezeTriggers(db);
    result.databaseBarrierActive = result.installedTriggers.length === COGNITIVE_TRIGGER_NAMES.length;
    result.sleepLastRunAtMs = readSleepStateRow(db, 'last_run_at_ms')?.state_value || null;
    result.memoryPrStatusCounts = readMemoryPrStatusCounts(db);
    result.effectiveFrozen = result.active && result.databaseBarrierActive;
    return result;
  } finally {
    db.close();
  }
}

function freezeMemoryMetabolism(options = {}) {
  const dbPath = path.resolve(String(options.dbPath || ''));
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`cognitive_memory_db_missing:${dbPath}`);
  }
  const statePath = resolveMemoryMetabolismFreezePath({ dbPath, statePath: options.statePath });
  const existingState = readMemoryMetabolismFreeze({ statePath });
  if (existingState.active === true) {
    return {
      ...inspectMemoryMetabolismFreeze({ dbPath, statePath }),
      alreadyFrozen: true,
    };
  }

  const artifactDir = defaultArtifactDir(options);
  const snapshotPath = path.join(artifactDir, 'cognitive-memory.pre-freeze.db');
  const exportPath = path.join(artifactDir, 'promoted-memories.json');
  const manifestPath = path.join(artifactDir, 'manifest.json');
  const paths = { artifactDir, snapshotPath, exportPath, manifestPath };
  ensureFreshArtifactTargets(paths, options);

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const evidenceWindowDays = Math.max(1, Number.parseInt(String(options.evidenceWindowDays || 30), 10) || 30);
  const reviewAfterMs = nowMs + (evidenceWindowDays * 24 * 60 * 60 * 1000);
  const expectedPromotedCount = options.expectedPromotedCount == null
    ? null
    : Math.max(0, Number.parseInt(String(options.expectedPromotedCount), 10) || 0);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000;');
  let barrier = null;
  let freezeState = null;
  let stateCommitted = false;

  try {
    createCognitiveSnapshot(db, snapshotPath);
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    let promoted;
    let fingerprint;
    let memoryPrStatusCounts;
    try {
      promoted = readPromotedMemoryPrs(snapshotDb);
      fingerprint = cognitiveSnapshotFingerprint(snapshotDb);
      memoryPrStatusCounts = readMemoryPrStatusCounts(snapshotDb);
    } finally {
      snapshotDb.close();
    }

    if (expectedPromotedCount != null && promoted.length !== expectedPromotedCount) {
      throw new Error(`promoted_memory_count_mismatch:expected=${expectedPromotedCount}:actual=${promoted.length}`);
    }

    const snapshotSha256 = fileSha256(snapshotPath);
    const exportPayload = {
      schemaVersion: 1,
      exportedAtMs: nowMs,
      exportedAt: new Date(nowMs).toISOString(),
      sourceDbPath: dbPath,
      snapshotFile: path.basename(snapshotPath),
      snapshotSha256,
      promotedCount: promoted.length,
      records: promoted,
    };
    writeJsonAtomic(exportPath, exportPayload);
    const exportSha256 = fileSha256(exportPath);

    barrier = installCognitiveDatabaseBarrier(db, nowMs);
    const liveFingerprint = cognitiveSnapshotFingerprint(db);
    if (!fingerprintMatches(fingerprint, liveFingerprint)) {
      removeCognitiveDatabaseBarrier(db, barrier);
      barrier = null;
      throw new Error('cognitive_memory_changed_during_snapshot');
    }

    freezeState = {
      schemaVersion: 1,
      active: true,
      reason: String(options.reason || '30-day evidence window before prose-memory retirement'),
      frozenAtMs: nowMs,
      frozenAt: new Date(nowMs).toISOString(),
      evidenceWindowDays,
      reviewAfterMs,
      reviewAfter: new Date(reviewAfterMs).toISOString(),
      dbPath,
      promotedCount: promoted.length,
      memoryPrStatusCounts,
      artifacts: {
        artifactDir,
        snapshotPath,
        snapshotSha256,
        exportPath,
        exportSha256,
        manifestPath,
      },
      barrier: {
        type: 'sqlite_triggers_plus_sleep_hold',
        triggerNames: [...COGNITIVE_TRIGGER_NAMES],
        sleepHoldValueMs: SLEEP_HOLD_VALUE_MS,
        previousLastRun: barrier.previousLastRun,
      },
    };
    const manifest = {
      schemaVersion: 1,
      purpose: 'Reversible pre-retirement export and snapshot for the bespoke prose-memory metabolism.',
      noDeletionPerformed: true,
      hardDeletionAuthorized: false,
      ...freezeState,
      statePath,
      snapshotFingerprint: fingerprint,
    };
    writeJsonAtomic(manifestPath, manifest);
    writeJsonAtomic(statePath, freezeState);
    stateCommitted = true;

    return {
      ok: true,
      active: true,
      statePath,
      dbPath,
      artifactDir,
      snapshotPath,
      snapshotSha256,
      exportPath,
      exportSha256,
      manifestPath,
      promotedCount: promoted.length,
      memoryPrStatusCounts,
      installedTriggers: listInstalledCognitiveFreezeTriggers(db),
      evidenceWindowDays,
      reviewAfter: freezeState.reviewAfter,
      noDeletionPerformed: true,
    };
  } catch (err) {
    if (barrier && !stateCommitted) {
      try { removeCognitiveDatabaseBarrier(db, barrier); } catch {}
    }
    throw err;
  } finally {
    db.close();
  }
}

function unfreezeMemoryMetabolism(options = {}) {
  const dbPath = path.resolve(String(options.dbPath || ''));
  const statePath = resolveMemoryMetabolismFreezePath({ dbPath, statePath: options.statePath });
  const state = readMemoryMetabolismFreeze({ statePath });
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`cognitive_memory_db_missing:${dbPath}`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000;');
  try {
    removeCognitiveDatabaseBarrier(db, {
      previousLastRun: state?.barrier?.previousLastRun || null,
    });
  } finally {
    db.close();
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const nextState = {
    ...state,
    schemaVersion: 1,
    active: false,
    unfrozenAtMs: nowMs,
    unfrozenAt: new Date(nowMs).toISOString(),
    unfrozenBy: String(options.unfrozenBy || 'manual'),
  };
  writeJsonAtomic(statePath, nextState);
  return inspectMemoryMetabolismFreeze({ dbPath, statePath });
}

module.exports = {
  COGNITIVE_TRIGGER_NAMES,
  FREEZE_FILENAME,
  FREEZE_REASON,
  SNAPSHOT_FINGERPRINT_TABLES,
  SLEEP_HOLD_VALUE_MS,
  cognitiveSnapshotFingerprint,
  freezeMemoryMetabolism,
  frozenMutationResult,
  inspectMemoryMetabolismFreeze,
  readMemoryMetabolismFreeze,
  resolveMemoryMetabolismFreezePath,
  unfreezeMemoryMetabolism,
  writeJsonAtomic,
};
