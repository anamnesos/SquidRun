const { buildCanonicalMemoryObject, generateId, hashContent, normalizeClaimType } = require('./schema');
const { hasDirectUserCorrection, resolveMemoryRoute } = require('./router');
const { MemoryIngestJournal, safeParseJson, utcDayBucket } = require('./journal');
const { MemoryIngestShutdownMarker } = require('./shutdown-marker');
const { buildPromotionArtifacts, MemoryPromotionService } = require('./promotion');

const DEFAULT_REPLAY_BATCH_SIZE = 25;
const DEFAULT_REPLAY_TICK_MS = 250;
const DEFAULT_REPLAY_MAX_TICK_MS = 250;
const DEFAULT_REPLAY_MAX_PASSES = 3;
const DEFAULT_COMPACTION_LOCKED_TIERS = Object.freeze(['tier1', 'tier3']);
const DEFAULT_MAX_RETRY_DELAY_MS = 60000;
const BACKOFF_BASE_MS = 250;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === 'object');
}

function nowMsFrom(value, fallback = Date.now()) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
}

function determineOverrideMode(memory = {}) {
  const claimType = normalizeClaimType(memory.claim_type);
  if (!claimType) return null;
  if (claimType === 'objective_fact') return 'objective_fact_note';
  const directUserCorrection = hasDirectUserCorrection(memory.provenance);
  if (!directUserCorrection && claimType !== 'preference' && claimType !== 'operational_correction') return null;
  if (claimType === 'operational_correction') return 'operational_correction';
  if (claimType === 'preference') return 'preference_override';
  return null;
}

function buildOverrideNote(memory = {}, mode = 'preference_override') {
  const prefix = mode === 'objective_fact_note'
    ? 'User-stated factual contradiction pending verification'
    : mode === 'operational_correction'
      ? 'Immediate user correction applied for this session pending verification'
      : 'Immediate user preference override applied for this session';
  return `${prefix}: ${memory.content}`;
}

function computeRetryDelay(attemptCount = 1) {
  const exponent = Math.max(0, Math.min(8, Math.floor(Number(attemptCount) || 0) - 1));
  return Math.min(DEFAULT_MAX_RETRY_DELAY_MS, BACKOFF_BASE_MS * (2 ** exponent));
}

function isRetryableRouteError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('locked')
    || message.includes('busy')
    || message.includes('sql')
    || message.includes('constraint')
    || message.includes('memory_ingest_compaction_locked');
}

function deriveQueueReason(err, fallback = 'route_retry') {
  const message = String(err?.message || '').toLowerCase();
  if (message.includes('memory_ingest_compaction_locked')) return 'compaction_lock';
  if (message.includes('locked') || message.includes('busy')) return 'store_locked';
  if (message.includes('constraint')) return 'constraint_retry';
  return fallback;
}

