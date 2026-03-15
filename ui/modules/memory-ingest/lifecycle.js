const { generateId } = require('./schema');

const STALE_THRESHOLD_SESSIONS = 10;
const ARCHIVE_THRESHOLD_SESSIONS = 30;
const RETRIEVAL_REACTIVATION_WINDOW = 5;
const STALE_RETRIEVAL_EXTENSION = 5;
const STALE_MENTION_EXTENSION = 3;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function asInteger(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.floor(numeric);
}

class MemoryLifecycleService {
  constructor(options = {}) {
    this.db = options.db || null;
  }

  requireDb() {
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new Error('memory_lifecycle_db_unavailable');
    }
    return this.db;
  }

  getMemory(memoryId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_objects
      WHERE memory_id = ?
      LIMIT 1
    `).get(String(memoryId || ''));
  }

  updateMemory(memoryId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries({
      status: 'status',
      lifecycle_state: 'lifecycle_state',
      last_access_session: 'last_access_session',
      stale_since_session: 'stale_since_session',
      stale_window_until_session: 'stale_window_until_session',
      archived_at: 'archived_at',
      useful_marked_at: 'useful_marked_at',
      freshness_at: 'freshness_at',
    })) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(memoryId);
    db.prepare(`UPDATE memory_objects SET ${sets.join(', ')} WHERE memory_id = ?`).run(...values);
  }

  insertAccess(memoryId, accessKind, sessionOrdinal, detail = {}, nowMs = Date.now()) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_access_log (
        access_id,
        memory_id,
        access_kind,
        session_ordinal,
        detail_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      generateId('access'),
      memoryId,
      accessKind,
      sessionOrdinal,
      JSON.stringify(detail || {}),
      nowMs
    );
  }

  countRecentRetrievals(memoryId, sessionOrdinal) {
    const db = this.requireDb();
    const minSession = Math.max(0, Number(sessionOrdinal || 0) - (RETRIEVAL_REACTIVATION_WINDOW - 1));
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_access_log
      WHERE memory_id = ?
        AND access_kind = 'retrieval'
        AND session_ordinal BETWEEN ? AND ?
    `).get(memoryId, minSession, sessionOrdinal);
    return Number(row?.count || 0);
  }

  recordAccess(payload = {}) {
    const input = asObject(payload);
    const memoryId = asString(input.memory_id || input.memoryId || '', '');
    const accessKind = asString(input.access_kind || input.accessKind || 'retrieval', 'retrieval');
    const sessionOrdinal = asInteger(input.session_ordinal || input.sessionOrdinal, null);
    const nowMs = asInteger(input.nowMs, Date.now());
    if (!memoryId) {
      return { ok: false, reason: 'memory_id_required' };
    }
    const memory = this.getMemory(memoryId);
    if (!memory) {
      return { ok: false, reason: 'memory_not_found', memoryId };
    }

    this.insertAccess(memoryId, accessKind, sessionOrdinal, input.detail, nowMs);

    const patch = {
      freshness_at: nowMs,
      updated_at: nowMs,
    };
    if (sessionOrdinal !== null) {
      patch.last_access_session = sessionOrdinal;
    }

    if (accessKind === 'useful_mark') {
      patch.lifecycle_state = 'active';
      patch.stale_since_session = null;
      patch.stale_window_until_session = null;
      patch.archived_at = null;
      patch.useful_marked_at = nowMs;
      this.updateMemory(memoryId, patch);
      return { ok: true, memory: this.getMemory(memoryId) };
    }

    if (memory.lifecycle_state === 'stale' || memory.lifecycle_state === 'archived') {
      if (accessKind === 'retrieval' && sessionOrdinal !== null) {
        const retrievalCount = this.countRecentRetrievals(memoryId, sessionOrdinal);
        if (retrievalCount >= 2) {
          patch.lifecycle_state = 'active';
          patch.stale_since_session = null;
          patch.stale_window_until_session = null;
          patch.archived_at = null;
        } else {
          patch.lifecycle_state = 'stale';
          patch.stale_window_until_session = Math.max(
            Number(memory.stale_window_until_session || 0),
            sessionOrdinal + STALE_RETRIEVAL_EXTENSION
          );
        }
      } else if (accessKind === 'mention' && sessionOrdinal !== null) {
        patch.lifecycle_state = memory.lifecycle_state === 'archived' ? 'stale' : memory.lifecycle_state;
        patch.archived_at = null;
        patch.stale_window_until_session = Math.max(
          Number(memory.stale_window_until_session || 0),
          sessionOrdinal + STALE_MENTION_EXTENSION
        );
      }
    }

    this.updateMemory(memoryId, patch);
    return { ok: true, memory: this.getMemory(memoryId) };
  }

  advanceLifecycle(payload = {}) {
    const input = asObject(payload);
    const sessionOrdinal = asInteger(input.session_ordinal || input.sessionOrdinal, null);
    const nowMs = asInteger(input.nowMs, Date.now());
    if (sessionOrdinal === null) {
      return { ok: false, reason: 'session_ordinal_required' };
    }

    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT *
      FROM memory_objects
      WHERE status NOT IN ('rejected', 'superseded', 'corrected', 'expired')
    `).all();

    let staleCount = 0;
    let archivedCount = 0;
    let expiredCount = 0;
    for (const row of rows) {
      const expiresAt = row.expires_at === null || row.expires_at === undefined
        ? null
        : asInteger(row.expires_at, null);
      if (expiresAt !== null && expiresAt <= nowMs) {
        this.updateMemory(row.memory_id, {
          status: 'expired',
          lifecycle_state: 'archived',
          archived_at: nowMs,
          updated_at: nowMs,
        });
        expiredCount += 1;
        continue;
      }

      const baselineSession = asInteger(row.last_access_session, asInteger(row.session_ordinal, null));
      if (baselineSession === null) continue;

      if ((row.lifecycle_state || 'active') === 'active') {
        if ((sessionOrdinal - baselineSession) >= STALE_THRESHOLD_SESSIONS) {
          this.updateMemory(row.memory_id, {
            lifecycle_state: 'stale',
            stale_since_session: sessionOrdinal,
            updated_at: nowMs,
          });
          staleCount += 1;
        }
        continue;
      }

      if ((row.lifecycle_state || '') !== 'stale') continue;

      const staleSince = asInteger(row.stale_since_session, sessionOrdinal);
      const extensionUntil = asInteger(row.stale_window_until_session, null);
      const archiveAfter = Math.max(
        staleSince + ARCHIVE_THRESHOLD_SESSIONS,
        extensionUntil === null ? 0 : extensionUntil
      );
      if (sessionOrdinal >= archiveAfter) {
        this.updateMemory(row.memory_id, {
          lifecycle_state: 'archived',
          archived_at: nowMs,
          updated_at: nowMs,
        });
        archivedCount += 1;
      }
    }

    return {
      ok: true,
      session_ordinal: sessionOrdinal,
      staleCount,
      archivedCount,
      expiredCount,
    };
  }

  reviewStaleMemories(payload = {}) {
    const input = asObject(payload);
    const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Math.floor(Number(input.limit))) : 50;
    const db = this.requireDb();
    const rows = db.prepare(`
      SELECT memory_id, memory_class, content, lifecycle_state, stale_since_session, last_access_session, updated_at
      FROM memory_objects
      WHERE lifecycle_state IN ('stale', 'archived')
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(limit);
    return {
      ok: true,
      review_candidates: rows,
    };
  }
}

module.exports = {
  ARCHIVE_THRESHOLD_SESSIONS,
  MemoryLifecycleService,
  RETRIEVAL_REACTIVATION_WINDOW,
  STALE_MENTION_EXTENSION,
  STALE_RETRIEVAL_EXTENSION,
  STALE_THRESHOLD_SESSIONS,
};
