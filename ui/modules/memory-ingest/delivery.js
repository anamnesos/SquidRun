const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../../config');
const { safeParseJson } = require('./journal');
const { generateId } = require('./schema');

const INJECTION_WINDOW_MS = 10 * 60 * 1000;
const MAX_INJECTIONS_PER_WINDOW = 3;
const MAX_UNREFERENCED_BEFORE_RANK_DOWN = 2;
const DEFAULT_TRIGGER_LIMIT = 25;
const DEFAULT_SURFACED_MEMORY_LIMIT = 5;
const DEFAULT_HANDOFF_SESSION_EXTENSION = 3;
const DEFAULT_TIER1_FILES = Object.freeze([
  'ARCHITECTURE.md',
  'workspace/knowledge/user-context.md',
  'workspace/knowledge/workflows.md',
  'workspace/knowledge/environment.md',
  'workspace/knowledge/devices.md',
  'workspace/knowledge/infrastructure.md',
  'workspace/knowledge/projects.md',
]);

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
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function asInteger(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.floor(numeric);
}

function normalizeTriggerType(value) {
  const normalized = asString(value, '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (normalized === 'error') return 'error_signature_match';
  if (normalized === 'file') return 'file_path_affinity';
  if (normalized === 'domain') return 'task_domain_match';
  if (normalized === 'rollover') return 'session_rollover';
  if (normalized === 'preference') return 'user_preference_activation';
  return normalized;
}

function resolveProjectRoot(options = {}) {
  const explicit = asString(options.projectRoot || options.project_root || options.workspaceRoot || options.workspace_root || '', '');
  return explicit ? path.resolve(explicit) : getProjectRoot();
}

function hashText(value = '') {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');
}

function summarizeText(value, limit = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function computeFileHash(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

function formatInjectionMessage(injection = {}) {
  const title = injection.authoritative ? '[MEMORY][authoritative]' : '[MEMORY][assistive]';
  const freshnessIso = Number.isFinite(Number(injection.freshness_at))
    ? new Date(Number(injection.freshness_at)).toISOString()
    : 'unknown';
  return [
    `${title} ${injection.injection_reason}`,
    `reason=${injection.reason} tier=${injection.source_tier} confidence=${Number(injection.confidence || 0).toFixed(2)} freshness=${freshnessIso}`,
    summarizeText(injection.content, 220),
  ].join('\n');
}

function buildContextKey(triggerType, payload = {}) {
  const input = asObject(payload);
  if (triggerType === 'error_signature_match') {
    return hashText(asString(input.error_signature || input.error || input.signature || '', '').toLowerCase());
  }
  if (triggerType === 'file_path_affinity') {
    const filePath = asString(input.file_path || input.filePath || input.path || '', '').replace(/\\/g, '/').toLowerCase();
    return hashText(filePath);
  }
  if (triggerType === 'task_domain_match') {
    return hashText(asString(input.task_domain || input.taskDomain || input.domain || '', '').toLowerCase());
  }
  if (triggerType === 'session_rollover') {
    return hashText(asString(input.session_id || input.sessionId || input.session_ordinal || input.sessionOrdinal || '', 'session_rollover'));
  }
  if (triggerType === 'user_preference_activation') {
    return hashText(asString(input.preference_key || input.preferenceKey || input.session_id || input.sessionId || '', 'user_preference_activation'));
  }
  return hashText(JSON.stringify(input));
}

function buildClusterKey(memory = {}) {
  return `${memory.memory_class || 'memory'}:${memory.content_hash || hashText(memory.content || '')}`;
}

class MemoryDeliveryService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.ingestService = options.ingestService || null;
    this.projectRoot = resolveProjectRoot(options);
  }

  requireDb() {
    if (!this.db || typeof this.db.prepare !== 'function') {
      throw new Error('memory_delivery_db_unavailable');
    }
    return this.db;
  }

  listInjectionEvents(filters = {}) {
    const db = this.requireDb();
    const paneId = asString(filters.pane_id || filters.paneId || '', '');
    const sessionId = asString(filters.session_id || filters.sessionId || '', '');
    const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.floor(Number(filters.limit))) : 50;
    return db.prepare(`
      SELECT *
      FROM memory_injection_events
      WHERE (? = '' OR pane_id = ?)
        AND (? = '' OR session_id = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(paneId, paneId, sessionId, sessionId, limit);
  }

  getWindowInjectionCount(paneId, nowMs) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_injection_events
      WHERE pane_id = ?
        AND status = 'delivered'
        AND created_at >= ?
    `).get(String(paneId || ''), nowMs - INJECTION_WINDOW_MS);
    return Number(row?.count || 0);
  }

  hasDeliveredTriggerEvent(paneId, triggerEventId) {
    if (!triggerEventId) return false;
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT injection_id
      FROM memory_injection_events
      WHERE pane_id = ?
        AND trigger_event_id = ?
        AND status = 'delivered'
      LIMIT 1
    `).get(String(paneId || ''), String(triggerEventId));
    return Boolean(row?.injection_id);
  }

  getSuppression(paneId, clusterKey) {
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_injection_suppressions
      WHERE pane_id = ?
        AND cluster_key = ?
      LIMIT 1
    `).get(String(paneId || ''), String(clusterKey || ''));
  }

  getUnreferencedCount(memoryId, sessionId) {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_injection_events
      WHERE memory_id = ?
        AND session_id = ?
        AND status = 'delivered'
        AND referenced_at IS NULL
    `).get(String(memoryId || ''), String(sessionId || ''));
    return Number(row?.count || 0);
  }

  incrementInjectionCount(memoryId, nowMs) {
    const db = this.requireDb();
    db.prepare(`
      UPDATE memory_objects
      SET injection_count = COALESCE(injection_count, 0) + 1,
          last_injected_at = ?,
          updated_at = ?
      WHERE memory_id = ?
    `).run(nowMs, nowMs, String(memoryId || ''));
  }

  insertInjectionEvent(event = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_injection_events (
        injection_id,
        pane_id,
        agent_role,
        session_id,
        trigger_type,
        trigger_event_id,
        memory_id,
        memory_class,
        cluster_key,
        context_key,
        injection_reason,
        source_tier,
        authoritative,
        confidence,
        freshness_at,
        status,
        referenced_at,
        dismissed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.injection_id,
      event.pane_id,
      event.agent_role || null,
      event.session_id || null,
      event.trigger_type,
      event.trigger_event_id || null,
      event.memory_id || null,
      event.memory_class || null,
      event.cluster_key || null,
      event.context_key || null,
      event.injection_reason,
      event.source_tier,
      event.authoritative ? 1 : 0,
      Number(event.confidence || 0),
      event.freshness_at || null,
      event.status || 'delivered',
      event.referenced_at || null,
      event.dismissed_at || null,
      event.created_at,
      event.updated_at
    );
  }

  updateInjectionEvent(injectionId, patch = {}) {
    const db = this.requireDb();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries({
      status: 'status',
      referenced_at: 'referenced_at',
      dismissed_at: 'dismissed_at',
    })) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    sets.push('updated_at = ?');
    values.push(patch.updated_at || Date.now());
    values.push(injectionId);
    db.prepare(`UPDATE memory_injection_events SET ${sets.join(', ')} WHERE injection_id = ?`).run(...values);
  }

  upsertSuppression(input = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_injection_suppressions (
        pane_id,
        cluster_key,
        context_key,
        dismissed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pane_id, cluster_key) DO UPDATE
      SET context_key = excluded.context_key,
          dismissed_at = excluded.dismissed_at,
          updated_at = excluded.updated_at
    `).run(
      input.pane_id,
      input.cluster_key,
      input.context_key,
      input.dismissed_at,
      input.updated_at
    );
  }

  listEligibleMemories(triggerType, payload = {}) {
    const db = this.requireDb();
    const limit = Number.isFinite(Number(payload.limit)) ? Math.max(1, Math.floor(Number(payload.limit))) : DEFAULT_TRIGGER_LIMIT;
    let rows = [];
    if (triggerType === 'user_preference_activation') {
      rows = db.prepare(`
        SELECT *
        FROM memory_objects
        WHERE memory_class = 'user_preference'
          AND tier = 'tier1'
          AND COALESCE(lifecycle_state, 'active') NOT IN ('stale', 'archived', 'rejected')
          AND status NOT IN ('rejected', 'superseded', 'corrected', 'expired')
        ORDER BY confidence DESC, freshness_at DESC
        LIMIT ?
      `).all(limit);
    } else if (triggerType === 'session_rollover') {
      rows = db.prepare(`
        SELECT *
        FROM memory_objects
        WHERE memory_class IN ('cross_device_handoff', 'active_task_state', 'solution_trace', 'historical_outcome')
          AND COALESCE(lifecycle_state, 'active') NOT IN ('stale', 'archived', 'rejected')
          AND status NOT IN ('rejected', 'superseded', 'corrected', 'expired')
        ORDER BY updated_at DESC, confidence DESC
        LIMIT ?
      `).all(limit);
    } else {
      rows = db.prepare(`
        SELECT *
        FROM memory_objects
        WHERE tier = 'tier3'
          AND memory_class IN ('solution_trace', 'historical_outcome')
          AND COALESCE(lifecycle_state, 'active') NOT IN ('stale', 'archived', 'rejected')
          AND status NOT IN ('rejected', 'superseded', 'corrected', 'expired')
        ORDER BY confidence DESC, freshness_at DESC
        LIMIT ?
      `).all(limit);
    }

    return rows.map((row) => ({
      ...row,
      provenance: safeParseJson(row.provenance_json, {}),
      scope: safeParseJson(row.scope_json, {}),
      result_refs: safeParseJson(row.result_refs_json, []),
    }));
  }

  memoryMatchesTrigger(memory = {}, triggerType, payload = {}) {
    const haystacks = [
      asString(memory.content, ''),
      asString(memory.source_trace, ''),
      JSON.stringify(memory.scope || {}),
      JSON.stringify(memory.provenance || {}),
    ].join('\n').toLowerCase();

    if (triggerType === 'error_signature_match') {
      const signature = asString(payload.error_signature || payload.error || payload.signature || '', '').toLowerCase();
      if (!signature) return false;
      const tokens = signature.split(/[^a-z0-9_./:-]+/i).map((entry) => entry.trim()).filter((entry) => entry.length >= 4);
      return haystacks.includes(signature) || tokens.some((token) => haystacks.includes(token));
    }

    if (triggerType === 'file_path_affinity') {
      const filePath = asString(payload.file_path || payload.filePath || payload.path || '', '').replace(/\\/g, '/').toLowerCase();
      if (!filePath) return false;
      const baseName = path.posix.basename(filePath);
      return haystacks.includes(filePath) || (baseName && haystacks.includes(baseName));
    }

    if (triggerType === 'task_domain_match') {
      const domain = asString(payload.task_domain || payload.taskDomain || payload.domain || '', '').toLowerCase();
      if (!domain) return false;
      return haystacks.includes(domain) || asString(memory.scope?.domain || memory.scope?.project || '', '').toLowerCase() === domain;
    }

    if (triggerType === 'session_rollover') {
      return true;
    }

    if (triggerType === 'user_preference_activation') {
      const preferenceKey = asString(payload.preference_key || payload.preferenceKey || '', '').toLowerCase();
      return memory.memory_class === 'user_preference' && (!preferenceKey || haystacks.includes(preferenceKey));
    }

    return false;
  }

  computeCandidateScore(memory = {}, triggerType, payload = {}) {
    const nowMs = asInteger(payload.nowMs, Date.now());
    const confidence = Number(memory.confidence || 0);
    const freshnessAt = asInteger(memory.freshness_at, asInteger(memory.updated_at, nowMs)) || nowMs;
    const ageMs = Math.max(0, nowMs - freshnessAt);
    const freshnessBonus = Math.max(0, 0.3 - Math.min(0.3, ageMs / (7 * 24 * 60 * 60 * 1000)));
    const authoritativeBonus = memory.tier === 'tier1' ? 0.25 : 0;
    const injectionPenalty = Math.min(0.4, Number(memory.injection_count || 0) * 0.05);
    const matchBonus = triggerType === 'error_signature_match'
      ? 0.2
      : triggerType === 'file_path_affinity'
        ? 0.15
        : triggerType === 'task_domain_match'
          ? 0.1
          : 0;
    const unreferencedCount = this.getUnreferencedCount(memory.memory_id, asString(payload.session_id || payload.sessionId || '', ''));
    const rankDownPenalty = unreferencedCount >= MAX_UNREFERENCED_BEFORE_RANK_DOWN ? 0.35 : 0;
    return {
      score: confidence + freshnessBonus + authoritativeBonus + matchBonus - injectionPenalty - rankDownPenalty,
      rankDownApplied: rankDownPenalty > 0,
      unreferencedCount,
    };
  }

  selectCandidate(triggerType, payload = {}) {
    const paneId = asString(payload.pane_id || payload.paneId || payload.agent || '1', '1');
    const contextKey = buildContextKey(triggerType, payload);
    const candidates = [];
    for (const memory of this.listEligibleMemories(triggerType, payload)) {
      if (!this.memoryMatchesTrigger(memory, triggerType, payload)) continue;
      const clusterKey = buildClusterKey(memory);
      const suppression = this.getSuppression(paneId, clusterKey);
      if (suppression && suppression.context_key === contextKey) continue;
      const ranking = this.computeCandidateScore(memory, triggerType, payload);
      candidates.push({
        memory,
        clusterKey,
        contextKey,
        ...ranking,
      });
    }
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const freshnessDiff = Number(right.memory.freshness_at || 0) - Number(left.memory.freshness_at || 0);
      if (freshnessDiff !== 0) return freshnessDiff;
      return String(left.memory.memory_id || '').localeCompare(String(right.memory.memory_id || ''));
    });
    return candidates[0] || null;
  }

  getInjectionEvent(injectionId) {
    if (!injectionId) return null;
    const db = this.requireDb();
    return db.prepare(`
      SELECT *
      FROM memory_injection_events
      WHERE injection_id = ?
      LIMIT 1
    `).get(String(injectionId));
  }

  triggerInjection(input = {}) {
    const triggerType = normalizeTriggerType(input.trigger_type || input.triggerType || input.reason || '');
    if (!triggerType) {
      return {
        ok: false,
        reason: 'invalid_trigger_type',
      };
    }

    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const paneId = asString(input.pane_id || input.paneId || input.agent || '1', '1');
    const agentRole = asString(input.agent_role || input.agentRole || '', '') || null;
    const sessionId = asString(input.session_id || input.sessionId || '', '') || null;
    const triggerEventId = asString(input.trigger_event_id || input.triggerEventId || '', '') || null;
    const explicitRequest = input.explicit === true || input.explicit_request === true || input.explicitRequest === true;

    if (!explicitRequest && triggerEventId && this.hasDeliveredTriggerEvent(paneId, triggerEventId)) {
      return {
        ok: true,
        injected: false,
        status: 'already_delivered_for_trigger',
      };
    }

    if (!explicitRequest && this.getWindowInjectionCount(paneId, nowMs) >= MAX_INJECTIONS_PER_WINDOW) {
      return {
        ok: true,
        injected: false,
        status: 'rate_limited',
      };
    }

    const candidate = this.selectCandidate(triggerType, {
      ...input,
      pane_id: paneId,
      session_id: sessionId,
      nowMs,
    });
    if (!candidate) {
      return {
        ok: true,
        injected: false,
        status: 'no_match',
      };
    }

    const memory = candidate.memory;
    const injectionId = generateId('inject');
    const injection = {
      injection_id: injectionId,
      pane_id: paneId,
      agent_role: agentRole,
      session_id: sessionId,
      trigger_type: triggerType,
      trigger_event_id: triggerEventId,
      memory_id: memory.memory_id,
      memory_class: memory.memory_class,
      cluster_key: candidate.clusterKey,
      context_key: candidate.contextKey,
      injection_reason: `${triggerType}:${memory.memory_class}`,
      source_tier: memory.tier,
      authoritative: memory.tier === 'tier1' || String(memory.authority_level || '').toLowerCase() === 'user_override',
      confidence: Math.max(0, Math.min(1, Number(memory.confidence || 0))),
      freshness_at: asInteger(memory.freshness_at, asInteger(memory.updated_at, nowMs)),
      status: 'delivered',
      created_at: nowMs,
      updated_at: nowMs,
      reason: triggerType,
      source_tier_label: memory.tier,
      provenance: memory.provenance,
      result_refs: memory.result_refs,
      content: memory.content,
      rank_down_applied: candidate.rankDownApplied === true,
      unreferenced_count: candidate.unreferencedCount,
      memory_id_ref: memory.memory_id,
    };

    this.insertInjectionEvent(injection);
    this.incrementInjectionCount(memory.memory_id, nowMs);

    return {
      ok: true,
      injected: true,
      status: 'delivered',
      injection: {
        ...injection,
        memory_id: memory.memory_id,
        source_tier: memory.tier,
        result_refs: memory.result_refs,
        message: formatInjectionMessage(injection),
      },
    };
  }

  recordInjectionFeedback(input = {}) {
    const injectionId = asString(input.injection_id || input.injectionId || input.deliveryId || '', '');
    if (!injectionId) {
      return {
        ok: false,
        reason: 'injection_id_required',
      };
    }

    const event = this.getInjectionEvent(injectionId);
    if (!event) {
      return {
        ok: false,
        reason: 'injection_not_found',
      };
    }

    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const feedback = asString(input.feedback || input.outcome || input.status || '', '').toLowerCase();
    const patch = {
      updated_at: nowMs,
    };

    if (feedback.includes('dismiss')) {
      patch.dismissed_at = nowMs;
      patch.status = 'dismissed';
      this.upsertSuppression({
        pane_id: event.pane_id,
        cluster_key: event.cluster_key,
        context_key: event.context_key,
        dismissed_at: nowMs,
        updated_at: nowMs,
      });
    } else if (feedback.includes('reference') || feedback.includes('useful') || feedback.includes('used')) {
      patch.referenced_at = nowMs;
      patch.status = 'referenced';
    } else if (feedback.includes('deliver')) {
      patch.status = 'delivered';
    }

    this.updateInjectionEvent(injectionId, patch);
    return {
      ok: true,
      injection_id: injectionId,
      status: patch.status || event.status,
      referenced_at: patch.referenced_at || event.referenced_at || null,
      dismissed_at: patch.dismissed_at || event.dismissed_at || null,
    };
  }

  listRecentSurfacedMemories(filters = {}) {
    const db = this.requireDb();
    const paneId = asString(filters.pane_id || filters.paneId || '', '');
    const sessionId = asString(filters.session_id || filters.sessionId || '', '');
    const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.floor(Number(filters.limit))) : DEFAULT_SURFACED_MEMORY_LIMIT;
    return db.prepare(`
      SELECT
        e.injection_id,
        e.memory_id,
        e.memory_class,
        e.injection_reason,
        e.source_tier,
        e.authoritative,
        e.confidence,
        e.freshness_at,
        e.created_at AS injected_at,
        m.content,
        m.result_refs_json
      FROM memory_injection_events e
      LEFT JOIN memory_objects m ON m.memory_id = e.memory_id
      WHERE e.status IN ('delivered', 'referenced')
        AND (? = '' OR e.pane_id = ?)
        AND (? = '' OR e.session_id = ?)
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(paneId, paneId, sessionId, sessionId, limit).map((row) => ({
      injection_id: row.injection_id,
      memory_id: row.memory_id,
      memory_class: row.memory_class,
      injection_reason: row.injection_reason,
      source_tier: row.source_tier,
      authoritative: Number(row.authoritative || 0) === 1,
      confidence: Number(row.confidence || 0),
      freshness_at: row.freshness_at || null,
      injected_at: row.injected_at,
      content_summary: summarizeText(row.content || '', 160),
      result_refs: safeParseJson(row.result_refs_json, []),
    }));
  }

  insertHandoffPacket(packet = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_handoff_packets (
        packet_id,
        ingest_id,
        source_memory_id,
        session_id,
        source_device,
        target_device,
        packet_json,
        status,
        expires_at_session,
        sent_at,
        received_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(packet_id) DO UPDATE SET
        ingest_id = excluded.ingest_id,
        source_memory_id = excluded.source_memory_id,
        target_device = excluded.target_device,
        packet_json = excluded.packet_json,
        status = excluded.status,
        expires_at_session = excluded.expires_at_session,
        sent_at = excluded.sent_at,
        received_at = excluded.received_at,
        updated_at = excluded.updated_at
    `).run(
      packet.packet_id,
      packet.ingest_id || null,
      packet.source_memory_id || null,
      packet.session_id,
      packet.source_device,
      packet.target_device || null,
      JSON.stringify(packet.packet_json || {}),
      packet.status || 'built',
      packet.expires_at_session || null,
      packet.sent_at || null,
      packet.received_at || null,
      packet.created_at,
      packet.updated_at
    );
  }

  updateHandoffPacket(packetId, patch = {}) {
    const db = this.requireDb();
    const existing = db.prepare(`
      SELECT *
      FROM memory_handoff_packets
      WHERE packet_id = ?
      LIMIT 1
    `).get(String(packetId || ''));
    if (!existing) {
      return {
        ok: false,
        reason: 'handoff_not_found',
      };
    }

    const mergedPacketJson = Object.prototype.hasOwnProperty.call(patch, 'packet_json')
      ? JSON.stringify(patch.packet_json || {})
      : existing.packet_json;
    db.prepare(`
      UPDATE memory_handoff_packets
      SET status = ?,
          packet_json = ?,
          sent_at = ?,
          received_at = ?,
          updated_at = ?
      WHERE packet_id = ?
    `).run(
      patch.status || existing.status,
      mergedPacketJson,
      Object.prototype.hasOwnProperty.call(patch, 'sent_at') ? patch.sent_at : existing.sent_at,
      Object.prototype.hasOwnProperty.call(patch, 'received_at') ? patch.received_at : existing.received_at,
      patch.updated_at || Date.now(),
      String(packetId || '')
    );
    return { ok: true, packet_id: packetId };
  }

  buildCrossDeviceHandoff(input = {}) {
    if (!this.ingestService || typeof this.ingestService.ingest !== 'function') {
      return {
        ok: false,
        reason: 'ingest_service_unavailable',
      };
    }

    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const sessionOrdinal = asInteger(input.session_ordinal || input.sessionOrdinal, null);
    const packetId = asString(input.packet_id || input.packetId || '', '') || generateId('handoff');
    const sessionId = asString(input.session_id || input.sessionId || '', '') || `session-${nowMs}`;
    const sourceDevice = asString(input.source_device || input.sourceDevice || process.env.SQUIDRUN_DEVICE_ID || 'LOCAL', 'LOCAL');
    const targetDevice = asString(input.target_device || input.targetDevice || '', '') || null;
    const activeWorkstreams = asArray(input.active_workstreams || input.activeWorkstreams).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const unresolvedBlockers = asArray(input.unresolved_blockers || input.unresolvedBlockers).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const recentSurfacedMemories = Array.isArray(input.recent_surfaced_memories || input.recentSurfacedMemories)
      ? (input.recent_surfaced_memories || input.recentSurfacedMemories)
      : this.listRecentSurfacedMemories({
          pane_id: input.pane_id || input.paneId || '',
          session_id: sessionId,
          limit: DEFAULT_SURFACED_MEMORY_LIMIT,
        });
    const expiresAtSession = sessionOrdinal === null ? null : sessionOrdinal + DEFAULT_HANDOFF_SESSION_EXTENSION;
    const expiryTimestamp = Number.isFinite(Number(input.expiry_timestamp || input.expiryTimestamp))
      ? Math.floor(Number(input.expiry_timestamp || input.expiryTimestamp))
      : nowMs + (DEFAULT_HANDOFF_SESSION_EXTENSION * 24 * 60 * 60 * 1000);

    const packet = {
      packet_id: packetId,
      session_id: sessionId,
      source_device: sourceDevice,
      target_device: targetDevice,
      active_workstreams: activeWorkstreams,
      unresolved_blockers: unresolvedBlockers,
      recent_surfaced_memories: recentSurfacedMemories,
      expiry_timestamp: expiryTimestamp,
      expires_at_session: expiresAtSession,
    };
    const summaryParts = [
      `Cross-device handoff from ${sourceDevice}`,
      activeWorkstreams.length > 0 ? `Workstreams: ${activeWorkstreams.join(' | ')}` : null,
      unresolvedBlockers.length > 0 ? `Blockers: ${unresolvedBlockers.join(' | ')}` : null,
    ].filter(Boolean);

    const ingestResult = this.ingestService.ingest({
      content: summaryParts.join('\n'),
      memory_class: 'cross_device_handoff',
      provenance: {
        source: 'system',
        kind: 'cross_device_handoff',
        actor: 'system',
      },
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.95,
      source_trace: asString(input.source_trace || input.sourceTrace || '', '') || `handoff:${packetId}`,
      device_id: sourceDevice,
      session_id: sessionId,
      session_ordinal: sessionOrdinal,
      scope: {
        handoff_packet_id: packetId,
        source_device: sourceDevice,
        target_device: targetDevice,
        active_workstreams: activeWorkstreams,
        unresolved_blockers: unresolvedBlockers,
        recent_surfaced_memories: recentSurfacedMemories,
      },
      expires_at: expiryTimestamp,
    }, {
      nowMs,
      deviceId: sourceDevice,
      sessionId,
      projectRoot: this.projectRoot,
    });
    if (!ingestResult?.ok) {
      return ingestResult;
    }

    const sourceMemoryRef = asArray(ingestResult.result_refs).find((entry) => entry && entry.kind === 'memory_object') || null;
    this.insertHandoffPacket({
      packet_id: packetId,
      ingest_id: ingestResult.ingest_id || null,
      source_memory_id: sourceMemoryRef?.id || null,
      session_id: sessionId,
      source_device: sourceDevice,
      target_device: targetDevice,
      packet_json: packet,
      status: 'built',
      expires_at_session: expiresAtSession,
      created_at: nowMs,
      updated_at: nowMs,
    });

    return {
      ok: true,
      packet_id: packetId,
      packet,
      result_refs: ingestResult.result_refs || [],
    };
  }

  markHandoffSent(input = {}) {
    const packetId = asString(input.packet_id || input.packetId || '', '');
    if (!packetId) {
      return {
        ok: false,
        reason: 'packet_id_required',
      };
    }
    return this.updateHandoffPacket(packetId, {
      status: 'sent',
      sent_at: asInteger(input.sent_at || input.sentAt, Date.now()),
      updated_at: asInteger(input.nowMs || input.now_ms, Date.now()),
      packet_json: input.packet_json || input.packetJson,
    });
  }

  receiveCrossDeviceHandoff(input = {}) {
    if (!this.ingestService || typeof this.ingestService.ingest !== 'function') {
      return {
        ok: false,
        reason: 'ingest_service_unavailable',
      };
    }

    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const packet = asObject(input.packet || input.payload || input);
    const packetId = asString(packet.packet_id || packet.packetId || '', '');
    if (!packetId) {
      return {
        ok: false,
        reason: 'packet_id_required',
      };
    }

    const sessionId = asString(packet.session_id || packet.sessionId || '', '') || null;
    const sourceDevice = asString(packet.source_device || packet.sourceDevice || '', '') || 'UNKNOWN';
    const targetDevice = asString(packet.target_device || packet.targetDevice || '', '') || null;
    const activeWorkstreams = asArray(packet.active_workstreams || packet.activeWorkstreams).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const unresolvedBlockers = asArray(packet.unresolved_blockers || packet.unresolvedBlockers).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const surfaced = asArray(packet.recent_surfaced_memories || packet.recentSurfacedMemories);
    const noteContent = [
      `Cross-device handoff received from ${sourceDevice}`,
      activeWorkstreams.length > 0 ? `Workstreams: ${activeWorkstreams.join(' | ')}` : null,
      unresolvedBlockers.length > 0 ? `Blockers: ${unresolvedBlockers.join(' | ')}` : null,
    ].filter(Boolean).join('\n');

    const ingestResult = this.ingestService.ingest({
      content: noteContent,
      memory_class: 'cross_device_handoff',
      provenance: {
        source: 'bridge',
        kind: 'cross_device_handoff_receive',
        actor: 'system',
      },
      confidence: 0.95,
      source_trace: `handoff-recv:${packetId}`,
      device_id: targetDevice || process.env.SQUIDRUN_DEVICE_ID || null,
      session_id: sessionId,
      scope: {
        handoff_packet_id: packetId,
        source_device: sourceDevice,
        target_device: targetDevice,
        active_workstreams: activeWorkstreams,
        unresolved_blockers: unresolvedBlockers,
        recent_surfaced_memories: surfaced,
      },
      expires_at: packet.expiry_timestamp || packet.expiryTimestamp || null,
    }, {
      nowMs,
      deviceId: targetDevice || process.env.SQUIDRUN_DEVICE_ID || null,
      sessionId,
      projectRoot: this.projectRoot,
    });
    if (!ingestResult?.ok) {
      return ingestResult;
    }

    const sourceMemoryRef = asArray(ingestResult.result_refs).find((entry) => entry && entry.kind === 'memory_object') || null;
    this.insertHandoffPacket({
      packet_id: packetId,
      ingest_id: ingestResult.ingest_id || null,
      source_memory_id: sourceMemoryRef?.id || null,
      session_id: sessionId || `session-${nowMs}`,
      source_device: sourceDevice,
      target_device: targetDevice,
      packet_json: packet,
      status: 'received',
      expires_at_session: asInteger(packet.expires_at_session || packet.expiresAtSession, null),
      received_at: nowMs,
      created_at: nowMs,
      updated_at: nowMs,
    });

    return {
      ok: true,
      packet_id: packetId,
      received: true,
      injection: {
        message: [
          `[HANDOFF ${sourceDevice}] ${activeWorkstreams[0] || 'Cross-device continuation ready'}`,
          unresolvedBlockers.length > 0 ? `Blockers: ${unresolvedBlockers.join(' | ')}` : 'Blockers: none',
          surfaced.length > 0 ? `Surfaced memories: ${surfaced.length}` : 'Surfaced memories: 0',
        ].join('\n'),
        panes: [asString(input.pane_id || input.paneId || '1', '1')],
      },
      result_refs: ingestResult.result_refs || [],
    };
  }

  listTier1Snapshots(input = {}) {
    const projectRoot = resolveProjectRoot({
      projectRoot: input.project_root || input.projectRoot || this.projectRoot,
    });
    return DEFAULT_TIER1_FILES.map((relativePath) => {
      const absolutePath = path.resolve(projectRoot, relativePath);
      const exists = fs.existsSync(absolutePath);
      return {
        path: relativePath,
        absolute_path: absolutePath,
        exists,
        sha1: exists ? computeFileHash(absolutePath) : null,
      };
    });
  }

  insertCompactionSurvival(entry = {}) {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_compaction_survival (
        survival_id,
        pane_id,
        session_id,
        note_memory_id,
        summary_json,
        tier1_snapshot_json,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(survival_id) DO UPDATE SET
        note_memory_id = excluded.note_memory_id,
        summary_json = excluded.summary_json,
        tier1_snapshot_json = excluded.tier1_snapshot_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      entry.survival_id,
      entry.pane_id || null,
      entry.session_id || null,
      entry.note_memory_id || null,
      JSON.stringify(entry.summary_json || {}),
      JSON.stringify(entry.tier1_snapshot_json || []),
      entry.status || 'prepared',
      entry.created_at,
      entry.updated_at
    );
  }

  updateCompactionSurvival(survivalId, patch = {}) {
    const db = this.requireDb();
    const existing = db.prepare(`
      SELECT *
      FROM memory_compaction_survival
      WHERE survival_id = ?
      LIMIT 1
    `).get(String(survivalId || ''));
    if (!existing) {
      return {
        ok: false,
        reason: 'survival_not_found',
      };
    }

    db.prepare(`
      UPDATE memory_compaction_survival
      SET note_memory_id = ?,
          summary_json = ?,
          tier1_snapshot_json = ?,
          status = ?,
          updated_at = ?
      WHERE survival_id = ?
    `).run(
      Object.prototype.hasOwnProperty.call(patch, 'note_memory_id') ? patch.note_memory_id : existing.note_memory_id,
      Object.prototype.hasOwnProperty.call(patch, 'summary_json') ? JSON.stringify(patch.summary_json || {}) : existing.summary_json,
      Object.prototype.hasOwnProperty.call(patch, 'tier1_snapshot_json') ? JSON.stringify(patch.tier1_snapshot_json || []) : existing.tier1_snapshot_json,
      patch.status || existing.status,
      patch.updated_at || Date.now(),
      String(survivalId || '')
    );
    return { ok: true, survival_id: survivalId };
  }

  getLatestCompactionSurvival(input = {}) {
    const db = this.requireDb();
    const paneId = asString(input.pane_id || input.paneId || '', '');
    const sessionId = asString(input.session_id || input.sessionId || '', '');
    const row = db.prepare(`
      SELECT *
      FROM memory_compaction_survival
      WHERE (? = '' OR pane_id = ?)
        AND (? = '' OR session_id = ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(paneId, paneId, sessionId, sessionId);
    if (!row) return null;
    return {
      ...row,
      summary: safeParseJson(row.summary_json, {}),
      tier1_snapshot: safeParseJson(row.tier1_snapshot_json, []),
    };
  }

  prepareCompactionSurvival(input = {}) {
    if (!this.ingestService || typeof this.ingestService.ingest !== 'function') {
      return {
        ok: false,
        reason: 'ingest_service_unavailable',
      };
    }

    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const paneId = asString(input.pane_id || input.paneId || '1', '1');
    const sessionId = asString(input.session_id || input.sessionId || '', '') || null;
    const role = asString(input.role || input.agent_role || input.agentRole || 'builder', 'builder');
    const projectRoot = resolveProjectRoot({
      projectRoot: input.project_root || input.projectRoot || this.projectRoot,
    });
    const activeWorkstreams = asArray(input.active_workstreams || input.activeWorkstreams).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const unfinishedWork = asArray(input.unfinished_work || input.unfinishedWork).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const blockers = asArray(input.unresolved_blockers || input.unresolvedBlockers).map((entry) => summarizeText(entry, 180)).filter(Boolean);
    const insights = asArray(input.uncommitted_insights || input.uncommittedInsights).map((entry) => summarizeText(entry, 240)).filter(Boolean);
    const survivalId = asString(input.survival_id || input.survivalId || '', '') || generateId('survival');

    const insightRefs = [];
    for (const insight of insights) {
      const insightResult = this.ingestService.ingest({
        content: insight,
        memory_class: 'historical_outcome',
        provenance: {
          source: 'system',
          kind: 'compaction_survival_extract',
          actor: role,
        },
        confidence: 0.8,
        source_trace: `compaction-survival:${survivalId}:${hashText(insight).slice(0, 10)}`,
        session_id: sessionId,
        scope: {
          pane_id: paneId,
          hook: 'compaction_survival',
        },
      }, {
        nowMs,
        sessionId,
        projectRoot,
      });
      if (insightResult?.ok === true) {
        insightRefs.push(...asArray(insightResult.result_refs));
      }
    }

    const noteLines = [
      `Compaction survival note for pane ${paneId}`,
      activeWorkstreams.length > 0 ? `Active workstreams: ${activeWorkstreams.join(' | ')}` : null,
      unfinishedWork.length > 0 ? `Unfinished work: ${unfinishedWork.join(' | ')}` : null,
      blockers.length > 0 ? `Blockers: ${blockers.join(' | ')}` : null,
    ].filter(Boolean);
    const noteResult = this.ingestService.ingest({
      content: noteLines.join('\n'),
      memory_class: 'active_task_state',
      provenance: {
        source: 'system',
        kind: 'compaction_survival_note',
        actor: role,
      },
      confidence: 1,
      source_trace: `compaction-survival-note:${survivalId}`,
      session_id: sessionId,
      scope: {
        pane_id: paneId,
        hook: 'compaction_survival',
        active_workstreams: activeWorkstreams,
        unfinished_work: unfinishedWork,
        unresolved_blockers: blockers,
      },
      expires_at: nowMs + (6 * 60 * 60 * 1000),
    }, {
      nowMs,
      sessionId,
      projectRoot,
    });
    if (!noteResult?.ok) {
      return noteResult;
    }

    const noteMemoryRef = asArray(noteResult.result_refs).find((entry) => entry && entry.kind === 'memory_object') || null;
    const tier1Snapshot = this.listTier1Snapshots({ project_root: projectRoot });
    const summary = {
      active_workstreams: activeWorkstreams,
      unfinished_work: unfinishedWork,
      unresolved_blockers: blockers,
      uncommitted_insight_count: insights.length,
      result_refs: [...noteResult.result_refs, ...insightRefs],
    };
    this.insertCompactionSurvival({
      survival_id: survivalId,
      pane_id: paneId,
      session_id: sessionId,
      note_memory_id: noteMemoryRef?.id || null,
      summary_json: summary,
      tier1_snapshot_json: tier1Snapshot,
      status: 'prepared',
      created_at: nowMs,
      updated_at: nowMs,
    });

    return {
      ok: true,
      survival_id: survivalId,
      note_memory_id: noteMemoryRef?.id || null,
      tier1_snapshot: tier1Snapshot,
      result_refs: [...noteResult.result_refs, ...insightRefs],
    };
  }

  resumeCompactionSurvival(input = {}) {
    const nowMs = asInteger(input.nowMs || input.now_ms, Date.now());
    const paneId = asString(input.pane_id || input.paneId || '', '');
    const sessionId = asString(input.session_id || input.sessionId || '', '');
    const projectRoot = resolveProjectRoot({
      projectRoot: input.project_root || input.projectRoot || this.projectRoot,
    });
    const survival = this.getLatestCompactionSurvival({
      pane_id: paneId,
      session_id: sessionId,
    });
    if (!survival) {
      return {
        ok: true,
        resumed: false,
        status: 'no_survival_note',
      };
    }

    const freshSnapshot = this.listTier1Snapshots({ project_root: projectRoot });
    this.updateCompactionSurvival(survival.survival_id, {
      tier1_snapshot_json: freshSnapshot,
      status: 'resumed',
      updated_at: nowMs,
    });

    return {
      ok: true,
      resumed: true,
      survival_id: survival.survival_id,
      tier1_snapshot: freshSnapshot,
      injection: {
        message: [
          `[COMPACTION RESUME] Pane ${paneId || 'unknown'} context restored`,
          summarizeText(`Active workstreams: ${asArray(survival.summary?.active_workstreams).join(' | ')}`, 220),
          `Tier 1 re-read: ${freshSnapshot.filter((entry) => entry.exists).map((entry) => entry.path).join(', ')}`,
        ].join('\n'),
        panes: [paneId || '1'],
      },
    };
  }
}

module.exports = {
  DEFAULT_HANDOFF_SESSION_EXTENSION,
  DEFAULT_TIER1_FILES,
  INJECTION_WINDOW_MS,
  MAX_INJECTIONS_PER_WINDOW,
  MAX_UNREFERENCED_BEFORE_RANK_DOWN,
  MemoryDeliveryService,
  buildClusterKey,
  buildContextKey,
  formatInjectionMessage,
  normalizeTriggerType,
};