class MemoryIngestService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.logger = options.logger || console;
    this.idFactory = typeof options.generateId === 'function' ? options.generateId : generateId;
    this.journal = options.journal || new MemoryIngestJournal(this.db);
    this.shutdownMarker = options.shutdownMarker || new MemoryIngestShutdownMarker(asObject(options.shutdownMarkerOptions));
    this.promotionService = options.promotionService || new MemoryPromotionService({
      db: this.db,
      projectRoot: options.projectRoot,
      workspaceRoot: options.workspaceRoot,
    });
    this.replayBatchSize = Number.isFinite(Number(options.replayBatchSize))
      ? Math.max(1, Math.floor(Number(options.replayBatchSize)))
      : DEFAULT_REPLAY_BATCH_SIZE;
    this.replayTickMs = Number.isFinite(Number(options.replayTickMs))
      ? Math.max(0, Math.floor(Number(options.replayTickMs)))
      : DEFAULT_REPLAY_TICK_MS;
    this.replayMaxTickMs = Number.isFinite(Number(options.replayMaxTickMs))
      ? Math.max(10, Math.floor(Number(options.replayMaxTickMs)))
      : DEFAULT_REPLAY_MAX_TICK_MS;
    this.replayMaxPasses = Number.isFinite(Number(options.replayMaxPasses))
      ? Math.max(1, Math.floor(Number(options.replayMaxPasses)))
      : DEFAULT_REPLAY_MAX_PASSES;
    this.recoveryTimer = null;
    this.recoveryRunning = false;
    this.startupInfo = null;
    this.backlogTier4Emitted = false;
  }

  initializeRuntime(options = {}) {
    if (this.startupInfo) {
      return {
        ok: true,
        startup: this.startupInfo,
        status: this.getStatus({ nowMs: options.nowMs }),
      };
    }

    const nowMs = nowMsFrom(options.nowMs);
    const markerResult = this.shutdownMarker.armStartup({
      nowMs,
      sessionId: options.sessionId,
      deviceId: options.deviceId,
      reason: options.reason || 'team-memory-runtime-start',
    });

    if (markerResult.hadAbruptShutdown) {
      this.clearCompactionLock({
        nowMs,
        reason: 'cleared_after_unclean_shutdown',
        source: 'memory-ingest-startup',
      });
    }

    const outstanding = this.journal.countOutstandingEntries();
    const ready = this.journal.countReplayableEntries(nowMs);
    this.startupInfo = {
      ok: true,
      hadAbruptShutdown: markerResult.hadAbruptShutdown,
      pendingOutstanding: outstanding,
      pendingReady: ready,
      markerPath: markerResult.filePath,
    };

    this.updateRecoveryStatus({
      nowMs,
      running: false,
      reason: markerResult.hadAbruptShutdown ? 'unclean_shutdown' : 'startup',
      pendingOutstanding: outstanding,
      pendingReady: ready,
      lastCheckpoint: null,
      lastError: null,
      startedAt: nowMs,
    });

    if (markerResult.hadAbruptShutdown || outstanding > 0) {
      this.scheduleRecovery({
        immediate: true,
        nowMs,
        reason: markerResult.hadAbruptShutdown ? 'unclean_shutdown' : 'pending_backlog',
      });
    }

    return {
      ok: true,
      startup: this.startupInfo,
      status: this.getStatus({ nowMs }),
    };
  }

  shutdown(options = {}) {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const nowMs = nowMsFrom(options.nowMs);
    this.updateRecoveryStatus({
      nowMs,
      running: false,
      reason: 'shutdown',
      pendingOutstanding: this.journal.countOutstandingEntries(),
      pendingReady: this.journal.countReplayableEntries(nowMs),
      lastCheckpoint: null,
      lastError: null,
      completedAt: nowMs,
    });
    return this.shutdownMarker.markCleanShutdown({
      nowMs,
      sessionId: options.sessionId,
      deviceId: options.deviceId,
      reason: options.reason || 'team-memory-runtime-stop',
    });
  }

  ingest(payload = {}, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const projectRoot = options.projectRoot || payload.project_root || payload.projectRoot || payload.workspace_root || payload.workspaceRoot;
    const buildResult = buildCanonicalMemoryObject(payload, {
      nowMs,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
    });

    if (!buildResult.ok) {
      return {
        ok: false,
        reason: buildResult.reason,
        errors: buildResult.errors || [],
      };
    }

    const memory = buildResult.memory;
    const overrideMode = determineOverrideMode(memory);
    if (overrideMode === 'objective_fact_note') {
      return this.createSessionOverrideNote(memory, {
        nowMs,
        overrideMode,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
      });
    }

    const route = resolveMemoryRoute(memory);
    if (!route.ok) {
      return {
        ok: false,
        reason: route.reason,
        memory_class: memory.memory_class,
      };
    }

    memory.tier = route.tier;
    memory.authority_level = route.authorityLevel;
    memory.status = route.promotionRequired ? 'pending' : 'active';
    memory.content_hash = memory.content_hash || hashContent(memory.content);
    memory.dedupe_key = memory.dedupe_key || `${memory.content_hash}:${memory.memory_class}`;

    const persistResult = this.persistEnvelope(memory, route, nowMs);
    if (!persistResult.ok) {
      return {
        ok: false,
        reason: persistResult.reason || 'journal_persist_failed',
        ingest_id: memory.ingest_id,
        memory_class: memory.memory_class,
        error: persistResult.error || null,
      };
    }

    const routed = this.routePersistedEntry(memory.ingest_id, {
      nowMs,
      routeHint: route,
      reason: 'direct_ingest',
      projectRoot,
    });
    if (!routed?.ok) return routed;

    if (overrideMode === 'preference_override' || overrideMode === 'operational_correction') {
      const note = this.createSessionOverrideNote(memory, {
        nowMs,
        overrideMode,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
        sourceMemoryId: memory.memory_id,
      });
      if (note?.ok) {
        routed.result_refs = [...(routed.result_refs || []), ...(note.result_refs || [])];
      }
    }
    return routed;
  }

  createSessionOverrideNote(memory = {}, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const noteMemoryId = this.idFactory('memory');
    const noteIngestId = this.idFactory('ingest');
    const note = {
      ingest_id: noteIngestId,
      memory_id: noteMemoryId,
      memory_class: 'active_task_state',
      tier: 'tier4',
      status: 'active',
      lifecycle_state: 'active',
      authority_level: 'user_override',
      content: buildOverrideNote(memory, options.overrideMode),
      content_hash: hashContent(buildOverrideNote(memory, options.overrideMode)),
      provenance: {
        source: 'system',
        kind: 'user_override_note',
        actor: 'system',
      },
      source_trace: `override:${memory.memory_id || memory.ingest_id || 'memory'}:${nowMs}`,
      created_at: nowMs,
      updated_at: nowMs,
      freshness_at: nowMs,
      confidence: 1,
      scope: {
        override_mode: options.overrideMode,
        source_memory_id: options.sourceMemoryId || memory.memory_id || null,
      },
      device_id: memory.device_id || options.deviceId || null,
      session_id: memory.session_id || options.sessionId || null,
      session_ordinal: memory.session_ordinal || null,
      claim_type: memory.claim_type || null,
      correction_of: memory.correction_of || null,
      supersedes: memory.supersedes || null,
      expires_at: nowMs + (60 * 60 * 1000),
      result_refs: [{
        kind: 'memory_object',
        id: noteMemoryId,
        tier: 'tier4',
      }],
    };

    const db = this.journal.requireDb();
    db.exec('BEGIN IMMEDIATE;');
    try {
      this.journal.insertJournalEntry({
        ingest_id: noteIngestId,
        memory_id: noteMemoryId,
        memory_class: note.memory_class,
        content_hash: note.content_hash,
        dedupe_key: `${note.content_hash}:${note.memory_class}`,
        time_bucket: utcDayBucket(nowMs),
        route_tier: 'tier4',
        promotion_required: false,
        status: 'routed',
        payload: note,
        result_refs: note.result_refs,
        attempt_count: 0,
        last_attempt_at: nowMs,
        next_attempt_at: null,
        queue_reason: null,
        created_at: nowMs,
        updated_at: nowMs,
      });
      this.journal.insertMemoryObject(note);
      this.journal.insertDedupeRecord({
        memory_class: note.memory_class,
        dedupe_key: `${note.content_hash}:${note.memory_class}`,
        time_bucket: utcDayBucket(nowMs),
        ingest_id: note.ingest_id,
        memory_id: note.memory_id,
        result_refs: note.result_refs,
        created_at: nowMs,
        updated_at: nowMs,
      });
      db.exec('COMMIT;');
      return {
        ok: true,
        ingest_id: note.ingest_id,
        routed_to_tier: 'tier4',
        promotion_required: false,
        deduped: false,
        queued: false,
        result_refs: note.result_refs,
      };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'override_note_failed',
        error: err.message,
      };
    }
  }

  capturePrecompactState(payload = {}, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const input = asObject(payload);
    const paneId = asString(input.pane_id || input.paneId || '', '') || null;
    const role = asString(input.role || input.owner || '', '') || 'system';
    const summary = asString(input.content || input.summary || input.note || '', '');
    const content = summary || `Pre-compact state captured for ${paneId || role}.`;

    return this.ingest({
      content,
      memory_class: 'active_task_state',
      provenance: {
        source: 'system',
        kind: 'precompact_hook',
        actor: role,
      },
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 1,
      source_trace: asString(input.source_trace || input.sourceTrace || '', '') || `precompact:${paneId || role}:${nowMs}`,
      device_id: input.device_id || input.deviceId || null,
      session_id: input.session_id || input.sessionId || null,
      scope: {
        ...(asObject(input.scope)),
        pane_id: paneId,
        reason: asString(input.reason || 'compaction_detected', 'compaction_detected'),
        hook: 'precompact',
      },
      expires_at: input.expires_at || input.expiresAt || null,
    }, {
      nowMs,
      deviceId: input.device_id || input.deviceId,
      sessionId: input.session_id || input.sessionId,
    });
  }

  setCompactionLock(payload = {}, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const input = asObject(payload);
    const locked = input.locked !== false;
    const state = locked
      ? {
          locked: true,
          locked_tiers: Array.isArray(input.locked_tiers || input.lockedTiers)
            ? [...new Set((input.locked_tiers || input.lockedTiers).map((entry) => asString(entry, '')).filter(Boolean))]
            : [...DEFAULT_COMPACTION_LOCKED_TIERS],
          reason: asString(input.reason || 'compaction_in_progress', 'compaction_in_progress'),
          source: asString(input.source || 'memory-ingest', 'memory-ingest'),
          locked_at: nowMs,
          expires_at: Number.isFinite(Number(input.expires_at || input.expiresAt))
            ? Math.floor(Number(input.expires_at || input.expiresAt))
            : null,
        }
      : {
          locked: false,
          locked_tiers: [],
          reason: asString(input.reason || 'compaction_complete', 'compaction_complete'),
          source: asString(input.source || 'memory-ingest', 'memory-ingest'),
          unlocked_at: nowMs,
        };

    this.journal.setRuntimeState('compaction_lock', state, nowMs);
    if (!locked) {
      this.scheduleRecovery({
        immediate: true,
        nowMs,
        reason: 'compaction_unlock',
      });
    }

    return {
      ok: true,
      compaction_lock: state,
    };
  }

  clearCompactionLock(options = {}) {
    return this.setCompactionLock({
      locked: false,
      reason: options.reason || 'compaction_lock_cleared',
      source: options.source || 'memory-ingest',
    }, options);
  }

  replayPending(options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    return this.runRecoveryPass({
      nowMs,
      reason: options.reason || 'manual_replay',
      limit: options.limit,
      force: options.force !== false,
    });
  }

  flushRecoveryWork(options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const maxPasses = Number.isFinite(Number(options.maxPasses))
      ? Math.max(1, Math.floor(Number(options.maxPasses)))
      : 10;
    let lastResult = null;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      lastResult = this.runRecoveryPass({
        nowMs: nowMsFrom(options.nowMs, Date.now()),
        reason: options.reason || 'flush_recovery_work',
        limit: options.limit,
        force: options.force !== false,
      });
      if ((lastResult?.outstandingEntries || 0) <= 0) break;
      const nextDueAt = Number(lastResult?.nextReplayDueAt || 0);
      if (nextDueAt > Date.now()) {
        break;
      }
    }
    return lastResult || this.getStatus({ nowMs });
  }

  getStatus(options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const compactionLock = this.getCompactionLockState(nowMs);
    const recoveryStatus = this.journal.getRuntimeState('recovery_status', {}) || {};
    return {
      ok: true,
      startup: this.startupInfo,
      outstandingEntries: this.journal.countOutstandingEntries(),
      readyEntries: this.journal.countReplayableEntries(nowMs),
      nextReplayDueAt: this.journal.getNextReplayDueAt(),
      compactionLock,
      recovery: {
        running: this.recoveryRunning || recoveryStatus.running === true,
        ...recoveryStatus,
      },
      shutdownMarker: this.shutdownMarker.read(),
    };
  }

  persistEnvelope(memory, route, nowMs) {
    const db = this.journal.requireDb();
    const payloadSnapshot = {
      ...memory,
      route,
    };

    db.exec('BEGIN IMMEDIATE;');
    try {
      this.journal.insertJournalEntry({
        ingest_id: memory.ingest_id,
        memory_id: memory.memory_id,
        memory_class: memory.memory_class,
        content_hash: memory.content_hash,
        dedupe_key: memory.dedupe_key,
        time_bucket: utcDayBucket(nowMs),
        route_tier: route.tier,
        promotion_required: route.promotionRequired,
        status: 'recorded',
        payload: payloadSnapshot,
        result_refs: [],
        attempt_count: 0,
        last_attempt_at: null,
        next_attempt_at: nowMs,
        queue_reason: null,
        created_at: nowMs,
        updated_at: nowMs,
      });
      db.exec('COMMIT;');
      return {
        ok: true,
      };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      const existing = this.journal.getJournalEntry(memory.ingest_id);
      if (existing) {
        return {
          ok: true,
          existing: true,
        };
      }
      return {
        ok: false,
        reason: 'journal_persist_failed',
        error: err.message,
      };
    }
  }

  routePersistedEntry(ingestId, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const journalEntry = this.journal.getJournalEntry(ingestId);
    if (!journalEntry) {
      return {
        ok: false,
        reason: 'journal_entry_missing',
        ingest_id: ingestId,
      };
    }

    const payload = asObject(journalEntry.payload);
    const memory = {
      ...payload,
      route: undefined,
    };
    const route = options.routeHint || payload.route || resolveMemoryRoute(memory);
    if (!route || route.ok === false) {
      return {
        ok: false,
        reason: route?.reason || 'route_unavailable',
        ingest_id: ingestId,
      };
    }

    if (journalEntry.status === 'routed' || journalEntry.status === 'deduped') {
      return this.buildFinalResult(journalEntry, route);
    }

    if (this.isTierLocked(route.tier, nowMs)) {
      return this.deferJournalEntry(journalEntry, route, {
        nowMs,
        queueReason: 'compaction_lock',
        errorCode: 'memory_ingest_compaction_locked',
        errorMessage: `routing deferred while ${route.tier} is compacting`,
      });
    }

    const existingObject = this.journal.getMemoryObjectForIngest(ingestId);
    if (existingObject) {
      const resultRefs = this.buildStoredResultRefs(ingestId, route.tier, existingObject);
      this.journal.updateJournalEntry(ingestId, {
        status: 'routed',
        result_refs: resultRefs,
        error_code: null,
        error_message: null,
        queue_reason: null,
        next_attempt_at: null,
        last_attempt_at: nowMs,
        updated_at: nowMs,
      });
      return {
        ok: true,
        ingest_id: ingestId,
        routed_to_tier: route.tier,
        promotion_required: route.promotionRequired,
        deduped: false,
        queued: false,
        result_refs: resultRefs,
      };
    }

    const db = this.journal.requireDb();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const liveEntry = this.journal.getJournalEntry(ingestId);
      if (!liveEntry) {
        throw new Error('journal_entry_missing');
      }

      if (liveEntry.status === 'routed' || liveEntry.status === 'deduped') {
        db.exec('COMMIT;');
        return this.buildFinalResult(liveEntry, route);
      }

      const routedObject = this.journal.getMemoryObjectForIngest(ingestId);
      if (routedObject) {
        const storedRefs = this.buildStoredResultRefs(ingestId, route.tier, routedObject);
        this.journal.updateJournalEntry(ingestId, {
          status: 'routed',
          result_refs: storedRefs,
          error_code: null,
          error_message: null,
          queue_reason: null,
          next_attempt_at: null,
          last_attempt_at: nowMs,
          updated_at: nowMs,
        });
        db.exec('COMMIT;');
        return {
          ok: true,
          ingest_id: ingestId,
          routed_to_tier: route.tier,
          promotion_required: route.promotionRequired,
          deduped: false,
          queued: false,
          result_refs: storedRefs,
        };
      }

      const existingDedupe = this.journal.findRecentDedupe(
        liveEntry.memory_class,
        liveEntry.dedupe_key,
        nowMs,
        24 * 60 * 60 * 1000,
        ingestId
      );
      if (existingDedupe) {
        const dedupedRefs = normalizeRefs(safeParseJson(existingDedupe.result_refs_json, []));
        this.journal.updateJournalEntry(ingestId, {
          route_tier: route.tier,
          promotion_required: route.promotionRequired,
          status: 'deduped',
          result_refs: dedupedRefs,
          error_code: null,
          error_message: null,
          queue_reason: null,
          next_attempt_at: null,
          last_attempt_at: nowMs,
          updated_at: nowMs,
        });
        db.exec('COMMIT;');
        return {
          ok: true,
          ingest_id: ingestId,
          routed_to_tier: route.tier,
          promotion_required: route.promotionRequired,
          deduped: true,
          queued: false,
          result_refs: dedupedRefs,
        };
      }

      const candidateId = route.tier === 'tier1' ? this.idFactory('candidate') : null;
      const promotionArtifacts = candidateId
        ? buildPromotionArtifacts(memory, { projectRoot: options.projectRoot })
        : null;
      const resultRefs = [
        {
          kind: 'memory_object',
          id: memory.memory_id,
          tier: route.tier,
        },
      ];
      if (candidateId) {
        resultRefs.push({
          kind: 'promotion_candidate',
          id: candidateId,
          target_file: route.targetFile || null,
        });
      }

      memory.result_refs = resultRefs;
      memory.lifecycle_state = route.promotionRequired ? 'pending' : 'active';
      this.journal.insertMemoryObject(memory);

      if (candidateId) {
        const artifacts = promotionArtifacts || {};
        this.journal.insertPromotionCandidate({
          candidate_id: candidateId,
          memory_id: memory.memory_id,
          ingest_id: memory.ingest_id,
          memory_class: memory.memory_class,
          claim_type: memory.claim_type || null,
          target_file: artifacts.target_file || route.targetFile || 'workspace/knowledge/workflows.md',
          target_heading: artifacts.target_heading || null,
          base_sha: artifacts.base_sha || null,
          patch_text: artifacts.patch_text || null,
          review_required: route.promotionRequired,
          status: route.promotionRequired ? 'pending' : 'auto_approved',
          created_at: nowMs,
          updated_at: nowMs,
        });
      }

      this.journal.insertDedupeRecord({
        memory_class: memory.memory_class,
        dedupe_key: memory.dedupe_key,
        time_bucket: utcDayBucket(nowMs),
        ingest_id: memory.ingest_id,
        memory_id: memory.memory_id,
        result_refs: resultRefs,
        created_at: nowMs,
        updated_at: nowMs,
      });

      this.journal.updateJournalEntry(ingestId, {
        route_tier: route.tier,
        promotion_required: route.promotionRequired,
        status: 'routed',
        result_refs: resultRefs,
        error_code: null,
        error_message: null,
        queue_reason: null,
        next_attempt_at: null,
        last_attempt_at: nowMs,
        updated_at: nowMs,
      });

      db.exec('COMMIT;');
      if (candidateId && route.promotionRequired === false) {
        const autoPromote = this.promotionService.approveCandidate(candidateId, {
          nowMs,
          reviewer: 'system:auto-promote',
          projectRoot: options.projectRoot,
        });
        if (autoPromote?.ok === true) {
          return {
            ok: true,
            ingest_id: ingestId,
            routed_to_tier: route.tier,
            promotion_required: route.promotionRequired,
            deduped: false,
            queued: false,
            auto_promoted: true,
            promotion_status: autoPromote.status,
            result_refs: resultRefs,
          };
        }
      }
      return {
        ok: true,
        ingest_id: ingestId,
        routed_to_tier: route.tier,
        promotion_required: route.promotionRequired,
        deduped: false,
        queued: false,
        result_refs: resultRefs,
      };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      if (!isRetryableRouteError(err)) {
        this.logger?.warn?.('MemoryIngest', `Non-fatal route error retained for replay: ${err.message}`);
      }
      return this.deferJournalEntry(journalEntry, route, {
        nowMs,
        queueReason: deriveQueueReason(err),
        errorCode: 'memory_ingest_retry_scheduled',
        errorMessage: err.message,
      });
    }
  }

  deferJournalEntry(journalEntry, route, options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const attemptCount = Math.max(1, Number(journalEntry.attempt_count || 0) + 1);
    const retryDelayMs = Number.isFinite(Number(options.retryDelayMs))
      ? Math.max(0, Math.floor(Number(options.retryDelayMs)))
      : computeRetryDelay(attemptCount);
    const nextAttemptAt = nowMs + retryDelayMs;

    try {
      this.journal.updateJournalEntry(journalEntry.ingest_id, {
        status: 'failed',
        attempt_count: attemptCount,
        queue_reason: options.queueReason || 'route_retry',
        error_code: options.errorCode || 'memory_ingest_retry_scheduled',
        error_message: options.errorMessage || null,
        last_attempt_at: nowMs,
        next_attempt_at: nextAttemptAt,
        updated_at: nowMs,
      });
    } catch (err) {
      this.logger?.warn?.('MemoryIngest', `Unable to update retry metadata for ${journalEntry.ingest_id}: ${err.message}`);
    }

    this.scheduleRecovery({
      delayMs: retryDelayMs,
      reason: options.queueReason || 'route_retry',
      nowMs,
    });

    return {
      ok: true,
      ingest_id: journalEntry.ingest_id,
      routed_to_tier: route.tier,
      promotion_required: route.promotionRequired,
      deduped: false,
      queued: true,
      status: 'queued',
      queue_reason: options.queueReason || 'route_retry',
      next_attempt_at: nextAttemptAt,
      result_refs: normalizeRefs(journalEntry.result_refs),
    };
  }

  runRecoveryPass(options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    if (this.recoveryRunning) {
      return this.getStatus({ nowMs });
    }

    this.recoveryRunning = true;
    let lastCheckpoint = null;
    let lastError = null;
    let processedEntries = 0;

    try {
      const startedAt = Date.now();
      for (let pass = 0; pass < this.replayMaxPasses; pass += 1) {
        if ((Date.now() - startedAt) >= this.replayMaxTickMs) break;
        const batch = this.journal.listReplayableEntries(nowMsFrom(options.nowMs, Date.now()), {
          limit: options.limit || this.replayBatchSize,
          includeFuture: options.force === true,
        });
        if (batch.length === 0) break;

        for (const entry of batch) {
          const replayResult = this.routePersistedEntry(entry.ingest_id, {
            nowMs: nowMsFrom(options.nowMs, Date.now()),
            routeHint: entry.payload?.route,
            reason: options.reason || 'recovery_replay',
          });
          processedEntries += 1;
          lastCheckpoint = entry.ingest_id;
          if (replayResult?.ok === false) {
            lastError = replayResult.reason || 'replay_failed';
          }
        }
      }
    } finally {
      this.recoveryRunning = false;
    }

    const outstandingEntries = this.journal.countOutstandingEntries();
    const readyEntries = this.journal.countReplayableEntries(Date.now());
    const nextReplayDueAt = this.journal.getNextReplayDueAt();
    const nowMsFinal = Date.now();

    if (outstandingEntries > 0) {
      this.updateRecoveryStatus({
        nowMs: nowMsFinal,
        running: true,
        reason: options.reason || 'recovery_replay',
        pendingOutstanding: outstandingEntries,
        pendingReady: readyEntries,
        lastCheckpoint,
        lastError,
        nextReplayDueAt,
      });
      this.emitBacklogTier4Status({
        nowMs: nowMsFinal,
        outstandingEntries,
        reason: options.reason || 'recovery_replay',
      });
      const delayMs = nextReplayDueAt && nextReplayDueAt > nowMsFinal
        ? Math.max(0, nextReplayDueAt - nowMsFinal)
        : this.replayTickMs;
      this.scheduleRecovery({
        delayMs,
        reason: options.reason || 'recovery_replay',
        nowMs: nowMsFinal,
      });
    } else {
      this.backlogTier4Emitted = false;
      this.updateRecoveryStatus({
        nowMs: nowMsFinal,
        running: false,
        reason: options.reason || 'recovery_replay',
        pendingOutstanding: 0,
        pendingReady: 0,
        lastCheckpoint,
        lastError,
        nextReplayDueAt: null,
        completedAt: nowMsFinal,
      });
    }

    return {
      ok: true,
      processedEntries,
      outstandingEntries,
      readyEntries,
      nextReplayDueAt,
      lastCheckpoint,
      lastError,
    };
  }

  scheduleRecovery(options = {}) {
    const nowMs = nowMsFrom(options.nowMs);
    const delayMs = options.immediate === true
      ? 0
      : (Number.isFinite(Number(options.delayMs))
        ? Math.max(0, Math.floor(Number(options.delayMs)))
        : this.replayTickMs);

    this.updateRecoveryStatus({
      nowMs,
      running: true,
      reason: options.reason || 'recovery_scheduled',
      pendingOutstanding: this.journal.countOutstandingEntries(),
      pendingReady: this.journal.countReplayableEntries(nowMs),
      lastCheckpoint: null,
      lastError: null,
      nextReplayDueAt: nowMs + delayMs,
    });

    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      try {
        this.runRecoveryPass({
          reason: options.reason || 'recovery_scheduled',
          nowMs: Date.now(),
        });
      } catch (err) {
        this.logger?.warn?.('MemoryIngest', `Recovery replay failed: ${err.message}`);
      }
    }, delayMs);
    if (typeof this.recoveryTimer.unref === 'function') {
      this.recoveryTimer.unref();
    }
  }

  emitBacklogTier4Status(options = {}) {
    if (this.backlogTier4Emitted) return;
    const nowMs = nowMsFrom(options.nowMs);
    const outstandingEntries = Number(options.outstandingEntries || 0);
    if (outstandingEntries <= 0) return;
    this.backlogTier4Emitted = true;

    const result = this.ingest({
      content: `Memory ingest recovery is replaying ${outstandingEntries} pending journal entries after an unclean shutdown.`,
      memory_class: 'active_task_state',
      provenance: {
        source: 'system',
        kind: 'crash_recovery',
        actor: 'system',
      },
      confidence: 1,
      source_trace: `startup-recovery:${nowMs}`,
      scope: {
        subsystem: 'memory_ingest',
        reason: asString(options.reason || 'recovery_replay', 'recovery_replay'),
      },
      expires_at: nowMs + (60 * 60 * 1000),
    }, { nowMs });

    if (result?.ok !== true) {
      this.backlogTier4Emitted = false;
    }
  }

  buildStoredResultRefs(ingestId, fallbackTier, existingObject = null) {
    const memoryObject = existingObject || this.journal.getMemoryObjectForIngest(ingestId);
    const refs = [];
    if (memoryObject) {
      refs.push({
        kind: 'memory_object',
        id: memoryObject.memory_id,
        tier: memoryObject.tier || fallbackTier || null,
      });
      const storedRefs = normalizeRefs(safeParseJson(memoryObject.result_refs_json, []));
      for (const entry of storedRefs) {
        if (entry.kind === 'promotion_candidate') refs.push(entry);
      }
    }
    for (const candidate of this.journal.listPromotionCandidatesForIngest(ingestId)) {
      if (refs.some((entry) => entry.kind === 'promotion_candidate' && entry.id === candidate.candidate_id)) {
        continue;
      }
      refs.push({
        kind: 'promotion_candidate',
        id: candidate.candidate_id,
        target_file: candidate.target_file || null,
      });
    }
    return refs;
  }

  buildFinalResult(journalEntry, route) {
    const resultRefs = normalizeRefs(journalEntry.result_refs);
    return {
      ok: true,
      ingest_id: journalEntry.ingest_id,
      routed_to_tier: route.tier,
      promotion_required: route.promotionRequired,
      deduped: journalEntry.status === 'deduped',
      queued: false,
      result_refs: resultRefs,
    };
  }

  updateRecoveryStatus(input = {}) {
    const nowMs = nowMsFrom(input.nowMs);
    this.journal.setRuntimeState('recovery_status', {
      running: input.running === true,
      reason: input.reason || 'recovery_status',
      pendingOutstanding: Number(input.pendingOutstanding || 0),
      pendingReady: Number(input.pendingReady || 0),
      lastCheckpoint: input.lastCheckpoint || null,
      lastError: input.lastError || null,
      nextReplayDueAt: Number.isFinite(Number(input.nextReplayDueAt)) ? Number(input.nextReplayDueAt) : null,
      startedAt: input.startedAt || null,
      completedAt: input.completedAt || null,
    }, nowMs);
  }

  getCompactionLockState(nowMs = Date.now()) {
    const state = asObject(this.journal.getRuntimeState('compaction_lock', {}));
    const expiresAt = Number(state.expires_at || 0);
    if (state.locked === true && expiresAt > 0 && expiresAt <= nowMs) {
      this.clearCompactionLock({
        nowMs,
        reason: 'compaction_lock_expired',
        source: 'memory-ingest',
      });
      return {
        locked: false,
        locked_tiers: [],
        reason: 'compaction_lock_expired',
      };
    }
    return {
      locked: state.locked === true,
      locked_tiers: Array.isArray(state.locked_tiers) ? state.locked_tiers : [],
      reason: state.reason || null,
      source: state.source || null,
      locked_at: state.locked_at || null,
      unlocked_at: state.unlocked_at || null,
      expires_at: state.expires_at || null,
    };
  }

  isTierLocked(tier, nowMs = Date.now()) {
    const compactionLock = this.getCompactionLockState(nowMs);
    return compactionLock.locked === true
      && Array.isArray(compactionLock.locked_tiers)
      && compactionLock.locked_tiers.includes(String(tier || '').trim().toLowerCase());
  }
}

module.exports = {
  MemoryIngestService,
  computeRetryDelay,
};
