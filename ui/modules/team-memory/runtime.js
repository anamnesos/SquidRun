const path = require('path');
const { TeamMemoryStore } = require('./store');
const { TeamMemoryClaims } = require('./claims');
const { TeamMemoryPatterns } = require('./patterns');
const { TeamMemoryGuards } = require('./guards');
const { runBackfill } = require('./backfill');
const { extractTaggedClaimsFromComms } = require('./comms-tagged-extractor');
const { scanOrphanedEvidenceRefs } = require('./integrity-checker');
const { executeExperimentOperation } = require('../experiment/runtime');
const { MemoryIngestService } = require('../memory-ingest/service');
const { MemoryLifecycleService } = require('../memory-ingest/lifecycle');
const { MemoryPromotionService } = require('../memory-ingest/promotion');
const { MemoryDeliveryService } = require('../memory-ingest/delivery');
const log = require('../logger');
const { resolveCoordPath } = require('../../config');

let sharedRuntime = null;
const RUNTIME_LIFECYCLE_STATE = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
});
const ALLOWED_RUNTIME_TRANSITIONS = Object.freeze({
  [RUNTIME_LIFECYCLE_STATE.STOPPED]: new Set([RUNTIME_LIFECYCLE_STATE.STARTING, RUNTIME_LIFECYCLE_STATE.STOPPING]),
  [RUNTIME_LIFECYCLE_STATE.STARTING]: new Set([RUNTIME_LIFECYCLE_STATE.RUNNING, RUNTIME_LIFECYCLE_STATE.STOPPED]),
  [RUNTIME_LIFECYCLE_STATE.RUNNING]: new Set([RUNTIME_LIFECYCLE_STATE.STOPPING]),
  [RUNTIME_LIFECYCLE_STATE.STOPPING]: new Set([RUNTIME_LIFECYCLE_STATE.STOPPED]),
});
let runtimeLifecycleState = RUNTIME_LIFECYCLE_STATE.STOPPED;

function transitionRuntimeLifecycle(nextState, reason = 'unspecified') {
  const currentState = runtimeLifecycleState;
  if (currentState === nextState) return true;
  const allowed = ALLOWED_RUNTIME_TRANSITIONS[currentState];
  if (!allowed || !allowed.has(nextState)) {
    log.warn('TeamMemoryRuntime', `Illegal runtime transition ${currentState} -> ${nextState} (${reason})`);
    return false;
  }
  runtimeLifecycleState = nextState;
  log.info('TeamMemoryRuntime', `Runtime transition ${currentState} -> ${nextState} (${reason})`);
  return true;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveDefaultTeamMemoryDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true });
  }
  return null;
}

function normalizeRuntimeOptions(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  if (!storeOptions.dbPath) {
    const defaultDbPath = resolveDefaultTeamMemoryDbPath();
    if (defaultDbPath) {
      storeOptions.dbPath = defaultDbPath;
    }
  }
  return {
    ...options,
    storeOptions,
  };
}

function getExplicitRuntimeDbPath(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  return asString(storeOptions.dbPath, '');
}

function isRuntimeAvailable(runtime) {
  return Boolean(runtime?.store && typeof runtime.store.isAvailable === 'function' && runtime.store.isAvailable());
}

function createTeamMemoryRuntime(options = {}) {
  const store = new TeamMemoryStore(asObject(options.storeOptions));
  const initResult = store.init({
    nowMs: options.nowMs,
  });
  const claims = new TeamMemoryClaims(store.db);
  const patterns = new TeamMemoryPatterns(store.db, asObject(options.patternOptions));
  const guards = new TeamMemoryGuards(store.db);
  const memoryIngestOptions = asObject(options.memoryIngestOptions);
  const shutdownMarkerOptions = asObject(memoryIngestOptions.shutdownMarkerOptions);
  const shutdownMarkerFilePath = shutdownMarkerOptions.filePath
    || path.join(path.dirname(store.dbPath), 'memory-ingest-shutdown.json');
  const ingestService = new MemoryIngestService({
    db: store.db,
    logger: log,
    shutdownMarkerOptions: {
      ...shutdownMarkerOptions,
      filePath: shutdownMarkerFilePath,
    },
    replayBatchSize: memoryIngestOptions.replayBatchSize,
    replayTickMs: memoryIngestOptions.replayTickMs,
    replayMaxTickMs: memoryIngestOptions.replayMaxTickMs,
    replayMaxPasses: memoryIngestOptions.replayMaxPasses,
  });
  const promotionService = new MemoryPromotionService({
    db: store.db,
  });
  const lifecycleService = new MemoryLifecycleService({
    db: store.db,
  });
  const deliveryService = new MemoryDeliveryService({
    db: store.db,
    ingestService,
    lifecycleService,
    projectRoot: options.projectRoot || options.workspaceRoot,
  });

  if (initResult?.ok === true) {
    ingestService.initializeRuntime({
      nowMs: options.nowMs,
      sessionId: options.sessionId,
      deviceId: options.deviceId,
      reason: 'team-memory-runtime-init',
    });
  }

  return {
    store,
    claims,
    patterns,
    guards,
    ingestService,
    promotionService,
    lifecycleService,
    deliveryService,
    initResult,
  };
}

