const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');
const { resolveCoordPath } = require('../../config');
const { runMigrations } = require('./migrations');

function resolveDefaultDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/supervisor.sqlite');
  }
  return resolveCoordPath(path.join('runtime', 'supervisor.sqlite'), { forWrite: true });
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();
const VALID_STATUSES = new Set(['pending', 'running', 'complete', 'failed', 'blocked', 'canceled']);

function loadSqliteDriver() {
  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      return {
        name: 'node:sqlite',
        create: (filename) => new mod.DatabaseSync(filename),
      };
    }
  } catch {}

  try {
    const BetterSqlite3 = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      create: (filename) => new BetterSqlite3(filename),
    };
  } catch {
    return null;
  }
}

function toEpochMs(value = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  return Date.now();
}

function toJsonString(value, fallback = '{}') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function generateId(prefix = 'sup') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(normalized) ? normalized : fallback;
}

function toOptionalAgeMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

function normalizeTaskRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    objective: row.objective,
    status: row.status,
    ownerPane: row.owner_pane || null,
    priority: Number(row.priority || 0),
    attemptCount: Number(row.attempt_count || 0),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAtMs: row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms),
    workerPid: row.worker_pid == null ? null : Number(row.worker_pid),
    contextSnapshot: parseJson(row.context_snapshot_json, {}),
    resultPayload: parseJson(row.result_payload_json, null),
    errorPayload: parseJson(row.error_payload_json, null),
    createdAtMs: Number(row.created_at_ms || 0),
    updatedAtMs: Number(row.updated_at_ms || 0),
    startedAtMs: row.started_at_ms == null ? null : Number(row.started_at_ms),
    completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
    lastHeartbeatAtMs: row.last_heartbeat_at_ms == null ? null : Number(row.last_heartbeat_at_ms),
  };
}

class SupervisorStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || resolveDefaultDbPath();
    this.enabled = options.enabled !== false;
    this.db = null;
    this.driverName = null;
    this.available = false;
    this.degradedReason = null;
    this.migrationResult = null;
  }

  init(options = {}) {
    if (this.isAvailable()) {
      return {
        ok: true,
        driver: this.driverName,
        dbPath: this.dbPath,
        migrationResult: this.migrationResult,
      };
    }

    if (!this.enabled) {
      this.degradedReason = 'disabled';
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    } catch (err) {
      this.degradedReason = `runtime_dir_error:${err.message}`;
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    const driver = loadSqliteDriver();
    if (!driver) {
      this.degradedReason = 'sqlite_driver_unavailable';
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    try {
      this.db = driver.create(this.dbPath);
      this.driverName = driver.name;
      log.info('SupervisorStore', `SQLite driver selected: ${this.driverName} (Node ${process.versions.node})`);
      this._applyPragmas();
      this.migrationResult = runMigrations(this.db, { nowMs: options.nowMs });
      if (!this.migrationResult.ok) {
        throw new Error(this.migrationResult.error || this.migrationResult.reason || 'migration_failed');
      }
      this.available = true;
      this.degradedReason = null;
      return {
        ok: true,
        driver: this.driverName,
        dbPath: this.dbPath,
        migrationResult: this.migrationResult,
      };
    } catch (err) {
      this.available = false;
      this.degradedReason = `open_failed:${err.message}`;
      this.close();
      return { ok: false, reason: this.degradedReason };
    }
  }

  _applyPragmas() {
    if (!this.db) return;
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
  }

  isAvailable() {
    return this.available && Boolean(this.db);
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      driver: this.driverName,
      dbPath: this.dbPath,
      degradedReason: this.degradedReason,
      migrationResult: this.migrationResult,
    };
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn('SupervisorStore', `Error closing DB: ${err.message}`);
    }
    this.db = null;
    this.available = false;
  }

  _assertAvailable() {
    if (!this.isAvailable()) {
      throw new Error('supervisor_store_unavailable');
    }
  }

  _insertEvent(taskId, eventType, payload, nowMs = Date.now()) {
    this.db.prepare(`
      INSERT INTO supervisor_task_events (
        event_id, task_id, event_type, payload_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      generateId('evt'),
      taskId,
      String(eventType || 'unknown'),
      toJsonString(payload, '{}'),
      toEpochMs(nowMs)
    );
  }

  enqueueTask(input = {}) {
    this._assertAvailable();
    const nowMs = toEpochMs(input.nowMs);
    const taskId = String(input.taskId || generateId('task'));
    const objective = String(input.objective || '').trim();
    if (!objective) {
      return { ok: false, reason: 'objective_required' };
    }

    const status = normalizeStatus(input.status, 'pending');
    const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100;
    const ownerPane = input.ownerPane ? String(input.ownerPane).trim() : null;
    const attemptCount = Number.isFinite(Number(input.attemptCount)) ? Number(input.attemptCount) : 0;
    const contextSnapshot = input.contextSnapshot && typeof input.contextSnapshot === 'object'
      ? input.contextSnapshot
      : {};

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO supervisor_tasks (
          task_id,
          objective,
          status,
          owner_pane,
          priority,
          attempt_count,
          lease_owner,
          lease_expires_at_ms,
          worker_pid,
          context_snapshot_json,
          result_payload_json,
          error_payload_json,
          created_at_ms,
          updated_at_ms,
          started_at_ms,
          completed_at_ms,
          last_heartbeat_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        objective,
        status,
        ownerPane,
        priority,
        attemptCount,
        null,
        null,
        null,
        toJsonString(contextSnapshot, '{}'),
        toJsonString(input.resultPayload, 'null'),
        toJsonString(input.errorPayload, 'null'),
        nowMs,
        nowMs,
        status === 'running' ? nowMs : null,
        status === 'complete' || status === 'failed' || status === 'canceled' ? nowMs : null,
        null
      );
      this._insertEvent(taskId, 'enqueued', {
        objective,
        status,
        ownerPane,
        priority,
      }, nowMs);
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'enqueue_failed', error: err.message };
    }

    return {
      ok: true,
      taskId,
      task: this.getTask(taskId),
    };
  }

  getTask(taskId) {
    this._assertAvailable();
    const row = this.db.prepare(`
      SELECT *
      FROM supervisor_tasks
      WHERE task_id = ?
    `).get(String(taskId || ''));
    return normalizeTaskRow(row);
  }

  listTasks(options = {}) {
    this._assertAvailable();
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || '50', 10) || 50));
    const status = options.status ? normalizeStatus(options.status, '') : '';

    let rows;
    if (status) {
      rows = this.db.prepare(`
        SELECT *
        FROM supervisor_tasks
        WHERE status = ?
        ORDER BY priority DESC, created_at_ms ASC
        LIMIT ?
      `).all(status, limit);
    } else {
      rows = this.db.prepare(`
        SELECT *
        FROM supervisor_tasks
        ORDER BY
          CASE status
            WHEN 'running' THEN 0
            WHEN 'pending' THEN 1
            ELSE 2
          END,
          priority DESC,
          created_at_ms ASC
        LIMIT ?
      `).all(limit);
    }
    return rows.map(normalizeTaskRow);
  }

  getTaskCounts() {
    this._assertAvailable();
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS total
      FROM supervisor_tasks
      GROUP BY status
    `).all();
    const counts = {
      pending: 0,
      running: 0,
      complete: 0,
      failed: 0,
      blocked: 0,
      canceled: 0,
      total: 0,
    };
    for (const row of rows) {
      const status = normalizeStatus(row?.status, '');
      const total = Number(row?.total || 0);
      if (status) {
        counts[status] = total;
        counts.total += total;
      }
    }
    return counts;
  }

  claimNextTask(options = {}) {
    this._assertAvailable();
    const leaseOwner = String(options.leaseOwner || '').trim();
    if (!leaseOwner) {
      return { ok: false, reason: 'lease_owner_required' };
    }

    const nowMs = toEpochMs(options.nowMs);
    const leaseMs = Math.max(1000, Number.parseInt(options.leaseMs || '60000', 10) || 60000);
    const ownerPane = options.ownerPane ? String(options.ownerPane).trim() : null;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const candidate = this.db.prepare(`
        SELECT *
        FROM supervisor_tasks
        WHERE status = 'pending'
           OR (status = 'running' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?)
        ORDER BY
          CASE status WHEN 'running' THEN 0 ELSE 1 END,
          priority DESC,
          created_at_ms ASC
        LIMIT 1
      `).get(nowMs);

      if (!candidate) {
        this.db.exec('COMMIT;');
        return { ok: true, task: null };
      }

      const taskId = candidate.task_id;
      const attemptCount = Number(candidate.attempt_count || 0) + 1;
      const leaseExpiresAtMs = nowMs + leaseMs;
      this.db.prepare(`
        UPDATE supervisor_tasks
        SET status = 'running',
            owner_pane = COALESCE(?, owner_pane),
            attempt_count = ?,
            lease_owner = ?,
            lease_expires_at_ms = ?,
            updated_at_ms = ?,
            started_at_ms = COALESCE(started_at_ms, ?),
            completed_at_ms = NULL,
            result_payload_json = NULL,
            error_payload_json = NULL,
            last_heartbeat_at_ms = ?
        WHERE task_id = ?
      `).run(
        ownerPane,
        attemptCount,
        leaseOwner,
        leaseExpiresAtMs,
        nowMs,
        nowMs,
        nowMs,
        taskId
      );

      this._insertEvent(taskId, 'claimed', {
        leaseOwner,
        ownerPane,
        leaseExpiresAtMs,
        attemptCount,
      }, nowMs);

      this.db.exec('COMMIT;');
      return {
        ok: true,
        task: this.getTask(taskId),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'claim_failed', error: err.message };
    }
  }

  heartbeatTask(taskId, options = {}) {
    this._assertAvailable();
    const leaseOwner = String(options.leaseOwner || '').trim();
    if (!leaseOwner) {
      return { ok: false, reason: 'lease_owner_required' };
    }
    const nowMs = toEpochMs(options.nowMs);
    const leaseMs = Math.max(1000, Number.parseInt(options.leaseMs || '60000', 10) || 60000);
    const leaseExpiresAtMs = nowMs + leaseMs;

    const result = this.db.prepare(`
      UPDATE supervisor_tasks
      SET lease_expires_at_ms = ?,
          updated_at_ms = ?,
          last_heartbeat_at_ms = ?
      WHERE task_id = ?
        AND status = 'running'
        AND lease_owner = ?
    `).run(
      leaseExpiresAtMs,
      nowMs,
      nowMs,
      String(taskId || ''),
      leaseOwner
    );

    const changes = Number(result?.changes || 0);
    if (changes === 0) {
      return { ok: false, reason: 'task_not_running' };
    }
    this._insertEvent(String(taskId || ''), 'heartbeat', {
      leaseOwner,
      leaseExpiresAtMs,
    }, nowMs);
    return {
      ok: true,
      leaseExpiresAtMs,
    };
  }

  attachWorkerPid(taskId, workerPid, options = {}) {
    this._assertAvailable();
    const leaseOwner = String(options.leaseOwner || '').trim();
    const result = this.db.prepare(`
      UPDATE supervisor_tasks
      SET worker_pid = ?,
          updated_at_ms = ?
      WHERE task_id = ?
        AND status = 'running'
        AND lease_owner = ?
    `).run(
      workerPid == null ? null : Number(workerPid),
      toEpochMs(options.nowMs),
      String(taskId || ''),
      leaseOwner
    );
    const changes = Number(result?.changes || 0);
    if (changes === 0) {
      return { ok: false, reason: 'task_not_running' };
    }
    return { ok: true };
  }

  completeTask(taskId, options = {}) {
    this._assertAvailable();
    const leaseOwner = String(options.leaseOwner || '').trim();
    if (!leaseOwner) {
      return { ok: false, reason: 'lease_owner_required' };
    }
    const nowMs = toEpochMs(options.nowMs);
    const resultPayload = options.resultPayload === undefined ? null : options.resultPayload;
    const result = this.db.prepare(`
      UPDATE supervisor_tasks
      SET status = 'complete',
          result_payload_json = ?,
          error_payload_json = NULL,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          worker_pid = NULL,
          updated_at_ms = ?,
          completed_at_ms = ?
      WHERE task_id = ?
        AND status = 'running'
        AND lease_owner = ?
    `).run(
      toJsonString(resultPayload, 'null'),
      nowMs,
      nowMs,
      String(taskId || ''),
      leaseOwner
    );
    const changes = Number(result?.changes || 0);
    if (changes === 0) {
      return { ok: false, reason: 'task_not_running' };
    }
    this._insertEvent(String(taskId || ''), 'completed', {
      leaseOwner,
      resultPayload,
    }, nowMs);
    return {
      ok: true,
      task: this.getTask(taskId),
    };
  }

  failTask(taskId, options = {}) {
    this._assertAvailable();
    const leaseOwner = String(options.leaseOwner || '').trim();
    if (!leaseOwner) {
      return { ok: false, reason: 'lease_owner_required' };
    }
    const nowMs = toEpochMs(options.nowMs);
    const errorPayload = options.errorPayload === undefined ? null : options.errorPayload;
    const result = this.db.prepare(`
      UPDATE supervisor_tasks
      SET status = 'failed',
          error_payload_json = ?,
          result_payload_json = NULL,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          worker_pid = NULL,
          updated_at_ms = ?,
          completed_at_ms = ?
      WHERE task_id = ?
        AND status = 'running'
        AND lease_owner = ?
    `).run(
      toJsonString(errorPayload, 'null'),
      nowMs,
      nowMs,
      String(taskId || ''),
      leaseOwner
    );
    const changes = Number(result?.changes || 0);
    if (changes === 0) {
      return { ok: false, reason: 'task_not_running' };
    }
    this._insertEvent(String(taskId || ''), 'failed', {
      leaseOwner,
      errorPayload,
    }, nowMs);
    return {
      ok: true,
      task: this.getTask(taskId),
    };
  }

  requeueExpiredTasks(options = {}) {
    this._assertAvailable();
    const nowMs = toEpochMs(options.nowMs);
    const expiredRows = this.db.prepare(`
      SELECT task_id, lease_owner, lease_expires_at_ms, attempt_count, worker_pid
      FROM supervisor_tasks
      WHERE status = 'running'
        AND lease_expires_at_ms IS NOT NULL
        AND lease_expires_at_ms <= ?
      ORDER BY lease_expires_at_ms ASC
    `).all(nowMs);

    if (!expiredRows.length) {
      return { ok: true, requeued: 0, taskIds: [], tasks: [] };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of expiredRows) {
        this.db.prepare(`
          UPDATE supervisor_tasks
          SET status = 'pending',
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              worker_pid = NULL,
              updated_at_ms = ?
          WHERE task_id = ?
        `).run(nowMs, row.task_id);
        this._insertEvent(row.task_id, 'requeued_expired_lease', {
          previousLeaseOwner: row.lease_owner || null,
          expiredAtMs: row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms),
          attemptCount: Number(row.attempt_count || 0),
        }, nowMs);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'requeue_failed', error: err.message };
    }

    return {
      ok: true,
      requeued: expiredRows.length,
      taskIds: expiredRows.map((row) => row.task_id),
      tasks: expiredRows.map((row) => ({
        taskId: row.task_id,
        previousLeaseOwner: row.lease_owner || null,
        expiredAtMs: row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms),
        attemptCount: Number(row.attempt_count || 0),
        workerPid: row.worker_pid == null ? null : Number(row.worker_pid),
      })),
    };
  }

  pruneExpiredPendingTasks(options = {}) {
    this._assertAvailable();
    const nowMs = toEpochMs(options.nowMs);
    const maxAgeMs = toOptionalAgeMs(options.maxAgeMs);
    if (!maxAgeMs) {
      return { ok: true, pruned: 0, taskIds: [], tasks: [], skipped: true, reason: 'ttl_disabled' };
    }

    const cutoffMs = nowMs - maxAgeMs;
    const staleRows = this.db.prepare(`
      SELECT task_id, objective, priority, owner_pane, created_at_ms, updated_at_ms
      FROM supervisor_tasks
      WHERE status = 'pending'
        AND updated_at_ms <= ?
      ORDER BY updated_at_ms ASC
    `).all(cutoffMs);

    if (!staleRows.length) {
      return { ok: true, pruned: 0, taskIds: [], tasks: [] };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of staleRows) {
        this.db.prepare(`
          UPDATE supervisor_tasks
          SET status = 'canceled',
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              worker_pid = NULL,
              updated_at_ms = ?,
              completed_at_ms = ?
          WHERE task_id = ?
        `).run(nowMs, nowMs, row.task_id);
        this._insertEvent(row.task_id, 'pruned_pending_ttl', {
          maxAgeMs,
          pendingAgeMs: Math.max(0, nowMs - Number(row.updated_at_ms || row.created_at_ms || nowMs)),
          objective: row.objective,
          priority: Number(row.priority || 0),
          ownerPane: row.owner_pane || null,
        }, nowMs);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'prune_pending_failed', error: err.message };
    }

    return {
      ok: true,
      pruned: staleRows.length,
      taskIds: staleRows.map((row) => row.task_id),
      tasks: staleRows.map((row) => ({
        taskId: row.task_id,
        objective: row.objective,
        priority: Number(row.priority || 0),
        ownerPane: row.owner_pane || null,
        createdAtMs: Number(row.created_at_ms || 0),
        updatedAtMs: Number(row.updated_at_ms || 0),
      })),
    };
  }
}

module.exports = {
  SupervisorStore,
  DEFAULT_DB_PATH,
  VALID_STATUSES,
  loadSqliteDriver,
  resolveDefaultDbPath,
  normalizeTaskRow,
};
