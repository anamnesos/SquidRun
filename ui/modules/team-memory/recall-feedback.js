const crypto = require('crypto');

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tokenize(value) {
  return normalizeWhitespace(value).toLowerCase().match(/[a-z0-9_\-./\\:가-힣]+/g) || [];
}

function generateId(prefix = 'recallfb') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toEpochMs(value = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  return Date.now();
}

function safeParseJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function countUsefulOverlap(left = [], right = []) {
  const rightSet = new Set(right.filter((entry) => entry && entry.length >= 4));
  let count = 0;
  for (const token of left) {
    if (!token || token.length < 4) continue;
    if (rightSet.has(token)) count += 1;
  }
  return count;
}

const FEEDBACK_WEIGHTS = Object.freeze({
  used: 0.35,
  ignored: -0.18,
  missing: -0.55,
});
const HARD_SUPPRESSION_IGNORED_COUNT = 50;

class RecallFeedbackService {
  constructor(options = {}) {
    this.db = options.db || null;
  }

  requireDb() {
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new Error('recall_feedback_db_unavailable');
    }
    return this.db;
  }

  listUnresolvedSets(filters = {}) {
    const db = this.requireDb();
    const paneId = asString(filters.pane_id || filters.paneId || '', '');
    const agentRole = asString(filters.agent_role || filters.agentRole || filters.role || '', '');
    const channel = asString(filters.channel || '', '');
    const limit = Math.max(1, Math.floor(Number(filters.limit) || 10));
    return db.prepare(`
      SELECT *
      FROM memory_recall_sets
      WHERE status = 'delivered'
        AND (? = '' OR pane_id = ?)
        AND (? = '' OR agent_role = ?)
        AND (? = '' OR channel = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(
      paneId, paneId,
      agentRole, agentRole,
      channel, channel,
      limit
    );
  }

  getRankAdjustments(input = {}) {
    const db = this.requireDb();
    const identityKeys = [...new Set(asArray(input.identityKeys).map((entry) => asString(entry, '')).filter(Boolean))];
    if (identityKeys.length === 0) {
      return {
        ok: true,
        adjustments: {},
      };
    }

    const placeholders = identityKeys.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT *
      FROM memory_recall_profiles
      WHERE identity_key IN (${placeholders})
    `).all(...identityKeys);

    const adjustments = {};
    const suppressedIdentityKeys = [];
    for (const row of rows) {
      const used = Number(row?.used_count || 0);
      const ignored = Number(row?.ignored_count || 0);
      const missing = Number(row?.missing_count || 0);
      if (ignored >= HARD_SUPPRESSION_IGNORED_COUNT) {
        suppressedIdentityKeys.push(String(row.identity_key));
      }
      const adjustment = Math.max(
        -2.0,
        Math.min(
          2.0,
          (used * FEEDBACK_WEIGHTS.used)
            + (ignored * FEEDBACK_WEIGHTS.ignored)
            + (missing * FEEDBACK_WEIGHTS.missing)
        )
      );
      adjustments[String(row.identity_key)] = adjustment;
    }

    return {
      ok: true,
      adjustments,
      suppressedIdentityKeys,
    };
  }

  recordRecallSet(input = {}) {
    const db = this.requireDb();
    const nowMs = toEpochMs(input.nowMs);
    const resultSetId = asString(input.resultSetId, '');
    if (!resultSetId) return { ok: false, reason: 'result_set_id_required' };

    const paneId = asString(input.paneId || input.pane_id || '', '');
    const agentRole = asString(input.agentRole || input.agent_role || input.role || '', '');
    const channel = asString(input.channel || '', '');
    const sender = asString(input.sender || '', '');
    const query = asString(input.query || '', '');
    const metadataJson = JSON.stringify(asObject(input.metadata));
    const items = asArray(input.items).map((entry, index) => {
      const item = asObject(entry);
      return {
        result_item_id: asString(item.resultItemId || item.result_item_id || '', '') || generateId('recallitem'),
        result_set_id: resultSetId,
        identity_key: asString(item.identityKey || item.identity_key || '', ''),
        rank_index: Number.isFinite(Number(item.rankIndex)) ? Math.floor(Number(item.rankIndex)) : index,
        store_name: asString(item.store || item.store_name || '', ''),
        source_role: asString(item.sourceRole || item.source_role || '', ''),
        source_path: asString(item.sourcePath || item.source_path || '', ''),
        citation: asString(item.citation || '', ''),
        title: asString(item.title || '', ''),
        excerpt: asString(item.excerpt || '', ''),
        score: Number(item.baseScore ?? item.score ?? 0) || 0,
        rank_score: Number(item.rankScore ?? item.rank_score ?? item.score ?? 0) || 0,
        metadata_json: JSON.stringify(asObject(item.metadata)),
        created_at: nowMs,
      };
    });

    const insertSet = db.prepare(`
      INSERT OR REPLACE INTO memory_recall_sets (
        result_set_id,
        pane_id,
        agent_role,
        channel,
        sender,
        query,
        status,
        outcome_reason,
        metadata_json,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', NULL, ?, ?, ?, NULL)
    `);
    const deleteItems = db.prepare(`
      DELETE FROM memory_recall_items
      WHERE result_set_id = ?
    `);
    const insertItem = db.prepare(`
      INSERT INTO memory_recall_items (
        result_item_id,
        result_set_id,
        identity_key,
        rank_index,
        store_name,
        source_role,
        source_path,
        citation,
        title,
        excerpt,
        score,
        rank_score,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN IMMEDIATE;');
    try {
      const priorSets = db.prepare(`
        SELECT result_set_id
        FROM memory_recall_sets
        WHERE status = 'delivered'
          AND result_set_id != ?
          AND (? = '' OR pane_id = ?)
          AND (? = '' OR agent_role = ?)
          AND (? = '' OR channel = ?)
        ORDER BY created_at DESC
      `).all(
        resultSetId,
        paneId, paneId,
        agentRole, agentRole,
        channel, channel
      );

      for (const row of priorSets) {
        this.applyFeedbackToSet({
          resultSetId: row.result_set_id,
          feedbackType: 'ignored',
          reason: 'superseded_by_next_recall',
          nowMs,
          metadata: {
            supersededBy: resultSetId,
          },
        });
      }

      insertSet.run(resultSetId, paneId || null, agentRole || null, channel || null, sender || null, query, metadataJson, nowMs, nowMs);
      deleteItems.run(resultSetId);
      for (const item of items) {
        insertItem.run(
          item.result_item_id,
          item.result_set_id,
          item.identity_key || null,
          item.rank_index,
          item.store_name,
          item.source_role || null,
          item.source_path || null,
          item.citation || null,
          item.title || null,
          item.excerpt || null,
          item.score,
          item.rank_score,
          item.metadata_json,
          item.created_at
        );
      }

      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'record_recall_set_failed',
        error: err.message,
      };
    }

    return {
      ok: true,
      resultSetId,
      itemCount: items.length,
    };
  }

  recordRecallFeedback(input = {}) {
    const db = this.requireDb();
    const feedbackType = asString(input.feedbackType || input.feedback_type || '', '').toLowerCase();
    if (!FEEDBACK_WEIGHTS[feedbackType]) {
      return { ok: false, reason: 'invalid_feedback_type' };
    }

    const nowMs = toEpochMs(input.nowMs);
    let resultSetId = asString(input.resultSetId || input.result_set_id || '', '');
    const paneId = asString(input.paneId || input.pane_id || '', '');
    const agentRole = asString(input.agentRole || input.agent_role || input.role || '', '');
    const channel = asString(input.channel || '', '');
    const reason = asString(input.reason || '', '') || null;
    const messageText = normalizeWhitespace(input.messageText || input.message || '');
    const metadata = asObject(input.metadata);

    if (!resultSetId) {
      const latest = this.listUnresolvedSets({
        paneId,
        agentRole,
        channel,
        limit: feedbackType === 'used' ? 5 : 1,
      });
      if (feedbackType === 'used' && messageText) {
        for (const candidate of latest) {
          const items = this.matchItemsForUsage(candidate.result_set_id, messageText);
          if (items.length > 0) {
            resultSetId = candidate.result_set_id;
            input.resultItemIds = items.map((entry) => entry.result_item_id);
            break;
          }
        }
      } else if (latest[0]?.result_set_id) {
        resultSetId = latest[0].result_set_id;
      }
    }

    if (!resultSetId) {
      return {
        ok: true,
        resultSetId: null,
        feedbackType,
        matchedCount: 0,
        reason: 'no_candidate_set',
      };
    }

    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.applyFeedbackToSet({
        resultSetId,
        feedbackType,
        reason,
        nowMs,
        resultItemIds: input.resultItemIds,
        metadata: {
          ...metadata,
          paneId,
          agentRole,
          channel,
          messageText: messageText || null,
        },
      });
      db.exec('COMMIT;');
      return {
        ok: true,
        feedbackType,
        ...result,
      };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'record_recall_feedback_failed',
        error: err.message,
      };
    }
  }

  matchItemsForUsage(resultSetId, messageText = '') {
    const db = this.requireDb();
    const normalizedMessage = normalizeWhitespace(messageText);
    if (!resultSetId || !normalizedMessage) return [];
    const messageTokens = tokenize(normalizedMessage);
    if (messageTokens.length === 0) return [];

    const rows = db.prepare(`
      SELECT *
      FROM memory_recall_items
      WHERE result_set_id = ?
      ORDER BY rank_index ASC
    `).all(String(resultSetId));

    return rows.filter((row) => {
      const haystack = [
        row.title,
        row.excerpt,
        row.source_path,
        row.citation,
      ].filter(Boolean).join(' ');
      const rowTokens = tokenize(haystack);
      const overlap = countUsefulOverlap(messageTokens, rowTokens);
      if (overlap >= 2) return true;
      const citation = asString(row.citation, '').toLowerCase();
      if (citation && normalizedMessage.toLowerCase().includes(citation)) return true;
      const sourcePath = asString(row.source_path, '').replace(/\\/g, '/');
      const baseName = asString(sourcePath.split('/').pop(), '').toLowerCase();
      if (baseName && baseName.length >= 6 && normalizedMessage.toLowerCase().includes(baseName)) return true;
      return false;
    });
  }

  applyFeedbackToSet({ resultSetId, feedbackType, reason = null, nowMs = Date.now(), resultItemIds = null, metadata = {} } = {}) {
    const db = this.requireDb();
    const setRow = db.prepare(`
      SELECT *
      FROM memory_recall_sets
      WHERE result_set_id = ?
      LIMIT 1
    `).get(String(resultSetId || ''));
    if (!setRow) {
      return {
        resultSetId,
        matchedCount: 0,
        reason: 'set_not_found',
      };
    }
    if (String(setRow.status || '').toLowerCase() !== 'delivered') {
      return {
        resultSetId,
        matchedCount: 0,
        reason: 'set_already_resolved',
        status: setRow.status,
      };
    }

    const explicitIds = new Set(asArray(resultItemIds).map((entry) => asString(entry, '')).filter(Boolean));
    const rows = db.prepare(`
      SELECT *
      FROM memory_recall_items
      WHERE result_set_id = ?
      ORDER BY rank_index ASC
    `).all(String(resultSetId));
    const targetRows = explicitIds.size > 0
      ? rows.filter((row) => explicitIds.has(String(row.result_item_id)))
      : rows;

    if (feedbackType === 'used' && targetRows.length === 0) {
      return {
        resultSetId,
        matchedCount: 0,
        reason: 'no_matching_items',
      };
    }

    const insertEvent = db.prepare(`
      INSERT INTO memory_recall_feedback_events (
        event_id,
        result_set_id,
        result_item_id,
        identity_key,
        feedback_type,
        weight,
        reason,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertProfile = db.prepare(`
      INSERT INTO memory_recall_profiles (
        identity_key,
        used_count,
        ignored_count,
        missing_count,
        last_used_at,
        last_ignored_at,
        last_missing_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        used_count = memory_recall_profiles.used_count + excluded.used_count,
        ignored_count = memory_recall_profiles.ignored_count + excluded.ignored_count,
        missing_count = memory_recall_profiles.missing_count + excluded.missing_count,
        last_used_at = CASE WHEN excluded.last_used_at IS NOT NULL THEN excluded.last_used_at ELSE memory_recall_profiles.last_used_at END,
        last_ignored_at = CASE WHEN excluded.last_ignored_at IS NOT NULL THEN excluded.last_ignored_at ELSE memory_recall_profiles.last_ignored_at END,
        last_missing_at = CASE WHEN excluded.last_missing_at IS NOT NULL THEN excluded.last_missing_at ELSE memory_recall_profiles.last_missing_at END,
        updated_at = excluded.updated_at
    `);
    const updateSet = db.prepare(`
      UPDATE memory_recall_sets
      SET status = ?,
          outcome_reason = ?,
          updated_at = ?,
          resolved_at = ?
      WHERE result_set_id = ?
    `);

    for (const row of targetRows) {
      const identityKey = asString(row.identity_key, '');
      insertEvent.run(
        generateId('recallfbevent'),
        setRow.result_set_id,
        row.result_item_id,
        identityKey || null,
        feedbackType,
        FEEDBACK_WEIGHTS[feedbackType],
        reason,
        JSON.stringify(metadata),
        nowMs
      );
      if (identityKey) {
        upsertProfile.run(
          identityKey,
          feedbackType === 'used' ? 1 : 0,
          feedbackType === 'ignored' ? 1 : 0,
          feedbackType === 'missing' ? 1 : 0,
          feedbackType === 'used' ? nowMs : null,
          feedbackType === 'ignored' ? nowMs : null,
          feedbackType === 'missing' ? nowMs : null,
          nowMs
        );
      }
    }

    updateSet.run(feedbackType, reason, nowMs, nowMs, setRow.result_set_id);
    return {
      resultSetId: setRow.result_set_id,
      matchedCount: targetRows.length,
      status: feedbackType,
    };
  }
}

module.exports = {
  RecallFeedbackService,
  FEEDBACK_WEIGHTS,
  HARD_SUPPRESSION_IGNORED_COUNT,
};