function getSharedRuntime(deps = {}) {
  const factory = typeof deps.createTeamMemoryRuntime === 'function'
    ? deps.createTeamMemoryRuntime
    : createTeamMemoryRuntime;
  const runtimeOptionsRaw = asObject(deps.runtimeOptions);
  const explicitRequestedDbPath = getExplicitRuntimeDbPath(runtimeOptionsRaw);
  const runtimeOptions = normalizeRuntimeOptions(runtimeOptionsRaw);
  const forceRuntimeRecreate = deps.forceRuntimeRecreate === true;
  const recreateUnavailable = deps.recreateUnavailable !== false;

  if (forceRuntimeRecreate) {
    if (runtimeLifecycleState === RUNTIME_LIFECYCLE_STATE.STARTING || runtimeLifecycleState === RUNTIME_LIFECYCLE_STATE.STOPPING) {
      log.warn('TeamMemoryRuntime', `forceRuntimeRecreate requested while ${runtimeLifecycleState}`);
    }
    closeSharedRuntime();
  }

  if (sharedRuntime && recreateUnavailable && !isRuntimeAvailable(sharedRuntime)) {
    closeSharedRuntime();
  }

  const activeDbPath = asString(sharedRuntime?.store?.dbPath, '');
  if (
    sharedRuntime
    && explicitRequestedDbPath
    && activeDbPath
    && path.resolve(explicitRequestedDbPath) !== path.resolve(activeDbPath)
  ) {
    closeSharedRuntime();
  }

  if (sharedRuntime) return sharedRuntime;
  if (!transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STARTING, 'get-shared-runtime')) {
    throw new Error(`illegal_runtime_transition:${runtimeLifecycleState}->${RUNTIME_LIFECYCLE_STATE.STARTING}`);
  }
  try {
    sharedRuntime = factory(runtimeOptions);
    transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.RUNNING, 'get-shared-runtime');
  } catch (err) {
    transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, 'get-shared-runtime-error');
    throw err;
  }
  return sharedRuntime;
}

function closeSharedRuntime() {
  if (!sharedRuntime) {
    if (runtimeLifecycleState !== RUNTIME_LIFECYCLE_STATE.STOPPED) {
      transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPING, 'close-shared-runtime');
      transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, 'close-shared-runtime');
    }
    return;
  }
  transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPING, 'close-shared-runtime');
  try {
    sharedRuntime.ingestService?.shutdown?.({
      nowMs: Date.now(),
      reason: 'close-shared-runtime',
    });
  } catch (err) {
    log.warn('TeamMemoryRuntime', `Memory ingest shutdown marker failed: ${err.message}`);
  }
  try {
    sharedRuntime.store?.close?.();
  } catch {
    // best effort
  }
  sharedRuntime = null;
  transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, 'close-shared-runtime');
}

function initializeTeamMemoryRuntime(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: opts.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: opts.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: opts.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });

  const status = runtime?.store && typeof runtime.store.getStatus === 'function'
    ? runtime.store.getStatus()
    : null;

  return {
    ok: isRuntimeAvailable(runtime),
    initResult: runtime?.initResult || null,
    status,
  };
}

