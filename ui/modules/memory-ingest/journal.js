function asJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function safeParseJson(raw, fallback) {
  try {
    if (raw === undefined || raw === null || raw === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function utcDayBucket(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function normalizeReplayRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...row,
    payload: safeParseJson(row.payload_json, {}),
    result_refs: safeParseJson(row.result_refs_json, []),
  };
}

class MemoryIngestJournal {
  constructor(db) {
    this.db = db;
  }

  requireDb() {
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new Error('memory_ingest_db_unavailable');
    }
    return this.db;
  }

  findRecentDedupe(memoryClass, dedupeKey, nowMs = Date.now(), windowMs = 24 * 60 * 60 * 1000, excludeIngestId = null) {
    if (!memoryClass || !dedupeKey) return null;
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_dedupe_keys
      WHERE memory_class = ?
        AND dedupe_key = ?
        AND created_at >= ?
        AND (? IS NULL OR ingest_id <> ?)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      String(memoryClass),
      String(dedupeKey),
      nowMs - windowMs,
      excludeIngestId || null,
      excludeIngestId || null
    );
  }

  insertJournalEntry(input = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_ingest_journal (
        ingest_id,
        memory_id,
        memory_class,
        content_hash,
        dedupe_key,
        time_bucket,
        route_tier,
        promotion_required,
        status,
        payload_json,
        result_refs_json,
        error_code,
        error_message,
        attempt_count,
        last_attempt_at,
        next_attempt_at,
        queue_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ingest_id,
      input.memory_id,
      input.memory_class,
      input.content_hash,
      input.dedupe_key || null,
      input.time_bucket || utcDayBucket(input.created_at),
      input.route_tier || null,
      input.promotion_required ? 1 : 0,
      input.status || 'recorded',
      asJson(input.payload, {}),
      asJson(input.result_refs, []),
      input.error_code || null,
      input.error_message || null,
      Number.isFinite(Number(input.attempt_count)) ? Math.max(0, Math.floor(Number(input.attempt_count))) : 0,
      input.last_attempt_at || null,
      input.next_attempt_at || null,
      input.queue_reason || null,
      input.created_at,
      input.updated_at
    );
  }

  getJournalEntry(ingestId) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT *
      FROM memory_ingest_journal
      WHERE ingest_id = ?
      LIMIT 1
    `).get(String(ingestId || ''));
    return normalizeReplayRow(row);
  }

  listReplayableEntries(nowMs = Date.now(), options = {}) {
    const db = this.requireDb();
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 25;
    const includeFuture = options.includeFuture === true;
    const rows = db.prepare(`
      SELECT *
      FROM memory_ingest_journal
      WHERE status IN ('recorded', 'failed')
        AND (? = 1 OR COALESCE(next_attempt_at, 0) <= ?)
      ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
      LIMIT ?
    `).all(includeFuture ? 1 : 0, nowMs, limit);
    return rows.map(normalizeReplayRow).filter(Boolean);
  }

  countReplayableEntries(nowMs = Date.now(), options = {}) {
    const db = this.requireDb();
    const includeFuture = options.includeFuture === true;
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_ingest_journal
      WHERE status IN ('recorded', 'failed')
        AND (? = 1 OR COALESCE(next_attempt_at, 0) <= ?)
    `).get(includeFuture ? 1 : 0, nowMs);
    return Number(row?.count || 0);
  }

  countOutstandingEntries() {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_ingest_journal
      WHERE status IN ('recorded', 'failed')
    `).get();
    return Number(row?.count || 0);
  }

  getNextReplayDueAt() {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT MIN(COALESCE(next_attempt_at, 0)) AS next_due_at
      FROM memory_ingest_journal
      WHERE status IN ('recorded', 'failed')
    `).get();
    return Number.isFinite(Number(row?.next_due_at)) ? Number(row.next_due_at) : null;
  }

  updateJournalEntry(ingestId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(patch, 'route_tier')) {
      sets.push('route_tier = ?');
      values.push(patch.route_tier);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'promotion_required')) {
      sets.push('promotion_required = ?');
      values.push(patch.promotion_required ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'payload')) {
      sets.push('payload_json = ?');
      values.push(asJson(patch.payload, {}));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'result_refs')) {
      sets.push('result_refs_json = ?');
      values.push(asJson(patch.result_refs, []));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error_code')) {
      sets.push('error_code = ?');
      values.push(patch.error_code);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error_message')) {
      sets.push('error_message = ?');
      values.push(patch.error_message);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'attempt_count')) {
      sets.push('attempt_count = ?');
      values.push(Math.max(0, Math.floor(Number(patch.attempt_count) || 0)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'last_attempt_at')) {
      sets.push('last_attempt_at = ?');
      values.push(patch.last_attempt_at);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'next_attempt_at')) {
      sets.push('next_attempt_at = ?');
      values.push(patch.next_attempt_at);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'queue_reason')) {
      sets.push('queue_reason = ?');
      values.push(patch.queue_reason);
    }

    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(ingestId);

    db.prepare(`
      UPDATE memory_ingest_journal
      SET ${sets.join(', ')}
      WHERE ingest_id = ?
    `).run(...values);
  }

  insertMemoryObject(memory = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_objects (
        memory_id,
        ingest_id,
        memory_class,
        tier,
        status,
        authority_level,
        content,
        content_hash,
        provenance_json,
        source_trace,
        confidence,
        scope_json,
        device_id,
        session_id,
        session_ordinal,
        correction_of,
        supersedes,
        claim_type,
        lifecycle_state,
        last_access_session,
        stale_since_session,
        stale_window_until_session,
        archived_at,
        promoted_at,
        useful_marked_at,
        expires_at,
        result_refs_json,
        freshness_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.memory_id,
      memory.ingest_id,
      memory.memory_class,
      memory.tier,
      memory.status,
      memory.authority_level,
      memory.content,
      memory.content_hash,
      asJson(memory.provenance, {}),
      memory.source_trace,
      memory.confidence,
      asJson(memory.scope, null),
      memory.device_id || null,
      memory.session_id || null,
      memory.session_ordinal || null,
      memory.correction_of || null,
      memory.supersedes || null,
      memory.claim_type || null,
      memory.lifecycle_state || (memory.status === 'pending' ? 'pending' : 'active'),
      memory.last_access_session || memory.session_ordinal || null,
      memory.stale_since_session || null,
      memory.stale_window_until_session || null,
      memory.archived_at || null,
      memory.promoted_at || null,
      memory.useful_marked_at || null,
      memory.expires_at || null,
      asJson(memory.result_refs, []),
      memory.freshness_at,
      memory.created_at,
      memory.updated_at
    );
  }

  getMemoryObjectForIngest(ingestId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_objects
      WHERE ingest_id = ?
      LIMIT 1
    `).get(String(ingestId || ''));
  }

  insertPromotionCandidate(candidate = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_promotion_queue (
        candidate_id,
        memory_id,
        ingest_id,
        memory_class,
        claim_type,
        target_file,
        target_heading,
        base_sha,
        patch_text,
        review_required,
        status,
        review_notes,
        reviewed_by,
        reviewed_at,
        conflict_artifact_path,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.candidate_id,
      candidate.memory_id,
      candidate.ingest_id,
      candidate.memory_class,
      candidate.claim_type || null,
      candidate.target_file,
      candidate.target_heading || null,
      candidate.base_sha || null,
      candidate.patch_text || null,
      candidate.review_required ? 1 : 0,
      candidate.status || 'pending',
      candidate.review_notes || null,
      candidate.reviewed_by || null,
      candidate.reviewed_at || null,
      candidate.conflict_artifact_path || null,
      candidate.created_at,
      candidate.updated_at
    );
  }

  listPromotionCandidatesForIngest(ingestId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_promotion_queue
      WHERE ingest_id = ?
      ORDER BY created_at ASC
    `).all(String(ingestId || ''));
  }

  getPromotionCandidate(candidateId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_promotion_queue
      WHERE candidate_id = ?
      LIMIT 1
    `).get(String(candidateId || ''));
  }

  listPromotionCandidates(status = 'pending', limit = 50) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_promotion_queue
      WHERE (? = 'all' OR status = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(status, status, Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 50);
  }

  updatePromotionCandidate(candidateId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries({
      status: 'status',
      target_file: 'target_file',
      target_heading: 'target_heading',
      base_sha: 'base_sha',
      patch_text: 'patch_text',
      review_notes: 'review_notes',
      reviewed_by: 'reviewed_by',
      reviewed_at: 'reviewed_at',
      conflict_artifact_path: 'conflict_artifact_path',
    })) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(candidateId);
    db.prepare(`UPDATE memory_promotion_queue SET ${sets.join(', ')} WHERE candidate_id = ?`).run(...values);
  }

  getMemoryObject(memoryId) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_objects
      WHERE memory_id = ?
      LIMIT 1
    `).get(String(memoryId || ''));
  }

  updateMemoryObject(memoryId, patch = {}) {
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
      promoted_at: 'promoted_at',
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

  insertConflictRecord(conflict = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_conflict_queue (
        conflict_id,
        candidate_id,
        memory_id,
        target_file,
        base_sha,
        current_sha,
        patch_text,
        artifact_path,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conflict.conflict_id,
      conflict.candidate_id,
      conflict.memory_id,
      conflict.target_file,
      conflict.base_sha || null,
      conflict.current_sha || null,
      conflict.patch_text || null,
      conflict.artifact_path || null,
      conflict.status || 'pending',
      conflict.created_at,
      conflict.updated_at
    );
  }

  listConflicts(status = 'pending', limit = 50) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_conflict_queue
      WHERE (? = 'all' OR status = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(status, status, Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 50);
  }

  insertDedupeRecord(input = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT OR REPLACE INTO memory_dedupe_keys (
        memory_class,
        dedupe_key,
        time_bucket,
        ingest_id,
        memory_id,
        result_refs_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.memory_class,
      input.dedupe_key,
      input.time_bucket || utcDayBucket(input.created_at),
      input.ingest_id,
      input.memory_id || null,
      asJson(input.result_refs, []),
      input.created_at,
      input.updated_at
    );
  }

  getRuntimeState(stateKey, fallback = null) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT state_json, updated_at
      FROM memory_ingest_runtime_state
      WHERE state_key = ?
      LIMIT 1
    `).get(String(stateKey || ''));
    if (!row) return fallback;
    const value = safeParseJson(row.state_json, fallback);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        ...value,
        updated_at: row.updated_at,
      };
    }
    return value;
  }

  setRuntimeState(stateKey, value, updatedAt = Date.now()) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_ingest_runtime_state (state_key, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE
      SET state_json = excluded.state_json,
          updated_at = excluded.updated_at
    `).run(
      String(stateKey || ''),
      asJson(value, {}),
      updatedAt
    );
  }

  clearRuntimeState(stateKey) {
    const db = this.requireDb();
    db.prepare('DELETE FROM memory_ingest_runtime_state WHERE state_key = ?').run(String(stateKey || ''));
  }
}

module.exports = {
  MemoryIngestJournal,
  normalizeReplayRow,
  safeParseJson,
  utcDayBucket,
};