function executeTeamMemoryOperation(action, payload = {}, options = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const deps = asObject(options.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: options.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: options.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: options.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });
  const store = runtime?.store;
  const claims = runtime?.claims;
  const patterns = runtime?.patterns;
  const guards = runtime?.guards;
  const ingestService = runtime?.ingestService;
  const promotionService = runtime?.promotionService;
  const lifecycleService = runtime?.lifecycleService;
  const deliveryService = runtime?.deliveryService;

  if (!store || !store.isAvailable()) {
    return { ok: false, reason: 'unavailable' };
  }

  const opPayload = asObject(payload);
  const experimentRuntimeOptions = {
    dbPath: store.dbPath,
    artifactRoot: opPayload.artifactRoot,
    profilesPath: opPayload.profilesPath,
    evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
  };

  switch (normalizedAction) {
    case 'health':
      return {
        ok: true,
        status: store.getStatus(),
      };

    case 'create-claim':
      return claims.createClaim(opPayload);

    case 'query-claims':
      return claims.queryClaims(opPayload);

    case 'search-claims':
      return claims.searchClaims(opPayload);

    case 'update-claim-status':
    case 'update-claim': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      const status = opPayload.status || opPayload.newStatus || opPayload.new_status;
      const changedBy = opPayload.changedBy || opPayload.changed_by || opPayload.owner;
      const reason = opPayload.reason || null;
      return claims.updateClaimStatus(claimId, status, changedBy, reason, opPayload.nowMs);
    }

    case 'deprecate-claim': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      const changedBy = opPayload.changedBy || opPayload.changed_by || opPayload.owner;
      const reason = opPayload.reason || 'deprecated_by_user';
      return claims.deprecateClaim(claimId, changedBy, reason, opPayload.nowMs);
    }

    case 'add-evidence': {
      const claimId = opPayload.claimId || opPayload.claim_id;
      const evidenceRef = opPayload.evidenceRef || opPayload.evidence_ref;
      const relation = opPayload.relation || 'supports';
      return claims.addEvidence(claimId, evidenceRef, relation, opPayload);
    }

    case 'create-decision':
      return claims.createDecision(opPayload);

    case 'record-consensus':
      return claims.recordConsensus(opPayload);

    case 'get-consensus': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      return claims.getConsensus(claimId);
    }

    case 'create-belief-snapshot':
      return claims.createBeliefSnapshot(opPayload);

    case 'get-agent-beliefs':
      return claims.getAgentBeliefs(opPayload);

    case 'get-contradictions':
      return claims.getContradictions(opPayload);

    case 'create-pattern':
      return patterns.createPattern(opPayload);

    case 'query-patterns':
      return patterns.queryPatterns(opPayload);

    case 'create-guard':
      return guards.createGuard(opPayload);

    case 'query-guards':
      return guards.queryGuards(opPayload);

    case 'evaluate-guards':
      return guards.evaluateHookEvents(opPayload.events || [], opPayload);

    case 'activate-guard': {
      const guardId = opPayload.guardId || opPayload.guard_id || opPayload.id;
      return guards.activateGuard(guardId, opPayload.nowMs);
    }

    case 'deactivate-guard': {
      const guardId = opPayload.guardId || opPayload.guard_id || opPayload.id;
      return guards.deactivateGuard(guardId, opPayload.nowMs);
    }

    case 'activate-pattern': {
      const patternId = opPayload.patternId || opPayload.pattern_id || opPayload.id;
      return patterns.activatePattern(patternId, opPayload.nowMs);
    }

    case 'deactivate-pattern': {
      const patternId = opPayload.patternId || opPayload.pattern_id || opPayload.id;
      return patterns.deactivatePattern(patternId, opPayload.nowMs);
    }

    case 'process-pattern-spool': {
      const mined = patterns.processPatternSpool(opPayload);
      if (!mined?.ok) return mined;

      const autoCreate = guards.autoCreateGuardsFromPatterns({
        patterns: mined.patterns || [],
        threshold: opPayload.guardAutoCreateThreshold,
        nowMs: opPayload.nowMs,
      });
      const evaluations = guards.evaluateHookEvents(mined.events || [], opPayload);

      return {
        ...mined,
        guardAutoCreate: autoCreate,
        guardActions: evaluations?.actions || [],
        blockedByGuards: Boolean(evaluations?.blocked),
      };
    }

    case 'record-outcome': {
      const decisionId = opPayload.decisionId || opPayload.decision_id || opPayload.id;
      const outcome = opPayload.outcome;
      const notes = opPayload.notes || opPayload.outcomeNotes || opPayload.outcome_notes || null;
      return claims.recordOutcome(decisionId, outcome, notes, opPayload);
    }

    case 'run-backfill':
      return runBackfill({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        limit: opPayload.limit,
        nowMs: opPayload.nowMs,
      });

    case 'extract-comms-tagged-claims':
      return extractTaggedClaimsFromComms({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        sessionId: opPayload.sessionId || opPayload.session_id || null,
        sinceMs: opPayload.sinceMs,
        untilMs: opPayload.untilMs,
        limit: opPayload.limit,
        nowMs: opPayload.nowMs,
      });

    case 'run-integrity-check':
      return scanOrphanedEvidenceRefs({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        limit: opPayload.limit,
        repairOrphans: opPayload.repairOrphans === true,
        nowMs: opPayload.nowMs,
      });

    case 'create-experiment':
    case 'run-experiment':
    case 'run_experiment':
      return executeExperimentOperation('run-experiment', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'get-experiment':
      return executeExperimentOperation('get-experiment', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'list-experiments':
      return executeExperimentOperation('list-experiments', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'attach-to-claim':
      return executeExperimentOperation('attach-to-claim', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'ingest-memory':
    case 'memory-ingest': {
      return ingestService.ingest(opPayload, {
        nowMs: opPayload.nowMs,
        deviceId: opPayload.device_id || opPayload.deviceId,
        sessionId: opPayload.session_id || opPayload.sessionId,
      });
    }

    case 'get-memory-ingest-status':
      return ingestService.getStatus({
        nowMs: opPayload.nowMs,
      });

    case 'replay-memory-ingest':
      return ingestService.replayPending({
        nowMs: opPayload.nowMs,
        reason: opPayload.reason,
        limit: opPayload.limit,
      });

    case 'set-memory-ingest-compaction-lock':
      return ingestService.setCompactionLock(opPayload, {
        nowMs: opPayload.nowMs,
      });

    case 'capture-precompact-memory':
      return ingestService.capturePrecompactState(opPayload, {
        nowMs: opPayload.nowMs,
      });

    case 'list-memory-promotions':
      return promotionService.listCandidates(opPayload);

    case 'approve-memory-promotion':
      return promotionService.approveCandidate(
        opPayload.candidateId || opPayload.candidate_id,
        {
          nowMs: opPayload.nowMs,
          reviewer: opPayload.reviewer || opPayload.actor,
          reviewNotes: opPayload.reviewNotes || opPayload.review_notes,
          projectRoot: opPayload.projectRoot || opPayload.project_root || opPayload.workspaceRoot || opPayload.workspace_root,
        }
      );

    case 'reject-memory-promotion':
      return promotionService.rejectCandidate(
        opPayload.candidateId || opPayload.candidate_id,
        {
          nowMs: opPayload.nowMs,
          reviewer: opPayload.reviewer || opPayload.actor,
          reviewNotes: opPayload.reviewNotes || opPayload.review_notes,
        }
      );

    case 'record-memory-access':
      return lifecycleService.recordAccess(opPayload);

    case 'mark-memory-useful':
      return lifecycleService.recordAccess({
        ...opPayload,
        access_kind: 'useful_mark',
      });

    case 'advance-memory-lifecycle':
      return lifecycleService.advanceLifecycle(opPayload);

    case 'review-stale-memories':
      return lifecycleService.reviewStaleMemories(opPayload);

    case 'trigger-memory-injection':
      return deliveryService.triggerInjection(opPayload);

    case 'record-memory-injection-feedback':
      return deliveryService.recordInjectionFeedback(opPayload);

    case 'build-cross-device-handoff':
      return deliveryService.buildCrossDeviceHandoff(opPayload);

    case 'mark-cross-device-handoff-sent':
      return deliveryService.markHandoffSent(opPayload);

    case 'receive-cross-device-handoff':
      return deliveryService.receiveCrossDeviceHandoff(opPayload);

    case 'prepare-compaction-survival':
      return deliveryService.prepareCompactionSurvival(opPayload);

    case 'resume-compaction-survival':
      return deliveryService.resumeCompactionSurvival(opPayload);

    default:
      return {
        ok: false,
        reason: 'unknown_action',
        action: normalizedAction || action || null,
      };
  }
}

module.exports = {
  createTeamMemoryRuntime,
  initializeTeamMemoryRuntime,
  executeTeamMemoryOperation,
  closeSharedRuntime,
  getRuntimeLifecycleState: () => runtimeLifecycleState,
};
